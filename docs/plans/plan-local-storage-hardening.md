# Plan: Local Storage Hardening (P0–P3)

Implementation plan for local storage security and reliability. Derived from
review of `src-tauri/src/hosts.rs`, `config.rs`, `ssh.rs`, `lib.rs`, frontend
`localStorage` usage in `src/lib/theme.ts`, `search-prefs.ts`, `timestamps.ts`,
and `src/components/nav-panel.ts`.

## Goals

| Priority | Item | Why |
|---|---|---|
| P0 | Ollama API key in OS keychain, not plaintext `config.json` | Secret on disk — same class of bug avoided for host passwords |
| P1 | Restrictive file perms on all persisted files | Multi-user hosts can read hostnames/usernames/host keys today |
| P1 | Atomic writes (tmp + rename) | Power loss / panic mid-write = empty JSON, silent data loss |
| P2 | Use Tauri `app_local_data_dir` instead of `dirs::data_dir` | Wrong dir on Windows (Roaming), wrong under sandboxed/Flatpak |
| P2 | Preserve corrupt file on parse error, don't auto-overwrite | Parse failure → empty default → save() destroys only copy |
| P3 | Single `paths.rs` for data dir resolution | 3 copies of `dirs::data_dir().join("netssh")` drift |
| P3 | Remove CWD fallback in `known_hosts_path` | Silently writes into process CWD if `dirs` returns None |
| P3 | Log file (`netssh.log`) path + perms | Added by plan-logging P3.2; now persists hostnames/usernames in plaintext append-only log, in `dirs::data_dir()` (Roaming on Windows), no rotation, no perms |

Non-goals: encrypting `hosts.json` at rest (keychain handles secrets; host
metadata is not secret enough to justify a key-management surface), migrating
to a SQLite/SQLCipher store (YAGNI until query needs exceed flat-file),
interoperating `known_hosts.json` with OpenSSH `~/.ssh/known_hosts` (separate
future task), frontend `localStorage` changes (already correct — UI prefs only,
no secrets).

## Dependencies on completed work

This plan assumes `plan-logging-improvements.md` is **fully implemented**
(P1.1, P1.2, P2.1–P2.3, P3.1, P3.2). That work introduced:

- **`AppConfig.log_level` field** (`config.rs:22`) + `save_log_level` +
  `get_log_level` / `set_log_level` Tauri commands + frontend `setLogLevel`.
  This is a new persisted field in `config.json` that P0.1's migration must
  explicitly preserve when rewriting the file to drop `ollama_api_key`.
- **`netssh.log` file** (`lib.rs:676`) — release-only, append-only, in
  `dirs::data_dir().join("netssh").join("logs")`, created with default perms
  via `OpenOptions`, no rotation. Captures SSH connect lines (hostname,
  username, port) and therefore needs the same path + perm treatment as the
  other persisted files. See new P3.3 below.
- **`simplelog` + `MultiWriter` logger init** (`lib.rs:660–691`) runs
  **before** Tauri `setup`, with no `AppHandle` available. P2.1's switch to
  `app_local_data_dir(app)` cannot apply here without restructuring init.
  See P2.1 "Log init ordering" note.

## Background — current state

Three backend stores each independently resolve the data dir:

```rust
// hosts.rs:69, config.rs:60, ssh.rs:29 (identical pattern)
let data_dir = dirs::data_dir()
    .ok_or_else(|| "Could not find app data directory".to_string())?
    .join("netssh");
```

`dirs::data_dir()` returns:
- **Windows**: `%APPDATA%` (Roaming) — syncs across domain-joined machines via
  AD profile replication. Host list + host keys shouldn't roam.
- **macOS**: `~/Library/Application Support` (correct, but not sandbox-aware —
  a signed/notarized MAS build needs the container path).
- **Linux**: `$XDG_DATA_HOME` or `~/.local/share` (correct, but Flatpak/snap
  sandboxes redirect differently and `dirs` ignores Tauri's bundle identifier
  `com.netssh.app`).

All writes use `std::fs::write` (truncate-then-write, non-atomic). No file in
`src-tauri` calls `set_permissions` (confirmed by grep). On parse error,
loaders return `Vec::new()` / `AppConfig::default()` and the next mutation
overwrites the bad file.

