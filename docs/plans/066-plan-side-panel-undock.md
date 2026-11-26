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
- `attach_main_window_cleanup` destroys the panel window once the main window is
  destroyed, so quitting while undocked cannot leave an orphan process. Not on
  `CloseRequested`: that fires before the close confirmation resolves, so a
  cancelled quit would take the undocked panel with it.

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

## Follow-up after review: both controls carry a word and an icon

Manual review found the two halves of the same action labelled inconsistently — the docked
panel's Undock control was icon-only while the undocked window's Dock control was word-only.
Both now read word + icon: `icons.undock` plus "Undock" in the tab strip, and a new
`icons.dock` plus "Dock" in the header. The `dock` glyph is an arrow entering a frame rather
than a mirrored `undock`, because a mirrored arrow still reads as "leave" pointed the wrong
way. `.panel-window .pw-dock` centres the pair with the same `--space-1` gap `.sb-undock-btn`
uses and matches its `--font-size-sm`, so the two homes look like one control. The labelled
Undock button is `flex: 0 0 auto` against `flex: 1 1 auto` tabs with `min-width: max-content`, so the strip
holds at the 320px default width and degrades by wrapping onto extra rows, never by
overflowing or letting a label overlap its neighbour. Close stays icon-only: it is not the pair, and two words and two glyphs in a
narrow frameless header would crowd the drag region.

## Follow-up after review: lifecycle and persistence hardening

Review of the first cut found races the tests did not cover. Each fix below is exercised by a
test that fails without it.

**Config writes are field-level and single-guarded.** `ConfigStore::set_panel` replaced the
whole `PanelConfig`, so the geometry worker could read `undocked = true`, a dock could persist
`false`, and the worker's older snapshot would then restore `true`. `save_panel_geometry`,
`save_panel_undocked` and `save_panel_docked_width` each change one field inside one
`apply_and_persist`, and `panel.rs` reaches them through `with_config`, which holds the store
lock across read, change and persist.

**The geometry worker cannot undo the final rectangle.** The worker used to take a rectangle,
sleep, and write it afterwards; a close that saved the live rectangle first could then be
overwritten. Writes now take a `writes` lock that the close path also takes *after* setting
`stop`, and a worker that finds `stop` set drops its stale value instead of persisting it. The
same reasoning makes `panel_close`, docking and app shutdown all go through one
`close_panel_window`: Tauri's `destroy()` bypasses `CloseRequested`, so that function reads the
live rectangle and saves it before destroying, rather than trusting the debounce.

**The close path is serialised end to end, and a close claims the window.** A second round
of review found that taking the saver out of `PanelGeometryWriter` made the worker lock defeat
itself: a concurrent close saw no saver, skipped the wait and wrote beside a write still in
progress. Worse, it could read the rectangle from a window the first close had already
destroyed, and a per-field fallback would then save the *default* rectangle over the user's
geometry. The writer keeps its saver (so every close waits on the same lock), a `closing` guard
covers read → stop → persist → destroy, and a close now *claims* the window before destroying
it: `destroy()` reaches the event loop asynchronously, so `get_webview_window` keeps reporting
the label for a moment and a second close would otherwise read a dying window. The close path
also refuses to write anything when the live rectangle cannot be read (`live_geometry`), so a
default rectangle can never be substituted for a real one. Tests:
`close_paths_are_serialised`, `a_claimed_window_is_not_closed_twice`,
`a_rebuilt_window_can_be_closed_again`, `a_rectangle_collected_before_stop_is_not_written_after_it`
and `a_rectangle_recorded_after_stop_is_never_written`. The live-window half is exercised by
`panel-undock-relaunch` through `test_panel_race_close`, and the sequence is *observed* rather
than assumed: the command arms a gate, moves the window so the worker has something to write, and
receives the rectangle the worker actually took when it blocks inside that write. It then moves
the window to a distinct rectangle B and starts both close paths. Contention is reported only
when it happens — a close counts as queued on the guard only after `try_lock` returns
`WouldBlock`, and as queued behind a write only when `try_lock` on the write lock fails. Once
both signals are set, the paused write is released. The paused rectangle is therefore a genuine
stale value that must lose: the scenario asserts the saved geometry equals B and differs from the
worker's own rectangle by more than 20px. Before the claim, the equivalent check saved
`x = 1605` (the centred default) instead of the live `390`.

