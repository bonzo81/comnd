# 016. Four per-area line floors gate coverage, superseding the "not a gate" clause of ADR 014

Date: 2026-11-02
Status: Accepted
Supersedes: ADR-014, for its "coverage is a report, never a gate" clause only.

## Context
ADR 014 shipped coverage as a report and recorded, deliberately, that it was "not a gate": the
baseline had been measured once and a global percentage floor would either be meaningless or
freeze the current shape. Issue #88 is the follow-up that decision named, taken after the
baseline had survived several merged changes.

The numbers it gates on are ADR 014's own: frontend 48.59% lines (3102/6383), Rust 71.05% lines
(8293/11672), both measured on the `ubuntu-22.04` leg. They are global figures, so the per-area
baselines a floor needs were decomposed from the `coverage-frontend` and `coverage-rust`
artifacts of the same CI run (frontend 3109/6383, Rust 8266/11657 — a same-measurement
difference of 0.11pp and 0.14pp). The derivation, the headroom and the response when a floor
trips live in `docs/plans/065-plan-test-coverage.md`; this ADR records the shape and its limits.

Constraints the issue set, and this ADR keeps: no global percentage target, no per-file
enforcement, no third-party coverage service, no `continue-on-error`, and Rust branch coverage
stays unmeasured.

## Options
- **One global floor via `--fail-under-lines` and Vitest's top-level `thresholds.lines`.** Cost:
  a single number dominated by `src/components/` (31.41% of 4199 lines), which moves whenever a
  screen is added and says nothing about which behaviour lost its test.
- **Per-file floors (`--fail-under-file-lines`, `thresholds.perFile`).** Cost: a new file at 0%
  fails the build on arrival, which turns every partial feature into a red CI run; it also
  penalises the deliberately untestable Tauri command glue.
- **A floor on the lines a pull request touches.** Cost: needs diff-aware tooling the repo does
  not have, and it silently passes a change that deletes tests it did not otherwise touch.
- **A script over `cargo llvm-cov report --json`.** Cost: about seventy lines of Node to
  maintain, plus a Node setup step in the rust job.
- **Several `report --ignore-filename-regex '(?!a|b)' --fail-under-lines N` runs.** Cost: no
  custom code, but the file list is an inverted regex, the failure message names no area, and a
  renamed file silently shrinks the area instead of failing.
- **Do nothing further.** Cost: the #86 tests can be deleted or skipped and nothing fails.

## Decision
Four line floors, each over an area that maps to behaviour #86 brought under measurement:

| Area | Files | Floor |
|---|---|---|
| frontend `src/lib/**` | every `src/lib/*.ts` module | 78% lines |
| frontend `src/components/**` | every `src/components/*.ts` module | 29% lines |
| rust core stores | `src-tauri/src/hosts.rs`, `replay.rs`, `config.rs` | 65% lines |
| rust command layer | `src-tauri/src/lib.rs` | 35% lines |

Each floor sits below its measured baseline by a stated headroom: 3.96pp, 2.41pp, 2.60pp and
6.74pp respectively, against an observed same-commit measurement variance of 0.11pp (frontend)
and 0.14pp (Rust). `lib.rs` carries the largest headroom because its denominator only grows:
`#[tauri::command]` handlers cannot be called from a plain `#[test]` without an app handle.

Frontend: two glob-keyed `coverage.thresholds` entries in `vitest.config.ts`. Vitest 4 applies a
threshold set only to the files its glob matches and applies no global threshold when no
top-level `lines` is set, so the config expresses exactly two area floors.

Rust: `scripts/check-rust-coverage.mjs` reads `cargo llvm-cov report --json --summary-only`,
sums `summary.lines.covered` / `summary.lines.count` for the files each area names, and exits
non-zero with the area, its actual percentage, the floor and the shortfall. It also fails when a
configured file is missing from the report, so a rename cannot shrink an area and quietly raise
its percentage. It runs as `npm run test:coverage:rust` on the `ubuntu-22.04` leg only, because
`#[cfg]` changes which lines exist. Rust branch coverage stays unmeasured and no floor claims it.

`--fail-under-lines` and `--fail-under-file-lines` are not used: the first is the global target
this change rules out, the second is the per-file policy it rules out.

## Consequences
- Easier: deleting or skipping one of the #86 test files now fails CI in the area that lost it,
  and the failure names the area and the shortfall rather than a bare percentage; the floors are
  four lines of config plus one script, with no service, token or dashboard.
- Harder: a change that legitimately adds a large untested module has to either test it or lower
  a floor in the same pull request with the new derivation recorded; `src/components/` growth
  will eventually force that conversation, which is the point.
- Rules out: a global percentage target, `thresholds.perFile`, `--fail-under-file-lines`, and
  `continue-on-error` on any coverage step.
- Amends ADR 014: the "coverage is a report, never a gate" clause is superseded. The rest of
  ADR 014 stands — v8 and cargo-llvm-cov, artifacts rather than a service, the Linux-only
  measurement, and no Rust branch coverage.
- Unchanged: coverage still leaves GitHub only as a workflow artifact, and both upload steps now
  use `if: always()` so a red floor still publishes the report needed to read it.
- Revisit when: a floor trips on churn rather than on a lost test — loosen it and record why in
  plan 065 rather than muting the step.
