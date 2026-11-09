# Agents.md — Comnd

AI agent behavior and conventions for the Comnd project.

## Project Context

Comnd is a cross-platform desktop SSH client with context-aware command suggestions for network engineers.

**Stack:** Tauri v2 (Rust) + TypeScript/Vite frontend + xterm.js terminal emulator

**Target platforms:** Windows, macOS, Linux desktop app; network devices (Linux/bash, Cisco IOS-XE, Cisco NX-OS, F5 BIG-IP TMOS)

## Documentation Hierarchy

Read these docs before implementing anything in their domain:

| Domain | Doc |
|---|---|
| Goals, scope, target platforms | `docs/specs/01-overview-goals.md` |
| SSH, keystroke flow, prompt detection | `docs/specs/02-technical-architecture.md` |
| UI layout, colors, typography, components | `docs/specs/03-ui-visual-design.md` |
| Host list, empty state, forms | `docs/specs/04-connection-manager.md` |
| Ghost text, dropdown, mode detection | `docs/specs/05-suggestion-engine.md` |
| YAML schema, version filtering, matching | `docs/specs/06-knowledge-base.md` |
| Shortcuts, keyboard-first design | `docs/specs/07-keyboard-shortcuts.md` |
| Post-MVP backlog, decision log | `docs/specs/08-future-open-questions.md` |
| Command Replay (user-saved commands, variables, playback) | `docs/specs/09-command-replay.md` |
| Custom KB (user-wins merge, provenance, import) | `docs/specs/10-custom-knowledge-base.md` |
| Shortcut customization | `docs/specs/11-shortcut-customization.md` |
| Reading Comfort mode (dyslexia) | `docs/specs/12-dyslexia-mode.md` |
| Accessibility conformance target (WCAG 2.1 AA) | `docs/specs/accessibility.md` |

Implementation plans live in `docs/plans/`. Read the plan document for a feature before you build it.

## Non-Negotiable Architecture Rules

1. **Shadow buffer model** — No local echo; keystrokes reach the remote in real time, and the frontend keeps an observe-only shadow buffer. See ADR-001.

2. **Input handling in frontend** — Keystrokes are handled in the xterm.js handler; never routed through Rust. Bounded exception: pre-channel auth-phase prompt responses cross via one dedicated IPC command during connect only. See ADR-002, ADR-005.

3. **Prompt detection** — State machine in frontend: ANSI strip → idle detection (200ms) → regex match against platform `prompt_patterns`. This powers mode awareness and shadow buffer reset.

4. **Sidebar pushes terminal** — The side panel resizes (never overlays) the terminal; PTY resize on open/close. See ADR-003.

5. **Tab is context-sensitive** — Accepts ghost suggestion when one is showing; passes through to remote when no suggestion is visible.

6. **Keyboard-first** — Entire app must be navigable without a mouse. `Ctrl+W` must pass through to remote (delete-word in shells).

## Code Style

### TypeScript (Frontend)

- Strict mode enabled
- ES modules (`import`/`export`)
- Classes for stateful components, functions for utilities
- No React/Vue/Svelte — vanilla TypeScript with DOM manipulation
- xterm.js v5 (`@xterm/xterm`)

### Rust (Backend)

- Edition 2021
- Async everywhere (tokio runtime)
- `russh` for SSH, `yaml_serde` for YAML (NOT `serde_yml`/`serde_yaml` — both unmaintained and unsound)
- `dirs` crate for platform-appropriate data paths
- Tauri v2 command handlers are `async fn` with `#[tauri::command]`
- Error handling: return `Result<T, String>` from Tauri commands
- Test HTTP mocks (e.g. the `sse_test_mock` in `src-tauri/src/llm.rs`) must serve responses per HTTP request, not per connection — the reqwest client pools keep-alive connections, so per-connection response queues desync between requests and flake on CI

### CSS

