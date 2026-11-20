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
| UI chrome (title bar, top bar, sidebar, status bar) | `--color-surface-secondary` | `#0A0F1C` | Differentiates chrome from terminal |
| Elevated surfaces (cards, modals, dropdowns, inputs) | `--color-surface-elevated` | `#1E293B` (slate-800) | |
| Borders / dividers | `--color-border` | `rgba(255,255,255,0.20)` | Subtle, not prominent |
| Accent / interactive | `--color-accent` | `#22C55E` | Green — links, selected items, focus indicators, badges |
| Ghost text (suggestions) | `--color-text-secondary` at 60% opacity | `#94A3B8` @ 0.6 | Must be clearly distinguishable from real text and cursor. No ambiguity. |
| Selected item background | `--color-surface-selected` | `rgba(34, 197, 94, 0.12)` | Accent tint — highlighted row |
| Error / warning | `--color-error` / `--color-warning` | `#EF4444` / `#F59E0B` | Red / orange |
| Success / connected | `--color-success` | `#22C55E` | Same as accent |
| Muted metadata | `--color-text-secondary` | `#94A3B8` | Version, mode, tags in sidebar |
| NX-OS badge | `--color-badge-nxos` | `#38BDF8` | Platform badge differentiation |

Platform tints: each platform subtly tints the top/status bar chrome via `--color-chrome-tint` (IOS-XE green, NX-OS sky, TMOS amber, Bash green-dim). Purely ambient — never competes with content.

* **Light palette (shipped, theme-aware via `[data-theme="light"]`):**

| Element | Colour | Notes |
|---------|--------|-------|
| Surface primary / elevated | `#F8FAFC` / `#FFFFFF` | |
| Chrome | `#F1F5F9` | |
| Text primary / secondary / tertiary | `#0F172A` / `#475569` / `#64748B` | All ≥ 4.5:1 on their surfaces |
| Accent / success | `#15803D` | Darker green for light-bg contrast |
| Terminal | bg `#F8FAFC`, fg `#0F172A`, cursor `#16A34A` | Via xterm theme |

Contrast rule: every text/background pair ≥ 4.5:1 WCAG AA. The one deliberate exception is ghost text — it must be *less* prominent than real input.

## Token Layer

Every colour, size, radius and shadow in the UI resolves to a token in `src/styles/tokens.css`. The naming standard is `docs/adr/018-css-token-naming-standard.md`; `npm run lint:css` enforces it in the `frontend` job, and `scripts/check-css-tokens.mjs` additionally proves that no token is defined without a reader and none is read without a definition (CSS and TypeScript both count as readers).

| Namespace | Holds | Example |
|---|---|---|
| `--color-*` | Every colour, surface, border, role and platform tint | `--color-surface-elevated`, `--color-focus-ring` |
| `--space-*` | 4px-grid spacing steps | `--space-4` |
| `--font-size-*` | Type scale, multiplied by `--text-scale` | `--font-size-base` |
| `--font-weight-*` | Available Inter/mono weights, as a role axis | `--font-weight-semibold` |
| `--font-leading-*` | Line height for chrome by role | `--font-leading-title` |
| `--font-tracking-*` | Letter spacing for labels and display text | `--font-tracking-label` |
| `--radius-*` | Corner radii | `--radius-md` |
| `--shadow-*` | Elevation shadows | `--shadow-lg` |
| `--focus-ring-*` | Focus ring width and offset | `--focus-ring-width` |
| `--ghost-*` | Ghost-suggestion opacity | `--ghost-opacity` |
| `--prose-*` | Reading Comfort prose measure | `--prose-max-width` |
| `--local-*` | A value scoped to one component | `--local-ts-gutter` |

Colour roles sit above the raw palette: a component reads `--color-fg-on-danger` (text on a danger fill), `--color-scrollbar-thumb` / `--color-scrollbar-thumb-hover`, or `--color-focus-ring` rather than reaching for the primitive behind them. No `var()` fallbacks — a fallback hides a typo.

**Type scale:** `2xs` 10, `xs` 11, `sm` 12, `base` 13, `lg` 14, `xl` 16, `2xl` 20, `3xl` 22, `4xl` 36 (px, before `--text-scale`).

**Radius scale:** `2xs` 2, `sm` 4, `md` 6, `lg` 8, `pill` 9999 (px).

## Typography

| Context | Font | Size | Notes |
|---------|------|------|-------|
| Terminal | JetBrains Mono | 14px default | Bundled via `@fontsource`. User-configurable (`Ctrl++`/`Ctrl+-`/`Ctrl+0`, range 8–32px). |
| UI text (labels, sidebar, connection manager) | Inter, system stack fallback | 13px body, 12px metadata, 11px badges | Inter bundled via `@fontsource` (400/500/600) |
| Sidebar command name (heading) | JetBrains Mono, bold | 16px | Monospace to match terminal context |
| Sidebar code blocks / syntax | JetBrains Mono | 12px | Syntax colouring for optional vs required params |

