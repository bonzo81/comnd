# Reading Comfort Mode (Dyslexia Mode)

User-facing name: **Reading Comfort**. Internal shorthand: dyslexia mode.

A preset toggle that applies evidence-based readability settings for dyslexic
readers (and anyone who finds text hard to read), then exposes every value as
an individual control. Built from: W3C COGA note, WebAIM cognitive guidance,
BDA style guide, Zorzi 2012 (letter spacing), Rello (line height), W3C
eye-tracking colour study. See "Research basis" at the end for what was
deliberately not adopted.

## Scope and non-goals

**In scope:** live rendering of terminal + UI chrome — typography, spacing,
tint themes, suggestion contrast.

**Out of scope:**
- Session logs, replay data, anything persisted from the terminal — the mode
  affects what the user *sees*, never operational records.
- Ligature work: xterm.js v5 WebGL renderer does not apply OpenType ligatures,
  so JetBrains Mono's ligatures never render in the terminal. No code needed.
- OpenDyslexic or other "dyslexia fonts": no objective evidence; font choice
  is handled by the ordinary theme/font system.
- New global shortcuts: the toggle is a button until the shortcut registry
  (spec 11) lands.
- Reduced-motion handling: the app has no significant animation today.

## Mode semantics

1. **ON** stamps a preset into individual settings (see table), including a
   recommended theme for the terminal and app chrome.
2. Every stamped value is immediately adjustable as its own control.
   The preset is an initialiser, not a lock.
3. **OFF** reverts typography to the pre-mode values; the user's theme choice
   is kept (the preset only *recommended* a theme once).
4. Setting is persisted and reachable from every screen: Settings pane +
   a status bar toggle button (`aria-pressed`).

**Theme stamping rules** (COGA 4.9.1 — never surprise-overwrite a deliberate
choice):

- Terminal theme: stock `dark` → **warm charcoal**; stock `light` → **cream**.
  (Terminal currently has only stock themes.)
- App theme: if currently `light` or `solarized-light` → `solarized-light`
  (cream-family, already shipped). Dark-axis themes (dark, dracula, monokai,
  nord) are left alone.

## Preset values

| Control | Default (off) | Preset (on) | Range |
|---|---|---|---|
| Terminal font size | 14px | 16px | 8–32px |
| Terminal line height | 1.0 | 1.4 | 1.0–1.8 |
| Terminal letter spacing | 0 | +2px | 0–6px |
| UI text scale | 1.0 | 1.15 | 1.0–1.5 |
| Ghost text opacity | 0.6 | 0.85 | fixed bump, no slider |
| Ghost variable tokens | 0.45, italic | 0.7, no italic (dashed underline carries the distinction) | fixed bump |
| Suggestion dropdown rows | ~8 | 5 max (COGA ≤5 visible choices) | fixed bump |
| Prose word spacing | normal | 0.1em | fixed bump |
| Prose line height | 1.5 | 1.6 | fixed bump |
| Prose max width | none | 68ch (help panel + KB descriptions; never the terminal) | fixed bump |

Terminal line height stays conservative (1.4, not prose's 1.6): rows get too
airy at terminal densities and cell height feeds ghost-text positioning.

## Persistence

Two localStorage keys, matching the theme precedent (presentational →
localStorage, never config.json):

- **`netssh-terminal-font-size`** — always present, mode-independent. Fixes
  the spec-03 drift where `Ctrl++`/`Ctrl+-`/`Ctrl+0` zoom was session-only:
  those shortcuts now read/write this key. Terminal font size has ONE source
  of truth; the mode stamps into it like any other writer.
- **`netssh-reading-comfort`** — flat object, created on first ON, kept
  across OFF (an `enabled` flag flips; values survive the toggle cycle):
  ```json
  { "enabled": true, "prevFontSize": 14, "lastFontSize": 16,
    "uiScale": 1.15, "lineHeight": 1.4, "letterSpacing": 2 }
  ```
  - `ON` (first time): snapshot current terminal font size into
    `prevFontSize`, stamp preset values everywhere.
  - `ON` (re-enable): snapshot font size into `prevFontSize`, restore the
    user's remembered values — sliders and `lastFontSize` (the size last
    used while on), not the preset. Themes re-stamp every ON.
  - `OFF`: restore font size from `prevFontSize`, record the current size
    into `lastFontSize`, flip `enabled` off. Derived typography tokens
    return to defaults because nothing overrides them.
  - **Reset to preset** button: rewrite all preset values (font size → 16).
  - Corrupt JSON → treated as off (fresh first-ON path).

"OFF reverts typography" is honoured exactly: `prevFontSize` is the only
rollback state; no per-knob dirty tracking.

## Derived tokens (no forked palette)

The mode never overrides the 50+ colour tokens — that would mirror every
future theme edit forever. Instead:

- `tokens.css` font-size tokens become
  `calc(<base>px * var(--text-scale))` with `--text-scale: 1` declared in
  `:root` (tokens are always defined — no var() fallbacks); the mode sets
  `--text-scale`. All six themes inherit the scaling with zero mirroring.
- New derived tokens with defaults: `--ghost-opacity: 0.6`,
  `--prose-word-spacing: normal`, `--prose-line-height: 1.5`.
  Component CSS consumes the tokens; the mode sets overrides on
  `documentElement`.
