## Summary

<!-- What changes, and why. One or two sentences. -->

Closes #

## Verification

<!-- Tick what you ran. CI re-runs every gate; this is so reviewers can see it up front. -->

- [ ] `npm run build`
- [ ] `npm run test`
- [ ] `cargo check --all-targets` (in `src-tauri/`)
- [ ] `cargo test` (in `src-tauri/`)
- [ ] `npm run smoke` — required when touching the keystroke path, the suggestion
      controller, the terminal view, or `test/smoke/`
- [ ] `npm run smoke:mutation` — required when `test/smoke/` or the mock host changed
- [ ] `npx commitlint --from origin/main` — Conventional Commits, 72-char subject

## Notes for reviewers

<!-- Screenshots for UI changes, the manual-matrix row for user-visible behaviour,
     anything deliberately out of scope. -->

- [ ] No hand-edited version numbers or `CHANGELOG.md` — release-please owns both
