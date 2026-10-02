# Plan: Split kb.rs into Domain-Owned Modules (Phase 6)

Split the five sub-domains inside `src-tauri/src/kb.rs` into separate modules
with small interfaces. Standalone plan from the Sep 2026 KB architecture
review; final phase of the KB cleanup — sequenced last because it is pure
mechanical movement over code the earlier phases have already cleaned
(dead seams gone, version filter gone, platform truth consolidated).

Companion plans, in order: 0 `plan-kb-false-seams.md` ·
1 `plan-kb-contract-test.md` · 2 `plan-kb-platform-truth.md` ·
3 `plan-kb-import-pipeline.md` · 4 `plan-kb-import-progress.md` ·
5 `plan-kb-version-filter.md` · **6 this plan**.

## Why (problem being solved)

`kb.rs` is 2163 lines (~1234 non-test) carrying five distinct sub-domains:

| Sub-domain | Contents (post-phase-5 state) | ~Lines |
|---|---|---|
| Schema | `Command`, `CommandToken`, `PlatformIndex`, `PrefixCommand`, `CommandVersions`, `CommandExample`, `VarToken`, `PipeToken`, `PipeFilter`, `CommandOrder` serde types | ~330 |
| Validation | `KbValidationIssue`, `validate_command`, `validate_platform` | ~150 |
| Store + merge + tombstones | `KbStore` (load, merge), `KbManager` (get_or_load, reload_all), tombstone list helpers | ~370 |
| User-KB file mutation | `upsert_command`, `remove_command`, `mark_disabled`/`mark_enabled`, `list_disabled`, `get_target_yaml_path`, `write_commands_to_yaml`, `serialize_commands` | ~400 |
| IPC handlers | `query_kb`, `validate_kb`, `get_all_kb_commands`, `save_kb_command`, `delete_kb_command`, `disable/enable_kb_command`, `get_disabled_commands` | ~130 |

The module is deep in places (`get_or_load` hides load/merge/index-override/
tombstone-filter behind one call) but reads shallow because its
**fn-level interface is nearly as wide as its implementation**: of the 9 free
pub fns, only 3 were used outside kb.rs (all by import.rs:
`get_target_yaml_path`, `write_commands_to_yaml`, `validate_command`); the
rest were `pub` only for their own tests. Of the KbManager methods, only
`with_user_path`, `get_platform_index`, `categories_for_platform`,
`reload_all` had external callers. A reader cannot tell which functions are
contract and which are internals — the interface does not say.

Two policies also hide 400 lines apart with the same name and opposite
semantics: load-time merge is user-wins-replace (`merge_from`), write-time
merge is fill-empty-upgrade (`write_commands_to_yaml`). Splitting puts
them adjacent under one module whose doc comment states both rules.

Deletion-test framing: this split does not delete modules — it shrinks
*interfaces*. Every fn that was `pub` only for its own tests becomes
crate-private or module-private, so each new module's interface is honest.

## Goals / non-goals

**Goals**

- Five modules under `src-tauri/src/kb/` (a directory module replacing the
  single file), with lib.rs re-exports kept **only** where registration
  needs them (`kb::query_kb` etc. in the `invoke_handler` list):
  - `kb/schema.rs` — serde types only. No logic.
  - `kb/validate.rs` — `validate_command`, `validate_platform`,
    `KbValidationIssue`.
  - `kb/store.rs` — `KbStore`, `KbManager`, merge policy, tombstone
    filtering; the deep load/merge core.
  - `kb/user_files.rs` — user-KB YAML mutation: upsert/remove/disable/
    enable/list + target-path resolution + `serialize_commands`. Owns the
    `_deleted.yaml` / `_disabled.yaml` file formats.
  - `kb/commands.rs` — the `#[tauri::command]` handlers, thin.
- Interface shrink: free fns that only import.rs needs
  (`get_target_yaml_path`, `write_commands_to_yaml`, `validate_command`)
  become `pub(crate)` (import.rs is a sibling module); everything internal
  drops to private. `KbManager` keeps exactly its externally-called
  methods public (`with_user_path`, `get_platform_index`,
  `categories_for_platform`, `reload_all`, plus whatever the
  post-phase-5 command surface needs — audit at implementation).
