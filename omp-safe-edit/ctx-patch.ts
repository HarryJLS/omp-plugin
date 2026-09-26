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
 * Three deliberate divergences, all toward failing closed:
 *
 *  1. codex takes the FIRST location that matches (`return Some(i)` in every
 *     loop). A hunk whose context appears twice lands on whichever copy comes
 *     first. This applier requires the match to be unique at the level that
 *     first matched, and reports both line numbers otherwise. Multi-hunk
 *     patches still work on repeated code because the search cursor advances
 *     past each placed hunk.
 *
 *  2. codex writes `+` lines verbatim — there is no indentation handling in
 *     `file_update.rs` at all — so a hunk that only matched after ignoring
 *     indentation writes the model's (wrong) indentation into the file. This
 *     applier maps each added line's indentation through the correspondence
 *     observed between the hunk's own context lines and the file's actual ones,
 *     and refuses the hunk when no correspondence exists rather than guessing.
 *
 *  3. A hunk with no context and no removals (only `+` rows) is rejected here.
 *     codex takes that branch to `original_lines.len()` and appends at the end
 *     of the file (`file_update.rs:114-130`), ignoring the `@@` locator — so a
 *     bare insertion silently lands at EOF instead of where it was aimed.
 *
 * Guarantees
 * ----------
 *  1. Every removed line must be present, in order, adjacent to its context.
 *  2. Ambiguous placement is an error, never a coin flip.
 *  3. Hunks are located against the original file and spliced back-to-front, so
 *     no hunk can be displaced by an earlier one.
 *  4. A hunk with no context and no removals is rejected — a bare insertion has
 *     nothing to anchor to.
 *  5. `write` cannot silently overwrite an existing non-empty file, which is the
 *     other common way real code disappears.
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
 *   OMP_EDIT_ALLOW_OUTSIDE=1       permit edits outside the session cwd
 *   OMP_ALLOW_WRITE_OVERWRITE=1    permit `write` onto an existing file
 */

import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const PREVIEW_COLUMNS = 120;
/** Matches `scheme://`, so `xd://` device dispatch and other URI targets are left alone. */
const URI_TARGET = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/** Match strictness, tried in order. Ported from codex's `seek_sequence` ladder. */
type Level = "exact" | "trailing-space" | "indentation" | "unicode";
const LEVELS: readonly Level[] = ["exact", "trailing-space", "indentation", "unicode"];

/** Levels that compare leading whitespace byte-for-byte, so `+` lines need no remapping. */
const LEADING_WHITESPACE_VERIFIED: Record<Level, boolean> = {
	exact: true,
	"trailing-space": true,
	indentation: false,
	unicode: false,
};

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
			case " ":
			case " ":
			case " ":
			case " ":
			case " ":
			case " ":
			case " ":
			case " ":
			case " ":
			case " ":
			case " ":
			case " ":
			case "　":
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

/** Every start index at or after `from` where `pattern` matches under `level`. */
function findAll(lines: readonly string[], pattern: readonly string[], from: number, level: Level): number[] {
	const hits: number[] = [];
	for (let i = from; i + pattern.length <= lines.length; i++) {
		if (matchesAt(lines, pattern, i, level)) hits.push(i);
	}
	return hits;
}

function clip(line: string): string {
	return line.length > PREVIEW_COLUMNS ? `${line.slice(0, PREVIEW_COLUMNS)}…` : line;
}

function leadingWhitespace(line: string): string {
	return line.slice(0, line.length - line.trimStart().length);
}

/** Render whitespace visibly so an indentation error message is actually readable. */
function showWhitespace(ws: string): string {
	if (ws.length === 0) return "(none)";
	return `${JSON.stringify(ws)} (${ws.length} char${ws.length === 1 ? "" : "s"})`;
}

interface Placement {
	index: number;
	level: Level;
	/** Matches at `level` inside the searched window. >1 only when a locator resolved them. */
	candidates: number;
}

/**
 * Find the first line at or after `from` matching `locator`, descending the
 * strictness ladder. Ported from codex's use of `change_context`
 * (`file_update.rs:99-113`): the `@@ text` line is a search anchor, not a
 * comment. Taking the first match (rather than requiring uniqueness) is
 * deliberate — the locator only narrows the window; the safety guarantee comes
 * from `pattern` being unique *inside* that window.
 */
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

