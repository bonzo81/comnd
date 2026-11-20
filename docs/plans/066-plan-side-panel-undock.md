# Plan: undock the side panel into its own window (issue #176)

Status: Implemented; verification recorded below.
Spec: bonzo81/comnd#176, artifact `spec-side-panel-undock`. Amends
`docs/adr/003-sidebar-pushes-terminal-not-overlay.md`; constrained by
`docs/adr/013-concurrent-sessions-session-id-tabs.md` (one app-wide panel),
`docs/adr/015-transactional-config-writes.md` (config writes) and
`docs/adr/018-css-token-naming-standard.md` (tokens only).

## Problem

The side panel could only live docked inside the terminal view. Engineers working on a
single screen want the panel's command reference beside a *full-width* terminal, and on a
second monitor they want it out of the window entirely. Overlaying it inside the app
window is not an answer: ADR-003 requires the terminal to render at its true width so
wrapped output stays correct, which an overlay breaks.

## Shape of the change

The panel window is a second Tauri window running the same bundle, labelled `panel`. Its
JS detects the label at bootstrap and renders only the panel; the main window renders the
app as before. There is no third renderer and no new IPC on the keystroke path — the panel
reads its content from the same in-memory snapshot the docked panel does.

One app-wide panel follows the active tab (ADR-013), so undocking never forks per-tab
state: the panel window is fed the active tab's suggestion/KB state exactly as the docked
panel is.

### Rust (`src-tauri/src/panel.rs`, new)

Window, geometry and config work only.

- `clamp_position(geometry, monitors)` — pure, so it is unit-testable without a window
  server. A saved position that no longer intersects a visible monitor is moved onto the
  nearest one; the saved size is kept (clamped to the screen only when it cannot fit).
- `panel_open` builds the window hidden, applies the stored geometry in *physical* pixels,
  then shows and focuses it. Building hidden avoids the flash of a default-sized window
  jumping to the saved rectangle.
- `attach_geometry_tracking` merges `Moved`/`Resized` events into one pending geometry and
  writes it at most once per 300 ms, so dragging the window does not hammer the config
  file. `CloseRequested` flushes the pending geometry, destroys the window and emits
  `comnd:panel-closed` to the main window.
- `panel_set_undocked(false)` destroys the panel window if it exists, so "dock" cannot
  leave a stray copy behind. `panel_open` reuses an existing window instead of building a
  second one.
- `attach_main_window_cleanup` destroys the panel window when the main window closes, so
  quitting while undocked cannot leave an orphan process.

### Config (`src-tauri/src/config.rs`)

```json
"panel": { "undocked": false, "docked_width": 320, "window": null }
```

`docked_width` is clamped to 240..=1200 on the way in. `window` holds physical `x`, `y`,
`width`, `height` — physical because that is what the window API returns and applies, so
one representation round-trips without a scale factor at every read. Every write goes
through `ConfigStore::apply_and_persist` (ADR-015): read-modify-write under one lock, then a
single atomic replace.

### Frontend

- `src/lib/side-panel.ts` — the panel state machine (`open`, `undocked`, `dockedWidth`)
  plus `cycleSidePanel()`. `initSidePanel()` restores `undocked` into the *state* but never
  sets `open`: the panel must not open itself at launch, even when the app was quit
  undocked. Width changes debounce 400 ms before persisting.
- `src/components/terminal-view.ts` — while undocked the docked sidebar and its resizer are
  hidden, so the terminal lays out at full window width and the existing
  `fit()` → `ssh_resize` path gives the PTY the new column count. Docking restores the panel
  at its saved width through the same path. No second resize mechanism exists.
- `src/components/panel-window.ts` — the undocked window's own UI: a frameless header that
  is the window's drag region, with Dock and Close controls, the same tab strip, the shared
  `.sb-content` renderer. `Escape` closes it.
- `src/lib/shortcuts.ts`, `src/main.ts` — `Ctrl+Shift+B` (`Mod+Shift+B`) is bound to
  `toggle-side-panel` and calls `cycleSidePanel()`, in both windows, so the keyboard alone
  can open, undock and dock. `Ctrl+W` is untouched.

### Styles

`src/styles/components/_panel-window.css` plus a `.sb-undock-btn` rule in `_replay.css`.
Tokens only (ADR-018); `npm run lint:css` passes.

## Known gaps handed over by the spec, and the answers chosen

1. **Where the Dock control lives, and which shortcut triggers dock/undock.** The undocked
   window puts Dock first in its header tab order and Close second; the docked panel gains
   an Undock control in its own tab strip rather than a second toolbar button.
   `Ctrl+Shift+B` cycles closed → docked → undocked → docked instead of toggling, because a
   toggle would have no route from docked to undocked. Hiding the docked panel stays on
   `.tv-panel-btn` and `Escape`.
2. **Does `Escape` close the undocked window?** Yes. It destroys the window and leaves the
   panel undocked for the next open, which matches what the header's Close control does.
   `Escape` in the main window still closes the docked panel.
