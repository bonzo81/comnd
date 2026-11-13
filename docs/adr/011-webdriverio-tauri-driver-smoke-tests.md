# 011. WebdriverIO with tauri-driver for full-app SSH smoke tests

Date: 2026-10-20
Status: Accepted
Supersedes: ADR-010

## Context

Issue #53 requires tests to launch the real Comnd desktop app and verify the
full frontend → Tauri IPC → Rust SSH → terminal path. The app uses WebKitGTK
on Linux and WebView2 on Windows, so a driver that depends on Chrome DevTools
Protocol does not cover the Linux CI platform.

## Decision

Use WebdriverIO with Tauri's external `tauri-driver` for the Linux CI smoke
job and Windows local runs. The driver launches the debug app binary. Linux
headless runs use Xvfb and `webkit2gtk-driver`; Windows requires a compatible
`msedgedriver`. macOS is not covered by this external-driver setup.

The smoke build exposes xterm's active buffer only when built in `smoke` Vite
mode. Test SSH servers, secret providers, data-directory overrides, and
mutation behavior are restricted to Rust debug builds. Each scenario receives
its own temporary data directory and test-only secret through its process
environment.

Amended 2026-10-30: recorded where the mutation applies, after issue #61 moved it from
the mock host into the `ssh_send` command.

The mutation check breaks app code rather than test infrastructure: setting
`COMND_SMOKE_MUTATION=ssh_send` makes the `ssh_send` command drop typed input
before it reaches the SSH session, so a passing run proves the harness observes
real app behaviour. The mock host's echo path stays intact.

Amended 2026-10-31: after issue #78, the debug-only `test_smoke_mutation_drops`
command reports how many bytes the drop discarded. The mutation run reads it
after the expected failure and passes only when the count is non-zero, so a
frontend that never reaches `ssh_send` fails the check even though the mock
still receives zero bytes. The count is read inside the scenario's `run`,
because `runCase` destroys the WebDriver session in `finally` — once the
scenario returns there is no channel left to read it.

Amended 2026-11-02: after issue #89, the mutation carries a category. The flag
accepts `ssh_send`, `focus`, `name`, `layout` and `suggestion`; a bare
`--mutation` still means `ssh_send`, so `npm run smoke:mutation` is unchanged.
Rust gates the whole path on `debug_assertions` and returns the active category
through the debug-only `test_smoke_mutation` command; the frontend records it
on `document.documentElement.dataset.smokeMutation`, and each category's
scenario asserts that marker before reporting its failure, so a category cannot
pass by breaking nothing. The four frontend categories inject their regression
from `src/lib/smoke-mutation.ts` before `new App()`: `focus` removes every
visible focus indicator, `name` strips `aria-label`, `aria-labelledby` and
`title` from controls with no visible text, `layout` positions the sidebar over
the terminal instead of resizing it — the ADR-003 violation the resize
assertion exists to catch — and `suggestion` writes the marker only, which
makes `SuggestionEngine.stripPrefix` stop stripping a prefix command.

Amended 2026-11-05: after issue #138, `suggestion` is deliberately scoped to
the prefix path. A repaint or anchoring regression would also fail
`suggestion-accept`, breaking the one-category-one-scenario rule, so instead
only `prefix-suggestion` — the one scenario that types `sudo system` — loses
its ghost. `suggestion-accept` grew the anchor and hit-test assertions, and
`dropdown-click` covers mouse accept, so a broken overlay now fails the clean
run as well as a mutation.

Amended 2026-11-13: after issue #133, two more categories cover control geometry
at the window the app opens with (1200x800), because the visual baseline is a
review aid and a pixel diff cannot tell a control that moved off screen from one
that was restyled. `kb-layout` moves `.cmd-actions` and `.kb-count` off the right
edge, so `kb-layout`'s in-window box assertion has to fail;
`terminal-sidebar-layout` does the same for the terminal side panel's
`.example-copy`, `.cmd-ref-link` and `#tv-sidebar-resizer`, pinning them to the
viewport with `position: fixed` because the panel scrolls and a scrolled box
would otherwise come back into view. Scrolling into view is vertical only: the
panel's `overflow-y: auto` makes it scroll horizontally too, so a horizontal
scroll could pull a control that really overflows back into the window and hide
the regression, and the helper restores every ancestor's horizontal offset
before it measures. Both scenarios also hit-test each control's
centre and assert that `.kb-command-detail` and `.sb-content` do not scroll
horizontally, which keeps the assertion honest about an element that is on screen
but covered. Neither scenario resizes the window: it measures what the default
window shows.

## Consequences

- Tests cover the desktop webview, Tauri commands, real Rust SSH client, and
  mock SSH host without using external network credentials.
- Linux CI requires Xvfb, WebKitWebDriver, and tauri-driver; Windows local
  runs require a matching Edge WebDriver.
- macOS smoke coverage remains unsupported by this external-driver setup.
- Because the mutation drops input, the expected failure surfaces in
  `waitForBytes` as zero bytes received; the matcher accepts only that form,
  requires the app-reported non-zero drop count, and names the scenario it
  broke.
- The buffer hook and mock controls are absent from release Rust builds and
  normal production frontend builds.
- Each mutation category breaks exactly one scenario and reports two facts: the
  assertion's own failure message and `mutation activation: <category> applied`.
  Only the `ssh_send` run also requires the non-zero drop count, because only it
  touches the SSH path. The six frontend categories sit behind the same
  `#[cfg(debug_assertions)]` command and the `smoke` Vite mode, so neither the
  command nor the module ships in a release build.
- The mutation check is verified by breaking the drop: add
  `if (data.length >= 0) return;` inside the connected branch of `sendData` in
  `src/components/terminal-view.ts`, ahead of `sshSend`. A bare `return;` at the
  top of `sendData` instead fails the smoke build on `tsc` (`TS2345` on the
  `sessionId` narrowing).
