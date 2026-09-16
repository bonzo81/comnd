# Plan: KB Architecture Cleanup — False Seams (Phase 0)

Deletion-first cleanup from the Sep 2026 KB architecture review. This plan is
standalone; it removes five "false seams" — places where an interface
advertises behavior the implementation does not deliver. No new modules, no
behavior change intended; everything here is dead, ignored, or duplicated.

This is the first phase of the KB architecture cleanup. It is deliberately
sequenced before `plan-kb-contract-test.md` so the IPC surface is honest and
small before a contract test freezes it. Companion plans, in order:

1. **This plan** — prune false seams (pure deletion)
2. `plan-kb-contract-test.md` — pin the Rust↔TS schema with a fixture test
3. `plan-kb-platform-truth.md` — one platform-truth module in AppState
4. `plan-kb-import-pipeline.md` — delete the dead one-shot import path
5. `plan-kb-import-progress.md` — one import-progress listener
6. `plan-kb-version-filter.md` — move the version filter to the frontend
7. `plan-kb-split-modules.md` — split kb.rs into domain-owned modules

Why this order: phases 0–1 are safe, low-risk, and shrink every later diff;
phases 2–4 are small independent deletions/consolidations; phases 5–6 are the
behavior-adjacent refactors, done on a clean base; phase 7 is the large
mechanical split, done last so it does not rebase the other plans.

## Why (problem being solved)

An architecture review of the KB area (Sep 2026) found five seams whose
interface lies about its implementation. Each one costs a reader the same
thing: they follow the promised behavior and find it absent. Concretely:

1. **Dropped IPC parameter.** `extractKbPreview` /
   `extractKbPreviewFromText` (`src/lib/tauri-api.ts` L485, L503) accept an
   `allowedCategories` argument and serialize it into the invoke payload — but
   the Rust commands `extract_kb_preview` / `extract_kb_preview_from_text`
   (src-tauri/src/import.rs L1399, L1438) have no such parameter, so the value
   is silently discarded. The dialog (`kb-import-dialog.ts` ~L722) builds and
   passes the list, believing it controls category filtering. Rust recomputes
   its own list via `resolve_index_and_categories` (import.rs L1321).
2. **Dead command parameters.** `query_kb` (src-tauri/src/kb.rs L1106–1109)
   declares `_prefix` and `_mode` params whose names start with underscore —
   read by nothing. The frontend wrapper `queryKb(prefix, platform, mode,
   version)` (`src/lib/tauri-api.ts` L115–121) forwards them, and the only
   call site (`terminal-view.ts` L1203) sends `""` and `null`.
3. **Dead YAML field.** Every bundled `index.yaml` declares `command_files:`
   (knowledge-base/cisco-iosxe/index.yaml L18, and the 3 other platforms). The
   loader (`KbStore::load`, kb.rs L384–399) reads the whole `commands/`
   directory and never consults the field, so it can silently lie about what
   is loaded.
4. **Hardcoded platform lists in TS.** `FALLBACK_PLATFORM_OPTIONS`
   (kb-import-dialog.ts L37–42) duplicates the platform ids/names that already
   arrive over the existing `list_kb_platforms` IPC seam — and
   `PLATFORM_META` (`src/lib/platforms.ts` L6–11) hardcodes them a second
   time for display metadata.
5. **Two bundled-KB path resolvers.** `default_bundled_kb_path()`
   (src-tauri/src/import.rs L155–164) resolves the bundled KB root via
   `CARGO_MANIFEST_DIR` fallback, while lib.rs (L314–335) resolves it via
   `resource_dir()` at app setup. Two sources of truth for "where is the
   bundled KB" that can diverge between dev and release builds.

None of these are speculative simplifications; every one is dead code or
duplicated state observed today.

## Goals / non-goals

**Goals**

- Remove the `allowedCategories` parameter end-to-end (TS wrapper, dialog
  call site).
- Remove `_prefix` / `_mode` from `query_kb` and its TS wrapper signature.
- Remove `command_files:` from all four bundled `index.yaml` files.
- Kill `FALLBACK_PLATFORM_OPTIONS`; the import dialog fetches platforms via
  the existing `list_kb_platforms` IPC seam (loading state + error message
  while empty).
- One bundled-KB path resolver, owned by the paths area (`src-tauri/src/paths/`),
  used by both lib.rs setup and the import pipeline.

**Non-goals**

- No change to import behavior, suggestion behavior, or merge semantics.
- No new IPC commands (reuse `list_kb_platforms`).
- Not removing `PLATFORM_META`'s badge/color display data (that is display
  styling keyed by platform id, not a platform registry; new platforms simply
  get a default badge via the existing `getPlatformMeta` fallback).
- Not touching prompt detection, mode awareness, or token matching.

## Detailed design

### 1. Drop `allowedCategories` (TS only)

- `src/lib/tauri-api.ts` L485, L503: delete the `allowedCategories?` param
  and the `allowedCategories: allowedCategories ?? null` payload line from
  both `extractKbPreview` and `extractKbPreviewFromText`.
- `src/components/kb-import-dialog.ts` (~L722–729): stop computing and passing
  the category list at both call sites. Rust is already the only source of
  categories via `resolve_index_and_categories`; the dialog keeps rendering
  whatever categories the preview returns.
- If the dialog uses a local category list for anything else (e.g. a select
  input), it should take the list from the preview response it already holds,
  not from a hardcoded constant.

### 2. Honest `query_kb` signature (Rust + TS)

- `src-tauri/src/kb.rs` L1106–1109: delete `_prefix` and `_mode` from the
  `query_kb` Tauri command. Keep the `version` parameter (still consumed by
  `KbStore::query`; its removal is phase 6,
  `plan-kb-version-filter.md` — do not do it here).
