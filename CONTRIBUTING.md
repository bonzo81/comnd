# Contributing to Comnd

## Commit Messages

All commits follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/). The format is `type(scope)!: subject`, optionally followed by a body and a footer.

- Subject: imperative mood, lowercase, no trailing period, 72 characters max
- Body (optional): wrapped at 100 characters, explain what you changed and why
- Breaking change: add `!` after the type (e.g. `feat(kb)!: ...`) or a `BREAKING CHANGE: reason` footer
- One logical change per commit

Allowed types: `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`, `test`. The scope is optional — use it for the area you touched (`kb`, `ssh`, `ui`, ...). CI checks commit messages on pull requests, so a non-conventional subject will fail the build.

## Knowledge Base Contributions

The easiest way to contribute is adding commands to the knowledge base.

### Adding a command

1. Find the right file in `knowledge-base/<platform>/commands/<category>.yaml`
2. Add your command entry following the schema:

```yaml
  - name: show ip ospf neighbor
    syntax: "show ip ospf [<process-id>] neighbor [detail]"
    description: |
      Displays OSPF neighbor adjacency information.
      Shows neighbor state, priority, dead time, and interface.
    category: routing
    mode: privileged-exec
    aliases:
      - sh ip ospf nei
    examples:
      - command: show ip ospf neighbor
        description: All OSPF neighbors
      - command: show ip ospf neighbor detail
        description: Detailed neighbor information
    versions:
      introduced: "12.0"
      deprecated: null
      notes: null
    tags:
      - ospf
      - routing
      - troubleshooting
```

### Rules
- Every command needs: name, syntax, description, category, mode, at least one example
- Aliases should include common abbreviations engineers actually use
- Descriptions should be practical — what the command does and when you'd use it
- Version `introduced` should be the earliest major version where the command exists
- Tags help with search — include the protocol, category, and use case

## Releases

Releases are automated by [release-please](https://github.com/googleapis/release-please) — you don't need to bump versions or edit the changelog yourself:

1. When a `feat` or `fix` commit lands on main, release-please opens (or updates) a PR titled `chore(main): release X.Y.Z` that bumps the version in `package.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, and `src-tauri/tauri.conf.json`, and updates `CHANGELOG.md`.
2. Merging that PR creates the `vX.Y.Z` git tag and a draft GitHub release.
3. The tag fires the binary build workflow, which attaches per-platform installers to the draft.
4. A maintainer smoke-tests the draft, then publishes it. Before publishing, work through the rows in [`docs/testing/manual-matrix.md`](docs/testing/manual-matrix.md) for your platform and add a row to its pass log; review any changed reference screenshot using [`docs/testing/visual-baseline.md`](docs/testing/visual-baseline.md).

Just write conventional commits and let the release PR do the rest.

### Release PR checks

The release PR runs the same `ci.yml` jobs as any other PR — `frontend`, `rust`, `smoke`, `smoke-netbox` and `commitlint`. That only happens because the PR is opened with a GitHub App token. A PR created with `secrets.GITHUB_TOKEN` starts no workflows, which is why release PRs before the App existed showed every check as `action_required`.

**One-time setup (repository admin).** These steps need admin rights on `bonzo81/comnd` and are not automated:

1. Create a GitHub App named `comnd-release-please` (Settings → Developer settings → GitHub Apps → New GitHub App). Turn the webhook off — nothing receives events.
2. Under **Repository permissions** grant exactly two: **Contents: Read and write** and **Pull requests: Read and write**. Leave everything else at **No access**; the workflow narrows the installation token to these two with `permission-contents` and `permission-pull-requests`.
3. Install the App on `bonzo81/comnd` only.
4. Note the App's **Client ID** from its About page, then generate a private key and download the `.pem`.
5. Store both as repository Actions secrets: `RELEASE_PLEASE_APP_CLIENT_ID` (the Client ID) and `RELEASE_PLEASE_APP_PRIVATE_KEY` (the whole `.pem`, `BEGIN`/`END` lines included). Delete the downloaded file afterwards.

**Rotation.** Owner: `@bonzo81`. The key has no expiry, so rotate it on maintainer change, on suspected exposure, or yearly:

1. Generate a new private key on the App, leaving the old one active.
2. Replace `RELEASE_PLEASE_APP_PRIVATE_KEY` with the new `.pem`.
3. Run `gh workflow run release-please.yml` and confirm the token-minting step succeeds.
4. Delete the old key from the App.

Never print a secret: no `echo`, no `--debug`, no `run:` that dumps the token. The installation token is short-lived and revoked when the job ends.

**If the release PR's checks do not start.** Confirm the App is installed on this repo and both secrets exist, then read the `release-please` run log — a bad key or revoked installation fails at the token step. Otherwise close the release PR without merging and re-run `gh workflow run release-please.yml`; release-please reopens it as the App and the PR events fire again. Approving checks manually in the Checks tab is a stopgap, not a fix.

**Proving it on an existing release PR.** PRs opened before the App existed (for example #64) will not pick up CI until they are recreated:

1. Merge the workflow change, then run `gh workflow run release-please.yml`.
2. Run `gh pr checks 64`. Working means `frontend`, `rust`, `smoke`, `smoke-netbox` and `commitlint` are listed and queued or running — not `action_required`.
3. If #64 gains no new commit, its PR events never re-fire: close it without merging and re-run the workflow so release-please recreates it as the App.
