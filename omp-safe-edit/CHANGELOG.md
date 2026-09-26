# Changelog

Semantic versioning. Dates are `YYYY-MM-DD`.

## [0.1.0] - 2026-09-26

Initial version:

- `str-replace.ts` — registers `str_replace`, modelled on claw-code
  (`rust/crates/runtime/src/file_ops.rs`), targeted by a verbatim copy of the replaced
  text. Requires a unique match and lists every site otherwise, where claw-code's bare
  `contains()` + `replacen(old, new, 1)` silently edits the first occurrence.
- `ctx-patch.ts` — registers `ctx_patch`, modelled on codex
  (`codex-rs/apply-patch/src/seek_sequence.rs`), targeted by a context diff (`@@`,
  space keep, `-` remove, `+` add). Three fail-closed divergences: an `@@`-less hunk
  must match exactly once, added lines are reindented through the context/actual
  correspondence (refusing when none exists), and an anchorless insertion is rejected
  instead of being appended at end of file.
- Both extensions drop the built-in `edit` on `session_start` and add their own tool;
  `OMP_KEEP_BUILTIN_EDIT=1` keeps the built-in active alongside.
- Both extensions block `write` onto an existing non-empty file
  (`OMP_ALLOW_WRITE_OVERWRITE=1` to permit); new files, empty files and `xd://` dispatch
  are unaffected. Edits outside the session working directory require
  `OMP_EDIT_ALLOW_OUTSIDE=1`.
- Per-extension stats commands `/str-replace-stats` and `/ctx-patch-stats` report
  applied / rejected / blocked counts for the session.
- `test.ts` — 88 cases, runnable with `bun run test.ts` from anywhere.
