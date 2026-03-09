# Stage 06 — SSH Connection (Rust)

**Goal:** Implement the full SSH connection lifecycle in Rust using `russh` — connect, authenticate, allocate PTY, stream data bidirectionally via Tauri events, handle disconnects, and manage known hosts (TOFU).

**Spec refs:** `docs/02-technical-architecture.md` (SSH section, error handling, TOFU, keepalive), `docs/04-connection-manager.md` (connecting state, auth types)

---

## Why This Stage

This is the most complex single component in the app. SSH is core functionality — everything from terminal display to prompt detection to suggestions depends on a working SSH data stream. No other stage can deliver a meaningful user experience without this.

---

## Steps

### 1. Implement the `russh` client handler

In `src-tauri/src/ssh.rs`, implement the `russh::client::Handler` trait:

- `check_server_key()` — TOFU (Trust On First Use) model:
  - Load known hosts from `{data_dir}/netsh/known_hosts.json`
  - If host not seen: accept key, save to known hosts file, return `true`
  - If host seen and key matches: return `true`
  - If host seen and key CHANGED: reject connection, return error with clear warning message (spec: "Host key has changed" UX scenario)
- `auth_banner()` — store banner text, emit to frontend if present
- `channel_open_confirmation()` — mark channel as ready
- `data()` — forward SSH output data to frontend via Tauri event

### 2. Implement connection establishment

Create an `SshSession` struct managing the lifecycle:

- `connect(hostname: &str, port: u16, username: &str) -> Result<(), String>`
  - Create `russh::client::Config` with sensible defaults (keepalive interval: 15s, connection timeout: 10s)
  - Call `russh::client::connect()` with the config + handler
  - Handle connection timeout (spec: 10s default)
  - Handle DNS resolution failure
  - Handle TCP connection refused

### 3. Implement authentication

Support two auth methods per spec:

