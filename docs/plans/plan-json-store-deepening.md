# Plan: One Deep JSON Store — `load_json_or_preserve` + Hosts/Groups Merge

Candidate from the architecture review (September 2026). This plan is
self-contained; it does not depend on the review session.

## Problem

The backend has five hand-rolled copies of the same JSON-file store
pattern — load (parse → `preserve_corrupt` on failure → default) and
save (`to_string_pretty` → `secure_write`):

| Store | Load block | Save block |
|---|---|---|
| `HostStore` | hosts.rs:287–303 | hosts.rs:276–284 |
| `HostGroupStore` | hosts.rs:377–388 | hosts.rs:366–374 |
| `ConfigStore` | config.rs:410–419 | config.rs:371–377 |
| `NetBoxCacheStore` | netbox.rs:520–529 | netbox.rs:505–511 |
| `replay` (free fns) | replay.rs:38–50 | replay.rs:52–55 |

Two of them are mirror images of each other: `HostStore` and
`HostGroupStore` (hosts.rs:197–388) have byte-for-byte identical store
shapes (`new` → `in_memory` → `get_all` → create/update/delete → private
`save`), yet they live behind **two separate AppState locks**
(`state.rs:20–21`: `pub hosts: Mutex<HostStore>`, `pub groups:
Mutex<HostGroupStore>`). Consequences:

1. `delete_host_group` (hosts.rs:567–588) takes two locks sequentially to
   un-group hosts and delete the group — the operation is not atomic; a
   crash between the two leaves hosts pointing at a deleted group.
2. `save_host` / `save_host_group` lock order is manual discipline with
   no mechanical backstop (state.rs:6 documents the rule; nothing enforces
   it).
3. Every new store re-implements the corrupt-file policy, so it can
   drift (it already has: hosts/groups/netbox/config log + default
   silently; replay.rs:45 *errors* on corrupt instead of defaulting).

Deletion test: one generic loader/saver doesn't delete a store, it
deletes the **boilerplate seam** each store re-implements. Concentrates.

## Solution

Two changes, one plan:

- **A. `load_json_or_preserve<T>`** — one generic function in
  `paths/mod.rs` (the module that already owns `ensure_data_dir`,
  `secure_write`, `preserve_corrupt`). Each store's load block becomes
  one call.
- **B. Hosts + groups merge** — `HostStore` gains a groups side (one
  struct, two files), AppState drops the second Mutex, and the
  group-mutation handlers become single-lock.

Both keep every store's public interface unchanged where callers exist;
only the internals and the `AppState` field count change.

## A. `load_json_or_preserve`

New generic in `paths/mod.rs` (near `preserve_corrupt`, line ~124):

```rust
/// Load a JSON file into T. Missing file → default. Corrupt file →
/// preserved as `.corrupt-<ts>`, default returned (the store pattern
/// every data file already follows). Callers keep their log line by
/// passing the file name for the message.
pub fn load_json_or_preserve<T: serde::de::DeserializeOwned + Default>(
    path: &std::path::Path,
) -> T {
    match std::fs::read_to_string(path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_else(|e| {
            log::error!(
                "Failed to parse {}. Preserving as .corrupt: {}",
                path.display(), e
            );
            preserve_corrupt(path);
            T::default()
        }),
        Err(_) => T::default(),
    }
}
```

Migration, per store (each is one-line-loading, delete the local fn):

1. `load_hosts_from_file` (hosts.rs:287–303) — becomes
   `load_json_or_preserve::<Vec<Host>>(&path)` **plus** the existing
   `normalize_credential` map (hosts.rs:296–299). Keep the normalization
   in a small wrapper in hosts.rs; do not push `Host` knowledge into
   `paths`.
2. `load_groups_from_file` (hosts.rs:377–388) — one call, wrapper
   deleted.
3. `load_config_from_file` (config.rs:410–419) — one call, wrapper
   deleted. Note `ConfigStore::new` (config.rs:199) also calls
   `migrate_plaintext_api_key` before loading; keep that call order.
4. `load_cache_from_file` (netbox.rs:520–529) — one call, wrapper
   deleted.
5. `replay::load` (replay.rs:38–50) — **behavior change**: today it
   returns `Err("Corrupt replay.json")` to the command; after migration
   it defaults like every other store. Accept the change — it is the
   consistency this plan exists to create, and the `.corrupt` backup
   keeps the data recoverable. `replay::save` (replay.rs:52–55)
   collapses to
   `secure_write(&file_path()?, serde_json::to_string_pretty(cmds).map_err(|e| e.to_string())?.as_bytes())`
   or stays as-is; three lines are not worth a second generic. If a
   second save-shape appears later, extract then.