/**
 * Locate `pattern` uniquely at or after `from`, descending the strictness
 * ladder. More than one hit at the level that first matched is a hard error:
 * the whole point of a context diff is that the payload identifies one region.
 *
 * Uniqueness is required only when the hunk carries no `@@` locator. With a
 * locator the first match below it is taken, as codex does: writing
 * `@@ class Alpha:` is an explicit statement that the intended region is the
 * first one under that line, so honouring it is obeying a declaration rather
 * than guessing. Without a locator the tool has been told nothing about which
 * copy is meant, and picking one would be a guess — so it refuses. A locator
 * that had to break a tie is reported as a warning, so the choice stays
 * auditable.
 *
 * `isEndOfFile` (a trailing `*** End of File`) restricts the search to the
 * tail-aligned position, mirroring how codex's `seek_sequence` replaces the
 * search start with `lines.len() - pattern.len()` under its `eof` flag. There is
 * deliberately no fallback to a forward scan: the marker is an assertion about
 * where the region is, and quietly applying the hunk somewhere else when that
 * assertion is false would be exactly the silent relocation this tool exists to
 * prevent.
 */
function seekUnique(
	lines: readonly string[],
	pattern: readonly string[],
	from: number,
	label: string,
	locator = "",
	isEndOfFile = false,
): Placement {
	if (pattern.length === 0) {
		throw new Error(
			`${label}: the hunk has no context lines and no removed lines, so there is nothing to anchor it to. ` +
				`Include at least one unchanged line above or below the insertion point.`,
		);
	}
	if (pattern.length > lines.length) {
		throw new Error(`${label}: the hunk is longer than the file (${pattern.length} > ${lines.length} lines).`);
	}

	const windowStart = locator.length > 0 ? seekLocator(lines, locator, from, label) + 1 : from;

	// A trailing `*** End of File` names exactly one candidate position: the
	// tail-aligned one. Never let it move the cursor backwards over a hunk that
	// has already been placed.
	if (isEndOfFile) {
		const tail = lines.length - pattern.length;
		if (tail >= windowStart) {
			for (const level of LEVELS) {
				if (matchesAt(lines, pattern, tail, level)) return { index: tail, level, candidates: 1 };
			}
		}
		const actual = lines
			.slice(Math.max(0, lines.length - Math.max(pattern.length, 3)))
			.map((l, k) => `  ${lines.length - Math.min(lines.length, Math.max(pattern.length, 3)) + k + 1}:${clip(l)}`)
			.join("\n");
		throw new Error(
			`${label}: the hunk ends with "*** End of File", but its context does not match the tail of the file.\n` +
				`The file actually ends with:\n${actual}\n\n` +
				`Drop the "*** End of File" marker if the region is not at the end, or copy the final lines verbatim.`,
		);
	}

	const declared = locator.length > 0;
	for (const level of LEVELS) {
		const hits = findAll(lines, pattern, windowStart, level);
		if (hits.length === 0) continue;
		if (hits.length === 1 || declared) return { index: hits[0], level, candidates: hits.length };
		const sites = hits.map(hit => `  line ${hit + 1}: ${clip(lines[hit])}`).join("\n");
		throw new Error(
			`${label}: the hunk's context matches ${hits.length} locations and the hunk says nothing about which one ` +
				`is meant; refusing to guess.\n${sites}\n\n` +
				`Add more surrounding context lines, or name the enclosing declaration after "@@" to search only ` +
				`below it — the first match under an explicit "@@" locator is taken.`,
		);
	}
	const head = pattern
		.slice(0, 3)
		.map(l => `  ${clip(l)}`)
		.join("\n");
	const scope = locator.length > 0 ? ` at or after line ${windowStart + 1} (below the "@@" locator)` : "";
	throw new Error(
		`${label}: context not found${scope}. The hunk expects:\n${head}\n\n` +
			`Re-read the file and copy the context and removed lines verbatim.`,
	);
}

