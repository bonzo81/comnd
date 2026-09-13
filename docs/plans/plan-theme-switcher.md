# Plan: App Theme + Terminal Theme Switcher

Status: implemented (2026-08-18)

## Decisions (user-confirmed)

- App theme: dark (default) / light — persisted in `localStorage` (`netssh-theme`).
- Terminal theme: **separate** setting from app theme, dark/light for now (more themes later) — persisted in `localStorage` (`netssh-terminal-theme`).
- App theme toggle: button in the app tab bar (`.app-tab-bar`).
- Terminal theme toggle: button in the terminal topbar (`.tv-topbar`), next to `≡ Panel`.
- No keyboard shortcuts (user declined).
- No Rust changes — theme is a UI preference, `localStorage` suffices.

## 1. Tokens (`src/styles/tokens.css`)

Keep `:root` as the dark palette (default). Add a `[data-theme="light"]` block
overriding the color tokens:

- Surfaces: `--color-surface-primary: #F8FAFC` (slate-50), `--color-surface-secondary: #F1F5F9` (slate-100), `--color-surface-elevated: #FFFFFF`, `--color-surface-hover: rgba(0,0,0,0.05)`, `--color-surface-selected: rgba(22, 163, 74, 0.12)`
- Text: `--color-text-primary: #0F172A`, `--color-text-secondary: #475569`, `--color-text-tertiary: #94A3B8`
- Accent: `--color-accent: #16A34A` (darker for contrast on light), `--color-accent-hover: #15803D`
- Borders: `--color-border: rgba(0,0,0,0.08)`, `--color-border-hover: rgba(0,0,0,0.14)`
- Shadows: lighter black-alpha (e.g. `--shadow-md: 0 4px 12px rgba(0,0,0,0.12)`)
- Platform tints (`--tint-*`): keep, they read fine on light.

Promote hardcoded literals to tokens so they adapt per theme (define in `:root`,
override in `[data-theme="light"]` where needed):

| New token | Dark value (current) | Light value | Replaces |
|---|---|---|---|
| `--overlay-backdrop` | `rgba(0,0,0,0.6)` | `rgba(15,23,42,0.4)` | `_dialogs.css:37`, `_modals.css:5`, `_command-palette.css:5` (`0.7` — unify to token) |
| `--overlay-solid` | `rgba(15,23,42,0.92)` | `rgba(248,250,252,0.92)` | `_overlays.css:5` |
| `--suggestion-fade` | `rgba(24,24,37,0.8)` | `rgba(248,250,252,0.8)` | `_suggestion.css:79` |
| `--badge-nxos` | `#38BDF8` | `#0284C7` | `_terminal-view.css:294` |
| `--accent-tint-soft` | `rgba(34,197,94,0.12)` | `rgba(22,163,74,0.12)` | `_command-palette.css:85`, `_terminal-view.css:342` |

Leave as-is (read fine on both themes): `_overlays.css:76` scrim `rgba(0,0,0,0.3)`,
`_overlays.css:115` error tint, `_buttons.css:4` `color: #fff` (accent bg is
green in both themes), dialog box-shadows (black-alpha shadows work on light).

## 2. Theme module (new `src/lib/theme.ts`, ~50 lines)

Single source of truth:

```ts
export type Theme = "dark" | "light";

// App theme — localStorage["netssh-theme"], sets documentElement.dataset.theme,
// dispatches window CustomEvent "netssh:theme"
export function getAppTheme(): Theme
export function setAppTheme(t: Theme): void

// Terminal theme — localStorage["netssh-terminal-theme"], dispatches
// window CustomEvent "netssh:terminal-theme"
export function getTerminalTheme(): Theme
export function setTerminalTheme(t: Theme): void

// xterm.js ITheme per terminal theme. Extension point for future themes.
export const TERMINAL_THEMES: Record<Theme, ITheme> = {
  dark:  { background: "#0F172A", foreground: "#F8FAFC", cursor: "#22C55E", selectionBackground: "#1E293B" },
  light: { background: "#F8FAFC", foreground: "#0F172A", cursor: "#16A34A", selectionBackground: "#E2E8F0" },
};
```

`ITheme` imported from `@xterm/xterm`.

## 3. App wiring (`src/main.ts`)

- Constructor (before first paint, right after `this.container = ...`):
  `setAppTheme(getAppTheme())` — applies persisted theme, no flash.
- `renderTabBar()` (line 80): after the two `.app-tab` divs, append
  `<button class="btn-text app-theme-btn">` with icon `☀`/`🌙` (show the theme
  you'd switch TO, or current — pick one, be consistent). Own click listener
  (tab bar's existing handler only reacts to `.app-tab` class, no conflict):
  click → `setAppTheme(next)`, update icon. Listen for `netssh:theme` event to
  keep icon in sync.

## 4. Terminal view (`src/components/terminal-view.ts`)

- `initTerminal()` (line 148): `theme: TERMINAL_THEMES[getTerminalTheme()]`
  (replaces hardcoded object at line 151).
- New public method:
  ```ts
  setTerminalTheme(t: Theme) {
    if (this.terminal) this.terminal.options.theme = TERMINAL_THEMES[t];
  }
  ```
  xterm 5.5 applies `options.theme` live.
- Topbar template (line 362): add `<button class="btn-text tv-theme-btn">`
  before `≡ Panel`. Own listener: cycle dark→light, `setTerminalTheme(next)`
  (persists + dispatches), update icon. Listen for `netssh:terminal-theme` to
  keep icon in sync (covers future programmatic changes).
- Import `Theme`, `TERMINAL_THEMES`, `getTerminalTheme`, `setTerminalTheme`
  from `../lib/theme`.

## 5. CSS literal cleanup (values tokenized in step 1)

- `_dialogs.css:37` → `var(--overlay-backdrop)`
- `_modals.css:5` → `var(--overlay-backdrop)`
- `_command-palette.css:5` → `var(--overlay-backdrop)`
- `_overlays.css:5` → `var(--overlay-solid)`
- `_suggestion.css:79` → `var(--suggestion-fade)`
- `_terminal-view.css:294` → `var(--badge-nxos)`
- `_command-palette.css:85`, `_terminal-view.css:342` → `var(--accent-tint-soft)`
- `_buttons.css:4` (`color: #fff`) — leave; accent bg is green in both themes.

## 6. Icons

Text glyphs only (`☀` / `🌙`), consistent with existing text buttons
(`← Back`, `≡ Panel`, `✕ Close`). No icon dependency.

## Skipped (deliberate)

- Rust `AppConfig` theme field + Tauri commands — `localStorage` covers UI prefs.
- Keyboard shortcut — user declined.
- "Match app theme" terminal option — deferred; `TERMINAL_THEMES` map is the
  extension point for future themes.

## Verification

- `npm run build` (runs `tsc`) exits 0.
- Manual:
  - Toggle app theme → all chrome flips (tab bar, host list, KB screen, dialogs,
    command palette, suggestion bar); persists across app restart.
  - Toggle terminal theme in topbar → xterm bg/fg/cursor flip live; persists;
    works with multiple session tabs (each reads persisted value on init).
  - Light mode readability pass: host screen, KB screen, modals, palette,
    suggestion dropdown, terminal overlay.
