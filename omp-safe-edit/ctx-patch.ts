/**
 * ctx_patch — context-anchored patching for oh-my-pi (codex `apply_patch` style).
 *
 * The problem this removes
 * -----------------------
 * oh-my-pi's default `hashline` edit mode describes an edit target by
 * coordinates (`PUT 120.=155:`) and never restates the content being removed.
 * The 16-bit whole-file tag in `packages/hashline/src/format.ts` only proves the
 * file has not changed since it was read — it cannot prove the model pointed at
 * the right lines. `packages/hashline/src/patcher.ts:688` trusts that tag and
 * applies the range unconditionally, so a miscounted range end deletes real
 * code and reports success.
 *
 * A context diff carries the removed lines and their neighbours inside the
 * payload, so the patch validates itself: every `-` line must actually be
 * there, in that order, beside that context, or the hunk does not apply.
 *
 * Derived from
 * ------------
 * `codex/codex-rs/apply-patch/src/seek_sequence.rs` — the four-level strictness
 * ladder (exact → trailing-space → indentation → Unicode fold), the punctuation
 * fold table (dashes U+2010–U+2015/U+2212, quotes U+2018–U+201B/U+201C–U+201F,
 * spaces U+00A0/U+2002–U+200A/U+202F/U+205F/U+3000), and the
 * `pattern.len() > lines.len()` guard are ported from it. The `@@` locator as a
 * real search anchor and the `*** End of File` tail preference are ported from
 * `file_update.rs:99-113` and `:145-150`. The envelope grammar comes from
 * codex's patch parser.
 *
 * Compatibility
 * -------------
 * Uses Codex's first-match search, verbatim additions, EOF append for insertion
 * hunks, and trailing-empty-line retry. The OMP adapter keeps the existing
 * ctx_patch({ input }) interface. Filesystem permissions belong to the host;
 * this extension does not impose a cwd boundary or intercept other tools.
 *
 * Format
 * ------
 *     *** Begin Patch
 *     *** Update File: src/foo.ts
 *     @@ optional locator text
 *      unchanged context line
 *     -removed line
 *     +added line
 *      unchanged context line
 *     *** Add File: src/new.ts
 *     +first line of the new file
 *     *** Delete File: src/gone.ts
 *     *** End Patch
 *
 * Install
 * -------
 *   user-wide:   cp ctx-patch.ts ~/.omp/agent/extensions/
 *   one project: cp ctx-patch.ts <project>/.omp/extensions/
 *   ad hoc:      omp --extension ~/Downloads/omp-safe-edit/ctx-patch.ts
 *
 * Env
 * ---
 *   OMP_KEEP_BUILTIN_EDIT=1        keep the built-in line-anchored `edit` active
 */

import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const PREVIEW_COLUMNS = 120;

/** Match strictness, tried in order. Ported from codex's `seek_sequence` ladder. */
type Level = "exact" | "trailing-space" | "indentation" | "unicode";
const LEVELS: readonly Level[] = ["exact", "trailing-space", "indentation", "unicode"];

/** Fold typographic punctuation to ASCII so an ASCII-authored patch matches typographic source. */
function foldUnicode(text: string): string {
	let out = "";
	for (const ch of text.trim()) {
		switch (ch) {
			case "‐":
			case "‑":
			case "‒":
			case "–":
			case "—":
			case "―":
			case "−":
				out += "-";
				break;
			case "‘":
			case "’":
			case "‚":
			case "‛":
				out += "'";
				break;
			case "“":
			case "”":
			case "„":
			case "‟":
				out += '"';
				break;
			case "\u00a0":
			case "\u2002":
			case "\u2003":
			case "\u2004":
			case "\u2005":
			case "\u2006":
			case "\u2007":
			case "\u2008":
			case "\u2009":
			case "\u200a":
			case "\u202f":
			case "\u205f":
			case "\u3000":
				out += " ";
				break;
			default:
				out += ch;
		}
	}
	return out;
}

function linesEqual(a: string, b: string, level: Level): boolean {
	switch (level) {
		case "exact":
			return a === b;
		case "trailing-space":
			return a.trimEnd() === b.trimEnd();
		case "indentation":
			return a.trim() === b.trim();
		case "unicode":
			return foldUnicode(a) === foldUnicode(b);
	}
}

