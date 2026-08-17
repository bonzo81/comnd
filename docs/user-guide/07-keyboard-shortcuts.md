## Terminal Shortcuts

While connected to a device with an active SSH session.

| Shortcut | Action |
|---|---|
| `Tab` | Accept ghost text suggestion (if showing); pass through to remote (otherwise) |
| `Ctrl+Space` | Open command suggestion dropdown |
| `Escape` | See [Escape Cascade](#escape-cascade) |
| `↑` / `↓` | Navigate dropdown items (if open); remote command history (if closed) |
| `Enter` | Select highlighted dropdown item (if open); send typed command (if closed) |
| `` Ctrl+` `` | Toggle side panel (sessions, host details, suggestions) |
| `Ctrl+Shift+W` | Close active tab (with confirm) |
| `Ctrl++` / `Ctrl+-` | Zoom terminal font in / out |

**Note:** `Ctrl+W` is intentionally unbound. It passes through to the remote device — in most shells this deletes the word behind the cursor, and net.sh doesn't interfere with that.

## Connection Manager Shortcuts

The home screen and host list. Active when no SSH session is in focus.

| Shortcut | Action |
|---|---|
| `↑` / `↓` | Navigate host list |
| `Enter` | Connect to selected host |
| `/` | Focus search bar |
| `Ctrl+N` | New connection |
| `Delete` | Delete selected host (prompts for confirmation) |

## Global Shortcuts

Work regardless of which panel or view is active.

| Shortcut | Action |
|---|---|
| `Tab` / `Shift+Tab` | Move focus between interactive elements |
| `Ctrl+N` | New connection |
| `Ctrl+,` | Open settings |

## Escape Cascade

`Escape` follows a consistent back-out path. Each press steps up one level:

1. Dropdown open → close dropdown
2. Side panel open → close side panel
3. Otherwise → return to connection manager (home screen)

Repeated presses always land you back on the home screen. No dead ends.
