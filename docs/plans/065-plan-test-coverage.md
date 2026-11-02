# Plan: test coverage reports and confirmed high-risk gaps (issue #56)

Status: Implemented; verification recorded below.
Spec: bonzo81/comnd#56, with the targeted coverage gate from bonzo81/comnd#88. Builds on the
Vitest harness from `docs/plans/054-plan-test-harness.md` and the CI jobs in
`.github/workflows/ci.yml`.

## Background

Neither side of the codebase had a coverage report. Test counts said nothing about which
branches were exercised, so "host management is covered" was an assumption rather than a
measurement. The issue deliberately framed the five inspection targets (host CRUD/grouping,
replay, session lifecycle, settings, IPC contracts) as *candidates*: the task was to measure
first, then only add tests where the data showed a real gap.

Coverage is evidence of execution, not correctness. Everything below is reported that way.

## Tooling

### Frontend — `@vitest/coverage-v8`

Chosen because it is the first-party provider for the Vitest version already in use
(Vitest 4), needs no separate instrumentation step, and produces `text`, `html`, `lcov` and
`json-summary` from one run. It measures **statement, branch, function and line** coverage.

`vitest.config.ts` sets `include: ["src/**/*.ts"]`. Without it Vitest reports only files a
test imported, so an untested module disappears from the report instead of showing 0%.

Excluded, and why:

- `src/**/*.test.ts` — the tests themselves.
- `src/**/*.d.ts` — type declarations, no runtime code.
- `src/main.ts` — view-switching glue that only runs inside a real WebView; it is covered by
  the WebDriver smoke suite (`docs/plans/062-plan-full-app-ssh-smoke-tests.md`), not by unit
  tests. It is **not** covered by anything in this report.

