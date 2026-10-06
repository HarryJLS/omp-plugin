import { mkdtemp, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
// The real schema builder when this runs inside the oh-my-pi workspace; a stub
// otherwise. Tests call `execute` directly, so the schema is never exercised —
// it only has to be constructible at registration time.
let zod: any;
try {
	zod = await import("@oh-my-pi/omptype/zod");
} catch {
	const leaf = () => { const n: any = { describe: () => n, optional: () => n }; return n; };
	zod = { object: (shape: unknown) => ({ shape }), string: leaf, boolean: leaf };
}
import strReplace from "./str-replace.ts";
import ctxPatch from "./ctx-patch.ts";

const tools: Record<string, any> = {};
const handlers: Record<string, Function[]> = {};
function mkPi() {
	return {
		zod, pi: {},
		logger: { debug() {}, warn() {}, error() {} },
		setLabel() {}, registerCommand() {},
		registerTool(t: any) { tools[t.name] = t; },
		on(ev: string, h: Function) { (handlers[ev] ??= []).push(h); },
		getActiveTools: () => [],
		setActiveTools: async () => {},
	} as any;
}
strReplace(mkPi());
const srHandlers = [...(handlers.tool_call ?? [])];
handlers.tool_call = [];
ctxPatch(mkPi());
const cpHandlers = [...(handlers.tool_call ?? [])];

let pass = 0, fail = 0;
const failures: string[] = [];
const root = await mkdtemp(join(tmpdir(), "omp-edit-"));
const ctx: any = { cwd: root, ui: { notify() {} } };

let seq = 0;
async function seed(content: string, name = `f${++seq}.ts`): Promise<string> {
	const p = join(root, name);
	await mkdir(dirname(p), { recursive: true });
	await writeFile(p, content, "utf8");
	return name;
}
const run = (tool: string, params: any) => tools[tool].execute("t", params, undefined, undefined, ctx);
const read = (name: string) => readFile(join(root, name), "utf8");

function ok(label: string, cond: boolean, detail = "") {
	if (cond) { pass++; console.log(`  ok   ${label}`); }
	else { fail++; failures.push(label); console.log(`  FAIL ${label}${detail ? `\n         ${detail}` : ""}`); }
}
function eq(label: string, actual: string, expected: string) {
	ok(label, actual === expected, actual === expected ? "" : `got      ${JSON.stringify(actual)}\n         expected ${JSON.stringify(expected)}`);
}
async function rejects(label: string, fn: () => Promise<unknown>, ...needles: string[]) {
	try { await fn(); ok(label, false, "expected rejection, got success"); }
	catch (e) {
		const msg = String((e as Error).message ?? e);
		const missing = needles.filter(n => !msg.includes(n));
		ok(label, missing.length === 0, missing.length ? `missing ${JSON.stringify(missing)}\n         in: ${msg.slice(0, 260).replace(/\n/g, "\n         ")}` : "");
	}
}

const PY = "class A:\n    def go(self):\n        return 1\n";
const TS = "function alpha() {\n  return 1;\n}\n\nfunction beta() {\n  return 2;\n}\n";

console.log("\n=== str_replace (claw-code lineage) ===");
{ const f = await seed(TS); await run("str_replace", { path: f, old_string: "  return 1;", new_string: "  return 42;" });
  ok("unique match applies", (await read(f)).includes("return 42;")); }
{ const f = await seed(TS); await rejects("absent needle rejected", () => run("str_replace", { path: f, old_string: "return 999;", new_string: "x" }), "not found");
  eq("…and file untouched", await read(f), TS); }
{ const f = await seed(PY);
  // Relative indentation differs (patch uses 4-space levels, file uses 8), so the
  // block is not a literal substring but every line matches once trimmed.
  await rejects("whitespace drift named with actual lines", () => run("str_replace", { path: f, old_string: "def go(self):\n    return 1", new_string: "def go(self):\n    return 2" }),
    "whitespace differs", "2:    def go(self):", "3:        return 1");
  eq("…and file untouched", await read(f), PY); }
{ const f = await seed("x = 1;\ny = 2;\nx = 1;\n");
  await rejects("two occurrences rejected, both listed", () => run("str_replace", { path: f, old_string: "x = 1;", new_string: "x = 3;" }),
    "occurs 2 times", "line 1", "line 3");
  eq("…and file untouched", await read(f), "x = 1;\ny = 2;\nx = 1;\n"); }
{ const f = await seed("a\na\na\nb\n");
  await rejects("three occurrences counted correctly", () => run("str_replace", { path: f, old_string: "a", new_string: "c" }), "occurs 3 times"); }
{ const f = await seed("x = 1;\ny = 2;\nx = 1;\n"); await run("str_replace", { path: f, old_string: "x = 1;", new_string: "x = 3;", replace_all: true });
  eq("replace_all hits every site", await read(f), "x = 3;\ny = 2;\nx = 3;\n"); }
{ const f = await seed("a = 1;\r\nb = 2;\r\n"); await run("str_replace", { path: f, old_string: "a = 1;", new_string: "a = 9;" });
  eq("CRLF file matched by LF needle, CRLF preserved", await read(f), "a = 9;\r\nb = 2;\r\n"); }
{ const f = await seed("\uFEFFa = 1;\n"); await run("str_replace", { path: f, old_string: "a = 1;", new_string: "a = 2;" });
  eq("BOM preserved", await read(f), "\uFEFFa = 2;\n"); }
await rejects("cwd escape refused", () => run("str_replace", { path: "/etc/hosts", old_string: "a", new_string: "b" }), "outside the session workspace");
{ const f = await seed(TS); await rejects("identical strings rejected", () => run("str_replace", { path: f, old_string: "x", new_string: "x" }), "identical"); }
{ const f = await seed(TS); await rejects("empty old_string rejected", () => run("str_replace", { path: f, old_string: "", new_string: "x" }), "empty"); }
{ const f = await seed("keep\ndrop\nkeep2\n"); await run("str_replace", { path: f, old_string: "drop\n", new_string: "" });
  eq("empty new_string deletes region", await read(f), "keep\nkeep2\n"); }
await rejects("missing file reported clearly", () => run("str_replace", { path: "nope.ts", old_string: "a", new_string: "b" }), "does not exist");
await rejects("directory reported clearly", () => run("str_replace", { path: ".", old_string: "a", new_string: "b" }), "is a directory");
{ const f = await seed(TS); await rejects("unknown first line says re-read", () => run("str_replace", { path: f, old_string: "zzz_nothing\nmore", new_string: "q" }), "Re-read the file"); }
{ const f = await seed(TS); await run("str_replace", { path: f, old_string: "function beta() {\n  return 2;\n}", new_string: "function beta() {\n  return 3;\n}" });
  ok("multi-line match applies", (await read(f)).includes("return 3;")); }
{ const f = await seed("a\nb"); await run("str_replace", { path: f, old_string: "b", new_string: "c" });
  eq("missing trailing newline preserved", await read(f), "a\nc"); }
{ const f = await seed("head\nmid\n"); await run("str_replace", { path: f, old_string: "head", new_string: "HEAD" });
  eq("match at file start", await read(f), "HEAD\nmid\n"); }
{ const f = await seed("mid\ntail\n"); await run("str_replace", { path: f, old_string: "tail\n", new_string: "TAIL\n" });
  eq("match at file end", await read(f), "mid\nTAIL\n"); }
{ const f = await seed("a\nb\nc\n"); await run("str_replace", { path: f, old_string: "b", new_string: "$&x" });
  eq('"$&" in new_string stays literal', await read(f), "a\n$&x\nc\n"); }
{ const f = await seed("a\nb\nc\n"); await run("str_replace", { path: f, old_string: "b", new_string: "$1$$`" });
  eq('"$1", "$$", "$`" stay literal', await read(f), "a\n$1$$`\nc\n"); }
{ const f = await seed("p\nq\np\n"); await run("str_replace", { path: f, old_string: "p", new_string: "$&", replace_all: true });
  eq('replace_all keeps "$&" literal', await read(f), "$&\nq\n$&\n"); }
{ const f = await seed("if x:\n\tdo()\n"); await run("str_replace", { path: f, old_string: "\tdo()", new_string: "\tdone()" });
  eq("tab indentation handled", await read(f), "if x:\n\tdone()\n"); }
{ const f = await seed("const s = \"日本語\";\n"); await run("str_replace", { path: f, old_string: "日本語", new_string: "中文" });
  eq("non-ASCII content handled", await read(f), "const s = \"中文\";\n"); }

console.log("\n=== ctx_patch (codex lineage) ===");
const P = (body: string) => ({ input: `*** Begin Patch\n${body}*** End Patch\n` });
{ const f = await seed(TS); await run("ctx_patch", P(`*** Update File: ${f}\n@@\n function alpha() {\n-  return 1;\n+  return 42;\n }\n`));
  ok("simple hunk applies", (await read(f)).includes("return 42;")); }
{ const f = await seed(TS); await rejects("phantom removed line rejected", () => run("ctx_patch", P(`*** Update File: ${f}\n@@\n function alpha() {\n-  return 999;\n+  x\n }\n`)), "context not found");
  eq("…and file untouched", await read(f), TS); }
{ const f = await seed("a();\nlog();\nb();\nlog();\nc();\n");
  await run("ctx_patch", P(`*** Update File: ${f}\n@@\n-log();\n+trace();\n`));
  eq("repeated context selects first match", await read(f), "a();\ntrace();\nb();\nlog();\nc();\n"); }
{ const f = await seed("a();\nlog();\nb();\nlog();\nc();\n");
  await run("ctx_patch", P(`*** Update File: ${f}\n@@\n a();\n-log();\n+t1();\n b();\n@@\n-log();\n+t2();\n c();\n`));
  eq("sequential hunks on repeated code", await read(f), "a();\nt1();\nb();\nt2();\nc();\n"); }
{ const f = await seed(TS); await run("ctx_patch", P(`*** Update File: ${f}\n@@\n+// new\n`));
  eq("anchorless insertion appends at EOF", await read(f), `${TS}// new\n`); }
{ const f = await seed(PY); await run("ctx_patch", P(`*** Update File: ${f}\n@@\n   def go(self):\n-    return 1\n+    return 2\n`));
  eq("fuzzy match preserves context but writes additions verbatim", await read(f), "class A:\n    def go(self):\n    return 2\n"); }
{ const f = await seed("def a():\n    if x:\n        y()\n");
  await run("ctx_patch", P(`*** Update File: ${f}\n@@\n def a():\n   if x:\n-    y()\n+    z()\n`));
  eq("nested additions are not reindented", await read(f), "def a():\n    if x:\n    z()\n"); }
{ const f = await seed(PY); await run("ctx_patch", P(`*** Update File: ${f}\n@@\n   def go(self):\n-    return 1\n+      deeper()\n`));
  eq("new indentation level is accepted", await read(f), "class A:\n    def go(self):\n      deeper()\n"); }
{ await run("ctx_patch", P(`*** Add File: sub/deep/new.ts\n+export const x = 1;\n`));
  eq("Add File creates nested path", await read("sub/deep/new.ts"), "export const x = 1;\n");
  await run("ctx_patch", P(`*** Add File: sub/deep/new.ts\n+dup\n`));
  eq("Add File can replace an existing file", await read("sub/deep/new.ts"), "dup\n"); }
{ const f = await seed("bye\n"); await run("ctx_patch", P(`*** Delete File: ${f}\n`));
  ok("Delete File removes it", !(await Bun.file(join(root, f)).exists()));
  await rejects("Delete of missing rejected", () => run("ctx_patch", P(`*** Delete File: ghost.ts\n`)), "does not exist"); }
{ const f = await seed("a = 1;\n"); await run("ctx_patch", P(`*** Update File: ${f}\n@@\n a = 1;\n`));
  eq("no-op patch succeeds", await read(f), "a = 1;\n"); }
await rejects("missing envelope rejected", () => run("ctx_patch", { input: "just text\n" }), "must start with");
await rejects("missing End Patch rejected", () => run("ctx_patch", { input: `*** Begin Patch\n*** Update File: x.ts\n@@\n a\n` }), "missing the closing");
{ const f = await seed("v = 1;\n"); await run("ctx_patch", P(`*** Update File: ${f}\n@@\n-v = 1;\n+v = 2;\n*** Move to: moved/out.ts\n`));
  eq("Move to renames after patching", await read("moved/out.ts"), "v = 2;\n");
  ok("…and original is gone", !(await Bun.file(join(root, f)).exists())); }
{ const a = await seed("a = 1;\n"); const b = await seed("b = 1;\n");
  await run("ctx_patch", P(`*** Update File: ${a}\n@@\n-a = 1;\n+a = 2;\n*** Update File: ${b}\n@@\n-b = 1;\n+b = 2;\n`));
  ok("multi-file patch applies both", (await read(a)) === "a = 2;\n" && (await read(b)) === "b = 2;\n"); }
{ const a = await seed("a = 1;\n"); const b = await seed("b = 1;\n");
  await rejects("multi-file partial application is reported", () => run("ctx_patch", P(`*** Update File: ${a}\n@@\n-a = 1;\n+a = 9;\n*** Update File: ${b}\n@@\n-nope\n+x\n`)), "partially applied", `M ${a}`);
  eq("…first file did land", await read(a), "a = 9;\n"); }
{ const f = await seed("x = 1;   \ny = 2;\n"); await run("ctx_patch", P(`*** Update File: ${f}\n@@\n-x = 1;\n+x = 3;\n y = 2;\n`));
  eq("trailing-space level match", await read(f), "x = 3;\ny = 2;\n"); }
{ const f = await seed("const dash = \u2014;\nnext();\n"); await run("ctx_patch", P(`*** Update File: ${f}\n@@\n-const dash = -;\n+const dash = 0;\n next();\n`));
  eq("unicode fold matches em-dash via ASCII patch", await read(f), "const dash = 0;\nnext();\n"); }
{ const f = await seed("a\nb"); await run("ctx_patch", P(`*** Update File: ${f}\n@@\n a\n-b\n+c\n`));
  eq("missing trailing newline preserved", await read(f), "a\nc"); }
{ const f = await seed("a\nc\n"); await run("ctx_patch", P(`*** Update File: ${f}\n@@\n a\n+b\n c\n`));
  eq("pure insertion between context", await read(f), "a\nb\nc\n"); }
{ const f = await seed("a\nb\nc\n"); await run("ctx_patch", P(`*** Update File: ${f}\n@@\n a\n-b\n c\n`));
  eq("pure deletion with context", await read(f), "a\nc\n"); }
{ const f = await seed("only\n"); await rejects("hunk longer than file rejected", () => run("ctx_patch", P(`*** Update File: ${f}\n@@\n one\n two\n three\n`)), "longer than the file"); }
{ const f = await seed(TS); await rejects("unknown directive rejected", () => run("ctx_patch", P(`*** Frobnicate File: ${f}\n`)), "Unrecognized directive"); }
{ const f = await seed("a = 1;\r\nb = 2;\r\n"); await run("ctx_patch", P(`*** Update File: ${f}\n@@\n-a = 1;\n+a = 9;\n b = 2;\n`));
  eq("CRLF preserved through patch", await read(f), "a = 9;\r\nb = 2;\r\n"); }
{ const f = await seed("a\n\nb\n"); await run("ctx_patch", { input: `*** Begin Patch\n*** Update File: ${f}\n@@\n a\n\n-b\n+c\n*** End Patch\n` });
  eq("bare empty line treated as blank context", await read(f), "a\n\nc\n"); }
{ const f = await seed("a\nb\n"); await run("ctx_patch", P(`*** Update File: ${f}\n@@\n a\n-b\n+c\n*** End of File\n`));
  eq('"*** End of File" tolerated', await read(f), "a\nc\n"); }
await rejects("content before any directive rejected", () => run("ctx_patch", { input: `*** Begin Patch\n stray\n*** End Patch\n` }), "before any");
{ const f = await seed(TS); await rejects("Update File with no hunks rejected", () => run("ctx_patch", P(`*** Update File: ${f}\n`)), "has no hunks"); }
await rejects("Add File body must use +", () => run("ctx_patch", P(`*** Add File: bad.ts\nplain line\n`)), 'must start with "+"');
{ const f = await seed(TS); await rejects("bad row prefix rejected", () => run("ctx_patch", P(`*** Update File: ${f}\n@@\n?huh\n`)), 'must start with'); }
{ const f = await seed("outside\n");
  const nestedCtx = { ...ctx, cwd: join(root, "nested") };
  await tools.ctx_patch.execute("t", P(`*** Update File: ../${f}\n@@\n-outside\n+updated\n`), undefined, undefined, nestedCtx);
  eq("relative paths outside cwd are permitted", await read(f), "updated\n");
  await run("ctx_patch", P(`*** Update File: ${join(root, f)}\n@@\n-updated\n+absolute\n`));
  eq("absolute paths are supported", await read(f), "absolute\n"); }

console.log("\n=== ctx_patch: @@ locator + End of File (ported from file_update.rs) ===");
// A file where the same three-line shape occurs inside two different classes.
const DUP = [
	"class Alpha:", "    def run(self):", "        prepare()", "        return 1", "",
	"class Beta:", "    def run(self):", "        prepare()", "        return 1", "",
].join("\n");
{ const f = await seed(DUP);
  await run("ctx_patch", P(`*** Update File: ${f}\n@@\n         prepare()\n-        return 1\n+        return 2\n`));
  eq("without a locator the first class is selected", await read(f), DUP.replace("return 1", "return 2")); }
{ const f = await seed(DUP);
  await run("ctx_patch", P(`*** Update File: ${f}\n@@ class Beta:\n         prepare()\n-        return 1\n+        return 2\n`));
  const out = await read(f);
  ok("locator narrows to the second class", out.split("\n")[3] === "        return 1" && out.split("\n")[8] === "        return 2",
    JSON.stringify(out)); }
{ const f = await seed(DUP);
  await run("ctx_patch", P(`*** Update File: ${f}\n@@ class Alpha:\n         prepare()\n-        return 1\n+        return 9\n`));
  const out = await read(f);
  ok("locator narrows to the first class", out.split("\n")[3] === "        return 9" && out.split("\n")[8] === "        return 1",
    JSON.stringify(out)); }
{ const f = await seed(DUP);
  await rejects("unmatched locator is reported by name", () => run("ctx_patch", P(`*** Update File: ${f}\n@@ class Gamma:\n-        return 1\n+        return 2\n`)),
    '"@@" locator', "class Gamma:", "verbatim"); }
{ const f = await seed(DUP);
  const r: any = await run("ctx_patch", P(`*** Update File: ${f}\n@@ class Alpha:\n-        prepare()\n+        setup()\n`));
  const out = await read(f);
  ok("locator selects first match without ambiguity warnings",
    out.split("\n")[2] === "        setup()" && out.split("\n")[7] === "        prepare()"
      && r.details.warnings.length === 0,
    JSON.stringify({ out, w: r.details.warnings })); }
{ const f = await seed("a\nb\nc\n"); await run("ctx_patch", P(`*** Update File: ${f}\n@@\n a\n-b\n+B\n`));
  eq("bare @@ applies no narrowing", await read(f), "a\nB\nc\n"); }
{ const f = await seed("x\nend\ny\nend\n");
  await run("ctx_patch", P(`*** Update File: ${f}\n@@\n-end\n+END\n*** End of File\n`));
  eq("End of File selects the tail occurrence", await read(f), "x\nend\ny\nEND\n"); }
{ const f = await seed("x\nend\ny\nend\n");
  await run("ctx_patch", P(`*** Update File: ${f}\n@@\n-end\n+END\n`));
  eq("without End of File the first occurrence wins", await read(f), "x\nEND\ny\nend\n"); }
await rejects("End of File before any hunk body rejected", () => run("ctx_patch", P(`*** Update File: x.ts\n*** End of File\n`)), "must follow a hunk body");
{ const f = await seed("keep\nlast\n");
  await run("ctx_patch", P(`*** Update File: ${f}\n@@\n keep\n-last\n+final\n*** End of File\n`));
  eq("End of File with context still applies", await read(f), "keep\nfinal\n"); }
{ const f = await seed(DUP);
  // Self-contradictory: the marker asserts end-of-file, but `prepare()` is not the tail.
  await rejects("false End of File assertion is rejected, not relocated", () => run("ctx_patch", P(`*** Update File: ${f}\n@@     def run(self):\n-        prepare()\n+        setup()\n*** End of File\n`)),
    "does not match the tail");
  eq("…and the file is untouched", await read(f), DUP); }
{ const f = await seed(DUP);
  // Same hunk without the false marker: the locator declares intent, first match wins.
  await run("ctx_patch", P(`*** Update File: ${f}\n@@ class Beta:\n-        prepare()\n+        setup()\n`));
  eq("locator alone reaches the second class", (await read(f)).split("\n")[7], "        setup()"); }

console.log("\n=== ctx_patch: compatibility edge cases ===");
{ const r = await run("ctx_patch", P(""));
  ok("empty patch succeeds", r.details.files.length === 0); }
{ await run("ctx_patch", P("*** Add File: empty.txt\n"));
  eq("Add File with no rows creates an empty file", await read("empty.txt"), ""); }
{ const f = await seed(""); await run("ctx_patch", P(`*** Update File: ${f}\n@@\n+first\n`));
  eq("insertion into empty file has no phantom blank line", await read(f), "first\n"); }
{ const f = await seed("only\n"); await run("ctx_patch", P(`*** Update File: ${f}\n@@\n-only\n`));
  eq("deleting all lines leaves an empty file", await read(f), ""); }
{ const f = await seed("head\ntail\n");
  await run("ctx_patch", P(`*** Update File: ${f}\n@@ head\n+appended\n@@\n-tail\n+TAIL\n`));
  eq("append validates locator without consuming later search cursor", await read(f), "head\nTAIL\nappended\n"); }
{ const f = await seed("head\n");
  await run("ctx_patch", P(`*** Update File: ${f}\n@@\n+one\n@@\n+two\n`));
  eq("multiple EOF insertions retain patch order", await read(f), "head\none\ntwo\n"); }
{ const f = await seed("head\n");
  await rejects("pure insertion still validates locator", () => run("ctx_patch", P(`*** Update File: ${f}\n@@ missing\n+tail\n`)), '"@@" locator');
  eq("invalid insertion locator leaves file untouched", await read(f), "head\n"); }
{ const f = await seed("a\nb\n");
  await run("ctx_patch", P(`*** Update File: ${f}\n@@\n-b\n+B\n \n*** End of File\n`));
  eq("EOF trailing empty context retries without sentinel", await read(f), "a\nB\n"); }
{ const f = await seed("a\n");
  await run("ctx_patch", P(`*** Update File: ${f}\n@@\n-a\n-\n+A\n+\n`));
  eq("trailing empty old and new rows retry independently", await read(f), "A\n"); }
{ const f = await seed("a\n");
  await run("ctx_patch", P(`*** Update File: ${f}\n@@\n a\n \n+tail\n`));
  eq("old sentinel remains a new blank when followed by additions", await read(f), "a\n\ntail\n"); }
{ const f = await seed("a\n\nb\n");
  await run("ctx_patch", P(`*** Update File: ${f}\n@@\n a\n \n-b\n-\n`));
  eq("new sentinel removal retains old context consumption", await read(f), "a\n"); }
{ const f = await seed("before\n");
  await run("ctx_patch", P(`*** Update File: ${f}\n*** Move to: canonical/moved.ts\n@@\n-before\n+after\n`));
  eq("canonical Move to before hunks works", await read("canonical/moved.ts"), "after\n"); }
{ const f = await seed("before\n");
  const blocker = await seed("not a directory\n");
  await rejects("move rejects an unusable destination parent", () => run("ctx_patch",
    P(`*** Update File: ${f}\n*** Move to: ${blocker}/dest.ts\n@@\n-before\n+after\n`)));
  eq("failed destination creation leaves source unchanged", await read(f), "before\n");
  eq("failed destination creation leaves blocking file unchanged", await read(blocker), "not a directory\n"); }
{ const f = await seed("before\n");
  await mkdir(join(root, "move-directory"), { recursive: true });
  await rejects("move rejects writing over a directory", () => run("ctx_patch",
    P(`*** Update File: ${f}\n*** Move to: move-directory\n@@\n-before\n+after\n`)));
  eq("failed destination write leaves source unchanged", await read(f), "before\n"); }
{ const f = await seed("before\n"); const dest = await seed("existing destination\n");
  await run("ctx_patch", P(`*** Update File: ${f}\n*** Move to: ${dest}\n@@\n-before\n+after\n`));
  eq("move overwrites destination with updated source", await read(dest), "after\n");
  ok("successful destination write is followed by source removal", !(await Bun.file(join(root, f)).exists())); }
{ const f = await seed("before\n");
  await run("ctx_patch", P(`*** Update File: ${f}\n*** Move to: ./${f}\n@@\n-before\n+after\n`));
  eq("move to the same resolved path updates without deleting it", await read(f), "after\n"); }
{ const f = await seed("a\n\n");
  await run("ctx_patch", P(`*** Update File: ${f}\n@@\n-a\n+A\n \n`));
  eq("real trailing blank context is retained", await read(f), "A\n\n"); }
{ const f = await seed("  x\nx\n");
  await run("ctx_patch", P(`*** Update File: ${f}\n@@\n-x\n+y\n`));
  eq("exact later match beats earlier fuzzy match", await read(f), "  x\ny\n"); }
{ const f = await seed("one\u00a0two\u2009three\n");
  await run("ctx_patch", P(`*** Update File: ${f}\n@@\n-one two three\n+done\n`));
  eq("Unicode spaces fold to ASCII spaces", await read(f), "done\n"); }
{ const f = await seed("a\nb\n");
  await rejects("EOF matching cannot move behind prior hunk", () => run("ctx_patch", P(`*** Update File: ${f}\n@@\n-b\n+B\n@@\n-b\n+C\n*** End of File\n`)), "context not found");
  eq("failed later hunk leaves same file untouched", await read(f), "a\nb\n"); }

console.log("\n=== write guard (str_replace only) ===");
async function callGuard(hs: Function[], input: any) {
	for (const h of hs) { const r = await h({ type: "tool_call", toolCallId: "w", toolName: "write", input }, ctx); if (r) return r; }
	return undefined;
}
ok("ctx_patch does not intercept other tool calls", cpHandlers.length === 0);
for (const [name, hs] of [["str-replace", srHandlers]] as const) {
	const f = await seed("real code\n");
	const blocked = await callGuard(hs, { path: f, content: "oops" });
	ok(`${name}: overwrite of existing file blocked`, blocked?.block === true && String(blocked.reason).includes("Refusing to overwrite"));
	ok(`${name}: new file allowed`, (await callGuard(hs, { path: "brand-new.ts", content: "x" })) === undefined);
	const empty = await seed("");
	ok(`${name}: empty existing file allowed`, (await callGuard(hs, { path: empty, content: "x" })) === undefined);
	ok(`${name}: xd:// dispatch untouched`, (await callGuard(hs, { path: "xd://some-tool", content: "x" })) === undefined);
	ok(`${name}: directory target untouched`, (await callGuard(hs, { path: ".", content: "x" })) === undefined);
	process.env.OMP_ALLOW_WRITE_OVERWRITE = "1";
	ok(`${name}: env override permits overwrite`, (await callGuard(hs, { path: f, content: "x" })) === undefined);
	delete process.env.OMP_ALLOW_WRITE_OVERWRITE;
}

console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) console.log(`failing: ${failures.join(" | ")}`);
process.exit(fail === 0 ? 0 : 1);
