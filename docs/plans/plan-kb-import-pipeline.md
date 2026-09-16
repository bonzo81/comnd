# Plan: Delete the Dead One-Shot Import Pipeline (Phase 3)

Remove the unused `import_kb_url` IPC path end-to-end. Standalone plan from
the Sep 2026 KB architecture review; phase 4 of the KB cleanup.

Companion plans, in order: 0 `plan-kb-false-seams.md` ·
1 `plan-kb-contract-test.md` · 2 `plan-kb-platform-truth.md` ·
**3 this plan** · 4 `plan-kb-import-progress.md` ·
5 `plan-kb-version-filter.md` · 6 `plan-kb-split-modules.md`.

## Why (problem being solved)

The KB import feature has **two pipelines** to accomplish the same thing:

- **Two-stage (alive).** `extract_kb_preview` / `extract_kb_preview_from_text`
  → user reviews per-command → `commit_kb_import`. This is what the import
  dialog uses, what the custom-KB spec (docs/specs/10) describes, and what
  all tests exercise.
- **One-shot (dead).** `importKbUrl` (src/lib/tauri-api.ts L449) →
  `import_kb_url` (src-tauri/src/import.rs L1347) → `import_from_url`
  (import.rs L170). **Zero frontend callers** — `importKbUrl` is exported but
  never invoked from any component (verified by grep: the only reference is
  its own definition). `import_from_url`'s only caller is the dead IPC
  command. Three layers — wrapper, command, pipeline function — exist
  solely to compose extract + commit without the review step the product
  decided users must have (per-command accept/reject, docs/specs/10
  "LLM Import Confirmation Screen").

Beyond the ~60 dead lines, the fork keeps a second `ImportResult` producer
and a second control-flow path through `import.rs` alive, which every
reader of the import module must rule out ("is *this* the path the dialog
takes?"). The deletion test passes cleanly: deleting the trio concentrates
all import flow into the two-stage pipeline everyone already uses.

Note: `import_from_url`'s *internals* (fetch + SSRF check + scrape + chunk +
LLM + validate) are **not** dead — they are shared with
`extract_from_url`, which stays untouched. Only the one-shot composition
dies.

## Goals / non-goals

**Goals**

- Delete `importKbUrl` (tauri-api.ts), the `import_kb_url` Tauri command
  (import.rs L1347–1398), its registration in lib.rs, and
  `import_from_url` (import.rs L170–208).
- Refactor `import_from_url`'s still-alive internals only if they are
  currently private to it — they are not (they are shared free fns /
  `extract_from_url`), so expect a pure deletion with no refactoring.
- No `ImportResult` producer remains — the premise that `commit_import`
  produces one was false (it returns `()`; the `commit_kb_import` command
  returns `usize`). The Rust struct was deleted as dead code in the sweep.

**Non-goals**

- No change to the two-stage pipeline, its progress events, or the dialog.
- Not removing `extract_from_url` / `real_http_fetch` /
  `validate_fetch_url` / the scraper / chunker — all shared and alive.
- ~~No changes to `ImportResult`'s shape (still used by the commit path)~~ —
  premise false: only `import_from_url` constructed it; struct deleted.
- Not adding any "are you sure" or feature flag — the path is dead, removal
  is the whole point.

## Detailed design

### 1. Delete the TS wrapper

- `src/lib/tauri-api.ts` L449: delete `importKbUrl` entirely, along with any
  `ImportResult` TS type usage that only it referenced (check: if
  `ImportResult`'s TS declaration at tauri-api.ts has no other consumers
  after the deletion — grep — remove it too; if the commit path or the
  contract test fixture still references the type, keep it).

### 2. Delete the Rust command + pipeline fn

- import.rs L1347–1398: delete `import_kb_url` (`#[tauri::command]` fn).
  Note its body also contains one of the two `reload_all()` + `rescan()`
  pairs — phase 2 (`plan-kb-platform-truth.md`) already audited these; the
  pair disappears with the command.
- import.rs L170–208: delete `import_from_url`. Before deleting, confirm
  nothing else calls it (grep `import_from_url`) and that every helper it
  called is either (a) also called by `extract_from_url` /
  `commit_import` — keep, or (b) only called from it — delete too. Expect
  (a) for everything; if (b) appears, delete the orphan as part of this
  plan and note it in the commit.
- lib.rs: remove `import::import_kb_url` from the `invoke_handler` list
  (~L437).
- Check `import.rs` `mod tests` for tests exercising `import_from_url` or
  `import_kb_url` — the review found none, but verify; delete any that
  exist (they test dead behavior). SSE-mocked pipeline tests target
  `extract_from_*` and must be unaffected.

### 3. Dead-code sweep

- `rg "importKbUrl|import_kb_url|import_from_url"` must return zero hits in
  `src/` and `src-tauri/src/` after the change (docs and plans excluded).
- Check whether `ImportProgress` variants or `ImportResult` fields exist
  only to serve the one-shot flow (e.g. a variant only emitted from
  `import_from_url`) — if the review's expectation holds, none do; if one
  does, remove it and update `formatProgress` (src/lib/import-status.ts)
  accordingly, keeping phase 4's consolidation in mind (do not
  double-refactor; just remove the orphan).

## Tasks / checklist

- [ ] Delete `importKbUrl` wrapper (tauri-api.ts L449) + orphaned `ImportResult` TS type if unused elsewhere
- [ ] Delete `import_kb_url` command (import.rs L1347) and its lib.rs registration (~L437)
- [ ] Delete `import_from_url` (import.rs L170) after confirming shared helpers survive
- [ ] Repo grep for the three names returns zero code hits
- [ ] No orphaned private helpers remain in import.rs (audit `import_from_url`'s callee list)
- [ ] `cargo check` exits 0
- [ ] `cargo test` exits 0
- [ ] `npm run build` exits 0 (surfaces if anything still imported the wrapper)
- [ ] `npm run test` exits 0

## Verification

- All four verification commands green.
- Import still works end-to-end: paste-text import → preview → subset
  commit → command appears in KB viewer and in suggestions. (The URL-based
  *extract* path remains via `extractKbPreview`; only the no-review one-shot
  commit is gone.)
- `rg import-progress src/` still shows the two current listeners (their
  consolidation is phase 4, not here).

## Risks / open questions

- **Hidden caller via string invoke**: Tauri commands can be invoked by
  string name (`invoke("import_kb_url")`). Grep for the string literal
  `"import_kb_url"` across `src/` to rule this out (the review found the
  only string usage inside the now-deleted wrapper).
- Risk is low overall: the deletion removes code paths, it cannot change
  behavior of live paths. The only observable change is the IPC surface
  (a command disappears), which is fine — nothing invokes it.
- Open question: should the removed no-review import mode be recorded as a
  deliberate product decision (per-command review is mandatory)? It is
  already stated in docs/specs/10; if the implementer wants it load-bearing,
  a one-line note in docs/specs/06 or a follow-up ADR could be added —
  optional, not required by this plan.