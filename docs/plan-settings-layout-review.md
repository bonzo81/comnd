# Plan: Settings Pages — Layout & Form Styling Review Fixes

Status: proposed (not implemented). Source: layout/form review of
`src/components/settings-screen.ts` + `src/styles/components/_settings-screen.css`
(2026-09-01). Color tokens are explicitly out of scope — review confirmed
colors are correct; only layout and form styling change.

## 1. Goal

Fix 4 bugs and 4 layout inconsistencies found in the review, and record 1
structural concern as deferred. All changes are CSS or small TS template
edits in `settings-screen.ts`. No behavior changes, no new abstractions,
no color edits.

## 2. Confirmed decisions

| Question | Decision |
|---|---|
| Colors / tokens touched? | No. `tokens.css` and all `--color-*` values stay as-is. |
| Behavior changes? | None. One conditional-visibility addition (§4.3) is presentational + a11y. |
| Rust changes? | None. |
| Verification | `npm run build` exit 0 + manual visual pass (see §6). |
| Import dialog styles shared? | Yes — `import-*` classes stay shared for now (§5). |

## 3. Bugs (apply first)

### 3.1 Clipped secret-manager block — settings-screen.ts:508

`#netbox-auth-secretref-field` uses `class="auth-conditional ..."` but not
`auth-conditional-tall`. Content (Provider select + Reference input +
"no providers" hint ≈ 150px) exceeds `.auth-conditional` `max-height: 120px`
with `overflow: hidden` (`_modals.css:212`) — the bottom clips when the
"Secret Manager" radio is selected. The host form already fixed this exact
bug (`host-screen.ts:339` uses `auth-conditional-tall`).

- settings-screen.ts:508:
  ```html
  <!-- before -->
  <div id="netbox-auth-secretref-field" class="auth-conditional ${authType === "secret_ref" ? "" : "auth-conditional-hidden"}">
  <!-- after -->
  <div id="netbox-auth-secretref-field" class="auth-conditional auth-conditional-tall ${authType === "secret_ref" ? "" : "auth-conditional-hidden"}">
  ```
- No CSS change — `.auth-conditional-tall` (max-height 260px) already exists
  at `_modals.css:231`.
- While here, note the inner hint uses `.form-hint` where every other
  settings hint uses `.import-hint` — align to `.import-hint` (same look,
  consistent class).

### 3.2 Selects don't look like selects — _modals.css:75

`select.form-input { appearance: none }` strips the native dropdown arrow
and nothing replaces it. ~12 selects across General/Theme/NetBox render as
text boxes — no open affordance.

- Edit `select.form-input` in place (root cause — fixes host form and every
  other `select.form-input` too):
  ```css
  select.form-input {
    appearance: none;
    cursor: pointer;
    padding-right: var(--space-6);
    background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1.5l5 5 5-5' fill='none' stroke='%2394A3B8' stroke-width='1.5'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right var(--space-2) center;
  }
  ```
