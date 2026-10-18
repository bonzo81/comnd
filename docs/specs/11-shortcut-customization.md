# Comnd — User-Definable Keyboard Shortcuts

**Version:** 0.2 (draft) **Status:** Planned **Author:** Andy Norwood (architect) **Last updated:** 2026-10-11

---

## Intent

All keyboard shortcuts are currently hardcoded inline at their usage sites. This document specifies a central shortcut registry, a subset of user-mappable shortcuts, a Settings pane for re-assigning them, and a status bar affordance for viewing all shortcuts. It replaces the hardcoded help-modal list with a registry-driven one, so handlers and documentation can never drift apart.

## Current State (Audit Findings)

There is **no registry**. Every combo is an inline `if` chain at its usage site, in three layers:

### Layer 1 — Global (src/main.ts, `registerGlobalShortcuts()`, line 931)

| Combo | Action | Notes |
|---|---|---|
| `Ctrl+Shift+K` | Toggle Knowledge Base view | |
| `Ctrl+,` | Open Settings view | |
| `Ctrl+W` | Pass-through guard | `preventDefault()` only in terminal view so the app window doesn't close; key still reaches remote |
| `Ctrl+Shift+W` | Close active session tab (confirm modal) | |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Terminal font zoom in / out / reset | |
| `Escape` (bare) | KB/settings → connections; close shortcuts modal | |
| `?` (bare, not in input) | Toggle shortcuts help modal | |
| `/` (bare, not in input) | Focus global search | |

### Layer 2 — Terminal (src/components/terminal-view.ts + src/lib/suggestion-controller.ts)

The keystroke single-entry refactor (docs/plans/041) moved all byte-level routing out of terminal-view: `terminal.onData` (terminal-view.ts:309) now forwards every byte to `SuggestionController.keyIn` (suggestion-controller.ts:206), which routes through the pure `routeKeystroke` (suggestion-controller.ts:81).

| Mechanism | Combo | Action |
|---|---|---|
| `attachCustomKeyEventHandler` (terminal-view.ts:280) | `Ctrl+C` | Copy if selection exists; else interrupt passes through |
| `attachCustomKeyEventHandler` | `Ctrl+V` | Paste to SSH |
| `attachCustomKeyEventHandler` | `Ctrl+Shift+F` | Scrollback search |
| `routeKeystroke` (:85) | `\t` (Tab) | Context-sensitive: dropdown item / ghost remainder / pass through to remote |
| `routeKeystroke` (:91) | `\x1b` (Escape) | Cascade dismiss: dropdown → sidebar → ghost text |
| `routeKeystroke` (:99) | `\x00` (Ctrl+Space) | Toggle auto-suggestions |
| `routeKeystroke` (:102) | `\x1b[A`/`\x1b[B` | Dropdown up/down |
| `routeKeystroke` (:107, `ALT_ARROW_RIGHT` const :79) | `\x1b[1;3C` variants | Alt+→ accept next word of ghost suggestion |
| `window` keydown (terminal-view.ts:671) | `Ctrl+W` (connected) | Second pass-through guard |

**Note:** Ctrl+Space reaches the routing layer as the serialized byte `\x00` — re-binding it requires a combo→control-byte lookup the byte branch can match, not a KeyboardEvent matcher.

### Layer 3 — Component-local (fixed widget semantics)

Host screen (`host-screen.ts:515`), nav panel (`nav-panel.ts:1547`), global search (`global-search.ts:304`), dialogs, context menus (`a11y.ts:22`): arrows / Enter / Escape / Delete / Shift+F10 / Tab for list navigation, form submission, and WAI-ARIA menu patterns.

### Other findings

