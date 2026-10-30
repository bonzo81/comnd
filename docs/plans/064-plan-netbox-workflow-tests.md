# Plan: NetBox configuration, sync and refresh tests (issue #55)

Status: Implemented; verification recorded below.
Spec: bonzo81/comnd#55. Builds on `docs/plans/016-plan-netbox-host-source.md` and the
smoke-test harness from `docs/plans/062-plan-full-app-ssh-smoke-tests.md`
(`docs/adr/011-webdriverio-tauri-driver-smoke-tests.md`).

## Background

Plan 016 shipped the NetBox host source with unit coverage for the client, the cache and the
merge into the host tree. Those tests call the client directly. Nothing proved the path a user
actually walks: typing a URL and token into Settings, testing the connection, syncing, seeing
the resulting tree, refreshing after the remote data changes, and getting a useful message when
the API rejects the request.

The gap matters because the interesting failures live in that path. A sync that half-applies
leaves a stale tree behind a success toast. A refresh that appends instead of replacing
duplicates every device. A 401 during refresh that still writes the cache destroys working data.
None of those are visible to a test that only exercises `fetch_devices`.

## Pinned sync semantics

Two behaviours were previously implied by the code but not written down or asserted. They are
now contract:

1. **A successful sync full-replaces the device array.** `NetBoxCache::apply_sync` replaces
   `devices` wholesale with the newly fetched set, preserving the user's per-device `enabled`
   and `overlay` flags by `netbox_id`. A device that disappears from NetBox disappears from the
   cache and from the tree; a device that appears is added; a renamed device keeps its flags.
   Nothing accumulates, so a second sync of unchanged data is a no-op on the tree.
2. **A failed refresh leaves the previously synced tree untouched.** `netbox_sync` validates,
   fetches devices, fetches geography, builds entries, and only then calls `apply_sync`. Every
   failure path returns before `apply_sync`, so `netbox-cache.json` is not rewritten and the
   host tree still shows the last good sync. The UI reports the error and no success toast
   appears.

Geography is a partial exception and stays as designed in plan 016: `fetch_geo` degrades an
erroring geography read to an empty table rather than failing the sync. Device failures are the
ones that must be atomic.

## Decisions

1. **Reuse the existing HTTP mock; do not build a second simulator.** The `#[cfg(test)]` mock in
   `src-tauri/src/netbox.rs` moved to a `#[cfg(any(test, debug_assertions))] mod mock` so the
   app-level suite drives the same code the Rust unit tests use. It keeps its GET-only 405
   tripwire: a non-GET request is answered 405 and recorded, so a write attempt fails loudly
   instead of silently succeeding.
2. **Mock lifecycle inside the app, mirroring the SSH mock.** Four debug-only commands start,
   re-scope, inspect and stop it: `test_netbox_server` (returns the base URL),
   `test_netbox_set_scenario`, `test_netbox_requests`, `test_stop_netbox_server`. The handle
   lives in `AppState` behind `#[cfg(debug_assertions)]`, and the commands are registered with
   matching attributes, so release builds contain neither the commands nor the mock.
3. **Token from an in-memory store, not the keychain.** CI has no OS keychain, and the keychain
   backend fails with an error rather than "no entry" there. While `COMND_TEST_MOCK_NETBOX_TOKEN`
   is set, debug builds serve the two NetBox keys — the API token and the default password that
   `netbox_save_config` always clears and `netbox_get_status` always reads — from a process-local
   store seeded with that environment token. The store honours saves and deletes exactly like the
   keychain, so the UI's Save Connection step still has to write the token the user typed: if it
   silently stopped writing, syncs would fall back to the seed's token and the request audit's
   `Token`-scheme assertion would fail. Host credential keys keep using the OS keychain — only the
   two NetBox keys are diverted. Release builds contain none of this.
4. **Isolation per scenario.** Each scenario gets a fresh `COMND_DATA_DIR` temp directory and a
   freshly launched app, so cache files and config never leak between scenarios. The temp
   directory and every process the runner owns are removed on success and after a forced
   failure.
5. **Request audit through the mock, not a proxy.** The mock records method, path and whether an
   `Authorization` header was present for every request. The value is never recorded, so no
   token reaches test output. The suite asserts every request was a GET to an expected endpoint,
   which is the read-only guarantee stated in `AGENTS.md`.

## What these tests do not prove

**HTTP-mock success is not proof of compatibility with any real NetBox version.** The mock
serves synthetic fixtures shaped like the NetBox REST API as this client reads it. It proves
that the app, the client and the fixtures agree with each other; it cannot prove that a real
NetBox 3.x or 4.x instance answers the same way, nor that the pinned API version behaves
identically. Compatibility with real NetBox remains a manual check against a real instance,
which this suite deliberately does not touch: no production NetBox access, no API writes.

## Files touched

- `src-tauri/src/netbox.rs`: mock moved to `mod mock` (recorder, scenario switch, synthetic
  fixtures incl. a device with no primary IP, an unmapped platform and a device missing every
  optional field); new unit test pinning the recorder and the scenarios, including the
  `second_page_error` scenario that fails page 2 so a mid-pagination error can be exercised.
