# Plan: One Source of Platform Truth

Candidate 5 from the architecture review. Platform identity is defined in
five places with three different truths, and two of them disagree today:

| Location | Form | Truth |
|---|---|---|
| hosts.rs:57 | `VALID_PLATFORMS` const | hardcoded 4 platforms |
| netbox.rs:193–215 | `PLATFORM_TABLE` + `PlatformPolicy` | hardcoded slug map + user overrides |
| kb.rs `list_platforms` (655) | scans KB dirs for `index.yaml` | derived from disk — accepts anything |
| src/lib/platforms.ts:6 | `PLATFORM_META` | hardcoded labels for 4 |
| src/lib/terminal-view.ts:58 | `PLATFORM_LABELS` | a stale copy of the above |

The disagreement is a real bug path: custom platform import
(docs/10-custom-knowledge-base.md Part 5) writes a new platform dir that
`kb::list_platforms` happily returns — and `hosts::validate_host` then
rejects any host using it ("Platform 'X' is not valid"). The frontend
dropdown already lists custom platforms (host-screen.ts:167–171 calls
`listKbPlatforms()` and appends them to the platform select), so the user
can *choose* a platform the backend then refuses to save a host for. Badge
rendering degrades gracefully already (`platformBadge` falls back to first
4 chars, platforms.ts:21) — but custom badges render unstyled
(`platformColorClass` returns `""` for unknown platforms, platforms.ts:25).
Each new platform requires touching 3+ backend files.

A design review found a third backend consumer the original draft missed:
`replay.rs:65` validates replay commands against the same hardcoded
`is_valid_platform` — the same bug, second instance: a custom-platform
replay command is unsavable. The registry must serve it too.

---

## 1. The change

### 1.1 Backend: `PlatformRegistry` module

New `src-tauri/src/platform.rs`:

```rust
/// Single source of platform truth. Built once at startup by scanning both
/// KB roots (bundled + user) for `<platform>/index.yaml`, then cached.
pub struct PlatformRegistry {
    platforms: BTreeSet<String>,          // sorted, stable for UI
}

impl PlatformRegistry {
    pub fn scan(bundled_kb: &Path, user_kb: Option<&Path>) -> Self;
    pub fn is_valid(&self, platform: &str) -> bool;
    pub fn all(&self) -> Vec<String>;
    /// Re-scan after a custom-platform import / KB mutation.
    pub fn rescan(&mut self, bundled_kb: &Path, user_kb: Option<&Path>);
}
```

Truth becomes: **a platform exists iff it has an `index.yaml` in a KB root** —
exactly the rule `kb::list_platforms` already implements and the KB loader
already enforces. The other sites become consumers:

- **hosts.rs:** `VALID_PLATFORMS` const and `is_valid_platform`'s hardcoded
  check move out. `validate_host` needs the registry — pass it in
  (`validate_host(&host, &registry)`), and `HostStore::create/update`
  (hosts.rs:235, 248) take it from `AppState`. The existing validate_host
  tests construct a registry from a temp dir with the four standard
  platforms; a helper `PlatformRegistry::builtin()` (the current hardcoded
  four, used only in tests) keeps those tests readable.
- **netbox.rs:** `PLATFORM_TABLE` stays — mapping device slugs → platform is
  NetBox-domain knowledge, not platform truth. Today invalid overrides are
  already *rejected* at config level (`platform_policy()` filters overrides
  whose target fails `is_valid_platform` at netbox.rs:628–633, and
  `NetBoxConfig::validate()` rejects the whole config at 661–668) — so the
  real gap is the reverse: a *valid custom* platform cannot be used in an
  override. Wiring the registry in fixes that: the four
  `is_valid_platform` call sites (netbox.rs:624, 631, 652, 662) and the
  hardcoded platform list in the error string (654) switch from the const
  to the registry, so custom platforms become overridable targets and the
  error message lists what actually exists.
- **replay.rs:** the same swap — `replay.rs:65`'s `is_valid_platform` call
  reads from the registry. This is what makes custom-platform replay
  commands savable; without it the hosts fix is half a fix.
