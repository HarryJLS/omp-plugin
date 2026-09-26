/**
 * str_replace — text-anchored editing for oh-my-pi (claw-code / Claude Code style).
 *
 * The problem this removes
 * -----------------------
 * oh-my-pi's default `hashline` edit mode anchors by line number:
 *
 *     [src/foo.ts#1A2B]
 *     PUT 120.=155:
 *     +new content
 *
 * The payload says WHERE to cut but never WHAT is being cut. `patcher.ts`
 * validates only that the whole file still hashes to the 4-hex tag
 * (`packages/hashline/src/format.ts` — 16 bits) and that the anchored lines were
 * displayed by a prior read. Neither check can notice the model miscounting the
 * range end, so `PUT 120.=155` when 135 was meant deletes twenty extra lines
 * and returns success. `packages/hashline/src/types.ts:42` even declares an
 * `oldAssertion` field for exactly this check — nothing reads it.
 *
 * Anchoring by content removes the failure class by construction: a miscount
 * cannot match, and a non-match is an error rather than a deletion.
 *
 * Derived from
 * ------------
 * `claw-code/rust/crates/runtime/src/file_ops.rs:268-306` (`edit_file`) for the
 * overall shape: reject identical strings, reject when the needle is absent,
 * then replace one or all occurrences.
 *
 * Deliberate divergence: claw-code performs NO uniqueness check — it calls
 * `replacen(old, new, 1)` after a bare `contains()`, so a needle occurring
 * twice silently edits the first one. This tool requires a unique match (as
 * Claude Code's own Edit tool does) and lists every site when there are
 * several.
 *
 * Guarantees
 * ----------
 *  1. Nothing is deleted that the model did not reproduce verbatim.
 *  2. Ambiguity fails closed — 2+ matches is an error naming every site.
 *  3. A near-miss is diagnosed (whitespace-only drift is named outright) but
 *     never auto-applied.
 *  4. `write` cannot silently overwrite an existing non-empty file, which is
 *     the other common way real code disappears.
 *
 * Install
 * -------
 *   user-wide:  cp str-replace.ts ~/.omp/agent/extensions/
 *   one project: cp str-replace.ts <project>/.omp/extensions/
 *   ad hoc:      omp --extension ~/Downloads/omp-safe-edit/str-replace.ts
 *
 * Env
 * ---
 *   OMP_KEEP_BUILTIN_EDIT=1        keep the built-in line-anchored `edit` active
 *   OMP_EDIT_ALLOW_OUTSIDE=1       permit edits outside the session cwd
 *   OMP_ALLOW_WRITE_OVERWRITE=1    permit `write` onto an existing file
 */

import { readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

/** Occurrence sites listed in an error before truncating, so a pathological match set cannot flood context. */
const MAX_REPORTED_SITES = 10;
/** Near-miss candidate regions shown when nothing matched. */
const MAX_NEAR_MISS = 3;
/** Characters of a source line shown in any preview. */
const PREVIEW_COLUMNS = 120;
/** Matches `scheme://`, so `xd://` device dispatch and other URI targets are left alone. */
const URI_TARGET = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

type LineEnding = "\r\n" | "\n";

interface Shape {
	bom: string;
	ending: LineEnding;
}

/** Split off BOM, detect the dominant line ending, and return LF-normalized text. */
function decode(raw: string): { text: string; shape: Shape } {
	const bom = raw.startsWith("﻿") ? "﻿" : "";
	const body = bom ? raw.slice(1) : raw;
	const crlf = body.indexOf("\r\n");
	const lf = body.indexOf("\n");
	const ending: LineEnding = lf !== -1 && crlf !== -1 && crlf < lf ? "\r\n" : "\n";
	const text = body.indexOf("\r") === -1 ? body : body.replace(/\r\n?/g, "\n");
	return { text, shape: { bom, ending } };
}

/** Restore the original BOM and line-ending shape for write-back. */
function encode(text: string, shape: Shape): string {
	const body = shape.ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
	return shape.bom + body;
}

/** Normalize authored text to LF so a CRLF file does not defeat an otherwise-correct LF needle. */
function toLF(text: string): string {
	return text.indexOf("\r") === -1 ? text : text.replace(/\r\n?/g, "\n");
}

/** Resolve `rawPath` against `cwd`, refusing to escape the workspace unless opted out. */
function resolveTarget(rawPath: string, cwd: string): string {
	const absolute = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
	const target = resolve(absolute);
	if (process.env.OMP_EDIT_ALLOW_OUTSIDE === "1") return target;
	const root = resolve(cwd);
	if (target !== root && !target.startsWith(root + sep)) {
		throw new Error(
			`Refusing to edit outside the session workspace.\n  path: ${target}\n  cwd:  ${root}\n` +
				`Set OMP_EDIT_ALLOW_OUTSIDE=1 to permit this.`,
		);
	}
	return target;
}

/** Byte offsets of every non-overlapping occurrence of `needle` in `haystack`. */
function findOccurrences(haystack: string, needle: string): number[] {
	const offsets: number[] = [];
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		offsets.push(index);
		index = haystack.indexOf(needle, index + needle.length);
	}
	return offsets;
}