- CSS custom properties for all colors (defined in `:root` in `src/styles/tokens.css`)
- Tokens only — no raw px font sizes, colors, or shadows in component CSS; use `--font-size-*`, `--color-*`, `--shadow-*`, `--radius-*`
- One input class: `.form-input` (+ `.form-input-sm` size modifier). Do not hand-roll new input/select styles; compose with layout-only classes
- No `var()` fallbacks for tokens — tokens are always defined
- No inline `style="..."` in TS markup except dynamic values (positions, indents); everything else gets a class
- 4px spacing grid (`--space-*`)
- Multiple app themes (dark, light, solarized) — tokens in `tokens.css`, component styles in `src/styles/components/`
- JetBrains Mono for terminal and code; Inter for UI text (via `@fontsource`)

The token standard is `docs/adr/018-css-token-naming-standard.md`; `npm run lint:css` enforces it in the `frontend` job. Namespaces are `--color-*`, `--space-*`, `--font-size-*`, `--radius-*`, `--shadow-*`, `--focus-ring-*`, `--ghost-*`, `--prose-*`, plus `--local-*` for a value scoped to one component. Colour roles include `--color-fg-on-danger` (text on a danger fill), `--color-scrollbar-thumb(-hover)` and `--color-focus-ring`. A component must not reach for a primitive as a role, and `--local-*` must never hold a colour.

## Knowledge Base

- YAML files in `knowledge-base/<platform>/commands/<category>.yaml`
- Schema defined in `docs/specs/06-knowledge-base.md`
- Each platform is self-contained, because platforms name commands differently. Duplication across platforms is intentional.

## What NOT To Do

- No LLM in the suggestion/keystroke path; LLM only for KB import (`import.rs`). See ADR-004.
- No `serde_yml`/`serde_yaml` — use `yaml_serde` (the maintained serde-yaml fork)
- No sidebar overlay on terminal
- No `Ctrl+W` interception — must pass through to remote
- No local echo — shadow buffer observes only
- No heavy logic in Rust that could run in the frontend. IPC latency harms the terminal.
- No manual git tags or GitHub releases — release-please creates both; a human only publishes the draft
- No writes to the NetBox API — the integration is strictly read-only (GET only). All NetBox HTTP must go through the `readonly_http` guard in `src-tauri/src/netbox.rs`; never bypass it with a raw `reqwest::Client`, and never add a write command (`netbox_*` Tauri commands are reads/syncs only)

## File Locations

```
src/                    # TypeScript frontend (strict mode, ES modules)
  components/           # Screens & UI (one class per screen: host-screen,
                        #   terminal-view, kb-screen, settings-screen,
                        #   replay-screen, nav-panel, global-search,
                        #   kb-import-dialog, kb-viewer-dialog,
                        #   netbox-configure-dialog, replay-save-dialog)
  lib/                  # Utilities (one concern per file: suggestion-engine,
                        #   suggestion-controller, dropdown, shadow-buffer, line-tracker,
                        #   ghost-text, ansi, tokens, theme, a11y, platforms, replay,
                        #   tauri-api, modal, logger, toast, reading-comfort,
                        #   output-highlighter, ...)
  styles/
    tokens.css          # Design tokens (:root custom properties)
    base.css            # Base/reset styles
    main.css            # Global styles
    components/         # Per-component stylesheets (one _file per component)
  main.ts               # Entry point, view switching
                        #   (connections | terminal | knowledge-base | replay | settings)

src-tauri/              # Rust backend
  src/
    main.rs             # Binary entry point
    lib.rs              # Most Tauri command handlers
    state.rs            # Shared AppState (every handler locks its store here)
    ssh.rs              # SSH session (russh)
    hosts.rs            # Host storage
    credentials.rs      # Credential resolution + keyring helpers
    secrets/            # Secret providers (mod.rs + agent.rs for SSH agent;
                        #   providers/mod.rs + providers/proton.rs for Proton Pass)
    kb/                 # Knowledge base (mod.rs + schema, validate, store,
                        #   user_files, commands, test_util modules)
    import.rs           # KB import pipeline
    llm.rs              # LLM client (KB import only)
    netbox.rs           # NetBox host source
    platform.rs         # Platform registry (auto-discovers <platform>/index.yaml)
    config.rs           # App settings
    replay.rs           # Command Replay storage + its own command handlers
    session_log.rs      # Session logging
    transcript.rs       # Terminal output seam: session log + ssh-output fan-out
    paths/              # Data/log directory resolution (mod + commands)
    test_server.rs      # Mock SSH server for testing
  Cargo.toml            # Rust dependencies
  tauri.conf.json       # Tauri configuration

test/smoke/             # Full-app WebDriver smoke suite (npm run smoke; mock SSH
                        #   host in src-tauri/src/test_server.rs)

docs/                   # Specification documents, implementation plans, roadmap

knowledge-base/         # YAML knowledge bases per platform
  cisco-iosxe/          # index.yaml + commands/<category>.yaml
  cisco-nxos/           # same layout
  f5-tmos/              # same layout
  linux-bash/           # same layout
```

