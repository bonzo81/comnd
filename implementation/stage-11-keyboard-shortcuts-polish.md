# Stage 11 — Keyboard Shortcuts & Polish

**Goal:** Implement the complete keyboard shortcut table, the Escape cascade, global focus management, and polish the overall UX — status bar real data, terminal zoom, connection latency display, and visual refinements.

**Spec refs:** `docs/07-keyboard-shortcuts.md` (full shortcut table), `docs/03-ui-visual-design.md` (status bar, zoom), `docs/02-technical-architecture.md` (pass-through keys)

---

## Why This Stage

Individual stages implemented shortcuts in isolation (Tab in Stage 09, Ctrl+Space in Stage 10, etc.). This stage audits the full table, implements any missing shortcuts, adds the Escape cascade, and ensures consistent keyboard-first navigation across the entire app.

---

## Steps

### 1. Audit the full shortcut table

Cross-reference `docs/07-keyboard-shortcuts.md` with current implementation. Verify or implement every shortcut:

**Terminal View:**
| Shortcut | Action | Implemented in |
|----------|--------|----------------|
| `Tab` | Accept ghost suggestion OR pass through | Stage 09 |
| `Ctrl+Space` | Toggle dropdown | Stage 10 |
| `Escape` | Cascade dismiss | **This stage** |
| `↑ / ↓` | Dropdown nav OR pass through | Stage 10 |
| `Enter` | Dropdown select OR pass through | Stage 10 |
| `Ctrl+\`` | Toggle side panel | Stage 07 (partial) |
| `Ctrl+Shift+W` | Disconnect session | **This stage** |
| `Ctrl++` / `Ctrl+-` | Zoom in / out | **This stage** |

**Connection Manager:**
| Shortcut | Action | Implemented in |
|----------|--------|----------------|
| `↑ / ↓` | Navigate host list | Stage 05 |
| `Enter` | Connect to selected host | Stage 05 |
| `/` | Focus search | Stage 05 |
| `Ctrl+N` | New host form | Stage 05 |
| `Delete` | Delete with confirmation | Stage 05 |

**Global:**
| Shortcut | Action | Implemented in |
|----------|--------|----------------|
| `Tab` / `Shift+Tab` | Focus navigation | **This stage** |
| `Ctrl+N` | New host (when in conn mgr) | Stage 05 |
| `Ctrl+W` | **PASS THROUGH** (never intercept) | Stage 07 |

### 2. Implement the Escape cascade

Per `docs/07-keyboard-shortcuts.md`, Escape dismisses in priority order:

1. **Dropdown open** → close dropdown (keep ghost text)
2. **Side panel open** → close side panel
3. **Ghost text visible** → hide ghost text
4. **In terminal view** → navigate back to connection manager (with disconnect prompt if connected)
5. **In connection manager with search active** → clear search
6. **In modal/form** → close modal

Implement a central Escape handler that checks state in this order and takes the first matching action.

### 3. Implement `Ctrl+Shift+W` disconnect

