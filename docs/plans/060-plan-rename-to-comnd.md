# Plan: Rename the app and repository to Comnd

Adapted from the previous full-rename playbook (plan 019), based on the current
`origin/main` inventory. This document plans the rename only; implementation
must wait for approval.

## Decisions (fixed)

- Product name in user-facing prose and titles: **Comnd**. All package names,
  identifiers, binary names, keyring service names, localStorage keys, event
  names, file names, log prefixes, and environment variables use lowercase
  `comnd` (or uppercase `COMND` for environment-variable prefixes).
- Bundle identifier: `com.comnd.app`. The app data directory follows it, for
  example `%LOCALAPPDATA%\com.comnd.app` on Windows.
- Fresh start: add no migration from the old app data directory and do not add
  that directory to `migrate_data_dir()`. The historical source
  `dirs::data_dir()/netsh` in `src-tauri/src/paths/mod.rs` is a separate real
  legacy path and must remain byte-for-byte unchanged.
- The old app data directory and old keyring entries are abandoned. The user
  will re-enter hosts and credentials. Do not add credential/data migration.
- Rename GitHub repository `bonzo81/<former-name>` to `bonzo81/comnd` only after all
  commits have been pushed. Then set the origin URL and confirm with `gh`.
- Include `CHANGELOG.md` in the mechanical identity and repository-URL rename.
  Preserve its release entries, versions, tags, and commit hashes; do not
  manually bump a version. Release Please still owns version bumps.
- Regenerate generated artifacts (`Cargo.lock`, `package-lock.json`, and
  `src-tauri/gen/schemas/`) using the relevant package/build/check commands;
  do not edit them by hand.
- Preserve the app icons. The inspected icon samples are terminal-prompt
  symbols, not wordmarks; no replacement source image is required.

## Inventory and scope

The case-insensitive tracked-file search on current `origin/main` found rename
references in the following groups. The list below is the implementation
inventory; the changelog is included, while the historical `netsh` path remains
unchanged by design.

### Phase 1 — Rust identity and Tauri configuration

| File | Planned change |
|---|---|
| `src-tauri/Cargo.toml` | Rename the package and derived Rust library names to `comnd` and `comnd_lib`. |
| `src-tauri/src/main.rs` | Call `comnd_lib::run()`. |
| `src-tauri/tauri.conf.json` | Product name `Comnd`, identifier `com.comnd.app`, window title `Comnd`; change the explicit updater manifest URL to the new GitHub repository. |
| `src-tauri/capabilities/default.json` | Update the capability description to Comnd. |
| `src-tauri/src/paths/mod.rs` | Change `BUNDLE_ID`, app-data comments, import temp-directory prefixes, user-facing data-file errors, test temp-directory prefixes, and log filename references to the new identity. Preserve the `dirs::data_dir()/netsh` migration source exactly; do not add migration behavior for the previous bundle identifier. |
| `src-tauri/src/credentials.rs` | Change keyring service and key/test-fixture prefixes to `comnd`. |
| `src-tauri/src/config.rs` | Change keyring service, LLM/provider key names, temporary paths, test fixtures, and log-path fixtures. |
| `src-tauri/src/netbox.rs` | Change NetBox key names, comments, and test temp-directory prefixes. |
| `src-tauri/src/lib.rs` | Change crate logger filter, log prefixes, startup/error messages, default log filename, and related test paths/assertions. |
| `src-tauri/src/hosts.rs` | Change test temp-directory and fixture prefixes. |
| `src-tauri/src/import.rs` | Change test temp-directory prefixes. |
| `src-tauri/src/kb/store.rs`, `src-tauri/src/kb/test_util.rs`, `src-tauri/src/kb/user_files.rs` | Change test temp-directory prefixes. |
| `src-tauri/src/platform.rs`, `src-tauri/src/replay.rs` | Change test temp-directory prefixes. |
| `src-tauri/src/secrets/mod.rs` | Change docs, fixture strings, and the former uppercase test-environment prefix to `COMND_TEST_*`. |
| `src-tauri/src/session_log.rs`, `src-tauri/src/ssh.rs`, `src-tauri/src/transcript.rs` | Change test temp-directory/session prefixes. |
| `src-tauri/Cargo.lock` | Regenerate from Cargo after package/lib rename; never hand-edit. |
| `src-tauri/gen/schemas/*.json` | Regenerate Tauri generated schemas, including `capabilities.json`, after the capability description change; never hand-edit. |

