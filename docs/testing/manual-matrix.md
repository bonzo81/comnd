# Manual test matrix

What automation cannot establish, plus a dated log of the passes that were
actually performed.

Comnd targets **WCAG 2.1 AA** (`docs/specs/accessibility.md`). The automated
smoke suite is evidence towards that target; it is not proof. This document
records the other half: the checks a person has to perform, and — in the pass
log at the bottom — which of them have been done, on which platform, against
which build.

The visual reference screenshots and their review procedure live in
[visual-baseline.md](visual-baseline.md).

## Automated vs manual — the split

Nothing in this file is covered by CI. Everything in this table is, and a
reviewer should not spend manual effort re-establishing it.

| Area | Command | What it asserts |
|---|---|---|
| Focus visibility and keyboard reachability | `npm run smoke` | A visible focus indicator and a reachable path on the connection manager, terminal (side panel open and closed), settings, and the duplicate-session, KB import, replay-save and NetBox-configure dialogs |
| Focus management | `npm run smoke` | Modal focus trapped while open, restored to the invoking element on close |
| Accessible names and announcements | `npm run smoke` | A name on every control with no visible label; error toasts announced via `role="alert"` and a polite live region with a named dismiss button |
| Layout | `npm run smoke` | Side panel resizes the terminal and drives the PTY size change instead of overlaying it (ADR-003); no clipped or overlapping controls at small windows, with long host names, an expanded folder tree, or a scrolling dialog |
| Themes, Reading Comfort, enlarged text | `npm run smoke` | Dark, light and solarized themes, Reading Comfort mode and enlarged text render without clipped or overlapping controls |
| Assertion strength | `npm run smoke -- --mutation=focus\|name\|layout`, `npm run smoke:mutation` | Each category of assertion still fails when the behaviour it guards is deliberately broken |
| Visual reference | `npm run smoke:visual -- --check` | The current build reproduces the committed reference screenshots byte for byte (human review aid — see visual-baseline.md) |

The automatable half of issue #57 landed as #89 (commit `3f37b71`, PR #92).
Those assertions read computed styles, the accessibility tree and layout
geometry; they only pass for the states they visit.

Manual rows below are marked **M-n**. A pass is complete only for the rows it
actually exercised — the log records which.

## A. Screen-reader usability

Automation can assert ARIA roles and names. It cannot tell you whether a real
screen reader reads the interface in a usable order, or whether a canvas-based
terminal is navigable. These rows follow the checklists in
`docs/specs/accessibility.md` §Manual verification checklist; that file holds
the detailed steps and is the source of truth for expected announcements.

| ID | Check | Expected | Platforms |
|---|---|---|---|
| M-1 | NVDA: host list announces as a list with selected state, names each host, Arrow/Enter work | Matches accessibility.md §NVDA steps 1–2 | Windows |
| M-2 | NVDA: nav panel announces expanded/collapsed and moves with arrows | Steps 3 | Windows |
| M-3 | NVDA: host form announces the dialog, labels each field, Escape closes | Steps 4 | Windows |
| M-4 | NVDA: context menu announces items and returns focus on Escape | Steps 5 | Windows |
| M-5 | NVDA: terminal connection status is announced, xterm canvas does not crash the reader | Steps 6 | Windows |
| M-6 | NVDA: toasts announce politely; Reading Comfort toggle announces its state | Steps 7; spec 12 manual step 7 | Windows |
| M-7 | Orca: repeat M-1 to M-6 on Linux | Same expectations | Linux |
| M-8 | Screen-reader browsing of the Knowledge Base list and detail pane | Command rows announce name and selected state; detail pane reachable | Windows, Linux |

The VoiceOver checklist in accessibility.md applies to macOS builds. The smoke
driver does not support macOS, this matrix makes no macOS claim, and no
VoiceOver row is recorded here.

## B. Native dialogs and OS surfaces

WebDriver cannot see or screenshot OS-owned surfaces, and a native modal blocks
the driver, so these can only be checked by hand.