**The frontend has one serialised lifecycle, and it announces only what it saved.** The write
used to run outside the queue, so an undock write could land after a dock write and leave the
saved home undocked for the next launch; and the home was announced before the write, so the
docked panel could appear beside a window that was still open. The requested home is now held
*apart* from the published one — a snapshot or mode change during a pending write cannot leak
it — and `applyPanelLifecycle` runs one step per request: persist the requested home, then
reconcile the window, publishing the home only once the config agrees with it. A request id
decides which completion owns the state, so a failed open cannot clear a newer one, and an
open that completes after a dock closes the window it just created. Tests: `writes the home in
the order the user asked for it`, `never publishes a home whose write has not finished`,
`announces the docked home only after the write succeeds`,
`does not let a stale open failure clear a newer open`, plus the earlier
`does not reopen a window a later dock already ordered away`.

**The advertised shortcut is applied as an attribute.** `aria-keyshortcuts` was interpolated
into the markup, and the combo parser accepts any single character, so a saved binding such as
`Mod+Shift+"` could truncate the attribute (and a crafted override could inject markup). Both
Dock and Undock now set it with `setAttribute` after rendering and refresh it on
`comnd:shortcuts`; the panel tests mount with a quote-containing binding and with a
markup-shaped override, and assert the value survives as an attribute with no element added.

**The panel window cannot miss its first snapshot.** `comnd:panel-ready` used to be emitted
immediately after calling `listen()`; the reply could arrive before the listener resolved and
the window stayed on "Waiting for the terminal…". `onState` now resolves once the subscription
is live, and the request goes out after that.

**Replay follows the tab that owns the panel.** Reopening a closed panel used to render the
previous host's snapshot, because `setPanelActive` deliberately skips loading while the panel
is shut. A closed → open transition now reloads for the active tab, and a load that finishes
after its tab gave the panel up (or after the mode changed) no longer publishes its list or
its error over the new owner.

**Smaller gaps.** The docked width is flushed on the main window's close request
(`onCloseRequested` awaits the write), theme and Reading Comfort changes are pushed to an open
panel window, the panel window loads shortcut overrides and receives later ones, and the tab
strip wraps rather than overlapping at 240px with the largest UI text scale — `terminal-sidebar-
layout` now proves that by measuring the rendered boxes at 240px and 1.5× text: no label is
clipped, nothing leaves the panel, and no two items on one row overlap.

## Verification

Recorded on Windows 11, Node 24.14.0, cargo 1.93.1, `msedgedriver.exe` matching
WebView2 157.0.4341.60 on `PATH`.

| Gate | Result |
|---|---|
| `npm run build` | exit 0 |
| `npm run test` | 52 files, 989 tests passed |
| `npm run lint:css` | exit 0 — 82 tokens, 120 files scanned |
| `cargo check --all-targets` (`src-tauri/`) | exit 0 |
| `cargo test` (`src-tauri/`) | 275 passed |
| `cargo test --release --lib` (`src-tauri/`) | 273 passed |
| `npm run smoke` | exit 0 — 25 scenarios, including `panel-undock-dock` and `panel-undock-relaunch` |
| `npm run smoke:mutation` | exit 0, expected single failure reporting dropped `ssh_send` input |
| `npm run smoke -- --mutation=terminal-sidebar-layout` | exit 0, expected single failure |
| `npm run lint:eol` | exit 0 — 369 text files in the index |
| `npm run test:coverage` (frontend floors) | exit 0 — `lib` 87.50% (floor 78%), `components` 38.08% (floor 29%) |
| `npm run test:coverage:rust` (Rust floors) | exit 0 — stores 68.00% (floor 65%), command layer 40.87% (floor 35%); measured on Windows, where the numbers are indicative only |

`npm run smoke` rebuilds the app, and `tauri build` regenerates
`src-tauri/gen/schemas/capabilities.json` without a final newline, which
`scripts/check-eol.mjs` rejects. The file gains the `panel` window in this change, so it is
kept and the newline is restored before committing; the next regeneration drops it again,
so the same one-line fix applies whenever a capability change is committed from Windows.

