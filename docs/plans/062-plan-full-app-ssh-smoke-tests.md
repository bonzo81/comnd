# Plan: Full-app SSH smoke tests (issue #53)

Status: Implemented and verified locally; Linux CI verification pending.
Spec: bonzo81/comnd#53. Task prompt: `prompts/add-full-app-ssh-smoke-tests.md`.
Supersedes: `docs/adr/010-playwright-for-tauri-full-app-smoke-tests.md`; decision recorded in `docs/adr/011-webdriverio-tauri-driver-smoke-tests.md`.

## Background

Existing tests do not prove the full path (frontend, Tauri IPC, Rust SSH, terminal UI):

- `tests/harness.ts` (plan 054) mocks Tauri IPC. Not full-app coverage.
- Rust tests use `src-tauri/src/test_server.rs` for real local SSH auth. No UI.

These smoke tests boot the real debug desktop app against an ephemeral mock host and assert on observable outcomes.

## Decisions

1. **Driver: WebdriverIO + tauri-driver.** Playwright cannot drive WebKitGTK (Linux) because it needs CDP, which WebKitGTK does not expose. tauri-driver with `webkit2gtk-driver` under Xvfb covers Linux and Windows.
2. **Terminal text: debug-only xterm buffer hook.** xterm renders to canvas, so text is not in the DOM. The hook exposes `buffer.active` to `browser.execute`. It is compiled out of release builds.
3. **Isolation: `COMND_DATA_DIR` override** in `src-tauri/src/paths/mod.rs`. Works on all platforms. Each scenario gets a temp dir.
4. **Credentials: `COMND_TEST_MOCK_SECRET`** test-only env secret provider. No keyring, which CI does not have.

## Platform verification

- **Windows:** Verified locally with a debug build and tauri-driver. WebView2 matched the installed WebDriver version; `npm run smoke` and `npm run smoke:mutation` passed. `tauri-driver` needs `msedgedriver.exe` matching the installed WebView2 on `PATH`; it exits at startup otherwise and the runner prints its stderr in the failure.
- **Linux:** CI job is configured on Ubuntu 22.04 with `webkit2gtk-driver` and Xvfb. A passing CI run is still required; this Windows machine cannot verify Linux. Session capabilities carry no `browserName`: tauri-driver injects the native one on Windows, and WebKitWebDriver rejects `wry` with "Failed to match capabilities".
- **macOS:** Unsupported by this external-driver setup; no smoke coverage is claimed.

## Files touched

- `src-tauri/src/test_server.rs`: record received bytes per connection; add a server-initiated disconnect control. Exercised by `command-round-trip` and `server-disconnect` (no separate Rust unit tests: the controls only exist for the smoke suite).
- `src-tauri/src/paths/mod.rs`: `COMND_DATA_DIR` override. Exercised by every scenario (each asserts its temp dir was used).
- `src-tauri/src/secrets/mod.rs`: confirm `COMND_TEST_MOCK_SECRET` is debug-gated or test-only.
- `src/components/terminal-view.ts`: debug-only buffer hook (`window.__comndTerminal` or similar), gated by a build flag.
- `test/smoke/*`: WebdriverIO config, launcher (starts mock, tauri-driver, Xvfb on Linux), and specs.
- `package.json`: `smoke` script; WebdriverIO devDependencies.
- `.github/workflows/ci.yml`: new `smoke` job on ubuntu-22.04.
- `docs/adr/011-webdriverio-tauri-driver-smoke-tests.md`: new ADR (supersedes 010).

## Named tests and assertions

| # | Test | Assertions |
|---|---|---|
| 1 | `launch-and-connect` | Test host selected; status bar `.tv-sb-dot` connected; mock remote prompt (`user@host:~$`) in xterm buffer. |
| 2 | `command-round-trip` | Command reaches mock as exact bytes, once. Buffer shows one echo; no local duplicate. |
| 3 | `suggestion-accept` | Ghost text appears for a prefix; Tab adds only the remainder; exact bytes reach mock. |
| 4 | `tab-passthrough` | Tab with no suggestion showing sends `\t` to mock. |
| 5 | `auth-reject-cancel` | Failed-auth host shows a recovery message; cancel returns to Connections with no terminal session. |
| 6a | `user-disconnect` | User disconnect returns to Connections with zero sessions; mock observes its handler close; temp data removed. |
| 6b | `server-disconnect` | Mock closes the SSH channel on command; app returns to Connections; exact command bytes are recorded. |
| 7 | `mutation-check` | Muted remote output causes the command-round-trip echo assertion to fail with a behavior-specific message. Not in default run. |
| 8 | `ctrl-w-passthrough` | Ctrl+W bytes (`0x17`) reach mock unchanged; app does not intercept. |
| 9 | `isolation-cleanup` | Temp data dir and mock process gone after pass and after forced failure. |
| 10 | `failure-clarity` | A deliberate assertion failure names the specific behavior; the mutation run reports the missing remote echo. |

Named tests 1–6b, 8–10 run in `npm run smoke`. Test 7 runs via `npm run smoke:mutation`.

## Local command

`npm run smoke`: builds the debug app, starts Xvfb (Linux), starts the mock host, runs WebdriverIO specs, and tears down all owned processes on exit.

## CI placement

New `smoke` job in `.github/workflows/ci.yml`:

- runs-on: ubuntu-22.04
- apt: `webkit2gtk-driver`, `xvfb`, and existing webkit2gtk-4.1 deps
- `cargo install tauri-driver`
- `xvfb-run npm run smoke`

Needs a passing run recorded before the task is done.

## Verification gates

- `npm run build`
- `npm run test`
- `cargo check --all-targets` (in `src-tauri/`)
- `cargo test` (in `src-tauri/`)
- `npm run smoke`

## Open items

- Passing Linux CI run.
