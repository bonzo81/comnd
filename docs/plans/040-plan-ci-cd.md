# Plan: CI/CD Pipeline — Current State + Future Work

Implements **P0.2a** of `plan-production-readiness-phase2a-no-signing.md`: test gate + unsigned builds. Code signing and the updater are deliberately deferred to `plan-production-readiness-phase2b-code-signing.md` — this doc does not duplicate them, it only says when they slot in.

## What exists now

### `.github/workflows/ci.yml` — quality gate

Runs on every PR, push to `main`, and manual dispatch. Two jobs, each a matrix over `ubuntu-22.04`, `windows-latest`, `macos-latest` (`fail-fast: false`, no `continue-on-error`), so each OS reports its own required check, e.g. `frontend (windows-latest)`:

- **frontend**: `npm ci` → `npm run build` (tsc + vite) → `npm run test` (vitest)
- **rust**: Linux only: WebKitGTK 4.1 system deps (Windows and macOS need no extra system packages) → `cargo fmt --all -- --check` (Linux leg only; formatting is OS-independent) → `cargo clippy --all-targets -- -D warnings` (every leg; `#[cfg]` arms differ per OS) → `cargo check` → `cargo test -- --nocapture`

This is exactly the local verification contract in `AGENTS.md`, so a green local run predicts a green CI run.

**Skipped vs passed keychain tests.** Four tests need a working OS keychain (`credentials.rs`: 2, `config.rs`: 2). They call `keychain_available_or_skip`, which does a real set/get/delete roundtrip on a unique probe entry. If it fails, the test prints `SKIP <test>: <reason>` and a `::warning title=Keychain test skipped::` annotation, then returns. Cargo still shows `ok` for a skipped test, so a pass with no SKIP line or annotation means the test was exercised. `--nocapture` makes the lines visible in CI logs. Tests use unique entries and delete only their own.

**Automated per OS:** typecheck/build, vitest, `cargo check`, `cargo test` (temp-dir fixtures, loopback mock servers, `#[cfg(windows)]` process tests on Windows, keychain tests wherever the keychain works).

**Still manual (release smoke):** installer install/launch, native window/WebView behaviour, real SSH to devices, updater. No native smoke suite exists in this repo, so there are no unsupported runner combinations to list.

No bundling, no signing — fast feedback only. PR runs cancel earlier runs on the same ref (`concurrency`), which matters while the repo is private (billed minutes).

### `.github/workflows/release.yml` — unsigned release builds

Runs on tag push (`v*`) or manual dispatch. Matrix with `fail-fast: false`:

| Runner | Target | Artifacts |
|---|---|---|
| macos-latest | aarch64-apple-darwin | .dmg + signed .app.tar.gz (updater check) |
| macos-latest | x86_64-apple-darwin | .dmg + signed .app.tar.gz (updater check) |
| ubuntu-22.04 | x86_64 | .AppImage + .deb + .rpm |
| windows-latest | x86_64 | NSIS .exe |

Bundle targets come from the platform-specific `tauri.<platform>.conf.json` files, which override the base `tauri.conf.json`. Linux ships three formats because only the AppImage can update itself (ADR-022); Windows and macOS ship one each. `.sig` signature files are not attached — `latest.json` embeds the signatures, and clients never fetch `.sig` files.

`tauri-action` runs `beforeBuildCommand` (`npm run build`) itself; the workflow only installs deps. Output: a **draft** GitHub Release (`releaseDraft: true`) — a human reviews assets before publishing. `contents: write` permission is set at job level; without it the release upload fails with "Resource not accessible by integration".

### Conventions

- The **tag is the version source of truth**: push `v0.1.0` → `tauri-action` reads the version from `src-tauri/tauri.conf.json` and names the release accordingly. Tag must match that version or you release a mislabeled build.
- Ubuntu runner pinned to `22.04` with `libwebkit2gtk-4.1-dev` (Tauri v2 needs WebKitGTK 4.1; image drift is the classic CI breaker).
- Caches: `setup-node` npm cache + `swatinem/rust-cache` scoped to `./src-tauri -> target`.

## Current caveats (accepted, by design)

Builds are **unsigned**. Consequences per platform:

- **Windows**: SmartScreen "Unknown publisher" warning on install. Installer works fine after "Run anyway".
- **macOS**: Gatekeeper blocks downloaded apps with an "app is damaged" message on Apple Silicon. Workaround for beta testers:
  ```
  xattr -d com.apple.quarantine /Applications/comnd.app
  ```
  (or System Settings → Privacy & Security → "Open Anyway"). Tauri ad-hoc signs the binary, which satisfies the linker but not Gatekeeper for downloaded apps.
- **Linux**: no signing concept — unaffected.

These warnings are the entire reason Phase 2B exists.

## Future work

Ordered by when each becomes actionable — not by importance.

### 1. Code signing + notarization — *blocked on certs, fully specified in 2B*

When a no-warning public release is required: `plan-production-readiness-phase2b-code-signing.md` P0.1 → P0.2b. The work here is adding CI secrets (`APPLE_CERTIFICATE`, `APPLE_ID`, `APPLE_TEAM_ID`, Windows cert) — the workflow needs no structural change, secrets slot into `tauri-action` env.

### 2. Auto-updater — *blocked on signing keys + public releases*

2B P1.4. Note the minisign key (`tauri signer generate`) is free and independent of OS certs, but the updater also needs a public releases endpoint — pointless while the repo is private. Do after the repo goes public.

### 3. Repo going public — *flip a switch, then revisit*

When the repo becomes public:

- CI/release minutes stop billing — the `concurrency` guard and lean CI matter less, but keep them anyway.
- Release assets become publicly downloadable — beta distribution without "logged in to GitHub" friction.
- **Add Linux ARM64 to the release matrix**: `ubuntu-22.04-arm` / `ubuntu-24.04-arm` runners are free-tier GA for public repos. While private, an uncached ARM build bills ~1 hour — hence deferred.
- Re-check whether unsigned beta distribution is still acceptable for a public audience; it probably accelerates the 2B signing track.

### 4. sccache — *when CI time hurts*

`rust-cache` stores the whole `target/` as a coarse blob; hit rates degrade as the dep tree grows. Layer sccache on top for fine-grained object caching. Only worth it once a cached `cargo check` measurably annoys.

### 5. Optional CI extensions — *as pain appears*

- Nightly build from `main` (P0.2a optional item; only if beta testers want fresh builds)
- MSRV check if a minimum supported Rust version is ever declared

None of these block anything today.

**Adopted: `cargo fmt --check` + `cargo clippy` (issue #187).** Both were listed here as "only when the codebase adopts the lint gate". The gate is now adopted: the `rust` job runs `cargo fmt --all -- --check` on the Linux leg (formatting is OS-independent) and `cargo clippy --all-targets -- -D warnings` on every leg (`#[cfg(windows)]` / `#[cfg(unix)]` arms differ per OS). The toolchain install is still a single `rustup show`, which installs the `rustfmt` and `clippy` components that `rust-toolchain.toml` now declares. The existing clippy diagnostics were fixed in the same PR rather than silenced, and `AGENTS.md` plus `.github/pull_request_template.md` carry both commands.

## Verification

- CI green on a test PR / push to `main`
- Push tag `v0.1.0` → draft release appears with all 7 platform artifacts
- After publishing the draft, installers install and run on Windows/Linux; macOS requires the `xattr` workaround above
