# Plan: Reading Comfort Mode (Dyslexia Mode)

Status: planned (2026-09-14). Implements `docs/specs/12-dyslexia-mode.md` —
the spec owns the what/why (mode semantics, preset values, research basis);
this plan owns the how (phases, files, touch points). Values quoted here are
convenience copies; the spec's "Preset values" table is the source of truth —
if they disagree, fix the plan.

## Decisions (user-confirmed)

- User-facing name: **Reading Comfort**. Internal shorthand: dyslexia mode.
- Toggle = preset *initialiser*, not a lock: ON stamps defaults, every value
  stays individually adjustable via sliders.
- OFF reverts typography only; the user's theme choice is kept.
  `prevFontSize` (snapshotted at ON) is the sole rollback state — no per-knob
  dirty tracking.
- Persistence: localStorage only (`comnd-reading-comfort`,
  `comnd-terminal-font-size`), same pattern as `src/lib/theme.ts`.
  Never `config.json`. Zero Rust changes.
- No forked `[data-dyslexia]` colour layer (maintenance tax on every future
  theme edit). Instead: `--text-scale` calc pattern for font-size tokens +
  derived tokens (`--ghost-opacity` etc.) + one `data-reading-comfort`
  attribute for the fixed non-slider bumps.
- Terminal themes grow to four (`dark`, `warm-charcoal`, `cream`, `light`),
  cycled by the toolbar button; new entries are ordinary theme ids, not mode
  property.
- Theme stamping on ON touches stock ids only: terminal `dark`→
  `warm-charcoal`, `light`→`cream`; app `light`/`solarized-light`→
  `solarized-light`. Third-party app themes (dracula/monokai/nord) untouched.
- Fixed bumps, no sliders: ghost opacity 0.85, variable-token italic removed
  (dashed underline carries the distinction), dropdown ≤5 rows, prose
  word-spacing + 68ch measure.
- No new global shortcuts — the toggle is a button until the shortcut
  registry lands (`docs/specs/11-shortcut-customization.md`).
- No dyslexia-branded fonts (OpenDyslexic etc. — evidence rejected, spec
  "Research basis"). Existing Inter + JetBrains Mono stay.

Line numbers below were verified against the working tree on 2026-09-14;
they will drift. Re-locate by symbol name, not by number.

Sequencing: independent of the untracked KB architecture cleanup series
(`plan-kb-false-seams` → … → `plan-kb-split-modules`, phases 0–6) — that
series is Rust-heavy plus `suggestion-engine.ts`; this plan is zero-Rust
frontend and touches only suggestion *styles* (`_suggestion.css`). Safe to
sequence before, after, or interleaved with it. Decided order: this plan
first (user-visible value; the KB series then runs uninterrupted 0→6).

Phases are ordered to stay green: each phase leaves `npm run build` +
`npm run test` exiting 0.

## Phase 1 — Terminal font size persistence

Fixes a documented drift: `docs/specs/03-ui-visual-design.md` promises
`Ctrl++`/`Ctrl+-`/`Ctrl+0` zoom is persisted, but `terminal-view.ts` kept
`fontSize = 14` as an un-persisted field, so the claim was false. One source
of truth for terminal font size, mode-independent.

New module `src/lib/terminal-prefs.ts` (follows the `output-highlight.ts` /
`timestamps.ts` toggle pattern — localStorage key + window CustomEvent):

```ts
const SIZE_KEY = "comnd-terminal-font-size";
export const TERMINAL_FONT_MIN = 8;
export const TERMINAL_FONT_MAX = 32;
export const TERMINAL_FONT_DEFAULT = 14;

export function getTerminalFontSize(): number   // parse + clamp, default 14
export function setTerminalFontSize(px: number): void  // clamp, store, dispatch
  // dispatches window CustomEvent "comnd:terminal-font-size"
```

`terminal-view.ts` changes (touch points verified against current code):

