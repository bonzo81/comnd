# Plan: Production Readiness — Phase 2

Continuation of the production readiness work from
`plan-production-readiness.md` (Phase 1, complete).

**Phase 1 shipped:** `Cargo.lock` committed, `.unwrap()` removal in SSH IPC
paths + audit, config-store init fallback (no more panic), `open_url`
command-injection fix, host field input validation, full SHA-256
fingerprints, session reconnect UI + keepalive visibility, max-session cap
(configurable), panic hook writing to `netssh.log`, window decorations audit
(custom title bar verified), data export/backup with merge-conflict dialog,
ARIA roles + a11y conformance docs.

**Goal:** Move netssh from beta to a professional, publicly shippable
desktop application. Focus is on release infrastructure (signing, CI,
updater), the remaining hardening items, and explicit product decisions —
not new user-facing features.

**Status legend:** `[ ]` not started · `[~]` in progress · `[x]` done ·
`[!]` blocked

Item IDs continue from Phase 1 for traceability (e.g. P0.1 here is the same
item as P0.1 in the Phase 1 doc).

---

## P0 — Ship Blockers

These must be resolved before any public release.

### P0.1 — Code signing and notarization

- [ ] Add `bundle.signing` config to `tauri.conf.json` (Windows Authenticode,
      macOS Developer ID + notarization)
- [ ] Generate signing keys / certificates; store in CI secrets
- [ ] Document signing env vars (`APPLE_ID`, `APPLE_PASSWORD`,
      `APPLE_TEAM_ID`, Windows cert thumbprint / pfx path)
- [ ] Verify signed build on all three platforms

**Why:** Without signing, users get SmartScreen (Windows) / Gatekeeper
(macOS) warnings. Professional apps don't ship unsigned.

**Files:** `src-tauri/tauri.conf.json`, new CI workflow, `docs/DEVELOPMENT.md`

### P0.2 — CI/CD pipeline

- [ ] GitHub Actions workflow: `cargo test` + `cargo check` + `npm run build`
      on every PR
- [ ] Matrix build on tag push: windows-latest, macos-latest, ubuntu-latest
- [ ] Signed artifact upload (depends on P0.1)
- [ ] Optional: nightly build from `main`

**Why:** Every release is currently hand-built on one machine. No automated
test gate. CI is the foundation of reproducible releases.

**Files:** `.github/workflows/ci.yml`, `.github/workflows/release.yml`

---

## P1 — High Priority

Resolve before public release; acceptable for private beta without these.

### P1.4 — Tauri updater plugin

- [ ] Add `tauri-plugin-updater` dependency
- [ ] Configure updater endpoint (static JSON manifest on a CDN / GitHub
      releases)
- [ ] Wire a "Check for updates" action in Settings
- [ ] Sign the update manifest (depends on P0.1)
- [ ] Test update flow on all three platforms

**Why:** Users have no way to know a new version exists. Tauri v2 has a
first-party updater plugin.

**Files:** `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`,
`src/components/settings-screen.ts`

### P1.5 — App store / distribution metadata

- [ ] Short description (≤80 chars)
- [ ] Long description (≤4000 chars)
- [ ] Screenshots (at least 3: host list, terminal + suggestions, KB viewer)
- [ ] App category (Networking / Developer Tools)
- [ ] Keywords for discoverability
- [ ] Privacy policy URL (even if "we collect nothing")
- [ ] Prepare submissions: winget, Homebrew Cask, Snap/Flatpak (Linux)

**Why:** `tauri.conf.json` has no app metadata for store listings. Store /
package manager submissions need these.

**Files:** `src-tauri/tauri.conf.json`, new `docs/distribution-metadata.md`

---

## P2 — Should Fix

Address before wide release; acceptable for limited beta.

### P2.2 — Known-hosts management UI

- [ ] Add a Settings → Known Hosts panel
- [ ] List entries from `known_hosts.json` (hostname:port, key type,
      fingerprint, first-seen date)
- [ ] Per-entry "Delete" button (revokes trust)
- [ ] "Clear all" button with confirmation
- [ ] Show full `SHA256:base64` fingerprint (Phase 1 P2.3 already produces
      the correct format)

**Why:** TOFU is silent. Users cannot review, delete, or audit stored host
keys. A professional SSH client shows the known-hosts list and lets users
revoke trust.

**Files:** `src-tauri/src/ssh.rs`, `src-tauri/src/lib.rs`,
`src/components/settings-screen.ts`, `src/lib/tauri-api.ts`

### P2.4 — Session reconnect and keep-alive UI feedback (remaining)

- [ ] Consider configurable keepalive interval / max in Settings

**Why:** Keepalive is currently fixed at 15s × 3. Pro users on very flaky
links may want it tuned without a rebuild.

**Files:** `src-tauri/src/ssh.rs`, `src/components/settings-screen.ts`

*Phase 1 completed the event surfacing, "Reconnecting…" indicator, and
manual Reconnect button.*

### P2.6 — Import rate limiting

- [ ] Track in-flight import by URL; reject duplicate concurrent imports
- [ ] Add a cooldown (suggest 30s) on the same URL
- [ ] Surface "import in progress" state to the UI

**Why:** Each `import_kb_url` / `extract_kb_preview` call fetches a URL +
sends to Ollama (5-minute timeout, 64k context). Repeated clicks hammer the
Ollama server and the target doc site. No debounce on the Rust side.