- The shortcuts help modal (`main.ts:876`, `renderShortcutsModal()`) uses a **hardcoded display-only array** that is already stale: it lists `Ctrl+Shift+S` (toggle sidebar) and `Ctrl+Shift+Q` (disconnect), neither of which is implemented anywhere — and `Ctrl+N` (new connection), which likewise has no handler today (decided: implement — see "Also decided" below).
- Settings pane slot is **already reserved**: `{ id: "shortcuts", ready: false }` in `nav-panel.ts:57`; the `render()` dispatch (`settings-screen.ts:151`) falls through to `renderPlaceholder` (:829).
- Persistence pattern exists: `AppConfig` in `src-tauri/src/config.rs` (config.json in app data dir, `#[serde(default)]` per field, get/save via Tauri commands).
- No keybinding library in package.json. A small hand-rolled matcher fits the codebase style; no new dependency.

## Fixed vs. User-Mappable

### Fixed — not configurable

These are interaction semantics, not shortcuts. Remapping them would break the suggestion UX (docs/05, docs/07) or standard widget behaviour.

| Keys | Why fixed |
|---|---|
| `Tab`, `↑/↓`, `Enter`, `Escape` cascade, `Alt+→` | Context-sensitive terminal input semantics (dropdown / ghost text / remote pass-through) |
| `Ctrl+W` | Non-negotiable: must pass through to remote as delete-word (AGENTS.md) |
| `Ctrl+C` (with selection) / `Ctrl+V` | OS clipboard muscle memory; remapping risks confusion with shell interrupt |
| Arrows / Enter / Escape inside forms, comboboxes, menus, trees | WAI-ARIA navigation patterns |

### User-mappable registry

| Default (Windows/Linux) | Default (macOS) | Action | Scope |
|---|---|---|---|
| `Ctrl+N` | `⌘N` | New connection | global |
| `Ctrl+,` | `⌘,` | Open settings | global |
| `Ctrl+Shift+K` | `⌘⇧K` | Toggle KB view | global |
| `Ctrl+Shift+W` | `⌘⇧W` | Close session tab | global |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | `⌘=` / `⌘-` / `⌘0` | Font zoom in / out / reset | global |
| `Ctrl+Space` | `Ctrl+Space` | Toggle suggestion dropdown | terminal |
| `Ctrl+Shift+F` | `⌘⇧F` | Scrollback search | terminal |
| `/` | `/` | Focus global search | global (bare key) |
| `?` | `?` | Shortcuts modal | global (bare key) |

Terminal-scope `Ctrl+Space` keeps **Ctrl on all platforms**: it must produce the control byte `\x00` that the remote shell understands. Mapping it to `⌘Space` would also collide with the macOS Spotlight hotkey.

Also decided:

- **Implement `Ctrl+N` (new connection)** as a real, mappable binding — the help modal already promised it, but no handler has ever existed. The action routes through the existing seam: the nav panel's New Connection button → `onNewConnection` → `HostScreen.openNewConnection()` (host-screen.ts:123), which opens the form; from a non-connections view, show the connections view first.
- **Implement `Ctrl+Shift+Q` (disconnect)** as a real, mappable binding — the help modal already promised it.
- **Drop `Ctrl+Shift+S` (toggle sidebar)** from the list — sidebar already has a button and Escape closes it.

## Architecture: One Registry, Table-Driven Handlers

New file `src/lib/shortcuts.ts`:

```
type ShortcutAction = "new-connection" | "open-settings" | "toggle-kb" | ...
type ShortcutDef = {
  id: ShortcutAction
  defaultKey: string            // canonical form, mod-key-agnostic: "Mod+Shift+K"
  scope: "global" | "terminal"
  bareKeyOnly?: boolean         // "/" and "?": only when target is not an input
}
type ResolvedBinding = { actionId, combo: ParsedCombo }
```

Core utilities:

