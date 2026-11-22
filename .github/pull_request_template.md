## Summary

<!-- What changes, and why. One or two sentences. -->

Closes #

## Verification

<!-- Tick what you ran. CI re-runs every gate; this is so reviewers can see it up front. -->

- [ ] `npm run build`
- [ ] `npm run test`
- [ ] `npm run lint:css` — CSS token standard (ADR 018); required when touching stylesheets
      or a `var(--token)` read
- [ ] `npm run lint:eol` — `.editorconfig` rules on committed content; run `git add` first,
      the check reads the index rather than the working tree
- [ ] `cargo check --all-targets` (in `src-tauri/`)
- [ ] `cargo fmt --all -- --check` (in `src-tauri/`) — CI runs it on one leg, formatting is
      OS-independent
- [ ] `cargo clippy --all-targets -- -D warnings` (in `src-tauri/`) — CI runs it on every
      leg; fix diagnostics rather than adding `#[allow]`
- [ ] `cargo test` (in `src-tauri/`)
- [ ] `cargo test --release --lib` (in `src-tauri/`) — required when adding or changing a
      test around debug-only (`debug_assertions`) code
- [ ] `npm run smoke` — required when touching the keystroke path, the suggestion
      controller, the terminal view, or `test/smoke/`
- [ ] `npm run smoke:mutation:all` — required when `test/smoke/` or the mock host changed;
      one process proves all seven mutation categories
- [ ] `npm run smoke -- --mutation=focus|name|layout|suggestion|kb-layout|terminal-sidebar-layout`
      — a single-category re-check while iterating on one assertion
- [ ] `npx commitlint --from origin/main` — Conventional Commits, 72-char subject

## Notes for reviewers

<!-- Screenshots for UI changes, the manual-matrix row for user-visible behaviour,
     anything deliberately out of scope. -->

- [ ] No hand-edited version numbers or `CHANGELOG.md` — release-please owns both
