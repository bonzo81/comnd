# Plan: Settings Screen Redesign — Icon Nav + SettingRow Layout

Status: **approved (option A — reuse `--radius-pill`, no new radius
token)** and implemented. Supersedes
[020-plan-settings-layout-review.md](020-plan-settings-layout-review.md),
whose fixes landed in `d1c8486` + `eb421e9` and whose five verification
checks are carried into §8 below as done-checks for this rewrite.

## 1. Goal

Replace the Settings screen's single centered column with:

- a **left icon nav** — flat, borderless items, active item a filled pill —
  switching between 8 pages: general, logging, theme, reading-comfort,
  llm, auth, netbox, shortcuts;
- a **content pane** of `SettingRow` components: label + short description
  left, control right-aligned on the same baseline.

Booleans become pill toggles (native checkbox restyled — mechanism
unchanged), value controls become compact right-aligned selects/buttons,
bold section headings and divider rules are replaced by small muted group
labels separated by whitespace only, and the big per-page `h2` title is
removed.

Frontend only. No Rust changes — if `src-tauri` is touched, stop and
report before proceeding.

## 2. Context corrections (from repo inspection 2026-10-19)

Two facts discovered while drafting, which adjust the original brief:

1. **Plan 020 is already implemented.** All five of its checks are
   verifiably in place in the current tree:
   - NetBox secret-ref block renders through `credential-fieldset.ts` with
     `auth-conditional auth-conditional-tall` — no clipping (020 §3.1).
   - `#netbox-fallback-field` exists with a real `<label>` and `hidden`
     gating on `platform_policy === "fallback"` (020 §3.3).
   - No `--color-bg-hover` / `--color-bg` references remain (020 §3.4).
   - No control-less `<label>` elements remain (020 §4.4).
   - `select.form-input` shows a chevron (`_modals.css` `select.form-input`
     block) (020 §3.2).

   This rewrite must **preserve** all five; §8 re-verifies them.

2. **Inputs, selects, and buttons are already pill-shaped app-wide.**
   `eb421e9` set `.form-input`, `select.form-input`, and the `.btn`
   classes to `border-radius: var(--radius-pill)`. A new
   `--radius-control: 10px` scoped to settings would make settings
   controls *less* round than identical inputs in the host form and
   dialogs, and would require overriding the shared `.form-input` radius
   inside settings.

   **Decision (confirmed by user):** **A** — no new token; every settings
   control uses the existing `--radius-pill` (already applied app-wide via
   `.form-input` / `.btn`); pill toggles also use `--radius-pill`.

## 3. Layout

### 3.1 Shell

```
┌──────────────────────────────────────────────────────────────┐
│ Comnd          [search]        [↻?][↓?][⚙][– □ ×]           │
├──────────┬───────────────────────────────────────────────────┤
│ [app nav │ ┌─────────┐ Settings content pane                 │
│  panel,  │ │ ▤ General│                                      │
│  no      │ │ ▥ Logging│  GROUP LABEL                         │
│  settings│ │ ▣ Theme  │  Label   [control]                   │
│  section]│ │ …        │  desc                                │
│          │ └─────────┘                                       │
└──────────────────────────────────────────────────────────────┘
```

`.settings-screen` becomes `display: flex`:

- `.settings-nav` — labeled rail (~200px). One `<button>` per page
  (icon + text label, `data-item-id`, `aria-current` on the active page).
  No borders on items; active item is a **filled pill** (same treatment
  as the nav panel's active sub-items: `--color-surface-selected`
  background + accent color/text).
- `.settings-page` — content pane, `max-width: 720px`, left-aligned,
  `var(--space-8)` padding. The old centered `560px` column is removed
  (an icon rail beside a centered column reads off-balance).
- The nav panel has **no Settings section** — the entry point is the
  title-bar cog (permanent, left of minimize, tooltip "Settings"; the
  conditional update indicator sits left of it). The rail is the single
  page switcher.

### 3.2 SettingRow

```html
<div class="settings-row">
  <div class="settings-row-text">
    <label class="settings-row-label" for="…">Show empty folders</label>
    <span class="settings-row-desc">Also refresh the host tree…</span>
  </div>
  <div class="settings-row-control">
    …control…
  </div>
</div>
```

- Label + description stacked left; control right-aligned on the same
  baseline (`align-items: center`).
- Group labels: `<div class="settings-group-label">Logging</div>` —
  `--font-size-xs`, `--color-text-secondary`, whitespace separation only.
  `h3.settings-section-title` and its `border-top` divider rules are
  deleted.
- No `h2.settings-title` per page.

### 3.3 Controls