6. Keep the private `save(&self)` fns as they are — they are four lines
   each and their error strings name their file ("Failed to write hosts
   file"), which is worth keeping. **Do not build a save_json
   generic** — the load side is where the drift and duplication live.

Test (add to `paths` module tests, following the pattern of
`test_corrupt_file_preserved` in hosts.rs:680–700):

```rust
#[test]
fn test_load_json_or_preserve_defaults_on_missing_and_corrupt() {
    let dir = tempdir with uuid name;
    // missing → default
    assert_eq!(load_json_or_preserve::<Vec<String>>(&dir.join("nope.json")), Vec::new());
    // corrupt → preserved + default
    write dir.join("x.json") = "{not json";
    assert_eq!(load_json_or_preserve::<Vec<String>>(&dir.join("x.json")), Vec::new());
    assert a "x.json.corrupt-" entry exists;
    // clean roundtrip
    write dir.join("ok.json") = "[\"a\"]";
    assert_eq!(load_json_or_preserve::<Vec<String>>(&dir.join("ok.json")), vec!["a"]);
}
```

## B. Hosts + groups merge

Today: `HostStore { hosts_path, hosts }` + `HostGroupStore {
groups_path, groups }` behind two `Mutex`es. After: **one struct, two
files, one lock.**

```rust
pub struct HostStore {
    hosts_path: Option<PathBuf>,
    groups_path: Option<PathBuf>,
    hosts: Vec<Host>,
    groups: Vec<HostGroup>,
}
```

1. Move `HostGroupStore`'s methods into `HostStore` as `*_group` methods
   (rename `get_all` → `get_all_groups`, etc. — the current
   `HostGroupStore::get_all` and `HostStore::get_all` collide, so keep
   both names explicit). Port the bodies verbatim (they only touch
   `self.groups` + `self.groups_path`).
2. Delete the `HostGroupStore` struct. Update `state.rs:21` — remove
   `pub groups`, drop the `HostGroupStore` import. Update `lib.rs:346–350`
   — delete the `group_store` construction; `HostStore::new` loads both
   files. In-memory fallback (lib.rs:339–342) stays one call.
3. Update handlers in hosts.rs to single-lock:
   - `get_host_groups` (hosts.rs:477): `state.hosts.lock()` once, drop
     the `state.groups` scope.
   - `save_host_group` (hosts.rs:517), `move_host_group`
     (hosts.rs:554): one lock.
   - `delete_host_group` (hosts.rs:568–588): one lock; the un-group loop
     and the group delete are now atomic — that is the win. Keep the
     `platforms` lock **outside and before** the `hosts` lock
     (save_host at hosts.rs:427–428 already does this; mirror the order).
     Document with one comment: `// Lock order: platforms → hosts
     // (never nested the other way).`
4. `ssh_connect` (ssh.rs:945–947) uses `state.hosts` only — unaffected
   by the merge; verify with `cargo check`.
5. Move the group tests into the existing `mod tests` alongside host
   tests (they construct stores directly — change
   `HostGroupStore::in_memory()` construction sites to
   `HostStore::in_memory()`).

The two-lock choreography in `netbox_sync` / settings flows reads
`state.hosts` and `state.groups` via separate handlers (`get_hosts`,
`get_host_groups` — different commands, sequential locks); those keep
working unchanged because each handler takes one lock.

## Steps

1. A: add `load_json_or_preserve` + test to `paths/mod.rs`.
   `cargo check` + `cargo test` green (new test green, existing
   `test_corrupt_file_preserved` in hosts.rs still green).
2. A: migrate the five load sites (hosts ×2, config, netbox, replay).
   `cargo check` + `cargo test` green after each file.
3. B: merge `HostGroupStore` into `HostStore`; update `state.rs`,
   `lib.rs`, all `state.groups` handlers. `cargo check` + `cargo test`
   green.
4. Grep sweep: `state.groups` — zero references. `HostGroupStore` —
   zero references outside hosts.rs types (the `HostGroup` *type* stays;
   the *store* dies).

## Verification

- `cargo check` exits 0 (AGENTS.md requirement).
- `cargo test` exits 0 in `src-tauri/`.
- No frontend change — group commands (`get_host_groups`,
  `save_host_group`, `move_host_group`, `delete_host_group`) keep
  identical names, args, and payloads in `src/lib/tauri-api.ts`. If any
  file under `src/` was touched, `npm run build` must exit 0.
- **Manual regression** on a debug build: create a group, nest a group
  under it, drag hosts in, delete the parent group → children hosts
  survive with no group (the un-group loop), tree in the nav panel
  still renders, NetBox sync still materializes synthetic groups, and a
  corrupt-file restart (hand-edit `groups.json` to garbage) still
  preserves the file and boots with an empty group list.

## Deliberate non-goals

- No generic `JsonStore<T>` trait/object — the five stores differ in
  what they do with the data (validation, sort, NetBox merge); only the
  load/save *seams* concentrate, not the stores themselves.
- No save-side generic (load-side drift is the real duplication; save
  fns are four lines with useful per-file error strings).
- No migration of `known_hosts.json` (ssh.rs:31–53) or
  `session_log.rs` — different shapes (map load, streaming write), no
  drift, not the pattern.
- The 81× `lock().map_err(...)` std-Mutex idiom is a separate concern;
  not in this plan.