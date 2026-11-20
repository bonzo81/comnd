# Keyboard & Shortcuts

## Keyboard-First Design

The entire app must be navigable without a mouse. Network engineers work keyboard-first — mouse interaction is available but never required.

## Terminal Shortcuts

| Shortcut | Action | Context |
|----------|--------|---------|
| `Tab`    | Accept ghost text suggestion (if showing) / pass through to remote (if no suggestion) | Terminal |
| `Alt+→`  | Accept next word of ghost text suggestion (if showing) / pass through to remote | Terminal |
| `Ctrl+Space` | Toggle command suggestions (auto-show dropdown while typing) | Terminal |
| `Escape` | Dismiss dropdown / dismiss side panel | Dropdown or panel open |
| `↑` / `↓` | Navigate dropdown (if open) / pass through to remote (if closed) | Terminal |
| `Enter`  | Send command to remote (always); closes dropdown if open | Terminal |
| `Ctrl+Shift+F` | Search terminal scrollback | Terminal |
| `Ctrl+Shift+B` | Open side panel → undock it into its own window → dock it back | Terminal |
| `Ctrl+Shift+W` | Close active tab (with confirm) | Terminal |
| `Ctrl+Shift+Q` | Disconnect active session (with confirm) | Terminal |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Zoom terminal font in / out / reset | Terminal |

**Note:** `Ctrl+W` is NOT used — it is "delete previous word" in most shells and must pass through to the remote device.

## Connection Manager Shortcuts

| Shortcut | Action |
|----------|--------|
| `↑` / `↓` | Navigate host list |
| `Enter`  | Connect to selected host |
| `/`      | Focus search bar |
| `Ctrl+N` | New connection |
| `Delete` | Delete selected host (with confirmation) |

**Host form (New / Edit):** all fields are native inputs and selects — `Tab` / `Shift+Tab` moves between fields, `↑` / `↓` navigates dropdowns (Group, Platform, Agent identity), `Enter` submits (Save & Connect), `Escape` closes.

## Global Shortcuts

| Shortcut | Action |
|----------|--------|
| `Tab` / `Shift+Tab` | Move focus between panels/elements |
| `Ctrl+N` | New connection |
| `Ctrl+,` | Open settings |
| `Ctrl+Shift+K` | Toggle Knowledge Base view |
| `Ctrl+Shift+Q` | Disconnect active session (with confirm) |
| `/` | Focus global search (when not typing in an input) |
| `?` | Toggle shortcuts help modal (when not typing in an input) |

## Side Panel Shortcuts

| Shortcut | Action |
|----------|--------|
| `↑` / `↓` | Scroll content (when panel is focused) |
| `Ctrl+Shift+B` | Open / undock / dock the panel — see below |
| `Escape` | In the undocked panel window: close it (the panel stays undocked for the next open) |

`Ctrl+Shift+B` is the whole panel lifecycle from the keyboard, cycled rather than toggled so undocking is reachable without a mouse: closed → open docked → undocked in its own window → docked again. It works from both windows, so the same chord brings an undocked panel home. The mouse equivalents are the Dock control in the undocked window's header and the Undock control in the docked panel's tab strip; the `.tv-panel-btn` toolbar button still only shows and hides the docked panel.

The undocked window never opens itself at launch, even when the app was quit while undocked: the panel state is remembered, so the next open puts the panel straight back into its own window at the saved geometry.

## Escape Cascade

`Escape` follows a consistent "back out" behaviour:


1. If dropdown is open → dismiss dropdown
2. If side panel is open → close side panel
3. If nothing is open → return to connection manager

This means repeatedly pressing Escape always gets you back to the home screen.

## Help & Customization

Press `?` (when not typing in an input) or click the keyboard button at the right end of the status bar to open the shortcuts help modal. The modal is rendered from the same registry the handlers read, so it cannot drift stale; its **Customize…** link opens Settings → Shortcuts.

Every mappable shortcut above — everything except the fixed interaction keys (`Tab`, `↑`/`↓`, `Enter`, the `Escape` cascade, `Alt+→`) — can be rebound in that pane: click **Change**, press the new combination, then press `Enter` to confirm (`Escape` cancels). Rebindings apply immediately, survive restarts, and are stored per action in `config.json` in platform-agnostic form (`Mod+…`, so a config file is portable across platforms).

The pane validates while you capture:

- A combination already claimed by another action is rejected — both rows highlight and the save is blocked until the clash is resolved.
- Reserved keys are rejected with an explanation: `Ctrl+W` (must pass through to the remote as delete-word), `Ctrl+C` / `Ctrl+V` (clipboard muscle memory), bare `Tab` and bare `Escape` (interaction semantics, never shortcuts).
- `Ctrl+Space` is pinned to `Ctrl` on every platform — the remote shell expects its control byte, and `Cmd+Space` would collide with Spotlight. Its row shows a lock and cannot be edited.

On macOS the `Ctrl`-prefixed entries above mean `⌘`; the help modal and Settings render the platform-correct symbols. `Ctrl+Space` keeps literal `Ctrl` everywhere.

Full rules and the default table: `docs/specs/11-shortcut-customization.md`.
