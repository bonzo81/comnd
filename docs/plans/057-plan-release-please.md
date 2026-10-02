# Plan: release-please + Conventional Commits

Status: agreed 2026-10-02, corrected same day after a spec review against the release-please docs, its config schema and source, and the GitHub Actions events reference. Not yet implemented.

Implements the automation half of `040-plan-ci-cd.md`: version bumps, `CHANGELOG.md`, tagging, and release creation. Binary builds stay in `release.yml`. References: [release-please](https://github.com/googleapis/release-please), [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/).

## Current state

- Commit history already follows Conventional Commits: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `perf`, with scopes (`kb`, `ssh`, `ui`, ...). No re-training needed.
- `ci.yml` gates quality; `release.yml` builds the 4-target matrix on `v*` tag push and creates a **draft** release a human publishes.
- Version is duplicated in three files, all `0.1.0`: `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`.
- No tags exist. `v0.1.0` has never been released.

## Design constraints (found during review — do not regress these)

1. **Path scoping.** A manifest package key other than `.` scopes commit collection to files under that path. A `src-tauri` package would never release frontend-only commits (`feat(ui): ...` touching only `src/`). Most of this app's features are frontend-only, so the package key must be `.`.
2. **Rust strategy needs Cargo.toml at the package path.** The `rust` release-type reads `Cargo.toml`/`Cargo.lock` relative to the package path. At `.` it expects them at the repo root — they are in `src-tauri`. Also, the strategy name is `rust`, not `cargo` (`cargo-workspace` is a plugin name).
3. **Draft releases fire no `release` events.** GitHub: "Workflows are not triggered for the `created`, `edited`, or `deleted` activity types for draft releases." A `release: [created]` trigger never fires for a draft.
4. **Draft releases get no git tag until published.** release-please therefore requires `force-tag-creation: true` when `draft: true`, or it loses track of the previous release and regenerates full-history changelogs.

Consequence: single package at `.`, `release-type: node` (repo root has `package.json`; node bumps `package.json` + `package-lock.json` natively), and the Rust/Tauri files bumped via documented `extra-files` updaters.

## Decisions (agreed 2026-10-02)

1. **Pre-1.0.0 breaking changes bump minor** (`bump-minor-pre-major: true`). A `BREAKING CHANGE` commit on `0.1.x` produces `0.2.0`, never a surprise `1.0.0`. Post-1.0.0, breaking bumps major as usual.
2. **Bootstrap by tagging `v0.1.0` now** as a baseline release. The first release-please release is then a clean `v0.2.0` instead of a sweep of the entire git history.
3. **Keep the human publish gate.** release-please creates a draft release + tag; `release.yml` attaches binaries; a human smoke-tests and publishes. Same gate the current workflow already has.
4. **Commitlint in CI on pull requests only.** No husky/local hooks.

Version bump rules after this change: `feat` → minor, `fix` → patch, `BREAKING CHANGE` (footer or `!`) → minor while pre-1.0.0, major after. `docs`/`chore`/`refactor`/`test`/`perf` → no bump, grouped in the changelog "Miscellaneous" section.

## Implementation steps

### Step 1: Baseline release `v0.1.0` (before enabling release-please)

```bash
git tag v0.1.0
git push origin v0.1.0
```

The existing `release.yml` triggers on the tag, builds the matrix, and creates a draft `v0.1.0` release. Smoke-test, then publish.

Do this **before** merging the release-please workflow. Otherwise the first release-please run treats the entire commit history as unreleased and produces `v0.2.0` with a full-history changelog.

### Step 2: release-please configuration

Two files at the repo root, both committed.

`release-please-config.json`:

```json
{
  "$schema": "https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json",
  "packages": {
    ".": {
      "release-type": "node",
      "include-component-in-tag": false,
      "bump-minor-pre-major": true,
      "draft": true,
      "force-tag-creation": true,
      "extra-files": [
        { "type": "toml", "path": "src-tauri/Cargo.toml", "jsonpath": "$.package.version" },
        { "type": "toml", "path": "src-tauri/Cargo.lock", "jsonpath": "$.package[?(@.name=='netssh')].version" },
        { "type": "json", "path": "src-tauri/tauri.conf.json", "jsonpath": "$.version" }
      ]
    }
  }
}
```

`.release-please-manifest.json`:

```json
{
  ".": "0.1.0"
}
```

Rationale:

- `release-type: node` at `.` avoids both path-scoping problems: it releases on commits anywhere in the repo and bumps `package.json` + `package-lock.json` at the root natively.
- The `extra-files` updaters keep the Rust and Tauri versions in sync in the same release PR. The `toml` updater with `$.package.version` is the documented pattern for `Cargo.toml`. For `Cargo.lock`, release-please uses jsonpath-plus, which supports the filter expression — it bumps only the `netssh` entry, not dependency entries. If the filter ever fails to match, the updater logs a warning and leaves the file unchanged (soft failure), and cargo rewrites the lock itself on the next build, so the worst case is cosmetic drift.
- One package means one tag (`vX.Y.Z`) and one release. `include-component-in-tag: false` pins the tag format.
- `draft: true` + `force-tag-creation: true` implement the human publish gate without losing the git tag (see design constraints 3 and 4).
- This removes the tag/config mismatch risk called out in `040-plan-ci-cd.md`: the tag, `tauri.conf.json`, `Cargo.toml`, `Cargo.lock`, and `package.json` all move together in one PR.

### Step 3: New workflow `.github/workflows/release-please.yml`

```yaml
name: release-please

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write

jobs:
  release-please:
    runs-on: ubuntu-latest
    steps:
      - uses: googleapis/release-please-action@v4
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          config-file: release-please-config.json
          manifest-file: .release-please-manifest.json
```

Behavior: when conventional commits land on main, release-please opens (or updates) a release PR titled `chore(main): release X.Y.Z` that bumps the version files and updates `CHANGELOG.md`. Merging that PR creates the `vX.Y.Z` git tag (forced, despite the draft) and a **draft** GitHub release. Pushes containing only `chore`/`docs`-type commits produce no release PR.

### Step 4: Rework `.github/workflows/release.yml`

```yaml
name: Release

on:
  create:
  workflow_dispatch:

jobs:
  build:
    if: startsWith(github.ref, 'refs/tags/v')
    # ... matrix and steps unchanged ...
    - uses: tauri-apps/tauri-action@v1
      env:
        GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      with:
        tagName: v__VERSION__
        args: ${{ matrix.args }}
```

Changes:

- Trigger becomes `create` (+ keep `workflow_dispatch`), **not** `push: tags` and not `release`. The `create` event fires when a tag ref comes into existence — whether pushed by git (the bootstrap in Step 1) or created by release-please's forced tag via the API. Keeping `push: tags` as well would double-fire on manual tag pushes.
- The job-level `if` filters out branch creations (the `create` event also fires for branches).
- `tauri-action` inputs reduce to `tagName: v__VERSION__`: release-please already created the draft release with changelog notes, and `tauri-action` attaches artifacts to the existing release by tag. Drop `releaseName`, `releaseBody`, `releaseDraft` so nothing clobbers the release-please release.

One link stays unverified until first rollout: `tauri-action` attaching to an existing **draft** release (its by-tag lookup should find drafts; the token has `contents: write`). Fallback if it does not: run the workflow via `workflow_dispatch` before publishing, so binaries land before the release goes live.

### Step 5: Commitlint in CI

- Add devDependencies: `@commitlint/cli`, `@commitlint/config-conventional`.
- Add `commitlint.config.json` at the repo root:

  ```json
  {
    "extends": ["@commitlint/config-conventional"]
  }
  ```

  Allowed types (`build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`, `test`) match the existing history. Scope is optional and free-form.

- New job in `ci.yml` (pull_request only). Fetch the base branch by ref rather than using `base.sha` — the SHA can vanish from history after a rebase or base-branch force-push, which would fail the job with a bad-object error:

  ```yaml
  commitlint:
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v6
        with:
          node-version: lts/*
          cache: npm
      - run: npm ci
      - run: git fetch origin ${{ github.event.pull_request.base.ref }}
      - run: npx commitlint --from origin/${{ github.event.pull_request.base.ref }} --to ${{ github.event.pull_request.head.sha }}
  ```

- Recommended repo setting: squash-merge PRs so the PR title becomes the single commit subject; the commitlint job plus a conventional PR title then covers the merged commit. Merge commits also work (release-please ignores non-conventional subjects), they are just noisier.

### Step 6: Documentation

- `AGENTS.md`: add a commit message format section (agents author most commits in this repo) and a short release flow summary.
- `CONTRIBUTING.md`: same rules for humans.

Commit message rules to document:

- Format: `type(scope)!: subject`, then body, then footer.
- Subject: imperative mood, lowercase, no trailing period, 72 characters max.
- Body: wrapped at 100 characters, explain what and why.
- Breaking change: `!` after the type, or a `BREAKING CHANGE: reason` footer.
- One logical change per commit.

## Full release flow (after rollout)

1. Conventional commit lands on main.
2. release-please opens or updates the `chore(main): release X.Y.Z` PR (version bumps + changelog).
3. Human merges the release PR → `vX.Y.Z` tag (forced) + draft GitHub release created.
4. The tag creation fires `release.yml`, which attaches per-platform installers to the draft.
5. Human smoke-tests the draft, then publishes.

## Rollout order

1. Tag and publish `v0.1.0` (Step 1).
2. One PR containing: `release-please-config.json`, `.release-please-manifest.json`, `.github/workflows/release-please.yml`, reworked `release.yml`, commitlint config + CI job, devDependencies, doc updates (Steps 2–6).
3. Next `feat` commit on main → release-please opens the `chore(main): release 0.2.0` PR → verify its contents (all four version files bumped, `Cargo.lock` netssh entry bumped, changelog correct) → merge → draft release + tag → binaries attach → publish.

## Caveats

- release-please release PRs carry `[skip ci]`, so CI skips those merge commits. This is intended; `cargo check` / builds still gate via feature PRs and the binary workflow.
- The commitlint job lints PR commits only. Direct pushes to main rely on discipline.
- `bump-minor-pre-major` only changes behavior while the version is below `1.0.0`.
- `tauri-action` attaching to a **draft** release is the one unverified link in the chain; check it at first rollout and fall back to a manual `workflow_dispatch` run before publishing if it fails.
- The `Cargo.lock` jsonpath filter bumps only the `netssh` package entry; if it fails to match it degrades softly (warning + unchanged file), and cargo self-heals the lock on the next build.

## Verification

- Frontend changes: `npm run build` exits 0.
- Workflow YAML: validate syntax (actionlint if available, otherwise push and watch the run).
- After rollout, the next `feat` commit should produce a release PR with all four version files bumped and a matching `CHANGELOG.md` entry.
- At the first release-please release, confirm on GitHub that the tag exists, the release is a draft, and the binary workflow attached installers to that draft before publishing.
