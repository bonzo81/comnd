# Plan: User-Definable Keyboard Shortcuts (Shortcut Customization)

Status: planned (2026-10-11). Implements `docs/specs/11-shortcut-customization.md`
— the spec owns the what/why (fixed vs mappable, registry shape, settings
capture flow, macOS rules); this plan owns the how (phases, files, touch
points, exact seams). Where this plan and the spec disagree, fix the plan —
except where noted under "Decisions", where the plan corrects the spec.

Line numbers below were verified against the working tree on 2026-10-11;
they will drift. Re-locate by symbol name, not by number.

Sequencing: frontend-heavy plus one small Rust addition (`config.rs` field +
command). Overlap risk with concurrent terminal/suggestion work is limited
to phase 4 (`terminal-view.ts`, `suggestion-controller.ts`); phases 1–3 and
5–6 are additive. Phases are ordered to stay green: each leaves
`npm run build` + `npm run test` (+ `cargo check --all-targets` where Rust
is touched) exiting 0.

## Decisions (user-confirmed, plus one spec correction)

- **Ctrl+N is a real new binding** (spec "Also decided"): routes through
  the existing seam — `showView("connections")` + `hostScreen.
  openNewConnection()` — exactly the nav panel's `onNewConnection` callback
  body (main.ts:198-201). No new form logic.
- **Ctrl+Shift+Q disconnect = the close-tab path**: confirm dialog then
  `tab.view.disconnect()` (closeTab, main.ts:733-744, reuses
  `showCloseConfirm`). `close-session-tab` and `disconnect` are two registry
  ids with one behaviour; both were promised by the old help modal, and the
  spec keeps both. Not redundant to merge — the ids are the user-visible
  labels.
- **Spec correction — one new Tauri command is required.** The spec's
  persistence section says "No new Tauri commands — the existing config
  get/save path covers it." False in code: there is no whole-`AppConfig`
  save. Every section persists through its own command
  (`set_max_sessions` config.rs:494, `save_llm_settings` :434,
  `set_log_level` :455, …). Shortcuts follow the same pattern with a new
  `set_shortcuts` command (phase 1). The spec line is corrected by this
  plan.
- **Ctrl+Space stays UI-locked but registry-resolved.** `modLocked` makes
  it non-editable in Settings, but the byte branch in `routeKeystroke`
  still consults the registry (`ctrlByteForCombo(resolvedCombo(...))`),
  so a hand-edited `config.json` override works and the combo has a single
  source of truth. The settings lock is a UI guard, not a matcher guard.
- **No new dependency**: hand-rolled matcher (spec; package.json has no
  keybinding library).

## Phase 1 — Registry + matcher + config plumbing (pure refactor)

### New `src/lib/shortcuts.ts`

```ts
export type ShortcutAction =
  | "open-settings" | "toggle-kb" | "close-session-tab"
  | "font-zoom-in" | "font-zoom-out" | "font-zoom-reset"
  | "toggle-suggestions" | "scrollback-search"          // terminal scope
  | "focus-search" | "shortcuts-modal";                // bare keys
// Phase 5 adds: "new-connection" | "disconnect".

export type ShortcutScope = "global" | "terminal";
export type ShortcutSection = "navigation" | "view" | "terminal"; // UI grouping

export interface ShortcutDef {
  id: ShortcutAction;
  label: string;               // shown in modal + settings rows
  defaultKey: string;          // canonical, platform-agnostic: "Mod+Shift+K"
  scope: ShortcutScope;
  section: ShortcutSection;
  bareKeyOnly?: boolean;       // "/" and "?": only when target is not an input
  modLocked?: boolean;         // Ctrl+Space: pinned to Ctrl; UI-locked
}

export const SHORTCUT_DEFS: ShortcutDef[];
```

Defaults (spec §User-mappable registry; the spec table is the source of
truth for combos): `open-settings` `Mod+,`, `toggle-kb` `Mod+Shift+K`,
`close-session-tab` `Mod+Shift+W`, `font-zoom-in` `Mod+=`, `font-zoom-out`
`Mod+-`, `font-zoom-reset` `Mod+0`, `toggle-suggestions` `Ctrl+Space`
(modLocked), `scrollback-search` `Mod+Shift+F`, `focus-search` `/`,
`shortcuts-modal` `?`. Section proposal (labels adjustable, mechanism is
the contract): navigation = `open-settings`, `focus-search`; view =
`toggle-kb`, `shortcuts-modal`, zoom trio; terminal = `close-session-tab`,
`scrollback-search`, `toggle-suggestions`.

Core API:

