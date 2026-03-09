# Stage 07 — Terminal ↔ SSH Integration

**Goal:** Wire xterm.js to the SSH data stream — keystrokes go to the remote device, remote output renders in the terminal, PTY resizes on layout changes, and the connecting/disconnected states are shown in the UI.

**Spec refs:** `docs/02-technical-architecture.md` (keystroke flow, pass-through keys), `docs/03-ui-visual-design.md` (connecting state, terminal layout, status bar), `docs/07-keyboard-shortcuts.md` (terminal pass-through)

---

## Why This Stage

This is where the app becomes a working SSH client. Stages 02-06 built the pieces; this stage wires them together. After this stage, a user can connect to a device and interact with it like any terminal — before suggestions or prompt detection are added.

---

## Steps

### 1. Wire SSH output → xterm.js

In `src/components/terminal-view.ts`:

- Import `listen` from `@tauri-apps/api/event`
- On connect: register listener for `ssh-output` event
- Decode the data payload (base64 → Uint8Array if bytes, or direct string)
- Write to xterm.js: `terminal.write(data)`
- On disconnect: unregister the listener

### 2. Wire keystroke input → SSH

Replace the current placeholder `onKey` / `onData` handler in `terminal-view.ts`:

- Use `terminal.onData()` (handles all input including paste, IME, special keys)
- On each input event: call `sshSend({ data })` from `tauri-api.ts`
- Do NOT write to the terminal locally — the remote echo will come back via `ssh-output`
- This is the **shadow buffer model**: no local echo, remote is authoritative

### 3. Implement the connect flow

When the user selects a host and presses Connect (from Stage 05):

- Receive host data (hostname, port, username, platform, auth_type, etc.)
- Switch to terminal view
- Show connecting overlay (see step 5)
- Retrieve credential: `getCredential(hostId)` if auth type is password
- Call `sshConnect()` with all connection parameters including current terminal dimensions
- Listen for events:
  - `ssh-connected` → dismiss overlay, focus terminal, update status bar
  - `ssh-error` → show error in overlay with retry/back options
  - `ssh-auth-prompt` → show prompt UI for keyboard-interactive response
  - `ssh-disconnected` → show disconnected state

### 4. Update the terminal top bar

Per `docs/03-ui-visual-design.md`:

- **Back button** (left): returns to connection manager (calls `sshDisconnect()` first if connected)
- **Host info** (center): display name + hostname
- **Panel toggle** (right): toggles the sidebar (already partially implemented)

### 5. Implement connecting overlay

Per `docs/03-ui-visual-design.md` connecting state:

- Semi-transparent overlay on top of the terminal area
- 5-stage progress display:
  1. "Resolving hostname…"
  2. "Connecting to {host}:{port}…"
  3. "Authenticating…"
  4. "Starting session…"
  5. "Ready"
- Map SSH events to stages (approximate — we may not get granular events for all 5)
- Show a **Cancel** button that calls `sshDisconnect()` and returns to connection manager
- On error: show error message with "Retry" and "Back" buttons
- Animate: subtle spinner or dots (CSS animation only, no JS)

### 6. Implement disconnected state

When `ssh-disconnected` event fires:

- Show a banner/overlay: "Connection lost" with reason (if available)
- Options: "Reconnect" (retry with same host) and "Back to hosts" (return to connection manager)
- If clean disconnect (user clicked Back): go straight to connection manager, no banner

### 7. Handle PTY resize

- On terminal resize (FitAddon recalculates dimensions): call `sshResize({ cols, rows })`
- Trigger resize when:
  - Window resizes → `window.addEventListener('resize', ...)` → `fitAddon.fit()` → get new dimensions → `sshResize()`
  - Sidebar opens/closes → after sidebar transition → `fitAddon.fit()` → `sshResize()`
- Use `terminal.onResize()` event from xterm.js to get the new cols/rows after `fit()`

### 8. Update status bar with real data

Per `docs/03-ui-visual-design.md` status bar:

- **Connection indicator**: green dot when connected, red when disconnected / amber when connecting
- **Host**: hostname or IP
- **Platform**: from host config (e.g. "Cisco IOS-XE")
- **Mode**: placeholder "—" for now (real mode detection comes in Stage 08)
- **Latency**: placeholder "—" for now (could measure round-trip on keepalive responses later)

### 9. Handle pass-through keys

Per `docs/02-technical-architecture.md` and `docs/07-keyboard-shortcuts.md`:

- `Ctrl+C`, `Ctrl+Z`, `Ctrl+D`: always send to remote (xterm.js `onData` handles this automatically)
- `Ctrl+W`: MUST pass through to remote (delete-word). Prevent browser default (close tab). Add `window.addEventListener('keydown', ...)` for Ctrl+W and call `e.preventDefault()` when terminal is focused
- `Tab`: for now, always send to remote (suggestion interception comes in Stage 09)
- Arrow keys: for now, always send to remote

### 10. Clean up terminal on disconnect/back

When navigating away from terminal view:

- Call `sshDisconnect()` if session active
- Unregister all event listeners (`ssh-output`, `ssh-disconnected`, etc.)
- Dispose xterm.js terminal + addons
- Reset terminal view state for next connection

---

## Files Modified

| File | Changes |
|------|---------|
| `src/components/terminal-view.ts` | Major rewrite: SSH event wiring, connect flow, overlays, resize, status bar |
| `src/styles/main.css` | Add connecting overlay, disconnected banner, status bar states |
| `src/main.ts` | Pass full host data through connect callback (not just a flag) |
| `src/lib/tauri-api.ts` | Add event listener helpers if needed (typed `listen()` wrappers) |

## Files Created

None.

---

## Verification

1. `cargo tauri dev` — app launches to connection manager
2. **Connect**: Select a host (from Stage 05) → press Enter → connecting overlay shows with progress stages
3. **Authentication**: Overlay transitions from "Connecting…" to "Authenticating…" to "Ready" → overlay dismisses
4. **Terminal output**: Device banner/MOTD appears in xterm.js → prompt visible
5. **Input**: Type `show version` + Enter → command output renders correctly in terminal
6. **No local echo**: Characters should NOT appear until remote echo comes back (verify by typing and watching)
7. **Ctrl+W**: Type a word, press Ctrl+W → word is deleted on remote (not captured by browser)
8. **Resize**: Drag window larger/smaller → terminal reflows → output formatting stays correct
9. **Sidebar resize**: Toggle sidebar → terminal resizes → send a command → output fits new width
10. **Status bar**: Shows green dot, hostname, platform — updates on connect/disconnect
11. **Back button**: Click Back → `sshDisconnect()` called → returns to connection manager
12. **Disconnected state**: Pull network cable or `ssh_disconnect` from console → disconnected banner appears → "Reconnect" works
13. **Auth failure**: Try with wrong password → error message in overlay → "Retry" allows re-entry → "Back" returns to list
14. **Cancel connect**: During connection, click Cancel → connection aborted → back to connection manager

---

## Definition of Done

The app is a **functional SSH client**. Users can select a host, connect, authenticate, type commands, see output, resize the terminal, and disconnect — all through the UI. The connecting and disconnected states provide clear feedback. Ctrl+W and other pass-through keys work correctly.