- A few fixed behaviour switches (variable-token italics off, dropdown
  max-height, prose max-width) use one attribute:
  `document.documentElement.dataset.readingComfort = "on"`. This is for the
  non-slider bumps only — it is not a theme layer.

## Terminal themes

`TERMINAL_THEMES` (theme.ts) gains two entries; the theme button cycles four
states instead of toggling two:

| id | Background | Foreground | Notes |
|---|---|---|---|
| `dark` | `#0F172A` | `#F8FAFC` | existing stock dark |
| `light` | `#F8FAFC` | `#0F172A` | existing stock light |
| `cream` | `#F7F0DC` | `#1A1A1A` | warm off-white; W3C study: dyslexic readers read fastest on black-on-cream |
| `warm-charcoal` | `#1A1A1F` | `#EDEDED` | softens both ends: no pure #000/#fff, reduces halation |

Cycle order: dark → warm charcoal → cream → light. Button `aria-label` names
the current theme and the next ("Terminal theme: Cream — click for Light") so
the four states stay keyboard/screen-reader legible. Cream and warm charcoal
are ordinary theme-list entries, independently reachable, not mode property.

xterm.js already supports `lineHeight` and `letterSpacing` options; ghost text
positions off live `cellHeight`, so spacing changes flow through with no
extra plumbing. Font size/spacing changes re-fit the terminal and send the
PTY resize, same path the sidebar drag already exercises (architecture rule 4).

## Settings UI

Settings pane **Reading Comfort** (settings-screen.ts dispatch + nav entry):

- Mode toggle at top. Off state shows one sentence: what the mode does.
- Controls appear beneath when enabled (progressive disclosure — greyed-out
  disabled controls read as clutter; COGA ≤5 visible choices).
- Sliders: terminal font size, terminal line height, terminal letter
  spacing, UI text scale. Native range inputs, live apply on drag, styled via
  the existing `.form-input` conventions (layout-only classes, no new input
  CSS system).
- **Reset to preset** button beside the toggle.
- Description mentions dyslexia explicitly for discovery:
  "Recommended settings for dyslexic readers and anyone who finds text hard
  to read."

Status bar gains a Reading Comfort toggle button next to the theme toggle:
`aria-pressed`, icon state, one click from every screen. A cog button on the
same status-bar control opens a quick-adjust dropup with the four sliders +
reset (live apply, same events as the settings pane; sliders disabled while
the mode is off), so adjustments never require leaving the current screen.

## Implementation notes

- `src/lib/reading-comfort.ts` — pure module: get/set, `stampPreset()`,
  `revert()`, apply-to-DOM/xterm. Vitest coverage for stamp/revert/rollback
  (verification requirement: `npm run test`).
- `terminal-view.ts` — fontSize field replaced by persisted key; theme button
  becomes 4-cycle; options wiring for lineHeight/letterSpacing.
- `tokens.css` — calc-scale font tokens + new derived tokens.
- `_suggestion.css` — ghost opacity/italics consume derived tokens;
  dropdown max-height under the mode attribute.
- Prose contexts (side-panel help, KB descriptions) get the word-spacing,
  line-height, max-width tokens.

## Cross-doc updates

- `AGENTS.md` docs table: add row for this spec.
- `03-ui-visual-design.md`: correct the "persisted" claim (now true, via
  `netssh-terminal-font-size`); document 4 terminal themes.
- `accessibility.md`: Reading Comfort section + note the status bar toggle
  in the ARIA inventory.
- `CONTEXT.md`: glossary entry added (Reading Comfort mode).

## Verification

- `npm run build` exits 0 (runs tsc).
- `npm run test` exits 0 (vitest: stamp/revert/rollback).
- Manual:
  1. Toggle on → typography applies live, terminal re-fits, PTY resizes.
  2. Restart app → mode + all values persist.
  3. Sliders live-apply while dragging; ghost text repositions with cell height.
  4. Toggle off → typography reverts to pre-mode values; themes stay.
  5. Dracula user toggles on → app theme untouched; terminal goes warm charcoal.
  6. Ctrl+/- persists across restart, mode on or off.
  7. NVDA announces toggle state; four-state theme button announces clearly.

## Research basis (adopted vs rejected)

Adopted: larger font size (strongest effect), increased letter/word spacing
(Zorzi ~0.1em ≈ 1.6px at 16px; conservative +2px start), line height 1.4–1.5
(Rello), cream/warm-tinted backgrounds over pure white/black (W3C eye
tracking: only ~14% of dyslexic participants preferred black-on-white),
halation mitigation on dark themes (off-white on charcoal, never #fff-on-#000),
no italics (BDA), suggestion/autocomplete as accessibility feature (COGA
endorses it explicitly — this app's core is already dyslexia-aligned),
≤5 visible choices (COGA 4.6.3), 60–70ch prose measure.

Rejected: OpenDyslexic (no objective evidence), forced monolithic preset with
no individual controls (individual variation is large — every source converges
on this), forked `[data-dyslexia]` colour layer (maintenance tax on every
future theme edit; settings-driven derived tokens instead).