3. **Config shape and key names.** `panel.undocked`, `panel.docked_width`,
   `panel.window.{x,y,width,height}`, as above. `window: null` means "never undocked", which
   the first undock replaces with a centred default scaled by the primary monitor's
   `scale_factor()`.

## Follow-up after review: the window is frameless

The first cut kept native decorations. Manual review asked for them gone, matching the main
window, which `tauri.conf.json` already opens with `decorations: false`. The window is now
created with `.decorations(false)` and keeps `shadow` at its default, so the DWM frame still
supplies the all-edge resize borders and the drop shadow; `.resizable(true)` is unchanged, so
the saved geometry stays user-adjustable. With no title bar to move the window by, `.pw-head`
carries `data-tauri-drag-region="deep"` and `user-select: none`, which makes the header a
title bar while leaving the Dock and Close buttons clickable — Tauri's drag script refuses to
start a drag from an interactive element. Close reuses the `close` bridge action that `Escape`
already sends, so no new IPC surface exists, and it sits *after* Dock in tab order so the way
back is still the first control the keyboard reaches. `core:window:allow-start-dragging` is
the one added permission: `core:window:default` already grants `internal_toggle_maximize`,
which is what a double-click on the header needs.

## Verification

Recorded on Windows 11, Node 24.14.0, cargo 1.93.1, `msedgedriver.exe` matching
WebView2 157.0.4341.60 on `PATH`.

| Gate | Result |
|---|---|
| `npm run build` | exit 0 |
| `npm run test` | 52 files, 972 tests passed |
| `npm run lint:css` | exit 0 — 82 tokens, 120 files scanned |
| `cargo check --all-targets` (`src-tauri/`) | exit 0 |
| `cargo test` (`src-tauri/`) | 270 passed |
| `cargo test --release --lib` (`src-tauri/`) | 268 passed |
| `npm run smoke` | exit 0 — 25 scenarios, including `panel-undock-dock` and `panel-undock-relaunch` |
| `npm run smoke:mutation` | exit 0, expected single failure reporting dropped `ssh_send` input |
| `npm run smoke -- --mutation=terminal-sidebar-layout` | exit 0, expected single failure |
| `npm run lint:eol` | exit 0 — 369 text files in the index |
| `npm run test:coverage` (frontend floors) | exit 0 |
| `npm run test:coverage:rust` (Rust floors) | exit 0 — stores 68.32% (floor 65%), command layer 40.94% (floor 35%); measured on Windows, where the numbers are indicative only |

`npm run smoke` rebuilds the app, and `tauri build` regenerates
`src-tauri/gen/schemas/capabilities.json` without a final newline, which
`scripts/check-eol.mjs` rejects. The file gains the `panel` window in this change, so it is
kept and the newline is restored before committing; the next regeneration drops it again,
so the same one-line fix applies whenever a capability change is committed from Windows.

### Evidence per definition-of-done item

| Item | Evidence |
|---|---|
| Undock moves the panel to its own OS window; terminal goes full width | `panel-undock-dock`: two windows after the chord, `#tv-sidebar` gone from the terminal row, `.tv-terminal` width back to the closed-state width within 1px, PTY columns back within 1 of the closed count |
| Dock returns the panel at its saved width and the terminal narrows; docked baseline unchanged | `panel-undock-dock`: one window after docking, sidebar width back to the docked width within 1px, `sidebar.left >= terminal.right - 1` (push, not overlay), terminal narrowed, PTY columns down again. `npm run smoke:visual -- --check` is unaffected: the docked layout rules were not touched |
| Quit while undocked, relaunch: no panel and no panel window; opening restores the undocked window at its saved geometry | `panel-undock-relaunch`, two app processes on one data directory |
| A saved position on a missing monitor is clamped back on screen, size kept | `clamp_position` unit tests in `panel.rs`, including a rectangle outside every monitor |
| Undock and dock work from the keyboard alone | every transition in `panel-undock-dock` is driven by `Ctrl+Shift+B` only, including docking from the panel window |

### Smoke harness

`test/smoke/lib/harness.mjs` had no way to address a second window. It now has
`switchToWindow(browser, marker)`, `windowHandles`, `waitForWindowCount`,
`waitForNoWindow` and `withWindow`, plus `runBoots`/`test.phases` for scenarios that span a
relaunch (one app process per phase, one shared data directory).

Windows are told apart by `document.documentElement.dataset.comndWindow`, not by title or
URL: the panel window loads the same `index.html`, so both windows report an identical
`document.title` and `location.href` to WebDriver, and the Tauri window label is not
exposed to the page.

Two WebDriver behaviours the helpers account for, both found by running the suite:

- The window the app destroys during a dock is the window the failing command was sent to,
  so a `no such window` error from that command is expected and the scenario re-targets the
  surviving handle before polling.
- A destroyed window stays listed for a moment and rejects the switch; `waitForNoWindow`
  treats an unswitchable handle as absent and re-reads the list on the next poll.
