# Plan: Multi-Session Tabs

Decisions (user-confirmed):
- One tab per host — connecting to a host with an open session switches to existing tab.
- Tab strip lives in terminal view only.
- Close confirmation always shown.

## 1. Backend (`src-tauri`) — enable concurrent sessions

- `src-tauri/src/ssh.rs` — `SshManager.session: Option<SshSession>` → `HashMap<u64, SshSession>`. Methods `insert`, `get`, `remove` by `session_id`.
- `src-tauri/src/lib.rs` commands:
  - `ssh_connect` — remove kill-existing-session block (`lib.rs:221-227`).
  - `ssh_send(session_id, data)`, `ssh_disconnect(session_id)`, `ssh_resize(session_id, cols, rows)` — look up session in map; unknown id → `Err("no such session")`.
  - Events already carry `session_id` in every payload — no change needed.

## 2. Frontend API (`src/lib/tauri-api.ts`)

- Add `sessionId` param to `sshSend`, `sshDisconnect`, `sshResize` (`sshConnect` already takes it).

## 3. `TerminalView` refactor — multi-instance capable (`src/components/terminal-view.ts`)

- Scope all DOM lookups: replace `document.getElementById(...)` / `document.querySelector(...)` with queries against a per-instance root element (template uses classes instead of IDs).
- Fix latent recreate gap: recreate `Terminal`/addons in `connect()` if disposed (currently `cleanup()` nulls the terminal and nothing rebuilds it).
- Delete kill-previous-session policy in `connect()` (`terminal-view.ts:451-460`) — App routes per-host now.
- `--chrome-tint`: applied on tab activation (follows active tab's mode).
- Window-level handlers (resize, Ctrl+W) stay global, delegate to active tab.

## 4. Tab manager (`src/main.ts`, App class)

- `tabs: Map<hostId, { host, view, wrapper }>`. One tab per host.
- `onConnect(host)`: existing tab → activate; else create wrapper + `TerminalView`, mount, activate.
- `activateTab(id)`: hide other wrappers, show active, `fit()` + `ssh_resize`, update strip, set `activeHost`.
- `closeTab(id)`: confirm modal → `ssh_disconnect(sessionId)` → dispose view, remove wrapper, activate neighbor; if no tabs left → Connections view.
- Tab strip: App-owned `.session-tab-bar` row at top of terminal area. Each tab: host name + `×`. Click = activate, `×` = close flow. Styles mirror existing `.app-tab-bar` / `.app-tab`.
- Confirm modal: reuse `.modal-backdrop` / `.delete-confirm` pattern verbatim (from `host-screen.ts:512-543`). Text: "Close session to \<host\>? Your SSH session will be terminated." Cancel / Close Session buttons; Escape + backdrop-click cancel.
- `Ctrl+Shift+W` (currently full-disconnect) → close active tab with confirm. `activeSessions` Set stays host-keyed — HostScreen green dots unchanged.
- Zoom shortcuts (`Ctrl+=/-/0`) → apply to active tab's view.
- Escape-to-hosts keeps sessions alive; tabs persist when returning to Connections.

## 5. Docs (rule change)

- `AGENTS.md` — remove "No multi-tab/multi-session (post-MVP)" from NOT-To-Do list.
- `docs/08-future-open-questions.md` — move multi-session out of backlog.
- `docs/07-keyboard-shortcuts.md` — `Ctrl+Shift+W` = close tab.

## 6. Verification

- `cargo check` + `cargo clippy` in `src-tauri`; `tsc --noEmit` + `vite build`.
- Manual smoke: 2 hosts → 2 tabs; switch preserves scrollback/state; `×` → confirm → terminate; cancel keeps session; Ctrl+Shift+W closes active tab.

## Skipped (add when asked)

- Tab cycling shortcut (Ctrl+Tab), drag-reorder, quit-with-sessions guard, per-tab unread-activity dots.