Frontend `localStorage` is out of scope — it only holds: `netssh-theme`,
`netssh-terminal-theme`, `netssh-timestamps`, `netssh-timestamps-format`,
`netssh-search-include-tags`, `netssh.nav.expandedGroups`. All UI prefs, no
secrets, no PII. Correct as-is.

## P0.1 — Move Ollama API key to keychain

### Backend

`config.rs`:
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    #[serde(default = "default_ollama_base_url")]
    pub ollama_base_url: String,
    #[serde(default = "default_ollama_model")]
    pub ollama_model: String,
    // REMOVED: ollama_api_key field
    #[serde(default = "default_ollama_context_length")]
    pub ollama_context_length: u32,
}
```

Drop `ollama_api_key` from the struct, `Default` impl, `default_ollama_api_key`,
and `test_default_config`. Add `Option<String>` back-compat: if a migrated
`config.json` still has the field, `serde` will warn and ignore it (no
`#[serde(default)]` needed for removed fields). Provide a one-time migration
in `ConfigStore::new` that reads the old field, moves it to keychain, and
rewrites `config.json` without it. Use `serde_json::Value` for the migration
peek so we don't need a second struct.

New `config.rs` helpers, mirroring `hosts.rs::save_credential`:
```rust
const OLLAMA_KEY_ENTRY: &str = "netssh_ollama_api_key";

pub fn save_ollama_api_key(key: Option<String>) -> Result<(), String> {
    match key {
        Some(k) if !k.is_empty() => keyring::Entry::new("netssh", OLLAMA_KEY_ENTRY)
            .and_then(|e| e.set_password(&k)).map_err(|e| e.to_string()),
        _ => keyring::Entry::new("netssh", OLLAMA_KEY_ENTRY)
            .and_then(|e| e.delete_credential())
            .or_else(|e| matches!(e, keyring::Error::NoEntry).then(|| Ok(())).unwrap_or(Err(e)))
            .map_err(|e| e.to_string()),
    }
}

pub fn get_ollama_api_key() -> Result<Option<String>, String> {
    match keyring::Entry::new("netssh", OLLAMA_KEY_ENTRY).and_then(|e| e.get_password()) {
        Ok(k) => Ok(Some(k)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}
```

`lib.rs` command `save_ollama_settings` (around line 320) — accept `api_key:
Option<String>` as today, but route it to `save_ollama_api_key` instead of
passing to `config_store.save_ollama_settings`. `get_ollama_settings` (line
443) — call `get_ollama_api_key()` and merge into the returned shape so the
frontend API is unchanged. `import.rs:156` reads
`config.ollama_api_key.clone()` — replace with `config::get_ollama_api_key()?`.

### Migration