## Verification Requirements

Before marking a task complete:
- Frontend changes: run `npm run build`. It runs `tsc`. The command must exit 0.
- Frontend logic with test files: run `npm run test` (vitest). It must exit 0.
- CI resolves Node from `lts/*` (four jobs in `ci.yml`); there is no `engines` field and no `.nvmrc`, so a new LTS can break `npm run test` on every OS with no code change. Node 26 defines `localStorage` and `sessionStorage` on `globalThis` but leaves them `undefined` unless the process starts with `--localstorage-file`, and Vitest's jsdom environment does not overwrite globals that already exist — `tests/harness.ts` therefore installs an in-memory `Storage` for both. Reproduce a CI-only frontend failure locally with `npm exec --yes --package=node@<version> -- node node_modules/vitest/vitest.mjs run`.
- Frontend unit tests are co-located with source as `*.test.ts` files in the same directory (e.g., `src/lib/suggestion-engine.test.ts` tests `src/lib/suggestion-engine.ts`). Do not create a separate `tests/` directory for unit tests — the top-level `tests/` holds harness-based integration tests.
- Rust changes: run `cargo check --all-targets` in `src-tauri/`. It must exit 0.
- Rust tests: run `cargo test` in `src-tauri/`. It must exit 0 (CI runs this on every PR).
- `cfg(test)` and `cfg(debug_assertions)` are independent: `cargo test --release` compiles tests with `debug_assertions` off, so a test that touches a debug-only helper fails to compile with `E0425 cannot find ...` even though `cargo test` passes. Gate the helper and its test `#[cfg(any(debug_assertions, test))]`, as `pub mod test_server` does at `src-tauri/src/lib.rs:10`, and run `cargo test --release --lib --no-run` when you add a test around debug-only code — CI runs only the debug profile, so nothing else catches it.
- Coverage is a report *and* four per-area line floors. `npm run test:coverage` (Vitest v8) fails below 78% lines in `src/lib/**` or 29% lines in `src/components/**`; `cargo llvm-cov --no-report` then `cargo llvm-cov report --json --summary-only --output-path target/coverage.json` in `src-tauri/` followed by `npm run test:coverage:rust` fails below 65% lines for `hosts.rs` + `replay.rs` + `config.rs` or 35% lines for `lib.rs`. Both gates run on the `ubuntu-22.04` leg only, and there is no global target, no per-file check and no `continue-on-error`. `cargo llvm-cov --html --output-dir target/coverage-html` reproduces the published report; `cargo llvm-cov report` prints the per-file table. CI uploads `coverage-frontend` and `coverage-rust` artifacts on pull requests only. When a floor trips, add a test or lower the floor in the same PR with the new derivation in `docs/plans/065-plan-test-coverage.md` — never mute the step. Rust branch coverage needs nightly and is not measured — never claim it, and no floor covers it. Floors, derivation, headroom and measurement limits are in `docs/plans/065-plan-test-coverage.md` and `docs/adr/016-targeted-coverage-floors.md`.
- Smoke tests: run `npm run smoke` when a change touches the keystroke path, the suggestion controller, the terminal view, or the smoke suite itself. It boots the real debug app against an ephemeral mock host; see `docs/plans/062-plan-full-app-ssh-smoke-tests.md`. Supported hosts are Linux (needs `xvfb-run`) and Windows. macOS is not supported by the driver setup and no smoke coverage is claimed there, so a driver or toolchain failure on macOS is not a product regression. Add `npm run smoke:mutation` when you change `test/smoke/` or the mock host, and `npm run smoke -- --mutation=focus|name|layout` when you touch the focus, accessible-name or layout assertions. Every mutation run must produce exactly one named expected failure and exit 0 when it appears; a clean pass means the assertion no longer catches the class of bug it exists to catch. The bare `--mutation` (`npm run smoke:mutation`) breaks the SSH send path, so its failure must also report the app's non-zero `ssh_send` drop count. The three category runs instead must report their own assertion's failure message plus `mutation activation: <category> applied`, and carry no `ssh_send` count. CI runs `npm run smoke` and all four mutation runs on every PR. The driver is not bundled: on Windows the suite needs `msedgedriver.exe` on `PATH`, at the version matching the installed WebView2 runtime (download `msedgedriver.microsoft.com/<version>/edgedriver_win64.zip`); a missing or mismatched driver fails every scenario with `can not find binary msedgedriver.exe in the PATH`. Inside scenarios, poll with `browser.execute(() => !!document.querySelector(".sel"))` — a `waitUntil` predicate built on `(await browser.$(".sel")).isExisting()` never turns false, so it times out on a dialog that has already closed.
- Visual reference screenshots are a review aid, not a gate: no pixel diff runs in CI and no snapshot exists per theme or scale permutation. `npm run smoke:visual` rewrites `test/smoke/visual-baseline/<platform>/`; `npm run smoke:visual -- --check` compares byte for byte at the recorded display scale. Re-capture only for the reasons listed in `docs/testing/visual-baseline.md`, and review the images by eye before committing them. The manual checks automation cannot establish — screen readers, native dialogs, platform keyboard differences, the other themes, Reading Comfort and enlarged text — are in `docs/testing/manual-matrix.md`, which also holds the pass log a reviewer fills in before publishing a draft release.
- On Windows, `npm run smoke` rewrites line endings in `src-tauri/Cargo.toml` and `src-tauri/gen/schemas/*.json` (LF to CRLF) with no content change, so `git status` lists them as modified while `git diff` shows nothing. Before committing, run `git diff -- <file>` on each listed file: revert it with `git checkout -- <file>` only when that prints nothing, and keep it when it shows real edits.
- To prove a debug-only path is absent from a release build, scan the shipping binaries (`src-tauri/target/release/comnd.exe`, `comnd_lib.dll`), not `libcomnd_lib.rlib`: the rlib's `lib.rmeta` records the *names* of cfg-stripped items (even a `#[cfg(any())]` one), so an rlib scan reports every debug-only identifier while holding none of its code.
- Make sure that agent results match the expected outcomes.
- Windows/PowerShell agents: cargo and npm print progress to stderr, which PowerShell renders as error records even on success — judge by exit code or final output lines, not error-record styling. Quote-sensitive `gh` filters (`--jq`, GraphQL queries) are safer written to a file and passed with `-F key=@file`; for anything past a trivial ASCII filter prefer dumping the JSON and parsing it, since non-ASCII or hyphenated comparisons inside the expression get mangled even in single quotes. PowerShell 5.1's `>` redirect writes UTF-16LE, so read that dump back with an encoding fallback rather than assuming UTF-8. Write commit messages with `[System.IO.File]::WriteAllLines` plus `UTF8Encoding($false)`; PowerShell 5.1's `Set-Content -Encoding utf8` prepends a BOM, which corrupts the subject and fails commitlint.

