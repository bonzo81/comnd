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

## 2026-10-30 (issue #67)

Source: issue #67, allowing concurrent sessions to the same host.

### Verification Requirements

Added:

> The driver is not bundled: on Windows the suite needs `msedgedriver.exe` on
> `PATH`, at the version matching the installed WebView2 runtime (download
> `msedgedriver.microsoft.com/<version>/edgedriver_win64.zip`); a missing or
> mismatched driver fails every scenario with `can not find binary
> msedgedriver.exe in the PATH`. Inside scenarios, poll with
> `browser.execute(() => !!document.querySelector(".sel"))` — a `waitUntil`
> predicate built on `(await browser.$(".sel")).isExisting()` never turns false,
> so it times out on a dialog that has already closed.

Why: the smoke suite could not run at all on Windows until the matching driver
was downloaded, and the new duplicate-session scenario then hung on its
`dialog is gone` wait because an `isExisting()` predicate cannot observe a
closed dialog — it reports the last successful lookup forever.

## 2026-11-02 (issue #89)

Source: issue #89, keyboard and accessibility assertions in the smoke suite.

### Verification Requirements

Changed:

> Add `npm run smoke:mutation` when you change `test/smoke/` or the mock host,
> and `npm run smoke -- --mutation=focus|name|layout` when you touch the focus,
> accessible-name or layout assertions. Every mutation run must produce exactly
> one named expected failure and exit 0 when it appears; a clean pass means the
> assertion no longer catches the class of bug it exists to catch. The bare
> `--mutation` (`npm run smoke:mutation`) breaks the SSH send path, so its
> failure must also report the app's non-zero `ssh_send` drop count. The three
> category runs instead must report their own assertion's failure message plus
> `mutation activation: <category> applied`, and carry no `ssh_send` count. CI
> runs `npm run smoke` and all four mutation runs on every PR.

Why: the file described one mutation run, so an agent touching the focus or
layout assertions had no reason to run the category that covers them, and the
`ssh_send` drop-count requirement read as applying to every mutation run.

Added:

> CI resolves Node from `lts/*` (four jobs in `ci.yml`); there is no `engines`
> field and no `.nvmrc`, so a new LTS can break `npm run test` on every OS with
> no code change. Node 26 defines `localStorage` and `sessionStorage` on
> `globalThis` but leaves them `undefined` unless the process starts with
> `--localstorage-file`, and Vitest's jsdom environment does not overwrite
> globals that already exist — `tests/harness.ts` therefore installs an
> in-memory `Storage` for both. Reproduce a CI-only frontend failure locally
> with `npm exec --yes --package=node@<version> -- node
> node_modules/vitest/vitest.mjs run`.

Why: `lts/*` moved to Node 26.13.0 and 43 tests across 7 files failed on all
three OSes with no code change. The cause took a reproduction under the exact
Node version to find, because the local Node 24 run passed.
