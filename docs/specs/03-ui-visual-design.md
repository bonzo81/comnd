# UI & Visual Design

## Design Language

Comnd is a professional tool for network engineers. The visual design should be clean, information-dense, and distraction-free. No decorative elements. Every pixel earns its place.

Style reference: Linear-inspired neutral slate surfaces, single green accent, subtle borders. All colors are CSS custom properties in `src/styles/tokens.css`.

## Theme

* **Default:** Dark theme, following OS-level dark/light preference (Tauri detects this automatically). Manual override via title-bar toggle. Both themes are shipped.
* **Dark palette (primary):**

| Element | Token | Colour | Notes |
|---------|-------|--------|-------|
| App background / terminal background | `--color-surface-primary` | `#0F172A` (slate-900) | Deep blue-grey, easy on the eyes for long sessions |
| Terminal foreground | — | `#F8FAFC` | Set via xterm theme (`src/lib/theme.ts`) |
| Terminal cursor | — | `#22C55E` | Green, matches accent |
| UI chrome (title bar, top bar, sidebar, status bar) | `--color-surface-secondary` | `#111827` | Differentiates chrome from terminal |
| Elevated surfaces (cards, modals, dropdowns, inputs) | `--color-surface-elevated` | `#1E293B` (slate-800) | |
| Borders / dividers | `--color-border` | `rgba(255,255,255,0.08)` | Subtle, not prominent |
| Accent / interactive | `--color-accent` | `#22C55E` | Green — links, selected items, focus indicators, badges |
| Ghost text (suggestions) | `--color-text-secondary` at 60% opacity | `#94A3B8` @ 0.6 | Must be clearly distinguishable from real text and cursor. No ambiguity. |
| Selected item background | `--color-surface-selected` | `rgba(34, 197, 94, 0.12)` | Accent tint — highlighted row |
| Error / warning | `--color-error` / `--color-warning` | `#EF4444` / `#F59E0B` | Red / orange |
| Success / connected | `--color-success` | `#22C55E` | Same as accent |
| Muted metadata | `--color-text-secondary` | `#94A3B8` | Version, mode, tags in sidebar |
| NX-OS badge | `--badge-nxos` | `#38BDF8` | Platform badge differentiation |

Platform tints: each platform subtly tints the top/status bar chrome via `--chrome-tint` (IOS-XE green, NX-OS sky, TMOS amber, Bash green-dim). Purely ambient — never competes with content.

* **Light palette (shipped, theme-aware via `[data-theme="light"]`):**

| Element | Colour | Notes |
|---------|--------|-------|
| Surface primary / elevated | `#F8FAFC` / `#FFFFFF` | |
| Chrome | `#F1F5F9` | |
| Text primary / secondary / tertiary | `#0F172A` / `#475569` / `#64748B` | All ≥ 4.5:1 on their surfaces |
| Accent / success | `#15803D` | Darker green for light-bg contrast |
| Terminal | bg `#F8FAFC`, fg `#0F172A`, cursor `#16A34A` | Via xterm theme |

Contrast rule: every text/background pair ≥ 4.5:1 WCAG AA. The one deliberate exception is ghost text — it must be *less* prominent than real input.

## Typography

| Context | Font | Size | Notes |
|---------|------|------|-------|
| Terminal | JetBrains Mono | 14px default | Bundled via `@fontsource`. User-configurable (`Ctrl++`/`Ctrl+-`/`Ctrl+0`, range 8–32px). |
| UI text (labels, sidebar, connection manager) | Inter, system stack fallback | 13px body, 12px metadata, 11px badges | Inter bundled via `@fontsource` (400/500/600) |
| Sidebar command name (heading) | JetBrains Mono, bold | 16px | Monospace to match terminal context |
| Sidebar code blocks / syntax | JetBrains Mono | 12px | Syntax colouring for optional vs required params |

**Terminal font size:** adjustable via `Ctrl++` / `Ctrl+-` / `Ctrl+0` (zoom). Persisted via the `comnd-terminal-font-size` localStorage key (range 8–32px); one source of truth also written by Reading Comfort mode (spec 12).

