# Stage 04 — Host Storage (Rust)

**Goal:** Implement persistent host storage (JSON file in app data dir) and credential management (OS keychain), exposed via Tauri commands. The frontend can CRUD hosts and retrieve saved credentials.

**Spec refs:** `docs/04-connection-manager.md` (host fields), `docs/02-technical-architecture.md` (data storage, security)

---

## Why This Stage

The Connection Manager UI (Stage 05) needs a backend to store and retrieve hosts. Host storage is simple and isolated — it doesn't depend on SSH or KB. Building it now unblocks the entire connection-manager frontend.

---

## Steps

### 1. Define the `Host` struct

Create `src-tauri/src/hosts.rs` with:

```
Host {
    id: String,              // UUID, generated on create
    display_name: String,
    hostname: String,        // hostname or IP
    port: u16,               // default 22
    username: String,
    auth_type: AuthType,     // enum: Password, SshKey
    ssh_key_path: Option<String>,  // only for SshKey auth
    platform: String,        // e.g. "cisco-iosxe"
    os_version: Option<String>,
    notes: Option<String>,
    last_connected: Option<String>,  // ISO 8601 timestamp
    created_at: String,
    sort_order: u32,         // for drag-to-reorder
}

AuthType enum: Password, SshKey
```

- Derive `Serialize`, `Deserialize`, `Clone`, `Debug`
- The struct must match what the frontend needs to render the host list

### 2. Implement JSON file storage

- Use `dirs::data_dir()` to get the platform-appropriate app data directory
- Store hosts in `{data_dir}/netssh/hosts.json`
- Create the directory if it doesn't exist
- Functions: `load_hosts() -> Vec<Host>`, `save_hosts(hosts: &[Host])`, `get_hosts_path() -> PathBuf`
- Handle missing file gracefully (return empty vec)
- Handle corrupt/invalid JSON gracefully (log error, return empty vec, don't crash)

### 3. Implement CRUD operations

- `create_host(host: Host) -> Result<Host, String>` — assigns UUID, sets `created_at`, appends to file
- `update_host(host: Host) -> Result<Host, String>` — replaces host by `id`
- `delete_host(id: String) -> Result<(), String>` — removes host by `id`
- `get_all_hosts() -> Result<Vec<Host>, String>` — returns all hosts sorted by `sort_order`
- `reorder_hosts(ids: Vec<String>) -> Result<(), String>` — updates `sort_order` based on new ID order

### 4. Implement credential management

Add credential functions using the `keyring` crate (add to `Cargo.toml`):

- `save_credential(host_id: &str, password: &str) -> Result<(), String>` — stores in OS keychain with service name `netssh` and user `host_id`
- `get_credential(host_id: &str) -> Result<Option<String>, String>` — retrieves from OS keychain
- `delete_credential(host_id: &str) -> Result<(), String>` — removes from OS keychain
- Passwords are NEVER stored in the JSON file — only in the OS keychain
- Handle keychain errors gracefully (e.g. user denies access on macOS)

### 5. Wire up Tauri commands

In `src-tauri/src/lib.rs`, replace stubs and add new commands:

- `get_hosts` → calls `get_all_hosts()`
- `save_host` → calls `create_host()` or `update_host()` depending on whether `id` is provided
- `delete_host(id: String)` → calls `delete_host()` + `delete_credential()`
- `save_credential(host_id: String, password: String)` → stores in keychain
- `get_credential(host_id: String)` → retrieves from keychain
- `reorder_hosts(ids: Vec<String>)` → updates sort order

### 6. Update `src/lib/tauri-api.ts`

Add typed frontend wrappers for all new commands:

- `getHosts(): Promise<Host[]>`
- `saveHost(host: Host): Promise<Host>`
- `deleteHost(id: string): Promise<void>`
- `saveCredential(hostId: string, password: string): Promise<void>`
- `getCredential(hostId: string): Promise<string | null>`
- `reorderHosts(ids: string[]): Promise<void>`
- Define the `Host` TypeScript interface matching the Rust struct
- Define the `AuthType` union type: `'password' | 'ssh_key'`

### 7. Write Rust tests

- Test create → read → update → delete lifecycle
- Test reorder
- Test loading from missing file returns empty vec
- Test loading from corrupt JSON doesn't crash
- Credential tests may need to be `#[ignore]` on CI (keychain requires OS session)

---

## Files Modified

| File | Changes |
|------|---------|
| `src-tauri/src/lib.rs` | Replace host stubs, add credential commands, register new commands |
| `src-tauri/Cargo.toml` | Add `keyring` crate, `uuid` crate |
| `src/lib/tauri-api.ts` | Add host + credential typed wrappers |

## Files Created

| File | Purpose |
|------|---------|
| `src-tauri/src/hosts.rs` | Host struct, JSON storage, CRUD, credential management |

---

## Verification

1. `cargo test` — host storage unit tests pass
2. `cargo tauri dev` → DevTools console:
   - Call `saveHost({ display_name: "Lab Router", hostname: "192.168.1.1", ... })` — returns host with generated UUID
   - Call `getHosts()` — returns array containing the saved host
   - Call `saveCredential(hostId, "mypassword")` — succeeds
   - Call `getCredential(hostId)` — returns `"mypassword"`
   - Call `deleteHost(hostId)` — succeeds
   - Call `getHosts()` — returns empty array
3. Check filesystem: `%APPDATA%/netssh/hosts.json` (Windows) or `~/.local/share/netssh/hosts.json` (Linux) or `~/Library/Application Support/netssh/hosts.json` (macOS) exists and contains valid JSON
4. Verify passwords are NOT in the JSON file
5. Verify OS keychain has the credential (Windows Credential Manager / macOS Keychain / Linux Secret Service)

---

## Definition of Done

Hosts persist across app restarts via JSON file. Passwords are stored exclusively in the OS keychain. All CRUD operations work via Tauri IPC. Frontend has typed wrappers for all host management commands.