In `ConfigStore::new`, before parsing into `AppConfig`, peek the raw JSON and
migrate `ollama_api_key` out. `log_level` and the other surviving fields are
parsed into `AppConfig` as before — the migration only **removes** the
`ollama_api_key` key from the object, then persists the struct normally on
the next `save_ollama_settings` / `save_log_level`. Do **not** rewrite the
file during migration; let the next legitimate `persist()` drop the field
naturally (the struct no longer has it, so `serde_json::to_string_pretty`
won't emit it). This avoids a second write path and preserves `log_level`
without special handling:

```rust
let raw = std::fs::read_to_string(&config_path).unwrap_or_default();
if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
    if let Some(key) = v.get("ollama_api_key").and_then(|k| k.as_str()) {
        if !key.is_empty() {
            // Only migrate if keychain doesn't already have a key — don't
            // clobber a newer key set via the settings UI on another machine.
            if get_ollama_api_key().ok().flatten().is_none() {
                let _ = save_ollama_api_key(Some(key.to_string()));
                log::info!("Migrated ollama_api_key from config.json to keychain");
            }
        }
    }
}
// Then proceed to parse into AppConfig as today. The next persist() drops
// the field from the file because AppConfig no longer has it.
```

Log, don't fail, on keychain error — user can re-enter the key in Settings.

### Tests

`config.rs` tests:
- `test_save_and_get_ollama_api_key` — round-trip through keyring (skip on CI
  where keychain is unavailable: `#[cfg(not(target_os = "linux"))]` or guard
  with a feature flag, match `hosts.rs` test convention).
- `test_default_config` — drop the `ollama_api_key` assertion (line 174),
  keep the new `log_level` assertion (line 176, added by plan-logging).
- `test_config_serialization_roundtrip` — already asserts `log_level` (added
  by plan-logging); no change needed beyond removing any `ollama_api_key`
  reference.
- `test_migrate_plaintext_key` — write a `config.json` with the old
  `ollama_api_key` field **and** a `log_level` field, construct
  `ConfigStore::new`, assert keychain has the key. Trigger a `persist()`
  (e.g. via `save_log_level` with the same level) and assert the rewritten
  file no longer has `ollama_api_key` but still has `log_level`.

### Frontend

No change — `kb-import-dialog` and settings screen already pass `api_key` as
`Option<String>` via Tauri IPC. The Rust signature stays the same; only the
storage backend changes.

## P1.1 — Restrictive file permissions

### Backend

New `src-tauri/src/paths.rs` (also hosts P3.1 below). Add a `secure_write`
helper:

```rust
use std::path::Path;

pub fn secure_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        ensure_data_dir(parent)?;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::write(path, bytes).map_err(|e| e.to_string())?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
        if let Some(parent) = path.parent() {
            // Best-effort — dir may already exist with correct perms
            let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
        }
    }

    #[cfg(windows)]
    {
        // %LOCALAPPDATA%\<bundle id> inherits user-only ACL from the user profile
        // by default. NTFS doesn't have a umask, so explicit ACL tightening is
        // only needed if the parent was created by another process. Tauri's
        // app_local_data_dir (P2.1) guarantees user-only inheritance.
        std::fs::write(path, bytes).map_err(|e| e.to_string())?;
    }

    Ok(())
}
```

Windows note: we rely on the parent dir's ACL being user-only (which P2.1
guarantees by using Tauri's scoped dir). Tightening the file ACL explicitly
requires the `windows-acl` or `windows` crate — YAGNI while the parent is
already locked down. Revisit if we ever write outside `app_local_data_dir`.

Replace `std::fs::write` in:
- `hosts.rs:144` (`HostStore::save`)
- `hosts.rs:233` (`HostGroupStore::save`)
- `config.rs:145` (`ConfigStore::persist` — note: shifted from line 120 after
  plan-logging added `save_log_level`)
- `ssh.rs:52` (`save_known_hosts`)
- `kb.rs:682`, `kb.rs:782`, `kb.rs:862` (user KB writes — these are YAML, not
  secrets, so use `atomic_write` without the chmod; low priority, can defer
  if it complicates the KB code paths)
- `lib.rs:676` (`netssh.log` open) — **see P3.3**; the log file is append-only
  and opened once at startup, so `secure_write` doesn't apply. Use
  `ensure_data_dir` + `set_permissions(0o600)` after `OpenOptions::open`
  instead.

`ensure_data_dir` (used above):
```rust
pub fn ensure_data_dir(dir: &Path) -> Result<(), String> {
    if !dir.exists() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
        }
    }
    Ok(())
}
```

### Tests

- `test_secure_write_sets_perms` (unix only) — write a file, assert
  `PermissionsExt::mode() & 0o077 == 0`.
- Windows: no unit test for ACL (would need `windows` crate); manual verify
  via `icacls` in the PR description.

## P1.2 — Atomic writes

### Backend

In `paths.rs`, extend `secure_write` to tmp-then-rename:

```rust
pub fn secure_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        ensure_data_dir(parent)?;
    }

    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, bytes).map_err(|e| format!("write tmp: {}", e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("chmod tmp: {}", e))?;
    }

    std::fs::rename(&tmp, path).map_err(|e| format!("rename: {}", e))?;

    #[cfg(unix)]
    if let Some(parent) = path.parent() {
        let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
    }
    Ok(())
}
```

`rename` is atomic on the same filesystem (POSIX guarantee; Windows NTFS is
atomic for same-volume renames). The tmp file is in the same dir, so same
volume is guaranteed. Set perms on the tmp file **before** rename so there's
no window where the final path is world-readable.

Update all call sites listed in P1.1 to call `paths::secure_write` instead of
`std::fs::write`. After this, `save()` / `persist()` / `save_known_hosts`
bodies shrink to:

```rust
fn save(&self) -> Result<(), String> {
    if let Some(ref path) = self.hosts_path {
        let json = serde_json::to_string_pretty(&self.hosts)
            .map_err(|e| format!("Failed to serialize hosts: {}", e))?;
        crate::paths::secure_write(path, json.as_bytes())?;
    }
    Ok(())
}
```

### Edge case — KB YAML writes

`kb.rs` writes YAML with `std::fs::write` in several places (lines 682, 782,
862). These are user-authored knowledge-base files, not secrets. Atomic
writes still help (don't want a half-written `interface.yaml` after a crash),
but applying `0o600` perms is wrong — the user may want to share their KB dir.
Add a separate `atomic_write(path, bytes)` in `paths.rs` that does tmp+rename
**without** the chmod, and use it for KB writes. `secure_write` becomes
`atomic_write` + chmod.

```rust
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    // tmp + rename, no perms change — for non-secret user files (KB YAML)
}

pub fn secure_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    // atomic_write + 0o600 on unix
}
```

### Tests

- `test_atomic_write_survives_concurrent_reader` — spawn a thread reading the
  file in a loop, write in another thread, assert the reader never sees a
  truncated/empty file.
- `test_atomic_write_cleans_tmp_on_failure` — mock a rename failure (write to
  a read-only dir), assert no `.tmp` file lingers. (Best-effort — hard to mock
  without injection. Skip if it requires heavy fixtures, just assert `.tmp`
  doesn't exist after a successful write.)

## P2.1 — Use Tauri `app_local_data_dir` instead of `dirs::data_dir`

### Backend

`paths.rs`:
```rust
use tauri::{AppHandle, Manager};

pub fn app_data_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path().app_local_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {}", e))
}
```

`app_local_data_dir` returns:
- **Windows**: `%LOCALAPPDATA%\com.netssh.app` (Local, not Roaming)
- **macOS**: `~/Library/Application Support/com.netssh.app` (sandbox-aware
  inside a MAS container)
- **Linux**: `$XDG_DATA_HOME/com.netssh.app` or `~/.local/share/com.netssh.app`

This honors the `identifier` in `tauri.conf.json` (`com.netssh.app`) and is
sandbox-safe. The `dirs` crate is still used by `ssh.rs:409` for
`dirs::home_dir()` (finding `~/.ssh/id_*` default keys) — that's correct and
stays.

### Migration

Existing users have data in `dirs::data_dir().join("netssh")`. On first launch
after this change, if the new dir is empty and the old dir exists and has
`hosts.json`, copy (not move — leave the old dir as a backup) the JSON files
to the new location. This is a one-shot migration in `lib.rs` `setup`:

```rust
let new_dir = paths::app_data_dir(app.handle())?;
if !new_dir.join("hosts.json").exists() {
    if let Some(old_dir) = dirs::data_dir().map(|d| d.join("netssh")) {
        if old_dir.join("hosts.json").exists() {
            log::info!("Migrating data dir {} -> {}", old_dir.display(), new_dir.display());
            for name in ["hosts.json", "groups.json", "config.json", "known_hosts.json"] {
                let src = old_dir.join(name);
                if src.exists() {
                    if let Err(e) = std::fs::copy(&src, new_dir.join(name)) {
                        log::warn!("Failed to migrate {}: {}", name, e);
                    }
                }
            }
            // Re-secure perms on the new copies (P1.1)
            // Leave old_dir in place — user can delete manually after confirming
        }
    }
}
```

Don't migrate `logs/netssh.log` — it's an append-only debug log, not user
data; the old one stays where it is and a new one starts in the new location
(or under `log_dir()` per the ordering note above). No data loss.

Keychain entries are keyed by `("netssh", host_id)` and don't move — no
credential migration needed.

### Call site changes

`HostStore::new`, `HostGroupStore::new`, `ConfigStore::new` currently take no
args and resolve the dir internally. Change them to accept a `&Path`:

```rust
impl HostStore {
    pub fn new(data_dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(data_dir)...;
        let hosts_path = data_dir.join("hosts.json");
        ...
    }
}
```

`lib.rs` `setup` resolves the dir once and passes it to all three constructors.
This removes the 3 duplicated `dirs::data_dir().join("netssh")` blocks and the
`ConfigStore::new_with_path` fallback (lib.rs:643–653) — `setup` already has
the `AppHandle`, so the fallback path can be the same `app_data_dir` call with
error handling in one place.

`ssh.rs` `known_hosts_path` (line 28) is called from free functions without an
`AppHandle`. Either:
- (a) Thread the `AppHandle` through `ClientHandler` (already has
  `app_handle: tauri::AppHandle` field, line 118) and resolve the path
  lazily in `check_server_key` / `save_known_hosts`. Preferred — the handler
  already owns the handle.
- (b) Keep `known_hosts_path` as a free function but have it take a `&Path`
  passed down from the handler.

Go with (a). `load_known_hosts` and `save_known_hosts` become methods on
`ClientHandler` or take `&AppHandle`. The CWD fallback (P3.2) disappears
because `app_data_dir` returns `Result`, not `Option`.

### Log init ordering (from plan-logging P3.2)

Logger init at `lib.rs:660` runs **before** `tauri::Builder::default().setup`,
so it has no `AppHandle` and cannot call `paths::app_data_dir(app)`. Three
options, ranked:

1. **Use `dirs::data_local_dir()` for the log path only** (`%LOCALAPPDATA%`
   on Windows, `~/.local/share` on Linux, `~/Library/Application Support` on
   macOS — same as `app_local_data_dir` resolves to, just without the
   bundle-id suffix). Add a dedicated `paths::log_dir()` free function:
   ```rust
   pub fn log_dir() -> Result<PathBuf, String> {
       // No AppHandle available at log-init time — use dirs, not Tauri.
       // Same parent as app_data_dir; the log file lives under <data>/netssh/logs.
       dirs::data_local_dir()
           .map(|d| d.join("netssh").join("logs"))
           .ok_or_else(|| "Could not resolve log dir".to_string())
   }
   ```
   Downside: log file path uses `netssh` not `com.netssh.app`, so it doesn't
   move when P2.1 migrates the data dir. Acceptable — logs are ephemeral and
   the old log file is harmless. If consistency matters, move logger init
   into `setup` (option 2).
2. **Move logger init into `setup`** — restructure so the `WriteLogger` is
   constructed after `app_data_dir` resolves. Cleaner but larger diff: the
   current init logs "netssh v{} starting" before `setup`, and several early
   operations between init and `setup` would lose their log lines. Probably
   not worth the churn just for a bundle-id suffix on the log path.
3. **Accept the mismatch** — log path uses `dirs::data_local_dir().join("netssh")`,
   data path uses Tauri's `app_local_data_dir()`. Two subdirs under the same
   parent. Harmless, document it.

Recommend option 1. Whatever is chosen, the log file itself still gets the
P3.3 perm treatment.

### Tests

- `test_host_store_with_explicit_dir` — already exists as `in_memory()`; add
  one that writes to a `tempfile::TempDir` and asserts the file lands at the
  expected path.
- Migration test — create old dir with a `hosts.json`, run the migration
  function, assert new dir has the file and old dir still has it.

## P2.2 — Preserve corrupt file on parse error

### Backend

`hosts.rs` `load_hosts_from_file` (line 152):
```rust
fn load_hosts_from_file(path: &PathBuf) -> Vec<Host> {
    match std::fs::read_to_string(path) {
        Ok(content) => match serde_json::from_str(&content) {
            Ok(hosts) => hosts,
            Err(e) => {
                log::error!("Failed to parse {}: {}. Preserving as .corrupt.", path.display(), e);
                preserve_corrupt(path);
                Vec::new()
            }
        },
        Err(_) => Vec::new(),
    }
}

fn preserve_corrupt(path: &Path) {
    let ts = chrono::Utc::now().format("%Y%m%dT%H%M%S");
    let backup = path.with_extension(format!("json.corrupt-{}", ts));
    if let Err(e) = std::fs::rename(path, &backup) {
        log::error!("Failed to rename corrupt {}: {}", path.display(), e);
        // Last resort: copy, then overwrite on next save
        let _ = std::fs::copy(path, &backup);
    }
}
```

Apply the same pattern to `load_groups_from_file` (hosts.rs:240) and
`load_config_from_file` (config.rs:128). The next `save()` writes a fresh
file to the original path — the corrupt copy is preserved alongside for
manual recovery.

`preserve_corrupt` lives in `paths.rs` so all three loaders share it.

### Frontend

Optional (P3): emit a Tauri event `storage-corrupt` with the file name so the
UI can show a one-time toast: "hosts.json was corrupt and has been backed up.
Your host list may be incomplete." Defer until we have a toast component —
log loudly for now.

### Tests

- `test_corrupt_file_preserved` — write garbage to a temp `hosts.json`,
  call `load_hosts_from_file`, assert the file was renamed to
  `*.corrupt-<ts>` and the function returned an empty vec.

## P3.1 — Consolidate path resolution in `paths.rs`

Single module owning all data-dir logic. Public surface:

```rust
pub fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String>;
pub fn log_dir() -> Result<PathBuf, String>;          // P3.3 — no AppHandle at log-init time
pub fn ensure_data_dir(dir: &Path) -> Result<(), String>;
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String>;
pub fn secure_write(path: &Path, bytes: &[u8]) -> Result<(), String>;
pub fn preserve_corrupt(path: &Path);
```

All other modules import from here. No `dirs::data_dir()` calls outside
`paths.rs` (except `ssh.rs` default-key lookup which uses `dirs::home_dir` —
that stays). `Cargo.toml` keeps `dirs` for `home_dir` and for `log_dir`'s
`data_local_dir`; if we later drop default-key discovery and move log init
into `setup`, `dirs` can be removed.

## P3.2 — Remove CWD fallback in `known_hosts_path`

Subsumed by P2.1 — `app_data_dir` returns `Result`, so the
`unwrap_or_else(|| PathBuf::from("."))` at `ssh.rs:30` is deleted. No write
ever lands in CWD.

## P3.3 — Log file (`netssh.log`) path + permissions

Added by `plan-logging-improvements.md` P3.2. The log file is created at
`lib.rs:676` via `OpenOptions::new().create(true).append(true).open()` with
default umask, in `dirs::data_dir().join("netssh").join("logs")` (Roaming on
Windows). It captures SSH connect lines including hostname, username, and
port (`ssh.rs:361` "SSH connected for {host_key}" where `host_key` is
`hostname:port`). This is host metadata, not credentials, but it's the same
class of "leakable to other users on a shared host" as `hosts.json`.

### Path

Per the P2.1 "Log init ordering" note, use `paths::log_dir()` (or
`app_data_dir` if logger init is moved into `setup`). The log file lives at
`<log_dir>/netssh.log`.

### Permissions

After `OpenOptions::open` succeeds, set restrictive perms on the file and
its parent dir:

```rust
// lib.rs — replace the current OpenOptions block (lines 676–685)
let log_path = paths::log_dir()?.join("netssh.log");
paths::ensure_data_dir(log_path.parent().unwrap())?;
let file = std::fs::OpenOptions::new()
    .create(true)
    .append(true)
    .open(&log_path)?;

// Restrict perms — log contains hostnames/usernames
#[cfg(unix)]
{
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&log_path, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| e.to_string())?;
    if let Some(parent) = log_path.parent() {
        let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
    }
}
// Windows: parent dir ACL is user-only if it's under app_local_data_dir;
// no explicit file ACL tightening needed (see P1.1 Windows note).
```

Append-only means `secure_write` (which does tmp+rename) doesn't apply — the
file is opened once and held open by `WriteLogger`. Just set perms once after
open.

### Custom log path (added by `plan-custom-log-location.md`)

The log path is now user-configurable (Settings → General → "Log file
location"). The perms treatment above applies to whichever path is used —
`open_log_file()` in `lib.rs` chmods the file to `0o600` and the parent dir to
`0o700` on unix regardless of location.

**Caveat:** custom paths outside the app data dir may inherit lax ACLs from
their parent dir. We chmod on unix, but on Windows a path on a shared drive
may expose hostnames/usernames to other users. Documented in the Settings
hint: "Custom locations may have different access permissions. Prefer the
default for privacy." We document the risk rather than block non-app-data-dir
paths (open question 3 in the custom-log-location plan).

### Rotation

Out of scope. The existing `ponytail:` comment at `lib.rs:670` names the
ceiling: `netssh.log` grows unbounded; upgrade path is
`simplelog::RollingFileAppender` or truncate at >10MB. This plan doesn't add
rotation, just perms. Rotation is a separate future task.

### Tests

- `test_log_dir_created_with_secure_perms` (unix) — call `log_dir()`, create
  the file, assert mode `0o600` on the file and `0o700` on the parent.
- Windows: manual `icacls` check in the PR description.

## Implementation order

1. **P0.1** (API key → keychain) — standalone, no deps on other tasks. Ship
   first, it's the only true secret-on-disk.
2. **P3.1 + P2.1** (paths.rs + Tauri dir) — do together; paths.rs is the
   natural home for `app_data_dir` and `log_dir`. Includes the one-shot
   migration.
3. **P1.1 + P1.2** (perms + atomic writes) — both live in `secure_write`, so
   implement in one pass. Update all call sites, including the log file
   open at `lib.rs:676` (P3.3 uses `ensure_data_dir` + chmod, not
   `secure_write`, but it belongs in the same pass since it's the same
   `paths.rs` API).
4. **P2.2** (corrupt-file preservation) — small, independent, last.

Each step compiles and passes `cargo check` + existing tests independently.
`npm run build` is unaffected (no frontend changes except optional toast in
P2.2, deferred).

## Verification

After each step:
- `cargo check` in `src-tauri/` — must exit 0.
- `cargo test` in `src-tauri/` — existing tests pass, new tests added per step.
- `npm run build` — runs `tsc`, must exit 0 (only needed if P2.2 toast is
  implemented, which is deferred).
- Manual: launch the app, confirm hosts/groups/config load from the new dir,
  confirm `ollama_api_key` round-trips through the settings screen, confirm
  a deliberately corrupted `hosts.json` produces a `.corrupt-<ts>` file and
  the app still launches with an empty list.

## Files touched

| File | Change |
|---|---|
| `src-tauri/src/paths.rs` | **New** — `app_data_dir`, `log_dir`, `ensure_data_dir`, `atomic_write`, `secure_write`, `preserve_corrupt` |
| `src-tauri/src/config.rs` | Drop `ollama_api_key` field; add keychain helpers; migration in `new`; use `secure_write`; `preserve_corrupt` in loader; accept `&Path` in `new`; preserve `log_level` field (added by plan-logging) |
| `src-tauri/src/hosts.rs` | `HostStore::new` / `HostGroupStore::new` accept `&Path`; use `secure_write`; `preserve_corrupt` in loaders |
| `src-tauri/src/ssh.rs` | `known_hosts_path` → `ClientHandler` method using `app_data_dir`; use `secure_write`; drop CWD fallback |
| `src-tauri/src/kb.rs` | Use `atomic_write` for user YAML writes (no chmod) |
| `src-tauri/src/lib.rs` | Resolve `app_data_dir` once in `setup`; pass to stores; one-shot migration; route `api_key` through keychain in `save_ollama_settings` / `get_ollama_settings`; replace log file open (line 676) with `paths::log_dir()` + `ensure_data_dir` + chmod (P3.3) |
| `src-tauri/src/import.rs` | Read API key via `config::get_ollama_api_key` instead of `config.ollama_api_key` |
| `src-tauri/Cargo.toml` | No new deps (`keyring`, `simplelog` already present); `dirs` stays for `home_dir` + `log_dir` |
| Frontend | No changes (P2.2 toast deferred) |

## Out of scope / future

- **Encrypt `hosts.json` at rest**: hostnames/usernames are metadata, not
  secrets. Encryption adds key-management surface (where do you store the key?
  keychain → same threat model as storing the data there). Defer until a
  compliance requirement forces it.
- **SQLite / SQLCipher**: flat JSON is fine at current scale (tens to low
  hundreds of hosts). Migrate when we need indexed queries, transactions, or
  per-host ACLs.
- **OpenSSH `known_hosts` interop**: write a second copy to
  `~/.ssh/known_hosts` so `ssh` / `ansible` share trust state. Separate task,
  needs a settings toggle (some users don't want netssh touching their SSH
  config).
- **Frontend `localStorage` → Tauri `store` plugin**: only matters if we open
  multiple webviews sharing prefs. YAGNI while single-window.
- **Log rotation**: `netssh.log` grows unbounded. The existing `ponytail:`
  comment at `lib.rs:670` names the ceiling. P3.3 only adds perms, not
  rotation. Upgrade path: `simplelog::RollingFileAppender` or truncate at
  >10MB. Separate task.
- **Windows ACL tightening**: rely on parent-dir inheritance from
  `app_local_data_dir`. If we ever write outside that dir, revisit with the
  `windows` crate.