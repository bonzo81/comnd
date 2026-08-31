# Keyboard Shortcuts

## Terminal Shortcuts

These shortcuts work while you are connected to a device with an active SSH session.

| Shortcut | Action |
|---|---|
| `Tab` | Accept the ghost text suggestion if one is showing. Otherwise, pass through to the remote device |
| `Ctrl+Space` | Toggle command suggestions (auto-show the dropdown while typing) |
| `Escape` | See [Escape Cascade](#escape-cascade) |
| `↑` / `↓` | Navigate dropdown items if the dropdown is open. Navigate remote command history if it is closed |
| `Enter` | Send the typed command to the device (always). Closes the dropdown if it is open |
| `` Ctrl+` `` | Toggle side panel (sessions, host details, suggestions) |
| `Ctrl+Shift+W` | Close active tab (after a confirmation dialog) |
| `Ctrl++` / `Ctrl+-` | Zoom terminal font in / out |

**Note:** `Ctrl+W` is intentionally unbound. It passes through to the remote device — in most shells this deletes the word behind the cursor, and netssh does not interfere with that.

## Connection Manager Shortcuts

These shortcuts work on the home screen and host list. They are active when no SSH session is in focus.

| Shortcut | Action |
|---|---|
| `↑` / `↓` | Navigate host list |
| `Enter` | Connect to selected host |
| `/` | Focus search bar |
| `Ctrl+N` | New connection |
| `Delete` | Delete selected host (prompts for confirmation) |

## Global Shortcuts

These shortcuts work regardless of which panel or view is active.

| Shortcut | Action |
|---|---|
| `Tab` / `Shift+Tab` | Move focus between interactive elements |
| `Ctrl+N` | New connection |
| `Ctrl+,` | Open settings |

## Escape Cascade

`Escape` follows a consistent back-out path. Each press moves you up one level:

1. Dropdown open → close dropdown
2. Side panel open → close side panel
3. Otherwise → return to connection manager (home screen)

Repeated presses always land you back on the home screen. No dead ends.
