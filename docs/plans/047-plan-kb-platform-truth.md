# Plan: One Platform-Truth Module (Phase 2)

Collapse the two live platform sets in `AppState` into one: the
`PlatformRegistry`. Standalone plan from the Sep 2026 KB architecture review;
phase 3 of the KB cleanup, sequenced after `plan-kb-false-seams.md` (phase 0)
and `plan-kb-contract-test.md` (phase 1).

Companion plans, in order: 0 `plan-kb-false-seams.md` ·
1 `plan-kb-contract-test.md` · **2 this plan** ·
3 `plan-kb-import-pipeline.md` · 4 `plan-kb-import-progress.md` ·
5 `plan-kb-version-filter.md` · 6 `plan-kb-split-modules.md`.

## Why (problem being solved)

The answer to "which platforms exist?" lives in **two independent, live copies**
in the backend state, each maintained by a different module:

1. `state.platforms: Mutex<PlatformRegistry>` (`src-tauri/src/state.rs` L32) —
   scanned at setup and rescanned after imports by
   `PlatformRegistry::rescan` (`src-tauri/src/platform.rs` L50), which walks
   both roots via `scan_root` (platform.rs L66).
2. `KbManager::list_platforms` (`src-tauri/src/kb.rs` L656–663) — the KbManager
   performs its *own* directory scan over both roots using the same
   `platform::scan_root`, on demand.

The `list_kb_platforms` IPC command (platform.rs L183–188) reads copy 2; the
hosts / netbox / replay validation paths read copy 1. Both copies must agree
at all times, and they only do because both import commands
(`extract_kb_preview*` at import.rs L1383–1386 and `commit_kb_import` at
import.rs L1506–1510) *remember* to call both `kb.reload_all()` **and**
`state.platforms...rescan()`. Every future mutation that adds or removes a
platform directory must remember the same dual invalidation, or the two
copies silently disagree — the import dialog would list a platform the host
form rejects, or vice versa.

This is a duplicated-state coupling with no single module owning the
concept. The deletion test: deleting `KbManager::list_platforms` does not
move complexity around — it concentrates platform enumeration in the module
that hosts, netbox, and replay already depend on. One cache to invalidate,
one scan, one interface.

## Goals / non-goals

**Goals**

- `AppState` holds exactly one live platform set: the `PlatformRegistry`.
- `KbManager` stops scanning directories for platforms; its
  `list_platforms` method is deleted.
- The `list_kb_platforms` IPC command reads `state.platforms`
  (the registry), not KbManager.
- Import mutations invalidate exactly one cache: `state.platforms.rescan()`
  (+ `kb.reload_all()` for the *command* cache, which stays — it caches
  loaded command stores, a different concern).
- `PlatformRegistry` remains the deep module: consumers (hosts, netbox,
  replay, import, IPC) get `is_valid` / `all` / `rescan` and nothing else.

**Non-goals**

- Not merging `PlatformRegistry` and `KbManager` into one module — they cache
  different things (platform existence vs loaded command stores). Only the
  *platform enumeration* is consolidated.
- No IPC surface change beyond what phase 0 already did; `list_kb_platforms`
  keeps its exact wire contract.
- Not touching `platform::scan_root` semantics or `BUILTIN_PLATFORMS`.
- No frontend changes.

## Detailed design

### 1. Change the IPC command's data source

`list_kb_platforms` (platform.rs L183–188) currently does:

```rust
Ok(kb.list_platforms())
```

It takes the KbManager lock and scans. Change it to take
`state.platforms` (the registry) and return `registry.all()` — same
`Vec<String>` shape, same ordering guarantee (`BTreeSet`-backed, so sorted
— verify `all()` preserves the same ordering `list_platforms` produced;
both go through `BTreeSet`, so they do).

### 2. Delete `KbManager::list_platforms`

- kb.rs L656–663: delete the method and its `platform::scan_root` usage.
- Check `mod tests` in kb.rs for direct calls; tests that set up a
  KbManager and call `list_platforms` switch to building a
  `PlatformRegistry` over the same fixture directories (platform.rs already
  has the test utilities — reuse its test module's temp-dir patterns).
- After deletion, `KbManager` should have no remaining dependency on
  `platform::scan_root` (grep to confirm; `platform::BUILTIN_PLATFORMS` or
  index loading via `get_platform_index` may remain — those are fine, they
  are consumers of platform *data*, not enumerators of platform
  *directories*).

### 3. Single-cache invalidation at the two import sites

- import.rs L1383–1386 and L1506–1510: keep `kb.reload_all()` (command
  stores), drop nothing else — `state.platforms.rescan()` is already there
  and stays. The diff is that the *other* half of the pair
  (`kb.list_platforms`'s implicit re-scan) no longer exists to drift.
- Grep for any other `reload_all()` call sites; each one that follows a
  platform-directory mutation must also call `state.platforms.rescan()`.
  Today those are exactly the two import commands — confirm at
  implementation time and note any new ones found.

### 4. Setup-time wiring

- lib.rs setup already constructs the registry before serving IPC (verify
  ordering at implementation: the registry must be populated before the
  first `list_kb_platforms` can fire; it is built in setup, so it is).
- No change expected; listed here so the implementer checks rather than
  assumes.

## Tasks / checklist

- [ ] `list_kb_platforms` reads `state.platforms` (registry) instead of `kb.list_platforms()`
- [ ] Delete `KbManager::list_platforms` (kb.rs L656–663); no `scan_root` callers remain in kb.rs
- [ ] Import commands keep `kb.reload_all()` + `state.platforms.rescan()`; grep confirms no other mutation sites need the pair
- [ ] kb.rs tests that used `list_platforms` migrate to `PlatformRegistry` fixtures
- [ ] `cargo check` exits 0
- [ ] `cargo test` exits 0
- [ ] `npm run build` exits 0 (no TS change expected — build confirms it)
- [ ] `npm run test` exits 0

## Verification

- All four verification commands green.
- Rust tests: platform.rs's existing tests (`rescan_picks_up_new_platform`,
  platform.rs L151) already cover the registry's behavior; the migrated
  kb.rs tests must keep their assertions (same platform sets observed).
- Manual smoke: import a command into a **new** user platform (paste-text
  import with "New platform…"), then (a) the import dialog lists the new
  platform on next open, (b) a host form accepts the new platform id,
  (c) `list_kb_platforms` via the KB screen shows it. All three read the
  registry now, so this exercises the single-cache invariant.
- Regression probe (do once): temporarily comment out the
  `state.platforms.rescan()` in `commit_kb_import`, run the new-platform
  import smoke, observe the platform missing everywhere (not just in one
  consumer) — this confirms one cache, then restore.

## Risks / open questions

- **Lock ordering**: `list_kb_platforms` moves from the kb lock to the
  platforms lock — strictly a reduction in shared-lock contention; no
  ordering risk is introduced (the handler no longer takes the kb lock at
  all).
- **`all()` vs `list_platforms()` ordering**: both derive from
  `BTreeSet<String>`, so both are sorted; the wire format is unchanged for
  callers. Verify with one assertion in the migrated tests.
- Open question: should `PlatformRegistry` also own "platform has an index /
  is loadable" checks? Out of scope — `KbManager::get_platform_index`
  already answers that; do not widen the registry's interface
  speculatively.