## Git Hygiene

### Before starting work
- Sync your branch with `origin` before you begin. Your working branch is usually `main` but may be a feature or release branch — whichever it is, fetch and confirm it already contains the latest commits from `origin`. Don't start work on a stale branch:
  - `git fetch origin`, then read `git status -sb` for ahead/behind of upstream.
  - If behind, merge or rebase your branch onto its upstream before making changes.

### Before opening a PR
- Re-run the Verification Requirements checks and confirm each exits 0: `npm run build`, `npm run test`, and `cargo check --all-targets`. "Task complete" is not the same as "ready to ship."
- Run commitlint locally on your new commits before pushing, so you don't wait on CI to catch a malformed message. This mirrors the `commitlint` job in `ci.yml`:
  - `npx commitlint --from origin/<target-branch>` (e.g. `origin/main`), or a specific range with `--from <base> --to <head>`.
  - It checks the Conventional Commit rules in the Commit Messages section using `commitlint.config.cjs`.

### When addressing review comments
- Bot reviewers can put findings in the review body instead of an inline thread. `reviewThreads` then reports every thread resolved while those findings are still open, so read the bodies as well: `gh api repos/bonzo81/comnd/pulls/<n>/reviews`, then each review's `body`.
- A body finding has no thread. Answer it with one top-level PR comment (`gh pr comment <n> --body-file <file>`). Reply inside a thread only for that thread's finding, and resolve the thread only once the fix is pushed.