- **Password auth**: `session.authenticate_password(username, password)`
  - Handle auth failure (spec: "Authentication failed" UX — allow retry, don't disconnect)
- **Keyboard-interactive auth**: `session.authenticate_keyboard_interactive(username)`
  - Implement `check_server_key` prompt handling for challenge/response
  - Forward prompts to frontend for user to answer (emit Tauri event with prompt text)
  - Receive response from frontend (Tauri command) and continue auth flow
- **SSH key auth**: `session.authenticate_publickey(username, key)`
  - Load key from path specified in host config
  - Use `russh_keys::load_secret_key()` — handle passphrase-protected keys by prompting user
- Handle the "unrecognised challenge" scenario from spec (fallback to password if keyboard-interactive sends unexpected prompts)

### 4. Implement PTY allocation and shell

After successful auth:

- Open a channel: `session.channel_open_session()`
- Request PTY: `channel.request_pty(false, "xterm-256color", cols, rows, 0, 0, &[])` — cols/rows from frontend terminal dimensions
- Request shell: `channel.request_shell(false)`
- The session is now live — data flows bidirectionally

### 5. Implement data streaming via Tauri events

This is the critical data path — must be efficient:

- **SSH → Frontend (output)**: In the handler's `data()` callback, emit a Tauri event: `app.emit("ssh-output", payload)` where payload is the raw bytes (base64-encoded or as a Vec<u8>)
- **Frontend → SSH (input)**: Tauri command `ssh_send(data: String)` writes to the SSH channel: `channel.data(data.as_bytes())`
- **Lifecycle events**: Emit events for connection state changes:
  - `ssh-connected` — auth successful, shell ready
  - `ssh-disconnected` — connection closed (with reason)
  - `ssh-error` — error occurred (with message)
  - `ssh-auth-prompt` — keyboard-interactive prompt needs response

### 6. Implement PTY resize

- New Tauri command: `ssh_resize(cols: u32, rows: u32)`
- Calls `channel.window_change(cols, rows, 0, 0)` on the active channel
- Frontend calls this when terminal or sidebar resizes

### 7. Implement keepalive and disconnect detection

Per spec:

- Send keepalive packets every 15 seconds via `russh` config `keepalive_interval`
- If no data received for 30 seconds + 3 missed keepalives → consider connection dead
- On mid-session disconnect: emit `ssh-disconnected` event with `reason: "connection_lost"`
- Frontend will show reconnect option (wired in Stage 07/11)

### 8. Implement connection state management

The SSH module needs to manage active sessions:

- Use `tauri::State<Mutex<Option<SshSession>>>` for the active session (single-session MVP)
- `ssh_connect` command: create session, store in state
- `ssh_send` command: get session from state, write data
- `ssh_disconnect` command: close channel and session, clear state
- `ssh_resize` command: get session from state, resize PTY
- Handle concurrent access safely — all commands are async

### 9. Implement known hosts file

- Store in `{data_dir}/netsh/known_hosts.json`
- Schema: `{ "hostname:port": { "key_type": "ssh-ed25519", "key_base64": "...", "first_seen": "ISO8601" } }`
- Load on connect, save after accepting new key
- Handle file corruption gracefully

### 10. Wire up Tauri commands

Update `src-tauri/src/lib.rs`:

- Replace stub `ssh_connect` with real implementation — params: `hostname`, `port`, `username`, `password` (optional), `key_path` (optional), `cols`, `rows`
- Replace stub `ssh_send` with real implementation — param: `data: String`
- Replace stub `ssh_disconnect` with real implementation
- Add `ssh_resize` — params: `cols`, `rows`
- Add `ssh_auth_response` — param: `response: String` (for keyboard-interactive)
- Register all events in Tauri app builder

---

## Files Modified

| File | Changes |
|------|---------|
| `src-tauri/src/ssh.rs` | Full implementation: Handler, SshSession, connect, auth, data streaming, resize, keepalive |
| `src-tauri/src/lib.rs` | Replace SSH stubs, add new commands, add SSH state management, register events |
| `src-tauri/Cargo.toml` | Add `base64` crate if needed for data encoding, `chrono` for timestamps |
| `src/lib/tauri-api.ts` | Add `sshConnect()`, `sshSend()`, `sshDisconnect()`, `sshResize()`, `sshAuthResponse()` typed wrappers + event listener types |

## Files Created

None — `ssh.rs` exists (currently empty).

---

## Verification

1. `cargo test` — SSH module unit tests pass (connection state management, known hosts file)
2. `cargo tauri dev` → DevTools console:
   - Call `sshConnect({ hostname: "<real-ios-xe-host>", port: 22, username: "admin", password: "***", cols: 80, rows: 24 })`
   - Listen for `ssh-connected` event → should fire on successful auth
   - Listen for `ssh-output` event → should receive device banner / MOTD / prompt
   - Call `sshSend({ data: "show version\r\n" })` → `ssh-output` events contain command output
   - Call `sshDisconnect()` → `ssh-disconnected` event fires
3. **Auth failure test**: Connect with wrong password → error returned, no crash, can retry
4. **Known hosts**: First connection asks to trust → check `known_hosts.json` created → second connection auto-trusts
5. **Resize**: Call `sshResize({ cols: 120, rows: 40 })` during active session → no error
6. **Disconnect detection**: Disconnect network briefly → `ssh-disconnected` event fires within ~45s
7. **PTY**: Output should have proper formatting (no raw escape codes from missing PTY)

---

## Technical Notes

- `russh` is async and uses `tokio` — all SSH operations run on the Tauri async runtime
- The `Handler` trait methods are called from the SSH read loop — they must not block
- Data events may arrive as partial chunks — the frontend (xterm.js) handles reassembly
- Consider using `tokio::sync::mpsc` channels internally to bridge between the handler callbacks and the Tauri event emitter
- The `Mutex<Option<SshSession>>` pattern needs careful deadlock avoidance — don't hold the lock across await points

---

## Definition of Done

The app can establish a real SSH connection to a network device, authenticate (password or key), allocate a PTY, stream data bidirectionally via Tauri events, handle resize, and detect disconnects. Known hosts are persisted and verified on reconnect.