- Listen for this shortcut in terminal view
- Show a brief confirmation: "Disconnect from {host}?" (or disconnect immediately — spec doesn't mandate confirmation)
- Call `sshDisconnect()` → navigate to connection manager
- Differentiate from `Ctrl+W` (which MUST pass through to remote)

### 4. Implement terminal zoom

- `Ctrl++` (Ctrl + Plus/Equals): Increase terminal font size
- `Ctrl+-` (Ctrl + Minus): Decrease terminal font size
- `Ctrl+0`: Reset to default font size
- Apply font size change to xterm.js: `terminal.options.fontSize = newSize`
- After resize: `fitAddon.fit()` → `sshResize()` (font size affects cols/rows)
- Persist zoom level in memory (not across sessions for MVP)
- Prevent browser default zoom (use `e.preventDefault()`)

### 5. Implement global focus management

Ensure the app is fully navigable without a mouse:

- When in connection manager: focus is on the host list (keyboard nav) or search input or form fields
- When in terminal view: focus defaults to the terminal (xterm.js captures input)
- `Tab` / `Shift+Tab`: cycle focus between top bar buttons, terminal, and sidebar content
- Focus indicators: visible outline on focused elements (use `var(--color-accent)` outline or ring)
- Auto-focus: terminal gets focus on connect, search gets focus on `/`, form fields auto-advance

### 6. Implement `Ctrl+W` protection

Ensure `Ctrl+W` is never intercepted:

- In the global `keydown` handler: if `Ctrl+W` is pressed and terminal is focused, `e.preventDefault()` on the browser's default (close tab) but let the keystroke flow to SSH via `terminal.onData()`
- Verify this works on all platforms (Tauri webview may not fire the browser "close tab" on Ctrl+W, but better safe)

### 7. Polish the status bar

Complete the status bar with real data:

- **Connection indicator**: Animated dot or icon
  - Green pulse when connected
  - Red static when disconnected
  - Amber blink when connecting
- **Host**: From connection config
- **Platform**: Human-readable name from platform index
- **Mode**: From prompt detector (already wired in Stage 08)
- **Latency**: Measure SSH round-trip time
  - Option A: Time the `sshSend()` to next `ssh-output` event for echo
  - Option B: Measure keepalive response time on the Rust side and emit as an event
  - Display as "Xms" with colour coding (green <100ms, yellow <300ms, red >300ms)

### 8. Add keyboard shortcut help

- Consider a small `?` icon or `Ctrl+/` shortcut that shows an overlay listing all shortcuts
- This is a nice-to-have but very useful for discoverability
- Simple modal with the shortcut table from the spec
- Dismiss with Escape

### 9. Visual polish pass

Review and fix:

- Transition animations: sidebar slide (CSS transition, ~200ms)
- Hover states on all clickable elements
- Consistent border-radius on all containers
- Loading/spinner CSS for the connecting overlay
- Disabled state for buttons during connection
- Cursor styles (pointer on buttons, text on inputs, default elsewhere)
- Selection colours in terminal (already set in xterm.js theme)

---

## Files Modified

| File | Changes |
|------|---------|
| `src/components/terminal-view.ts` | Escape cascade, zoom, Ctrl+Shift+W, focus management |
| `src/components/connection-manager.ts` | Escape handler, focus management |
| `src/main.ts` | Global keyboard handler, Ctrl+W protection, focus management |
| `src/styles/main.css` | Focus indicators, status bar states, transitions, polish |
| `src/lib/ghost-text.ts` | Ensure hide on Escape cascade |
| `src/lib/dropdown.ts` | Ensure close on Escape cascade |

## Files Created

| File | Purpose |
|------|---------|
| `src/lib/keyboard-handler.ts` | Optional: central keyboard shortcut dispatcher |

---

## Verification

1. **Escape cascade**: Open dropdown + side panel → Escape #1 closes dropdown → Escape #2 closes panel → Escape #3 navigates back
2. **Ctrl+Shift+W**: In terminal → Ctrl+Shift+W → disconnects → returns to connection manager
3. **Ctrl+W passthrough**: In terminal → type "hello" → Ctrl+W → deletes "hello" on remote (doesn't close app)
4. **Zoom**: Ctrl++ three times → font grows → fit recalculates → Ctrl+0 resets
5. **Tab focus**: In terminal → Tab+Shift cycles through top bar Back button → panel toggle → terminal
6. **Focus indicators**: Tab through elements → each shows visible focus ring
7. **Status bar latency**: Connect to device → latency shows real value (e.g. "23ms")
8. **Status bar mode**: Navigate modes → status bar updates live
9. **All shortcuts**: Walk through every row in the shortcut table and verify it works
10. **No Ctrl+W interception**: Terminal focused → Ctrl+W → no app closure, delete-word on remote
11. **Smooth transitions**: Sidebar open/close is animated → terminal resize follows smoothly

---

## Definition of Done

Every keyboard shortcut from `docs/07-keyboard-shortcuts.md` works correctly. The Escape cascade follows the spec priority order. The app is fully keyboard-navigable without a mouse. The status bar shows live connection data. Visual polish is applied across all views.
