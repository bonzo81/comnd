# Visual baseline

Reference screenshots of the main screens, captured through the smoke harness
and committed so a reviewer can compare a change against a known-good picture.

**These images are a review aid, not a gate.** There is no pixel diff in CI, no
snapshot per theme or scale permutation, and nothing fails when an image
changes. CI runs `npm run smoke` and the mutation runs; the baseline is only
ever looked at by a human. Issue #57 tracks the split between what automation
asserts and what a person must check — that split lives in
[manual-matrix.md](manual-matrix.md).

## What is covered

Committed set: `test/smoke/visual-baseline/windows/`.

| File | Screen | State |
|---|---|---|
| `01-connections.png` | Connections | Three seeded hosts in Recent Sessions; nav tree with the "Core network" folder expanded and "Edge" collapsed |
| `02-dialog-new-connection.png` | New connection dialog | Empty form, opened with `Ctrl+N` |
| `03-dialog-shortcuts.png` | Keyboard shortcuts dialog | Opened from the status-bar keyboard button |
| `04-knowledge-base.png` | Knowledge Base | First command of the default platform selected, detail pane populated |
| `05-dialog-confirm-delete.png` | Delete confirmation | In-app confirm dialog over the Knowledge Base |
| `06-replay.png` | Command Replay | Three seeded commands across three platforms, one containing a `{{variable}}` |
| `07-settings-general.png` | Settings | General pane |
| `08-terminal-sidebar-closed.png` | Terminal | `ip ` typed at the mock prompt: one command row (`ip`) plus ghost text `addr`; side panel closed |
| `09-terminal-sidebar-open.png` | Terminal | Same command line with the side panel open on the `ip` detail |

`manifest.json` sits beside them and records the geometry the set was captured
at, plus each shot's screen, state, SHA-256 and pixel size.

The committed set was last captured on 2026-11-03 on Windows 11 (WebView2
156.0.4314.58, DPR 2, 1280×800). Re-capture reproducibility was checked by
capturing five times in a row and comparing every file's SHA-256 against the
committed set: identical every time.

### What is deliberately not covered

| Excluded | Why |
|---|---|
| Light, solarized and the other app themes | `npm run smoke` already asserts these render without clipped or overlapping controls; one image per permutation is exactly the maintenance burden #57 rules out. Eyeballing each theme is in the manual matrix. |
| Reading Comfort on, enlarged text | Same reason; the smoke suite covers the mode, and the manual matrix records a pass at the preset and at the maximum text scale. |
| Settings → Logging, About | Paths and version strings are machine-specific, so the images could never reproduce. |
| Settings → NetBox, LLM API, Auth Integrations | Credential-shaped fields; the capture must not write anything that looks like a secret, even a placeholder. |
| Native file, import and export dialogs, OS window chrome | WebDriver cannot screenshot OS surfaces. Manual matrix. |
| Replay delete's native `confirm()` | Same — it is an OS dialog, not app UI. Manual matrix. |
| Empty states, error toasts, loading states | Already asserted in `npm run smoke`; a static image adds nothing a reviewer cannot get from the assertion. |
| macOS | The smoke driver does not support it. No macOS coverage is claimed anywhere in this repo. |

## Committed geometry

The manifest is the source of truth; this section explains it.

