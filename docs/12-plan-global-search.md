# Plan: Global Search Box (Titlebar)

Status: implemented
Date: 2026-08-18

## Goal

A single search box in the center of the titlebar that searches **either** hosts
**or** knowledge-base commands — never both at the same time. A small switch in
the box selects the mode. Results render in a dropdown below the search box,
overlaying the content area. Arrow keys / Tab navigate results; Enter activates:

- **Host result** → connect to that host (`App.onConnect`)
- **Command result** → open KB view with that command's detail panel selected

## Decisions (agreed)

| Question | Decision |
|---|---|
| Focus shortcut | `/` — currently advertised as the nav-panel host-search shortcut. Move it to the global search box; remove the `(/)` hint from the nav host search. |
| Mode switch | Segmented toggle inside the search box: `Hosts` \| `Commands`. Switching mode clears the query and results. |
| Command detail target | `KbScreen` deep-link: switch to KB view (browse tab), select the platform, select the command so the detail panel shows it. |
| Commands scope | All platforms at once (the titlebar box has no platform context). |
| Dead code | Delete `src/components/command-palette.ts` + `src/styles/components/_command-palette.css` (unreferenced; its Ctrl+K claim is stale). |

## Current state (what exists today)

- **Titlebar** — `src/main.ts:154` `renderTitleBar()`: `[net.sh]` left,
  `.title-bar-controls` right (`?`, theme, min/max/close). CSS in
  `src/styles/main.css:19` — 32px tall, `-webkit-app-region: drag`.
- **Hosts** — `getHosts()` (`src/lib/tauri-api.ts:92`) returns all hosts.
  Connect = `App.onConnect(host)` (`src/main.ts:230`).
- **KB commands** — `listKbPlatforms()` + `getAllKbCommands(platform)`
  (`src/lib/tauri-api.ts:238,242`). No cross-platform search endpoint.
- **Command detail** — rendered inside `KbViewerDialog`
  (`src/components/kb-viewer-dialog.ts:198` `renderDetailPanel()`), embedded in
  `KbScreen` (`src/components/kb-screen.ts:162`). No public deep-link method —
  `selectedCommand` is private state.
- **`command-palette.ts`** — dead. Never imported. It's a shortcuts-reference
  modal, not a real search.
- **`/` shortcut** — `NavPanel.focusSearch()` (`src/components/nav-panel.ts:105`)
  exists but is **never called** from any keydown handler; the placeholder
  `"Search hosts… ( / )"` (`nav-panel.ts:240`) advertises a shortcut that
  doesn't fire. The shortcuts modal in `main.ts:453` also lists it.

## Changes

### 1. New component — `src/components/global-search.ts`

`class GlobalSearch` with constructor
`(onConnect: (host: Host) => void, onOpenCommand: (platform: string, cmd: Command) => void)`.

**DOM** (appended into the titlebar between title and controls):

```
.title-bar-search            (flex:1, no-drag, centered)
  .title-bar-search-toggle   (segmented: [Hosts][Commands])
  input.title-bar-search-input
.title-bar-search-results    (fixed-position dropdown, created once, hidden)
```

- Results panel: `position: fixed`, `top: 32px` (titlebar height), left-aligned
  to the search input's left edge (measured on open), `z-index` above content,
  max-height 40vh, scrollable.
- Result row: icon + primary label + secondary line.
  - Host: `display_name` / `hostname:port`
  - Command: `name` / `platform · category`

**Behavior**