function matchesAt(lines: readonly string[], pattern: readonly string[], at: number, level: Level): boolean {
	for (let i = 0; i < pattern.length; i++) {
		if (!linesEqual(lines[at + i], pattern[i], level)) return false;
	}
	return true;
}

function clip(line: string): string {
	return line.length > PREVIEW_COLUMNS ? `${line.slice(0, PREVIEW_COLUMNS)}…` : line;
}

interface Placement {
	index: number;
	level: Level;
}

/** Find the first locator match, using the same ladder as hunk matching. */
function seekLocator(lines: readonly string[], locator: string, from: number, label: string): number {
	for (const level of LEVELS) {
		for (let i = from; i < lines.length; i++) {
			if (linesEqual(lines[i], locator, level)) return i;
		}
	}
	throw new Error(
		`${label}: the "@@" locator ${JSON.stringify(clip(locator))} does not match any line at or after line ` +
			`${from + 1}. The text after "@@" must be copied verbatim from the file (a bare "@@" with no text is ` +
			`also valid when the hunk's own context is enough to place it).`,
	);
}

/** First match at the strictest matching level, as in Codex seek_sequence. */
function seekSequence(
	lines: readonly string[],
	pattern: readonly string[],
	from: number,
	isEndOfFile = false,
): Placement | undefined {
	if (pattern.length === 0) return { index: from, level: "exact" };
	if (pattern.length > lines.length) return undefined;
	const windowStart = isEndOfFile ? Math.max(from, lines.length - pattern.length) : from;
	for (const level of LEVELS) {
		for (let i = windowStart; i + pattern.length <= lines.length; i++) {
			if (matchesAt(lines, pattern, i, level)) return { index: i, level };
		}
	}
	return undefined;
}

type RowKind = " " | "-" | "+";
interface Row {
	kind: RowKind;
	text: string;
}
interface Hunk {
	rows: Row[];
	/** Text after `@@`, or "" for a bare `@@`. Narrows the search window. */
	locator: string;
	/** Set by a trailing `*** End of File`: the hunk must match at the file's tail. */
	isEndOfFile: boolean;
}
interface Section {
	op: "update" | "add" | "delete";
	path: string;
	moveTo?: string;
	hunks: Hunk[];
	addLines: string[];
}

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";

/** Parse the `*** Begin Patch` envelope into per-file sections. */
function parseEnvelope(input: string): Section[] {
	const lines = input.replace(/\r\n?/g, "\n").split("\n");
	let start = 0;
	while (start < lines.length && lines[start].trim().length === 0) start++;
	if (lines[start]?.trim() !== BEGIN) throw new Error(`Patch must start with "${BEGIN}".`);
	start++;

	const sections: Section[] = [];
	let current: Section | undefined;
	let hunk: Hunk | undefined;
	let sawEnd = false;

	const closeHunk = () => {
		if (hunk && hunk.rows.length > 0) current?.hunks.push(hunk);
		hunk = undefined;
	};

	for (let i = start; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();

		if (trimmed === END) {
			sawEnd = true;
			break;
		}
		if (line.startsWith("*** ")) {
			// Grammar order is `change: change_line+ eof_line?`, so this marker
			// belongs to the hunk still open above it — record it before closing.
			if (trimmed === "*** End of File") {
				if (hunk === undefined) {
					throw new Error(`"*** End of File" must follow a hunk body (line ${i + 1}).`);
				}
				hunk.isEndOfFile = true;
				continue;
			}
			const update = /^\*\*\* Update File:\s*(.+)$/.exec(line);
			const add = /^\*\*\* Add File:\s*(.+)$/.exec(line);
			const del = /^\*\*\* Delete File:\s*(.+)$/.exec(line);
			const move = /^\*\*\* Move to:\s*(.+)$/.exec(line);
			closeHunk();
			if (update) {
				current = { op: "update", path: update[1].trim(), hunks: [], addLines: [] };
				sections.push(current);
			} else if (add) {
				current = { op: "add", path: add[1].trim(), hunks: [], addLines: [] };
				sections.push(current);
			} else if (del) {
				current = { op: "delete", path: del[1].trim(), hunks: [], addLines: [] };
				sections.push(current);
			} else if (move) {
				if (!current || current.op !== "update") {
					throw new Error(`"*** Move to:" must follow an "*** Update File:" section (line ${i + 1}).`);
				}
				current.moveTo = move[1].trim();
			} else {
				throw new Error(`Unrecognized directive on line ${i + 1}: ${clip(trimmed)}`);
			}
			continue;
		}
		if (!current) {
			if (trimmed.length === 0) continue;
			throw new Error(`Content on line ${i + 1} appears before any "*** Update/Add/Delete File:" directive.`);
		}
		if (current.op === "delete") {
			if (trimmed.length > 0) throw new Error(`"*** Delete File:" takes no body (line ${i + 1}).`);
			continue;
		}
		if (current.op === "add") {
			if (line.startsWith("+")) current.addLines.push(line.slice(1));
			else if (trimmed.length > 0) {
				throw new Error(`Lines in an "*** Add File:" section must start with "+" (line ${i + 1}).`);
			}
			continue;
		}
		if (line.startsWith("@@")) {
			closeHunk();
			hunk = { rows: [], locator: line.slice(2).trim(), isEndOfFile: false };
			continue;
		}
		hunk ??= { rows: [], locator: "", isEndOfFile: false };
		if (line.startsWith(" ")) hunk.rows.push({ kind: " ", text: line.slice(1) });
		else if (line.startsWith("-")) hunk.rows.push({ kind: "-", text: line.slice(1) });
		else if (line.startsWith("+")) hunk.rows.push({ kind: "+", text: line.slice(1) });
		else if (line.length === 0) hunk.rows.push({ kind: " ", text: "" });
		else throw new Error(`Line ${i + 1} must start with " ", "-", "+", or "@@": ${clip(line)}`);
	}
	closeHunk();

	if (!sawEnd) throw new Error(`Patch is missing the closing "${END}" line.`);
	for (const section of sections) {
		if (section.op === "update" && section.hunks.length === 0) {
			throw new Error(`"*** Update File: ${section.path}" has no hunks.`);
		}
	}
	return sections;
}

