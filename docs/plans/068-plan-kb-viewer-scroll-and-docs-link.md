# Plan: KB viewer scroll retention and the Documentation link (issue #229)

Status: implemented; verification recorded below.
Spec: bonzo81/comnd#229.

## Background

Two defects in **Knowledge Base → Browse**:

1. `KbViewerDialog.render()` replaced the whole dialog markup on every selection, so
   `.kb-command-list` was a new element with `scrollTop` 0. A command clicked below the
   fold disappeared from view.
2. `SidebarContent.renderFooter()` emitted a raw `<a href target="_blank">` for the
   platform `reference_url`. The WebView did not follow it, and neither place that renders
   `SidebarContent` wired a handler.

## Changes

- `src/lib/sidebar-content.ts`
  - The footer control is a `<button type="button" class="cmd-ref-link btn-link">` carrying
    the URL in `data-url`. It keeps the class and the visible **Documentation ↗** label,
    reuses the existing `.btn-link` style, and has no `href`, so the WebView has no default
    navigation, middle-click or ctrl-click path.
  - `wireReferenceLink(root)` is the shared handler: it calls `openUrl(url)` and reports a
    rejection through `log.error(LogTag.Kb, …)` and an error toast. An empty `reference_url`
    still renders no control.
- `src/lib/side-panel-render.ts` wires the handler in the shared detail branch, which both
  the docked and undocked homes render.
- `src/components/kb-viewer-dialog.ts`
  - `render({ resetScroll })` captures the list offset and whether a command row had focus
    before replacing the markup, then restores both (`focus({ preventScroll: true })`).
  - The offset resets only for a new search query, a deep link that clears an active
    query, or a platform load.
  - A deep link then reveals its selection with `scrollIntoView({ block: "nearest" })`, so
    the list moves only when the chosen row is outside the viewport.
  - `bindEvents` wires the same reference-link handler for the KB screen.
- Tests: `sidebar-content.test.ts` (markup and shared wiring), the new
  `side-panel-render.test.ts` (panel-home render path), and `kb-viewer-dialog.test.ts`
  (click keeps `scrollTop` and focus, search resets it, both link states).

## Decisions

- The helper calls `openUrl` directly rather than routing a panel action, so both render
  paths exercise one code path and the KB screen does not need the action bridge. App
  commands are not window-scoped, so the undocked window can invoke `open_url_cmd`; the
  docked and KB surfaces run in the main window.
- Capture/replace/restore is used instead of patching only the changed rows. The list
  markup is small, and the constraint on keyboard selection is unchanged: arrow keys still
  call `scrollSelectedIntoView()`, which now only moves an off-screen row.
- `scrollSelectedIntoView` uses an optional call because jsdom has no `scrollIntoView`; the
  browser path is unchanged. A test installs a spy to prove the deep-link path reveals.
- Rebased onto `main` after #238 rewrote the same viewer (in-place disable, no Ignored
  section). Its `reloadAfterToggle` already restores the offset itself; both restores write
  the same value, so the two changes compose.
- No Rust, suggestion-engine or keystroke-path changes.

## Verification

Windows, 2026-11-27. No Rust file changed, so the Rust gates were not run.

| Command | Result |
|---|---|
| `npm run build` | exit 0; `tsc` and the Vite build completed |
| `npm run test` | exit 0; 63 files, 1093 tests passed |
| `npm run lint` | exit 0 |
| `npm run lint:css` | exit 0; 82 tokens, 139 files |
| `git add -A; npm run lint:eol` | exit 0; 395 files |
| `npm run smoke` | exit 0; 28 scenarios, 1 worker, 0 failures (one expected-failure probe), using msedgedriver 158.0.4370.33 matched to the installed WebView2 runtime |