- `platformMod(): "Ctrl" | "Cmd"` — via `navigator.platform`/`userAgent`.
- `parseCombo(e: KeyboardEvent): string` — canonical string. Letters
  uppercased (`Ctrl+Shift+K` arrives as `"K"`, `Ctrl+k` as `"k"` — both
  canonicalize). `e.key === "+"` canonicalizes to `Mod+=` so the zoom-in
  match accepts `=` and `+` exactly like today's handler (main.ts:973).
  Modifier order: `Mod`, `Shift`, `Alt`, then key. Bare keys → the key
  itself (`"/"`, `"?"`).
- `formatCombo(combo: string): string` — display label: `Ctrl+Shift+K` on
  Windows/Linux, `⌘⇧K` with platform symbols on macOS (spec §macOS).
- `matches(e: KeyboardEvent, scope: ShortcutScope): ShortcutAction | null`
  — Mod matches `ctrlKey` on Windows/Linux, `metaKey` on macOS;
  `modLocked` defs match `ctrlKey` on every platform. `bareKeyOnly` adds
  the existing gate: `document.activeElement` is not an input/textarea
  (carries the check from main.ts:1010-1012, :1020-1022 into the matcher).
  Unknown/invalid overrides fall back to the default.
- `resolvedCombo(id): string` — override ?? `defaultKey`.
- `ctrlByteForCombo(combo: string): string | null` — single-Ctrl combos to
  their control byte (`Ctrl+Space` → `"\x00"`, `Ctrl+O` → `"\x0F"`,
  Ctrl+Shift+letter collapses to the same byte; `chr(code & 0x1f)`).
  `null` for anything else (Cmd combos, multi-key) — binding is inert in
  the terminal byte path (documented; only reachable by hand-editing
  config, since the UI locks this def).
- `initShortcuts(): Promise<void>` — `getAppConfig()` → seed overrides map.
  Called once at app boot, before `registerGlobalShortcuts()` (main.ts:
  220). Until it resolves, `matches()` runs on defaults — no race.
- `setOverrides(map: Record<string, string>): void` — replace overrides,
  dispatch `netssh:shortcuts` CustomEvent (same pattern as
  `netssh:reading-comfort`, `netssh:terminal-font-size`).

### Rust: config field + command

- `AppConfig` (config.rs:14) gains, after `host_sources` (:57), following
  the existing `#[serde(default)]` HashMap pattern:

  ```rust
  /// User keyboard shortcut overrides (docs/specs/11). Key = shortcut
  /// action id, value = platform-agnostic canonical combo,
  /// e.g. "toggle-kb" -> "Mod+Shift+K".
  #[serde(default)]
  pub shortcuts: std::collections::HashMap<String, String>,
  ```

- `ConfigStore::save_shortcuts` (mirror `save_max_sessions` :277):

  ```rust
  pub fn save_shortcuts(
      &mut self,
      overrides: std::collections::HashMap<String, String>,
  ) -> Result<(), String> {
      self.config.shortcuts = overrides;
      self.persist()
  }
  ```

- Command (mirror `set_max_sessions` :494):

  ```rust
  #[tauri::command]
  pub async fn set_shortcuts(
      overrides: std::collections::HashMap<String, String>,
      state: tauri::State<'_, AppState>,
  ) -> Result<(), String> {
      let mut config = state.config.lock().map_err(|e| e.to_string())?;
      config.save_shortcuts(overrides)
  }
  ```

- `lib.rs` invoke_handler: add `config::set_shortcuts,` beside
  `config::set_max_sessions` (:386).

### Frontend plumbing

- TS `AppConfig` (tauri-api.ts:311): add
  `shortcuts?: Record<string, string>;` and
  `setShortcutOverrides(overrides): Promise<void>` →
  `invoke<void>("set_shortcuts", { overrides })`.
- main.ts: `void initShortcuts()` at boot; `registerGlobalShortcuts()`
  (:931) becomes: the **Ctrl+W guard stays hardcoded and first** (never a
  registry action — AGENTS.md rule 6, spec Fixed table), then
  `const action = matches(e, "global")`, then a `switch (action)` whose
  cases call the exact code paths of today: toggle-KB block (:934-945),
  settings (:949-952), close-tab (:964-969), zoom trio (:973-996),
  focus-search (:1020), shortcuts-modal (:1010). The bare-Escape
  view-return (:999-1007) stays hardcoded — not a registry action (fixed
  cascade semantics; the modal shell also owns Escape).
- Delete the per-combo `if` chains; nothing user-visible changes.

### Tests — `src/lib/shortcuts.test.ts` (co-located, vitest)

`parseCombo` canonicalization (letter case, `=`/`+`, bare keys);
`platformMod` under mocked `navigator`; `matches` on defaults, override
wins + old combo stops matching, `bareKeyOnly` input-focus gate,
`modLocked` ignores platform Mod; `formatCombo` per platform;
`ctrlByteForCombo` incl. null cases; `setOverrides` dispatches
`netssh:shortcuts`; unknown ids in a hand-edited map are ignored.

