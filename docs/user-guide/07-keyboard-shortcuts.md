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
| `Ctrl+Shift+F` | Search terminal scrollback |
| `Ctrl+Shift+W` | Close active tab (after a confirmation dialog) |
| `Ctrl+Shift+Q` | Disconnect active session (after a confirmation dialog) |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Zoom terminal font in / out / reset |

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
| `Ctrl+Shift+K` | Toggle Knowledge Base view |
| `Ctrl+Shift+Q` | Disconnect active session (after a confirmation dialog) |
| `/` | Focus search (when not typing in an input) |
| `?` | Toggle the shortcuts help modal (when not typing in an input) |

## Escape Cascade

`Escape` follows a consistent back-out path. Each press moves you up one level:

1. Dropdown open → close dropdown
2. Side panel open → close side panel
3. Otherwise → return to connection manager (home screen)

Repeated presses always land you back on the home screen. No dead ends.

## Help & Customization

Press `?` or click the keyboard button in the status bar (bottom of the window) to see every shortcut in one place. The list is generated from the app itself, so it is always current. Its **Customize…** link takes you to Settings → Shortcuts.

Most shortcuts can be rebound there — everything except the fixed interaction keys (`Tab`, `↑`/`↓`, `Enter`, `Escape`, `Alt+→`). Click **Change**, press the new combination, then press `Enter` to save. New bindings take effect immediately and persist across restarts.

A few keys are protected: `Ctrl+W` always passes through to the remote device, `Ctrl+C` / `Ctrl+V` keep their clipboard roles, bare `Tab` / `Escape` are navigation semantics, and `Ctrl+Space` is pinned to `Ctrl` on every platform. The pane explains each rule whenever it blocks a change.

For the full walkthrough, see [Settings](08-settings.md#keyboard-shortcuts).