- Module doc comments: `store.rs` documents the load-time user-wins merge;
  `user_files.rs` documents the write-time fill-empty-upgrade merge and
  *why* the two differ (import appends into category files; load replaces
  wholesale).
- Tests move with their code: each module owns its tests. The kb.rs `mod
  tests` (~930 lines) splits along the same seams; test helpers shared
  across modules (temp-dir builders, sample commands) go into a
  `#[cfg(test)] mod test_util` shared by the kb submodules.
- `mod.rs` for `kb/` re-exports the handler fns so lib.rs's
  `invoke_handler` list keeps working with minimal churn
  (`kb::query_kb` still resolves).

**Non-goals**

- No behavior change of any kind — pure code movement, visibility changes,
  and doc comments. Any diff that changes logic during the move is a
  mistake (see Verification).
- Not splitting `import.rs` (its multi-concern split is a possible future
  plan; this one is scoped to kb.rs, which the review inventoried fully).
- Not renaming any public wire contract (IPC names, YAML field names,
  event names all frozen).
- Not moving schema types into a separate crate — same crate, same
  package.
- No new abstractions: no traits, no interface indirections. The split is
  along seams the file already has.

## Detailed design

### Module boundaries (what goes where)

- **`kb/schema.rs`**: all `#[derive(...)]` serde types currently at kb.rs
  L14–176 (`PlatformIndex`, `PrefixCommand`, `Command`, `CommandExample`,
  `CommandVersions`, `CommandToken`, `VarToken`, `VarType`, `VarSource`,
  `PipeToken`, `PipeFilter`, `CommandOrder`) plus `default_true`.
  Re-exported by `kb/mod.rs` as `kb::Command` etc. so existing
  `use crate::kb::...` paths in import.rs / llm.rs / lib.rs keep working
  (zero-diff for consumers; tighten later if desired).
- **`kb/validate.rs`**: `KbValidationIssue`, `validate_command` (kb.rs
  L191), `validate_platform` (L318), their tests.
- **`kb/store.rs`**: `CommandFile`, `KbStore` (load + `merge_from` +
  tombstone filter at load), `KbManager` (`with_user_path`,
  `get_or_load`, `reload_all`, `get_platform_index`,
  `categories_for_platform`, post-phase-5 command-set accessors),
  `parse_major_version`-era leftovers removed by phase 5. Doc comment on
  the module: the user-wins merge rule and the tombstone model (the "which
  copy wins / what hides what" model from docs/specs/10, currently
  described only in the spec).
- **`kb/user_files.rs`**: `read_name_list`, `write_name_list`,
  `read_deleted_list`, `write_deleted_list`, `read_disabled_list`,
  `write_disabled_list`, `serialize_commands`, `valid_kb_slug`,
  `get_target_yaml_path`, `write_commands_to_yaml`, `upsert_command`,
  `remove_command`, `mark_disabled`, `mark_enabled`, `list_disabled`.
  Doc comment: write-time merge is fill-empty-upgrade; load-time merge
  (store.rs) is user-wins-replace; the asymmetry is the design.
- **`kb/commands.rs`**: the `#[tauri::command]` handlers (post-phase-5
  set), each a thin lock-and-delegate over state, as today.

### Visibility rules

- `pub(crate)` for the three import.rs-facing fns and for types used in
  Tauri command signatures that lib.rs registers (Tauri requires the
  command fn visible; `pub(crate)` suffices within the crate — verify
  against lib.rs's registration; if `invoke_handler` needs `pub`, keep
  those fns `pub` and note it).
- Everything else private to its module; `pub use` in `kb/mod.rs` only for
  what other crate modules actually use (audit with
  `rg "kb::" src-tauri/src --glob '!kb*` after the split and trim).

### Test movement

