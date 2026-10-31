# Plan: test coverage reports and confirmed high-risk gaps (issue #56)

Status: Implemented; verification recorded below.
Spec: bonzo81/comnd#56. Builds on the Vitest harness from
`docs/plans/054-plan-test-harness.md` and the CI jobs in `.github/workflows/ci.yml`.

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

No thresholds are configured. A gate needs a measured, stable baseline first; see
[Targeted gates](#targeted-gates).

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

## CI

Both coverage steps run on the `ubuntu-22.04` leg only. The numbers do not vary by OS and the
report is an artifact, not a gate, so running them three times would only triple the runtime.

- `coverage-frontend` — `actions/upload-artifact@v4`, path `coverage/`, 7-day retention.
- `coverage-rust` — same action, paths `src-tauri/target/coverage-html/` and
  `src-tauri/target/coverage.lcov`, 7-day retention.

Both uploads are gated on `github.event_name == 'pull_request'`. Nothing leaves GitHub: there
is no Codecov/Coveralls/third-party upload, and the workflow's `permissions` stay at
`contents: read`.

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
| F8 | `src/components/settings-screen.ts:1137,1195,1199,1203,1216,1220` | Deferred — see [Deferred](#deferred) |

### Rust

| ID | Location | Unproven behaviour |
|---|---|---|
| R1 | `src-tauri/src/hosts.rs:308-333` | `create_group` / `update_group` / `delete_group`: id assignment, persistence to `groups.json`, and the error on an unknown id |
| R2 | `src-tauri/src/hosts.rs:273-283` | `touch` setting `last_connected` and that the change reaches disk |
| R3 | `src-tauri/src/replay.rs:81-113` | `validate` boundary branches: oversized command, too many variables, empty/oversized variable name |
| R4 | `src-tauri/src/replay.rs:40-112` | `upsert` / `delete` round-tripping through disk, id assignment, and unknown-id errors |
| R5 | `src-tauri/src/lib.rs:43-58` | `DepCapLogger` both suppressing dependency-target records and letting application records through to the sink |
| R6 | `src-tauri/src/lib.rs:62-93` | `SizeCapWriter` truncating at the cap and reporting the short write |
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
- `test_size_cap_writer_truncates_at_cap` — a write past the cap is truncated to exactly the cap and reports a short write.
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

## Deferred

**F8 — settings saves fail silently.** `src/components/settings-screen.ts` fires six config
writes as `void setX(...)` with no `.catch`
(lines 1137, 1195, 1199, 1203, 1216, 1220 — log level, log max size, max sessions, session
logging, session log timestamps, shortcut overrides). If the IPC rejects, the rejection is
unhandled: no toast appears and the control keeps showing the new value, so the UI can display
a setting that was never persisted. The neighbouring handlers
(`#duplicate-session-policy` at 1208, `#session-log-dir` at 1225, `#log-file-path` at 1257)
already catch and toast, so the behaviour is inconsistent within one screen.

Fixing this means choosing between reverting the control to the persisted value and toasting,
and that decision was not taken. **No test was added here** — a test that asserted today's
silent-failure behaviour would freeze the defect. Tracked as a deferred gap rather than
implied covered.

**F8's measurement limit:** the screen sits at 44.68% lines and its remaining uncovered lines
are the per-setting handler bodies, which the deferred defect is part of.

## Observations (not fixed)

`renderReplayTemplate` escapes twice: it runs `escHtml(command)` and then `escHtml(name)` on a
name that is already inside the escaped template. A variable named `<script>` renders a chip
labelled `&lt;script&gt;` instead of `<script>`. It is cosmetic, it fails closed, and no test
freezes it — the escaping tests assert that markup is inert, not the exact entity text.

## Targeted gates

None, deliberately. Issue #56 asks for a baseline first, and a global percentage gate on these
numbers would either be set low enough to be meaningless or fail on unrelated churn. The
targeted gates worth considering once a second measurement exists are narrow and behavioural,
for example "`src/lib/tauri-api.ts` stays at 100% lines and every wrapper has a contract row"
(the tripwire in `ipc-contract.test.ts` already enforces the second half). Those are follow-up
work, not part of this change.

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
5. **Coverage on the ubuntu leg only.** Same numbers everywhere; the artifact is what matters.
6. **Artifacts, not a service.** No third-party upload, no token, no `permissions` change.

## Verification

Commands and final output lines are recorded in the pull request for this change. All of them
exit 0:

```text
npm run build            -> ✓ built in 1.45s
npm run test             -> Test Files  36 passed (36) / Tests  539 passed (539)
cargo check --all-targets-> Finished `dev` profile [unoptimized + debuginfo] target(s) in 4.08s
cargo test               -> test result: ok. 255 passed; 0 failed  (lib)
                            test result: ok. 3 passed; 0 failed    (integration)
npm run test:coverage    -> Lines 48.59% (3102/6383)
cargo llvm-cov report    -> TOTAL 19971 5428 72.82% | 1659 711 57.14% | 11672 3379 71.05% | 0 0 -
```

Not run, and why:

- **Rust branch coverage** — needs a nightly toolchain; see [Tooling](#rust--cargo-llvm-cov-091).
- **`cargo llvm-cov` on macOS** — not attempted; the numbers are OS-independent and CI covers
  the Linux leg.
- **Smoke suite** — this change touches no keystroke path, suggestion controller, terminal view
  or smoke file, so `npm run smoke` was not required by `AGENTS.md`. The CI run for the pull
  request still executes it.