- `src/lib/tauri-api.ts` L115–121: change wrapper to `queryKb(platform,
  version)`.
- `src/components/terminal-view.ts` L1203: update the single call site.
- `kb.rs` tests that reference the removed params (if any do — check
  `mod tests` for calls shaped like the old command signature) must be
  updated; the store-level tests (`KbStore::query`) are unaffected.

### 3. Delete `command_files:` from index.yaml (data only)

- Remove the `command_files:` block from
  `knowledge-base/{cisco-iosxe,cisco-nxos,f5-tmos,linux-bash}/index.yaml`.
- Grep for `command_files` across the repo after deletion to catch stragglers
  (docs are fine; no Rust or TS code reads it — verify with the grep, do not
  assume).
- No schema change: `PlatformIndex` never had a corresponding field, so no
  serde update is needed. (If a future review shows the loader *should* be
  file-list-driven, that is a new feature, not this cleanup.)

### 4. Kill `FALLBACK_PLATFORM_OPTIONS` (TS only)

- Delete `FALLBACK_PLATFORM_OPTIONS` from `kb-import-dialog.ts` L37–42.
- The dialog already calls `list_kb_platforms` (verify at implementation
  time; if it does not, add the call at `mount()`). Render from the fetched
  list; while the fetch is pending show a disabled "Loading platforms…"
  option; on fetch failure show an inline error and a retry affordance
  (existing dialog patterns apply — reuse the dialog's current error row
  styling; no new CSS classes).
- Keep "New platform…" as a non-data entry in the dropdown — it is dialog
  behavior, not platform data.

### 5. One bundled-KB path resolver (Rust only)

- Move `default_bundled_kb_path` semantics into the paths area:
  `src-tauri/src/paths/mod.rs` gains the resolver; import.rs calls it.
  The resolver must return the release-build-correct path
  (`resource_dir()`-based, same resolution lib.rs L314–335 performs) with the
  dev-build fallback preserved.
- lib.rs setup keeps its existing logic (it already reads `resource_dir()`
  at the right lifecycle moment); the goal is that import.rs no longer
  carries a *second, different* algorithm. If lib.rs can delegate to the new
  resolver without changing behavior, do that; otherwise leave lib.rs as the
  one caller of the underlying tauri resource resolution and make the new
  resolver the only import.rs entry point.
- Update `import.rs` internal callers (`import_from_url` L185,
  `extract_from_url` L188, `extract_from_text` L376,
  `commit_kb_import` L1497) to use the resolver.
- Importantly: do NOT delete `default_bundled_kb_path` tests' *intent* —
  the test in import.rs (if present) moves to the paths module alongside the
  resolver.

### Sequencing inside this plan

All five steps are independent; they can land as one commit or five. If
split: 1 and 2 are TS↔Rust seam changes (land with the wrapper renames), 3 is
data-only, 4 and 5 are TS / Rust internal. Suggested commit order: 3 (data),
1 (TS seam), 2 (seam), 4 (TS), 5 (Rust).

## Tasks / checklist

- [ ] Remove `allowedCategories` from `extractKbPreview` / `extractKbPreviewFromText` (tauri-api.ts) and both dialog call sites
- [ ] Delete `_prefix` / `_mode` from `query_kb` (kb.rs L1106) and update `queryKb` wrapper (tauri-api.ts L115) + call site (terminal-view.ts L1203)
- [ ] Delete `command_files:` from all four bundled index.yaml files; repo-wide grep confirms no code reads it
- [ ] Delete `FALLBACK_PLATFORM_OPTIONS`; import dialog sources platforms from `list_kb_platforms` with loading/error states
- [ ] Consolidate bundled-KB path resolution into `src-tauri/src/paths/`; import.rs delegates; release/dev resolution preserved
- [ ] `cargo check` in `src-tauri/` exits 0
- [ ] `npm run build` exits 0
- [ ] `npm run test` exits 0 (vitest)
- [ ] `cargo test` (src-tauri) — all existing tests pass; updated where signatures changed

## Verification

- `cargo check` and `cargo test` in `src-tauri/`: exit 0. The import and kb
  test suites must pass unchanged except where a signature was altered.
- `npm run build`: exit 0 (this runs `tsc`; the wrapper signature change
  surfaces here).
- `npm run test`: exit 0.
- Manual smoke: open the import dialog — the platform dropdown lists real
  platforms (fetched, not hardcoded); start a paste-text import; the preview
  still shows categories. Connect to a host (or use the test server); ghost
  text still appears for `show ip int`.
- Repo-wide `rg command_files` returns only doc matches. Repo-wide
  `rg allowedCategories` returns nothing. `rg FALLBACK_PLATFORM_OPTIONS`
  returns nothing.

## Risks / open questions

- **Dev-vs-release path divergence** (step 5): the two resolvers were not
  identical; consolidating must preserve the release-build behavior
  (resource_dir) as primary. Verify in a release build (`cargo tauri build`
  or at least `cargo build --release` plus inspection) if feasible during
  implementation; if not, keep the preserved-algorithm note in the commit
  message.
- **Import dialog fetch failure**: today the hardcoded list cannot fail.
  After this change a failed `list_kb_platforms` blocks platform selection —
  acceptable (import is pointless without platforms), but the dialog must
  show the error rather than an empty dropdown.
- Open question: whether `PLATFORM_META` in `platforms.ts` should also derive
  from fetched data — out of scope here (it is display styling; new platforms
  already degrade to a default badge). Revisit only if a user-facing
  complaint appears.