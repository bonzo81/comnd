# Guidance patches

Dated record of rules added to `AGENTS.md` after an agent session showed the
file was missing something it should have covered. Each entry names the lines
added and the failure that motivated them.

## 2026-10-30

Source: issue #61, strengthening the smoke suite's mutation check.

### Verification Requirements

Added:

> On Windows, `npm run smoke` rewrites line endings in `src-tauri/Cargo.toml`
> and `src-tauri/gen/schemas/*.json` (LF to CRLF) with no content change, so
> `git status` lists them as modified while `git diff` shows nothing. Before
> committing, run `git diff -- <file>` on each listed file: revert it with
> `git checkout -- <file>` only when that prints nothing, and keep it when it
> shows real edits.

Why: every smoke run left those three files listed as modified with an empty
diff, which made the working tree look dirty before each commit and risked
committing line-ending churn.

### Commit Messages

Added:

> A body line that begins `word: ` (for example `code: …` or `app: …`) is
> parsed as a footer token and triggers the `footer-leading-blank` warning.
> Reword it so it does not start with a token and colon.

Why: a commit body line beginning `app: ` tripped the rule twice, and the
warning names a blank-line problem rather than the real cause, so the fix took
several attempts.
