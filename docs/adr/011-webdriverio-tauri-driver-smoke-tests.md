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
- The mutation check is verified by breaking the drop: add
  `if (data.length >= 0) return;` inside the connected branch of `sendData` in
  `src/components/terminal-view.ts`, ahead of `sshSend`. A bare `return;` at the
  top of `sendData` instead fails the smoke build on `tsc` (`TS2345` on the
  `sessionId` narrowing).