**Weights.** Only the three Inter weights that ship are used: `regular` (400) for body and prose, `medium` (500) for dense chrome (buttons, chips, badges), `semibold` (600) for every heading and any text carrying the primary label of its region. Nothing in the UI is 700 — Inter 700 is not loaded, so a `700` would be synthesised bold. JetBrains Mono ships 700 and the two places that need it (the command name, the syntax match highlight) use `--font-weight-bold`.

**Leading.** Chrome leadings by role: `display` (1.15) for headings at 20px and up, `title` (1.3) for 14–16px headings and two-line list rows, `meta` (1.45) for 12px secondary lines, `solid` (1) for single-glyph controls, and `body` (1.5) on `body` itself. Body leading deliberately matches `--prose-line-height`'s default so prose is never tighter than the chrome around it; prose that must widen under Reading Comfort keeps `var(--prose-line-height)`, which is the Reading Comfort seam — a tooltip or a description never takes a fixed leading, or it silently loses that bump.

**Tracking.** Only uppercase labels are tracked (`--font-tracking-label`, 0.06em); display headings take `--font-tracking-display` (−0.01em) to offset optical looseness at large sizes; everything else is `--font-tracking-none`. Uppercase exists in one role only — the label — and never in body copy.

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
* **Radii:** 2px / 4px / 6px / 8px (`--radius-2xs/sm/md/lg`), `--radius-pill` for fully rounded
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

The screen is inset `--space-2` (8px) inside the 1px frame on all four sides, so no glyph sits against the border and ghost text on row 0 keeps its pill background and descenders. `.tv-terminal` is `box-sizing: content-box` so FitAddon's `parseInt(getComputedStyle(...).width)` sees the *content* width; under `border-box` Chrome reports the border box there and the inset would be invisible to the fit, hanging the grid past the padding and clipping the last row and column. The timestamps gutter adds its width to the left inset instead of replacing it.

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

**Undocked window.** The panel can also leave the app window entirely and live in its own OS window — the only form of detachment available: nothing floats inside the app window, and only the panel moves, never a terminal tab. `Ctrl+Shift+B` cycles closed → docked → undocked → docked; the Undock control sits in the docked panel's tab strip and the Dock control heads the undocked window's header, both carrying a word beside their icon so the pair reads as one action. Undocked, the terminal takes the full width back through the same fit → PTY resize path a docked panel uses in reverse, and docking restores the panel at its saved width. The undocked window is frameless, like the main window, so its header is the drag region and carries Dock and Close; it is a single instance, and asking for it again reuses it. It never opens itself at launch, even when the app was quit while undocked — the panel stays hidden, and the next open returns to the window at its saved geometry, clamped back onto a visible monitor if that geometry no longer fits.

**Visual hierarchy (top to bottom):**


1. **Command name** — large, bold, monospace, accent color. The heading.
2. **Syntax block** — monospace code block with colour highlighting:
   * Required params (`<name>`) in accent colour
   * Optional params (`[...]`) in warning colour
3. **Description** — body text. Plain language explanation.
4. **Examples** — each in a monospace code block. **Clickable** — clicking an example inserts it into the terminal input (writes to shadow buffer + sends to SSH channel). Hover state indicates interactivity. Each block also carries a small copy button in its top-right corner; copying does not run the command, so the KB viewer (which never runs examples) offers the same affordance.
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
* Each item: matched prefix shown in **bold** accent (e.g. **show ip** interface brief). The
  highlight grows with each character typed, carries into multi-word names, and holds the whole
  name once the line moves on to arguments
* Selected item has highlighted background (accent tint)
* Category shown as muted text right-aligned in each row (e.g. `networking`)
* Surface is translucent (`color-mix` of `--color-surface-elevated` at 50%) with a 4px backdrop
  blur, so the terminal stays faintly present behind the list instead of the panel reading as a
  hole cut in the window. Alpha alone cannot carry this effect here: the blurred dark terminal
  averages to the same luminance as `--color-surface-elevated` (both ≈43), so the composite tone
  measures 43.3 at 100%, 70%, 50% and 35% alike and only the texture behind the fill differs. The
  blur radius is what makes the frost legible — with the fill at 50%, the luminance spread in the
  panel measures 8.9 / 6.1 / 5.2 / 2.7 for a 4 / 6 / 8 / 20px radius against 0.1 for an opaque box —
  so 4px is used: line shapes ghost through as soft bands without turning into readable output.
  With dense output behind it the rows measured a 75-luminance peak behind them, so primary
  text still clears 8:1. The side panel stays opaque, because translucency there would read as an
  overlay (ADR-003). The full measurement, and why the alpha cannot be the dial here, is
  [ADR-023](../adr/023-translucency-reads-through-blur-radius.md)
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

