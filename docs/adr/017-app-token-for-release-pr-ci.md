# 017. Release PRs are opened with a GitHub App token so CI runs, and tagging stays on `GITHUB_TOKEN`

Date: 2026-11-05
Status: Accepted

## Context
Issue #101: every release PR showed its five CI jobs as `action_required`. `release-please.yml`
opened the PR with `secrets.GITHUB_TOKEN`, and GitHub starts no workflow runs for events caused
by that token, so a release PR could never run `ci.yml` on its own.

That mattered because `main` has no branch protection (`protected: false`, no rulesets) and has
received direct commits — three of the last thirty first-parent commits (`df799d6`, `8bd5b7b`,
`b16cf6d`) are not from a pull request. The release PR is therefore the last whole-tree check
before a tag. Re-running five jobs on a version-only PR is redundant for source behaviour; it is
the tag gate that justifies the cost. The repo is public, so Actions minutes are not the
constraint — wall-clock is. The `smoke` job took 41 minutes in PR #104.

Issue #101 named three options and left the choice open. Its constraint was that whatever token
is used be narrowed to `contents: write` and `pull-requests: write` and nothing more.

## Options
- **GitHub App installation token** (`actions/create-github-app-token@v3`, `client-id` and
  `private-key`). Cost: a one-time App registration, two repository secrets, and key rotation
  owned by a maintainer. Benefit: the installation token is not tied to a person and expires on
  its own.
- **Fine-grained PAT in a secret.** Cost: tied to the account that minted it, so a maintainer
  change is a rotation event; its permission set is fixed by whoever created it and cannot be
  narrowed by the workflow, so the two-permission scope is unenforceable from `ci.yml`; and it is
  long-lived.
- **Manual approval of each release PR's checks.** Cost: every release needs a human click before
  verification starts, so a forgotten click merges unverified — the original failure returns as
  an attention lapse instead of a config bug. No token to manage.

The App was chosen because its installation token is not tied to a person (no rotation when a
maintainer changes) and expires by itself.

## Decision
`release-please.yml` mints an installation token from the `comnd-release-please` App and opens the
release PR with it, so the PR events are App-authored and `ci.yml` starts. The workflow narrows
the token with `permission-contents: write` and `permission-pull-requests: write`. The App itself
is registered with `contents: write` and `pull_requests: write` only, plus `metadata: read`, which
GitHub requires of every App; it has no webhook.

The release-please run is split into two steps:

| Step | Token | Skips | Purpose |
|---|---|---|---|
| `release` | `GITHUB_TOKEN` | `skip-github-pull-request: true` | tags and drafts the release |
| `release-pr` | App installation token | `skip-github-release: true` | opens or updates the PR, never tags |

Three constraints on ordering and conditions, each with its reason:

1. **`release` runs first.** `createPullRequests()` calls `buildPullRequests()`, then iterates
   `findMergedReleasePullRequests()`; on the first hit it logs `There are untagged, merged release
   PRs outstanding - aborting` and returns `[]` (release-please `manifest.ts`, around line 933).
   It returns an empty list rather than throwing, so the step reports success while creating
   nothing. Tagging first clears that state before the PR step reads it, and it means a broken App
   secret cannot stop a merged release from being tagged.
2. **Tagging stays on `GITHUB_TOKEN`.** A tag created by the App fires `release.yml`'s `on: create`
   trigger, which alongside the existing explicit dispatch would queue a second identical build in
   concurrency group `release-${{ inputs.release_tag || github.event.ref }}` with
   `cancel-in-progress: false` — a duplicate that would likely fail on already-uploaded assets.
   GitHub suppresses workflow runs for events caused by `GITHUB_TOKEN`, so the dispatch remains the
   only path into `release.yml`.
3. **The dispatch is gated on `!cancelled() && steps.release.outputs.release_created == 'true'`,
   not the implicit `success()`.** A failed token-mint or PR step must not leave a tagged draft
   with no installers attached.

`release.yml`, its build matrix, the version-bump rules, the release PR contents and the absence of
auto-merge are all unchanged.

## Consequences
- Easier: a release PR runs the same five jobs as any other PR with no human click; a broken App
  secret no longer blocks tagging or the build; the installation token is revoked by the action's
  post step when the job ends.
- Harder: a maintainer owns key rotation (`@bonzo81`), and a bad private key or revoked installation
  fails at the token-minting step, so the run log is the first place to look. Release PRs opened
  before the App existed cannot be rescued — a PR keeps its author, and release-please pushing no
  new commit means no `synchronize` event, so such a PR has to be closed and recreated.
- Rules out: opening release PRs with `secrets.GITHUB_TOKEN`; letting the App create the tag;
  auto-merging release PRs; granting the App or the token anything beyond `contents: write` and
  `pull-requests: write`.
- Unproven as of this date: automatic CI startup on a real App-authored release PR, and post-merge
  draft creation with exactly one dispatch. Run 42112104558 proves the token mints, both steps
  authenticate, the dispatch stays gated and the token is revoked — nothing beyond that. Evidence
  for the rest arrives with the first release after merge.
- Revisit when: a release PR shows `action_required` again — check the App installation and both
  secrets before touching the workflow; or if release-please changes its untagged-merged-PR guard,
  which would make constraint 1 removable.