- Field `fontSize = 14` (line 146): becomes `getTerminalFontSize()` at init.
- `initTerminal()` (line 215): `fontSize: getTerminalFontSize()`.
- `zoomIn()/zoomOut()/zoomReset()` (lines 1485–1507): replace the private
  field mutation with `setTerminalFontSize(n ± 2)` (clamped), then apply:
  `terminal.options.fontSize`, `syncTerminalChrome()`, `fitAddon.fit()`.
  Extract the apply into one private `applyFontSize(px)` so all callers share it.
  (Post-implementation simplification: the three zoom wrappers were deleted —
  main.ts calls `setTerminalFontSize` directly at the three shortcut sites;
  the `comnd:terminal-font-size` event + `applyFontSize` path is unchanged.)
- New handler `fontChangeHandler` (mirror `themeChangeHandler`, line 150):
  listen for `comnd:terminal-font-size`, re-apply to this terminal. Keeps
  every session tab in sync when the settings slider writes the value.
  Register in `initTerminal()`, remove in `destroy()` (where
  `themeChangeHandler` is removed today).

Note `syncTerminalChrome()` (line 1404–1410) already reads `this.fontSize` —
keep the field, but make it always mirror the persisted value.

## Phase 2 — Terminal themes: cream + warm charcoal, 4-cycle

`src/lib/theme.ts`:

- `TerminalTheme` type: `"dark" | "light" | "cream" | "warm-charcoal"`.
- `getTerminalTheme()`: validate stored id against the 4-entry list
  (same `APP_THEMES.some` pattern app themes already use), default `"dark"`.
- `TERMINAL_THEMES` gains:
  - `cream`: background `#F7F0DC`, foreground `#1A1A1A`, cursor `#16A34A`,
    selectionBackground `#D9D0BC` (cream-shifted slate selection).
  - `warm-charcoal`: background `#1A1A1F`, foreground `#EDEDED`,
    cursor `#22C55E`, selectionBackground `#3A3A42`.
