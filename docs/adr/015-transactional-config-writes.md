# 015. A failed config write leaves no trace in memory

Date: 2026-11-01
Status: Accepted

## Context

`ConfigStore` (`src-tauri/src/config.rs`) keeps `AppConfig` in memory beside the path it was
loaded from, and `persist()` (`config.rs:414`) writes it through `paths::secure_write`. The
Tauri command `get_app_config` (`config.rs:460`) serializes `config.get()` — the in-memory
value — not the file. Every `save_*` method used to assign to `self.config` and then call
`persist()`, so when the write failed the error was returned to the caller while the new value
stayed visible in memory.

That was invisible from the frontend. The #87 fix (commit `08fd668`) made each of the five
Settings handlers catch a rejected save, toast, and re-read the stored config so the control
shows the persisted value. The re-read was correct in shape and a no-op in effect: it handed the
rejected value straight back. A review comment on PR #91
(`src/components/settings-screen.ts:1201`) identified the ordering; the frontend contract only
holds if the backend keeps "in memory" equal to "last written".

`AppConfig` already derives `Clone`, `persist()` is the only writer, and `AGENTS.md` requires
`cargo check --all-targets` plus `cargo test` on every Rust change, so the fix fits the existing
shape rather than adding a new abstraction.

## Options

- **Roll back in the store: snapshot, apply, restore on failure.** Cost: touches Rust, and every
  `save_*` has to move to the helper or the guarantee is partial.
- **Roll back in the frontend only: each handler remembers the pre-edit value.** Cost: five
  private copies of "last good value", and every other reader — `SettingsScreen.reloadConfig()`,
  the duplicate-session policy read in `src/main.ts` — still sees values that never reached disk.
- **Reply to the review without changing behaviour.** Cost: the control keeps showing a value
  that was never saved, which is the bug #87 exists to remove.

## Decision

A config write is applied through `ConfigStore::apply_and_persist` (`config.rs:401`), which
clones the current config, applies the change, and restores the clone when `persist()` fails
before returning the error. No `save_*` method assigns to `self.config` and calls `persist()`
directly, so `get_app_config` reports only values that reached disk. The frontend keeps its
re-read after a rejected save; it is now reading the truth.

`test_failed_persist_rolls_back_in_memory_config` protects the guarantee: it places a directory
at the `<config>.tmp` path `secure_write` renames from, forces the write to fail, and asserts the
in-memory log level, session logging and max sessions keep their previous values.

## Consequences

- Easier: one place owns the "in memory equals on disk" invariant; the Settings re-read and every
  other reader of `get_app_config` can be trusted; a new persistence failure mode is handled once.
- Harder: a new `save_*` must go through `apply_and_persist` — a direct assignment compiles and
  silently reopens the bug; each save now clones `AppConfig` on the write path (small, but it is a
  clone).
- Rules out: mutating `self.config` before `persist()`; treating the in-memory config as "current
  intent" separate from "last saved".
- Not covered: a write that fails halfway is still `secure_write`'s problem — the rollback restores
  memory, not a partly written file.
- Lesson from the failure: the `.catch` looked correct in review of the frontend alone, and the bug
  only appeared when the store's contract was read. A cross-layer fix needs the other layer's
  contract checked, not just its call site.
- Revisit when: persistence moves to a different store (database, keyring-backed config), where
  "restore the clone" may no longer describe the rollback.