Gate: `npm run build`, `npm run test`, and `cargo check --all-targets` in
`src-tauri/` all exit 0.

## Phase 2 — Registry-driven help modal + status bar button

- `renderShortcutsModal()` (main.ts:876): replace the hardcoded array
  (:881-897) with generation from `SHORTCUT_DEFS` — group by `section`,
  row = `formatCombo(resolvedCombo(id))` + `label`, same grid markup and
  `shortcuts-section` headers as today. The phantom rows
  (`Ctrl+Shift+S`, `Ctrl+Shift+Q`, and `Ctrl+N`) disappear because they
  are not in phase-1 defs; they return in phase 5 as real actions.
- Status bar (`renderStatusBar()`, main.ts:452): after
  `bar.appendChild(readingComfort)` (:500), append one keyboard-glyph
  button (`.statusbar-item`, icon via `icons.ts` — add a glyph if none
  fits), `title` + `aria-label` `"Keyboard shortcuts (?)"`, click → the
  same toggle path as `?` (`showShortcuts = !showShortcuts` +
  re-render). Reachable from every screen (status bar is global chrome).
- Modal footer gains a **"Customize…"** link → `showView("settings")` +
  `settingsScreen.setItem("shortcuts")` + close the modal.
- Listen for `netssh:shortcuts` to re-render an open modal after a
  rebinding (stale combos in the help list are the bug this feature kills).

Gate: `npm run build` + `npm run test` exit 0; manual: button opens modal,
rows match the defaults table, no phantom entries.

## Phase 3 — Settings pane: Shortcuts

- `nav-panel.ts` SETTINGS_ITEMS (:57): flip the existing
  `{ id: "shortcuts", label: "Shortcuts", ready: false }` to
  `ready: true`.
- `settings-screen.ts`: `LABELS` already has the entry (:52); add
  `: this.itemId === "shortcuts" ? this.renderShortcuts()` to the
  `render()` dispatch chain (:160-168, before the placeholder fallback).
- `renderShortcuts()`, grouped by `section` (same groups as the modal):
  - Row: `label`, current combo as `<kbd>` chips (`formatCombo`),
    **Change** button; per-row **Reset** (only when an override exists);
    `modLocked` rows render a lock icon + explanatory tooltip with Change
    disabled (spec §Settings UI).
  - **Capture flow** (spec): Change → row enters "press new keys" state
    with a live chip preview from `parseCombo` → **Enter** confirms,
    **Escape** cancels; a keydown listener scoped to the capture state.
    Capture and match share `parseCombo`, so what the user pressed is
    exactly what `matches()` later resolves.
  - **Validation**: duplicate resolved combo → both rows in warning
    colour + inline message, save blocked while a conflict stands.
    Reserved combos rejected with explanation text: `Mod+W`/`Ctrl+W`
    (remote pass-through), `Tab`, `Mod+C`/`Ctrl+C`, `Mod+V`/`Ctrl+V`
    (clipboard muscle memory), `Escape` (cascade + modal dismiss).
  - **Save**: on capture confirm, write the row override into the map →
    `setShortcutOverrides(map)` (persists) → `setOverrides(map)` (re-read
    into the registry) → `netssh:shortcuts` re-renders pane + open modal.
    Applies immediately, no restart (spec).
  - **Restore all defaults** button → save the empty map.
- Styles in `_settings-screen.css` (tokens only, 4px grid): `.shortcut-row`,
  `.kbd-chip`, `.shortcut-capture`, warning state via the existing warning
  colour token — no new input classes, no raw px/colours (AGENTS.md CSS
  rules).
- a11y: capture state announced via `aria-live`; conflict message linked
  with `aria-describedby`; whole pane operable keyboard-only (spec 07
  keyboard-first; docs/accessibility.md).

Gate: `npm run build` + `npm run test` exit 0; manual: rebind `toggle-kb`,
act on it, restart, act again — `config.json` gains a `"shortcuts"` map
(spec Done-looks-like line 3).

## Phase 4 — Terminal-scope bindings consult the registry

- `terminal-view.ts` attach handler (:280): the `Ctrl+Shift+F` branch
  (:299) becomes `matches(e, "terminal") === "scrollback-search"`.
  `Ctrl+C`/`Ctrl+V` stay hardcoded (fixed, spec). Scope filtering means
  global actions never fire from this handler and terminal-scope actions
  never fire from the global listener.