/** 1-indexed line number containing byte offset `index`. */
function lineOf(text: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
	return line;
}

function clip(line: string): string {
	return line.length > PREVIEW_COLUMNS ? `${line.slice(0, PREVIEW_COLUMNS)}…` : line;
}

/**
 * Splice `replacement` over each offset in `offsets`, right-to-left.
 *
 * Deliberately not `String.prototype.replace`: with a string pattern it still
 * interprets `$&`, `$'`, "$`", `$1`..`$9`, and `$$` inside the REPLACEMENT, so
 * new content containing a literal `$&` would be silently corrupted.
 */
function spliceAll(text: string, offsets: readonly number[], needleLength: number, replacement: string): string {
	let out = text;
	for (let i = offsets.length - 1; i >= 0; i--) {
		const at = offsets[i];
		out = out.slice(0, at) + replacement + out.slice(at + needleLength);
	}
	return out;
}

/**
 * Explain a zero-match failure without weakening the guarantee.
 *
 * Whitespace-only drift is by far the most common cause and worth naming
 * outright: the model gets a precise correction instead of burning a turn on a
 * blind re-read. Everything here is reported, never applied.
 */
function diagnoseMiss(text: string, needle: string): string {
	const fileLines = text.split("\n");
	const needleLines = needle.split("\n");

	// Whole-block match modulo leading/trailing whitespace on every line.
	const trimmed = needleLines.map(l => l.trim());
	for (let i = 0; i + trimmed.length <= fileLines.length; i++) {
		let ok = true;
		for (let j = 0; j < trimmed.length; j++) {
			if (fileLines[i + j].trim() !== trimmed[j]) {
				ok = false;
				break;
			}
		}
		if (ok) {
			const actual = fileLines.slice(i, i + trimmed.length);
			return (
				`The block exists at line ${i + 1} but its whitespace differs from old_string.\n` +
				`Copy these lines verbatim (leading whitespace included):\n\n` +
				actual.map((l, k) => `${i + 1 + k}:${clip(l)}`).join("\n")
			);
		}
	}

	// Otherwise anchor on the first meaningful line of old_string.
	const anchor = needleLines.find(l => l.trim().length > 0);
	if (anchor === undefined) return "old_string contains only blank lines.";
	const anchorTrimmed = anchor.trim();
	const hits: number[] = [];
	for (let i = 0; i < fileLines.length && hits.length < MAX_NEAR_MISS; i++) {
		if (fileLines[i].trim() === anchorTrimmed) hits.push(i + 1);
	}
	if (hits.length === 0) {
		return (
			`No line in the file matches the first line of old_string ` +
			`(${JSON.stringify(clip(anchorTrimmed))}). Re-read the file before retrying.`
		);
	}
	const windows = hits.map(hit => {
		const from = Math.max(1, hit - 2);
		const to = Math.min(fileLines.length, hit + needleLines.length + 1);
		const body = fileLines
			.slice(from - 1, to)
			.map((l, k) => `${from + k}:${clip(l)}`)
			.join("\n");
		return `--- around line ${hit} ---\n${body}`;
	});
	return (
		`old_string's first line occurs at line ${hits.join(", ")}, but the lines after it diverge. ` +
		`Actual content:\n\n${windows.join("\n\n")}`
	);
}