The bundle, keyring, and persistent-identity changes form the breaking app
identity commit. Use a Conventional Commit with this exact footer:

```text
BREAKING CHANGE: app data directory and saved credentials move to comnd naming
```

### Phase 2 — Frontend identity

| File | Planned change |
|---|---|
| `index.html` | Set the document title to `Comnd`. |
| `src/main.ts` | Change title-bar text, app messages, and CustomEvent names. |
| `src/components/nav-panel.ts` | Rename the persisted navigation localStorage key. |
| `src/components/settings-screen.ts` | Rename event listeners, user-facing app references, default log filename, and backup filename. |
| `src/components/terminal-view.ts` | Rename the suggestion localStorage key and all CustomEvent listener/dispatch names. |
| `src/lib/auto-copy.ts`, `src/lib/output-highlight.ts`, `src/lib/reading-comfort.ts`, `src/lib/search-prefs.ts`, `src/lib/shortcuts.ts`, `src/lib/terminal-prefs.ts`, `src/lib/theme.ts`, `src/lib/timestamps.ts` | Rename persisted localStorage keys and CustomEvent names to the lowercase `comnd-*` / `comnd:*` forms. |
| `src/lib/logger.ts`, `src/lib/tauri-api.ts` | Rename log prefix and log-file references. |
| `src/lib/updater.ts` | Point the release page URL to `bonzo81/comnd`. |
| `src/lib/logger.test.ts`, `src/lib/reading-comfort.test.ts`, `src/lib/shortcuts.test.ts` | Update test fixtures and event assertions. |
| `src/styles/main.css` | Update the product-name comment. |
| `tests/log-status-toast.test.ts`, `tests/settings-log-file.test.ts` | Update log filename fixtures and assertions. |

### Phase 3 — npm, packaging, and updater metadata

| File | Planned change |
|---|---|
| `package.json` | Rename package to `comnd`. |
| `package-lock.json` | Regenerate with `npm install`; never hand-edit. |
| `release-please-config.json` | Update the Cargo.lock package-name JSONPath filter to select `comnd`; retain all version automation unchanged. |
| `src-tauri/tauri.conf.json`, `src/lib/updater.ts` | Update the explicit updater/release URLs as listed above. |
| Build artifacts | A Windows build produced `src-tauri/target/release/comnd.exe`, `Comnd_0.3.0_x64_en-US.msi`, and `Comnd_0.3.0_x64-setup.exe`. The installation guide uses the verified versioned filename patterns; do not guess names for other platforms. |

### Phase 4 — Documentation and historical references

Apply the casing rules consistently. User-facing prose and titles use
**Comnd**; identifiers, paths, keys, events, and filenames use lowercase
`comnd`. Correct stale app-data paths to the bundle-ID-based locations where
they describe current behavior. Update user-guide installation artifact names
only after verifying a real build.

Files with tracked matches, grouped by area:

- Root/project guidance: `.agents/skills/review-documentation/SKILL.md`,
  `.github/copilot-instructions.md`, `CONTEXT.md`, `CONTRIBUTING.md`,
  `README.md`, `agents.md`.
- Development and architecture: `docs/DEVELOPMENT.md`,
  `docs/adr/001-no-local-echo-shadow-buffer.md`,
  `docs/adr/007-per-platform-secret-prompt-patterns.md`.
- Specifications: `docs/specs/01-overview-goals.md`,
  `02-technical-architecture.md`, `03-ui-visual-design.md`,
  `04-connection-manager.md`, `08-future-open-questions.md`,
  `09-command-replay.md`, `11-shortcut-customization.md`,
  `12-dyslexia-mode.md`, and `accessibility.md`.
