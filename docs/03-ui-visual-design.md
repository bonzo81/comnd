# UI & Visual Design

## Design Language

net.sh is a professional tool for network engineers. The visual design should be clean, information-dense, and distraction-free. No decorative elements. Every pixel earns its place.

## Theme

* **Default:** Dark theme, following OS-level dark/light preference (Tauri detects this automatically). Manual override in settings.
* **Dark palette (primary):**

| Element | Colour | Notes |
|---------|--------|-------|
| Terminal background | `#1e1e2e` | Deep blue-grey, easy on the eyes for long sessions |
| Terminal foreground | `#cdd6f4` | Warm off-white |
| UI chrome (sidebar, connection manager) | `#181825` | Slightly darker than terminal to differentiate |
| Borders / dividers | `#313244` | Subtle, not prominent |
| Accent / interactive | `#89b4fa` | Blue — links, selected items, focus indicators |
| Ghost text (suggestions) | `#6c7086` at 50% opacity | Must be clearly distinguishable from real text and cursor. No ambiguity. |
| Dropdown selected item | `#313244` background | Highlighted row |
| Error / warning | `#f38ba8` / `#fab387` | Red / orange |
| Success / connected | `#a6e3a1` | Green |
| Muted metadata | `#585b70` | Version, mode, tags in sidebar |

* **Light palette:** Post-MVP. Design dark-first, derive light later.

## Typography

| Context | Font | Size | Notes |
|---------|------|------|-------|
| Terminal | JetBrains Mono | 14px default | Bundled with app. User-configurable in settings. |
| UI text (labels, sidebar, connection manager) | System font stack (Inter as fallback) | 13px body, 12px metadata | Native feel per OS |
| Sidebar command name (heading) | JetBrains Mono, bold | 16px | Monospace to match terminal context |
| Sidebar code blocks / syntax | JetBrains Mono | 13px | Syntax colouring for optional vs required params |

**Terminal font size:** adjustable via `Ctrl++` / `Ctrl+-` (zoom). Persisted in user preferences.

## Spacing & Layout

* **Base unit:** 4px grid. All spacing is a multiple of 4.
* **Connection manager list items:** 48px row height (comfortable click/touch target)
* **Sidebar default width:** 320px
* **Sidebar min width:** 240px (collapses if dragged smaller)
* **Sidebar resizable:** yes — drag the divider between terminal and sidebar
* **Sidebar mode:** push (resizes the terminal, does NOT overlay it)
* **Dropdown max height:** 8 visible items, scrollable if more
* **Dropdown item height:** 28px

## Screens / Views


1. **Connection Manager** — Home screen. Lists saved hosts. Add / edit / delete.
2. **Terminal View** — Active SSH session. Terminal + suggestion UI.
3. **Settings** — App preferences, KB update channel, theme.

## Terminal View Layout

```
┌──────────────────────────────────────────────────────────────┐
│ [← Back]  core-rtr-lon01 (IOS-XE 17.6)           [≡ Panel] │  ← Top bar
├─────────────────────────────────┬────────────────────────────┤
│                                 │                            │
│     SSH Terminal                │  show ip interface brief   │
│     (xterm.js)                  │  ━━━━━━━━━━━━━━━━━━━━━━━   │
│                                 │                            │
│                                 │  Syntax                    │
│                                 │  ┌────────────────────┐    │
│                                 │  │ show ip interface   │    │
│                                 │  │ [brief | <name>]   │    │
│                                 │  └────────────────────┘    │
│                                 │                            │
│  router# show ip int            │  Description               │
│    ░░░░erface brief (+4)        │  Displays IP address,      │
│                                 │  status, and protocol      │
│                                 │  state for interfaces.     │
│                                 │                            │
│                                 │  Examples                  │
│                                 │  ▸ show ip int brief       │
│                                 │  ▸ show ip int Gi0/0/0     │
│                                 │                            │
│                                 │  ─────────────────────     │
│                                 │  IOS-XE · ≥12.0 · exec    │
│                                 │  🏷 interfaces networking  │
│                                 │  📖 Official docs →        │
├─────────────────────────────────┴────────────────────────────┤
│ 🟢 core-rtr-lon01 │ IOS-XE 17.6 │ privileged-exec │ 12ms   │  ← Status bar
└──────────────────────────────────────────────────────────────┘
```

