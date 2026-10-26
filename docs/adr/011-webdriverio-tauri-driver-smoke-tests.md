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

## Consequences

- Tests cover the desktop webview, Tauri commands, real Rust SSH client, and
  mock SSH host without using external network credentials.
- Linux CI requires Xvfb, WebKitWebDriver, and tauri-driver; Windows local
  runs require a matching Edge WebDriver.
- macOS smoke coverage remains unsupported by this external-driver setup.
- The buffer hook and mock controls are absent from release Rust builds and
  normal production frontend builds.
