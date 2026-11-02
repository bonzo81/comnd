# 013. Concurrent sessions to one host: live tabs are keyed by session id

Date: 2026-10-30
Status: Accepted

## Context
Issue #67 asked for more than one live session to the same host entry. Before the change `src/main.ts` held `tabs: Map<string, SessionTab>` keyed by `host.id`, and `onConnect` short-circuited to the existing tab, so a second connect could not start a session. Everything else was already per-session: `src/components/terminal-view.ts` owns the channel, shadow buffer, line tracker, suggestion controller, ghost text and dropdown, so one view per session is independent by construction; `src-tauri/src/ssh.rs` already counts `mgr.session_count()` against `max_sessions`; `src-tauri/src/session_log.rs` already names files `<host>_<ts>_<session_id>.log`, so distinct session ids give distinct logs with no backend change. Keyboard-first rules (`docs/specs/07-keyboard-shortcuts.md`) and the WCAG 2.1 AA target (`docs/specs/accessibility.md`) mean the connect prompt has to be a real dialog: accessible name, focus trap, Esc cancels.

## Options
- **Keep host-id keying and refuse a second session.** Cost: issue #67 stays open; two commands on one device are impossible; tab identity stays coupled to the host, so every future per-session feature has to fight the map.
- **Key tabs by session id, minting the transport id per connect.** Cost: two identity spaces to keep apart (tab key vs transport session id), `activeSessions` must stay host-id based for `host-screen`/`nav-panel`, and every lifecycle site (`activateTab`, `closeTab`, `removeSessionTab`, `onSessionDied`, tab bar, status bar) has to be re-keyed.
- **Open a second session silently, with no prompt.** Cost: a double-clicked host yields two sessions and two log files unasked; there is nothing to remember, and no place for the at-limit branch.

## Decision
Live tabs are keyed by session id, not host id. A connect to an already-connected host resolves `AppConfig.duplicate_session_policy` — `ask` | `allow` | `focus`, default `ask` through `#[serde(default = "default_duplicate_session_policy")]` so existing config files keep working. `ask` shows the duplicate-session dialog naming the device, `allow` opens another session, `focus` switches to the running one; "Remember my choice" persists `allow`/`focus` and a cancel is never remembered. When `max_sessions` is reached (`0` = unlimited) the dialog offers no second session — only "Go to existing session" and "Cancel". An unreadable config makes the limit *unknown* rather than unlimited (`number | null`, resolved by `resolveSessionLimit` in `src/lib/duplicate-session.ts`), which reaches the same two-button state with copy that names the reason it could not check and no number (#82). Duplicate tabs show the identical host display name, with the "session i of n" discriminator in the tab's `aria-label` rather than the visible label.

## Consequences
- Easier: independent PTY, shadow buffer, suggestion state and session log per session with no Rust change; the tab key survives a reconnect while `SessionChannel` mints a fresh transport id; the connect flow stays in the frontend.
- Harder: two identity spaces in `main.ts` — the tab key (session id) and the host id behind `activeSessions`; the limit must count *live* sessions (`isLiveSession`/`countLiveSessions`), not tabs, or a failed-connection Retry tab wrongly hides "Open another session"; a surface that writes `AppConfig` must trigger `SettingsScreen.reloadConfig()`, because that screen caches the snapshot; an unreadable config used to fall back to offering a session the backend would then reject, which is now closed by the unknown-limit state above.
- Rules out: keying any tab, lookup or close path by `host.id`; visible ` (2)`-style suffixes on duplicate tab labels; remembering a cancel.
