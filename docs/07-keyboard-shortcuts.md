# Keyboard & Shortcuts

## Keyboard-First Design

The entire app must be navigable without a mouse. Network engineers work keyboard-first — mouse interaction is available but never required.

## Terminal Shortcuts

| Shortcut | Action | Context |
|----------|--------|---------|
| `Tab`    | Accept ghost text suggestion (if showing) / pass through to remote (if no suggestion) | Terminal |
| `Ctrl+Space` | Open suggestion dropdown | Terminal |
| `Escape` | Dismiss dropdown / dismiss side panel | Dropdown or panel open |
| `↑` / `↓` | Navigate dropdown (if open) / pass through to remote (if closed) | Terminal |
| `Enter`  | Select dropdown item (if open) / send command to remote (if closed) | Terminal |
| ``` Ctrl+``  ``` | Toggle side panel | Terminal |
| `Ctrl+Shift+W` | Disconnect current session | Terminal |
| `Ctrl++` / `Ctrl+-` | Zoom terminal font | Terminal |

**Note:** `Ctrl+W` is NOT used — it is "delete previous word" in most shells and must pass through to the remote device.

## Connection Manager Shortcuts

| Shortcut | Action |
|----------|--------|
| `↑` / `↓` | Navigate host list |
| `Enter`  | Connect to selected host |
| `/`      | Focus search bar |
| `Ctrl+N` | New connection |
| `Delete` | Delete selected host (with confirmation) |

## Global Shortcuts

| Shortcut | Action |
|----------|--------|
| `Tab` / `Shift+Tab` | Move focus between panels/elements |
| `Ctrl+N` | New connection |
| `Ctrl+,` | Open settings |

## Side Panel Shortcuts

| Shortcut | Action |
|----------|--------|
| `↑` / `↓` | Scroll content (when panel is focused) |

## Escape Cascade

`Escape` follows a consistent "back out" behaviour:


1. If dropdown is open → dismiss dropdown
2. If side panel is open → close side panel
3. If nothing is open → return to connection manager

This means repeatedly pressing Escape always gets you back to the home screen.
