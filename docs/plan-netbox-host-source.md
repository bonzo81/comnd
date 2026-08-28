# Plan: NetBox Host Source Integration

Status: implemented (all phases, 2026-08-28). Implementation notes: Phase 0
landed `credentials.rs` (keyring keys `host:<id>` with lazy bare-id fallback);
NetBox client/cache/mapping live in `netbox.rs`; IPC commands are the nine
`netbox_*` commands in `lib.rs`; frontend pieces are the Settings -> NetBox
section (`settings-screen.ts`), the nav tree integration + guards
(`nav-panel.ts`, `host-screen.ts`), and the Configure dialog
(`netbox-configure-dialog.ts`). Deviations from this doc: `netbox_save_config`
and `netbox_set_device_overlay` take an extra password argument (secret rides
the keyring, never config); `netbox_get_status` also reports `has_default_pw`;
`fetch_devices` returns a `FetchResult` struct (devices + no-primary-IP count).
Audience: implementation agents with no prior context. This document is
self-contained — read it fully before writing code. Obey `AGENTS.md` rules
throughout (no local echo changes, verification gates, serde_yml vs serde_yaml,
etc. — nothing in this plan touches those areas, but the general rules apply).

## 1. Goal

Add an **opt-in integration** that pulls network devices from a user's NetBox instance
(https://netbox.readthedocs.io — open-source network Source of Truth, DCIM/IPAM) and shows
them in the net.sh host list, alongside (never mixed into) manually-created hosts.

User-visible requirements:

- Opt-in: disabled entirely until the user enables it in Settings.
- NetBox devices appear under their **own top-level folder** in the nav host tree, with a
  NetBox icon. Sub-grouping: **site → location → devices** (NetBox `site` and `location`
  objects).
- Minimum device data: device name + device primary IP. Extra metadata is cached too
  (platform, tags, site, location) to power the tree and platform badges.
- User can **filter** which devices sync (by site, role, tag, status) and **toggle
  individual devices on/off** (per-device enable).
- **Local cached storage with explicit manual refresh.** The host list never blocks on or
  repeatedly hits the NetBox API. Cache loads instantly from disk; the API is only touched
  when the user clicks Refresh in Settings.
- Existing host authentication methods (password / SSH key / SSH agent / secret-manager
  reference) must all remain usable for NetBox-sourced hosts (see §6 credential overlay).
- Future: same feature for LibreNMS. The design introduces a generic "host source" concept
  so LibreNMS becomes a second instance of it, not a refactor (see §13).

## 2. Confirmed decisions (do not revisit)

| Question | Decision |
|---|---|
| Local storage | Separate cache file `netbox-cache.json` in the app data dir. `get_hosts` merges user hosts + NetBox hosts at read time. **The sync never writes to `hosts.json`.** Devices deleted in NetBox disappear locally on next sync. |
| Refresh policy | **Manual only.** Refresh button in the NetBox settings section. No background interval task, no polling, no refresh-on-launch. |
| Tree grouping | "NetBox" top-level folder → sub-group per NetBox **site** → sub-sub-group per NetBox **location** (location is nullable; devices with no location sit directly under their site group). |
| Credentials | Overlay model (§6): source-level defaults + optional per-device overrides, all four existing auth methods available. |
| Pre-work | A small credential-handling cleanup (Phase 0, §5) lands first. No larger auth refactor. |

## 3. Current architecture you must know (verified line anchors)

Line numbers verified at time of writing — re-locate by symbol name if the code has moved.

### Backend (`src-tauri/src/`)

- `lib.rs:133-146` — `AppState`: `kb`, `hosts: Mutex<HostStore>`, `groups:
  Mutex<HostGroupStore>`, `ssh: tokio::sync::Mutex<SshManager>`, `config: Mutex<ConfigStore>`,
  `providers: Mutex<secrets::ProviderRegistry>`, `log_status`. All std `Mutex` guards must
  NEVER be held across `.await` (documented at `lib.rs:139-141`; clone data out first).
- `lib.rs:1157-1165` — `setup`: stores constructed from `data_dir` (resolved via
  `paths::app_data_dir()` at `lib.rs:1012`), each with `in_memory()` fallback. New state
  fields are wired here.
- `lib.rs:1169-1218` — `tauri::generate_handler![...]` registration block. New commands
  append here.
- Host commands: `get_hosts` (lib.rs:186), `save_host` (194, create-if-empty-id else
  update), `delete_host` (207, also deletes keyring credential), `touch_host` (219),
  `save_credential`/`get_credential` (230/235).
- Group commands: `get_host_groups` (lib.rs:249), `save_host_group` (257), `move_host_group`
  (295), `delete_host_group` (315 — ungroups hosts first, see lib.rs:320-334).
- `ssh_connect` (lib.rs:338-417): clones the `Host` out of the store, enforces
  `max_sessions`, resolves credentials Rust-side (SecretRef special-cased at lib.rs:380-398
  through the provider registry because it is async; other variants via
  `Host::resolve_credentials`), then `ssh::SshSession::connect(...)`. The frontend passes
  only `hostId` — secrets never enter the webview. Keep that property.
- `hosts.rs` — `Host` struct (24-57: `id, display_name, hostname, port, username,
  credential, platform, os_version, highlight_profile, notes, last_connected, created_at,
  sort_order, tags, group_id`), `CredentialSource` enum (12-22: `Password | SshKey{key_path}
  | Agent{identity: Option<String>} | SecretRef{provider, reference, label}`),
  `AgentAuth` (167), `ResolvedCredentials` (177: `password/key_path/agent`),
  `Host::resolve_credentials` (198), `validate_host` (78), `VALID_PLATFORMS` (64:
  `cisco-iosxe, cisco-nxos, f5-tmos, linux-bash`). `HostStore` (249) = in-memory `Vec<Host>`
  + `hosts.json`, persisted whole-file via `paths::secure_write`. `load_hosts_from_file`
  (340) uses `paths::preserve_corrupt` on parse failure.
- `HostGroup` (hosts.rs:230-245): `id, name, parent_id (Option), sort_order, color, icon,
  created_at`. Groups nest via `parent_id`.
- `config.rs` — `AppConfig` with `providers: HashMap<String, serde_json::Value>` (35-36)
  used by the **secret-manager** provider system. Secrets live in the OS keychain, not
  config.json: `save_provider_secret(id, secret)` / `get_provider_secret(id)` (124/140) use
  keyring entry `netsh_provider_<id>`. `ConfigStore` methods `provider_config`,
  `provider_enabled`, `save_provider_config`, `clear_provider` (247-272) are the
  convention to copy for host sources.
- `secrets/mod.rs` — `SecretProvider` trait (`id/status/resolve/test_reference/list`),
  `ProviderRegistry::from_config` (75-101), rebuilt live in `save_provider_config`
  (lib.rs:665-678). This registry is for **secret resolvers** (e.g. Proton Pass). NetBox is
  a different concept — do NOT shoehorn it into this trait.
- `ollama.rs` — HTTP client pattern to copy for the NetBox client: struct holds
  `base_url`/`api_key`/`reqwest::Client`; builder with timeout (ollama.rs:113-133);
  per-request timeout override (267); friendly error mapping for connection-refused /
  timeout / non-2xx with JSON error body (213-253). Clients are constructed per call, not
  stored in AppState (lib.rs:811-816).
- `import.rs:257-279` — `validate_fetch_url`: SSRF guard that enforces HTTPS and **blocks
  private/loopback IPs**. ⚠ NetBox instances live on LANs — this validator would reject
  every real NetBox. Do NOT reuse it for NetBox. Scheme check only (http/https allowed).
- `test_server.rs` — mock **SSH** server only (`start_mock_server` binds `127.0.0.1:0`,
  returns port + JoinHandle; debug-gated). No HTTP mock exists yet; §10 defines one.
- `paths.rs` — data dir = `dirs::data_local_dir()/com.netsh.app` (Windows:
  `%LOCALAPPDATA%\com.netsh.app`). Helpers: `app_data_dir`, `ensure_data_dir` (0o700),
  `secure_write` (tmp + 0o600 + rename), `atomic_write` (non-secret),
  `preserve_corrupt` (rename to `.corrupt-<ts>`). Existing files: `hosts.json`,
  `groups.json`, `config.json`, `known_hosts.json`, `logs/`, user KB dir.
- `Cargo.toml` — reqwest 0.12 (features: json, default TLS = native-tls), tokio 1 (features:
  full), serde/serde_json, chrono, uuid, keyring 3, async-trait, log. **Zero new
  dependencies are required for this feature.**

### Frontend (`src/`)

- All IPC goes through typed wrappers in `src/lib/tauri-api.ts` (single source of truth).
  `Host` interface (16-32), `HostGroup` (34-42), `CredentialSource` type (10-14). Add new
  commands here.
- Nav host tree: `src/components/nav-panel.ts` — `renderGroupNode` (360-410) recurses
  `parent_id`; hosts render under their group; ungrouped hosts under pseudo-root
  `ALL_GROUP_ID = "__all__"` (`host-filters.ts:7`, render 329-343). Expand/collapse state
  persisted to localStorage (`netsh.nav.expandedGroups`, nav-panel.ts:74-108). Any root
  group auto-renders as a sibling under All Hosts — synthetic NetBox groups need **zero
  tree-render changes**.
- Search filter: `host-filters.ts:26-37` (`hostMatches` — substring across
  display_name/hostname/username/platform/notes/tags) + `visibleGroupIds`
  (nav-panel.ts:223-250). Works on merged hosts for free.
- Mutation entry points that must be guarded for NetBox hosts (see §8 guards):
  - host form save: `host-screen.ts:740-823` (`submitForm` → `saveHost`)
  - nav rename: `nav-panel.ts:574`
  - drag-drop group move: `nav-panel.ts:1158-1260` (writes `saveHost({...host, group_id})`)
  - duplicate: `host-screen.ts:825`, `nav-panel.ts:911`
  - delete (context menus): both files
- Host form: `host-screen.ts:232-391` (`renderForm`). No read-only/disabled support exists
  today — NetBox hosts get a dedicated slim "Configure" dialog instead (§9.4).
- Settings screen: `src/components/settings-screen.ts` — `render()` (82-100) dispatches on
  item id; nav items in `nav-panel.ts:42-48` (`SETTINGS_ITEMS`) + `LABELS` map
  (settings-screen.ts:27-33). Patterns to copy: Ollama section with URL/model/key form +
  **Test Connection** button + inline status (102-138, 506-537) and provider cards with
  enable checkbox + secret save + live status (PROVIDER_CATALOG 44-50, `renderAuth` 290,
  `renderProviderCard` 301). Provider status enum (`Ready/NotInstalled/AuthExpired/Error`)
  drives status lines.
- Connect flow: `TerminalView.connect(host)` (`terminal-view.ts:580-651`) →
  `sshConnect({ hostId, cols, rows, sessionId })` — **only hostId crosses IPC**; backend
  resolves everything. `touchHost(host.id)` on success (730). Global search
  (`global-search.ts:175-177`) and recent-sessions list (`host-screen.ts:188-192`, sorted
  by `recentHosts` host-filters.ts:40-49) both consume `getHosts()` — merged NetBox hosts
  appear there automatically.
- Toasts: `showToast(msg, "success"|"error"|"info", duration)` (`src/lib/toast.ts:28`).
- Icons: inline SVG set in `src/lib/icons.ts` (Lucide paths, 24×24, stroke=currentColor).
  Platform badges: `src/lib/platforms.ts` (badge/label/color maps; unknown platform falls
  back to `platform.toUpperCase().slice(0,4)`).

## 4. NetBox API facts (verified against NetBox docs, 2026)

- Endpoint: `GET {base_url}/api/dcim/devices/` (list devices).
- Auth: `Authorization` header. **v2 tokens** (start with `nbt_`): value
  `Bearer nbt_<key>.<plaintext>`. **v1 legacy tokens**: value `Token <plaintext>`.
  Implementation: if the stored token string starts with `nbt_`, send
  `Bearer <token>` verbatim; else send `Token <token>`. (Users paste the full value they
  copied from NetBox; both forms must work.)
- Pagination: offset-based by default. Response root: `{count, next, previous, results}`.
  Follow `next` until null. Default page 50; request `?limit=100` per page (max page is
  server-configured `MAX_PAGE_SIZE`, default 1000). Loop with a hard safety cap
  (e.g. 200 pages) to avoid infinite loops on a misbehaving server.
- Performance: always add `?exclude=config_context` (config contexts are huge and
  unneeded). Optional `brief` mode exists but omits `primary_ip` — do NOT use `brief`.
- Useful device-list query filters (exact-match on slug/id, repeatable):
  `site=<slug>`, `location=<slug>`, `role=<slug>`, `status=<slug>` (e.g. `active`),
  `tag=<slug>`, `platform=<slug>`, `region=<slug>`. Also `primary_ip4__isnull=false`
  (note: this one needs `has_primary_device` in newer NetBox — safest is to filter
  client-side, see below).
- Per-device fields to extract (see §4.1 for exact JSON shapes): `id` (int), `name`
  (**nullable** — see §4.1), `primary_ip4.address` / `primary_ip6.address` (strings
  **with CIDR mask suffix**, e.g. `"10.0.0.1/24"` — strip everything from the first `/`),
  `platform` (nested object, nullable → `.slug`), `site` (nested object → `.slug`),
  `location` (nested object, nullable → `.slug`), `tags` (array of nested objects →
  `.slug` each), `status` (choice object → `.value`), `description`.
- Devices with neither `primary_ip4` nor `primary_ip6` cannot be connected — skip them and
  report the count in the sync summary (do not silently drop).
- Error codes to map: 401 → invalid/expired token; 403 → token lacks permission;
  429 → rate limited (respect `Retry-After` if present); 5xx → server error.
  Connection-refused/timeout → instance unreachable.

### 4.1 Endpoint contract — device object shape (source-verified)

Verified against `netbox/dcim/api/serializers_/devices.py` (DeviceSerializer) in current
NetBox; NetBox 3.x and 4.x share this shape. Related objects use **nested brief
serializers** (`{id, url, display, name, slug, ...}`), never bare integers on read.

Shape we must parse (irrelevant fields omitted):

```json
{
  "id": 231,
  "url": "http://netbox/api/dcim/devices/231/",
  "display": "core-rtr-01",
  "name": "core-rtr-01",
  "description": "Core router",
  "status": { "value": "active", "label": "Active" },
  "site": { "id": 7, "url": "...", "display": "DC1", "name": "DC1", "slug": "dc1" },
  "location": { "id": 3, "url": "...", "display": "Rack row 1", "name": "Rack row 1", "slug": "rack-row-1" },
  "platform": { "id": 2, "url": "...", "display": "Cisco IOS", "name": "Cisco IOS", "slug": "cisco-ios" },
  "primary_ip4": { "id": 991, "url": "...", "family": 4, "address": "10.0.0.1/24" },
  "primary_ip6": null,
  "tags": [ { "id": 5, "url": "...", "display": "prod", "name": "prod", "slug": "prod", "color": "f44336" } ]
}
```

Parsing rules (each one exists because of a real serializer property):

1. **`name` is nullable.** NetBox permits unnamed devices. Fallback chain:
   `name` → `display` (always non-empty server-computed) → `"device-<id>"`. Never
   materialize an empty display_name.
2. **`platform` and `location` are nullable** (`allow_null=true` in the serializer) —
   model as `Option`. `site` is NOT nullable (every device has a site).
3. **`primary_ip4` / `primary_ip6` are nullable** nested objects; `.address` carries the
   CIDR suffix (`"10.0.0.1/24"`). Strip at first `/` → `address.split('/').next()`.
   Preference: `primary_ip4` first, `primary_ip6` fallback. Note `primary_ip` (the
   computed family-preferred field) also exists — do NOT use it; the explicit v4/v6 pair
   is deterministic.
4. **`status` is a choice object** `{value, label}`. NetBox ≥3.0 uses string values
   (`"active"`, `"offline"`, `"planned"`, `"staged"`, `"failed"`, `"decommissioning"`).
   Parse defensively: take `.value` if string, else `.label.to_lowercase()` (integer
   values existed in ancient 2.x). We filter server-side (`status=active` query param),
   so this field is display/reporting only.
5. **`tags` is an array of nested objects** (3.x+). Take `.slug` from each. (Ancient 2.x
   returned a plain string array — if an entry is a string instead of an object, use it
   verbatim. One `match` on untagged serde `Value` handles both.)
6. **Device names are NOT globally unique** (unique only per site in NetBox). Two sites
   can hold a device named `sw-01`. Our materialized host ids are `netbox:<netbox_id>`
   (globally unique PK) so no id collision; duplicate display names in the tree are
   acceptable and expected.

### 4.2 Endpoint contract — version detection for Test Connection

- Any API response carries the **`API-Version` HTTP response header** (this is how
  pynetbox detects versions — GET the API root and read the header; the header is present
  even on 403 responses, and as of NetBox 4.0 the root requires auth, so always send the
  token).
- `test_connection` therefore = one `GET /api/dcim/devices/?limit=1&exclude=config_context`
  → read `API-Version` header + `count` from the JSON body. No separate `/api/status/`
  call needed (`/api/status/` returns `netbox-version` in its body, but one request beats
  two).
- Optional response slimming exists via `?fields=id,name,...` (supports dotted paths like
  `site.slug`) — deliberately NOT used; `exclude=config_context` alone is the documented
  perf fix and a wider contract is more fragile across versions.

## 5. Phase 0 — credential resolution separation (pre-req, no behavior change)

Motivation: today resolution is split — `Host::resolve_credentials` (hosts.rs:198) handles
Password/SshKey/Agent, while `ssh_connect` special-cases SecretRef (lib.rs:380-398) because
it needs the async provider registry. Also, password keyring lookup is hard-wired to
`self.id` (hosts.rs:201), which breaks for source-level default passwords. NetBox needs
both seams fixed; do it once, before NetBox.

1. New module `src-tauri/src/credentials.rs`:
   - Move `CredentialSource`, `ResolvedCredentials`, `AgentAuth` there from `hosts.rs`
     (hosts.rs re-exports them so existing `use hosts::...` paths keep compiling; update
     imports opportunistically).
   - Single resolution function:
     ```rust
     pub async fn resolve(
         credential: &CredentialSource,
         secret_key: &str,            // keyring key, e.g. "host:<id>"
         registry: &secrets::ProviderRegistry,
     ) -> Result<ResolvedCredentials, String>
     ```
     Handles all four variants; SecretRef goes through `registry.get(provider)?.resolve(ref)`
     with the same friendly error as today (lib.rs:388-395 — reuse
     `secrets::resolve_error_message`).
   - Keyring lookup generalized: replace `get_credential(host_id)` /
     `save_credential(host_id, ...)` calls with key-based `get_secret(key)` /
     `save_secret(key, ...)`. Existing keyring entries are keyed by bare host id —
     on lookup, try `host:<id>` first, fall back to bare `<id>` (lazy migration; write back
     to the new key on next save). This avoids a one-time migration pass.
2. `ssh_connect` (lib.rs:338) calls `credentials::resolve(...)` — the lib.rs:380-398
   special case is deleted. Note `providers` registry must be cloned/locked **before**
   the await, per the std-Mutex rule.
3. Move affected unit tests (hosts.rs tests 534-567) to credentials.rs.
4. Gate: `cargo check` + `cargo test` green, `npm run build` green (frontend unaffected —
   serialized shapes unchanged).

Scope guard: do NOT relocate `AgentAuth` consumers in ssh.rs beyond the re-export, do NOT
touch frontend auth UI, do NOT build a resolver trait abstraction. Two warts fixed, that's
all.

## 6. Credential overlay model for NetBox hosts

NetBox supplies reachability (address) + identity (name), not SSH credentials. The user
must supply username + auth. Model:

- **Source-level defaults** (set in the NetBox settings section): `default_username`
  (optional), `default_port` (default 22), `default_credential` (optional, any of the four
  `CredentialSource` variants — rendered with the same radio UI as the host form).
- **Per-device overlay** (optional, via "Configure" on a NetBox host): `username`,
  `port`, `credential` — each individually `null` = inherit source default. Stored in the
  cache (§7), never in `hosts.json`.
- Resolution at connect time: `overlay.credential ?? source.default_credential` — then the
  Phase 0 `credentials::resolve` runs with keyring key `"host:netbox:<netbox_id>"` for
  per-device passwords, or `"source:netbox"` for the source default password. Agent and
  SSH-key and secret_ref variants need no secret lookup at all.
- A device with no resolvable username anywhere still appears in the list; connect fails
  with a clear toast: "No username configured for this device — set one via Configure."

This reuses the entire existing auth stack unchanged — the confirmed requirement.

## 7. Phase 1 — backend: NetBox client + cache (`src-tauri/src/netbox.rs`)

### 7.1 Client (copy ollama.rs structure)

```rust
pub struct NetBoxClient { base_url: String, token: String, http: reqwest::Client }
impl NetBoxClient {
    pub fn new(base_url: &str, token: &str) -> Self       // 30s timeout client
    pub async fn test_connection(&self) -> Result<(String /*version*/, u32 /*device count*/), String>
    pub async fn fetch_devices(&self, filters: &NetBoxFilters) -> Result<Vec<RawNetBoxDevice>, String>
}
```

- Request URL: `{base_url.trim_end_matches('/')}/api/dcim/devices/?limit=100&exclude=config_context`
  plus filter params (repeatable: `site=`, `role=`, `tag=`, `status=`). Auth header per §4.
  Follow `next` links; hard cap 200 pages → error "NetBox pagination did not terminate".
- `test_connection`: one `GET /api/dcim/devices/?limit=1&exclude=config_context` (§4.2)
  — return the `API-Version` response header string and `count` from the body.
  5s per-request timeout (ollama.rs:267 pattern).
- Error mapping per §4. Scheme validation only: reject `base_url` that is not `http://` or
  `https://`. NEVER apply `import.rs::validate_fetch_url` (blocks LAN IPs — §3 warning).
- `RawNetBoxDevice`: `{ netbox_id: u64, name: String /* §4.1 fallback chain */, address:
  String /*mask-stripped*/, platform_slug: Option<String>, site_slug: Option<String>,
  location_slug: Option<String>, tags: Vec<String> /*slugs*/, status: String,
  description: String }`. Deserialization goes through `serde_json::Value` + explicit
  extraction per §4.1 rules 1-5 (null name fallback, nested slugs, choice-object status,
  dual-shape tags) — do NOT derive a flat struct directly from the response. Devices with
  no primary IP (v4 or v6) are excluded from the list but counted → surfaced in the sync
  report.

### 7.2 Platform mapping

NetBox `platform.slug` → net.sh platform. Built-in table:

| NetBox platform slug | net.sh platform |
|---|---|
| `cisco-ios`, `ios`, `ios-xe`, `cisco-iosxe` | `cisco-iosxe` |
| `cisco-nx-os`, `nx-os`, `nxos` | `cisco-nxos` |
| `f5-tmos`, `tmos`, `big-ip` | `f5-tmos` |
| `linux`, `ubuntu`, `debian`, `centos`, `rhel` | `linux-bash` |

Configurable policy for unmatched slugs: `skip` (default — device not synced, reported) or
`fallback:<platform>` (treat as given platform). Plus an overrides map
`slug → platform` in the source config for site-specific platforms. This exists because
`VALID_PLATFORMS` (hosts.rs:64) rejects unknown platform strings at host save/validation —
materialized NetBox hosts must always carry one of the four known values.

### 7.3 Cache store

File: `<data_dir>/netbox-cache.json`, written with `paths::secure_write`, loaded with
`preserve_corrupt` fallback (mirror `load_hosts_from_file`, hosts.rs:340-355).

```json
{
  "version": 1,
  "last_synced": "2026-08-27T10:00:00Z",
  "sync_report": { "fetched": 420, "no_primary_ip": 12, "skipped_platform": 3, "unmatched_platforms": ["foo-os"] },
  "devices": [
    {
      "netbox_id": 123,
      "name": "core-rtr-01",
      "address": "10.0.0.1",
      "platform": "cisco-iosxe",
      "site": "dc1",
      "location": "rack-1",
      "tags": ["prod"],
      "status": "active",
      "enabled": true,
      "overlay": {
        "username": null, "port": null, "credential": null,
        "last_connected": null, "notes": null
      }
    }
  ]
}
```

Sync semantics: **full replace of the device array**, but `enabled` and `overlay` are
carried across syncs by matching `netbox_id`. Device gone from NetBox → gone locally
(overlay dropped with it; that is accepted).

`NetBoxCacheStore` (in netbox.rs): `Mutex`-wrapped in AppState (§8.1), methods
`load(data_dir)`, `get()`, `apply_sync(Vec<Device>)`, `set_enabled(netbox_id, bool)`,
`set_overlay(netbox_id, Overlay)`, `find_by_host_id("netbox:<id>")`, `touch(netbox_id)`.
All sync methods persist immediately (whole-file write, `secure_write`).

## 8. Phase 2 — backend: config, commands, merge, guards

### 8.1 Config + secrets

`config.rs` — new `AppConfig` field (serde default, backward compatible):

```rust
#[serde(default)]
pub host_sources: HashMap<String, serde_json::Value>,
```

Mirroring the `providers` convention: `ConfigStore::host_source_config(id)`,
`host_source_enabled(id)`, `save_host_source_config(id, value)`, `clear_host_source(id)`.
NetBox config JSON (key `"netbox"`):

```json
{
  "enabled": false,
  "base_url": "https://netbox.example.com",
  "filters": { "status": "active", "sites": [], "roles": [], "tags": [] },
  "platform_policy": "skip",
  "platform_fallback": null,
  "platform_overrides": {},
  "default_username": null,
  "default_port": 22,
  "default_credential": null
}
```

Secrets in OS keyring via the Phase 0 generalized helpers, under dedicated keys:
`netsh_source_netbox_token` (NetBox API token), `netsh_source_netbox_default_pw`
(source-default SSH password, only if `default_credential` is Password). Never in
config.json.

New AppState field: `netbox: Mutex<NetBoxCacheStore>` — constructed in `setup` like the
other stores, with an in-memory fallback on failure. Add `mod netbox;` + `mod credentials;`
to lib.rs.

### 8.2 IPC commands (register in generate_handler, lib.rs:1169-1218)

| Command | Signature (effect) |
|---|---|
| `netbox_get_config` | `() -> NetBoxConfig` (token/status summarized, never the secret itself — return `has_token: bool`) |
| `netbox_save_config` | `(config: NetBoxConfig) -> NetBoxConfig` |
| `netbox_save_token` | `(token: Option<String>) -> ()` (keyring) |
| `netbox_test_connection` | `(base_url, token) -> { version, device_count }` — does NOT save anything; allows test-before-save |
| `netbox_sync` | `() -> SyncReport` — reads config+token, fetches, applies to cache (§7.3), returns report |
| `netbox_get_devices` | `() -> Vec<NetBoxDeviceEntry>` (cache contents incl. enabled/overlay, for the settings device list) |
| `netbox_set_device_enabled` | `(netbox_id: u64, enabled: bool) -> ()` |
| `netbox_set_device_overlay` | `(netbox_id: u64, overlay: Overlay) -> ()` |
| `netbox_get_status` | `() -> { enabled, has_token, last_synced, device_count }` (for header line) |

All async, `Result<T, String>` per AGENTS.md. reqwest client constructed inside the
command (per-call, ollama pattern) — no client in AppState.

### 8.3 Merge points (the only existing commands that change)

- `get_hosts` (lib.rs:186): after user hosts, if NetBox enabled, materialize each
  **enabled** cached device into a `Host`:
  `id = "netbox:<netbox_id>"`, `display_name = name`, `hostname = address`,
  `port = overlay.port ?? source.default_port`, `username = overlay.username ??
  default_username` (may be empty string), `platform` = mapped platform,
  `os_version = None`, `notes = overlay.notes`, `last_connected = overlay.last_connected`,
  `group_id = "__netbox__"` (tree position handled by groups, §8.4), `tags` = NetBox tags,
  `credential = overlay.credential ?? default_credential`, and new field
  `source: Option<String>` (`Some("netbox")`; `#[serde(default)]` on `Host` so
  hosts.json round-trips unchanged).
- `get_host_groups` (lib.rs:249): after user groups, if enabled and cache non-empty, emit
  synthetic groups (stable ids, high `sort_order` so NetBox folder sorts last):
  - root `{ id: "__netbox__", name: "NetBox", parent_id: None, icon: Some("netbox") }`
  - per site `{ id: "__netbox__:site:<slug>", name: <slug>, parent_id: "__netbox__" }`
  - per location `{ id: "__netbox__:site:<s>:loc:<l>", name: <l>, parent_id: site-id }`
- `ssh_connect` (lib.rs:338): host lookup falls through — HostStore first (unchanged
  fast path), then NetBox cache for ids starting `netbox:`. For a NetBox host, resolve
  credential per §6 and call the same `SshSession::connect`. Note: materialized Host
  structs are NOT validated by `validate_host` (they bypass HostStore), which is fine —
  data comes from cache, already sanitized at sync time (address is mask-stripped;
  name/site/location validated as slug-safe: `[a-z0-9-]`).
- `touch_host` (lib.rs:219): if id starts `netbox:` → `cache.touch(netbox_id)` (writes
  overlay.last_connected) instead of HostStore touch.

### 8.4 Guards (authoritative, backend-side)

- `save_host` (lib.rs:194): reject with `"Cannot edit NetBox-sourced hosts"` when
  `host.source == Some("netbox")` **or** `host.id.starts_with("netbox:")`.
- `delete_host` (lib.rs:207): same rejection — disabling/removing NetBox devices happens
  via `netbox_set_device_enabled` / re-sync, never via host delete.
- `save_host_group` / `move_host_group` / `delete_host_group`: reject ids starting with
  `__netbox__` (synthetic, not user-editable).
- The frontend also guards (better UX, §9) but the backend rejection is the contract —
  the frontend can be bypassed.

## 9. Phases 3-4 — frontend

### 9.1 `src/lib/tauri-api.ts`

Types: `NetBoxConfig`, `NetBoxFilters`, `SyncReport`, `NetBoxDeviceEntry`,
`DeviceOverlay`, `NetBoxStatus`. Extend `Host` with `source?: string | null`. Thin invoke
wrappers for all nine commands (camelCase args; file is the single IPC source of truth).

### 9.2 Settings — new "NetBox" section (`settings-screen.ts` + `nav-panel.ts`)

- Add to `SETTINGS_ITEMS` (nav-panel.ts:42-48) and `LABELS` (27-33): id `netbox`, label
  "NetBox" under Settings (below "Auth Integrations").
- Section layout (copy Ollama card + provider card patterns, settings-screen.ts:102-138 +
  301):
  1. Enable toggle (disabled → everything below dimmed/hidden).
  2. Instance URL field + API token field (masked; blank = unchanged, `netbox_save_token`).
  3. **Test Connection** button → inline status line (version + device count or error).
  4. Sync filters: status (text, default `active`), sites / roles / tags (comma-separated
     slug lists → arrays).
  5. Platform policy: select `skip` / fallback platform + optional overrides editor
     (simple `slug=platform` rows are fine).
  6. Source default auth: username, port, auth radios identical to host form
     (password / key / agent / secret_ref with conditional fields) — reuses the host form
     auth markup pattern (host-screen.ts:286-330).
  7. **Refresh Now** button → `netbox_sync` → toast with sync report summary
     ("Synced 420 devices · 12 without primary IP · 3 skipped (unknown platform foo-os)").
  8. Status line: last synced timestamp (relative, `src/lib/timestamps.ts`) + device count.
  9. Device list: search box + rows (name, address, site/location, platform badge,
     enable checkbox → `netbox_set_device_enabled`). This is the per-device toggle UI.

### 9.3 Nav tree (`nav-panel.ts`)

- Synthetic groups render via existing recursion — no renderer change. Group icon: the
  tree currently shows no icons on groups; render the NetBox mark on the `__netbox__` root
  row (small inline SVG before the label) — follow existing row markup
  (`renderGroupNode`, nav-panel.ts:360-410).
- Add `netbox` icon to `src/lib/icons.ts`: NetBox logo mark (half-filled cube), inline
  SVG, 24×24 viewBox, `stroke="currentColor"` to match the set. Monochrome — it inherits
  theme color like every other icon.
- Guards (frontend mirrors §8.4, each with a toast "NetBox hosts are managed by the NetBox
  integration — use Configure"): rename (nav-panel.ts:574), drag-drop move (1158-1260),
  duplicate (host-screen.ts:825, nav-panel.ts:911), delete entries in both context menus,
  host form open (host-screen.ts renderForm path).
- NetBox host context menu: **Configure** (opens overlay dialog §9.4), **Disable**
  (netbox_set_device_enabled false + refresh). NetBox folder context menu: **Refresh**
  (netbox_sync + refresh) — convenience shortcut.
- `isNetboxHost(host)` helper (`host.source === "netbox"` or id prefix) — put in
  `host-filters.ts` next to `ALL_GROUP_ID`.

### 9.4 Configure overlay dialog (`host-screen.ts` or a small new component)

Modal reusing `.modal-backdrop` pattern. Fields: username, port, auth radios (all four
methods, same markup as host form auth section), notes. Empty = inherit source defaults
(helper text says so). Saves via `netbox_set_device_overlay`. Read-only summary line at
top: name, address, site/location, platform badge (data from the host entry).

### 9.5 Unchanged-by-design

Recent sessions list, global search, connect flow, tabs — all consume merged `getHosts()`
output and need no changes. Do not add special cases there.

## 10. Testing

- **Rust unit tests** (in-file `#[cfg(test)]` per house style):
  - Hand-rolled mock HTTP server for NetBox: `tokio::spawn` + `TcpListener` on
    `127.0.0.1:0`,     respond with canned paginated JSON (mirror `start_mock_server` shape,
    test_server.rs:129-160). Cover: pagination follow via `next`, termination, v1 `Token`
    and v2 `Bearer` header forms, 401 mapping, CIDR mask strip, no-primary-IP skip count,
    **device-object parsing per §4.1** (null `name` → `display` fallback, null
    `platform`/`location`, nested `tags[].slug` and string-tag tolerance, choice-object
    `status` with string and non-string values), **`API-Version` header read for
    test_connection**, platform mapping table + skip/fallback/override policy, sync
    full-replace preserves `enabled`/`overlay` by netbox_id, cache roundtrip +
    `preserve_corrupt` path.
  - Phase 0: move + extend credential resolution tests (all four variants; keyring-fallback
    key lookup uses a single `keyring::Entry` roundtrip like existing tests, config.rs:397).
  - Guards: save_host/delete_host reject `netbox:` ids and `source == "netbox"`.
- **Frontend**: strict `tsc` via `npm run build` exit 0. No frontend test framework exists
  beyond `suggestion-engine.test.ts` (node-based) — do not invent one for this.
- **Manual smoke** (dev build against a real or dockerized NetBox, or the mock server):
  enable → test connection → sync → tree shows NetBox > site > location > devices → connect
  with source-default password → per-device overlay username/key → disable device →
  re-sync keeps toggles.

## 11. What NOT to do (hard rules)

- Never write NetBox data into `hosts.json` — merge at read time only.
- Never reuse `import.rs::validate_fetch_url` for NetBox URLs (it blocks LAN IPs).
- Never store the NetBox API token or any password in `config.json` — keyring only
  (`netsh_source_netbox_token`, `netsh_source_netbox_default_pw`).
- Never add a background interval/polling task — refresh is manual-only (decision §2).
- Never allow save/delete/duplicate/rename/group-move of NetBox hosts (§8.4 guards).
- No new Cargo or npm dependencies.
- Do not extend the `SecretProvider` trait with NetBox — host sources are a separate
  concept sharing only conventions.
- No LLM in any of this — deterministic code paths only (AGENTS.md).

## 12. Verification gates (per AGENTS.md)

Every phase lands with: `cargo check` **and** `cargo test` in `src-tauri/` exit 0;
`npm run build` exit 0. Phase 0 additionally: full manual connect smoke with an existing
password host + agent host (regression on the moved resolution path).

## 13. Future: LibreNMS (out of scope — design hook only)

The `host_sources` config map is keyed by source id; LibreNMS becomes
`host_sources["librenms"]` with its own module (`librenms.rs`) implementing the same
shape: config + keyring secret (`netsh_source_librenms_token`) + cache
(`librenms-cache.json`) + materialization + guards. LibreNMS API differences for whoever
implements it: base endpoint `/api/v0/devices`, auth header `X-Auth-Token: <token>`,
pagination via `?limit=&offset=` JSON array responses (no `next` link — iterate offset
until short page). Device fields: `sysName`/`hostname`, `ip` (no CIDR suffix),
`hardware`, `os` (e.g. `ios`, `linux`) — needs its own platform mapping table. Do not
build any of this now; just do not hard-code anything that assumes "netbox" is the only
source (the `source` field, `__netbox__` id scheme, and per-source keyring prefix are all
parameterizable by design).

## 14. Suggested implementation order (each phase independently verifiable)

1. Phase 0 — `credentials.rs` extraction + generalized keyring keys (§5).
2. Phase 1 — `netbox.rs` client + cache + platform mapping + mock-server tests (§7, §10).
3. Phase 2 — config/host_sources wiring, keyring secrets, 9 IPC commands, merge in
   `get_hosts`/`get_host_groups`, `ssh_connect`/`touch_host` fallthrough, guards (§8).
4. Phase 3 — settings section: config form, test connection, filters, default auth,
   refresh, device list with toggles (§9.1-9.2).
5. Phase 4 — tree integration: icon, synthetic folder rendering, frontend guards,
   configure dialog, context menus (§9.3-9.4).
6. Phase 5 — docs: `04-connection-manager.md` gets a "Host Sources (NetBox)" section;
   `08-future-open-questions.md` decision log entries (host_sources map chosen; separate
   cache + merge chosen; manual refresh chosen; LibreNMS deferred).
