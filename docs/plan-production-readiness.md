# Plan: Production Readiness Review

Tracking document for gaps identified in the productization review of
net.sh. Derived from a full codebase audit (Rust backend + TS frontend +
Tauri config + build/release infra).

**Goal:** Move net.sh from a solid MVP to a professional, shippable desktop
application. Focus is on robustness, security, storage, permissions, and
release infrastructure — not new user-facing features.

**Status legend:** `[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked

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

### P0.3 — Commit `Cargo.lock`

- [x] Remove `src-tauri/Cargo.lock` (or `Cargo.lock`) from `.gitignore`
- [x] `git add src-tauri/Cargo.lock` and commit
- [x] Verify `cargo build` is reproducible across machines

**Why:** For a binary application, `Cargo.lock` MUST be committed. Without
it, dependency versions resolve differently on each machine — unreproducible
builds, supply-chain exposure. This is the #1 Rust reproducibility rule for
binaries.

**Files:** `.gitignore`, `src-tauri/Cargo.lock`

---

## P1 — High Priority

Resolve before public release; acceptable for private beta without these.

### P1.1 — Remove `.unwrap()` in SSH IPC paths

- [x] `ssh_send` (`src-tauri/src/lib.rs:402`): replace `mgr.get_session(session_id).unwrap()`
      with `ok_or_else(|| "Session not found".to_string())?`
- [x] `ssh_resize` (`src-tauri/src/lib.rs:427`): same fix
- [x] Audit for any other `.unwrap()` / `.expect()` in non-test Rust code
      that could panic on runtime data

**Why:** A disconnect between `route_send` and `get_session` (no lock held
across them) panics the process — takes the whole app + all open sessions
down.

**Files:** `src-tauri/src/lib.rs`

### P1.2 — Remove `panic!` on config store init failure

- [x] `lib.rs:1084`: replace `panic!("Cannot continue without config store")`
      with an in-memory `ConfigStore` fallback (mirrors `HostStore::in_memory()`)
      or surface a fatal-error dialog

**Why:** A corrupted data dir or locked file crashes the app with no user
recourse.

**Files:** `src-tauri/src/lib.rs`, `src-tauri/src/config.rs`

### P1.3 — `open_url` command injection on Windows

- [x] `lib.rs:106`: `cmd /C start` with a crafted URL can execute arbitrary
      commands (URL content after `http(s)://` is unchecked for shell
      metacharacters)
- [x] Replace with `ShellExecuteW` via the `windows` crate, or use
      `tauri-plugin-shell` `open` API (avoids `cmd.exe` parsing entirely)

**Why:** `open_url_cmd` validates the `http(s)://` prefix but not the URL
content. A URL containing `&` or other shell metacharacters can chain
commands through `cmd.exe`.

**Files:** `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml`

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

### P2.1 — Host field input validation

- [x] Validate `hostname` (RFC 1123: letters, digits, hyphens, dots; reject
      control characters, whitespace, newlines)
- [x] Reject control characters in `username`, `display_name`
- [x] Cap string field lengths (hostname ≤253, display_name ≤128,
      username ≤128, notes ≤4096)
- [x] Validate `platform` is one of the known platform ids
- [x] Return validation errors to the frontend; surface in the host form

**Why:** `save_host` accepts arbitrary strings. Not exploitable via russh
(TCP connect fails), but the log file gets polluted and the UI may render
garbage.

**Files:** `src-tauri/src/hosts.rs`, `src/components/host-screen.ts`

### P2.2 — Known-hosts management UI

- [ ] Add a Settings → Known Hosts panel
- [ ] List entries from `known_hosts.json` (hostname:port, key type,
      fingerprint, first-seen date)
- [ ] Per-entry "Delete" button (revokes trust)
- [ ] "Clear all" button with confirmation
- [ ] Show full `SHA256:base64` fingerprint (see P2.3)

**Why:** TOFU is silent. Users cannot review, delete, or audit stored host
keys. A professional SSH client shows the known-hosts list and lets users
revoke trust.

**Files:** `src-tauri/src/ssh.rs`, `src-tauri/src/lib.rs`,
`src/components/settings-screen.ts`, `src/lib/tauri-api.ts`

### P2.3 — Full SSH fingerprint format

- [x] `ssh.rs:181`: replace `&key_b64[..16.min(key_b64.len())]` with the
      full base64 SHA-256 (43 chars, no truncation)
- [x] Verify format matches `ssh-keygen -lf` output: `SHA256:base64nopad`

**Why:** Standard SSH fingerprints are full base64 SHA-256, not first 16
chars. Security-conscious users comparing against `ssh-keyscan` /
`ssh-keygen` output see a mismatch and lose trust.

**Files:** `src-tauri/src/ssh.rs`

### P2.4 — Session reconnect and keep-alive UI feedback

- [x] Surface keepalive state via Tauri events (reconnecting / lost)
- [x] Add a "Reconnecting…" indicator in the terminal topbar
- [x] Add a manual "Reconnect" button on disconnected sessions
- [ ] Consider configurable keepalive interval / max in Settings