- **Canonical combo string** — `parseCombo(keyboardEvent)` → `"Mod+Shift+K"`. `Mod` normalizes the platform modifier: `Ctrl` on Windows/Linux, `Cmd` on macOS. One binding definition serves both platforms.
- **Platform resolution** — `platformMod()` returns `"Ctrl"` or `"Cmd"` (detect via `navigator.platform` / `userAgent`); `formatCombo(def)` renders the display label (`Ctrl+Shift+K` or `⌘⇧K`) for the UI.
- **Matcher** — `matches(e: KeyboardEvent)` resolves an event to an actionId or null, consulting loaded overrides.
- **Load / save** — defaults from `SHORTCUT_DEFS`, overrides from app config; re-read after save so changes apply immediately.

### Handler conversion

- `registerGlobalShortcuts()` (`main.ts:931`) becomes a loop over the registry — the stale dual-maintenance problem dies.
- Terminal-scope: only `Ctrl+Space` and `Ctrl+Shift+F` consult the registry. Tab / Escape / arrows stay hardcoded (fixed semantics). `Ctrl+Shift+F` is matched in the attach handler (terminal-view.ts:299); `Ctrl+Space` is matched in `routeKeystroke` (suggestion-controller.ts:99) as the byte `\x00` — the registry must expose a combo→control-byte lookup so the byte branch can match the rebound combo.
- Component-local widget navigation stays hardcoded — mapping it adds conflict surface for near-zero value.

### macOS handling

- `Mod` = `Ctrl` on Windows/Linux, `Cmd` on macOS, applied at match time and at capture time in the settings UI.
- Terminal-scope bindings that must emit control characters (`Ctrl+Space`) are pinned to `Ctrl` on every platform via a `modLocked: true` flag on the def; the settings UI shows them as non-editable with an explanatory tooltip.
- Non-modifier keys (`/`, `?`) are platform-independent.
- Display labels use platform symbols on macOS (`⌘ ⇧ ⌥ ⌃`) and plain text elsewhere.

### Persistence

Add to `AppConfig` in `src-tauri/src/config.rs`:

```rust
#[serde(default)]
pub shortcuts: HashMap<String, String>,   // actionId -> canonical combo, e.g. "toggle-kb" -> "Mod+Shift+K"
```

Overrides store the **platform-agnostic** canonical form (`Mod+…`), so a config file is portable across platforms. One new Tauri command: `set_shortcuts(overrides)` follows the existing per-section save pattern (`set_max_sessions`, `save_llm_settings`) — there is no whole-config save command; `get_app_config` covers the read path.

## Settings Screen: Shortcuts Pane

Fits the already-reserved slot — no new view:

1. `nav-panel.ts`: flip `ready: true` for the `shortcuts` item.
2. `settings-screen.ts`: add `renderShortcuts()` + one dispatch case in the `render()` switch (:151).

UI:

- Grouped table: **Navigation** / **Terminal** / **View** sections (mirroring docs/07). Each row: action label, current key rendered as `<kbd>`-style chips (platform symbols on macOS), **Change** button.
- **Capture flow:** click Change → row enters "press new keys" state → next keydown (with modifiers) is captured, rendered live as chips → Enter confirms, Escape cancels. Capture happens through the same `parseCombo` utility, so what the user pressed is exactly what gets matched later.
- **Conflict handling:** if the combo is already assigned, both rows highlight in warning colour with an inline message; the user must clear one or pick another. Save is blocked while a conflict stands.
- **Reserved keys:** `Ctrl+W` (remote pass-through), `Tab`, `Ctrl+C` / `Ctrl+V` are rejected with explanation text.
- **`modLocked` bindings** (Ctrl+Space): shown with a lock icon, non-editable.
- **Reset:** per-row reset to default + "Restore all defaults" button.
- Persistence via existing config save; bindings apply immediately — no restart.

## Status Bar: Shortcuts Viewer Button

- One icon button (keyboard glyph, styled as a `statusbar-item`) added at the right end of the status bar in `renderStatusBar()` (`main.ts:452`), after the Reading Comfort items.
- Opens the shortcuts modal. The modal (`renderShortcutsModal()`) becomes **registry-driven** — same table the handlers use, grouped by the same sections, platform-correct key labels.
- Modal gains a **"Customize…"** link that opens Settings → Shortcuts.
- `?` keeps working; the button is the mouse-first affordance. Tooltip: "Keyboard shortcuts (?)".