| ID | Check | Expected | Platforms |
|---|---|---|---|
| M-9 | Command Replay → delete a saved command → native `confirm()` | Native dialog appears with the command in the prompt; Cancel keeps the command; OK deletes it and the list updates | Windows, Linux |
| M-10 | Settings → export/save session log → native save dialog | Dialog opens, a chosen path is honoured, the file is written, no error toast | Windows, Linux |
| M-11 | Settings → open data directory → native folder picker | OS file manager opens at the app data directory | Windows, Linux |
| M-12 | KB export / import → native save/open dialogs | Correct default directory and file filter; cancelling leaves state untouched | Windows, Linux |
| M-13 | Window chrome: resize, maximise, restore, close; app at 800×600 and maximised | Layout reflows, no clipped controls, terminal refits, close exits cleanly | Windows, Linux |
| M-14 | OS text scaling (Windows 125%/150%, Linux equivalent) | UI and terminal remain usable; no clipped labels | Windows, Linux |

## C. Platform keyboard differences

`docs/specs/07-keyboard-shortcuts.md` maps `Ctrl`-prefixed shortcuts to `⌘` on
macOS, keeps `Ctrl+Space` literal everywhere, and reserves `Ctrl+W`,
`Ctrl+C` and `Ctrl+V` so they reach the remote. Rebinding is stored
platform-agnostically as `Mod+…`, so a config file moves between platforms.

| ID | Check | Expected | Platforms |
|---|---|---|---|
| M-15 | `Ctrl+W` at a shell prompt on a connected host | Deletes the previous word at the remote; the app does not close, intercept or swallow it | Windows, Linux |
| M-16 | `Ctrl+Space` on a connected host | Sends the literal control byte; the app never treats it as a shortcut | Windows, Linux |
| M-17 | `Ctrl+C` with a remote command running, and with no selection | Interrupt reaches the remote; copy still works when text is selected | Windows, Linux |
| M-18 | Shortcut help modal and Settings → Shortcuts render the platform's own key names | `Ctrl+…` on Windows and Linux; no macOS symbols leak in | Windows, Linux |
| M-19 | A rebinding made on one platform, then the same `config.json` used on the other | The rebinding resolves to that platform's modifier | Windows ↔ Linux |
| M-20 | Linux-only: window-manager shortcuts (`Alt+F4`, `Super`) and desktop IME input in the terminal | No conflict; IME composition reaches the remote correctly | Linux |

## D. Themes

The committed baseline is dark only. The other themes are checked here.

| ID | Check | Expected | Platforms |
|---|---|---|---|
| M-21 | Dark, Light and Solarized Light: every screen in the baseline set | No unreadable text, no invisible focus ring, no wrong-colour icon, contrast as in the findings below | Windows, Linux |
| M-22 | Terminal themes (dark, warm charcoal, cream, light) with each app theme | Terminal text stays legible; the toolbar theme button announces its four states | Windows, Linux |
| M-23 | Reading Comfort on with app theme Light or Solarized Light | App theme is stamped to Solarized Light (spec 12 §Mode semantics) — expected, not a defect | Windows, Linux |

## E. Reading Comfort mode

| ID | Check | Expected | Platforms |
|---|---|---|---|
| M-24 | Toggle on from the status bar and from Settings | Typography applies live, terminal re-fits, PTY resizes | Windows, Linux |
| M-25 | Restart the app with the mode on | Mode and all values persist (spec 12 manual step 2) | Windows, Linux |
| M-26 | Drag each slider; press Reset to preset | Values live-apply and clamp to their ranges; reset restores 16px / 1.15 / 1.4 / +2px | Windows, Linux |
| M-27 | Toggle off | Typography reverts to the pre-mode values; theme choice is kept | Windows, Linux |

## F. Enlarged text

| ID | Check | Expected | Platforms |
|---|---|---|---|
| M-28 | Reading Comfort text scale at 1.5 (maximum) on every screen | No horizontal scrolling, no control pushed off-screen, no clipped essential label | Windows, Linux |
| M-29 | Terminal font size at its maximum (`Ctrl+=` repeatedly) with the side panel open and closed | Terminal refits, suggestion dropdown and ghost text stay aligned to the prompt | Windows, Linux |
| M-30 | OS-level display scaling combined with the in-app maximum | Still usable; note anything that degrades | Windows, Linux |

## Findings from the first pass

Recorded, not fixed: issue #57 is documentation, and fixing UI or behaviour
here would mix an unreviewed change into a docs commit.

