# 014. Coverage comes from v8 and cargo-llvm-cov, ships as Actions artifacts, and is not a gate

Date: 2026-10-31
Status: Accepted, then amended 2026-11-02 — see
[Amendment: targeted floors](#amendment-2026-11-02--targeted-floors-issue-88) at the end. The
sections above are the original record and are left as written.

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
Coverage is a report, never a gate, and it never leaves GitHub. *(The gate half was reversed on
2026-11-02 - see [the amendment](#amendment-2026-11-02--targeted-floors-issue-88).)*

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

## Amendment: 2026-11-02 — targeted floors (issue #88)

Status: Accepted. This amends the Decision above. "Coverage is a report, never a gate" no longer
holds; the rest of the record - the tooling, the Linux-only measurement, the artifact upload and
every "not measured" limit - stands unchanged.

**Context.** The revisit condition above was "once the baseline has settled over a few pull
requests". It has: #56 recorded the post-test baseline on the `ubuntu-22.04` leg (frontend 48.59%
lines; Rust 71.05% lines / 72.82% regions), and the suites have moved only with deliberate test
changes since. Issue #88 therefore asked for the narrow, targeted shape this ADR anticipated,
explicitly not a whole-tree percentage.

**Decision.** Four floors, lines-based, each ~1-1.5 pp under the recorded baseline. No global
percentage target, no per-file enforcement, no third-party service, no `continue-on-error`.

| Area | Enforced by | Floor | Baseline | Headroom |
|---|---|---|---|---|
| `src/lib/{replay,host-filters,session-channel,tauri-api}.ts` | `coverage.thresholds` in `vitest.config.ts` | 98% lines | 99.51% (203/204) | 1.51 pp ≈ 4 lines |
| `src/components/{host-screen,settings-screen}.ts` | same | 41% lines | 42.33% (538/1271) | 1.33 pp ≈ 17 lines |
| Rust total lines | `cargo llvm-cov report --fail-under-lines 70`, new step in the existing `coverage-rust` job | 70% | 71.05% (8293/11672) | 1.05 pp ≈ 123 lines |
| Rust total regions | `cargo llvm-cov report --fail-under-regions 72`, same step | 72% | 72.82% (14543/19971) | 0.82 pp ≈ 164 regions |

Why this shape:

- **Per-glob, not per-file and not global.** The two frontend globs are exactly the modules #86
  added behaviour tests for, so each floor protects a known set of tests. A whole-tree percentage
  would sit low enough to be meaningless or fail on unrelated churn; a per-file floor would encode
  the current shape of every file, including the ones a `State`/`AppHandle` signature keeps out of
  reach of `#[test]`.
- **Lines only.** v8 attributes branches through source maps, so branch floors fail refactors that
  keep behaviour tested; Vitest counts each arrow as a function, so function floors fall on a
  hoisted callback. Rust branch coverage is still unmeasurable on stable (see above) and no floor
  claims it - the report continues to print `0 0 -`.
- **Headroom under, not at, the baseline.** A new defensive branch or two must not fail a pull
  request; a deleted test file must. Both were checked: deleting `host-screen.test.ts` takes that
  glob to 32.12% and deleting `replay.test.ts` takes the other to 95.10%, and each fails.
- **The gate rides on existing commands.** `npm run test:coverage` gained the thresholds, and one
  `cargo llvm-cov report --fail-under-lines --fail-under-regions` step was inserted into the
  existing `coverage-rust` job on the ubuntu leg. No new workflow, no new npm script.

**Consequences.**

- Easier: a pull request that deletes or weakens the tests behind these modules now goes red
  instead of quietly lowering a number in an artifact nobody opens; the floors are plain config
  and plain CLI flags, so a developer can reproduce a failure locally with the same two commands
  CI runs.
- Harder: the frontend floors only cover the listed files, so an untested module added elsewhere
  still lowers the total without tripping anything; a glob that matches no file reports 100% and
  passes, so a rename can retire a floor silently - the globs are explicit (no `**`) to keep that
  visible in review.
- Local runs: the floors come from the Linux leg, and Windows measures slightly lower on the Rust
  side (70.87% lines / 72.71% regions on the machine the gate was written on) because
  `#[cfg(windows)]` lines replace `#[cfg(unix)]` ones. Both clear the floors, so an honest Windows
  `cargo llvm-cov report --fail-under-lines 70 --fail-under-regions 72` passes. The frontend suite
  has no OS-conditional test, so its floors are OS-independent in practice.
- Known tool quirk: `cargo-llvm-cov` 0.9.1 exits 1 on a `--fail-under-*` miss without printing a
  reason, so the `TOTAL` row from the preceding `report` step is the explanation, and the enforce
  step echoes its own floors first.
- If a floor later proves noisy, loosen or remove it and record the reason in
  `docs/plans/065-plan-test-coverage.md` §Targeted gates. `continue-on-error` is not an option.