* Transitions 100–300ms, color/opacity only — never layout-shifting scale on container elements (small scale on buttons OK). The navigation below is the one documented exception: its reveal runs 80–120ms, because it answers a keypress and a longer fade reads as lag, and it eases `max-height`/`translate` because the disclosure's height is the thing being revealed.
* **Arrivals settle, departures are instant.** Ghost text, the match-count badge, the suggestion dropdown
  and the side panel's content arrive over 180–220ms on `cubic-bezier(0.22, 1, 0.36, 1)` and disappear in
  the frame they stop matching. A surface that lingers after the input stopped matching misreports what
  the remote will receive, and one that pops in mid-sentence reads as a stutter. Arrivals take the middle
  of the band rather than its floor: a decelerating curve is three-quarters home in its first third, so
  the 120ms first pass was over before the eye read it as motion.
  * The settle belongs to the hidden→shown edge only. `showPayload()` runs on every keystroke while the
    ghost is visible and `updateResults()` re-renders the open dropdown, so a component adds its entrance
    class when the surface opens and clears it on hide. It is never baked into generated markup, where
    each `innerHTML` rebuild would replay it under the next character.
  * Ghost text glyphs never move *while typing* — only opacity interpolates, because the overlay has to
    land on the terminal cell grid. Its entrance additionally rises 3px and lands exactly on the cell, and
    the dropdown rises 8px up to the prompt line. The panel's content settles 10px in from the terminal
    side.
* Chrome tint, progress bar, toast entrance, the terminal frame's focus tint and the navigation are the
  animated transitions. **The side panel's width is not one of them** — it lands in a single frame,
  because the arrow-key resizer calls `applyWidth()` then `fitAddon.fit()` in the same tick, so FitAddon
  would measure the pre-transition width and the grid would settle on the wrong column count. What
  settles in the panel is its content (220ms), when the panel opens or its tab changes; a resize does
  not settle it, since nothing is arriving. Animating the pane itself would show the old terminal
  through it and read as an overlay, which ADR-003 forbids.
* **Terminal focus tint** — the terminal is the app's keystroke surface, so its frame (`.tv-terminal-wrap`) says whether typing lands on the remote: 140ms colour-only transition from the neutral hairline to `--color-focus-ring` while `.tv-terminal` holds `:focus-within`, back to neutral when focus moves to the scrollback search field, the side panel or the toolbar. The match is on `.tv-terminal` rather than the wrap, so search focus — a sibling inside the wrap — reads as "not typing to the remote", which is also the moment xterm hollows its cursor (its default `cursorInactiveStyle: "outline"`). Focus also draws the app's shared focus ring: `--focus-ring-width` at `--focus-ring-offset`, transparent at rest and colour-animated, so the ring appears outside the frame with a clear gap. It sits outside rather than inset because an inset outline at `outline-offset: -1px` paints *over* the border instead of adding to it — measured on the light theme as one device pixel of `#88898a` at rest and one of `#166534` focused, with no ink added. That reads on the dark themes, whose border is a faint 1.8:1 hairline, but not on the light ones, where the border is already a strong 3.3:1 line and is the only thing separating the pane (`#F8FAFC`) from the page (`#E2E8F0`, 1.13:1). Outside, focus goes from no ink beyond the frame to a 2px ring plus a 2px gap in every theme — same light-theme column, three device pixels of `#166534`, three of surface, then the border, against one pixel of `#88898a` at rest. Width and offset are constant, the wrap's 8px margin leaves room for the ring, and no layout moves. `prefers-reduced-motion: reduce` drops the transition; both states remain distinguishable as static colour and extent.
* The navigation animates too, because the nav is where the user's place in the app is decided:
  * nav row hover, keyboard focus and selection tint cross-fade (140–160ms), so switching views hands the highlight from one row to the next instead of blinking it;
  * section expand/collapse eases `max-height` (120ms, decelerating) under an 80ms opacity fade, and a collapsed section sits 2px high so the list drops into place. A closed section is `inert`, so its rows, search field and action buttons leave the tab order the moment it closes rather than when `visibility: hidden` lands;
  * a group's row actions park 2px right and slide to rest as they fade in on hover/focus;
  * the settings rail's pill fades in (160ms, colour only) on a real page change, and its icons nudge 2px on hover. It never scales: render() focuses the new active button, so a transform would carry the focus ring with it.
* Focus indicators never animate — a ring that fades in is a ring that arrives late. A focused row may gain the hover surface, which fades. The terminal frame's ring above is the one exception, and it is colour-only on a frame that is always present.
* Keyboard disclosure skips the reveal: ArrowRight opens a section and focuses its first row in the same tick, so an open section containing focus drops the transition rather than fading its focus ring in with the list. Opening by click or Enter focuses the header (a sibling), so it still animates.
* Everything above is disabled under `prefers-reduced-motion: reduce` (duration *and* delay collapsed to ~0, so every state still lands and no collapsed list hangs around for its reveal).
