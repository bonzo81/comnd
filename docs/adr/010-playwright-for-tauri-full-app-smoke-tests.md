# 010. Playwright for Tauri drives the full-app SSH smoke tests

Date: 2026-10-20
Status: Superseded by ADR-011

## Context
Issue #53 (full-app SSH smoke tests using the existing mock host) is Priority 1 of the testing backlog. Its acceptance criteria require proving the **full path** — frontend → Tauri IPC → Rust SSH → terminal UI — on a real boot of the app, across all 10 scenarios, wired into CI.

The existing coverage does not get there: `tests/harness.ts` mocks the IPC boundary (`docs/plans/054-plan-test-harness.md`), and the Rust tests exercise a local mock SSH server (`src-tauri/src/test_server.rs`, `docs/plans/005`) whose "Skipped" section explicitly deferred GUI end-to-end as a separate lift. The new suite must run alongside the existing frontend and rust jobs in `.github/workflows/ci.yml` on `ubuntu-22.04`, where headless Linux needs a display server (Xvfb) and the real app binary must actually launch. So we need to settle which native automation drives the Tauri v2 webview.

## Options
- **Playwright for Tauri v2 (webview automation).** Drives the real app binary. Cost: cross-platform support is not guaranteed uniform — it must be verified per OS with a small throwaway script before CI wiring, and headless Linux requires Xvfb.
- **Raw WebDriver harness as the fallback** for any platform Playwright-for-Tauri doesn't cover. Cost: hand-rolled glue and less "it's just Playwright" ergonomics on those platforms.
- **Headless / no-GUI smoke that skips launching the real webview.** Cost: never exercises frontend → IPC → SSH → terminal, so it cannot satisfy #53's goal — vacuous coverage.

## Decision
Use Playwright for Tauri v2 to drive the real app binary's webview for #53's smoke tests, with a raw WebDriver harness as fallback for any platform Playwright-for-Tauri doesn't cover. Verify each platform's support with a throwaway script before wiring CI; document any unsupported platform or required manual check rather than assuming it passes.

## Consequences
- Easier: one driver (Playwright) to author and run app-level smoke tests, reusing the existing mock host and CI jobs.
- Harder: Linux CI needs Xvfb plus launching the real binary on a supported OS; platform support must be verified per OS before committing to it.
- Rules out: treating the mocked-IPC harness (`tests/harness.ts`) as full-app coverage, and any no-GUI shortcut that skips the webview.