**Why:** After ~45s of network loss (keepalive_interval 15s × max 3), the
session dies silently. Pro users on flaky VPNs need visibility + a reconnect
action.

**Files:** `src-tauri/src/ssh.rs`, `src/components/terminal-view.ts`

### P2.5 — Max connections limit

- [x] Cap concurrent SSH sessions (suggest 20)
- [x] Surface a user-friendly error when the limit is reached
- [x] Optionally: make the limit configurable in Settings

**Why:** `SshManager` is an unbounded `HashMap`. 100 tabs = 100 SSH
sessions = unbounded memory + file descriptors + agent socket handles.

**Files:** `src-tauri/src/ssh.rs`, `src-tauri/src/lib.rs`

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
      `net.sh/{version} (SSH client; +https://net.sh)`
- [ ] Verify import still works against Cisco / F5 / Juniper docs (they
      block by bot-detection, not UA — spoofing buys nothing)

**Why:** Spoofing a browser UA is a policy concern (some TOS forbid it) and
looks unprofessional. Cisco/F5 block by bot-detection heuristics, not UA
string.

**Files:** `src-tauri/src/import.rs`

### P2.8 — Crash reporting / panic hook

- [x] Install a `std::panic::set_hook` that writes panics to `netsh.log`
      (currently only `log::error!` calls are captured, not actual panics)
- [ ] Optionally: add `tauri-plugin-log` for structured logging
- [ ] Optionally: opt-in Sentry integration (privacy-respecting, off by
      default, with a first-run consent prompt)

**Why:** No crash handler. A user's crash is invisible to you — the log file
doesn't capture panics, only explicit `log::error!` calls.

**Files:** `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml`

---

## P3 — Nice to Have

Improve professional polish; not blocking for any release.

### P3.1 — LICENSE file

- [ ] Add a `LICENSE` file in the repo root
- [ ] If open source: choose a license (MIT, Apache-2.0, or GPL)
- [ ] If closed source: state it explicitly
- [ ] Update `README.md` with license info

**Why:** Repo has `CONTRIBUTING.md` but no `LICENSE`. Legally ambiguous for
open source; should be explicit either way.

**Files:** `LICENSE`, `README.md`

### P3.2 — Window decorations audit

- [x] Verify the frontend has custom title-bar drag region + window controls
      (min / max / close)
- [x] If not: re-enable `decorations: true` in `tauri.conf.json`, or
      implement custom controls
- [ ] Test on Linux (Wayland + X11) — no OS controls without decorations

**Why:** `tauri.conf.json:21` sets `decorations: false`. If the frontend
doesn't provide custom controls, users on Linux can't move or close the
window without keyboard shortcuts.

**Files:** `src-tauri/tauri.conf.json`, `src/components/terminal-view.ts`
(or a new title-bar component)

### P3.3 — Data export / backup

- [x] Settings → Export: zip the app data dir (hosts, groups, config,
      known_hosts, user KB) to a user-chosen path
- [x] Settings → Import: unzip + restart the app
- [x] Confirm overwrite / merge behavior; warn on conflicts

**Why:** Users have hosts, groups, KB, known_hosts — all in JSON/YAML. No
backup / restore flow. A professional app lets users back up before a
reinstall or move between machines.

**Files:** `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml` (zip crate),
`src/components/settings-screen.ts`

### P3.4 — Multi-window support

- [ ] Allow "Open in new window" for a host
- [ ] Each window gets its own terminal session list
- [ ] Shared app state (hosts, config, KB) across windows

**Why:** Pro network engineers often want two terminals side-by-side on two
monitors. Tauri v2 supports multi-window. Larger effort — schedule for
post-1.0.

**Files:** `src-tauri/src/lib.rs`, `src/main.ts`, `src/components/`

### P3.5 — Accessibility audit

- [x] Add ARIA roles to interactive elements (buttons, dialogs, tabs)
- [x] Ensure keyboard focus indicators are visible on all controls
- [ ] Test with a screen reader (NVDA on Windows, VoiceOver on macOS) —
      manual pass required; checklist in `docs/accessibility.md`
- [x] Document a11y conformance level (target: WCAG 2.1 AA) — see
      `docs/accessibility.md`

**Why:** No ARIA roles, no documented focus indicators, no screen reader
testing. Professional apps need at least basic a11y for enterprise
procurement.

**Files:** All `src/components/*.ts`, `src/styles/`

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

1. **P0.3** (commit Cargo.lock) — trivial, do now
2. **P1.1 + P1.2 + P1.3** (robustness fixes) — small, independent, high value
3. **P0.1 + P0.2** (signing + CI) — do together; CI runs the signed builds
4. **P1.4** (updater) — depends on P0.1 signing keys
5. **P1.5** (distribution metadata) — parallel to P0.1/P0.2
6. **P2.1 → P2.8** — in priority order; each is independent
7. **P3.\*** — as time permits; P3.1 (LICENSE) is trivial and should not wait

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