- `#94A3B8` is a fixed glyph color (SVG data URIs can't use `var()`). It has
  acceptable contrast on every shipped elevated surface (dark, light,
  dracula, monokai, nord, solarized). Decorative glyph, not text — WCAG text
  contrast does not apply. If a future theme needs it themed, swap to a
  `mask-image` + `background-color: var(--color-text-secondary)` trick; do
  not pre-build that now.

### 3.3 Unlabeled, always-visible fallback select — settings-screen.ts:427-442

`#netbox-platform-fallback` has no label (a11y fail — placeholder-style
first option is not a label) and shows even when policy = "Skip device",
where it is meaningless noise.

- Split into its own `.import-field` with a real label, hidden unless
  policy = `fallback` (native `hidden` attribute — zero CSS):
  ```html
  <div class="import-field">
    <label for="netbox-platform-policy">Unknown platform slugs</label>
    <select class="form-input" id="netbox-platform-policy">…</select>
    <span class="import-hint">…existing hint…</span>
  </div>
  <div class="import-field" id="netbox-fallback-field"${cfg?.platform_policy === "fallback" ? "" : " hidden"}>
    <label for="netbox-platform-fallback">Fallback platform</label>
    <select class="form-input" id="netbox-platform-fallback">…</select>
  </div>
  ```
- Visibility toggle in `bindEvents()` (separate from the existing autosave
  listener — keep concerns apart):
  ```ts
  this.container?.querySelector<HTMLSelectElement>("#netbox-platform-policy")?.addEventListener("change", (e) => {
    const on = (e.target as HTMLSelectElement).value === "fallback";
    const field = this.container?.querySelector<HTMLElement>("#netbox-fallback-field");
    if (field) field.hidden = !on;
  });
  ```
- `collectNetboxConfig()` reads `#netbox-platform-fallback` via
  `querySelector` — a `hidden` element is still readable, so autosave is
  unaffected. Blank value + policy `skip` is already handled by the
  `|| null` fallback.

### 3.4 Dead CSS tokens — _settings-screen.css:190, 254

`--color-bg-hover` and `--color-bg` are not defined in any stylesheet
(`tokens.css` has no such names) — the fallbacks always win. Misleading to
future readers.

- Line 190: `var(--color-bg-hover, rgba(255, 255, 255, 0.04))` →
  `var(--color-surface-hover)` (defined in every theme).
- Line 254: `var(--color-bg, #fff)` → `#fff` (matches `.btn-primary` color).

## 4. Layout / form styling

### 4.1 Double spacing on NetBox — _settings-screen.css:158

`.netbox-body { gap: var(--space-3) }` stacks on top of
`.settings-form .import-field { margin-bottom: var(--space-4) }` → 28px
between fields; every other settings page is 16px.

- Drop the gap, let margins do the work:
  ```css
  .netbox-body {
    display: flex;
    flex-direction: column;
  }
  ```
- `netbox-body-disabled` (opacity/pointer-events) unchanged.

### 4.2 Section headings have no separation — _settings-screen.css:49

`.settings-section-title { margin: 0 0 var(--space-4) }` means the gap
above a heading equals the gap between fields — Logging / Terminal / Global
Search / Data Management read as one long form.

- Match the `.shortcuts-section` divider pattern already in the design
  system (`_modals.css:173`):
  ```css
  .settings-section-title {
    font-size: var(--font-size-lg);
    font-weight: 600;
    color: var(--color-text-primary);
    margin: 0 0 var(--space-4);
    padding-top: var(--space-4);
    border-top: 1px solid var(--color-border);
  }

  .settings-section-title:first-child {
    padding-top: 0;
    border-top: none;
  }
  ```
- `:first-child` covers General ("Logging"), Theme ("Appearance"), and
  NetBox ("Instance" — first child of `.netbox-body`).
- Apply together with §4.1 — spacing rhythm must be judged once, combined.

### 4.3 `.import-config-row` padding misaligns buttons — _settings-screen.css:30

The class carries `background: var(--color-surface-primary)` +
`padding: 8px 12px` (`_dialogs.css:140`), designed to contrast against the
import dialog's elevated background. On the settings page (same surface)
the strip is invisible but the padding still indents Test Connection /
Save Connection off the field grid.

- Scope an override in `_settings-screen.css` (do NOT edit
  `.import-config-row` globally — the KB import dialog uses it on an
  elevated background where the strip is intentional):
  ```css
  .settings-form .import-config-row {
    margin-bottom: var(--space-4);
    padding: 0;
    background: none;
  }
  ```
  (replaces the existing 2-line margin-only override at lines 30-32).

### 4.4 Label without a control — settings-screen.ts:281

`<label>Backup & Restore</label>` wraps no input — invalid a11y. The
section heading "Data Management" (§4.2 divider above) plus the
self-explanatory buttons ("Export backup...", "Restore from backup...")
make the label redundant.

- Delete the label line; keep the `.log-file-row` buttons and the
  `.import-hint` below them. Net deletion, no replacement needed.
- If the grouping name is ever missed, use a plain `<span>` with label
  styling — not a control-less `<label>`.

## 5. Structural (deferred — flag only)

Settings reuses `import-*` classes from the KB-import dialog stylesheet
(`_dialogs.css`); `.settings-form .import-field` already patches one
conflict (§4.3 patches another). Restyling the import dialog can silently
shift settings layout. Decouple when convenient: introduce
`settings-field` classes or promote shared field styles to a shared layer.
Do not do this in the same pass as the fixes above — it is a pure rename
with real regression surface and zero user-visible gain today.

## 6. Verification gates

1. `npm run build` — exit 0 (TS edits: §3.1, §3.3, §4.4).
2. Manual visual pass, all five settings pages (General, Theme, Ollama,
   Auth, NetBox) in dark + light theme:
   - NetBox → Secret Manager radio: provider select, reference input, and
     hint fully visible (nothing clipped).
   - Every `select.form-input` shows a chevron and opens; long option text
     doesn't underlap the chevron.
   - Fallback platform select: hidden when policy = Skip, appears on
     Fallback, autosave still writes both values.
   - NetBox field spacing visually matches General page (16px rhythm).
   - Section titles have dividers; first section in each page has none.
   - Test Connection / Save Connection buttons left-align with inputs.
   - Buttons in host form modal unaffected (spot-check chevron addition
     there — it should also now show one).
3. No color values changed — diff should contain no `#`-colors except the
   §3.2 chevron glyph URI and the §3.4 `#fff` literal replacement.

## 7. Suggested order

1. §3.4 + §4.1 + §4.2 + §4.3 — CSS only, one file each, judge NetBox
   spacing after 4.1+4.2 land together.
2. §3.2 — CSS, `_modals.css`, app-wide effect; verify host modal too.
3. §3.1 + §3.3 + §4.4 — TS template + binding edits in
   `settings-screen.ts`.
4. Run §6 gates once at the end.

Total: ~40 changed lines across 3 files. Single commit is fine — no
behavior change anywhere.