- **kb.rs:** `list_platforms` delegates to the registry (or the registry's
  scan *is* that code, moved — decide in grilling; the lazy default is:
  `KbManager::list_platforms` keeps working but the scan code moves to
  platform.rs and KbManager calls it, so there's one scan implementation).
- **AppState:** one more field, `platforms: Mutex<PlatformRegistry>`,
  rescanned after KB mutations. Rescan anchoring is order-dependent with
  plan-kb-single-interface — see §1.4.

### 1.2 Frontend: one label map

- Delete `PLATFORM_LABELS` from terminal-view.ts:58 — use
  `platforms.ts:getPlatformMeta`. Verified safe: its two use sites (1229,
  1254) already have platform fallbacks and its label strings are identical
  to `PLATFORM_META`'s.
- The hardcoded four in platforms.ts stay as *presentation* defaults (badge,
  label, color are UI concerns, not identity). Unknown platforms already get
  a generic badge (`platformBadge` falls back to first 4 chars,
  platforms.ts:21) — the actual gap is styling: `platformColorClass` returns
  `""` for unknown platforms. Add one fallback class (e.g.
  `badge-custom`, a neutral gray) — one line.
- Platform dropdowns already read from the backend: host-screen.ts:167–171
  calls `listKbPlatforms()` and appends custom platforms. Nothing to build
  there — the frontend story is only the label dedup + fallback class.

### 1.4 Rescan anchoring — order-dependent with plan-kb-single-interface

Today's rescan anchor is the six `kb.reload_all()` call sites
(lib.rs:1170, 1259, 1372, 1396, 1418, 1440) — this plan's step 5 says
"call `registry.rescan()` wherever `reload_all()` already runs". **If
plan-kb-single-interface lands first**, four of those sites (1372, 1396,
1418, 1440) disappear into the manager's internal invalidation — so this
plan must then put the rescan *inside* the KbManager mutation methods or
accept a passed-in registry. Resolution rule:

- Plan 3 first: `KbManager` mutation methods take `&mut Option<&PlatformRegistry>`
  — no. Simpler: plan 3 keeps its `stores.remove(platform)` and *also* calls
  an optional rescan hook; add the hook parameter when plan 5 lands.
- Plan 5 first: plan 3 must move the four rescan calls into its new
  mutation methods. State this in plan 3's step list (a note has been added
  there).

Either way: rescan happens at the mutation sync points, sequential locks
only, no nesting, no notification mechanism.

### 1.3 The bug this fixes, as acceptance test

Import a doc as new platform `vendor-cli` (docs/10 Part 5 flow) → create a
host on it → save succeeds. Today: save_host fails validation (the dropdown
already offers the platform — host-screen.ts:167 — so the user hits the
wall at save). After: works, badge renders (generic fallback + neutral
color class), host appears in the tree, and a replay command on the
platform saves too (replay.rs fix).

## 2. What this buys

- **Locality:** adding a platform (bundled or custom) touches zero
  registry consumers — the scan picks it up.
- **Fixes a real user-facing bug** (custom-platform hosts and replay
  commands rejected) — the review's reason this was "worth exploring"
  rather than speculative.
- **Leverage:** one `is_valid` interface, four backend consumers (hosts,
  netbox, replay, kb); the netbox override path accepts valid custom
  platforms for free.
- Frontend stops drifting: terminal-view's stale copy dies.

## 3. Locking note

`AppState` gains a registry behind its own std Mutex, read in
`validate_host` paths and written in rescan-after-KB-mutation paths. Reads
and writes are sequential-locks only, no nesting — same discipline as today.
Rescan happens inside handlers that already hold the kb lock but **not**
nested: drop kb lock, then rescan. (The codebase's stated rule, lib.rs:438.)

## 4. Steps

1. **Create platform.rs:** `PlatformRegistry` + scan (code lifted from
   kb.rs:655–687), `builtin()` test helper. Unit tests: scan over temp dirs
   (empty, bundled-only, user-only, overlap, missing index.yaml excluded).
   `cargo test`.
2. **Wire hosts.rs:** registry param through `validate_host` /
   `HostStore::create/update`; lib.rs AppState field + startup scan
   (where the kb manager is built, lib.rs:1634–1656 area). Existing hosts
   tests updated with `builtin()`; one new test: custom platform host
   validates when registry includes it.
3. **Wire replay.rs + netbox.rs:** replay.rs:65 reads the registry; netbox's
   four `is_valid_platform` sites (624, 631, 652, 662) and the error-string
   platform list (654) read the registry — enabling overrides to valid
   custom platforms. Existing netbox tests (28) pass; add one test:
   override to a custom platform passes config validation when the registry
   includes it.
4. **Wire kb.rs:** `list_platforms` delegates to the scan.
5. **Frontend:** delete terminal-view's `PLATFORM_LABELS`; add the
   `badge-custom` color fallback in platforms.ts. `npm run build`.
6. **Rescan hook:** call `registry.rescan()` at the KB-mutation sync points
   — see §1.4 for which sites exist depending on whether
   plan-kb-single-interface has landed. Acceptance test from §1.3 manually.

## 5. Verification

- `cargo check` + `cargo test` after each backend step; existing 42 kb +
  28 netbox + 22 hosts tests green.
- New: ~6 registry tests, 2 validation tests, 1 netbox policy test,
  1 replay validation test.
- `npm run build` for frontend step.
- Manual: §1.3 acceptance flow + a normal linux-bash host still saves
  (no regression).

## 6. Deliberate non-goals

- No moving NetBox's slug→platform mapping into the registry — that's
  integration policy, not platform identity.
- No per-platform UI theming/metadata from the backend (badges stay
  frontend presentation).
- No dynamic re-scan on file watch — rescan only at the existing
  mutation-sync points.