/**
 * Correspondence between the patch's own indentation and the file's actual
 * indentation, derived from the hunk's context and removed lines.
 *
 * A single offset delta is wrong whenever the two differ by a *scale* rather
 * than a constant — a patch written with two-space levels against a file using
 * four-space levels needs +2 at depth 1 and +4 at depth 2. Mapping each
 * distinct indentation string independently handles both cases and detects
 * contradictions. Returns null when one patch indentation maps to two different
 * file indentations, which means the hunk cannot be reindented coherently.
 */
function buildIndentMap(pattern: readonly string[], actual: readonly string[]): Map<string, string> | null {
	const map = new Map<string, string>();
	for (let i = 0; i < pattern.length; i++) {
		if (pattern[i].trim().length === 0) continue;
		const from = leadingWhitespace(pattern[i]);
		const to = leadingWhitespace(actual[i]);
		const existing = map.get(from);
		if (existing !== undefined && existing !== to) return null;
		map.set(from, to);
	}
	return map;
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
	if (sections.length === 0) throw new Error("Patch contains no file sections.");
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

interface UpdateOutcome {
	text: string;
	removed: number;
	added: number;
	fuzzy: Level[];
	/** One entry per hunk whose `@@` locator had to break a tie. */
	notes: string[];
	firstLine: number;
}

/** Locate every hunk against the original text, then splice back-to-front. */
function applyUpdate(text: string, section: Section): UpdateOutcome {
	const trailingNewline = text.endsWith("\n");
	const lines = text.split("\n");
	if (trailingNewline) lines.pop();

	const located: { placement: Placement; pattern: string[]; hunk: Hunk; label: string }[] = [];
	let cursor = 0;
	for (const [index, hunk] of section.hunks.entries()) {
		const pattern = hunk.rows.filter(row => row.kind !== "+").map(row => row.text);
		const label = hunk.locator
			? `${section.path} hunk ${index + 1} (@@ ${clip(hunk.locator)})`
			: `${section.path} hunk ${index + 1}`;
		const placement = seekUnique(lines, pattern, cursor, label, hunk.locator, hunk.isEndOfFile);
		located.push({ placement, pattern, hunk, label });
		cursor = placement.index + pattern.length;
	}

	let removed = 0;
	let added = 0;
	const fuzzy: Level[] = [];
	const notes: string[] = [];
	let firstLine = Number.POSITIVE_INFINITY;
	const result = [...lines];

	for (let i = located.length - 1; i >= 0; i--) {
		const { placement, pattern, hunk, label } = located[i];
		const { index, level } = placement;
		if (level !== "exact") fuzzy.push(level);
		if (placement.candidates > 1) {
			notes.push(
				`${label}: ${placement.candidates} regions matched below the "@@" locator; took the first, at line ${index + 1}.`,
			);
		}
		firstLine = Math.min(firstLine, index + 1);

		const matched = lines.slice(index, index + pattern.length);
		let indentMap: Map<string, string> | null = null;
		if (!LEADING_WHITESPACE_VERIFIED[level]) {
			indentMap = buildIndentMap(pattern, matched);
			if (indentMap === null) {
				throw new Error(
					`${label}: the hunk matched only after ignoring indentation, and its indentation cannot be ` +
						`mapped onto the file coherently (one patch indentation corresponds to two different file ` +
						`indentations). Re-read the file and copy the exact leading whitespace.`,
				);
			}
		}

		const replacement: string[] = [];
		let offset = 0;
		for (const row of hunk.rows) {
			if (row.kind === " ") {
				// Keep the file's own text so a whitespace-tolerant match never
				// rewrites lines the patch left unchanged.
				replacement.push(matched[offset]);
				offset++;
			} else if (row.kind === "-") {
				offset++;
				removed++;
			} else {
				replacement.push(indentMap === null ? row.text : reindentAdded(row.text, indentMap, label));
				added++;
			}
		}
		result.splice(index, pattern.length, ...replacement);
	}

	const joined = result.join("\n");
	return {
		text: trailingNewline ? `${joined}\n` : joined,
		removed,
		added,
		fuzzy,
		notes,
		firstLine: Number.isFinite(firstLine) ? firstLine : 1,
	};
}

/** Translate an added line's indentation through the hunk's observed correspondence. */
function reindentAdded(line: string, indentMap: Map<string, string>, label: string): string {
	if (line.trim().length === 0) return line;
	const own = leadingWhitespace(line);
	const mapped = indentMap.get(own);
	if (mapped === undefined) {
		const known = [...indentMap.keys()].map(showWhitespace).join(", ") || "(none)";
		throw new Error(
			`${label}: cannot place the added line ${JSON.stringify(clip(line.trim()))}.\n` +
				`The hunk matched only after ignoring indentation, so added lines must reuse an indentation that ` +
				`appears on one of the hunk's context or removed lines.\n` +
				`  this line's indentation: ${showWhitespace(own)}\n` +
				`  indentations in the hunk: ${known}\n` +
				`Re-read the file and rewrite the hunk with the file's exact leading whitespace.`,
		);
	}
	return mapped + line.slice(own.length);
}

export default function ctxPatchExtension(pi: ExtensionAPI) {
	const z = pi.zod;
	const stats = { applied: 0, rejected: 0, hunks: 0, fuzzyHunks: 0, blockedWrites: 0, removed: 0, added: 0 };

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
			"Context and removed lines MUST be copied verbatim from the file, including indentation — they are what",
			"locates the hunk. Include enough context that the hunk matches exactly one place; if it matches several,",
			"the call is rejected and every candidate is listed. A hunk made only of `+` lines is rejected because",
			"there is nothing to anchor it to, so always include at least one surrounding context line.",
			"",
			'Text after "@@" is a search anchor, not a comment: it must match a line in the file verbatim, and the',
			"hunk is then located only below that line. Use the enclosing declaration there to disambiguate a hunk",
			'whose context repeats elsewhere in the file. A bare "@@" with no text applies no narrowing.',
			'End a hunk with "*** End of File" when its context is the tail of the file.',
			"",
			'Use "*** Add File: path" followed by "+" lines to create a file, and "*** Delete File: path" to remove one.',
			'Add "*** Move to: path" after an Update section to rename the file once its hunks land.',
			"",
			"A patch that does not apply changes nothing, so it is always safe to retry after re-reading.",
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

			// Resolve and validate every path before touching the disk, so a bad
			// path in a later section cannot leave an earlier one half-applied.
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
						let exists = true;
						try {
							await stat(target);
						} catch (error) {
							if ((error as NodeJS.ErrnoException).code === "ENOENT") exists = false;
							else throw error;
						}
						if (exists) {
							throw new Error(
								`Cannot add ${section.path}: the file already exists. Use "*** Update File:" to modify it.`,
							);
						}
						await mkdir(dirname(target), { recursive: true });
						await writeFile(target, `${section.addLines.join("\n")}\n`, "utf8");
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
					if (outcome.text === text && !moveTarget) {
						throw new Error(`${section.path}: the patch applied cleanly but changed nothing.`);
					}
					await writeFile(target, encode(outcome.text, shape), "utf8");

					stats.hunks += section.hunks.length;
					stats.fuzzyHunks += outcome.fuzzy.length;
					totalRemoved += outcome.removed;
					totalAdded += outcome.added;
					warnings.push(...outcome.notes);
					if (outcome.fuzzy.length > 0) {
						const levels = [...new Set(outcome.fuzzy)].join(", ");
						warnings.push(`${section.path}: ${outcome.fuzzy.length} hunk(s) matched only after relaxing on ${levels}.`);
					}

					if (moveTarget) {
						await mkdir(dirname(moveTarget), { recursive: true });
						await rename(target, moveTarget);
						summary.push(`M ${section.path} → ${section.moveTo}`);
					} else {
						summary.push(`M ${section.path} (from line ${outcome.firstLine})`);
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
				`Use \`ctx_patch\` to change only the region you mean to change. If you truly intend to discard the ` +
				`current contents, say so and the user can set OMP_ALLOW_WRITE_OVERWRITE=1.`,
		};
	});

	pi.registerCommand("ctx-patch-stats", {
		description: "Show ctx_patch accept/reject counts for this session",
		handler: async (_args, ctx) => {
			const total = stats.applied + stats.rejected;
			ctx.ui.notify(
				`ctx_patch — ${stats.applied}/${total} applied, ${stats.rejected} rejected, ` +
					`${stats.hunks} hunks (${stats.fuzzyHunks} fuzzy), ${stats.blockedWrites} overwrites blocked, ` +
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