## Commit Messages

Conventional Commits are enforced in CI on pull requests (the `commitlint` job in `ci.yml`). Format: `type(scope)!: subject`, then body, then footer.

- Subject: imperative mood, lowercase, no trailing period, 72 characters max
- Body: wrapped at 100 characters, explain what and why
- A body line that begins `word: ` (for example `code: …` or `app: …`) is parsed as a footer token and triggers the `footer-leading-blank` warning. Reword it so it does not start with a token and colon.
- Breaking change: `!` after the type, or a `BREAKING CHANGE: reason` footer
- One logical change per commit
- Allowed types: `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`, `test`; scope is optional and free-form

Version bump rules (release-please): `feat` → minor, `fix` → patch, breaking change → minor while pre-1.0.0 (major after). `docs`/`chore`/`refactor`/`test`/`perf` do not bump the version; they are grouped in the changelog "Miscellaneous" section.

## Release Flow

1. A conventional commit lands on main → release-please opens or updates a `chore(main): release X.Y.Z` PR that bumps `package.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, and `src-tauri/tauri.conf.json`, and updates `CHANGELOG.md`.
2. Merging the release PR creates the `vX.Y.Z` git tag and a draft GitHub release.
3. `release-please.yml` dispatches `release.yml` explicitly, which attaches per-platform installers to the draft. The tag does not trigger it by itself: a tag created with `GITHUB_TOKEN` fires no workflows.
4. A human smoke-tests the draft, then publishes it. Work through `docs/testing/manual-matrix.md` for the platform you are on and add a row to its pass log; the visual reference screenshots and their review steps are in `docs/testing/visual-baseline.md`.

Never bump versions or edit `CHANGELOG.md` by hand — write conventional commits and let the release PR do the rest.

### Release PR checks

The release PR runs the full `ci.yml` gate — `frontend`, `rust`, `smoke`, `smoke-netbox`, `commitlint` — like any other PR. What makes that happen is the token. A PR opened with `secrets.GITHUB_TOKEN` starts no workflow runs at all, so every check sat in `action_required`. `release-please.yml` therefore mints an installation token from the `comnd-release-please` GitHub App (`actions/create-github-app-token@v3`, narrowed to `contents: write` and `pull-requests: write`) and opens the PR with it. Tagging still runs under `GITHUB_TOKEN`, so the explicit `gh workflow run release.yml` dispatch stays the only build trigger.

`actions/create-github-app-token@v3` takes `client-id`; `app-id` still exists but is deprecated. actionlint 1.7.12 ships a stale bundled manifest and reports `client-id` as undefined and `app-id` as required — a false positive, disproved by run 42109716249. No workflow linter runs in this repo, so do not switch to the deprecated input to silence one.

Tagging runs before the PR step, for two reasons. release-please returns an empty list instead of opening a PR while a merged release PR is still untagged (`buildPullRequests` in `manifest.ts`), so the tag has to exist first or a fix landing in that window gets no release PR. Ordering it first also means a broken App secret cannot stop a merged release from being tagged.

If the checks do not start:

- Confirm the App is installed on `bonzo81/comnd` and that the `RELEASE_PLEASE_APP_CLIENT_ID` and `RELEASE_PLEASE_APP_PRIVATE_KEY` repository Actions secrets exist.
- Read the `release-please` run log. A bad private key or a revoked installation fails at the token-minting step, before any PR work.
- Close the release PR without merging, then re-run `gh workflow run release-please.yml`. release-please reopens it as the App and the PR events fire again.
- Approving the checks by hand in the PR's Checks tab is a stopgap, not a fix — repair the App token before the next release.

App creation, secret storage and rotation are in `CONTRIBUTING.md` § Releases.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues (`bonzo81/comnd`) via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

Reviewed: 2026-11-05