# Plan: Production Readiness — Phase 2B (Code Signing & Signed Release)

The code-signing-dependent subset of Phase 2, split out from `plan-production-readiness-phase2a-no-signing.md` (2A).

**Deferred by design.** Start this track only when a public release that must not trigger SmartScreen (Windows) / Gatekeeper (macOS) is required. Everything in Phase 2A ships and develops independently of this track — nothing there waits on signing.

**Prerequisites (the real cost / lead-time):**
- Apple Developer Program account ($99/yr) + a Developer ID Application certificate + notarization credentials
- A Windows code-signing certificate (OV, or EV for faster SmartScreen reputation)
- CI secrets provisioned for both (P0.1)

**Status legend:** `[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked

Item IDs continue from Phase 1. `P0.2b` is the signed-release half of the pipeline; its test-gate + unsigned-build half (`P0.2a`) lives in Phase 2A.

---

## P0 — Ship Blockers

### P0.1 — Code signing and notarization

- [ ] Add `bundle.signing` config to `tauri.conf.json` (Windows Authenticode, macOS Developer ID + notarization)
- [ ] Generate signing keys / certificates; store in CI secrets
- [ ] Document signing env vars (`APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`, Windows cert thumbprint / pfx path)
- [ ] Verify signed build on all three platforms

**Why:** Without signing, users get SmartScreen (Windows) / Gatekeeper (macOS) warnings. Professional apps don't ship unsigned.

**Files:** `src-tauri/tauri.conf.json`, new CI workflow step, `docs/DEVELOPMENT.md`

### P0.2b — CI/CD pipeline: signed release build + upload

- [ ] Add code-signing to the release workflow from Phase 2A (P0.2a): Authenticode on `windows-latest`, Developer ID sign + notarize on `macos-latest`
- [ ] Signed artifact upload (depends on P0.1)

**Why:** Turns the unsigned beta builds produced by P0.2a into trusted, warning-free release artifacts. Reuses the same workflow — only the signing steps are added.

**Files:** `.github/workflows/release.yml`, CI secrets

---

## P1 — High Priority

### P1.4 — Tauri updater plugin

- [ ] Add `tauri-plugin-updater` dependency
- [ ] Configure updater endpoint (static JSON manifest on a CDN / GitHub releases)
- [ ] Wire a "Check for updates" action in Settings
- [ ] Sign the update artifacts + manifest with the minisign signer key
- [ ] Test update flow on all three platforms

**Why:** Users have no way to know a new version exists. Tauri v2 has a first-party updater plugin.

**Files:** `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src/components/settings-screen.ts`

*Signing nuance: the updater authenticates updates with a **minisign** key (`tauri signer generate`) — free and local, independent of the code-signing certs in P0.1. It can be generated and stored early. A minisign-only updater hosted on the Phase 2A release workflow / GitHub Releases works before P0.1 lands, but each update still triggers SmartScreen/Gatekeeper; completing P0.1 makes updates warning-free.*

---

## Recommended Implementation Order

1. **P0.1** — get accounts/certs, store in CI secrets (also generate the minisign signer key for P1.4)
2. **P0.2b** — wire signing into the Phase 2A release workflow
3. **P1.4** — updater slots into the signed release workflow

**Critical path to a clean public release:** P0.1 → P0.2b → P1.4. A beta does not need any of it — ship on Phase 2A.

## Verification

- `cargo check` — exit 0
- `npm run build` — exit 0
- Manual: signed Windows build passes SmartScreen (no "Unknown publisher")
- Manual: signed macOS build passes Gatekeeper + `spctl --assess`
- Manual: updater detects and installs a new version on all three platforms

## Out of Scope

- New target platforms (Cisco IOS classic, JunOS)
- LLM-powered suggestions
- Mobile support
- Plugin system
- **Everything that does not require signing — tracked in `plan-production-readiness-phase2a-no-signing.md`**
