# Plan: Phase 1 — Session Management

Phase 1 scope. Ordered by value; logging first (prerequisite for Phase 3 scripting hooks and Phase 6 agent layer).

Each item is independently shippable. Verify per AGENTS.md: `npm run build` (frontend), `cargo check` (Rust).

---

## Item 1 — Per-session logging to file (highest priority)

**Goal:** Every session writes a timestamped, human-readable transcript to disk. Enables audit + future agent layer.

**Decision: log in Rust, not frontend.** The backend already sees every byte of the SSH stream (`ssh-output` emit path in `ssh.rs`). Logging there captures raw output even for background tabs, avoids IPC echo, and keeps the frontend lean (AGENTS.md rule: no heavy logic in frontend that could be in Rust applies inversely — this is stream plumbing, backend's job).

### Steps (grouped)

**A. Log writer module (`src-tauri/src/session-log.rs` — new file)**
- `SessionLog` struct: `BufWriter<File>`, opened lazily on first output byte.
- File location: `<data_dir>/session-logs/<host>_<YYYYMMDD-HHMMSS>_<session_id>.log` (sanitize hostname for filename). Reuse `crate::paths::app_data_dir()`.
- Format: raw bytes as-received, plus optional header line (`# host, platform, started-at`) and periodic wall-clock timestamp lines. Ponytail ruling: **raw stream + header only**. Timestamps per line are what `timestamps.ts` already does in-view; for the file, a `[HH:MM:SS]` stamp prepended per write chunk (not per line) is 10 lines of code and good enough for audit. Decorate later if a consumer needs per-line precision.
- Flush policy: flush every write chunk (SSH chunks are small; correctness over throughput). `ponytail: sync flush per chunk; switch to flush-on-idle (200ms) if large-output sessions show measurable cost`.
- On disconnect: flush + drop (close file). No rotation — one file per session, cap total dir size later if asked.

**B. Wire into `ssh.rs`**
- `SshSession` (or the per-session struct in the `HashMap`) gains `Option<SessionLog>`.
- In the output-read loop (where `ssh-output` is emitted): feed bytes to `SessionLog` before/after emitting.
- Only log *output* bytes. Input echo comes back as output anyway (shadow buffer model — no local echo), so typed commands are already captured. No separate input logging.

**C. Config + commands (`config.rs`, `lib.rs`)**

Settings introduced — global only, no host overrides:

| Setting | Scope | Default | Where |
|---|---|---|---|
| `session_logging: bool` | global (AppConfig) | `true` | settings screen checkbox |
| `session_log_timestamps: bool` | global (AppConfig) | `true` | settings screen checkbox (only visible when logging on) |
| Log directory | fixed `<data_dir>/session-logs/` | — | "Open log folder" button only, not editable |

- **No per-host override.** Hosts already carry `platform`, `os_version`, `highlight_profile` — adding `session_logging` per host bloats the host form and the audit value is app-wide (you want *everything* logged, or off). If a "don't log this jump box" need appears, add a host-level `logging: "inherit"|"off"|"on"` tri-state then. YAGNI now.
- Toggle applies to *new* sessions; existing sessions keep their current behavior (simplest, matches "audit started when enabled").
- Tauri commands: `get_session_log_dir() -> String` (open-in-explorer button), `set_session_logging(enabled)`, `set_session_log_timestamps(enabled)`.

**Timestamps in the log file** — independent of the terminal gutter:
- Log timestamps and the in-view gutter (`netssh-timestamps` / `netssh-timestamps-format`) are **separate concerns**: the log is an audit record, the gutter is visual. A user may want timestamps in logs but a clean terminal. Own toggle: `session_log_timestamps: bool`.
- When on, each write chunk gets a `[HH:MM:SS]` wall-clock prefix (24h, fixed — log files are for parsing/audit, one canonical format; no 12h/ms options to configure). When off, raw stream only.
- Header line records ISO-8601 start time always. Terminal gutter behavior unchanged.

**D. Settings UI**
- Reuse existing settings screen pattern (see `plan-settings-layout-review.md` for structure). One checkbox + "Open log folder" button. No per-host toggle (YAGNI).

**E. Verify**
- `cargo check` + unit test in `session-log.rs`: write chunks → read file → assert content + header. Plus one test for filename sanitization.
- Manual: connect to mock server (`test_server.rs` exists), type, disconnect, inspect file.

**Skipped (add when asked):** per-host logging override (tri-state), custom log directory, per-line timestamps, log rotation/retention, log viewer UI in-app, redaction of secrets in output.

---

## Item 2 — Auto-reconnect with backoff

**Goal:** On `connection_lost` (unexpected drop only), retry automatically instead of requiring the Reconnect button click.

**Existing:** `showDisconnectBanner()` path in `terminal-view.ts` (reason `connection_lost`). Manual `reconnect()` works. `channel_closed`/`channel_eof` = clean end — must NOT auto-reconnect.

### Steps (grouped, frontend-only — all state machine lives here)

**A. Reconnect loop in `TerminalView`**
- New private state: `autoReconnectAttempt = 0`, `autoReconnectTimer`.
- In the `ssh-disconnected` handler, `isConnectionLost` branch: instead of only showing the banner, kick the loop.
- Backoff: 1s, 2s, 4s, 8s, 15s, 30s, then stop at **cap = 6 attempts (~60s total)**. Show banner with live status: "Reconnecting (attempt 3/6)… in 4s" + **Cancel button** (existing banner buttons: Reconnect becomes "Reconnect now", add "Give up" → back to hosts).
- Each attempt = existing `reconnect()` body (clear listeners, clear terminal, mint new session id, connect). Reuse it — do not fork a second connect path.
- User interaction cancels the loop: any manual Reconnect click, tab close, Escape-to-hosts, or keystroke after banner shows (they may be reading scrollback).

**B. Reset points**
- `ssh-connected` handler: reset attempt counter, hide banner.
- `disconnect()`/`cancelConnect()`: cancel pending timer.
- `cleanup()`: clear timer (existing teardown, one line).

**C. Config**
- No config for attempt count/backoff schedule (YAGNI — constants in one place). If a "always retry forever" user appears, add then.

**D. Verify**
- `npm run build`. Manual with mock server: kill server → banner + retries appear; restart server → reconnects; `exit` on device → no auto-retry (clean end path untouched).

**Skipped:** jitter on backoff (single-user desktop app), per-host reconnect policy, infinite retry.

---

## Item 3 — Scrollback search

**Goal:** Ctrl+Shift+F opens search over terminal scrollback. Smallest item — one addon + one small UI bar.

### Steps

**A. Dependency + load**
- `npm i @xterm/addon-search`. `SearchAddon` loaded in `initTerminal()` next to FitAddon (per-terminal instance, works with tabs for free).

**B. Search UI (`terminal-view.ts`)**
- **Toolbar button** in `.tv-topbar` next to the existing toggles (timestamps, theme, etc.): search icon from `src/lib/icons.ts`, `aria-label="Search scrollback"`, `aria-expanded` wired to bar visibility — same pattern as the Panel button. Mouse-discoverable counterpart to the shortcut.
- Small search bar overlay (top-right of `.tv-terminal-wrap`): input + match count + up/down buttons + close (Escape). Vanilla DOM, ~40 lines, styled in a new `styles/components/_terminal.css` block or existing terminal stylesheet.
- Behavior: Enter = next, Shift+Enter = previous, up/down buttons, `Escape` closes + focuses terminal. Live search on input (scrollback is in-memory; addon search is cheap).
- Keyboard wiring: in `attachCustomKeyEventHandler` — `Ctrl+Shift+F` keydown → open bar, `return false`. This is a *local* UI shortcut, not a remote keystroke — doesn't violate pass-through rules (Ctrl+F alone stays untouched; Ctrl+Shift+F is not a shell binding).
- Only wired for the **active tab's** terminal (each TerminalView handles its own).

**C. Verify**
- `npm run build`; manual: long scrollback, search wraps, highlight visible, works per-tab, Escape returns focus.

**Skipped:** regex mode, case-toggle (addon default case-insensitive is fine), search-across-tabs.

---

## Item 4 — Split panes: decide, probably don't build

Roadmap already flags this YAGNI candidate. Tabs shipped (`tab-state.ts`); panes are a layout engine (resize handles, focus routing, pane-aware fit/resize PTY) for marginal gain over tabs in a keyboard-first app.

**Plan = one decision, zero code:**
- Mark roadmap item as resolved-won't-build (or ⬜ deferred) with note "tabs suffice; revisit if users ask".
- If revisited later, it needs a full plan doc first (fit addon per-pane, `ssh_resize` per pane, focus routing, pane nav shortcuts — roughly a Phase-2-sized effort).

---

## Suggested shipping order

1. **Item 1** (logging) — unlocks Phase 3/3 scripting + Phase 6.
2. **Item 3** (scrollback search) — small, independent, quick win.
3. **Item 2** (auto-reconnect) — frontend-only, moderate.
4. **Item 4** — roadmap note only.

Check items off here as each lands.