- Historical plans (mechanical content rename, preserving their historical
  meaning): `docs/plans/001-implementation-plan.md`,
  `006-plan-theme-switcher.md`, `009-plan-global-search.md`,
  `011-plan-logging-improvements.md`, `012-plan-local-storage-hardening.md`,
  `013-plan-custom-log-location.md`, `014-plan-terminal-output-highlighting.md`,
  `015-plan-production-readiness.md`, `016-plan-netbox-host-source.md`,
  `018-plan-user-guide-ste-refinement.md`,
  plan 019, `021-plan-kb-schema-deepening.md`,
  `022-plan-kb-index-source-and-save-validation.md`,
  `023-plan-production-readiness-phase2a-no-signing.md`,
  `025-plan-phase1-session-management.md`,
  `027-plan-suggestion-ghost-text-hardening.md`, `040-plan-ci-cd.md`,
  `052-plan-config-keychain-test-flake.md`, `053-plan-reading-comfort.md`,
  `055-plan-frontend-logger-sinks.md`, `056-plan-transcript-module.md`,
  `057-plan-release-please.md`, `058-plan-shortcut-customization.md`, and
  `059-plan-secret-safe-suggestion-logging.md`.
- Other plans: `docs/plans/credentials/02-implementation-plan.md`.
- User guide: `docs/user-guide/01-installation.md`,
  `02-getting-started.md`, `03-connecting-to-devices.md`,
  `04-terminal-and-suggestions.md`, `06-knowledge-base-overview.md`,
  `07-keyboard-shortcuts.md`, `09-security.md`, `10-troubleshooting.md`,
  `11-customizing-knowledge-base.md`. Fix obsolete storage/log/KB paths in
  addition to product prose. In `01-installation.md`, use verified artifact
  names from the real build.
- Repository URLs and clone instructions: README links, `agents.md` issue
  tracker link, the clone examples in `docs/DEVELOPMENT.md`, the updater URLs
  above, and the historical plan links. Use `https://github.com/bonzo81/comnd`.
- Changelog: `CHANGELOG.md` — mechanically update former product-name strings
  and repository URLs in existing release entries. Preserve the release
  history, versions, tags, and commit hashes exactly; do not regenerate or
  rewrite the changelog.

### Phase 5 — Verification and cleanup

- Re-run the inventory after edits and review every remaining match.
- Run `npm install` only for dependency metadata regeneration, then run
  `npm run build` and `npm run test` from the repository root.
- Run `cargo check --all-targets` and `cargo test` from `src-tauri/`.
- Run a real Tauri build to verify the packaged artifact names, then correct
  `docs/user-guide/01-installation.md` and re-check the documentation.
- The Windows Tauri build produced the executable, MSI, and NSIS installer,
  then exited nonzero because the configured updater public key has no private
  signing key in this environment. Do not read or add private signing keys.
- Inspect `git diff` to verify that changelog changes are limited to the
  mechanical rename, versions are unchanged, the historical `netsh` migration
  source is unchanged, and generated files were not hand-edited.
- Confirm the case-insensitive repository sweep returns zero hits.
- Capture and report the tail of each required verification output and clearly
  mark any command not run.

Recorded results:

- `npm run build` — passed.
- `npm run test` — passed (28 files, 374 tests).
- `cargo check --all-targets` — passed with the existing `clear_host_source`
  dead-code warning.
- `cargo test` — passed (233 tests; no failures).
- `npm run tauri build` produced `comnd.exe`,
  `Comnd_0.3.0_x64_en-US.msi`, and `Comnd_0.3.0_x64-setup.exe`, then exited
  nonzero because no updater signing private key is available. No signing key
  was read or added.
- `cargo clean` removed build outputs after verification to restore disk space.

### Phase 6 — Push and rename the GitHub repository (final operational step)

1. Ensure all phase commits are pushed and the final branch is ready.
2. As the final repository operation, run `gh repo rename comnd --yes`.
3. Run `git remote set-url origin https://github.com/bonzo81/comnd.git`.
4. Confirm `gh repo view` reports `bonzo81/comnd`.

## Commit sequence

Use one Conventional Commit per logical phase: app identity (with the required
breaking-change footer), frontend identity, npm/packaging metadata, docs, and
verification/cleanup if it produces a separate change. Do not bundle the
GitHub rename into a commit; it is an operational step after all pushes.

Before committing, inspect the existing open release-please PR and coordinate
the package rename with that pending release branch so it cannot reintroduce
the old Cargo package filter or overwrite regenerated metadata.

## Manual smoke checklist for the user

- Run the app and confirm the title says **Comnd**.
- Re-enter a host credential and confirm a connection works.
- The previous app-data directory is abandoned by design; delete it or keep it
  as a backup at your discretion.

## Execution order

After approval: Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 → push all
commits → Phase 6. Do not begin code changes before approval.
