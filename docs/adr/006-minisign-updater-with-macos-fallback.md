# 006. Minisign-only updater; macOS falls back to GitHub until code signing lands

Date: 2026-10-15
Status: Accepted

## Context
In-app updates are Phase 2B item P1.4 (`docs/plans/024-plan-production-readiness-phase2b-code-signing.md`). The updater authenticates with a minisign key (`tauri signer generate`) — free and local, independent of the Apple/Windows code-signing certs in P0.1. A minisign-only updater works on the existing GitHub-Release workflow (P0.2a: `release.yml` + `tauri-apps/tauri-action@v1`) before any paid account exists. Code signing / notarization (P0.1) is deferred until a no-vendor-warning public release is required, and is not in scope for this work.

## Options
- **Full code-signing + notarization now.** Cost: requires an Apple Developer Program account ($99/yr), a Developer ID cert, and a Windows signing certificate before any update can ship — weeks of lead time and cost, blocking the feature on prerequisites that are not needed yet.
- **Minisign-only updater now; macOS falls back to opening GitHub Releases.** Cost: Windows/Linux updates still trigger SmartScreen until P0.1 lands; macOS never does a silent in-app replace until it is notarized (Gatekeeper would block an unsigned `.app` swap).

## Decision
Ship the Tauri updater with a minisign key only, on the existing GitHub-Release workflow. Windows and Linux get real in-app updates (download + install + relaunch). macOS does not attempt a silent replace — its update indicator opens the latest GitHub Release page instead. This is revisited when P0.1 code signing / notarization lands.

## Consequences
- Easier: no certificate or account prerequisites; the updater ships on the existing CI (P0.2a) with one minisign secret; Windows + Linux users self-update in-app today.
- Harder: every Windows/Linux update still triggers SmartScreen until P0.1; macOS users must install manually via GitHub Releases until notarization exists.
- Rules out: silent in-app replace on macOS before code signing / notarization (P0.1/P0.2b); any reliance on Apple/Windows signing certs for the updater path.