Two per-glob line floors are configured in `coverage.thresholds` — narrow, not a global
target, and derived from the baseline below. See [Targeted gates](#targeted-gates).

### Rust — `cargo-llvm-cov` 0.9.1

Chosen because it is the maintained wrapper around LLVM's own source-based coverage, needs no
code changes or extra crates, and reports **region, function and line** coverage. It requires
the `llvm-tools-preview` rustup component.

Branch coverage is **not available**: `cargo llvm-cov --branch` passes
`-Z coverage-options=branch`, which only exists on nightly. Installing a nightly toolchain
would instrument the crate with a different compiler than the one that ships, so the
measurement would not describe the released binary. The `Branches` column in the report
therefore prints `0 0 -` for every file, and no branch claim is made for Rust anywhere in this
document.

`src-tauri/src/main.rs` is included in the report at 0% (3 lines). It is binary glue
(`comnd_lib::run()`), not testable logic.

`src-tauri/src/test_server.rs` is **included** in the report at 75.04% lines — it is not
excluded, and its own numbers should not be read as product coverage. It is the mock SSH host
used by the smoke suite, so its lines execute during `cargo test` wherever a test starts it.

## Report commands

Frontend (writes `coverage/`, gitignored):

```bash
npm run test:coverage
```

Rust (writes `src-tauri/target/coverage-html/`, `src-tauri/target/coverage.lcov`):

```bash
cd src-tauri
cargo llvm-cov --html --output-dir target/coverage-html   # runs the tests, writes the report
cargo llvm-cov report                                     # per-file table + TOTAL to stdout
cargo llvm-cov report --lcov --output-path target/coverage.lcov
cargo llvm-cov report --json --summary-only --output-path target/coverage.json
```

`cargo llvm-cov` accepts one report format per invocation, so run it once and then re-run
`report` against the saved profdata. `--summary-only` is only valid with `--json`, `--lcov` or
`--cobertura`. `report --text` dumps annotated source (~18k lines here); plain `report` prints
the table CI needs.

Gate commands (what CI runs; both exit non-zero on a floor miss):

```bash
npm run test:coverage        # enforces coverage.thresholds in vitest.config.ts

cd src-tauri
cargo llvm-cov --no-report   # runs the tests, writes profdata only
cargo llvm-cov report        # the table, and the explanation for a miss below
cargo llvm-cov report --fail-under-lines 70 --fail-under-regions 72
```

`cargo llvm-cov` 0.9.1 exits 1 on a `--fail-under-*` miss **without printing why**
(`report.rs` calls `term::error::set(true)` and nothing else), so in CI the `TOTAL` row from the
plain `report` step above is the only explanation a reader gets. The enforce step echoes its own
floors first for the same reason. `report` re-reads the saved profdata, so the two commands cost
one instrumented run, not two.

## CI

Both coverage steps run on the `ubuntu-22.04` leg only, so the reports — and every floor derived
from them — are a **Linux baseline**, not a cross-platform one. The numbers can differ by OS:
`#[cfg(unix)]` / `#[cfg(windows)]` change which lines exist and which run, and there are 16 such
sites in `src-tauri/src`, so a macOS or Windows run measures a different set of lines. Running the
gate three times would triple the runtime for three non-comparable numbers, so the gate is the
Linux leg and macOS and Windows coverage stays unmeasured. See
[Targeted gates](#targeted-gates) for what that means for a local run.

- `coverage-frontend` — `actions/upload-artifact@v7`, path `coverage/`, 7-day retention.
- `coverage-rust` — `actions/upload-artifact@v7`, paths `src-tauri/target/coverage-html/` and
  `src-tauri/target/coverage.lcov`, 7-day retention.

Both uploads are gated on `github.event_name == 'pull_request'` and on `always()`, so a pull
request that fails a floor still publishes the report that explains the miss. Nothing leaves
GitHub: there is no Codecov/Coveralls/third-party upload, and the workflow's `permissions` stay at
`contents: read`. No step uses `continue-on-error` — a floor miss is a red build, not a warning.

`cargo-llvm-cov` is installed the same way the workflow already installs `tauri-driver` — an
`actions/cache@v4` entry keyed on the pinned version, then `cargo install --version 0.9.1
--locked` only on a cache miss.

## Measurements

Both baselines were taken with the tooling installed and no new tests, then re-taken after the
tests below.

| Suite | Metric | Before | After |
|---|---|---|---|
| Frontend (vitest v8) | Statements | 42.76% | 46.45% (3371/7256) |
| Frontend | Branches | 37.81% | 40.88% (1850/4525) |
| Frontend | Functions | 37.20% | 43.36% (598/1379) |
| Frontend | Lines | 44.63% | 48.59% (3102/6383) |
| Rust (llvm-cov) | Regions | 70.78% | 72.82% (14543/19971) |
| Rust | Functions | 54.94% | 57.14% (948/1659) |
| Rust | Lines | 69.08% | 71.05% (8293/11672) |
| Rust | Branches | not measurable | not measurable |

Per-file, after the change:

| File | Lines |
|---|---|
| `src/lib/tauri-api.ts` | 100% (75/75) |
| `src/lib/replay.ts` | 100% (9/9) |
| `src/lib/host-filters.ts` | 100% (29/29) |
| `src/lib/session-channel.ts` | 98.90% (90/91) |
| `src/components/settings-screen.ts` | 44.68% (374/837) |
| `src/components/host-screen.ts` | 37.78% (164/434) |
| `src-tauri/src/replay.rs` | 88.89% |
| `src-tauri/src/hosts.rs` | 71.02% |
| `src-tauri/src/config.rs` | 57.04% |
| `src-tauri/src/lib.rs` | 41.91% |

## Confirmed high-risk gaps

Each range below was confirmed uncovered by reading per-line hit data (`DA:` records in the
`lcov` output), not inferred from the file-level percentage. The behaviour column is what was
unproven before the tests.

### Frontend

| ID | Location | Unproven behaviour |
|---|---|---|
| F1 | `src/lib/replay.ts:13-28` | `substitute` on a partial or whitespace-only variable set; whether a failed substitution throws instead of sending a half-rendered command |
| F2 | `src/lib/replay.ts:30-35` | `renderReplayTemplate` chip rendering and escaping — whether user text and variable names can reach `innerHTML` unescaped |
| F3 | `src/lib/host-filters.ts:13-70` | NetBox id/group detection, descendant collection (cycle safety), search matching, and recency ordering |
| F4 | `src/lib/session-channel.ts:151-216` | `connect` rejecting, `disconnect` rejecting, post-unsubscribe event delivery, and per-session forwarding of the TOFU / TOFU-pending / auth-url prompts |
| F5 | `src/components/host-screen.ts:717-766` | Save-time validation blocking the IPC call, and a rejected `saveHost` leaving the form open with the error visible |
| F6 | `src/lib/tauri-api.ts:116-758` | The argument mapping of all 75 IPC wrappers — that each sends the right command name and payload, and returns the IPC result |
| F7 | `src/lib/tauri-api.ts` ↔ `src-tauri/src/lib.rs:476-570` | That no wrapper names a command the Rust side does not register (silent `invoke` rejection at runtime) |

### Rust

| ID | Location | Unproven behaviour |
|---|---|---|
| R1 | `src-tauri/src/hosts.rs:308-333` | `create_group` / `update_group` / `delete_group`: id assignment, persistence to `groups.json`, and the error on an unknown id |
| R2 | `src-tauri/src/hosts.rs:273-283` | `touch` setting `last_connected` and that the change reaches disk |
| R3 | `src-tauri/src/replay.rs:81-113` | `validate` boundary branches: oversized command, too many variables, empty/oversized variable name |
| R4 | `src-tauri/src/replay.rs:40-112` | `upsert` / `delete` round-tripping through disk, id assignment, and unknown-id errors |
| R5 | `src-tauri/src/lib.rs:43-58` | `DepCapLogger` both suppressing dependency-target records and letting application records through to the sink |
| R6 | `src-tauri/src/lib.rs:62-93` | `SizeCapWriter` truncating the file to zero bytes once a write reaches the cap, still returning the full buffer length, and starting a fresh file on the next write |
| R7 | `src-tauri/src/config.rs:212-224,423-446` | Corrupt-config preservation on startup, the plaintext-API-key migration, and that a keyless or fresh profile is left untouched |

### Confirmed not-gaps

Recorded so nobody re-opens them:

- `src-tauri/src/hosts.rs:463-472` `reject_synthetic_group` was already covered before this
  change.
- `src-tauri/src/config.rs:455-470` `get_app_config` takes `tauri::State`, so it cannot be
  called from a unit test. Unmeasurable, not untested-by-choice.
- `src-tauri/src/config.rs:441-443` (the keychain write inside the plaintext migration) depends
  on machine keychain state. Unmeasurable in CI, not a gap.
- `src-tauri/src/replay.rs:34-36,118-136` — `file_path()` plus the `replay_list` /
  `replay_save` / `replay_delete` command wrappers. `replay_save` needs `tauri::State`, and all
  three reach `app_data_dir()`, which honours `COMND_DATA_DIR` only in debug builds. Setting
  that variable from a second test would race the function-local `ENV_LOCK` in
  `paths::tests::test_export_import_roundtrip`. This is why the `*_at` seam exists instead.
- `src/lib/session-channel.ts:45` — `TauriTransport.disconnect`'s real `sshDisconnect` call.
  The channel tests drive `InMemoryTransport`; the real transport is exercised by the smoke
  suite.

## Tests added

Every test asserts observable output, persisted state, or failure behaviour. None of them
asserts only that a function ran. IPC tests use the strict harness (`createHarness()`), so an
unmocked command throws instead of silently succeeding; `saveHost` and the other void commands
stay explicitly mocked.

### Frontend

`src/lib/replay.test.ts` (new, 9 tests) — gaps F1, F2:

- replaces every occurrence of a variable — repeated `{{name}}` in one template are all substituted.
- substitutes multiple distinct variables in one template — each placeholder gets its own value.
- throws instead of sending a partially substituted command — a missing value raises rather than leaving `{{name}}` in the command.
- treats a whitespace-only value as missing — `"   "` counts as unset and throws.
- leaves a template without variables unchanged — no placeholders means byte-identical output.
- renders each variable as a chip — each placeholder becomes exactly one chip span.
- escapes template text before it reaches innerHTML — `<img onerror>` in the command is inert markup.
- escapes a variable name so the only markup is the chip span — a hostile name cannot add attributes or tags.
- leaves unmatched braces alone — `{ single }` and stray braces survive untouched.

`src/lib/host-filters.test.ts` (new, 14 tests) — gap F3:

- is true for a NetBox-sourced host / is true for a host whose id carries the netbox prefix / is false for a user-created host — the three `isNetboxHost` cases.
- detects the netbox host prefix only at the start — `user-netbox-x` is not a NetBox host.
- detects synthetic netbox groups — `__netbox__` is a synthetic group id.
- includes children and grandchildren regardless of order — descendant collection is order-independent.
- returns only the id for a leaf group — a childless group yields exactly itself.
- does not loop forever on a parent cycle — a self/cyclic parent terminates.
- matches an empty query / matches each searchable field, case-insensitively / rejects a query no field contains — `hostMatches` on every searchable field.
- drops hosts that were never connected and sorts newest first / breaks a last_connected tie by sort_order / keeps never-connected hosts last when sorting by recency — `recentHosts` ordering rules.

`src/lib/session-channel.test.ts` (extended, +4 tests, 13 total) — gap F4:

- sets state to error and rethrows when the connect IPC rejects — the failure is surfaced, not swallowed.
- stops delivering events after the unsubscribe function runs — a late event does not reach the handler.
- resolves disconnect even when the transport rejects, and still swallows the drop — teardown never throws.
- forwards TOFU and auth-url prompts from this session only — the three auth-phase prompts reach the listener with mapped field names.

`src/components/host-screen.test.ts` (new, 2 tests) — gap F5:

- blocks the save IPC and names the blank required fields — `saveHost` is never called and the error text lists every blank field.
- shows the failure and keeps the form open when the save IPC rejects — the form stays mounted with `Save failed: …` visible.

`src/lib/ipc-contract.test.ts` (new, 80 tests) — gaps F6, F7:

- `it.each` over a 75-row table — each wrapper sends its expected command name and returns the IPC result, with a distinct sentinel per parameter so a swapped argument fails.
- covers every wrapper, with no duplicate command names — a 75-entry tripwire, so adding a wrapper without a row fails.
- sends only command names the Rust side registers — parses `generate_handler![…]` out of `src-tauri/src/lib.rs` and fails on any wrapper command the Rust side does not register (gap F7).
- passes an explicit platformName through instead of nulling it / sends an empty sourceUrl as null, not an empty string / passes optional KB command fields through when they are supplied — the three wrappers whose optional arguments have non-obvious defaults.

### Rust

`src-tauri/src/hosts.rs` (3 tests) — gaps R1, R2:

- `test_touch_sets_last_connected_and_persists` — `touch` writes a `last_connected` timestamp that survives a re-read from disk.
- `test_group_crud_assigns_ids_and_persists` — create/update/delete produce distinct ids and the surviving groups are exactly what a fresh `HostStore::new` reads back.
- `test_group_crud_unknown_id_errors` — updating or deleting an unknown group id returns an error and leaves the store unchanged.

`src-tauri/src/replay.rs` (3 tests) — gaps R3, R4:

- `test_validate_rejects_oversized_and_malformed_fields` — the exact message for each cap: `Command exceeds {MAX_COMMAND} characters`, `Too many variables (max {MAX_VARS})`, `Variable name is required`, `Variable name exceeds {MAX_VAR_NAME} characters`.
- `test_upsert_assigns_id_and_round_trips_through_disk` — `upsert` assigns an id and `created_at`, and the command reads back from the file unchanged.
- `test_upsert_and_delete_unknown_id_error` — updating or deleting an unknown id errors and does not write.

`src-tauri/src/lib.rs` (3 tests) — gaps R5, R6, R7:

- `test_dep_cap_logger_caps_dependency_targets` — a `russh::cipher` Info record never reaches the sink while a `comnd_lib::ssh` Info record does, and `flush()` reaches the sink.
- `test_size_cap_writer_truncates_at_cap` — the write that reaches the cap truncates the file to zero bytes and still returns the full buffer length (so `write_all` does not see a short write), the next write starts a fresh file, and `max_bytes == 0` disables the check.
- `test_multi_writer_fans_out_and_propagates_errors` — every sink receives the bytes, and a failing sink's error is returned.

`src-tauri/src/config.rs` (4 tests) — gap R7:

- `test_corrupt_config_is_preserved_and_startup_uses_defaults` — truncated JSON yields defaults, `config.json` is gone, and exactly one `config.json.corrupt-*` holds the original bytes.
- `test_plaintext_migration_leaves_keyless_config_untouched` — an empty `ollama_api_key` leaves the file bytes unchanged.
- `test_fresh_profile_starts_on_defaults_without_writing_config` — a missing `config.json` yields defaults and still does not exist afterwards.
- `test_config_without_plaintext_key_is_left_untouched` — a config with no key field is not rewritten and its values are honoured.

### Source change made to enable a test

`src-tauri/src/replay.rs` gained `load_at` / `save_at` / `upsert_at` / `delete_at`, taking a
`&Path`. `load`, `save`, `upsert` and `delete` are thin wrappers over them, so command
behaviour is unchanged (`replay_save` still returns the pre-assignment struct). Without the
seam the only way to reach the persistence code was through `app_data_dir()`, which races the
existing `ENV_LOCK` test. This was approved as part of the gap list.

## Resolved gaps

**F8 — settings saves fail silently (fixed, #87).** The five config writes in
`src/components/settings-screen.ts` (log level, log max size, max sessions, session logging,
session log timestamps) previously ran as `void setX(...)` with no `.catch`. A rejected
`invoke` was therefore unhandled: no toast appeared and the control kept showing a value that
was never persisted. Each handler now catches the rejection, toasts `Failed to save …`, and
resets its own control from the stored config. `src/components/settings-screen.test.ts` covers
all five rejecting paths and one succeeding path.

The backend had the matching defect: `ConfigStore::save_*` mutated the in-memory config before
`persist()`, so a failed write still returned the new value from `get_app_config`. All config
writes now go through `apply_and_persist`, which restores the previous config when the write
fails; `test_failed_persist_rolls_back_in_memory_config` covers the rollback.

## Observations (not fixed)

`renderReplayTemplate` escapes twice: it runs `escHtml(command)` and then `escHtml(name)` on a
name that is already inside the escaped template. A variable named `<script>` renders a chip
labelled `&lt;script&gt;` instead of `<script>`. It is cosmetic, it fails closed, and no test
freezes it — the escaping tests assert that markup is inert, not the exact entity text.

## Targeted gates

Issue #88 turned these reports into a regression gate: four floors, three on lines and one on
regions, all below the recorded Linux baseline.

| Area | Where it is enforced | Floor | Baseline (post-#86, ubuntu leg) | Headroom |
|---|---|---|---|---|
| `src/lib/{replay,host-filters,session-channel,tauri-api}.ts` | `coverage.thresholds` in `vitest.config.ts` | 98% lines | 99.51% (203/204) | 1.51 pp ≈ 4 lines |
| `src/components/{host-screen,settings-screen}.ts` | same | 41% lines | 42.33% (538/1271) | 1.33 pp ≈ 17 lines |
| Rust total | `cargo llvm-cov report --fail-under-lines 70` | 70% lines | 71.05% (8293/11672) | 1.05 pp ≈ 123 lines |
| Rust total | `cargo llvm-cov report --fail-under-regions 72` | 72% regions | 72.82% (14543/19971) | 0.82 pp ≈ 164 regions |

### Why these four, and why lines

The frontend globs cover exactly the modules #86 added behaviour tests for, so each floor protects
a specific set of tests rather than a percentage of the tree: `tauri-api.ts` (75/75),
`replay.ts` (9/9), `host-filters.ts` (29/29) and `session-channel.ts` (90/91) are the IPC and
state-helper contracts; `settings-screen.ts` (374/837) and `host-screen.ts` (164/434) are the two
screens whose save and CRUD paths the same change covered. The Rust floors are totals because the
per-file spread there is genuine (`replay.rs` 88.89% down to `lib.rs` 41.91%, the latter partly a
`State`/`AppHandle` measurement limit), so a per-file Rust floor would encode the shape of the code
rather than the health of the suite.

Lines and regions are the only metrics gated:

- **Branches (frontend)** — v8 attributes branches through source maps, which makes it the
  noisiest column; a floor on it fails on refactors that keep every behaviour tested.
- **Functions** — Vitest counts each arrow separately, so hoisting a callback lowers the number
  with no test lost.
- **Rust branches** — not measurable on stable at all (see
  [Tooling](#rust--cargo-llvm-cov-091)); no floor claims it, and the report still prints `0 0 -`.
- **Lines** — the one metric both toolchains report directly and the one issue #56 quotes.
- **Rust regions** — gated as well as lines, because `cargo llvm-cov` attributes a region to an
  expression rather than a line, so a line-level floor can miss a branch that stops executing
  inside a still-covered line. Regions move less per refactor, hence the smaller headroom. There
  is no frontend region metric.

Not gated, deliberately: a global percentage target, per-file enforcement
(`--fail-under-file-lines`, `coverage.thresholds.perFile`), any third-party coverage service, and
anything that needs `continue-on-error` to stay green. If a floor later proves noisy the fix is to
loosen or delete it and record why here — not to mute the step.

### The Rust floors are totals, not per-area

`cargo llvm-cov` offers thresholds at exactly two granularities: the whole report
(`--fail-under-lines`, `--fail-under-regions`, `--fail-under-functions`) and per file
(`--fail-under-file-lines`). It has no per-glob or per-directory form, and the per-file form is
excluded by #88, so a Rust floor shaped like the frontend globs is not expressible with this tool.

That makes the Rust gate an aggregate tripwire rather than a per-area floor, with the two
properties an aggregate gate always has: a coverage gain elsewhere can offset a regression inside
a module this change set out to protect, and a large unrelated addition can fail it. Both are
accepted deliberately. The floors sit ~1 pp under the measured totals, so roughly a hundred
uncovered lines have to move before either trips — far more than the churn of a normal pull
request — and #88's instruction was specifically "no global percentage *target*": these are floors
below the current measurement, not a number anyone is asked to reach, and no percentage goal is set
anywhere. The remaining limit is real and is stated here rather than glossed: the Rust side is not
a per-area gate.

The alternative considered and rejected was scoping the report with an inverted
`--ignore-filename-regex`. The expression is unreadable, its meaning drifts silently as files are
added, and the floor would then gate a number that does not match the `TOTAL` a reader sees in the
report above it.

### Headroom

Each floor sits a little under its baseline so ordinary churn does not fail the build, while a
deleted test file or a large new untested module still does:

- **Frontend glob 1 (1.51 pp, ~4 lines).** These four files are almost fully covered, so the
  absolute line count is small and headroom is best read in lines: 4 lines allows a couple of new
  defensive branches. Removing the smallest test file in the group (`replay.test.ts`, 9 lines of
  source) takes the glob to 194/204 = 95.10% and fails.
- **Frontend glob 2 (1.33 pp, ~17 lines).** Same reasoning at screen scale: 17 lines absorbs a new
  error path. Deleting `host-screen.test.ts` takes the glob to 32.12% and fails;
  deleting `settings-screen.test.ts` is worse. The tree already measures higher than the baseline
  (45.02%, 597/1326) because #87 added settings-save tests, so this floor is the most conservative
  of the four.
- **Rust lines (1.05 pp, ~123 lines) and regions (0.82 pp, ~164 regions).** A new module of a
  couple of hundred uncovered lines, or a deleted integration test, crosses these; a defensive
  branch or two does not. Regions move less than lines per refactor, hence the smaller gap.

### A local run is not the CI measurement

Both floors were derived from the `ubuntu-22.04` leg. An honest local run on Windows is expected
to measure slightly lower on the Rust side — 70.87% lines and 72.71% regions on the machine this
gate was written on, against 71.05% / 72.82% on Linux — because `#[cfg(windows)]` lines replace
`#[cfg(unix)]` ones. Both Windows numbers still clear 70 and 72, so `cargo llvm-cov report
--fail-under-lines 70 --fail-under-regions 72` passes locally; if a future Windows measurement
drops below a floor while CI is green, that is the OS difference and the answer is to record the
local number here, not to lower the floor on CI's behalf. The frontend has no OS-conditional test
in the suite (no `skipIf`, no `process.platform` branch), so its floors are expected to hold
identically on every OS; they did on Windows (48.96% lines total, glob 1 99.5%, glob 2 45.02%).

### Failing path, proved

Raising a floor above the measured value, and deleting a test file, both fail the build:

```text
$ # coverage.thresholds glob 1 raised to lines: 100
$ npm run test:coverage
ERROR: Coverage for lines (99.5%) does not meet "src/lib/{replay,host-filters,session-channel,tauri-api}.ts" threshold
(100%)
exit 1

$ # src/components/host-screen.test.ts moved aside, floors at their real values
$ npm run test:coverage
Lines        : 46.33% ( 3011/6498 )
ERROR: Coverage for lines (32.12%) does not meet "src/components/{host-screen,settings-screen}.ts" threshold (41%)
exit 1

$ cd src-tauri && cargo llvm-cov report --fail-under-lines 99 --fail-under-regions 99
TOTAL  20128  5492  72.71%  1685  722  57.15%  11774  3430  70.87%  0  0  -
exit 1        # silent by design in cargo-llvm-cov 0.9.1; the TOTAL row is the explanation
```

Reverted, the same commands pass — the no-op check:

```text
$ npm run test:coverage
Lines        : 48.96% ( 3182/6498 )
exit 0

$ cd src-tauri && cargo llvm-cov --no-report && cargo llvm-cov report
TOTAL  20128  5492  72.71%  1685  722  57.15%  11774  3430  70.87%  0  0  -
exit 0

$ cargo llvm-cov report --fail-under-lines 70 --fail-under-regions 72
exit 0
```

### Known limitations

- **A glob that matches nothing passes.** picomatch reports a group with no files as 100%, so
  renaming a file out of a glob silently retires that floor. The globs are listed explicitly
  (no `**`) to keep a move visible in review; check the `text` reporter's per-file rows when
  changing these file names.
- **Only the listed files are gated.** A new untested module elsewhere lowers the total but trips
  no frontend floor. The Rust floors are the only whole-tree check, and they are totals, so a large
  addition can be offset by unrelated coverage elsewhere — see
  [The Rust floors are totals](#the-rust-floors-are-totals-not-per-area).

## Decisions

1. **v8 over istanbul for the frontend.** First-party for Vitest 4, no instrumentation step,
   branch coverage included. Istanbul would add a transform step for no measurement gain.
2. **`cargo-llvm-cov` over `tarpaulin`.** Source-based LLVM coverage, no code changes, no extra
   crate. Tarpaulin is Linux-only and reports differently.
3. **No nightly for Rust branch coverage.** A nightly instrumented build does not describe the
   shipping binary, and the branch column would then need a caveat anyway. Documented as
   unsupported instead.
4. **`include: ["src/**/*.ts"]` in the Vitest config.** Otherwise a module with no importing
   test vanishes from the report and looks like it does not exist.
5. **Coverage on the ubuntu leg only.** A Linux baseline, not a cross-platform one — `#[cfg]`-gated
   lines differ per OS, so the macOS and Windows paths are unmeasured. The artifact and the gate
   both live there.
6. **Artifacts, not a service.** No third-party upload, no token, no `permissions` change.
7. **Targeted per-glob floors on the frontend, no global target (#88).** A whole-tree frontend
   percentage on these numbers would be set low enough to be meaningless or would fail on unrelated
   churn. A glob per module group fails only when the tests protecting that group lose coverage,
   which is the behaviour worth blocking a pull request for. The Rust side cannot take that shape:
   `cargo llvm-cov` has no per-glob threshold, so its two floors are totals — a deliberate,
   documented compromise, see [The Rust floors are totals](#the-rust-floors-are-totals-not-per-area).
8. **Lines on both sides, plus Rust regions.** Branches are noisy through source maps on the
   frontend and unavailable on stable for Rust; functions count each arrow. Lines is the one
   metric both toolchains report directly, and no floor claims Rust branch coverage. Rust also
   gets a region floor, because `cargo llvm-cov` attributes regions to expressions and so catches
   a dead branch inside a still-covered line.
9. **Headroom under the recorded baseline, not at it.** Each floor sits ~1–1.5 pp under the
   post-#86 measurement so a new defensive branch or two passes and a deleted test file does not.
   The numbers and the arithmetic are in [Targeted gates](#targeted-gates).
10. **The gate rides on existing commands.** `npm run test:coverage` enforces the frontend floors
    and a `cargo llvm-cov report --fail-under-lines --fail-under-regions` step was added inside the
    existing `coverage-rust` job. No new workflow, no new npm script, no `continue-on-error`.

## Verification

Commands and final output lines are recorded in the pull request for this change. All of them
exit 0. The table in [Measurements](#measurements) is the recorded Linux baseline; these are the
same commands re-run on the Windows development machine that added the gate, so the Rust totals
sit ~0.2 pp below the Linux figures (see [Targeted gates](#targeted-gates)):

```text
npm run build             -> ✓ built in 1.47s
npm run test              -> Tests  554 passed (554)
cargo check --all-targets -> Finished `dev` profile [unoptimized + debuginfo] target(s) in 1m 08s
cargo test                -> test result: ok. 256 passed; 0 failed  (lib)
                             test result: ok. 3 passed; 0 failed    (integration)
npm run test:coverage     -> Test Files  36 passed (36) / Lines 48.96% (3182/6498)
cargo llvm-cov --no-report-> exit 0
cargo llvm-cov report     -> TOTAL 20128 5492 72.71% | 1685 722 57.15% | 11774 3430 70.87% | 0 0 -
cargo llvm-cov report --fail-under-lines 70 --fail-under-regions 72 -> exit 0
```

The failing path and the no-op check are recorded in [Targeted gates](#targeted-gates).

Not run, and why:

- **Rust branch coverage** — needs a nightly toolchain; see [Tooling](#rust--cargo-llvm-cov-091).
- **`cargo llvm-cov` on macOS** — not attempted, and CI does not run it there either, so
  macOS-only paths stay unmeasured. Windows *was* re-run locally (the totals above are that run),
  but CI still measures only the Linux leg. The numbers are *not* OS-independent: conditional
  compilation changes which lines exist and run, so the recorded baseline is a Linux baseline and
  the Windows figures are a local cross-check against it.
- **Smoke suite** — this change touches no keystroke path, suggestion controller, terminal view
  or smoke file, so `npm run smoke` was not required by `AGENTS.md`. The CI run for the pull
  request still executes it.
