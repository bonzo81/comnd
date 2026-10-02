# Contributing to netssh

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
4. A maintainer smoke-tests the draft, then publishes it.

Just write conventional commits and let the release PR do the rest.