- **Viewport 1280×800 CSS px**, set through WebDriver once the window is up.
- **Device pixel ratio is recorded, not forced.** WebView2 ignores
  `--force-device-scale-factor`, so a capture inherits the host's display scale.
  The committed Windows set was captured at **DPR 2**, which is why the PNGs are
  2560×1600. A machine at a different scale produces the same layout at a
  different pixel count; `--check` reports that as an `ENVIRONMENT MISMATCH` and
  does not compare, because no file could match. That is a display setting, not
  a regression — see [Re-capturing](#re-capturing).
- **Dark app theme, dark terminal theme, Reading Comfort off, terminal font
  14px**, all written to `localStorage` explicitly and then reloaded, so the
  capture never inherits preferences left behind by an earlier manual run.
- **Suggestions are enabled through the terminal toolbar toggle** during the
  capture so the dropdown and ghost text are reviewable; the stored default is
  off.
- **Animations, transitions and the text caret are disabled** by a stylesheet
  injected before the first shot, so nothing is caught mid-fade.
- **The pointer is parked at the viewport origin before every shot.** Element
  clicks leave the real cursor wherever they landed, so the row under it kept a
  `:hover` tint and re-captures differed by one row of text.
- **The xterm cursor is pinned lit.** The terminal blinks its cursor on a timer,
  so a screenshot lands with the cursor lit or dark depending on timing. The
  capture sets `window.__comndTerminal.options.cursorBlink = false` before every
  shot and records `terminalCursorBlink: false` in the manifest.
- **Data is seeded over IPC only**: two folders, three decorative hosts, one
  mock host, three replay commands. No credentials, no personal data, and a
  forbidden-text guard (`smoke-secret`, `BEGIN OPENSSH`, `PRIVATE KEY`,
  `Bearer `, `C:\Users`, `/home/` and similar) runs before anything is
  written.
- **All nine shots come from one app boot**, so the sequence is reproducible as
  a sequence and the run stays inside the smoke suite's per-case timeout.

## Capturing

Prerequisites are the smoke suite's own: a built debug app, `msedgedriver` on
`PATH` on Windows, `xvfb-run` on Linux. See `docs/plans/062-plan-full-app-ssh-smoke-tests.md`.

```sh
npm run smoke:visual                          # rewrite the committed set for this platform
npm run smoke:visual -- --check                # capture to a temp dir, compare, then delete it
npm run smoke:visual -- --out=tmp/review       # capture somewhere you can look at the images
npm run smoke:visual -- --platform=linux       # write test/smoke/visual-baseline/linux/
```

`--check` deletes only the temporary directory it allocated itself. An explicit
`--out` directory is yours and is never removed, so `--check --out=tmp/review`
keeps the fresh images for inspection alongside the comparison result.

A plain capture writes into a temporary directory and copies the result into
`test/smoke/visual-baseline/<platform>/` only after every screenshot and the
manifest were produced, so an interrupted or failed capture leaves the
committed set whole. `--out` is written directly, and `--check` refuses an
`--out` that points at the committed baseline, because comparing a capture with
itself always passes.

On a machine with `core.autocrlf=true` (the Git for Windows default) the
regenerated `manifest.json` is written with LF endings, so `git status` lists it
as modified while `git diff` shows nothing. Confirm with `git diff --
test/smoke/visual-baseline/<platform>/manifest.json`; if it prints nothing,
`git checkout --` the file. The screenshots are binary and re-capture
byte-for-byte, so they do not have this problem.

`--platform` defaults to `windows` on Windows and `linux` elsewhere. A Linux
set is not committed yet: run the command on a Linux host and commit the
result under `test/smoke/visual-baseline/linux/`. Until then there is no Linux
baseline and no claim of one.

## When to re-capture

Re-capture, then review the difference by eye before committing the new images,
when:

1. You changed layout, spacing, colour tokens or a component's markup.
2. You added or removed a screen, dialog or nav item — update the shot list in
   `test/smoke/visual.mjs` in the same commit.
3. You changed the seeded fixture (the host, folder or replay data in
   `test/smoke/visual.mjs`).
4. You changed the viewport, theme or font defaults in `test/smoke/visual.mjs`.
5. You are preparing a release and the last capture predates the changes in it.

Do **not** re-capture to make a red `--check` go away. A red `--check` means
the app renders differently; the question is whether the difference is
intended.

### Re-capturing after a display-scale change

If `--check` stops with `ENVIRONMENT MISMATCH`, your display scale is not the
one in `manifest.json`. Nothing is wrong with the app and there is nothing to
review. Two honest options:

1. Run on a display at the recorded scale and compare there; or
2. Re-capture and commit the new set **together with the new
   `devicePixelRatio` in `manifest.json`**, saying in the commit message that
   only the scale changed. Verify first that two consecutive captures agree —
   `--out=tmp/a`, `--out=tmp/b`, then compare the hashes — so the new set is
   known reproducible before it lands.

Never re-capture at a different scale and describe the result as a layout
change, and never lower the recorded scale in the manifest to match a machine.

## Reviewing a changed screenshot by eye

`--check` only tells you byte equality. When it reports `DIFFERS`, look at the
picture:

1. `npm run smoke:visual -- --out=tmp/review` — a plain `--check` deletes its
   temp directory, so use `--out` to keep a set you can open.
2. Open the committed image and the fresh one side by side, same file name. On
   Windows: `start test\smoke\visual-baseline\windows\07-settings-general.png`
   then `start tmp\review\07-settings-general.png`; any viewer that shows two
   windows works.
3. Work through the shot's stated state, not the whole frame at once:
   - Is every label fully drawn, with no ellipsis or overlap the committed
     image did not have?
   - Is the focus ring, selection highlight and active nav item in the same
     place?
   - Are colours, spacing and alignment unchanged apart from the intended edit?
   - For the terminal shots: are the command line, suggestion row and ghost
     text in the same position relative to the prompt?
4. Read `manifest.json` for each file's state description — that text is the
   contract for what the image is supposed to show.
5. Decide. Intended change → commit the new PNGs and manifest. Unintended →
   fix the code and re-capture. A real defect you are not fixing in this change
   goes in the manual matrix's findings section; do not doctor the baseline to
   hide it.

Reviewing by eye cannot be replaced by reading the hash, and the hash cannot be
replaced by eyeballing: run `--check` first to know *which* images to look at.

## What `--check` proves and does not prove

Proves: on a machine at the recorded display scale, the current build reproduces
each committed image **byte for byte** — same viewport, same pixels, same
encoding. It reads each committed PNG and verifies it against the hash and pixel
size recorded in `manifest.json` before comparing, so an image edited or
corrupted without a manifest update is reported as `BASELINE MODIFIED` rather
than silently accepted. It compares the two inventories, so a screenshot
captured but never committed is reported as `NOT IN BASELINE` instead of being
ignored, and it compares each shot's `screen` label and the manifest's
`terminalSuggestion` field, reporting a stale description as `METADATA`. It
prints the fresh DPR and pixel size, and when the display scale differs it stops
with `ENVIRONMENT MISMATCH` instead of listing nine misleading differences; the
committed-image integrity check still runs in that case, so a damaged baseline
is reported alongside the mismatch.

Does not prove: that the image is correct, accessible or attractive; that
another platform renders identically (font rasterisation and scale factor
differ, which is why sets are per platform); or that anything in CI will fail
if an image changes. `--check` is a local command; no workflow runs it. It also
does not compare the free-text `state` description — that is prose, and editing
it is not a rendering change.