export default function strReplaceExtension(pi: ExtensionAPI) {
	const z = pi.zod;
	const stats = { applied: 0, noMatch: 0, ambiguous: 0, blockedWrites: 0, removed: 0, added: 0 };

	pi.setLabel("str_replace (text-anchored edit)");

	pi.registerTool({
		name: "str_replace",
		label: "Str Replace",
		description: [
			"Replace an exact literal substring in a file. The edit is anchored by content, never by line number.",
			"",
			"`old_string` MUST reproduce the target region byte-for-byte as it appears in the file, including",
			"indentation. It must also be long enough to occur exactly once — keep adding surrounding lines until",
			"it is unique. If it occurs more than once the call is rejected and every site is listed; add context to",
			"disambiguate, or pass replace_all: true when you genuinely mean to change all of them.",
			"",
			"`new_string` is the complete replacement for that region. Pass an empty string to delete the region.",
			"To create a new file, use `write`.",
			"",
			"A call that does not match changes nothing, so it is always safe to retry after re-reading.",
		].join("\n"),
		approval: "write",
		loadMode: "essential",
		parameters: z.object({
			path: z.string().describe("File to edit, absolute or relative to the session working directory."),
			old_string: z
				.string()
				.describe("Exact literal text to replace, copied verbatim from the file including indentation."),
			new_string: z.string().describe("Replacement text. An empty string deletes the matched region."),
			replace_all: z
				.boolean()
				.optional()
				.describe("Replace every occurrence instead of requiring a unique match. Defaults to false."),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const replaceAll = params.replace_all === true;
			const target = resolveTarget(params.path, ctx.cwd);

			if (params.old_string === params.new_string) {
				throw new Error("old_string and new_string are identical — nothing to do.");
			}
			if (params.old_string.length === 0) {
				throw new Error("old_string is empty. Use the `write` tool to create a file.");
			}

			let raw: string;
			try {
				raw = await readFile(target, "utf8");
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code === "ENOENT") throw new Error(`File does not exist: ${params.path}`);
				if (code === "EISDIR") throw new Error(`Path is a directory, not a file: ${params.path}`);
				throw error;
			}

			const { text, shape } = decode(raw);
			const needle = toLF(params.old_string);
			const replacement = toLF(params.new_string);
			const offsets = findOccurrences(text, needle);

			if (offsets.length === 0) {
				stats.noMatch++;
				throw new Error(`old_string not found in ${params.path}.\n\n${diagnoseMiss(text, needle)}`);
			}
			if (offsets.length > 1 && !replaceAll) {
				stats.ambiguous++;
				const lines = text.split("\n");
				const shown = offsets.slice(0, MAX_REPORTED_SITES);
				const sites = shown
					.map(offset => {
						const line = lineOf(text, offset);
						return `  line ${line}: ${clip(lines[line - 1] ?? "")}`;
					})
					.join("\n");
				const more = offsets.length > shown.length ? `\n  … and ${offsets.length - shown.length} more` : "";
				throw new Error(
					`old_string occurs ${offsets.length} times in ${params.path}; refusing to guess which one.\n` +
						`${sites}${more}\n\n` +
						`Extend old_string with surrounding lines until it is unique, or pass replace_all: true.`,
				);
			}

			const applied = replaceAll ? offsets : offsets.slice(0, 1);
			const updated = spliceAll(text, applied, needle.length, replacement);
			await writeFile(target, encode(updated, shape), "utf8");

			const count = applied.length;
			const firstLine = lineOf(text, applied[0]);
			const removed = needle.split("\n").length * count;
			const added = replacement.length === 0 ? 0 : replacement.split("\n").length * count;
			stats.applied++;
			stats.removed += removed;
			stats.added += added;

			return {
				content: [
					{
						type: "text" as const,
						text:
							`Replaced ${count} ${count === 1 ? "occurrence" : "occurrences"} in ${params.path} ` +
							`(first at line ${firstLine}); -${removed}/+${added} lines.`,
					},
				],
				details: { path: target, count, firstLine, linesRemoved: removed, linesAdded: added },
			};
		},
	});

	/**
	 * Wholesale overwrite is the other common way real code disappears: a
	 * "rewritten" file silently drops whatever the model did not reproduce, and
	 * no anchoring scheme can catch it because nothing was anchored. Creating a
	 * new file, writing an empty file, and `xd://` device dispatch stay allowed.
	 */
	pi.on("tool_call", async (event, ctx) => {
		if (process.env.OMP_ALLOW_WRITE_OVERWRITE === "1") return;
		if (event.toolName !== "write") return;
		const rawPath = (event.input as { path?: unknown }).path;
		if (typeof rawPath !== "string" || rawPath.length === 0) return;
		if (URI_TARGET.test(rawPath)) return;
		let info: Awaited<ReturnType<typeof stat>>;
		try {
			info = await stat(resolve(ctx.cwd, rawPath));
		} catch {
			return; // Missing (or unreadable) target: creating a file is fine.
		}
		if (!info.isFile() || info.size === 0) return;
		stats.blockedWrites++;
		return {
			block: true,
			reason:
				`Refusing to overwrite the existing file ${rawPath} (${info.size} bytes) with \`write\`.\n` +
				`A wholesale rewrite silently drops every part of the file you did not reproduce, which is the ` +
				`most common way working code is lost.\n` +
				`Use \`str_replace\` to change only the region you mean to change. If you truly intend to discard ` +
				`the current contents, say so and the user can set OMP_ALLOW_WRITE_OVERWRITE=1.`,
		};
	});

	pi.registerCommand("str-replace-stats", {
		description: "Show str_replace accept/reject counts for this session",
		handler: async (_args, ctx) => {
			const total = stats.applied + stats.noMatch + stats.ambiguous;
			ctx.ui.notify(
				`str_replace — ${stats.applied}/${total} applied, ${stats.noMatch} no-match, ` +
					`${stats.ambiguous} ambiguous, ${stats.blockedWrites} overwrites blocked, ` +
					`-${stats.removed}/+${stats.added} lines`,
				"info",
			);
		},
	});

	// Drop the built-in line-anchored `edit` so the model cannot fall back to it.
	pi.on("session_start", async (_event, ctx) => {
		if (process.env.OMP_KEEP_BUILTIN_EDIT === "1") return;
		try {
			const active = pi.getActiveTools();
			if (!active.includes("edit")) return;
			const next = active.filter(name => name !== "edit");
			if (!next.includes("str_replace")) next.push("str_replace");
			await pi.setActiveTools(next);
			pi.logger.debug("str-replace: replaced built-in `edit` with `str_replace`");
		} catch (error) {
			ctx.ui.notify(`str-replace: could not swap out built-in edit (${String(error)})`, "warning");
		}
	});
}