**Files:** `src-tauri/src/import.rs`, `src-tauri/src/lib.rs`,
`src/components/kb-import-dialog.ts`

### P2.7 — Honest User-Agent in import fetch

- [ ] `import.rs:290`: replace the spoofed Chrome UA with
      `netssh/{version} (SSH client; +https://netssh)`
- [ ] Verify import still works against Cisco / F5 / Juniper docs (they
      block by bot-detection, not UA — spoofing buys nothing)

**Why:** Spoofing a browser UA is a policy concern (some TOS forbid it) and
looks unprofessional. Cisco/F5 block by bot-detection heuristics, not UA
string.

**Files:** `src-tauri/src/import.rs`

### P2.8 — Crash reporting / panic hook (remaining, optional)

- [ ] Optionally: add `tauri-plugin-log` for structured logging
- [ ] Optionally: opt-in Sentry integration (privacy-respecting, off by
      default, with a first-run consent prompt)

**Why:** The Phase 1 panic hook captures crashes locally. Structured logging
and opt-in remote reporting are polish on top, not blockers.

**Files:** `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml`

*Phase 1 installed the `std::panic::set_hook` that writes panics to
`netssh.log`.*

---

## P3 — Nice to Have

Improve professional polish; not blocking for any release.

### P3.1 — LICENSE file

- [ ] Add a `LICENSE` file in the repo root
- [ ] If open source: choose a license (MIT, Apache-2.0, or GPL)
- [ ] If closed source: state it explicitly
- [ ] Update `README.md` with license info

**Why:** Repo has `CONTRIBUTING.md` but no `LICENSE`. Legally ambiguous for
open source; should be explicit either way. Trivial — should not wait.

**Files:** `LICENSE`, `README.md`

### P3.2 — Window decorations audit (remaining)

- [ ] Test on Linux (Wayland + X11) — no OS controls without decorations

**Why:** Phase 1 verified the custom title bar (CSS drag region + JS
min/max/close). Linux is the only platform where `decorations: false`
behavior hasn't been manually confirmed.

**Files:** manual test; file changes only if something breaks

### P3.4 — Multi-window support

- [ ] Allow "Open in new window" for a host
- [ ] Each window gets its own terminal session list
- [ ] Shared app state (hosts, config, KB) across windows

**Why:** Pro network engineers often want two terminals side-by-side on two
monitors. Tauri v2 supports multi-window. Larger effort — schedule for
post-1.0.

**Files:** `src-tauri/src/lib.rs`, `src/main.ts`, `src/components/`

### P3.5 — Accessibility audit (remaining)

- [ ] Test with a screen reader (NVDA on Windows, VoiceOver on macOS) —
      manual pass required; checklist in `docs/accessibility.md`

**Why:** Phase 1 added ARIA roles, visible focus indicators, and the
conformance doc. The manual screen-reader pass is the only unverified claim
in the a11y story.

**Files:** manual test against `docs/accessibility.md` checklist

### P3.6 — Telemetry / analytics decision

- [ ] Decide: collect anonymous usage stats? (default: no)
- [ ] If yes: add opt-in toggle in Settings + first-run privacy notice
- [ ] If no: document the decision in `README.md` / privacy policy
- [ ] Crash reports: see P2.8 (separate from usage telemetry)

**Why:** Not a gap per se, but a decision that should be documented. Doing
nothing is fine; it should be an explicit choice.

**Files:** `README.md`, `docs/distribution-metadata.md`

### P3.7 — i18n scaffolding

- [ ] Extract all user-facing strings into a `src/lib/strings.ts` map
- [ ] Add a `t(key)` function and locale loader
- [ ] Ship English only initially; structure allows translations later
- [ ] Consider `@formatjs/intl` or a lightweight alternative

**Why:** All strings are hardcoded in English. Pro apps targeting global
network teams need at least the scaffolding for translations, even if only
English ships initially.

**Files:** `src/lib/strings.ts` (new), all `src/components/*.ts`

---

## Recommended Implementation Order

1. **P3.1** (LICENSE) — trivial, do now
2. **P0.1 + P0.2** (signing + CI) — do together; CI runs the signed builds
3. **P1.5** (distribution metadata) — parallel to P0.1/P0.2, no code deps
4. **P1.4** (updater) — depends on P0.1 signing keys
5. **P2.2 → P2.7** — in priority order; each is independent
6. **P3.2 + P3.5** (manual tests) — batch into one Linux/macOS test session
7. **P3.4, P3.6, P3.7** — as time permits

**Critical path to public release:** P0.1 → P0.2 → P1.4. Everything else is
beta-acceptable per the tiering above.

## Verification

After each item:

- Frontend changes: `npm run build` (runs `tsc`) — must exit 0
- Rust changes: `cargo check` in `src-tauri/` — must exit 0
- Run relevant tests: `cargo test` in `src-tauri/`, `npm test` in root
- Manual smoke test: launch the app, verify the affected flow

## Out of Scope

- Encrypting `hosts.json` at rest (keychain handles secrets; host metadata
  is not secret enough to justify key-management surface)
- SQLite / SQLCipher migration (flat JSON is fine at current scale)
- OpenSSH `~/.ssh/known_hosts` interop (separate future task)
- Log rotation (size cap already in place; full rotation is a separate task)
- Windows ACL tightening beyond parent-dir inheritance (YAGNI while
  everything lives under `app_local_data_dir`)
