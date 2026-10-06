# omp-safe-edit

Version: `0.1.0` — recorded here only; this directory ships raw `.ts` files and has no
`package.json`. Changelog: [`CHANGELOG.md`](./CHANGELOG.md).

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
tool. `ctx_patch` leaves other tools alone; `str_replace` also guards `write`.

## Divergences from the originals

**`str_replace` vs claw-code** — claw-code performs no uniqueness check: after a bare
`contains()` it calls `replacen(old, new, 1)`, so a needle occurring twice silently edits
the first one. This tool requires a unique match (as Claude Code's own Edit tool does) and
lists every site otherwise.

**`ctx_patch` vs Codex** — the patch behavior follows Codex, without the previous
extra rejection rules:

- First match wins at the strictest matching level: exact, trailing whitespace,
  indentation, then Unicode punctuation/space normalization.
- Added lines are written verbatim. Unchanged context keeps the file's original text.
- A hunk containing only `+` rows appends at EOF. An optional `@@` locator must still
  exist, but does not change the insertion position.
- `@@ text` advances the search cursor past the matching line. `*** End of File`
  requires a tail match and cannot move behind previously matched hunks.
- A failed match with a trailing empty line retries without that newline sentinel.
- No-op updates and empty patches succeed. `*** Add File` can overwrite existing
  files; an Add section with no rows creates an empty file.
- Absolute paths and paths outside cwd are accepted. The extension does not intercept
  `write`; filesystem access control is the host's responsibility.

The OMP-facing interface remains `ctx_patch({ input: "*** Begin Patch\n..." })` for
compatibility with existing callers. This uses Codex's patch envelope, not the
Responses API's structured `apply_patch_call` operations, and does not expose Codex's
freeform tool transport.

Remaining implementation differences: no streaming preview; CRLF/LF and BOM are
preserved for ordinary files, but mixed line endings are normalized to the first
observed ending. This is not a byte-for-byte replacement for Codex's parser or host
sandbox. Multi-file changes are sequential, not atomic.

## The `write` guard

Only `str_replace` blocks `write` onto an existing non-empty file. This matters: swapping
out `edit` closes the line-number hole, but `write` is a separate essential built-in
(`tools/essential-tools.ts`) that overwrites a whole file, and a "rewritten" file silently
drops whatever the model did not reproduce. Creating new files, writing empty files, and
`xd://` device dispatch are unaffected.

## Environment variables

| Variable | Applies to | Effect |
|---|---|---|
| `OMP_KEEP_BUILTIN_EDIT=1` | Both | Keep the built-in line-anchored `edit` active alongside |
| `OMP_EDIT_ALLOW_OUTSIDE=1` | `str_replace` only | Permit edits outside the session working directory |
| `OMP_ALLOW_WRITE_OVERWRITE=1` | `str_replace` only | Permit `write` onto an existing file |

Each extension also registers a stats command — `/str-replace-stats` or
`/ctx-patch-stats` — reporting applied / rejected counts and line totals for the session.
Only `str_replace` reports blocked writes.

## Tests

```sh
bun run test.ts
```

Covers: unique/absent/ambiguous matches, whitespace-drift diagnosis, `replace_all`,
CRLF and BOM round-trips, missing trailing newlines, `$&`/`$1` staying literal in
replacements, tabs, non-ASCII, verbatim additions at new indentation levels,
multi-hunk patches on repeated code, multi-file partial application,
Add/Delete/Move, `@@` locator narrowing, unmatched locators, EOF append,
empty files, no-op patches, trailing-empty-line retries, outside-cwd paths,
`*** End of File` selection and false-assertion rejection, every parser rejection, and
the `str_replace` write guard.

## Measured token cost

tiktoken `o200k_base`, historical measurements from 0.1.0 before compatibility changes.
Static cost is the tool prompt injected into every request; payload
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

Content anchoring does not guarantee that an edit is correct:

- **Lossy rewrite.** Both tools verify what you delete, never what you write. Matching 30
  lines correctly and replacing them with 5 that drop a branch applies cleanly. Neither
  claw-code, codex, nor Claude Code prevents this. But the exposure is not equal across
  mechanisms, and it is worth being precise: `write` and hashline destroy lines *by
  omission* — the lines vanish without appearing in the payload at all, at ~0.7 tokens per
  line for hashline. These tools destroy lines *by declaration* — every removed line must
  be typed out, at ~29 tokens per line, and shows up in the rendered diff. Same theoretical
  hole, ~40x the cost and fully auditable instead of invisible.
- **`replace_all: true`.** Once passed, the uniqueness guarantee is waived by design.
- **First match and overwrites.** `ctx_patch` selects the first matching region and
  allows whole-file replacement via Add or the host's `write` tool, like Codex.
- **`bash` and `ast_edit`.** `rm`, `sed -i`, `git checkout -- .`, and the separate
  `ast_edit` tool are all still available.
- **Multi-file `ctx_patch` is not atomic.** A failure on the third file leaves the first
  two changed; the error says so. codex has the same property (its spec §6.1).
- **Implementation coverage.** These standalone adapters have focused regression tests,
  not the full Codex or oh-my-pi integration test suites.
