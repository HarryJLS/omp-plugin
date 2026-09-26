# omp-safe-edit

Two oh-my-pi extensions that replace the built-in line-anchored `edit` tool with a
content-anchored one. **Install one, not both** — pick the anchoring style you prefer.

| File | Modeled on | Tool it registers | How an edit is targeted |
|---|---|---|---|
| `str-replace.ts` | claw-code (`rust/crates/runtime/src/file_ops.rs`) | `str_replace` | A verbatim copy of the text being replaced |
| `ctx-patch.ts` | codex (`codex-rs/apply-patch/src/seek_sequence.rs`) | `ctx_patch` | A context diff: `@@`, ` ` keep, `-` remove, `+` add |

## The bug being fixed

oh-my-pi's default `hashline` mode anchors by line number:

```
[src/foo.ts#1A2B]
PUT 120.=155:
+new content
```

The payload says *where* to cut but never *what* is being cut. `patcher.ts:688` checks
only that the whole file still hashes to the 4-hex tag — and that tag is 16 bits
(`format.ts:119`: `xxHash32(...) & 0xffff`). That proves the file has not changed; it
cannot prove the model pointed at the right lines. So `PUT 120.=155` when 135 was meant
deletes twenty extra lines and returns success. `types.ts:42` even declares an
`oldAssertion` field for this check — nothing in the repo reads it.

Both extensions make the edit target self-describing, so a miscount cannot match and a
non-match is an error rather than a deletion.

## Install

```sh
# user-wide (all projects)
cp str-replace.ts ~/.omp/agent/extensions/
#   …or…
cp ctx-patch.ts   ~/.omp/agent/extensions/

# one project only
cp str-replace.ts <project>/.omp/extensions/

# try without installing
omp --extension ~/Downloads/omp-safe-edit/str-replace.ts
```

On `session_start` the extension drops `edit` from the active tool set and adds its own
tool. Nothing else is touched.

## Divergences from the originals

Both deliberately fail closed where the original guesses.

**`str_replace` vs claw-code** — claw-code performs no uniqueness check: after a bare
`contains()` it calls `replacen(old, new, 1)`, so a needle occurring twice silently edits
the first one. This tool requires a unique match (as Claude Code's own Edit tool does) and
lists every site otherwise.

**`ctx_patch` vs codex** — three changes, all toward failing closed:

1. **Ambiguity.** codex takes the *first* location that matches (`return Some(i)` in every
   loop of `seek_sequence`), so a hunk whose context appears twice lands on whichever copy
   comes first. Here, a hunk with **no `@@` locator** must match exactly once or it is
   rejected with every candidate listed. A hunk **with** a locator keeps codex's
   first-match behaviour — writing `@@ class Alpha:` is an explicit statement that the
   intended region is the first one below that line, so honouring it obeys a declaration
   rather than guessing — and a locator that had to break a tie is reported as a warning so
   the choice stays auditable.
2. **Indentation.** codex writes `+` lines verbatim (there is no indentation handling in
   `file_update.rs` at all), so a hunk that only matched after ignoring indentation writes
   the model's wrong indentation into the file. Here each added line's indentation is mapped
   through the correspondence observed between the hunk's context lines and the file's actual
   ones, and the hunk is refused when no correspondence exists. A single offset delta is not
   enough: a patch using two-space levels against a four-space file needs +2 at depth 1 and
   +4 at depth 2.
3. **Anchorless insertion.** A hunk with no context and no removals is rejected. codex sends
   that case to `original_lines.len()` and appends at end of file
   (`file_update.rs:114-130`), ignoring the locator — so a bare insertion silently lands at
   EOF instead of where it was aimed.

Ported unchanged: the four-level match ladder (exact → trailing-space → indentation →
Unicode fold), the punctuation fold table, the `pattern.len() > lines.len()` guard
(`seek_sequence.rs`), the `@@` locator as a real search anchor (`file_update.rs:99-113`),
and the `*** End of File` tail restriction (`file_update.rs:145-150`). One note on the
last: codex's `eof` flag *replaces* the search start with the tail position, so a hunk
claiming end-of-file whose context is not at the tail simply fails. This applier does the
same and says why, rather than falling back to a forward scan — the marker is an assertion,
and quietly applying the hunk elsewhere when it is false is the silent relocation the tool
exists to prevent.

Not ported: codex's streaming parser (`streaming_parser.rs`, 924 lines — it can render a
patch preview mid-stream), its `PreserveLineEndings` mode (mixed-ending files are
homogenized to the dominant ending here), and its trailing-empty-line retry.