- Export `TERMINAL_THEME_ORDER: TerminalTheme[]` =
  `["dark", "warm-charcoal", "cream", "light"]` (cycle order, spec §Terminal
  themes; palette hex values live in the spec's theme table).

`terminal-view.ts`:

- Theme button (`syncThemeIcon`, lines 538–545): 4-state cycle via
  `TERMINAL_THEME_ORDER.indexOf`. Icon per state (`icons.ts` — reuse
  existing sun/moon; add two glyph states or icons if needed, plain text
  glyphs acceptable per spec 03 iconography). `aria-label` pattern:
  `"Terminal theme: Cream — click for Light"` (current → next), same
  `setToggleState`/`aria-pressed` treatment as today.
- `getTerminalTheme()` call sites that assume binary
  (`getTerminalTheme() === "dark"`) — line 539 is the only one; the 4-cycle
  replaces it.

`syncTerminalChrome()` (line 1408) reads `TERMINAL_THEMES[...]` by key —
already generic, no change.

Timestamp gutter background also reads the theme — verify no hardcoded
slate assumption (check `_terminal-view.css` `.timestamps` classes).

## Phase 3 — Derived tokens + mode attribute CSS

`src/styles/tokens.css`:

- Font-size tokens become scale-aware (one block, all themes inherit —
  this is the maintenance keystone, spec §Derived tokens):
  ```css
  --font-size-2xs: calc(10px * var(--text-scale, 1));
  --font-size-xs:  calc(11px * var(--text-scale, 1));
  --font-size-sm:  calc(12px * var(--text-scale, 1));
  --font-size-base: calc(13px * var(--text-scale, 1));
  --font-size-lg:  calc(14px * var(--text-scale, 1));
  --font-size-xl:  calc(16px * var(--text-scale, 1));
  --font-size-2xl: calc(20px * var(--text-scale, 1));
  ```
- New derived tokens in `:root` (defaults = mode-off values):
  `--ghost-opacity: 0.6;`, `--ghost-variable-opacity: 0.45;`,
  `--prose-word-spacing: normal;`, `--prose-line-height: 1.6;`
  (1.6 already the prevailing prose value — token just names it),
  `--prose-max-width: none;`.

`_suggestion.css`:

- `.ghost-text` (line 5): `opacity: 0.6` → `opacity: var(--ghost-opacity)`.
- `.ghost-text--variable` (line 22): `opacity: 0.45` →
  `var(--ghost-variable-opacity)`; drop `font-style: italic`.
- `.ghost-text--choice`/`--literal` (lines 29–36): use
  `var(--ghost-opacity)` (choice may keep a slight offset — one token if
  identical, else leave choice at `--ghost-opacity` and delete the override).
- Dropdown cap (fixed bump, spec §Preset values): add
  ```css
  [data-reading-comfort="on"] .suggestion-dropdown { max-height: <5 rows>; }
  ```
  replacing the current `calc(8 * ...)` (line 59) for mode-on only.

Prose contexts — token consumers (word spacing, line height, measure):
`.cmd-detail` (side-panel help, `_terminal-view.css:229` — already
`line-height: 1.6`, switch to `var(--prose-line-height)`), KB description
blocks (`_kb-screen.css`), `.import-hint` (settings). Apply
`word-spacing: var(--prose-word-spacing)` and
`max-width: var(--prose-max-width)` to these classes. Never the terminal
output (`.tv-terminal` stays untouched by prose tokens).

## Phase 4 — `reading-comfort.ts` module

New `src/lib/reading-comfort.ts`, pure logic + DOM application. The vitest
surface (AGENTS.md: frontend logic with test files → `npm run test`).

```ts
export interface ReadingComfortState {
  prevFontSize: number;   // captured at ON, sole rollback state
  uiScale: number;        // --text-scale, 1.0–1.5
  lineHeight: number;    // xterm lineHeight, 1.0–1.8
  letterSpacing: number; // px, 0–6
}
const KEY = "comnd-reading-comfort";

export const RC_PRESET = { fontSize: 16, uiScale: 1.15, lineHeight: 1.4, letterSpacing: 2 };

export function isReadingComfortEnabled(): boolean
export function enable(): void   // snapshot fontSize → prevFontSize, write preset
  values, applyReadingComfort(), stamp themes per spec §Mode semantics
export function disable(): void   // restore fontSize from prevFontSize, remove
  key, clear DOM (remove attribute, remove property overrides)
export function update(partial: Partial<ReadingComfortState>): void  // slider path
export function resetToPreset(): void  // rewrite preset over all fields
export function getReadingComfortState(): ReadingComfortState | null
export function applyReadingComfort(): void
  // document.documentElement.style.setProperty("--text-scale", ...)
  // document.documentElement.dataset.readingComfort = "on" | remove
  // dispatch "comnd:reading-comfort" so terminal-view re-applies
  //   terminal options (lineHeight/letterSpacing live on xterm)
```

Theme stamping (inside `enable()`; rules from spec §Mode semantics):

- Terminal: stored theme `"dark"` → `setTerminalTheme("warm-charcoal")`,
  `"light"` → `setTerminalTheme("cream")`. (Only stock ids get stamped —
  after Phase 2 these are 2 of 4; `cream`/`warm-charcoal`/anything else
  stays.)
- App: `getAppTheme()` in `{"light","solarized-light"}` →
  `setAppTheme("solarized-light")`, else untouched.

`disable()` reverts typography only: fontSize from `prevFontSize`; scale/
attribute removal returns derived tokens to `:root` defaults. Theme choice
persists — nothing to revert.

Terminal live options (`lineHeight`, `letterSpacing`) are xterm options, not
CSS — `terminal-view.ts` listens for `comnd:reading-comfort` +
`comnd:terminal-font-size` and writes `this.terminal.options.{lineHeight,
letterSpacing, fontSize}` then re-fits (fit → PTY resize — existing
`onResize` path, architecture rule 4). One handler covers both events or two
thin ones, whichever matches the file's existing pattern.

Vitest `src/lib/reading-comfort.test.ts` (localStorage mocked as in other
lib tests): ON stamps preset + theme swap rules; OFF restores prevFontSize,
leaves theme; reset rewrites; update() clamps ranges; corrupt JSON → null →
treated as off.

## Phase 5 — Settings pane + status bar toggle

`nav-panel.ts` `SETTINGS_ITEMS` (line 49): insert
`{ id: "reading-comfort", label: "Reading Comfort", ready: true }` after
`theme`.

`settings-screen.ts`:

- `LABELS` (line 39): `reading-comfort: "Reading Comfort"`.
- Render dispatch (line 144 chain): add
  `: this.itemId === "reading-comfort" ? this.renderReadingComfort()`.
- New `renderReadingComfort()` — progressive disclosure (spec §Settings UI):
  - Off: toggle + one sentence ("Recommended settings for dyslexic readers
    and anyone who finds text hard to read.").
  - On: toggle, four sliders (terminal font size 8–32, line height 1.0–1.8
    step 0.1, letter spacing 0–6, UI text scale 1.0–1.5 step 0.05), each with
    visible `<label>` (COGA 4.5.6 — labels next to controls), live value readout,
    then "Reset to preset" `.btn-text` button.
  - Sliders: native `<input type="range">` + `input` event →
    `update({...})` — live apply on drag (Phase 4 already wires the event
    to terminal re-fit). Layout-only classes +
    existing input conventions; no new input CSS system.
  - Toggle → `enable()`/`disable()` + re-render pane.
  - Listen for `comnd:reading-comfort` to re-render if the status bar
    button toggled while the pane is open.

`main.ts` `renderStatusBar()` (line 429): after `spacer`, add
Reading Comfort toggle button (`.statusbar-item.sb-rc`, `aria-pressed`,
`setToggleState` pattern, icon via `icons.ts`). Sync on the
`comnd:reading-comfort` event + on `refreshStatusBar()`. Reachable from
every screen (status bar is global chrome).

## Phase 6 — Docs + verification

- `docs/specs/accessibility.md`: add status-bar toggle + settings pane to
  the ARIA inventory lines (the section exists; extend, don't duplicate).
- `docs/specs/03-ui-visual-design.md`: already updated with the persistence
  key + 4-theme note — verify no stale "dark/light only" claims remain
  (grep `dark/light` in that file).
- `docs/user-guide/08-settings.md`: add Reading Comfort section (what the
  mode does, the four sliders, reset, status-bar button).
- Shortcuts modal (`renderShortcutsModal`, main.ts:583): Ctrl+0 reset label
  now accurate (persisted); no new entries.

## Verification gates (per AGENTS.md)

- `npm run build` (runs tsc) — exit 0 after every phase.
- `npm run test` (vitest) — exit 0; new `reading-comfort.test.ts` covers
  stamp/revert/rollback/corrupt-state.
- Manual checklist (spec §Verification, all 7 items): toggle live-apply +
  re-fit + PTY resize; restart persistence; slider drag live-apply with
  ghost repositioning; OFF revert typography/themes stay; Dracula-user
  terminal stamp; Ctrl+/- persists; NVDA announces toggle + 4-state theme
  button labels.
- No `cargo check` needed — zero Rust changes.

## Skipped (deliberate — rationale in spec "Scope and non-goals" and "Research basis")

- Ligature disabling (xterm WebGL renderer never applies OpenType ligatures).
- OpenDyslexic/Atkinson font bundling (font choice = ordinary theme system).
- Global shortcut for the toggle (waits for shortcut registry, spec 11).
- Reduced-motion handling (no significant animation exists).
- Word/letter-spacing CSS on terminal output (grid constraint — xterm
  `letterSpacing` option covers it).