type LineEnding = "\r\n" | "\n";
interface Shape {
	bom: string;
	ending: LineEnding;
}

function decode(raw: string): { text: string; shape: Shape } {
	const bom = raw.startsWith("﻿") ? "﻿" : "";
	const body = bom ? raw.slice(1) : raw;
	const crlf = body.indexOf("\r\n");
	const lf = body.indexOf("\n");
	const ending: LineEnding = lf !== -1 && crlf !== -1 && crlf < lf ? "\r\n" : "\n";
	const text = body.indexOf("\r") === -1 ? body : body.replace(/\r\n?/g, "\n");
	return { text, shape: { bom, ending } };
}

function encode(text: string, shape: Shape): string {
	const body = shape.ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
	return shape.bom + body;
}

function resolveTarget(rawPath: string, cwd: string): string {
	return resolve(cwd, rawPath);
}

interface UpdateOutcome {
	text: string;
	removed: number;
	added: number;
	fuzzy: Level[];
	firstLine: number;
}

/** Locate every hunk against the original text, then splice back-to-front. */
function applyUpdate(text: string, section: Section): UpdateOutcome {
	const trailingNewline = text.endsWith("\n");
	const lines = text.length === 0 ? [] : text.split("\n");
	if (trailingNewline) lines.pop();

	const located: { placement: Placement; pattern: string[]; rows: Row[] }[] = [];
	let cursor = 0;
	for (const [index, hunk] of section.hunks.entries()) {
		let rows = hunk.rows;
		let pattern = rows.filter(row => row.kind !== "+").map(row => row.text);
		const label = hunk.locator
			? `${section.path} hunk ${index + 1} (@@ ${clip(hunk.locator)})`
			: `${section.path} hunk ${index + 1}`;
		if (hunk.locator) cursor = seekLocator(lines, hunk.locator, cursor, label) + 1;
		if (pattern.length === 0) {
			located.push({ placement: { index: lines.length, level: "exact" }, pattern, rows });
			continue;
		}
		let placement = seekSequence(lines, pattern, cursor, hunk.isEndOfFile);
		if (!placement && pattern.at(-1) === "") {
			pattern = pattern.slice(0, -1);
			// Remove the old/new trailing sentinel independently, including when
			// the patch expresses it as a removed or added blank line.
			const oldEnd = rows.findLastIndex(row => row.kind !== "+");
			const newEnd = rows.findLastIndex(row => row.kind !== "-");
			const trimNew = newEnd >= 0 && rows[newEnd].text === "";
			rows = rows.flatMap((row, i): Row[] => {
				const keepOld = row.kind !== "+" && i !== oldEnd;
				const keepNew = row.kind !== "-" && !(trimNew && i === newEnd);
				if (!keepOld && !keepNew) return [];
				return [{ kind: keepOld && keepNew ? " " : keepOld ? "-" : "+", text: row.text }];
			});
			placement = seekSequence(lines, pattern, cursor, hunk.isEndOfFile);
		}
		if (!placement) {
			const reason = pattern.length > lines.length ? "hunk is longer than the file" : "context not found";
			const tail = hunk.isEndOfFile ? ' (does not match the tail required by "*** End of File")' : "";
			throw new Error(`${label}: ${reason}${tail}.\nRe-read the file and copy the expected lines:\n${pattern.join("\n")}`);
		}
		located.push({ placement, pattern, rows });
		cursor = placement.index + pattern.length;
	}

	let removed = 0;
	let added = 0;
	const fuzzy: Level[] = [];
	let firstLine = Number.POSITIVE_INFINITY;
	const result = [...lines];

	located.sort((a, b) => a.placement.index - b.placement.index);
	for (let i = located.length - 1; i >= 0; i--) {
		const { placement, pattern, rows } = located[i];
		const { index, level } = placement;
		if (level !== "exact") fuzzy.push(level);
		firstLine = Math.min(firstLine, index + 1);

		const matched = lines.slice(index, index + pattern.length);
		const replacement: string[] = [];
		let offset = 0;
		for (const row of rows) {
			if (row.kind === " ") {
				// Keep the file's own text so a whitespace-tolerant match never
				// rewrites lines the patch left unchanged.
				replacement.push(matched[offset]);
				offset++;
			} else if (row.kind === "-") {
				offset++;
				removed++;
			} else {
				replacement.push(row.text);
				added++;
			}
		}
		result.splice(index, pattern.length, ...replacement);
	}

	const joined = result.join("\n");
	return {
		text: result.length > 0 && (trailingNewline || text.length === 0) ? `${joined}\n` : joined,
		removed,
		added,
		fuzzy,
		firstLine: Number.isFinite(firstLine) ? firstLine : 1,
	};
}