- `src-tauri/src/credentials.rs`: debug-only `COMND_TEST_MOCK_NETBOX_TOKEN`-seeded in-memory
  store for the two NetBox keys, plus unit test.
- `src-tauri/src/state.rs`, `src-tauri/src/lib.rs`: mock handle and the four debug commands.
- `test/smoke/lib/harness.mjs`: helpers extracted from `run.mjs` (`runCase`, `invoke`,
  `buildApp`, `startDriver`, `waitForDriver`, `freePort`, `pause`, `withTimeout`, Xvfb
  bootstrap). `runCase` gained `env` and `teardown` hooks so each suite can own its teardown,
  and now records a failing suite teardown as a cleanup error: a scenario that passed, or failed
  on purpose, cannot report PASS while the mock or its temp directory was left behind.
- `test/smoke/netbox.mjs`: the NetBox scenarios.
- `package.json`: `smoke:netbox` script.
- `.github/workflows/ci.yml`: `smoke-netbox` job beside `smoke`.

## Named scenarios and assertions

Every scenario starts the mock through `test_netbox_server`, writes the URL into the settings
UI, and stops the mock in teardown.

| # | Scenario | Assertions |
|---|---|---|
| 1 | `configure-and-test` | Before the UI saves anything, `netbox_get_config` already reports `has_token: true`, proving the environment token seeded the debug store. URL and token are then typed into Settings; Test connection reports success; after Save Connection, `netbox_get_config` returns the entered URL and `has_token: true` (the token value itself is never asserted or printed); the probe the UI sent carried an `Authorization` header using the typed token's `Token` scheme, proving the form value reached the backend. |
| 2 | `sync-pagination` | Sync walks both API pages; tree shows hosts `netbox:101`, `netbox:102` under `__netbox__:region:emea` → `__netbox__:site:dc1` → `__netbox__:loc:rack-1`/`rack-2`, `netbox:103` under `__netbox__:site:dc2`, and `netbox:106` (no site) directly under `__netbox__`; persisted cache holds the same ids, addresses and folder ids; the report records five synced devices, one without a primary IP, one skipped platform (`juniper-junos`), and the success toast states both skip reasons. |
| 3 | `refresh-changes` | After switching to the `refresh` scenario, the renamed device shows its new name and address, the removed device is gone, no host id appears twice, and a locally added host is still present and unmodified. |
| 4 | `missing-fields` | Device with no primary IP is absent from the tree and counted in the report; device with an unmapped platform is skipped and named in the toast; device missing site, location, tags, status and description still lands, directly under `__netbox__`, with no error. |
| 5 | `error-paths` | The tree is expanded first and asserted to hold all four synced hosts, so the "unchanged" checks cannot pass vacuously. For each of 401, 403, 429 and 500: a message naming the problem appears, no success toast appears, the tree is unchanged, and the cache file is byte-identical to before the attempt. The 429 message names the retry delay on the sync path, where `Retry-After` is read; Test Connection does not read that header and says to wait and retry. A `second_page_error` case then fails page 2 after page 1 succeeded: the failure is reported, no success toast appears, the sync stops at the failed page (exactly two new requests, page 1 then page 2), and devices, tree and cache are unchanged. |
| 6 | `request-audit` | Every recorded request is a GET; the set covers the device list (both pages), the test-connection probe, regions, sites, locations, device roles and tags, and nothing outside it; per-endpoint counts match one probe plus one geo and one choices round per sync; every request carried an `Authorization` header, and all of them used the `Token` scheme of the legacy token saved through the UI — a save that stopped writing would fall back to the seeded `nbt_` token's `Bearer` scheme and fail here. |
| 7 | `cleanup-on-failure` | A deliberately failing scenario still stops the mock, removes the temp data dir and leaves no app or driver process behind; the failure message names the behaviour that broke. |

## Local command

`npm run smoke:netbox`: builds the debug app, starts Xvfb on Linux, launches the app once per
scenario with its own `COMND_DATA_DIR`, starts and stops the in-process mock through the debug
commands, and tears down every owned process on exit.

## CI placement

`smoke-netbox` job in `.github/workflows/ci.yml`, beside `smoke`, on ubuntu-22.04 with
`webkit2gtk-driver`, Xvfb and a cached `tauri-driver`, running `xvfb-run npm run smoke:netbox`.

## Verification gates

- `npm run build`
- `npm run test`
- `cargo check --all-targets` (in `src-tauri/`)
- `cargo test` (in `src-tauri/`)
- `npm run smoke`
- `npm run smoke:mutation`
- `npm run smoke:netbox`

On Windows the suite also needs `msedgedriver.exe` on `PATH`, at the version matching the
installed WebView2 runtime (see `AGENTS.md`). All seven scenarios pass locally on Windows; the
Linux CI run of the new job is the remaining gate.

## Open items

- Passing Linux CI run for the `smoke-netbox` job.
- Real-instance compatibility remains a manual check; see the caveat above.
