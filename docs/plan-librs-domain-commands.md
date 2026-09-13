# Plan: Split lib.rs — Domain-Owned Tauri Command Handlers

Candidate 3 from the architecture review (September 2026). This plan is
self-contained; it does not depend on the review session.

## Problem

`src-tauri/src/lib.rs` is a 1893-line god module: **68 of 71**
`#[tauri::command]` handlers live there, alongside `AppState` (9 Mutexes),
lock choreography, the log multi-writer, panic hook, and app bootstrap.
Only `replay.rs` owns its handlers (`replay::replay_list` etc. in the
`generate_handler!` list, lib.rs:1810–1812) — proving the pattern already
works in this codebase.

Consequences:

- **The handler layer is the untested layer.** Module tests are strong
  (kb 48, netbox 35, hosts 23, import 20, ssh 13, secrets 13, llm 11,
  config 9), but lib.rs has 5 tests, all on log-path helpers. Policy that
  lives only in handlers cannot be tested without the Tauri runtime.
- **Domain policy is embedded in handlers.** `ssh_connect`
  (lib.rs:418–549) contains ~70 lines of NetBox connection-parameter
  overlay policy (username/port/credential/secret-key precedence,
  lib.rs:441–492) that belongs to the netbox domain. Any change to NetBox
  sourcing requires editing lib.rs, and the policy is untestable in
  isolation.
- **Locality failure:** every domain change (a new kb command, a new
  netbox field) edits three places — the module, the lib.rs handler, and
  the `generate_handler!` list.

Deletion test: moving a handler out of lib.rs doesn't delete code, but it
deletes the *coupling* — the handler's dependency surface collapses to its
domain module's interface, and the handler becomes testable next to the
module it wraps. lib.rs shrinks to bootstrap + state wiring.

**Constraint:** the frontend is untouched. Handler names, argument
shapes, and error strings are the Tauri IPC contract — all 68 commands
keep their exact signatures. Only their Rust homes change.

## Solution

Follow the replay.rs pattern: each domain module gains a `commands.rs`
sibling (or an in-file `commands` submodule) holding its
`#[tauri::command]` handlers. `AppState` moves to a small shared
`state.rs`. lib.rs keeps bootstrap, logging setup, the panic hook, and the
`generate_handler!` list (which just gets longer module paths).

Target layout:

```
src-tauri/src/
  state.rs              # AppState struct + pub(crate) fields (new, ~30 lines)
  lib.rs                # bootstrap, logging, panic hook, generate_handler! (~350 lines)
  hosts/                # or hosts.rs + hosts_commands.rs — see step 1 note
    mod.rs              # today's hosts.rs, unchanged
    commands.rs         # host + group handlers (~180 lines)
  kb/ { mod.rs, commands.rs }
  ssh/ { mod.rs, commands.rs }
  netbox/ { mod.rs, commands.rs }
  config/ { mod.rs, commands.rs }     # get_app_config, log level/size, session log
  import.rs             # keeps commands inline (5 handlers, cohesive)
  secrets.rs            # provider + credential + agent handlers
  replay.rs             # unchanged — already the model
  paths/ { mod.rs, commands.rs }     # backup/restore/scan/apply/restart
  llm.rs                # test_llm_connection (single handler, in-file)
  platform.rs           # load_platform_index, list_kb_platforms
```

Module choice per domain is by handler count: kb (8 handlers) and netbox
(13) each justify a `commands.rs` sibling; single-handler modules keep the
command in-file. Convert `hosts.rs`, `kb.rs`, `netbox.rs`, `config.rs`,
`paths.rs` from files to directories only where a `commands.rs` sibling
exists; `use crate::hosts::HostStore` paths stay stable via re-exports in
`mod.rs` (`pub use`), so no call-site churn in other modules.

## 1. Extract the NetBox overlay policy first (the testable win)

The only *behavior-carrying* extraction. From `ssh_connect`
(lib.rs:418–549), move the parameter resolution into netbox.rs as a pure
function over data, not over Tauri state:

```rust
// src-tauri/src/netbox.rs
pub struct ConnectParams {
    pub hostname: String,
    pub port: u16,
    pub username: String,
    pub credential: Option<credentials::CredentialSource>,
    pub secret_key: String,
}

/// Overlay wins over source defaults (plan §6 precedence):
/// username: overlay → cfg.default_username, both must be non-empty;
/// port: overlay → cfg.default_port;
/// credential: overlay → cfg.default_credential (error when neither);
/// secret_key: per-device (overlay.credential set) → host_key, else DEFAULT_PW_KEY.
pub fn resolve_connect_params(device: &NetBoxHost, cfg: &NetBoxConfig,
                               host_id: &str) -> Result<ConnectParams, String>;
```

The `ssh_connect` handler then: finds the host (HostStore fast path) or the
NetBox device, calls `netbox::resolve_connect_params`, and proceeds.
Error strings are preserved verbatim (they are UI-facing IPC values).
Write unit tests for the precedence chain — both overlays set, overlay
empty vs whitespace, neither set (username and credential error cases),
per-device vs source-default secret key. These tests are the point of the
whole plan; they cannot exist today.