- Debounce input ~120ms before filtering/rendering.
- **Hosts mode**: fetch `getHosts()` once (cache; refresh not critical —
  re-fetch on each open is fine, it's cheap). Filter by
  `display_name`, `hostname`, `tags`.
- **Commands mode**: on first use, load all platforms
  (`listKbPlatforms()` then `getAllKbCommands(p)` per platform, in parallel),
  cache in memory. Filter by `name`, `aliases`, `description`, `tags`.
  `ponytail:` in-memory cache of all commands — fine at KB scale; add a
  Rust-side search command only if the KB grows to tens of thousands of
  entries.
- Toggle switch: two buttons; active one highlighted. Switching clears query +
  results, keeps focus in the input.
- Empty query → no dropdown. No matches → "No results" row.

**Keyboard** (on the input)

| Key | Action |
|---|---|
| `↑` / `↓` | Move selection (wrap). Also opens the dropdown if closed and there are results. |
| `Tab` | Move focus into the results list (first/selected row). Then `↑`/`↓` navigate, `Enter` activates, `Shift+Tab`/`Escape` back to input. |
| `Enter` | Activate selected row (or first result). |
| `Escape` | Close dropdown + blur input. |

Mouse: click a row to activate; `mouseleave` on the whole widget (input +
dropdown) after a short delay closes the dropdown.

**Activation**

- Host → `onConnect(host)`, close + clear.
- Command → `onOpenCommand(platform, cmd)`, close + clear.

### 2. KB deep-link — `KbScreen` + `KbViewerDialog`

- `KbViewerDialog.selectCommandByName(name: string): boolean` — find the
  command in `this.commands`, set `selectedCommand` + `selectedIndex`,
  `render()`. Returns false if not found. (~8 lines, reuses existing render.)
- `KbScreen.openCommand(platform: string, cmd: Command)`:
  1. If `activeTab !== "browse"` → `switchTab("browse")`.
  2. If `selectedPlatform !== platform` → `selectPlatform(platform)` (reloads
     commands), then select by name.
  3. If same platform → `viewerDialog.selectCommandByName(cmd.name)`.
  4. Guard: viewer dialog may still be loading — if `viewerDialog` is null,
     queue the selection and apply it after `loadBrowseTab()` completes.

### 3. `main.ts` wiring

- `renderTitleBar()`: create the search widget between the title and the
  controls; wrap in a `flex: 1` container with `-webkit-app-region: no-drag`.
  Callbacks:
  - `onConnect: (h) => this.onConnect(h)`
  - `onOpenCommand: (p, c) => { this.showView("knowledge-base"); this.kbScreen.openCommand(p, c); }`
- `registerGlobalShortcuts()`: add `/` handler — if the active element is not
  already a text input/textarea, `preventDefault()` and focus the search input
  (selecting its contents). Replaces the dead nav-`/` behavior.
- Update the shortcuts modal list (`main.ts:453`): `/` → "Focus global search".

### 4. Nav panel — drop the stale `/` hint

- `src/components/nav-panel.ts:240`: placeholder
  `"Search hosts… ( / )"` → `"Search hosts…"`.
- Delete `NavPanel.focusSearch()` (`nav-panel.ts:105`) — never called, and its
  purpose is superseded. Keep `clearSearch()` (still referenced? verify at
  build time; delete if orphaned).

### 5. Delete dead command palette

- `src/components/command-palette.ts`
- `src/styles/components/_command-palette.css`
- `@import` line in `src/styles/main.css:13`

### 6. CSS — `src/styles/components/_global-search.css`

Imported in `main.css`. Tokens from `tokens.css` only.

- `.title-bar-search` — flex row, gap 4px, height 24px, centered in the
  `flex:1` wrapper, `no-drag`.
- `.title-bar-search-input` — flex:1, transparent bg, 1px border
  `var(--color-border)`, 4px radius, 12px font, `var(--color-text-primary)`;
  focus: accent border.
- `.title-bar-search-toggle` — segmented pair, 12px font, active segment
  `var(--color-surface-hover)` bg.
- `.title-bar-search-results` — `var(--color-surface)` bg, 1px border,
  8px radius, shadow, min-width 280px, max-height 40vh, overflow auto.
- Row: 28px min-height, 12px horizontal padding, 13px primary / 11px
  tertiary secondary; selected/hover: `var(--color-surface-hover)` bg.
- Follow existing `_command-palette.css` patterns for the list (it's being
  deleted, but its structure is the model).

## Out of scope

- No Rust-side search endpoint (in-memory filter is sufficient).
- No fuzzy matching — substring `includes()` on the fields above.
- No search history / recents.
- No per-platform filter in the Commands mode.

## Verification

- `npm run build` (runs `tsc`) exits 0.
- Manual: `/` focuses the box from any view (not while typing in another
  input). Hosts mode finds a host by name → Enter connects. Switch to
  Commands → type a command name → Enter opens KB view with that command's
  detail panel visible. `↑`/`↓`/`Tab`/`Enter`/`Escape` behave as specified.
  Dropdown overlays content, never the titlebar. Window still draggable from
  titlebar areas outside the search widget.