### Evidence per definition-of-done item

| Item | Evidence |
|---|---|
| Undock moves the panel to its own OS window; terminal goes full width | `panel-undock-dock`: two windows after the chord, `#tv-sidebar` gone from the terminal row, `.tv-terminal` width back to the closed-state width within 1px, PTY columns back within 1 of the closed count |
| Dock returns the panel at its saved width and the terminal narrows; docked baseline unchanged | `panel-undock-dock` widens the docked panel with the resizer's keyboard path, waits for the saved width, then asserts the redocked sidebar returns at *that* width within 1px (so a reset-to-320px path fails), one window after docking, `sidebar.left >= terminal.right - 1` (push, not overlay), terminal narrowed, PTY columns down again. The docked layout at the default width is unchanged, so `npm run smoke:visual -- --check` is unaffected |
| Quit while undocked, relaunch: no panel and no panel window; opening restores the undocked window at its saved geometry | `panel-undock-relaunch`, two app processes on one data directory |
| A saved position on a missing monitor is clamped back on screen, size kept | `clamp_position` unit tests in `panel.rs`, including a rectangle outside every monitor |
| Undock and dock work from the keyboard alone | every transition in `panel-undock-dock` is driven by `Ctrl+Shift+B` only, including docking from the panel window |
| At most one panel window, and a repeat request reuses it | `panel-undock-dock` step 5 compares the WebDriver window handle before and after `panel_open`: destroying and rebuilding at the same width now fails even though the count and the width would still match |
| Overlapping closes save the live rectangle, not a default or a stale one | `panel-undock-relaunch` calls `test_panel_race_close`: the worker reports the rectangle it actually paused on, the window then moves to a distinct B, both closes start, and the command waits for observed contention (guard `try_lock` `WouldBlock`; write lock held) before releasing the write; the scenario asserts the saved rectangle equals B and differs from the paused one |

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

## Follow-up after release: 0.7.0 could not be closed

Shipped 0.7.0 did not quit: the title-bar cross, the OS window close and the taskbar Close
all did nothing on Windows (macOS and Linux were never reached by the report).

The close hook is the cause. Registering a JS listener for `tauri://close-requested` makes
Tauri's core call `api.prevent_close()` (`manager/window.rs`, `has_js_listener`), and
`@tauri-apps/api`'s `onCloseRequested` wrapper is responsible for the actual close: it
awaits the handler and then calls `Window.destroy()`. `destroy` is a permissioned command,
and `core:window:default` does not include `core:window:allow-destroy`, so the invoke was
rejected inside the event handler — after the native close had already been prevented.
Nothing surfaced: the rejection lives in a listener nobody awaits, so all three close paths
failed silently.

`src-tauri/capabilities/default.json` now grants `core:window:allow-destroy` alongside the
existing `allow-close` (the cross itself still needs that). The grant arrived with the
live-session close confirmation (issue #191), whose confirmed path calls `destroy()` too and
would have failed the same way; that change also renamed the hook to `holdWindowClose`.

`app-close` in the smoke suite is the guard: it clicks the real title-bar cross with no live
session (the silent path — a live session prompts first) and requires two independent proofs
that the app exited. WebDriver must lose the session with an error that names it gone
(`SESSION_GONE` in the harness; a transport failure fails the scenario instead), and the OS
must no longer have the process, which the app reports through the debug-only
`test_smoke_pid` command and the harness polls with `waitForProcessExit`. The second proof is
not redundant: WebKitGTK answers a clean quit and a crashed page with the same
`session deleted` error, so a session that merely dies is not evidence that the close was
honoured. Before the grant the scenario fails with
`App close: 1 window(s) still open 30000 ms after clicking the title-bar cross`; after it the
app exits. No earlier scenario quit through the window (teardown kills the driver), and the
panel-relaunch scenario's "quit" was that same teardown, so the path had no coverage at all.
That scenario ends with the app gone, which is why `runCase`/`runBoots` accept a per-test
`teardown` and `shutdownApp` treats W3C's `invalid session id` as an already-closed session.

