# 014. Coverage comes from v8 and cargo-llvm-cov, ships as Actions artifacts, and is not a gate

Date: 2026-10-31
Status: Accepted

## Context
Issue #56 asked for reproducible frontend and Rust coverage reports and for the confirmed
high-risk gaps to be protected by tests. Its own boundary note is the constraint this ADR
records: coverage is evidence of execution, not correctness. `AGENTS.md` already requires
`npm run build` and `npm run test` on every frontend change and `cargo check --all-targets`
plus `cargo test` on every Rust change, so a reporting command had to sit beside those gates
rather than replace them.

Tooling inventory before this change: no `@vitest/coverage-v8` in `package.json`, no
`llvm-tools-preview` component, and neither `cargo-llvm-cov` nor `cargo-tarpaulin` installed
(rustc 1.93.1, node v24.14.0). `vitest.config.ts` had no `coverage` block at all. Vitest 4
removed `coverage.all`, so without an explicit `include` a file with no test is absent from
the report instead of showing 0% - a silent undercount.

`.github/workflows/ci.yml` runs the frontend and rust jobs as three-OS matrices and already
installs a Rust CLI tool with `actions/cache` plus `cargo install --version ... --locked` for
`tauri-driver`. There is no third-party coverage action in this repo.

Baselines were measured before a test was written, so the gap list came from data rather than
assumption: frontend 430 tests across 32 files at 44.63% lines; Rust 245 tests at 69.08% lines.
After the tests added under #56: frontend 539 tests across 36 files at 48.59% lines; Rust 255
lib tests plus 3 integration tests at 71.05% lines. The per-file numbers, the gap list and the
test-to-gap mapping live in `docs/plans/065-plan-test-coverage.md`; this ADR records the
choices and their limits, not the measurements.

## Options
- **Vitest v8 provider.** Cost: reports against the transformed module and source-maps back to
  TypeScript, so a few constructs attribute oddly, and it adds a devDependency.
- **Istanbul provider.** Cost: closer TypeScript-level mapping but instrumented execution is
  slower, and its output is not the shape most tooling expects; still a devDependency.
- **`cargo-llvm-cov` on stable with `llvm-tools-preview`.** Cost: a `rustup component` on each
  runner plus a ~5 minute `cargo install` that has to be cached; branch coverage stays
  unavailable on stable.
- **`cargo-tarpaulin`.** Cost: ptrace-based, Linux-only in practice, and line coverage only -
  no region data at all.
- **Nightly toolchain for Rust branch coverage.** Cost: a nightly toolchain in every job, and
  the measured binary is then not the one that ships.
- **Upload to Codecov or Coveralls.** Cost: a third-party service, a token secret, and the
  repo's coverage data leaving GitHub - which #56 rules out.
- **Add a percentage gate now.** Cost: blocks pull requests on a number that measures
  execution, not correctness; a global floor at 48% frontend lines would either be
  meaningless or freeze the current shape.

## Decision
Coverage is a report, never a gate, and it never leaves GitHub.

Frontend: `@vitest/coverage-v8` as a devDependency, configured in `vitest.config.ts` with
`include: ["src/**/*.ts"]` - required by Vitest 4 or untested files vanish - excluding
`src/**/*.test.ts`, `src/**/*.d.ts` and `src/main.ts`. Reporters are `text`, `html`, `lcov`
and `json-summary` into `./coverage`, which `.gitignore` keeps out of the tree.
`npm run test:coverage` is the reproducible command and runs the whole suite.

Rust: `cargo-llvm-cov` pinned to 0.9.1 with `--version 0.9.1 --locked` and cached by
`actions/cache` keyed on version, OS and arch, following the existing `tauri-driver` pattern
rather than adding a third-party action. One instrumented run, then `cargo llvm-cov report`
for the table, `report --html` and `report --lcov` for the artifacts, because the tool accepts
one output format per invocation. `llvm-tools-preview` is installed with `rustup component
add` rather than by switching toolchains.

Both jobs measure on `ubuntu-22.04` only, so the reports are a Linux baseline rather than a
cross-platform one: `#[cfg(unix)]` / `#[cfg(windows)]` change which lines exist and which run, so
the macOS and Windows paths are unmeasured. Running three copies of a report that differs per OS
would also triple runner time for no comparable number. Both upload on `pull_request` only, via
`actions/upload-artifact@v7` with 7-day retention - `coverage-frontend` from `coverage/`, and
`coverage-rust` from `target/coverage-html/` plus `target/coverage.lcov`.

No gate is added in this change. A targeted gate is intended once the baseline has settled
over a few pull requests; a gate spanning the whole tree is not the shape under consideration.

## Consequences
- Easier: a reviewer can download the HTML report from any pull request and see which lines a
  change left unexecuted; the gap list in plan 065 has `file:line` evidence behind it; no
  token, no service, no dashboard to keep alive; the frontend and Rust commands are plain npm
  and cargo commands that run identically on a developer machine.
- Harder: no trend line and no inline PR annotation, so a regression is noticed only by opening
  the artifact; the `cargo install` costs about five minutes whenever the cache key changes;
  a report is three files (table, HTML, lcov) that have to be read together.
- Rules out: an external coverage service; a nightly toolchain added solely for branch
  numbers; a global percentage gate; committing `coverage/` or `target/coverage-*`.
- Not measured - Rust branch coverage. `cargo llvm-cov --branch` needs nightly
  (`-Z coverage-options=branch`), and a nightly-measured binary does not describe the stable
  binary that ships, so the number is omitted rather than approximated. Rust reports lines,
  functions and regions only.
- Not measured - the shipping app. The smoke suite boots the real debug build and is the only
  check that exercises the assembled app, and vitest cannot instrument it, so none of these
  numbers describe it.
- Not measured - macOS and Windows-only code paths. Coverage runs on the Linux leg only.
- Excluded, and never to be read as tested: `src/main.ts` (boot wiring and view switching,
  exercised only by the smoke suite), `src/**/*.test.ts` and `src/**/*.d.ts`.
- Present in the report but not product coverage: `src-tauri/src/test_server.rs` is the mock
  SSH host, compiled only under `#[cfg(any(debug_assertions, test))]` (`lib.rs:10`); its 75%
  describes the fixture. `src-tauri/src/main.rs` is the binary entry point and reads 0%.
- Understated - the Tauri command layer. A handler taking `State` or `AppHandle` cannot be
  called from a plain `#[test]` (for example `get_app_config`, `src-tauri/src/config.rs:456`),
  so part of the low `lib.rs` figure is a measurement limit rather than missing tests.
- Revisit when: the baseline has settled over a few pull requests and a targeted gate is
  wanted - the natural shape being a floor on files a pull request touches, not the tree;
  or when the smoke suite gains coverage instrumentation, which would be the first number that
  describes the shipping app.
