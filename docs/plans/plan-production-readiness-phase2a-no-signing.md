# Plan: Production Readiness — Phase 2A (No Code Signing)

Continuation of `plan-production-readiness.md` (Phase 1, complete).

**Why this doc exists:** Phase 2 is split into two tracks by one dependency — *does the work require code-signing / notarization?* This track (2A) holds everything that does **not**. It can proceed immediately with no certificate or account prerequisites, so netssh keeps moving. The signing-dependent remainder lives in `plan-production-readiness-phase2b-code-signing.md` (2B) and is deferred until a no-vendor-warning public release is actually required.

**Nothing in 2A blocks on 2B.** A beta can ship on 2A alone.

**Goal:** hardening, an automated CI quality gate, security features, and product polish — not new user-facing features, and no signing.

**Status legend:** `[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked

Item IDs continue from Phase 1 for traceability (e.g. P2.2 here is the same item as P2.2 in the Phase 1 doc). Where an item straddled the signing boundary it was split and suffixed: `P0.2a` = CI test gate + unsigned builds (here); `P0.2b` = signed release build + upload (in 2B).

---

## P0 — Foundation

### P0.2a — CI/CD pipeline: test gate + unsigned builds

- [x] GitHub Actions workflow: `cargo test` + `cargo check` + `npm run build` on every PR
- [x] Matrix build on tag push: windows-latest, macos-latest (aarch64 + x86_64), ubuntu-22.04 → unsigned artifacts for internal / beta distribution
- [ ] Optional: nightly build from `main`

**Why:** Every release is currently hand-built on one machine. No automated test gate. This half of the pipeline needs no signing — it's pure quality + reproducibility. The signed-artifact-upload half is P0.2b in Phase 2B.

**Files:** `.github/workflows/ci.yml`, `.github/workflows/release.yml`

---

## P1 — High Priority

### P1.5 — App store / distribution metadata

- [ ] Short description (≤80 chars)
- [ ] Long description (≤4000 chars)
- [ ] Screenshots (at least 3: host list, terminal + suggestions, KB viewer)
- [ ] App category (Networking / Developer Tools)
- [ ] Keywords for discoverability
- [ ] Privacy policy URL (even if "we collect nothing")
- [ ] Prepare submissions: winget, Homebrew Cask, Snap/Flatpak (Linux)

**Why:** `tauri.conf.json` has no app metadata for store listings. Store / package manager submissions need these. No signing involved.

**Files:** `src-tauri/tauri.conf.json`, new `docs/distribution-metadata.md`

---

## P2 — Should Fix

### P2.2 — Known-hosts management UI

- [ ] Add a Settings → Known Hosts panel
- [ ] List entries from `known_hosts.json` (hostname:port, key type, fingerprint, first-seen date)
- [ ] Per-entry "Delete" button (revokes trust)
- [ ] "Clear all" button with confirmation
- [ ] Show full `SHA256:base64` fingerprint (Phase 1 P2.3 already produces the correct format)

**Why:** TOFU is silent. Users cannot review, delete, or audit stored host keys. A professional SSH client shows the known-hosts list and lets users revoke trust.

**Files:** `src-tauri/src/ssh.rs`, `src-tauri/src/lib.rs`, `src/components/settings-screen.ts`, `src/lib/tauri-api.ts`

### P2.4 — Session reconnect and keep-alive UI feedback (remaining)

- [ ] Configurable keepalive interval / max in Settings (default 30s / 3)

**Why:** Phase 1 added the keepalive mechanism and the disconnect banner + Reconnect button. The only remaining sub-item is making the interval configurable so users on flaky links can tune it.

**Files:** `src/components/settings-screen.ts`, `src/lib/tauri-api.ts` (or terminal-view config)

### P2.6 — Import rate limiting

- [ ] Add a per-host rate limiter (e.g. max 10 requests / minute per host)
- [ ] Return a clear error when the limit is hit
- [ ] Document the limit in `docs/specs/06-knowledge-base.md`

**Why:** `fetch_source` has no rate limiting. A user importing from a slow or flaky source could hammer it. Network engineers' devices may have strict egress policies.

**Files:** `src-tauri/src/import.rs`

### P2.7 — Honest User-Agent in import fetch

- [ ] Replace `"netssh-kb-import/0.1"` with a real, versioned UA string that includes the app version and an optional contact URL
- [ ] Make it configurable via `tauri.conf.json` or a constant

**Why:** The current UA is a placeholder. A real product should identify itself honestly to the servers it fetches from.

**Files:** `src-tauri/src/import.rs`, `src-tauri/tauri.conf.json`

### P2.8 — Crash reporting / panic hook (remaining, optional)

- [ ] Optional: add `tauri-plugin-log` for file-based logging on all platforms
- [ ] Optional: opt-in Sentry or similar crash reporter (off by default, user must enable in Settings)

**Why:** Phase 1 added a Windows panic hook that writes to a log file. The remaining sub-items are cross-platform file logging and an optional remote crash reporter — both deferred because they add dependencies and the current panic hook is sufficient for MVP.

**Files:** `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`, `src/components/settings-screen.ts`

---

## P3 — Nice to Have

### P3.1 — LICENSE file

- [ ] Add a `LICENSE` file (MIT, matching `tauri.conf.json` `"license": "MIT"`)
- [ ] Add a short `CONTRIBUTING.md` with build instructions and coding conventions

**Why:** The license is declared in config but no license file exists. A public release needs one.

**Files:** new `LICENSE`, new `CONTRIBUTING.md`

### P3.2 — Window decorations audit (remaining)

- [ ] Manual test on Linux (Wayland + X11) to confirm the custom title bar renders correctly with no native decorations

**Why:** Phase 1 verified the CSS `-webkit-app-region: drag` title bar and JS min/max/close via `getCurrentWindow()`. The remaining sub-item is a manual Linux test, since the dev environment is Windows.

**Files:** none (manual verification)

### P3.4 — Multi-window support

- [ ] Allow opening multiple terminal windows (each with its own SSH session)
- [ ] Window management: list of open windows in the sidebar or a window switcher
- [ ] `Ctrl+Tab` to cycle between windows

**Why:** Network engineers often need multiple concurrent sessions. Tauri v2 supports multi-window via `WebviewWindowBuilder`. This is a significant feature, not a quick fix.

**Files:** `src-tauri/src/lib.rs`, `src/main.ts`, new window management module

### P3.5 — Accessibility audit (remaining)

- [ ] Manual screen-reader pass (NVDA on Windows, VoiceOver on macOS)

**Why:** Phase 1 added ARIA roles, labels, and a visible focus ring. The remaining sub-item is a manual screen-reader verification, which requires the specific assistive technology installed.

**Files:** none (manual verification)

### P3.6 — Telemetry / analytics decision

- [ ] Decide: no telemetry, or opt-in anonymous usage stats
- [ ] If opting in: add a toggle in Settings, default OFF
- [ ] Document the decision in `docs/specs/08-future-open-questions.md`

**Why:** A professional app should make a deliberate choice about telemetry. For an SSH client handling sensitive connections, "no telemetry" is the safest default and likely the right one. This item is primarily a *decision* to record, not code.

**Files:** `docs/specs/08-future-open-questions.md`, optionally `src/components/settings-screen.ts`

### P3.7 — i18n scaffolding

- [ ] Extract all user-facing strings into a translation table
- [ ] Add a language selector in Settings (default: system locale)
- [ ] Ship English only; structure allows adding languages later

**Why:** The target audience is global network engineers. Even shipping English-only, the string extraction is cheap now and expensive later.

**Files:** new `src/lib/i18n.ts`, all components with user-facing strings

---

## Recommended Implementation Order

1. **P3.1** (LICENSE) — trivial, do now
2. **P0.2a** (CI test gate + unsigned builds) — foundation; no signing
3. **P2.2 → P2.7** — hardening, each independent, any order by priority
4. **P1.5** (distribution metadata) — parallel, no code deps
5. **P3.2 + P3.5** (manual tests) — batch into one Linux/macOS test session
6. **P3.4, P3.6, P3.7** — as time permits

**Relationship to 2B:** none of the above requires signing. When a no-vendor-warning public release is needed, start Phase 2B (P0.1 → P0.2b → P1.4); it builds on the P0.2a workflow added here.

## Verification

- `cargo check` — exit 0
- `npm run build` — exit 0
- Manual: CI workflow runs green on a test PR
- Manual: known-hosts panel shows entries, delete works
- Manual: import rate limit triggers after N rapid requests
- Manual: unsigned beta artifacts produced by the tag-push matrix

## Out of Scope

- New target platforms (Cisco IOS classic, JunOS)
- LLM-powered suggestions
- Mobile support
- Plugin system
- **Code signing / notarization, signed release builds, and the updater — tracked in `plan-production-readiness-phase2b-code-signing.md`**