## Implementation Order

1. **Registry + matcher** (`shortcuts.ts`, defaults table, `shortcuts` field in `config.rs`) — pure refactor; convert `registerGlobalShortcuts()` to table-driven. Verify behaviour unchanged.
2. **Help modal + status bar button** — modal reads registry; add icon button; add "Customize…" link. Small, user-visible, zero risk.
3. **Settings pane** — capture UI, conflict / reserved-key validation, `modLocked` display, persistence, flip `ready: true`.
4. **Terminal-scope bindings** — wire `Ctrl+Shift+F` and `Ctrl+Space` through the registry (byte-match branch for Ctrl+Space). Highest care; do last.
5. **Missing bindings** — implement `Ctrl+Shift+Q` (disconnect; confirm modal, same as close-tab) and `Ctrl+N` (new connection; existing `onNewConnection` seam, connections view shown first if needed), add both to the registry as mappable.

Each phase passes `npm run build`; phase 4 additionally needs a manual terminal smoke test against the mock server (`test_server.rs`).

## Done Looks Like

- [ ] Phase 1 refactor is behaviour-preserving: every Layer 1 combo still triggers its action, with `registerGlobalShortcuts()` table-driven — proof: `npm run test` (new co-located `src/lib/shortcuts.test.ts` covering `parseCombo` / `matches` / override resolution) and `npm run build` both exit 0; manual pass over the Layer 1 table.
- [ ] Help modal is registry-driven with no stale entries (`Ctrl+Shift+S` gone), and the status bar keyboard button opens it with a working "Customize…" link — proof: manual click-through; modal rows match the defaults table.
- [ ] Rebinding a shortcut in Settings applies immediately without restart and survives an app restart — proof: manual — rebind `toggle-kb`, act on it, restart, act again; `config.json` gains a `"shortcuts"` map.
- [ ] Validation behaves as specified: duplicate combos highlight both rows and block save; `Ctrl+W` / `Tab` / `Ctrl+C` / `Ctrl+V` assignments are rejected with the explanation text; `modLocked` rows show a lock and are non-editable — proof: manual walk-through of each case.
- [ ] Terminal-scope bindings survive rebinding: `Ctrl+Shift+F` via the attach handler, `Ctrl+Space` via the combo→control-byte branch in `routeKeystroke` — proof: manual smoke test against the mock server (`test_server.rs`); `npm run build` exits 0.
- [ ] `Ctrl+Shift+Q` disconnects through a confirm modal (same as close-tab) and appears as a mappable row — proof: manual test against the mock server.
- [ ] `Ctrl+N` opens the new-connection form from any view (connections view shown first if needed) and appears as a mappable row — proof: manual — press it from the terminal and KB views; rebind it and press the new combo.
- [ ] No pass-through regression: `Ctrl+W` still deletes a word in the remote shell — proof: manual smoke test.

## Known Gaps (handed over deliberately)

- **Implementation plan:** no `docs/plans/` document exists for this feature yet; per AGENTS.md, one must be drafted from this spec before implementation starts.

## Risks / Notes

- **Scope discipline:** component-local widget navigation stays hardcoded. A registry that swallows widget semantics is a conflict surface, not a feature.
- **Bare keys:** `/` and `?` must stay gated on "target is not an input" — `bareKeyOnly` flag carries the existing focus check into the registry.
- **macOS Cmd coverage is global-scope only.** Terminal-scope bindings that emit control bytes to the remote (`Ctrl+Space`) are pinned to Ctrl; this is a protocol constraint, not a platform omission, and the UI states it.
- **Stale modal is a symptom:** the registry is the fix — handlers, help modal, and settings pane all read one table.
