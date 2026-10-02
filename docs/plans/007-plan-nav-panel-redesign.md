# Plan: Left Nav Panel Redesign

Replace the top app tab bar (Connections / Knowledge Base) with a persistent left
navigation panel available on all screens. Accordion behavior: one section expanded
at a time; expanding a section switches the content view.

## Target layout

```
┌─────────────────────────────────────────────────────────┐
│ Title bar: [app title]        [? shortcuts] [theme] [—][□][✕] │
├──────────────┬──────────────────────────────────────────┤
│ NAV PANEL    │  Content area (full width)               │
│              │                                          │
│ ▸ Connections│  ┌ Connections view:                    │
│ ▾ Knowledge  │  │  search + host list (full width)     │
│   cisco-iosxe│  ├ KB view:                             │
│   cisco-nxos │  │  [Browse KB | Import KB] tabs +      │
│   f5-tmos    │  │  viewer/import content               │
│   linux-bash │  ├ Settings view:                       │
│ ▸ Settings   │  │  placeholder items                   │
│              │  └ Terminal view: session tabs + terminal│
└──────────────┴──────────────────────────────────────────┘
```

- Panel visible on **all** views (connections, terminal, KB). No section highlighted
  while in terminal.
- Exactly one section expanded at a time (accordion); clicking a header expands it
  and collapses others, and switches the content view.
- `?` shortcuts + theme toggle move from the (removed) tab bar into the title bar,
  next to the window controls.

## Decisions (confirmed)

| Question | Decision |
|---|---|
| `?` shortcuts + theme toggle | Move to title bar, next to min/max/close |
| Nav panel in terminal view | Panel stays visible, no section active |
| `+ New Connection` / add-group buttons | Under Connections section, top of sub-items |
| Scope | Full redesign: remove tab bar + in-screen sidebars |
| Connections content | Host list (search + list) full width; groups only in nav |
| KB Browse/Import tabs | Stay as content tabs at top of KB content area |
| `Ctrl+,` | Wire to expand Settings section (fixes dead command-palette entry) |
| Keyboard nav | Arrows up/down through visible items, Enter activates, Left collapses / Right expands section, roving tabindex |

## Changes by file

### 1. New `src/components/nav-panel.ts` — `NavPanel` class

- Renders `.nav-panel` with three section headers: Connections, Knowledge Base, Settings.
- Connections sub-items: `+ New Connection` button, add-group button, "All Hosts"
  pseudo-group, then recursive group tree (reuse `renderGroupNode` logic from
  host-screen.ts; `ALL_GROUP_ID` from `src/lib/host-filters.ts`).
- KB sub-items: platform list from `listKbPlatforms()`, with `PLATFORM_META` badges.
- Settings sub-items: static placeholders (e.g. "General", "Ollama / KB Import",
  "Shortcuts") styled as disabled / coming-soon.
- Accordion state: `activeSection` + `expandedGroups` Set; one section open at a time.
- Emits selection events: `onSelectGroup(groupId)`, `onSelectPlatform(platform)`,
  `onNewConnection()`, `onAddGroup()`, `onSelectSettings(id)`.
- Keyboard: arrows up/down through visible items, Enter activates, Left collapses
  section, Right expands; roving tabindex.

### 2. `src/main.ts`

- Remove `renderTabBar()` / `updateTabBar()`; add `renderNavPanel()` mounting
  `NavPanel` into `#app` as a flex sibling before the view wrappers. `#app` becomes
  a row: nav panel + a column stack holding the three view wrappers.
- Move `?` shortcuts + theme toggle buttons into `renderTitleBar()`.
- `showView()` keeps display-toggle behavior; content views now fill the right column.
- Wire nav callbacks:
  - group select → `HostScreen.setGroup()` + ensure connections view
  - platform select → `KbScreen.selectPlatform()` + ensure KB view
  - new connection → existing host form flow
  - settings select → show settings placeholders
- Wire `Ctrl+,` → expand Settings section.
- `Ctrl+Shift+K` still toggles KB view — now also expands KB section.
- Terminal: no nav section active; panel stays visible.

### 3. `src/components/host-screen.ts`

- Strip `.hs-group-panel` from layout — keep only search + host list, full width.
- Expose public `setGroup(groupId)` so the nav panel drives selection.
- Extract shared group-tree builder (recursive `parent_id` nesting, expand/collapse)
  so `NavPanel` can reuse it.
- `+ New Connection` handler stays here; nav panel triggers it via callback.

### 4. `src/components/kb-screen.ts`

- Strip `.kb-sidebar` — keep only `.kb-content` (Browse/Import tabs + panels), full width.
- Expose `selectPlatform()` publicly (already exists) so the nav panel drives it.

### 5. CSS

- New `src/styles/components/_nav-panel.css`: panel width ~240px, section headers
  (chevron + label), sub-items with indent, selected state, disabled/placeholder state.
- `base.css` / `main.css`: `#app` layout change to row; title bar right-side controls.
- Remove `.app-tab-bar` styles from `_kb-screen.css`.
- Remove `.hs-group-panel` styles from `_host-screen.css`.
- Remove `.kb-sidebar` styles from `_kb-screen.css`.

### 6. `src/components/command-palette.ts`

- `Ctrl+,` entry becomes real (handler lives in main.ts); verify entry text matches.

## Data flow notes

- Groups/hosts and platforms already load in their screens; `NavPanel` calls the
  same `getHostGroups()` / `listKbPlatforms()` (cheap local IPC; own fetch is fine).
- Group tree nesting (`parent_id`) and descendant filtering already in
  `src/lib/host-filters.ts` — reuse.

## Out of scope (YAGNI)

- No real Settings implementation — placeholders only.
- No session list inside nav (terminal stays as-is).
- No drag-to-reorder groups (doesn't exist today).

## Verification

- `npm run build` (runs `tsc`) exits 0.
- Manual checks:
  - Accordion: one section expanded at a time; header click switches view.
  - Panel visible on all views incl. terminal; no section active in terminal.
  - Connections view: host list full width; group select filters list.
  - KB view: platform select drives viewer; Browse/Import tabs intact.
  - Settings: placeholders render, disabled styling.
  - Keyboard: arrows/Enter/Left/Right through nav; `Ctrl+,` and `Ctrl+Shift+K` work.
  - Title bar: `?` and theme toggle work from new location.