- `Ctrl+Space` byte branch — `routeKeystroke` (suggestion-controller.ts:
  99) currently hardcodes `data === "\x00"`. Inject the resolved byte via
  the controller deps (the pattern plan-041 established for view-private
  state): add `suggestionsToggleByte: () => string | null` to
  `ControllerDeps`, supplied by the view as
  `() => ctrlByteForCombo(resolvedCombo("toggle-suggestions"))`. The
  branch compares against it (default `"\x00"` when the getter returns
  null). No shadow-buffer or routing-semantics change (AGENTS.md rules
  1-2; plan-041 non-goals respected).
- Extend `suggestion-controller.test.ts`: default byte still toggles;
  custom byte via the dep toggles; null byte → no toggle (inert override,
  hand-edited config case).
- **Manual smoke test against the mock server (`test_server.rs`)** — the
  spec's gate for this phase: Ctrl+Space toggle + toolbar sync;
  Ctrl+Shift+F search; **Ctrl+W still deletes a word in the remote shell**
  (pass-through regression check); Tab cascade (dropdown → ghost →
  passthrough); Escape cascade (dropdown → sidebar → ghost); Alt+→ word
  accept; hand-edited config override for `toggle-suggestions` honored
  after restart.

Gate: `npm run build` + `npm run test` exit 0; smoke checklist above.

## Phase 5 — Missing bindings: Ctrl+N and Ctrl+Shift+Q

- Add defs: `new-connection` (`Mod+N`, global, navigation),
  `disconnect` (`Mod+Shift+Q`, global, terminal). They appear in the help
  modal and settings pane automatically (defs-driven — the drift problem
  the registry exists to kill).
- main.ts switch cases:
  - `new-connection`: `showView("connections"); hostScreen.
    openNewConnection();` — byte-for-byte the nav callback (:198-201).
  - `disconnect`: `closeTab(this.activeTabId)` — confirm modal then
    `disconnect()`, identical to `close-session-tab` (spec "Also decided";
    see Decisions above for why both ids exist).
- `shortcuts.test.ts`: the two new ids resolve and match.

Gate: `npm run build` + `npm run test` exit 0; manual (spec Done-looks-like
lines 6-8): Ctrl+N opens the form from the terminal and KB views; Ctrl+N
rebound still opens it; Ctrl+Shift+Q shows the confirm modal, then the
session ends and the tab removes (against `test_server.rs`).

## Phase 6 — Docs + a11y sweep

- `docs/specs/07-keyboard-shortcuts.md`: Global Shortcuts table gains
  `Ctrl+N` + `Ctrl+Shift+Q`; note the status-bar button and point
  customization at the Settings pane + spec 11.
- `docs/specs/03-ui-visual-design.md`: extend the status-bar component
  list with the shortcuts button (only if it enumerates items — verify).
- `docs/user-guide/` settings page (the `08-settings.md` pattern from
  plan-053): Shortcuts pane section — rebinding, conflicts, reserved keys,
  the Ctrl+Space lock, restore defaults.
- `docs/accessibility.md`: ARIA inventory — capture flow, conflict
  message, lock tooltip, status-bar button.
- Grep the docs for `Ctrl+Shift+S` and the old hardcoded shortcut lists —
  the registry made them liars; fix or point them at spec 11.
- AGENTS.md doc table: spec 11 row moves from "(Planned)" once
  implementation starts (status marker only, not content).

## Verification gates (per AGENTS.md)

- `npm run build` (runs tsc) — exit 0 after every phase.
- `npm run test` (vitest) — exit 0; new `src/lib/shortcuts.test.ts` +
  controller byte cases; no suite regressed.
- `cargo check --all-targets` in `src-tauri/` — exit 0 after phase 1 (the
  only Rust-touching phase).
- Manual checklist = spec §Done Looks Like, all 7 lines, each with its
  named proof; phases 4-5 additionally smoke-tested against
  `test_server.rs` (Ctrl+W pass-through is the non-negotiable regression
  check).
- a11y: keyboard-only walk of the settings pane (capture, conflict, reset,
  restore) and the modal via the status-bar button; capture state
  announced.

## Skipped (deliberate — rationale in spec "Fixed vs. User-Mappable" + "Risks / Notes")

- Widget navigation keys (Tab / arrows / Enter / Escape in forms,
  comboboxes, menus, trees) stay hardcoded — mapping them adds conflict
  surface for near-zero value.
- `Ctrl+W`, `Ctrl+C` / `Ctrl+V` untouched — non-negotiable pass-through
  and clipboard muscle memory (AGENTS.md; spec Fixed table).
- No keybinding dependency; no chords (multi-key sequences) — capture is
  one keydown with modifiers.
- No export/import of shortcut maps; overrides in `config.json` are the
  interop surface.
- macOS Cmd coverage is global-scope only; `modLocked` pins Ctrl+Space to
  Ctrl (protocol constraint — the UI states it, spec §Risks).
- No per-profile or per-platform binding sets — one canonical
  platform-agnostic map (spec §Persistence).