export default function ctxPatchExtension(pi: ExtensionAPI) {
	const z = pi.zod;
	const stats = { applied: 0, rejected: 0, hunks: 0, fuzzyHunks: 0, removed: 0, added: 0 };

	pi.setLabel("ctx_patch (context-anchored edit)");

	pi.registerTool({
		name: "ctx_patch",
		label: "Ctx Patch",
		description: [
			"Apply a context diff to one or more files. Each hunk is located by its own content, never by line number.",
			"",
			"Envelope:",
			"  *** Begin Patch",
			"  *** Update File: path/to/file.ts",
			"  @@ optional locator text",
			"   unchanged context line",
			"  -removed line",
			"  +added line",
			"   unchanged context line",
			"  *** End Patch",
			"",
			'Every line inside a hunk carries a one-character prefix: " " keeps it, "-" removes it, "+" adds it.',
			"Context and removed lines locate the hunk. The first match is used, trying exact text before",
			"whitespace and Unicode normalization. Added lines are written verbatim, without reindentation.",
			"A hunk made only of `+` lines appends at the end of the file.",
			"",
			'Text after "@@" is a search anchor, not a comment: it must match a line using the same matching rules.',
			"The search continues below that line. Use the enclosing declaration there to disambiguate a hunk",
			'whose context repeats elsewhere in the file. A bare "@@" with no text applies no narrowing.',
			'End a hunk with "*** End of File" when its context is the tail of the file.',
			"",
			'Use "*** Add File: path" followed by "+" lines to create or overwrite a file; "*** Delete File: path" removes it.',
			'Put "*** Move to: path" immediately after "*** Update File: path" to rename the updated file.',
			"",
			"Files are applied in order. If a later file fails, earlier changes remain and are listed in the error.",
		].join("\n"),
		approval: "write",
		loadMode: "essential",
		parameters: z.object({
			input: z.string().describe('The complete patch envelope, from "*** Begin Patch" to "*** End Patch".'),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			let sections: Section[];
			try {
				sections = parseEnvelope(params.input);
			} catch (error) {
				stats.rejected++;
				throw error;
			}

			// Resolve relative paths against the session cwd; permissions belong to the host.
			const planned = sections.map(section => ({
				section,
				target: resolveTarget(section.path, ctx.cwd),
				moveTarget: section.moveTo ? resolveTarget(section.moveTo, ctx.cwd) : undefined,
			}));

			const summary: string[] = [];
			const warnings: string[] = [];
			let totalRemoved = 0;
			let totalAdded = 0;

			try {
				for (const { section, target, moveTarget } of planned) {
					if (section.op === "delete") {
						try {
							await unlink(target);
						} catch (error) {
							if ((error as NodeJS.ErrnoException).code === "ENOENT") {
								throw new Error(`Cannot delete ${section.path}: the file does not exist.`);
							}
							throw error;
						}
						summary.push(`D ${section.path}`);
						continue;
					}

					if (section.op === "add") {
						await mkdir(dirname(target), { recursive: true });
						await writeFile(target, section.addLines.map(line => `${line}\n`).join(""), "utf8");
						totalAdded += section.addLines.length;
						summary.push(`A ${section.path}`);
						continue;
					}

					let raw: string;
					try {
						raw = await readFile(target, "utf8");
					} catch (error) {
						const code = (error as NodeJS.ErrnoException).code;
						if (code === "ENOENT") throw new Error(`Cannot update ${section.path}: the file does not exist.`);
						if (code === "EISDIR") throw new Error(`Cannot update ${section.path}: the path is a directory.`);
						throw error;
					}
					const { text, shape } = decode(raw);
					const outcome = applyUpdate(text, section);
					const contents = encode(outcome.text, shape);
					if (moveTarget && moveTarget !== target) {
						await mkdir(dirname(moveTarget), { recursive: true });
						await writeFile(moveTarget, contents, "utf8");
						// Record the destination before removing the source so a failed
						// removal still reports the change that already reached disk.
						summary.push(`A ${section.moveTo} (move destination written; source not yet removed)`);
						await unlink(target);
						summary[summary.length - 1] = `M ${section.path} → ${section.moveTo}`;
					} else {
						await writeFile(target, contents, "utf8");
						summary.push(`M ${section.path} (from line ${outcome.firstLine})`);
					}

					stats.hunks += section.hunks.length;
					stats.fuzzyHunks += outcome.fuzzy.length;
					totalRemoved += outcome.removed;
					totalAdded += outcome.added;
					if (outcome.fuzzy.length > 0) {
						const levels = [...new Set(outcome.fuzzy)].join(", ");
						warnings.push(`${section.path}: ${outcome.fuzzy.length} hunk(s) matched only after relaxing on ${levels}.`);
					}

				}
			} catch (error) {
				stats.rejected++;
				if (summary.length > 0) {
					throw new Error(
						`${String((error as Error).message ?? error)}\n\n` +
							`Note: files are patched one at a time and this patch was partially applied before failing:\n` +
							summary.map(l => `  ${l}`).join("\n"),
					);
				}
				throw error;
			}

			stats.applied++;
			stats.removed += totalRemoved;
			stats.added += totalAdded;

			const body = ["Success. Updated the following files:", ...summary, `-${totalRemoved}/+${totalAdded} lines.`];
			if (warnings.length > 0) body.push("", "Warnings:", ...warnings.map(w => `  ${w}`));
			return {
				content: [{ type: "text" as const, text: body.join("\n") }],
				details: { files: summary, linesRemoved: totalRemoved, linesAdded: totalAdded, warnings },
			};
		},
	});

	pi.registerCommand("ctx-patch-stats", {
		description: "Show ctx_patch accept/reject counts for this session",
		handler: async (_args, ctx) => {
			const total = stats.applied + stats.rejected;
			ctx.ui.notify(
				`ctx_patch — ${stats.applied}/${total} applied, ${stats.rejected} rejected, ` +
					`${stats.hunks} hunks (${stats.fuzzyHunks} fuzzy), ` +
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
			if (!next.includes("ctx_patch")) next.push("ctx_patch");
			await pi.setActiveTools(next);
			pi.logger.debug("ctx-patch: replaced built-in `edit` with `ctx_patch`");
		} catch (error) {
			ctx.ui.notify(`ctx-patch: could not swap out built-in edit (${String(error)})`, "warning");
		}
	});
}