## Top Bar

* **← Back** — returns to connection manager (keyboard: `Escape` when no dropdown/panel open)
* **Host name + platform** — always visible context
* **≡ Panel button** — toggles side panel (keyboard: Ctrl+\`)

## Status Bar

Thin bar at the bottom of the terminal view. Always visible. Shows at a glance:

| Element | Description |
|---------|-------------|
| Connection indicator | 🟢 green = connected, 🔴 red = disconnected, 🟡 yellow = connecting |
| Host display name | Which device am I on? |
| Platform + version | What OS is this? |
| Current mode | Updated in real time by prompt detection — confirms the app is tracking correctly |
| Latency (optional) | Round-trip time if measurable. Helps diagnose slow sessions. |

## Side Panel

Hidden by default. Toggled via ``` Ctrl+``  ``` or the panel button. Pushes terminal (does not overlay). Resizable by dragging the divider. Default 320px, minimum 240px.

**Visual hierarchy (top to bottom):**


1. **Command name** — large, bold, monospace. The heading.
2. **Syntax block** — monospace code block with colour highlighting:
   * Required params in foreground colour
   * Optional params (`[...]`) in accent colour
   * Placeholder params (`<name>`) in italic
3. **Description** — body text. Plain language explanation.
4. **Examples** — each in a monospace code block. **Clickable** — clicking an example inserts it into the terminal input (writes to shadow buffer + sends to SSH channel). Hover state indicates interactivity.
5. **Divider**
6. **Metadata row** (muted) — platform · version introduced · mode. De-emphasised, does not compete with description.
7. **Tags** — shown as pills/chips (e.g. `interfaces` `networking` `troubleshooting`). Post-MVP: clickable to filter related commands.
8. **📖 Official docs →** — link to platform reference URL. Opens in default browser.

## Ghost Text Rendering

* Appears immediately after the last typed character (not after the cursor block)
* Same terminal row, inline
* Rendered at 50% opacity of foreground colour — clearly distinct from real text
* **Truncates with** `**…**` if it would wrap to the next line
* **Instant on/off** — no animation, no fade. Any delay feels laggy in a terminal.
* **Match count badge** — when ghost text is showing, a subtle `(+N)` after the ghost text indicates more matches available via `Ctrl+Space`. Teaches the dropdown feature organically.
* Disappears instantly when user types a character that no longer matches

## Dropdown Rendering

* Appears below the cursor. If insufficient room below, appears above.
* **Never** obscures the current input line
* Maximum 8 visible items, scroll indicator if more
* Each item: matched prefix shown in **bold** (e.g. **show ip** interface brief)
* Selected item has highlighted background (`#313244`)
* Category shown as muted text right-aligned in each row (e.g. `networking`)
* Dismissed on `Escape`, typing a non-matching character, or clicking outside

## Connecting State

When a user clicks Connect, the terminal view shows a connection progress sequence:

```
┌──────────────────────────────────────────┐
│                                          │
│        Connecting to core-rtr-lon01      │
│        ━━━━━━━━━━━━━━━━░░░░░░░░░░       │
│                                          │
│        Authenticating...                 │
│                                          │
│                          [Cancel]        │
│                                          │
└──────────────────────────────────────────┘
```

Progress stages shown sequentially:


1. "Connecting..." (TCP handshake)
2. "Verifying host key..." (TOFU check)
3. "Authenticating..." (password/key/keyboard-interactive)
4. "Opening session..." (PTY channel)
5. → Terminal view (connected)

Cancel button available at all stages. On failure, error overlay with retry button (see Connection Error Handling in Technical Architecture).