**Terminal themes:** four states, cycled by the toolbar theme button — `dark`, `light`, `cream`, `warm-charcoal` (definitions in spec 12). See Reading Comfort mode (`docs/specs/12-dyslexia-mode.md`) for typography scaling (`--text-scale`), spacing, and prose-measure tokens.

## Iconography

* All icons are inline SVGs (Lucide path data, 24×24 viewBox, `stroke="currentColor"`) defined in one place: `src/lib/icons.ts`.
* Icons inherit text color via `currentColor`; sized per-context in CSS (12px badges, 14px buttons, 16px nav/toasts, 48px empty state).
* **No emoji as icons** — they render inconsistently across Windows/macOS/Linux and can't follow theme colors. Plain text glyphs (`×`, `●`, `▾`/`▸`, `←`) are acceptable where they're characters, not decorative icons.
* Every icon-only control has an `aria-label`. Decorative SVGs carry `aria-hidden="true"`.

## Spacing & Layout

* **Base unit:** 4px grid. All spacing is a multiple of 4 (`--space-*` tokens).
* **Connection manager list items:** 48px row height (comfortable click/touch target)
* **Sidebar default width:** 320px
* **Sidebar min width:** 240px (collapses if dragged smaller)
* **Sidebar resizable:** yes — drag the divider between terminal and sidebar
* **Sidebar mode:** push (resizes the terminal, does NOT overlay it)
* **Dropdown max height:** 8 visible items, scroll indicator if more
* **Dropdown item height:** 32px
* **Radii:** 4px / 6px / 8px (`--radius-sm/md/lg`)
* **Content column** (centered, `margin: 0 auto`): Replay 900px. Full-bleed screens (terminal, connection manager, KB, settings) have no max-width — Settings uses an icon rail + capped pane instead (see Settings Screen Layout).

## Screens / Views


