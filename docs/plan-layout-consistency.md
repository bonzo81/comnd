# Plan: Layout Consistency Fixes (Medium + Low Priority)

Status: done. All medium- and low-priority findings implemented and
verified with `npm run build` (exit 0). Kept for history; no open items
remain. The two `padding: var(--space-5)` bodies (`.import-form`,
`.import-result`, `.import-error`) were unified to `--space-6` to match
`.modal-panel`; `.import-header` horizontal padding to `--space-6` to
match. Selected states now all use background `--color-surface-selected`
plus 1px accent outline (offset -1px): `.nav-selected`, `.hs-host-selected`,
`.hs-browse-item-active`, `.kb-command-selected`, `.suggestion-item.selected`,
`.ms-item-selected`; `.title-bar-search-row.selected` keeps its reserved-
border variant (border, not outline, for the documented no-layout-shift
reason). Preview secondary-line indents derive from one custom property
`--preview-gutter` on `.preview-row` instead of magic 46px/22px.

Verification gates per `AGENTS.md`: `npm run build` must exit 0. No Rust
changes in this plan.

## 1. Goal

Retire the duplicate layout systems that accreted across later features
(replay, NetBox, import preview) so every screen speaks the same layout
language: `--space-*` tokens on the 4px grid (docs/03), one overlay
pattern, one form rhythm, one selected-state language, one empty-state
pattern, and a documented z-index ladder.

## 2. Medium priority — system drift

### 2.1 Two spacing systems + wrong token names in `_replay.css`

`src/styles/components/_replay.css` — the whole file uses literal px
(`20px`, `14px`, `12px`, `10px`, `8px`, `6px`) instead of `--space-*`
tokens, and references token names that do not exist in `tokens.css`:
`--border-default`, `--text-primary`, `--text-secondary`, `--color-danger`.
Every one silently falls back to a hardcoded hex.

Fix: rewrite spacing against `--space-*` tokens and replace the wrong
token names with the real ones (`--color-border`, `--color-text-primary`,
`--color-text-secondary`, `--color-error`). Delete the fallback hexes.

### 2.2 Same dialect in the `ms-*` block of `_settings-screen.css`

`src/styles/components/_settings-screen.css` (multi-select styles) — uses
`--color-surface`, `--color-text`, `--color-accent-dim` (none exist; the
fallback hexes are from the Catppuccin palette, not app tokens), plus
`!important` overrides on `.ms-search`.

Fix: same as 2.1 — real tokens, no fallbacks, remove `!important` by
resolving the specificity conflict properly.

### 2.3 `.import-field` spacing differs per screen

`.import-field` is `margin-bottom: var(--space-3)` in `_dialogs.css` but
overridden to `--space-4` in `_settings-screen.css`. Same class, different
rhythm depending on screen. Related: dialog body padding is
`--space-6` (`.modal-panel`) vs `--space-5` (`.import-form`).

Fix: pick one spacing per shared class, delete the overrides.

### 2.4 Two overlay systems with different geometry

`.modal-backdrop` (`_modals.css`) — `padding-top: 8vh`,
`backdrop-filter: blur(4px)`.
`.import-overlay` (`_dialogs.css`) — `padding-top: 6vh`, no blur.
Same dialog archetype, different vertical position and depth treatment.

Fix: make the import/KB-viewer dialogs use `.modal-backdrop`; delete
`.import-overlay` (or reduce it to an alias). Note: KB viewer and import
dialog render `.import-overlay` markup, so the class name must change in
`kb-viewer-dialog.ts` and `kb-import-dialog.ts`, or the CSS selector must
be updated — check both TS components when doing this.

### 2.5 Full-page centered views: arbitrary widths, mixed units

`.settings-page` — `max-width: 560px`, token padding.
`.replay-screen` — `max-width: 900px`, `padding: 20px` px.

Fix: decide and document one content-column scale (e.g. narrow forms
560px, wide lists 900px is acceptable — but write it into docs/03 and use
tokens for all padding).

### 2.6 Status bar heights disagree

`.statusbar` (`main.css`) — fixed `height: 26px`.
`.tv-statusbar` (`_terminal-view.css`) — `min-height: 28px`.
Two adjacent chrome bars, 2px apart — visible seam when both visible.