Keep the sequential-lock discipline: the handler drops each Mutex guard
before the next lock and before awaits (lib.rs:431–493 comments document
why). The extracted function takes cloned data, so it locks nothing.

## 2. Move handlers domain by domain

Order: netbox (largest, most handlers) → hosts → kb → config →
ssh → paths → secrets/import/llm/platform (small ones).

Per move:

1. Create the domain's `commands.rs` with the exact handler bodies,
   changing only `crate::AppState` paths to `crate::state::AppState` and
   imports (`use crate::hosts::{HostStore, Host}`).
2. Delete from lib.rs; add the module path to `generate_handler!`
   (`netbox_commands::netbox_sync` or `netbox::commands::netbox_sync` —
   match replay's `replay::replay_list` style).
3. `cargo check` + `cargo test` after every domain. All module test
   suites must stay green — handlers are moves, not rewrites.

`AppState` (lib.rs:141–159) moves to `state.rs` first, with fields
`pub(crate)`. The `#[cfg(test)]` helpers that construct stores for
handler-level tests (added in step 3) live in `state.rs` or each domain's
tests.

## 3. Handler-level tests (netbox only — the untested policy)

Add tests in `netbox/commands.rs` for what `ssh_connect` used to embed and
for guard rails that span modules:

- `resolve_connect_params` precedence chain (§1).
- The synthetic-group guard (`is_synthetic_group_id` rejections in
  save/delete/touch host handlers) — table-driven: each guarded handler
  returns the "managed by the NetBox integration" error for synthetic ids.

Do not attempt end-to-end handler tests through a Tauri mock. The
`#[tauri::command]` macro's `State<'_, AppState>` argument makes pure
handler invocation awkward; the policy extraction in §1 is what makes the
logic testable, and that is the seam worth keeping.

## 4. Non-goals / invariants

- **No IPC changes.** Every command keeps its name, params, return type,
  and error strings. `src/lib/tauri-api.ts` is untouched.
- **No store refactors.** `KbManager`, `HostStore`, `NetBoxCacheStore`
  keep their interfaces; the recent `52abb05` KbManager routing is
  preserved.
- **No async/lock discipline changes.** All moves preserve the
  std-Mutex-never-across-await rule documented at lib.rs:147–150.
- Out of scope (noted for a future plan, do not do): `save_kb_command`'s
  11 positional parameters; untyped `serde_json::Value` in
  `netbox_test_connection`/`get_app_config`; the stale free-function
  door in kb.rs (`save_kb_command` pub fns beside `KbManager` methods).

## 5. Steps

1. **`state.rs`**: move `AppState` + field visibility; re-point imports in
   lib.rs and replay.rs. `cargo check` + `cargo test`.
2. **netbox**: `resolve_connect_params` extraction + precedence tests
   (§1); move 13 netbox handlers to `netbox/commands.rs`; guard-rail tests
   (§3). Check + test after the extraction and after the moves.
3. **hosts**: host/group handlers to `hosts/commands.rs`. Check + test.
4. **kb**: 8 kb handlers to `kb/commands.rs`. Check + test.
5. **config**: config + logging handlers (log level, max size, session
   log, log status, log_frontend, llm settings). Check + test.
6. **ssh**: `ssh_connect`/`ssh_send`/`ssh_disconnect`/`ssh_resize` — now
   thin after §1. Check + test.
7. **paths + secrets + import + llm + platform**: backup/restore handlers
   to `paths/commands.rs`; provider/credential/agent handlers to
   `secrets.rs` (or `secrets/commands.rs` — the `secrets/` dir already
   exists, so a `commands.rs` submodule); import keeps its 5 handlers
   in-file. Check + test.
8. **lib.rs cleanup**: what remains is bootstrap, the log multi-writer,
   panic hook, `open_url_cmd` (generic — may stay), and
   `generate_handler!`. Final `cargo check` + full `cargo test`.
9. **Smoke test** the debug build: connect to the test server
   (`test_mock_server`), open the KB screen (list/save/delete a command),
   NetBox status page, backup scan, settings round-trip, replay list.
   The IPC contract must behave identically.

## Verification

- `cargo check` in `src-tauri/` exits 0 after every step.
- `cargo test` in `src-tauri/` exits 0; all existing module suites
  untouched and green; new netbox precedence/guard tests pass.
- `npm run build` exits 0 (no frontend change expected, run once at the
  end to prove the IPC surface is identical).
- Manual smoke list in step 9.

## Risk notes

- `generate_handler!` paths must match the moved handler's module path
  exactly or the build fails loudly — safe failure mode.
- The `#[cfg(debug_assertions)]` mock-server commands stay where they are.
- `mod test_server` visibility (`pub mod` under `cfg(debug_assertions)`,
  lib.rs:7–8) is unchanged.
- Windows paths in tests: keep the existing `#[cfg(windows)]`/
  `#[cfg(unix)]` pattern used by the log-path tests (lib.rs:1850–1859)
  when writing the new netbox tests — they run on all three platforms in
  CI.