- kb.rs's `mod tests` (L1235–2163) distributes: validator tests →
  `validate.rs`, merge/tombstone/manager tests → `store.rs`,
  YAML write/upsert/disable tests → `user_files.rs`, handler-level tests
  (if any test invokes command fns directly) → `commands.rs`.
- Shared fixtures (sample `Command` builders, temp KB trees used by
  multiple test groups) → `kb/test_util.rs` behind `#[cfg(test)]`.
- The phase-1 contract test (kb-schema fixture) lives wherever schema
  round-trip logic is tested — it imports `kb::schema` types; its location
  from phase 1 (`mod tests` in kb.rs) moves to `schema.rs`'s tests or
  stays as a crate-level integration test — keep it green, location is
  implementer's choice, note it in the PR.

### Mechanics

- Do the split as one commit (pure movement is hard to review in pieces;
  a single `git mv`-style diff with moved-file detection is easiest to
  audit).
- Use `git log --follow` friendly movement: create `kb/mod.rs` with
  re-exports first, confirm `cargo check`, then move type-by-type/module-
  by-module, checking between each move.
- After the split, `kb.rs` is deleted; no re-export shim beyond
  `kb/mod.rs`.

## Tasks / checklist

- [ ] Create `src-tauri/src/kb/` with `mod.rs` (re-exports + handler visibility)
- [ ] Move serde types → `kb/schema.rs`; `cargo check` green
- [ ] Move validators + tests → `kb/validate.rs`; `cargo test` green
- [ ] Move store/manager/merge/tombstones + tests → `kb/store.rs`; module doc comment states user-wins merge
- [ ] Move file mutation + tests → `kb/user_files.rs`; module doc comment states fill-empty-upgrade and the asymmetry rationale
- [ ] Move Tauri handlers → `kb/commands.rs`
- [ ] Shared test fixtures → `kb/test_util.rs` (`#[cfg(test)]`)
- [ ] Visibility audit: only import.rs-facing fns + registered handlers + externally-called KbManager methods remain reachable; `rg` audit documented
- [ ] Delete old `kb.rs`; lib.rs registration unchanged (paths still resolve via `kb::`)
- [ ] Phase-1 contract test still green (location noted)
- [ ] `cargo check` exits 0
- [ ] `cargo test` exits 0
- [ ] `npm run build` + `npm run test` exit 0 (frontend untouched — confirms no wire change)

## Verification

- All four commands green.
- **Zero-behavior-change proof**: the diff must contain no logic edits —
  reviewers (and the implementer) verify by `git diff --color-moved=zebra`
  (moved blocks show as moved, not rewritten). Any block that shows as
  modified must be a `use` path, a visibility keyword, or a doc comment —
  nothing else.
- Wire contracts frozen: IPC command names (lib.rs `invoke_handler` list),
  YAML serde shapes (phase-1 fixture test), event names — all unchanged,
  which the frontend builds/tests passing proves.
- AI-navigability spot-check: an agent asked "where is the merge policy?"
  lands on `kb/store.rs` (module doc) or `kb/user_files.rs` (doc) and
  gets the answer from one file — previously required reading kb.rs
  L437–451 and L860–899 400 lines apart.

## Risks / open questions

- **Merge-conflict surface**: if other work lands on kb.rs mid-split, the
  moved-file diff gets noisy. Land phases 0–5 first, then do this split
  in one sitting on a quiet tree.
- **Re-export churn**: keeping `use crate::kb::Command`-style paths working
  means `mod.rs` re-exports must be complete; the `rg "kb::"` audit is the
  completeness check. If some consumer used a deep path
  (`kb::KbStore`), the re-export covers it — trim re-exports only where
  the audit shows zero use.
- Open question: does `PlatformIndex` belong in `schema.rs` (it is a
  platform concern, not a command concern)? Pragmatic answer: yes, put it
  in schema.rs — it is a serde type with no logic; the alternative (its
  own file) is a file for one struct. Not worth it.
- Open question: after the split, should `store.rs` and `user_files.rs`
  eventually merge? No — they own different policies (load-time vs
  write-time merge) and different file sets; keeping them separate with
  cross-referencing doc comments is the point.