- **Booleans → pill toggle.** The existing `<input type="checkbox">` is
  restyled in place: `appearance: none`, ~32×18px track with
  `border-radius: var(--radius-pill)`, thumb via `::before`, `:checked`
  shifts the thumb and fills the track with `--color-accent`. **Mechanism
  unchanged** — same element, same IDs, same `.checked` bindings — so no
  test edits are needed. (Deviation from a rebuilt control is deliberate:
  tests and autosave depend on the native checkbox.)
- **Value controls** (selects, buttons): compact and right-aligned —
  `.form-input-sm` / small `btn` variants, never full-width. Text inputs
  compose the shared `.form-input` classes; no hand-rolled input styles.
- **One flagged exception:** the NetBox filter multi-select (`ms-*` chips
  box) keeps full width — it cannot function as a compact right-aligned
  control.

## 4. Icons

Reuse `src/lib/icons.ts` (Lucide paths, `svg()` helper, 24×24,
`stroke="currentColor"`). Two additions via the same helper:

| Page | Icon | Source |
|---|---|---|
| General | `sliders` | existing |
| Logging | `fileText` | **add** (Lucide `file-text`) |
| Theme | `paintbrush` | existing |
| Reading Comfort | `type` | **add** (Lucide `type`) |
| LLM API / KB Import | `bot` | existing |
| Auth Integrations | `lock` | existing |
| NetBox | `netbox` | existing |
| Shortcuts | `keyboard` | existing |

## 5. Sync (icon nav ⇄ main nav panel)

- **Nav panel → icon nav:** `main.ts` `showView()` calls
  `settingsScreen.setItem(this.settingsItemId)`; `setItem` re-renders and
  the rail highlights the new item.
- **Icon nav → main.ts:** the `onItemChanged` callback updates
  `settingsItemId` so re-opening Settings shows the last page. The nav
  panel has **no Settings section** — the entry point is the title-bar
  cog (main.ts `renderTitleBar`), which calls `showView("settings")`;
  there is no nav-panel callback or highlight to sync.
- **Keyboard:** roving tabindex in the icon nav mirroring
  `nav-panel.ts` (§ Keyboard: roving tabindex): Up/Down/Home/End move
  focus, Enter/Space activate (native buttons). Active item `tabIndex: 0`,
  others `-1`. The global `*:focus-visible` rule (`main.css`) provides the
  visible ring — WCAG 2.1 AA per `docs/specs/accessibility.md`.
- `setItem()` keeps its current contract: synchronous render for
  non-auth/netbox pages (tests depend on the timing), async load-then-
  render for `auth`/`netbox`.

## 6. Files to change, in order

1. `src/lib/icons.ts` — add `fileText`, `type`.
2. `src/components/settings-screen.ts` — render shell (icon nav + pane),
   SettingRow/group-label refactor of all 8 pages, pill toggle restyle
   class, `onItemChanged` callback, icon-nav keyboard handler. Preserve
   all element IDs, `.netbox-body` class, and `setItem` semantics.
3. `src/main.ts` — wire `onItemChanged` (§5).
4. `src/styles/components/_settings-screen.css` — rewrite: shell, icon
   nav, rows, group labels, pill toggle; restyle page-specific blocks
   (provider cards, netbox device list, ms-*, shortcuts) to compose with
   rows. Tokens only (`--space-*` grid); theme-agnostic — verify against
   dark, light, dracula, monokai, nord, solarized.
5. `docs/specs/03-ui-visual-design.md` — update "Content column" line
   (Settings 560px → new layout) and the Screens entry; add a "Settings
   Screen Layout" section (icon rail, SettingRow anatomy, pill toggles,
   group labels, radius decision).
6. `docs/plans/020-plan-settings-layout-review.md` — header note:
   superseded by this plan; fixes landed in `d1c8486`/`eb421e9`, layout
   replaced — see spec 03.

**Not changing:** `src-tauri/**`, element IDs, `nav-panel.ts` internals,
test files, theme color values.

## 7. Verification gates

1. `npm run build` — exit 0. Paste final output.
2. `npm run test` — exit 0. Paste final output.
3. Re-verify the five carried 020 checks (§2.1) by grep/read.
4. Cannot visually verify — user does the click-through:
   - all 8 pages render in the new layout in all 6 themes;
   - pill toggles work, selects show chevrons, controls right-aligned;
   - sync both directions (nav-panel sub-item → icon nav, icon nav →
     sub-item highlight), including keyboard;
   - focus ring visible on icon-nav items.

## 8. Done-checks carried from plan 020

1. NetBox "Secret Manager" block does not clip when the radio is selected.
2. NetBox fallback-platform select has a real label and shows only when
   policy = fallback.
3. No references to undefined tokens (`--color-bg-hover`, `--color-bg`).
4. No control-less `<label>` elements.
5. Selects show an open affordance (chevron) via `select.form-input`.