**F-1 — Reading Comfort does not re-apply its UI typography on launch.**
With `comnd-reading-comfort` stored as `{enabled: true, prevFontSize: 14,
lastFontSize: 16, uiScale: 1.15, lineHeight: 1.4, letterSpacing: 2}`, after a
reload the status-bar toggle reports `aria-pressed="true"`, but
`data-reading-comfort` is absent, `--text-scale` is unset and host names render
at 13px instead of 14.95px. Toggling off and on applies them
(`data-reading-comfort="on"`, `--text-scale: 1.15`, 14.95px). This contradicts
spec 12's manual step 2 ("Restart app → mode + all values persist"): the state
persists, the visual effect on UI text does not. Found while running M-25.

**F-2 — Contrast below AA in the Light and Solarized Light themes.**
Measured from computed styles (foreground composited over the nearest opaque
ancestor background), 2026-11-02:

| Theme | Element | Foreground on background | Size | Ratio | AA needs |
|---|---|---|---|---|---|
| Light | Active Settings nav label | `rgb(21,128,61)` on `rgb(221,240,231)` | 13px / 400 | 4.21:1 | 4.5:1 |
| Solarized Light | Active Settings nav label | `rgb(38,139,210)` on `rgb(223,231,225)` | 13px / 400 | 2.92:1 | 4.5:1 |
| Solarized Light | "New Connection" button label | `rgb(38,139,210)` on `rgb(253,246,227)` | 13px / 600 | 3.41:1 | 4.5:1 |
| Solarized Light | Recent-session timestamp ("2h ago") | `rgb(101,123,131)` on `rgb(210,219,213)` | 11px / 400 | 3.15:1 | 4.5:1 |

The Dark theme's minimum over the same elements is 6.28:1, so this is a
light-theme palette issue, not a general one. Found while running M-21.

**F-3 — The nav-panel folder label truncates at the maximum text scale.**
At `--text-scale: 1.5` in a 1280×800 window, the folder label "Core network"
gets 98px of box and needs 125px at 19.5px, so it ellipsises. It does not
truncate at the 1.15 preset. Found while running M-28.

## Pass log

One row per pass. Record the reviewer, the date, the build, the platforms
actually exercised, which rows were covered, the result, and anything you
could not do. **Never record a platform you did not run on.**

| Date | Reviewer | Build | Platforms exercised | Rows covered | Result | Notes |
|---|---|---|---|---|---|---|
| 2026-11-02 | AI agent, scripted pass through the smoke harness (no human screen-reader session) | `3f37b71` + the #57 working tree | Windows 11 Pro 10.0.26300, WebView2 156.0.4314.58, DPR 1.5, 1280×800 | M-21 (scripted), M-22 (app-theme × terminal-theme pairing by inspection of computed styles), M-23, M-24, M-25, M-26 (preset and maximum only), M-28 | Failures recorded as F-1 to F-3; everything else as expected | Screen-reader rows M-1 to M-8 **not run** — no NVDA or Orca session available. Native-dialog rows M-9 to M-14 **not run** — the driver cannot drive OS surfaces. Keyboard rows M-15 to M-20 **not run** as manual checks; `Ctrl+W` pass-through and the reserved-key rejections are asserted by `npm run smoke`. Linux was **not exercised** for any row. |

No human visual review of the theme permutations has been recorded. M-21 and
M-22 were exercised by measurement (layout geometry, computed colours,
contrast) rather than by a person looking at each screen.

## Running a pass

1. Build the app you are going to test and note the commit:
   `git rev-parse --short HEAD`, then `npm run smoke` for the debug build
   (or take the installer from the draft release).
2. Work through the rows for your platform. Rows you cannot run, you do not
   record as passed.
3. Add a row to the pass log with the date, your name, the build, the
   platforms, the rows you covered, the result, and what you could not do.
4. Any defect you are not fixing in the same change goes in
   §Findings from the first pass (or a new §Findings section) with what you
   saw, where, and how you reproduced it. Do not fix a finding silently in a
   docs change.
5. If a row exposes a visual difference in a baseline screen, follow
   [visual-baseline.md](visual-baseline.md) before re-capturing.

## Scope

- **Windows and Linux only.** The smoke driver does not support macOS; no
  macOS coverage is claimed in this repository, and a driver or toolchain
  failure on macOS is not a product regression.
- A row is only "covered" if someone actually performed it on the platform
  named. Coverage does not transfer between platforms.
- This matrix does not replace `docs/specs/accessibility.md`; it records which
  of its manual checks have been performed and what they found.