Fix: both `min-height: 28px` (or one shared height), tokens not px.

### 2.7 Selected-state language inconsistent across lists

Selection is signaled differently per list:
- `.hs-host-selected`, `.kb-command-selected`: background + 1px accent
  outline.
- `.nav-selected`, `.cm-host-selected`-successor states: background only.

Fix: one language everywhere — background `--color-surface-selected` plus
1px accent `outline` (offset `-1px`) — applied to `.nav-selected` and any
other background-only selected states. Sweep all list-like components for
selected states when doing this and align any that differ.

## 3. Low priority — hygiene

### 3.1 z-index scale undocumented

Current values (as of the review): 20 (ref combo), 30 (terminal search
bar), 40 (disconnect banner), 50 (connecting overlay), 100 (modal
backdrops + `ms-dropdown`), 200 (context menu + search results dropdown),
1000 (toasts), 9999 (drag clone). Nothing records the tiers, so each new
overlay guesses.

Fix: one comment block in `tokens.css` defining the ladder (e.g.:
10 title bar chrome · 20 inline dropdowns · 30–50 in-terminal layers ·
100 modal · 200 floating menus · 1000 toasts · 9999 drag clone), then
align existing values to it where they are off-tier.

### 3.2 Duplicate `.toast-with-action` blocks

`_overlays.css` defines `.toast-with-action` twice: once as a grid
(`grid-template-areas` for icon/message/close/action rows) and once again
as a flex row (`align-items: center; gap`). Two competing layout models in
one file; the later flex block partially overrides the grid.

Fix: delete the second block; keep the grid (it implements the documented
row-1/row-2 action-toast layout).

### 3.3 `.nav-section-items` defined twice

`_nav-panel.css` defines `.nav-section-items` in two separated blocks: one
for the collapse animation (`max-height`/`visibility` transitions), one
for padding. Works, but the two halves of one rule should be merged for
maintainability.

Fix: merge into a single rule block (keep the `ponytail:` comment on the
`max-height` ceiling intact).

### 3.4 Literal px off the 4px grid

docs/03 mandates a 4px grid; exceptions found:
- `.import-mode-toggle` — `padding: 2px`, `gap: 2px`.
- `.token-type-badge` / `.token-source-badge` — `font-size: 10px`,
  `padding: 0 4px`, `margin-left: 4px`.
- `.preview-why`, `.preview-compare` — `margin-left: 46px` / `22px` magic
  indents (alignment under a 14px/22px checkbox column).
- `.nav-row-actions` — `gap: 2px`.
- `.ms-chips`, `.ms-chip`, `.ms-item` (see also 2.2) — 2/4/6/8/12/13px mix.

Fix: where the value is genuinely half-grid (2px gaps between tight
chips), it may stay but should use a named token or be documented as an
intentional exception; the magic indents (`46px`, `22px`) should be
derived from the checkbox column width, not hardcoded.

### 3.5 Two empty-state patterns

`.cm-empty-state` (`_connection-manager.css`) — centered padded block,
no border.
`.rsm-empty` (`_replay.css`) — dashed-border box.
Two visual languages for the same concept.

Fix: one pattern. Given the review's other findings, the centered block
matches the app's dominant pattern; either restyle `.rsm-empty` as a
centered block or extract a shared `.empty-state` class.

## 4. Suggested order

1. 2.1 + 2.2 + 3.4 together — one "rewrite px dialects into tokens" pass
   across `_replay.css` and the `ms-*` block.
2. 2.4 — overlay unification (touches two TS components, verify clicks).
3. 2.3 + 2.5 + 2.6 — rhythm/geometry alignment.
4. 2.7 — selected-state sweep across all list components.
5. 3.1–3.5 — hygiene items, can be done opportunistically.

## 5. Verification

- `npm run build` exits 0 after each step.
- Manual smoke: open each screen (connection manager / host screen,
  terminal + sidebar, replay, KB screen + viewer + import dialog, settings
  incl. NetBox dialog) and each overlay (toasts, context menu, global
  search dropdown, delete confirms) — no clipped or overflowing content,
  no layout shift on keyboard navigation.
- Confirm the deleted/renamed classes in 2.1/2.2 have no remaining
  references: `grep -r "border-default\|text-primary\|color-surface,"
  src/styles` style search over renamed tokens.