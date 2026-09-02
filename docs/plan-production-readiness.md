# Plan: Production Readiness — Phase 1 (Complete)

Tracking document for gaps identified in the productization review of
netssh. Derived from a full codebase audit (Rust backend + TS frontend +
Tauri config + build/release infra).

**Goal:** Move netssh from a solid MVP to a professional, shippable desktop
application. Focus is on robustness, security, storage, permissions, and
release infrastructure — not new user-facing features.

**Status:** Phase 1 complete. All items below verified against code
(2026-08-29: `cargo check` exit 0, `npm run build` exit 0). Outstanding
work continues in Phase 2, split into two tracks:
`plan-production-readiness-phase2a-no-signing.md` (no signing — do now) and
`plan-production-readiness-phase2b-code-signing.md` (code signing — deferred).

**Status legend:** `[x]` done · sub-items not completed in this phase are
tracked in the Phase 2A / 2B docs

---

## P0 — Ship Blockers

These must be resolved before any public release.

### P0.3 — Commit `Cargo.lock`

- [x] Remove `src-tauri/Cargo.lock` (or `Cargo.lock`) from `.gitignore`
- [x] `git add src-tauri/Cargo.lock` and commit
- [x] Verify `cargo build` is reproducible across machines

**Why:** For a binary application, `Cargo.lock` MUST be committed. Without
it, dependency versions resolve differently on each machine — unreproducible
builds, supply-chain exposure. This is the #1 Rust reproducibility rule for
binaries.

**Files:** `.gitignore`, `src-tauri/Cargo.lock`

*P0.1 (code signing) and P0.2 (CI/CD) were not started in Phase 1 — the CI
test gate + unsigned builds (P0.2a) are in the Phase 2A doc; code signing and
the signed release build (P0.1, P0.2b) are in the Phase 2B doc.*

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

*Audit result: remaining non-test `.unwrap()`/`.expect()` calls are benign —
constant-string parses (`import.rs`), compile-time path fallback and standard
Tauri boilerplate (`lib.rs`), and the dev-only mock SSH server
(`test_server.rs`, reachable only via the explicit test command).*

### P1.2 — Remove `panic!` on config store init failure

- [x] `lib.rs:1084`: replace `panic!("Cannot continue without config store")`
      with an in-memory `ConfigStore` fallback (mirrors `HostStore::in_memory()`)
      or surface a fatal-error dialog

**Why:** A corrupted data dir or locked file crashes the app with no user
recourse.

**Files:** `src-tauri/src/lib.rs`, `src-tauri/src/config.rs`

*Implemented as a 3-stage fallback: real store → `config.json` in the app
data dir → in-memory store with an error log.*

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

*Implemented with direct process spawn (`explorer.exe <url>` / `open` /
`xdg-open`) — no `cmd.exe` in the path, so there is no shell to inject
into. Scheme allowlist + control-character rejection kept as defense in
depth.*

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

**Why:** After ~45s of network loss (keepalive_interval 15s × max 3), the
session dies silently. Pro users on flaky VPNs need visibility + a reconnect
action.

**Files:** `src-tauri/src/ssh.rs`, `src/components/terminal-view.ts`

*One sub-item remains — configurable keepalive interval / max in Settings —
tracked in the Phase 2A doc.*

### P2.5 — Max connections limit

- [x] Cap concurrent SSH sessions (suggest 20)
- [x] Surface a user-friendly error when the limit is reached
- [x] Optionally: make the limit configurable in Settings

**Why:** `SshManager` is an unbounded `HashMap`. 100 tabs = 100 SSH
sessions = unbounded memory + file descriptors + agent socket handles.

**Files:** `src-tauri/src/ssh.rs`, `src-tauri/src/lib.rs`

*Shipped with default 30 (configurable, 0 = unlimited) and a Settings
dropdown.*

### P2.8 — Crash reporting / panic hook

- [x] Install a `std::panic::set_hook` that writes panics to `netssh.log`
      (currently only `log::error!` calls are captured, not actual panics)

**Why:** No crash handler. A user's crash is invisible to you — the log file
doesn't capture panics, only explicit `log::error!` calls.

**Files:** `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml`

*Two optional sub-items remain (`tauri-plugin-log`, opt-in Sentry) — tracked
in the Phase 2A doc.*

---

## P3 — Nice to Have

Improve professional polish; not blocking for any release.

### P3.2 — Window decorations audit

- [x] Verify the frontend has custom title-bar drag region + window controls
      (min / max / close)
- [x] If not: re-enable `decorations: true` in `tauri.conf.json`, or
      implement custom controls

**Why:** `tauri.conf.json:21` sets `decorations: false`. If the frontend
doesn't provide custom controls, users on Linux can't move or close the
window without keyboard shortcuts.

**Files:** `src-tauri/tauri.conf.json`, `src/components/terminal-view.ts`
(or a new title-bar component)

*Verified present: CSS `-webkit-app-region: drag` title bar with `no-drag`
overrides on controls, and JS min/max/close via `getCurrentWindow()`. One
sub-item remains — Linux (Wayland + X11) manual test — tracked in the Phase
2A doc.*

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

*Import uses a two-step merge: conflict scan first, then apply with a
per-item keep-current / use-backup resolution dialog.*

### P3.5 — Accessibility audit

- [x] Add ARIA roles to interactive elements (buttons, dialogs, tabs)
- [x] Ensure keyboard focus indicators are visible on all controls
- [x] Document a11y conformance level (target: WCAG 2.1 AA) — see
      `docs/accessibility.md`

**Why:** No ARIA roles, no documented focus indicators, no screen reader
testing. Professional apps need at least basic a11y for enterprise
procurement.

**Files:** All `src/components/*.ts`, `src/styles/`

*One sub-item remains — manual screen-reader pass (NVDA / VoiceOver) —
tracked in the Phase 2A doc.*

---

## Verification

How this phase was verified:

- Frontend: `npm run build` (runs `tsc`) — exit 0
- Rust: `cargo check` in `src-tauri/` — exit 0
- Each item re-read against the actual implementation (file + line level),
  not just the checkbox

## Out of Scope

- Encrypting `hosts.json` at rest (keychain handles secrets; host metadata
  is not secret enough to justify key-management surface)
- SQLite / SQLCipher migration (flat JSON is fine at current scale)
- OpenSSH `~/.ssh/known_hosts` interop (separate future task)
- Log rotation (size cap already in place; full rotation is a separate task)
- Windows ACL tightening beyond parent-dir inheritance (YAGNI while
  everything lives under `app_local_data_dir`)