1. **Connection Manager** — Home screen. Lists saved hosts. Add / edit / delete. Host tree groups in the left nav panel.
2. **Terminal View** — Active SSH session. Terminal + suggestion UI. One tab per connected host.
3. **Knowledge Base** — Browse / edit / import KB commands.
4. **Settings** — App preferences, KB update channel, theme. Icon-nav layout (see Settings Screen Layout below).

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
│                                 │  [interfaces] [networking] │
│                                 │  Official docs →           │
├─────────────────────────────────┴────────────────────────────┤
│ ● core-rtr-lon01 │ IOS-XE 17.6 │ privileged-exec │ 12ms     │  ← Status bar
└──────────────────────────────────────────────────────────────┘
```

## Top Bar

* **← Back** — returns to connection manager (keyboard: `Escape` when no dropdown/panel open)
* **Host name + platform** — always visible context
* **≡ Panel button** — toggles side panel

## Status Bar

Thin bar at the bottom of the terminal view. Always visible. Monospace. Shows at a glance:

| Element | Description |
|---------|-------------|
| Connection indicator | Colored dot (`●`) — green = connected, red = disconnected, amber = connecting |
| Host display name | Which device am I on? |
| Platform + version | What OS is this? |
| Current mode | Updated in real time by prompt detection — confirms the app is tracking correctly |
| Latency (optional) | Round-trip time if measurable. Helps diagnose slow sessions. |
| Shortcuts help button | Keyboard glyph at the right end. Opens the shortcuts help modal (same as pressing `?`). Tooltip: "Keyboard shortcuts (?)". Registry-driven — see docs/specs/11-shortcut-customization.md. |

## Side Panel

Hidden by default. Opened via the `≡` panel button; closed with the button again or `Escape` (after any open dropdown). Pushes terminal (does not overlay). Resizable by dragging the divider. Default 320px, minimum 240px.

**Visual hierarchy (top to bottom):**


1. **Command name** — large, bold, monospace, accent color. The heading.
2. **Syntax block** — monospace code block with colour highlighting:
   * Required params (`<name>`) in accent colour
   * Optional params (`[...]`) in warning colour
3. **Description** — body text. Plain language explanation.
4. **Examples** — each in a monospace code block. **Clickable** — clicking an example inserts it into the terminal input (writes to shadow buffer + sends to SSH channel). Hover state indicates interactivity.
5. **Divider**
6. **Metadata rows** (muted label + value) — platform · version introduced · mode. De-emphasised, does not compete with description.
7. **Tags** — shown as pills/chips (e.g. `interfaces` `networking` `troubleshooting`). Post-MVP: clickable to filter related commands.
8. **Official docs →** — link to platform reference URL. Opens in default browser.

## Ghost Text Rendering

* Appears immediately after the last typed character (not after the cursor block)
* Same terminal row, inline
* Rendered at 60% opacity in secondary text colour — clearly distinct from real text
* **Truncates with** `**…**` if it would wrap to the next line
* **Instant on/off** — no animation, no fade. Any delay feels laggy in a terminal.
* **Match count badge** — when ghost text is showing, a subtle `(+N)` after the ghost text indicates more matches available via `Ctrl+Space`. Teaches the dropdown feature organically.
* Disappears instantly when user types a character that no longer matches

## Dropdown Rendering

* Anchored bottom-left of the terminal pane — never obscures the current input line
* Maximum 8 visible items, scroll indicator if more
* Each item: matched prefix shown in **bold** accent (e.g. **show ip** interface brief)
* Selected item has highlighted background (accent tint)
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

## Settings Screen Layout

```
┌──────────────────────────────────────────────────────┐
│ nav │ ▤  │  GROUP LABEL                              │
│ panel │ ▥ │  Label                      [control]    │
│       │ ▣ │  description                              │
│       │ … │                                           │
└──────────────────────────────────────────────────────┘
```

* **Icon rail (left):** one labeled button per page — icon + text: General, Logging, Theme, Reading Comfort, LLM API / KB Import, Auth Integrations, NetBox, Shortcuts (icons from `src/lib/icons.ts`). Flat — no borders on items; the active page is a **filled pill** (accent-tint background + accent text), mirroring the nav panel's active sub-item. Keyboard: roving tabindex (`↑`/`↓`/`Home`/`End`, Enter/Space activate) with the standard visible focus ring.
* **Nav panel:** no Settings section — the entry point is the **title-bar cog** (left of the minimize button, tooltip "Settings"; the conditional update indicator sits left of it). The icon rail is the single page switcher.
* **Content pane:** max-width 720px, left-aligned. No per-page title heading — the rail is the title.
* **SettingRow:** label + short description left, control right-aligned on the same baseline. Wide widgets (log paths, textarea, filter multi-select) use a block variant: label on top, full-width control below.
* **Group labels:** small, muted, uppercase (`--color-text-tertiary`), separated by whitespace only — no bold section headings, no divider rules.
* **Controls:** all share the app-wide pill radius (`--radius-pill` via `.form-input` / `.btn`). Booleans are **pill switches** — native checkboxes restyled in place, so bindings and tests are unchanged. Selects and buttons are compact and right-aligned, never full-width (one exception: the NetBox filter multi-select chips box stays full-width — it cannot function compact).

## Accessibility

* **Focus:** every interactive element has a visible `:focus-visible` ring (2px accent). Roving tabindex in the nav panel; arrow-key navigation throughout.
* **Keyboard-first:** entire app navigable without a mouse (see `docs/specs/07-keyboard-shortcuts.md`). `Ctrl+W` passes through to the remote.
* **Contrast:** all text ≥ 4.5:1 WCAG AA in both themes (deliberate exception: ghost text must read as "not real").
* **Screen readers:** toast container is `role="status"` + `aria-live="polite"`; error toasts escalate to `role="alert"`. Icon-only buttons carry `aria-label`. Decorative SVGs are `aria-hidden`.
* **Never color-only:** selection is tint **plus** outline. Known gap: the status-bar connection dot is color-only today — pair it with state text (e.g. "Connected") when next touched.

## Motion

* Transitions 100–300ms, color/opacity only — never layout-shifting scale on container elements (small scale on buttons OK).
* Ghost text and suggestion visibility are instant — no fades in the keystroke path.
* Sidebar width, chrome tint, progress bar, toast entrance are the only animated transitions.