## The `write` guard

Both extensions also block `write` onto an existing non-empty file. This matters: swapping
out `edit` closes the line-number hole, but `write` is a separate essential built-in
(`tools/essential-tools.ts`) that overwrites a whole file, and a "rewritten" file silently
drops whatever the model did not reproduce. Creating new files, writing empty files, and
`xd://` device dispatch are unaffected.

## Environment variables

| Variable | Effect |
|---|---|
| `OMP_KEEP_BUILTIN_EDIT=1` | Keep the built-in line-anchored `edit` active alongside |
| `OMP_EDIT_ALLOW_OUTSIDE=1` | Permit edits outside the session working directory |
| `OMP_ALLOW_WRITE_OVERWRITE=1` | Permit `write` onto an existing file |

Each extension also registers a stats command — `/str-replace-stats` or
`/ctx-patch-stats` — reporting applied / rejected / blocked counts for the session, which
is the practical way to compare the two.

## Tests

```sh
bun run test.ts     # 88 cases; runs from anywhere
```

Covers: unique/absent/ambiguous matches, whitespace-drift diagnosis, `replace_all`,
CRLF and BOM round-trips, missing trailing newlines, `$&`/`$1` staying literal in
replacements, tabs, non-ASCII, reindentation across nesting depths, unmappable
indentation, multi-hunk patches on repeated code, multi-file partial application,
Add/Delete/Move, `@@` locator narrowing and tie-break warnings, unmatched locators,
`*** End of File` selection and false-assertion rejection, every parser rejection, and
the `write` guard.

## Measured token cost

tiktoken `o200k_base`. Static cost is the tool prompt injected into every request; payload
is the JSON arguments the model emits per edit.

| | hashline | str_replace | ctx_patch |
|---|---|---|---|
| static prompt | 1822 | **157** | 340 |
| 5 representative edits, total payload | **270** | 1224 | 1355 |
| ratio | 1.00x | 4.53x | 5.02x |

The payload difference is the safety mechanism, most visibly when deleting a 29-line block:

| | payload | per line destroyed |
|---|---|---|
| hashline `CUT 40.=68` | 20 tok | **0.7 tok** |
| `str_replace` `old_string` | 823 tok | 28.4 tok |
| `ctx_patch` `-` lines | 855 tok | 29.5 tok |

Read both directions together: these tools save ~1500 tokens of static prompt per request
(usually cached, so cheap in practice) and cost 4-5x more per edit (uncached, and re-read
from history every subsequent turn). In a long session the payload side dominates, so this
is a net token increase whose size depends on your edit density.

No accuracy measurements have been made. `scripts/edit-benchmark.py --variant
replace|apply_patch` in the oh-my-pi repo can produce a baseline for the built-in modes
these are derived from, but it does not know how to drive extension-registered tools.

## What this does not fix

Closing the line-number hole and the `write` hole removes the *mechanical* ways code
disappears. These remain, and no anchoring scheme can catch them:

- **Lossy rewrite.** Both tools verify what you delete, never what you write. Matching 30
  lines correctly and replacing them with 5 that drop a branch applies cleanly. Neither
  claw-code, codex, nor Claude Code prevents this. But the exposure is not equal across
  mechanisms, and it is worth being precise: `write` and hashline destroy lines *by
  omission* — the lines vanish without appearing in the payload at all, at ~0.7 tokens per
  line for hashline. These tools destroy lines *by declaration* — every removed line must
  be typed out, at ~29 tokens per line, and shows up in the rendered diff. Same theoretical
  hole, ~40x the cost and fully auditable instead of invisible.
- **`replace_all: true`.** Once passed, the uniqueness guarantee is waived by design.
- **`bash` and `ast_edit`.** `rm`, `sed -i`, `git checkout -- .`, and the separate
  `ast_edit` tool are all still available.
- **Multi-file `ctx_patch` is not atomic.** A failure on the third file leaves the first
  two changed; the error says so. codex has the same property (its spec §6.1).
- **New code.** These are ~1000 lines with 75 passing tests, against a `hashline` that has
  years of hardening behind it. Different risk, not zero risk.
