# Technical Architecture

## Process Model

Tauri v2 runs two layers:

* **Rust backend** — manages SSH connections (byte pipe), credential access (OS keychain), KB loading/indexing, and file I/O. Exposes async Tauri commands for the frontend.
* **Web frontend** (rendered in OS webview) — terminal UI (xterm.js), input handling, shadow buffer, suggestion rendering, connection manager, sidebar

Communication between frontend and backend via Tauri v2's IPC command system (typed, async). Keystrokes are handled in the frontend for zero-latency input; KB queries go async to Rust.

## SSH Connection Management

* **Library:** `russh` (pure Rust SSH2 implementation) — no dependency on system `ssh` binary
* **YAML parsing:** `serde_yml` (successor to deprecated `serde_yaml`)
* **Platform paths:** `dirs` crate for resolving OS-appropriate config/data directories
* **Host key verification:** First-connect trust-on-first-use (TOFU) model. Known hosts stored in app data directory. User prompted on first connect and on key change (with clear MITM warning)
* **Authentication flow:**
  * Uses the method configured per saved host (password or SSH key). Hosts store a `credential` source enum: `Password` (OS keychain entry keyed by host id) or `SshKey` (local key file path); `Agent` and `SecretRef` variants are planned. Legacy `auth_type`/`ssh_key_path` fields in hosts.json are read-compat only — synthesized into `credential` on load, never re-serialized.
  * **Credential resolution is Rust-side.** `ssh_connect(host_id, cols, rows, session_id)` loads the host from the store and resolves the secret inside Rust before authenticating — passwords never enter the webview or IPC payloads. The frontend sends only the host id.
  * **Keyboard-interactive auth** supported — many network devices (Cisco, F5) use this instead of simple password auth. The app handles challenge/response prompts and passes the stored password.
  * **Interactive auth (issue #12):** a host saved with password auth but no stored password (regular or NetBox-imported alike) authenticates in the terminal, not the overlay. `ssh_connect` computes the gate backend-side (`needs_interactive_auth`) and emits `ssh-auth-interactive`; auth-phase output (banner, prompts) streams into the real xterm.js terminal. The user answers by typing: keystrokes are assembled in the frontend (`AuthInputCollector`) and submitted once per round via `ssh_auth_respond` — the bounded ADR-002 auth-phase exception. Enter submits the round, Ctrl+C cancels the connect, and the 120s auth timeout keeps running. Typed answers go straight to russh — never logged, transcribed, or persisted; only prompt text reaches the session log. A URL round (browser-auth gateway) restores the overlay with its "Open login page" button.
  * **Client-side password fallback:** the `password` method is single-shot — the server never prompts. When an armed session meets a server that refuses keyboard-interactive without any round (Linux with `KbdInteractiveAuthentication no`), the client synthesizes `user@host's password: ` in the terminal — exactly like the OpenSSH CLI — and fires the typed answer as one password attempt, up to three (mirroring `ssh`).
  * **Key formats:** OpenSSH and PEM (via `russh`). PKCS#8 support post-MVP if needed.
  * **Passphrase-protected keys:** user prompted at connect time. Passphrase optionally stored in OS keychain.
* **Connection lifecycle:**
  * Connect → authenticate → open PTY channel → begin streaming I/O
  * Heartbeat keepalive packets sent to prevent idle disconnects
  * On network drop: detect via read timeout, show "Disconnected" overlay with reconnect button
  * On intentional disconnect (user closes session or types `exit`): clean channel/session teardown
* **SSH agent forwarding:** Not in MVP. Post-MVP consideration.
* **Terminal size negotiation:** Initial terminal dimensions sent on channel open. On window resize (including sidebar open/close), a PTY resize request is sent to the remote host so output reformats correctly.

## Connection Error Handling

| Scenario | User experience |
|----------|-----------------|
| Auth failure (wrong password / rejected key) | Error banner with reason. "Retry" button. Connection manager stays accessible. |
| Host unreachable (timeout) | "Connection timed out" overlay after configurable timeout (default 10s). Retry button. |
| Host key changed (potential MITM) | **Blocking warning** — "Host key has changed. This could indicate a man-in-the-middle attack." User must explicitly accept the new key or abort. Old key shown for comparison. |
| Connection drops mid-session | "Disconnected" overlay with reconnect button. Terminal frozen (no input accepted). Last output preserved. |
| Keyboard-interactive challenge unrecognised | Fall back to prompting user for input in a dialog box. |
| Auth-phase prompt cancelled (Ctrl+C) or auth timeout (120s) | Connect aborts cleanly; no half-open session. |

## Keystroke Flow & Input Interception

This is the core technical challenge. The app must observe user input to power suggestions while the remote device handles all actual echo and editing.

**Key principle: shadow buffer model.** The app does NOT do local echo. All keystrokes are sent to the remote device in real time — the remote handles echo, line editing, and history. The frontend maintains a **shadow buffer** that mirrors what the user is typing, used solely for suggestion matching. The ghost text is an overlay rendered on top of the remote echo.

**Architecture:**

```
┌──────────────────────────────────────────────────────┐
│  Frontend (xterm.js + JavaScript)                    │
│                                                      │
│  xterm.js onKey                                      │
│    ├→ update shadow buffer (local, for suggestions)  │
│    ├→ send keystroke to Rust backend (IPC) → SSH     │
│    └→ query KB via Rust (async) → render ghost text  │
│                                                      │
│  xterm.js onData (from SSH)                          │
│    ├→ write to terminal (remote echo + output)       │
│    └→ prompt detector (ANSI-strip → idle → regex)    │
│           └→ updates current mode                    │
└──────────────┬───────────────────────────────────────┘
               │ IPC (Tauri commands)
┌──────────────▼───────────────────────────────────────┐
│  Rust Backend                                        │
│                                                      │
│  SSH channel (russh) ←→ raw byte stream              │
│  KB index (in-memory, loaded per platform on connect)│
│  KB query API → returns matches for shadow buffer    │
│  Credential manager (OS keychain via platform APIs)  │
│  Config / host storage (JSON in app data dir)        │
└──────────────────────────────────────────────────────┘
```

**How it works:**


1. **xterm.js captures all keystrokes** via `onKey` handler. Each keystroke is:
   * Added to the local shadow buffer (JavaScript, zero latency)
   * Forwarded to the Rust backend via IPC, which writes it to the SSH channel immediately
   * The remote device echoes the character back — xterm.js displays the echo as normal
2. **The shadow buffer** tracks the current input line as the user types. It:
   * Appends printable characters
   * Handles backspace/delete (mirrors what the remote will do)
   * Resets on Enter (new command line)
   * Resets when a new prompt is detected (output from remote command has finished)
3. **On each shadow buffer change**, the KB is queried asynchronously via a Tauri command:
   * Buffer contents matched against KB for current platform + version + mode
   * Top match returned → rendered as ghost text overlay in xterm.js (dimmed, after cursor)
   * Full match list cached for Ctrl+Space dropdown
4. **On Tab (suggestion accept)**: if ghost text is showing, the ghost text completion is:
   * Written to the shadow buffer
   * Sent to the SSH channel as a string (as if the user typed it rapidly)
   * The remote device echoes it — xterm.js displays the completed command
   * If NO ghost text is showing, Tab is passed through to the remote device for native tab-completion
5. **On Enter**: keystroke sent to remote, shadow buffer reset. Remote executes the command and sends output.
6. **Pass-through keys**: these go straight to the SSH channel and update the shadow buffer as appropriate:
   * `Ctrl+C` (interrupt) — also clears shadow buffer
   * `Ctrl+Z` (suspend) — clears shadow buffer
   * `Ctrl+D` (EOF)
   * Arrow keys when dropdown is NOT open (remote history navigation — shadow buffer resets since we can't track remote history)
7. **Paste handling**: pasted text is sent to the SSH channel and added to shadow buffer in full. Suggestion engine runs against the final buffer state.

**Edge cases:**

* **Interactive commands** (e.g. `more`, `vi`, `top`): When the prompt detector identifies a non-prompt interactive context (rapid output with no idle gap, or unrecognised output patterns), the app enters **raw pass-through mode** — shadow buffer and suggestions disabled until next prompt is detected
* **Remote tab-completion output**: When the remote device responds to Tab with completion options (multi-line output), the prompt detector treats this as command output. Shadow buffer resets on next detected prompt.
* **Multi-line input**: Not supported in MVP — shadow buffer is single-line, reset on Enter
* **Cisco** `**?**` **key**: Sends `?` to remote immediately (pass-through), remote displays help. Shadow buffer keeps the text before `?` so suggestions resume after help output.

## Prompt Detection

Prompt detection powers both mode awareness and the shadow buffer reset. It operates on the SSH output stream using a state machine:


1. **ANSI stripping** — all escape sequences are stripped from the output stream before analysis
2. **Idle detection** — a prompt is characterised by output that ends without a newline, followed by an idle gap (no new bytes for 200ms). This distinguishes a prompt from mid-output pauses.
3. **Regex matching** — the idle trailing text is matched against `prompt_patterns` from the active platform's `index.yaml`
4. **Mode update** — if a pattern matches, the current mode is updated and the shadow buffer is reset (ready for new input)

If no pattern matches after an idle gap, mode remains unchanged (assumed same context). If no prompt is detected for an extended period (e.g. during `vi` or `more`), raw pass-through mode is activated.

## KB Loading & Performance

* The KB for the active platform is loaded into an in-memory index when a connection is established (not per-keystroke)
* YAML files are parsed once via `serde_yml` into Rust structs, then indexed for prefix matching
* For 4 platforms × \~500 commands each, initial load is sub-50ms — not a concern
* The in-memory index supports fast prefix search (trie or sorted vec with binary search — implementation detail)

## Data Storage

| Data | Location | Format |
|------|----------|--------|
| Saved hosts (non-secret fields) | App data directory (`~/.local/share/com.netssh.app/` on Linux, `%LOCALAPPDATA%\com.netssh.app\` on Windows, `~/Library/Application Support/com.netssh.app/` on macOS) | JSON   |
| Credentials (passwords, key passphrases) | OS keychain (libsecret on Linux, Keychain on macOS, Credential Manager on Windows) | Managed by OS |
| SSH private keys | User's filesystem — referenced by path only | Not copied |
| Known hosts | App data directory | JSON   |
| Knowledge base | Bundled with app in install directory, user-editable copy in app data directory | YAML   |
| User preferences | App data directory | JSON   |
| Session logs (opt-in; off by default) | `<data_dir>/session-logs/` by default, or the configured session-log directory | One `.log` file per session; header, optional per-chunk timestamps, and raw remote output. Raw output can contain secrets, so logs are not created unless the user enables session logging. |
