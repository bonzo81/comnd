# Keyboard & Shortcuts

### Keyboard Shortcuts

| Shortcut | Action | Context |
|---|---|---|
| `Tab` | Accept ghost text suggestion (if showing) / pass through to remote (if no suggestion) | Terminal |
| `Ctrl+Space` | Open suggestion dropdown | Terminal |
| `Escape` | Dismiss dropdown / dismiss side panel | Dropdown or panel open |
| `↑` / `↓` | Navigate dropdown (if open) / pass through to remote (if closed) | Terminal |
| `Enter` | Select dropdown item (if open) / send command to remote (if closed) | Terminal |
| `Ctrl+\`` (backtick) | Toggle side panel | Terminal |
| `Ctrl+N` | New connection | Any |
| `Ctrl+Shift+W` | Disconnect current session | Terminal |

**Note:** `Ctrl+W` is NOT used — it is "delete previous word" in most shells and must pass through to the remote device.

### Keyboard-First Design

The entire app must be navigable without a mouse. Network engineers work keyboard-first — mouse interaction is available but never required.

| Screen | Key | Action |
|---|---|---|
| Connection Manager | `↑` / `↓` | Navigate host list |
| Connection Manager | `Enter` | Connect to selected host |
| Connection Manager | `/` | Focus search bar |
| Connection Manager | `Ctrl+N` | New connection |
| Connection Manager | `Delete` | Delete selected host (with confirmation) |
| Terminal | `Tab` | Accept suggestion / pass to remote |
| Terminal | `Ctrl+Space` | Open dropdown |
| Terminal | `Ctrl+\`` | Toggle side panel |
| Terminal | `Ctrl+Shift+W` | Disconnect |
| Terminal | `Escape` | Dismiss dropdown → dismiss panel → return to connection manager (cascade) |
| Terminal | `Ctrl++` / `Ctrl+-` | Zoom terminal font |
| Side Panel | `↑` / `↓` | Scroll content (when panel is focused) |
| Global | `Tab` / `Shift+Tab` | Move focus between panels/elements |
| Global | `Ctrl+,` | Open settings |

---
