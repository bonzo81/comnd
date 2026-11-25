//! Host storage — JSON file in app data dir + OS keychain for credentials.
//! Host groups — separate JSON file, hierarchical (parent_id for nesting).

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

// Credential types live in credentials.rs (Phase 0 of the host-source
// plan); re-exported here so existing `hosts::...` paths keep compiling.
pub use crate::credentials::{AgentAuth, CredentialSource};
use crate::platform::PlatformRegistry;
use crate::state::AppState;

// Tauri command handlers (plan: lib.rs domain split) reference the NetBox
// source and credential stores.
use crate::{credentials, netbox};

// ─── Host Types ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Host {
    #[serde(default)]
    pub id: String,
    pub display_name: String,
    pub hostname: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub username: String,
    #[serde(default = "default_auth_type", skip_serializing)]
    pub auth_type: String, // legacy — read-compat only; use `credential`
    #[serde(default, skip_serializing)]
    pub ssh_key_path: Option<String>, // legacy — read-compat only; use `credential`
    #[serde(default)]
    pub credential: Option<CredentialSource>,
    #[serde(default = "default_platform")]
    pub platform: String,
    pub os_version: Option<String>,
    /// Syntax highlighting profile for terminal output. `"auto"` (default)
    /// uses the host's platform. Other values force a specific rule set.
    /// `None` is treated as `"auto"` for legacy hosts.
    #[serde(default)]
    pub highlight_profile: Option<String>,
    pub notes: Option<String>,
    pub last_connected: Option<String>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub sort_order: u32,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub group_id: Option<String>,
    /// Host source integration that materialized this host (e.g. "netbox").
    /// `None` = user-created. NetBox hosts are guarded against save/delete.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

fn default_port() -> u16 {
    22
}
fn default_auth_type() -> String {
    "password".to_string()
}
fn default_platform() -> String {
    "cisco-iosxe".to_string()
}

// ─── Validation ─────────────────────────────────────────────────────

/// Field length caps — generous enough for real-world values, tight enough
/// to prevent log pollution and UI rendering issues.
const MAX_DISPLAY_NAME: usize = 128;
const MAX_HOSTNAME: usize = 253; // RFC 1123 max DNS name
const MAX_USERNAME: usize = 128;
const MAX_NOTES: usize = 4096;
const MAX_OS_VERSION: usize = 64;

/// Validate a host's user-editable fields before persisting. Returns a
/// human-readable error string on the first violation.
pub fn validate_host(host: &Host, platforms: &PlatformRegistry) -> Result<(), String> {
    if host.display_name.trim().is_empty() {
        return Err("Display name is required".to_string());
    }
    if host.display_name.len() > MAX_DISPLAY_NAME {
        return Err(format!(
            "Display name is too long (max {} chars)",
            MAX_DISPLAY_NAME
        ));
    }
    if host.display_name.chars().any(|c| c.is_control()) {
        return Err("Display name contains control characters".to_string());
    }

    if host.hostname.trim().is_empty() {
        return Err("Hostname is required".to_string());
    }
    if host.hostname.len() > MAX_HOSTNAME {
        return Err(format!("Hostname is too long (max {} chars)", MAX_HOSTNAME));
    }
    validate_hostname(&host.hostname)?;

    if host.username.trim().is_empty() {
        return Err("Username is required".to_string());
    }
    if host.username.len() > MAX_USERNAME {
        return Err(format!("Username is too long (max {} chars)", MAX_USERNAME));
    }
    if host.username.chars().any(|c| c.is_control()) {
        return Err("Username contains control characters".to_string());
    }

    if !platforms.is_valid(&host.platform) {
        return Err(format!(
            "Platform '{}' is not valid (must be one of: {})",
            host.platform,
            platforms.all().join(", ")
        ));
    }

    if let Some(ref ver) = host.os_version {
        if ver.len() > MAX_OS_VERSION {
            return Err(format!(
                "OS version is too long (max {} chars)",
                MAX_OS_VERSION
            ));
        }
        if ver.chars().any(|c| c.is_control()) {
            return Err("OS version contains control characters".to_string());
        }
    }

    if let Some(ref notes) = host.notes {
        if notes.len() > MAX_NOTES {
            return Err(format!("Notes are too long (max {} chars)", MAX_NOTES));
        }
        if notes
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\r' && c != '\t')
        {
            return Err("Notes contain invalid control characters".to_string());
        }
    }

    Ok(())
}

/// Validate a hostname per RFC 1123 (relaxed): allows letters, digits,
/// hyphens, dots, and bracketed IPv6 addresses. Rejects whitespace,
/// newlines, and other control characters.
fn validate_hostname(hostname: &str) -> Result<(), String> {
    // Allow bracketed IPv6 addresses: [::1]
    let h = if hostname.starts_with('[') && hostname.ends_with(']') {
        &hostname[1..hostname.len() - 1]
    } else {
        hostname
    };

    // Reject if any char is not a letter, digit, hyphen, dot, or colon (IPv6)
    for c in h.chars() {
        if !(c.is_ascii_alphanumeric() || c == '-' || c == '.' || c == ':') {
            return Err(format!(
                "Hostname contains invalid character '{}'. Only letters, digits, hyphens, dots, and colons (IPv6) are allowed.",
                c
            ));
        }
    }

    // Reject leading/trailing hyphens or dots
    if h.starts_with('-') || h.ends_with('-') {
        return Err("Hostname must not start or end with a hyphen".to_string());
    }

    Ok(())
}

impl Host {
    /// Fill `credential` from legacy `auth_type`/`ssh_key_path` when absent.
    /// Called on every path where a Host enters the store (file load, IPC create/update).
    pub fn normalize_credential(&mut self) {
        if self.credential.is_none() {
            self.credential = Some(match self.auth_type.as_str() {
                "ssh_key" => CredentialSource::SshKey {
                    key_path: self.ssh_key_path.clone().unwrap_or_default(),
                },
                _ => CredentialSource::Password,
            });
        }
    }
}

// ─── Host Group Types ────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostGroup {
    #[serde(default)]
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub sort_order: u32,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub created_at: String,
}

// ─── Host Store ─────────────────────────────────────────────────────

pub struct HostStore {
    hosts_path: Option<PathBuf>,
    groups_path: Option<PathBuf>,
    hosts: Vec<Host>,
    groups: Vec<HostGroup>,
}

impl HostStore {
    /// Create a new HostStore backed by a JSON file in `data_dir`.
    pub fn new(data_dir: &std::path::Path) -> Result<Self, String> {
        crate::paths::ensure_data_dir(data_dir)
            .map_err(|e| format!("Failed to create data dir: {}", e))?;

        let hosts_path = data_dir.join("hosts.json");
        let groups_path = data_dir.join("groups.json");

        Ok(HostStore {
            hosts: load_hosts_from_file(&hosts_path),
            groups: load_groups_from_file(&groups_path),
            hosts_path: Some(hosts_path),
            groups_path: Some(groups_path),
        })
    }

    /// Create an in-memory-only store (fallback if filesystem fails).
    pub fn in_memory() -> Self {
        HostStore {
            hosts_path: None,
            groups_path: None,
            hosts: Vec::new(),
            groups: Vec::new(),
        }
    }

    /// Get all hosts sorted by sort_order.
    pub fn get_all(&self) -> Result<Vec<Host>, String> {
        let mut sorted = self.hosts.clone();
        sorted.sort_by_key(|h| h.sort_order);
        Ok(sorted)
    }

    /// Create a new host with generated UUID and timestamp.
    pub fn create(&mut self, mut host: Host, platforms: &PlatformRegistry) -> Result<Host, String> {
        validate_host(&host, platforms)?;
        host.normalize_credential();
        host.id = uuid::Uuid::new_v4().to_string();
        host.created_at = chrono::Utc::now().to_rfc3339();
        host.sort_order = self.hosts.len() as u32;
        log::info!(
            "Host created: '{}' ({}:{})",
            host.display_name,
            host.hostname,
            host.port
        );
        self.hosts.push(host.clone());
        self.save()?;
        Ok(host)
    }

    /// Update an existing host by id.
    pub fn update(&mut self, mut host: Host, platforms: &PlatformRegistry) -> Result<Host, String> {
        validate_host(&host, platforms)?;
        host.normalize_credential();
        let pos = self
            .hosts
            .iter()
            .position(|h| h.id == host.id)
            .ok_or_else(|| format!("Host not found: {}", host.id))?;
        self.hosts[pos] = host.clone();
        self.save()?;
        Ok(host)
    }

    /// Delete a host by id.
    pub fn delete(&mut self, id: &str) -> Result<(), String> {
        let pos = self
            .hosts
            .iter()
            .position(|h| h.id == id)
            .ok_or_else(|| format!("Host not found: {}", id))?;
        log::info!("Host deleted: '{}' ({})", self.hosts[pos].display_name, id);
        self.hosts.remove(pos);
        self.save()?;
        Ok(())
    }

    /// Update last_connected timestamp for a host.
    pub fn touch(&mut self, id: &str) -> Result<(), String> {
        if let Some(host) = self.hosts.iter_mut().find(|h| h.id == id) {
            host.last_connected = Some(chrono::Utc::now().to_rfc3339());
            self.save()?;
        }
        Ok(())
    }

    /// Persist both hosts and groups to disk. One lock covers both, so a
    /// crash can't leave them out of sync (e.g. dangling `group_id` refs).
    fn save(&self) -> Result<(), String> {
        if let Some(ref path) = self.hosts_path {
            let json = serde_json::to_string_pretty(&self.hosts)
                .map_err(|e| format!("Failed to serialize hosts: {}", e))?;
            crate::paths::secure_write(path, json.as_bytes())
                .map_err(|e| format!("Failed to write hosts file: {}", e))?;
        }
        if let Some(ref path) = self.groups_path {
            let json = serde_json::to_string_pretty(&self.groups)
                .map_err(|e| format!("Failed to serialize groups: {}", e))?;
            crate::paths::secure_write(path, json.as_bytes())
                .map_err(|e| format!("Failed to write groups file: {}", e))?;
        }
        Ok(())
    }

    // ─── Host groups (merged from HostGroupStore) ───────────────────

    /// Get all groups sorted by sort_order.
    pub fn get_groups(&self) -> Result<Vec<HostGroup>, String> {
        let mut sorted = self.groups.clone();
        sorted.sort_by_key(|g| g.sort_order);
        Ok(sorted)
    }

    pub fn create_group(&mut self, mut group: HostGroup) -> Result<HostGroup, String> {
        group.id = uuid::Uuid::new_v4().to_string();
        group.created_at = chrono::Utc::now().to_rfc3339();
        group.sort_order = self.groups.len() as u32;
        log::info!("Host group created: '{}'", group.name);
        self.groups.push(group.clone());
        self.save()?;
        Ok(group)
    }

    pub fn update_group(&mut self, group: HostGroup) -> Result<HostGroup, String> {
        let pos = self
            .groups
            .iter()
            .position(|g| g.id == group.id)
            .ok_or_else(|| format!("Host group not found: {}", group.id))?;
        self.groups[pos] = group.clone();
        self.save()?;
        Ok(group)
    }

    pub fn delete_group(&mut self, id: &str) -> Result<(), String> {
        let pos = self
            .groups
            .iter()
            .position(|g| g.id == id)
            .ok_or_else(|| format!("Host group not found: {}", id))?;
        log::info!("Host group deleted: '{}' ({})", self.groups[pos].name, id);
        self.groups.remove(pos);
        self.save()?;
        Ok(())
    }
}

/// Load hosts from JSON file, returning empty vec on any error.
fn load_hosts_from_file(path: &Path) -> Vec<Host> {
    let mut hosts = crate::paths::load_json_or_preserve::<Vec<Host>>(path);
    for h in &mut hosts {
        h.normalize_credential();
    }
    hosts
}

fn load_groups_from_file(path: &Path) -> Vec<HostGroup> {
    crate::paths::load_json_or_preserve::<Vec<HostGroup>>(path)
}

// ─── Tauri Commands (host + group, plan: lib.rs domain split) ───────

/// Lock order: hosts (released) → config (released) → netbox. The NetBox
/// merge is read-time only — never written to hosts.json.
fn get_hosts_impl(state: &AppState) -> Result<Vec<Host>, String> {
    let mut all = {
        let hosts = state.hosts.lock().map_err(|e| e.to_string())?;
        hosts.get_all()?
    };

    // NetBox merge (plan §8.3): read-time only — never written to hosts.json.
    let (enabled, netbox_cfg) = {
        let config = state.config.lock().map_err(|e| e.to_string())?;
        (
            config.host_source_enabled("netbox"),
            netbox::NetBoxConfig::from_json(config.host_source_config("netbox")),
        )
    };
    if enabled {
        let netbox = state.netbox.lock().map_err(|e| e.to_string())?;
        for device in netbox.get().devices.iter().filter(|d| d.enabled) {
            all.push(netbox::materialize_host(device, &netbox_cfg));
        }
    }
    Ok(all)
}

#[tauri::command]
pub async fn get_hosts(state: tauri::State<'_, AppState>) -> Result<Vec<Host>, String> {
    get_hosts_impl(&state)
}

/// Guard first (no lock), then lock order: platforms → hosts.
fn save_host_impl(state: &AppState, host: Host) -> Result<Host, String> {
    if host.source.as_deref() == Some("netbox") || netbox::is_netbox_host_id(&host.id) {
        log::warn!(
            "Rejected save_host on NetBox-sourced host {} (plan §8.4 guard)",
            host.id
        );
        return Err("Cannot edit NetBox-sourced hosts".to_string());
    }
    let platforms = state.platforms.lock().map_err(|e| e.to_string())?;
    let mut hosts = state.hosts.lock().map_err(|e| e.to_string())?;
    if host.id.is_empty() {
        hosts.create(host, &platforms)
    } else {
        hosts.update(host, &platforms)
    }
}

#[tauri::command]
pub async fn save_host(host: Host, state: tauri::State<'_, AppState>) -> Result<Host, String> {
    save_host_impl(&state, host)
}

/// Guard first (no lock), then the hosts lock; the keyring delete last.
fn delete_host_impl(state: &AppState, id: String) -> Result<(), String> {
    if netbox::is_netbox_host_id(&id) {
        log::warn!(
            "Rejected delete_host on NetBox-sourced host {} (plan §8.4 guard)",
            id
        );
        return Err(
            "Cannot delete NetBox-sourced hosts — disable the device in Settings → NetBox or remove it in NetBox"
                .to_string(),
        );
    }
    let mut hosts = state.hosts.lock().map_err(|e| e.to_string())?;
    hosts.delete(&id)?;
    // Also delete credential (new key + legacy bare-id entry)
    credentials::delete_secret(&credentials::host_key(&id)).ok();
    Ok(())
}

#[tauri::command]
pub async fn delete_host(id: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    delete_host_impl(&state, id)
}

/// NetBox ids take the netbox lock; user ids take the hosts lock. The two are
/// never held together.
fn touch_host_impl(state: &AppState, id: String) -> Result<(), String> {
    if netbox::is_netbox_host_id(&id) {
        let netbox_id: u64 = id
            .strip_prefix("netbox:")
            .and_then(|s| s.parse().ok())
            .ok_or_else(|| format!("Host not found: {}", id))?;
        let mut netbox = state.netbox.lock().map_err(|e| e.to_string())?;
        return netbox.touch(netbox_id);
    }
    let mut hosts = state.hosts.lock().map_err(|e| e.to_string())?;
    hosts.touch(&id)
}

#[tauri::command]
pub async fn touch_host(id: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    touch_host_impl(&state, id)
}

/// Lock order: hosts (released) → config (released) → netbox. Synthetic groups
/// are emitted only when enabled and at least one device is cached.
fn get_host_groups_impl(state: &AppState) -> Result<Vec<HostGroup>, String> {
    let mut groups = {
        let hosts = state.hosts.lock().map_err(|e| e.to_string())?;
        hosts.get_groups()?
    };

    // Synthetic NetBox groups (plan §8.3) — emitted only when enabled and
    // at least one enabled device is cached.
    let (enabled, netbox_config) = {
        let config = state.config.lock().map_err(|e| e.to_string())?;
        (
            config.host_source_enabled("netbox"),
            netbox::NetBoxConfig::from_json(config.host_source_config("netbox")),
        )
    };
    if enabled {
        let netbox = state.netbox.lock().map_err(|e| e.to_string())?;
        groups.extend(netbox::synthetic_groups(
            &netbox.get().devices,
            &netbox.get().geo,
            netbox_config.show_empty_folders,
        ));
    }
    Ok(groups)
}

#[tauri::command]
pub async fn get_host_groups(state: tauri::State<'_, AppState>) -> Result<Vec<HostGroup>, String> {
    get_host_groups_impl(&state)
}

/// NetBox-owned groups (plan §8.4): mutation handlers reject synthetic ids
/// before touching the store. Pure so the guard logic is testable without
/// `State<'_, AppState>`.
fn reject_synthetic_group(handler: &str, id: &str) -> Result<(), String> {
    if netbox::is_synthetic_group_id(id) {
        log::warn!(
            "Rejected {} on synthetic NetBox group {} (plan §8.4 guard)",
            handler,
            id
        );
        return Err("NetBox groups are managed by the NetBox integration".to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn save_host_group(
    id: Option<String>,
    name: String,
    parent_id: Option<String>,
    color: Option<String>,
    icon: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<HostGroup, String> {
    if let Some(ref group_id) = id {
        reject_synthetic_group("save_host_group", group_id)?;
    }
    let mut hosts = state.hosts.lock().map_err(|e| e.to_string())?;

    if let Some(group_id) = id {
        // Update existing
        let existing = hosts
            .get_groups()?
            .into_iter()
            .find(|g| g.id == group_id)
            .ok_or_else(|| format!("Group not found: {}", group_id))?;
        hosts.update_group(HostGroup {
            id: group_id,
            name,
            parent_id,
            sort_order: existing.sort_order,
            color,
            icon,
            created_at: existing.created_at,
        })
    } else {
        // Create new
        hosts.create_group(HostGroup {
            id: String::new(),
            name,
            parent_id,
            sort_order: 0,
            color,
            icon,
            created_at: String::new(),
        })
    }
}

/// Guard first (no lock), then the hosts lock alone.
fn move_host_group_impl(
    state: &AppState,
    id: String,
    new_parent: Option<String>,
    sort_order: u32,
) -> Result<HostGroup, String> {
    reject_synthetic_group("move_host_group", &id)?;
    let mut hosts = state.hosts.lock().map_err(|e| e.to_string())?;
    let existing = hosts
        .get_groups()?
        .into_iter()
        .find(|g| g.id == id)
        .ok_or_else(|| format!("Group not found: {}", id))?;
    hosts.update_group(HostGroup {
        parent_id: new_parent,
        sort_order,
        ..existing
    })
}

#[tauri::command]
pub async fn move_host_group(
    id: String,
    new_parent: Option<String>,
    sort_order: u32,
    state: tauri::State<'_, AppState>,
) -> Result<HostGroup, String> {
    move_host_group_impl(&state, id, new_parent, sort_order)
}

/// Guard first (no lock), then lock order: platforms → hosts (never nested the
/// other way).
fn delete_host_group_impl(state: &AppState, id: String) -> Result<(), String> {
    reject_synthetic_group("delete_host_group", &id)?;
    let platforms = state.platforms.lock().map_err(|e| e.to_string())?;
    let mut hosts = state.hosts.lock().map_err(|e| e.to_string())?;
    // Ungroup any hosts in this group, then delete it. One lock covers both
    // files, so a crash can't leave dangling `group_id` refs.
    for host in hosts.get_all()? {
        if host.group_id.as_deref() == Some(&id) {
            let mut updated = host.clone();
            updated.group_id = None;
            let _ = hosts.update(updated, &platforms);
        }
    }
    hosts.delete_group(&id)
}

#[tauri::command]
pub async fn delete_host_group(
    id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    delete_host_group_impl(&state, id)
}

// ─── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    use crate::fixtures::{mk_group, mk_host, TempDir};

    #[test]
    fn test_create_and_get_hosts() {
        let mut store = HostStore::in_memory();
        let host = mk_host("Test Router", "192.168.1.1");

        let created = store.create(host, &PlatformRegistry::builtin()).unwrap();
        assert!(!created.id.is_empty());
        assert!(!created.created_at.is_empty());

        let all = store.get_all().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].display_name, "Test Router");
    }

    #[test]
    fn test_update_host() {
        let mut store = HostStore::in_memory();
        let host = mk_host("Router A", "10.0.0.1");

        let created = store.create(host, &PlatformRegistry::builtin()).unwrap();
        let mut updated = created.clone();
        updated.display_name = "Router B".to_string();

        let result = store.update(updated, &PlatformRegistry::builtin()).unwrap();
        assert_eq!(result.display_name, "Router B");
    }

    #[test]
    fn test_delete_host() {
        let mut store = HostStore::in_memory();
        let host = mk_host("Delete Me", "10.0.0.2");

        let created = store.create(host, &PlatformRegistry::builtin()).unwrap();
        store.delete(&created.id).unwrap();
        let all = store.get_all().unwrap();
        assert!(all.is_empty());
    }

    #[test]
    fn test_legacy_hosts_synthesize_credential() {
        let json = r#"[{"id":"h1","display_name":"R1","hostname":"10.0.0.1","port":22,"username":"admin","auth_type":"password","ssh_key_path":null,"platform":"cisco-iosxe"},
                       {"id":"h2","display_name":"R2","hostname":"10.0.0.2","port":22,"username":"admin","auth_type":"ssh_key","ssh_key_path":"~/.ssh/id_rsa","platform":"cisco-iosxe"}]"#;
        let mut hosts: Vec<Host> = serde_json::from_str(json).unwrap();
        hosts.iter_mut().for_each(|h| h.normalize_credential());
        assert_eq!(hosts.remove(0).credential, Some(CredentialSource::Password));
        assert_eq!(
            hosts.remove(0).credential,
            Some(CredentialSource::SshKey {
                key_path: "~/.ssh/id_rsa".to_string()
            })
        );
    }

    #[test]
    fn test_roundtrip_serializes_credential_only() {
        let mut host = mk_host("R1", "10.0.0.1");
        host.normalize_credential();
        let json = serde_json::to_string(&host).unwrap();
        assert!(
            json.contains("\"credential\""),
            "credential must serialize: {}",
            json
        );
        assert!(
            !json.contains("auth_type"),
            "legacy field must not serialize: {}",
            json
        );
        assert!(
            !json.contains("ssh_key_path"),
            "legacy field must not serialize: {}",
            json
        );
        // Reload roundtrip keeps the variant
        let reloaded: Host = serde_json::from_str(&json).unwrap();
        assert_eq!(reloaded.credential, Some(CredentialSource::Password));
    }

    #[test]
    fn test_corrupt_file_preserved() {
        let dir = TempDir::new("hosts-corrupt");
        let path = dir.join("hosts.json");
        std::fs::write(&path, "{not valid json").unwrap();

        let hosts = load_hosts_from_file(&path);
        assert!(hosts.is_empty());
        assert!(!path.exists(), "corrupt file should be renamed away");
        let preserved = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("hosts.json.corrupt-")
            });
        assert!(preserved, "expected a .corrupt-<ts> backup file");
    }

    // ─── Validation tests ───────────────────────────────────────────

    #[test]
    fn test_validate_host_accepts_valid() {
        let host = mk_host("Core Switch", "core-sw-01.lab.local");
        assert!(validate_host(&host, &PlatformRegistry::builtin()).is_ok());
    }

    #[test]
    fn test_validate_host_accepts_ipv6_bracketed() {
        let mut host = mk_host("IPv6 Host", "[::1]");
        host.platform = "linux-bash".to_string();
        assert!(validate_host(&host, &PlatformRegistry::builtin()).is_ok());
    }

    #[test]
    fn test_validate_host_rejects_empty_display_name() {
        let mut host = mk_host("", "10.0.0.1");
        host.display_name = "   ".to_string();
        let err = validate_host(&host, &PlatformRegistry::builtin()).unwrap_err();
        assert!(err.contains("Display name"));
    }

    #[test]
    fn test_validate_host_rejects_empty_hostname() {
        let mut host = mk_host("R1", "");
        host.hostname = "  ".to_string();
        let err = validate_host(&host, &PlatformRegistry::builtin()).unwrap_err();
        assert!(err.contains("Hostname"));
    }

    #[test]
    fn test_validate_host_rejects_empty_username() {
        let mut host = mk_host("R1", "10.0.0.1");
        host.username = "".to_string();
        let err = validate_host(&host, &PlatformRegistry::builtin()).unwrap_err();
        assert!(err.contains("Username"));
    }

    #[test]
    fn test_validate_host_rejects_control_chars_in_hostname() {
        let mut host = mk_host("R1", "10.0.0.1\nbad");
        host.hostname = "evil.com\nSSH-2.0".to_string();
        let err = validate_host(&host, &PlatformRegistry::builtin()).unwrap_err();
        assert!(err.contains("invalid character"));
    }

    #[test]
    fn test_validate_host_rejects_control_chars_in_username() {
        let mut host = mk_host("R1", "10.0.0.1");
        host.username = "root\n".to_string();
        let err = validate_host(&host, &PlatformRegistry::builtin()).unwrap_err();
        assert!(err.contains("control character"));
    }

    #[test]
    fn test_validate_host_rejects_control_chars_in_display_name() {
        let mut host = mk_host("R1", "10.0.0.1");
        host.display_name = "Bad\x07Name".to_string();
        let err = validate_host(&host, &PlatformRegistry::builtin()).unwrap_err();
        assert!(err.contains("control character"));
    }

    #[test]
    fn test_validate_host_rejects_leading_hyphen_hostname() {
        let mut host = mk_host("R1", "10.0.0.1");
        host.hostname = "-bad".to_string();
        let err = validate_host(&host, &PlatformRegistry::builtin()).unwrap_err();
        assert!(err.contains("hyphen"));
    }

    #[test]
    fn test_validate_host_rejects_invalid_platform() {
        let mut host = mk_host("R1", "10.0.0.1");
        host.platform = "juniper-junos".to_string();
        let err = validate_host(&host, &PlatformRegistry::builtin()).unwrap_err();
        assert!(err.contains("not valid"));
        assert!(err.contains("juniper-junos"));
    }

    #[test]
    fn test_validate_host_rejects_oversized_display_name() {
        let mut host = mk_host("R1", "10.0.0.1");
        host.display_name = "x".repeat(129);
        let err = validate_host(&host, &PlatformRegistry::builtin()).unwrap_err();
        assert!(err.contains("too long"));
    }

    #[test]
    fn test_validate_host_rejects_oversized_notes() {
        let mut host = mk_host("R1", "10.0.0.1");
        host.notes = Some("x".repeat(4097));
        let err = validate_host(&host, &PlatformRegistry::builtin()).unwrap_err();
        assert!(err.contains("too long"));
    }

    #[test]
    fn test_validate_host_allows_newlines_in_notes() {
        let mut host = mk_host("R1", "10.0.0.1");
        host.notes = Some("Line 1\nLine 2\r\nLine 3\tTabbed".to_string());
        assert!(validate_host(&host, &PlatformRegistry::builtin()).is_ok());
    }

    #[test]
    fn test_validate_host_rejects_non_tab_control_in_notes() {
        let mut host = mk_host("R1", "10.0.0.1");
        host.notes = Some("bad\x00data".to_string());
        let err = validate_host(&host, &PlatformRegistry::builtin()).unwrap_err();
        assert!(err.contains("control character"));
    }

    #[test]
    fn test_create_rejects_invalid_host() {
        let mut store = HostStore::in_memory();
        let mut host = mk_host("R1", "10.0.0.1");
        host.hostname = "bad\nname".to_string();
        assert!(store.create(host, &PlatformRegistry::builtin()).is_err());
    }

    #[test]
    fn test_update_rejects_invalid_host() {
        let mut store = HostStore::in_memory();
        let platforms = PlatformRegistry::builtin();
        let created = store.create(mk_host("R1", "10.0.0.1"), &platforms).unwrap();
        let mut updated = created;
        updated.username = "".to_string();
        assert!(store.update(updated, &platforms).is_err());
    }

    #[test]
    fn test_custom_platform_host_validates_when_in_registry() {
        let dir = TempDir::new("hosts-custom-platform");
        std::fs::create_dir_all(dir.join("my-custom")).unwrap();
        std::fs::write(dir.join("my-custom/index.yaml"), "platform: my-custom\n").unwrap();
        let platforms = PlatformRegistry::scan(&dir, None::<&std::path::Path>);

        let mut host = mk_host("R1", "10.0.0.1");
        host.platform = "my-custom".to_string();
        assert!(validate_host(&host, &platforms).is_ok());
        // Fails against a registry that lacks the custom platform
        assert!(validate_host(&host, &PlatformRegistry::builtin()).is_err());
    }

    #[test]
    fn test_synthetic_group_guards_reject_all_mutation_handlers() {
        // Table-driven (plan §3): every group-mutation handler rejects
        // synthetic NetBox ids with the same error, and lets user ids pass.
        for handler in ["save_host_group", "move_host_group", "delete_host_group"] {
            for id in ["__netbox__", "__netbox__:site:dc1", "__netbox__:loc:rack-1"] {
                let err = reject_synthetic_group(handler, id).unwrap_err();
                assert_eq!(err, "NetBox groups are managed by the NetBox integration");
            }
            assert!(reject_synthetic_group(handler, "user-group").is_ok());
            assert!(reject_synthetic_group(handler, "550e8400-e29b-41d4").is_ok());
        }
    }

    #[test]
    fn test_corrupt_hosts_preserves_valid_groups() {
        // Part B: one store owns both files. A corrupt hosts.json must reset
        // hosts to empty WITHOUT clobbering a valid groups.json (and vice
        // versa), since each file is loaded independently.
        let dir = TempDir::new("hosts-btest");

        let group = HostGroup {
            id: "g1".to_string(),
            created_at: "t".to_string(),
            ..mk_group("Core")
        };
        std::fs::write(
            dir.join("groups.json"),
            serde_json::to_string_pretty(std::slice::from_ref(&group)).unwrap(),
        )
        .unwrap();
        std::fs::write(dir.join("hosts.json"), "{ not valid json ").unwrap();

        let store = HostStore::new(&dir).unwrap();
        assert!(
            store.get_all().unwrap().is_empty(),
            "corrupt hosts -> empty"
        );
        let groups = store.get_groups().unwrap();
        assert_eq!(groups.len(), 1, "valid groups preserved");
        assert_eq!(groups[0].id, "g1");

        // A later save must persist the surviving group, not wipe it.
        store.save().unwrap();
        let reloaded: Vec<HostGroup> =
            serde_json::from_str(&std::fs::read_to_string(dir.join("groups.json")).unwrap())
                .unwrap();
        assert_eq!(reloaded.len(), 1);
    }

    // ─── last_connected + group CRUD (coverage gaps R1/R2) ──────────

    /// A store backed by a real temp dir, so `save()` actually writes.
    fn temp_store() -> (TempDir, HostStore) {
        let dir = TempDir::new("hosts-crud");
        let store = HostStore::new(&dir).unwrap();
        (dir, store)
    }

    #[test]
    fn test_touch_sets_last_connected_and_persists() {
        let (dir, mut store) = temp_store();
        let created = store
            .create(mk_host("R1", "10.0.0.1"), &PlatformRegistry::builtin())
            .unwrap();
        assert!(created.last_connected.is_none());

        store.touch(&created.id).unwrap();

        let mut all = store.get_all().unwrap();
        let stamp = all.remove(0).last_connected.expect("last_connected set");
        assert!(!stamp.is_empty());

        // Written through to disk, not just held in memory.
        let on_disk: Vec<Host> =
            serde_json::from_str(&std::fs::read_to_string(dir.join("hosts.json")).unwrap())
                .unwrap();
        assert_eq!(on_disk[0].last_connected, Some(stamp));

        // An unknown id is a silent no-op: no error, no new host, no write.
        let before = std::fs::read_to_string(dir.join("hosts.json")).unwrap();
        store.touch("no-such-id").unwrap();
        assert_eq!(store.get_all().unwrap().len(), 1);
        assert_eq!(
            std::fs::read_to_string(dir.join("hosts.json")).unwrap(),
            before
        );
    }

    #[test]
    fn test_group_crud_assigns_ids_and_persists() {
        let (dir, mut store) = temp_store();
        let blank_group = |name: &str, parent: Option<String>| HostGroup {
            parent_id: parent,
            ..mk_group(name)
        };

        let core = store.create_group(blank_group("Core", None)).unwrap();
        assert!(!core.id.is_empty(), "create_group assigns an id");
        assert!(
            !core.created_at.is_empty(),
            "create_group stamps created_at"
        );
        assert_eq!(core.sort_order, 0);

        let edge = store
            .create_group(blank_group("Edge", Some(core.id.clone())))
            .unwrap();
        assert_eq!(edge.sort_order, 1, "second group takes the next sort_order");

        // Renaming persists, and does not resurrect a second copy.
        let mut renamed = core.clone();
        renamed.name = "Core Renamed".to_string();
        store.update_group(renamed).unwrap();

        let on_disk: Vec<HostGroup> =
            serde_json::from_str(&std::fs::read_to_string(dir.join("groups.json")).unwrap())
                .unwrap();
        assert_eq!(on_disk.len(), 2);
        assert_eq!(on_disk[0].name, "Core Renamed");
        assert_eq!(on_disk[0].id, core.id);

        store.delete_group(&edge.id).unwrap();
        let remaining = store.get_groups().unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, core.id);
        let on_disk: Vec<HostGroup> =
            serde_json::from_str(&std::fs::read_to_string(dir.join("groups.json")).unwrap())
                .unwrap();
        assert_eq!(on_disk.len(), 1, "delete_group persists the removal");
    }

    #[test]
    fn test_group_crud_unknown_id_errors() {
        let (_dir, mut store) = temp_store();
        let ghost = HostGroup {
            id: "ghost".to_string(),
            ..mk_group("Ghost")
        };

        assert_eq!(
            store.update_group(ghost).unwrap_err(),
            "Host group not found: ghost"
        );
        assert_eq!(
            store.delete_group("ghost").unwrap_err(),
            "Host group not found: ghost"
        );
        assert!(store.get_groups().unwrap().is_empty());
    }

    // ─── Handler wiring (issue #185) ────────────────────────────────

    use crate::fixtures::{assert_acquired_before, sample_entry};
    use crate::netbox::{NetBoxConfig, NetBoxGeo, SyncReport};
    use crate::state::AppState;

    /// Seed one cached NetBox device (enabled unless `enabled` says otherwise).
    fn seed_netbox_device(state: &AppState, id: u64, enabled: bool) {
        state
            .netbox
            .lock()
            .unwrap()
            .apply_sync(
                SyncReport::default(),
                vec![sample_entry(id, enabled)],
                NetBoxGeo::default(),
            )
            .unwrap();
    }

    fn seed_devices(state: &AppState, entries: Vec<crate::netbox::NetBoxDeviceEntry>) {
        state
            .netbox
            .lock()
            .unwrap()
            .apply_sync(SyncReport::default(), entries, NetBoxGeo::default())
            .unwrap();
    }

    fn enable_netbox(state: &AppState, show_empty_folders: bool) {
        let config = NetBoxConfig {
            enabled: true,
            show_empty_folders,
            ..Default::default()
        };
        state
            .config
            .lock()
            .unwrap()
            .save_host_source_config("netbox", serde_json::to_value(config).unwrap())
            .unwrap();
    }

    #[test]
    fn save_host_impl_takes_the_platforms_lock_before_hosts_and_persists() {
        let dir = TempDir::new("hosts-save");
        let state = AppState::for_test(&dir);

        // Contended order: holding `platforms` must leave `hosts` free.
        let created = assert_acquired_before(&state.platforms, &state.hosts, || {
            save_host_impl(&state, mk_host("R1", "10.0.0.1"))
        })
        .unwrap();

        assert!(!created.id.is_empty());
        assert_eq!(state.hosts.lock().unwrap().get_all().unwrap().len(), 1);
        assert!(dir.join("hosts.json").exists());
    }

    #[test]
    fn save_host_impl_rejects_netbox_sourced_hosts_before_the_stores() {
        let dir = TempDir::new("hosts-save-netbox");
        let state = AppState::for_test(&dir);

        let mut by_source = mk_host("dev-1", "10.0.0.1");
        by_source.source = Some("netbox".to_string());
        let mut by_id = mk_host("dev-2", "10.0.0.2");
        by_id.id = "netbox:2".to_string();

        for host in [by_source, by_id] {
            let err = save_host_impl(&state, host).unwrap_err();
            assert_eq!(err, "Cannot edit NetBox-sourced hosts");
        }
        assert!(state.hosts.lock().unwrap().get_all().unwrap().is_empty());
    }

    #[test]
    fn delete_host_impl_rejects_netbox_host_ids_before_touching_the_store() {
        let dir = TempDir::new("hosts-delete-netbox");
        let state = AppState::for_test(&dir);
        let created = save_host_impl(&state, mk_host("R1", "10.0.0.1")).unwrap();

        let err = delete_host_impl(&state, "netbox:7".to_string()).unwrap_err();

        assert!(err.contains("Cannot delete NetBox-sourced hosts"), "{err}");
        assert_eq!(
            state.hosts.lock().unwrap().get_all().unwrap()[0].id,
            created.id
        );
    }

    #[test]
    fn touch_host_impl_takes_the_netbox_lock_for_netbox_ids() {
        let dir = TempDir::new("hosts-touch-netbox");
        let state = AppState::for_test(&dir);
        seed_netbox_device(&state, 5, true);

        touch_host_impl(&state, "netbox:5".to_string()).unwrap();

        let netbox = state.netbox.lock().unwrap();
        assert!(netbox.get().devices[0].overlay.last_connected.is_some());
        assert!(state.hosts.lock().unwrap().get_all().unwrap().is_empty());
    }

    #[test]
    fn touch_host_impl_takes_the_hosts_lock_for_user_hosts() {
        let dir = TempDir::new("hosts-touch-user");
        let state = AppState::for_test(&dir);
        let created = save_host_impl(&state, mk_host("R1", "10.0.0.1")).unwrap();

        touch_host_impl(&state, created.id.clone()).unwrap();

        let hosts = state.hosts.lock().unwrap().get_all().unwrap();
        assert!(hosts[0].last_connected.is_some());
    }

    #[test]
    fn get_hosts_impl_merges_only_enabled_devices() {
        let dir = TempDir::new("hosts-merge");
        let state = AppState::for_test(&dir);
        save_host_impl(&state, mk_host("R1", "10.0.0.1")).unwrap();
        seed_devices(&state, vec![sample_entry(1, true), sample_entry(2, false)]);

        let without = get_hosts_impl(&state).unwrap();
        assert_eq!(without.len(), 1, "disabled source adds no NetBox devices");

        enable_netbox(&state, false);
        let merged = get_hosts_impl(&state).unwrap();

        assert_eq!(merged.len(), 2, "only the enabled device is merged");
        assert!(merged.iter().any(|h| h.id == "netbox:1"));
        assert!(!merged.iter().any(|h| h.id == "netbox:2"));

        let on_disk: Vec<Host> =
            serde_json::from_str(&std::fs::read_to_string(dir.join("hosts.json")).unwrap())
                .unwrap();
        assert_eq!(on_disk.len(), 1, "the merge is never written to hosts.json");
    }

    #[test]
    fn get_hosts_impl_reads_hosts_then_config_then_netbox() {
        let dir = TempDir::new("hosts-read-order");
        let state = AppState::for_test(&dir);
        enable_netbox(&state, false);
        seed_devices(&state, vec![sample_entry(1, true)]);

        // Holding `hosts` must leave `config` free, and holding `config` must
        // leave `netbox` free: each pair is taken in the documented order.
        let merged =
            assert_acquired_before(&state.hosts, &state.config, || get_hosts_impl(&state)).unwrap();
        assert!(merged.iter().any(|h| h.id == "netbox:1"));

        assert_acquired_before(&state.config, &state.netbox, || get_hosts_impl(&state)).unwrap();
    }

    #[test]
    fn get_host_groups_impl_merges_synthetic_groups_only_when_enabled() {
        let dir = TempDir::new("hosts-groups-merge");
        let state = AppState::for_test(&dir);
        seed_devices(&state, vec![sample_entry(1, true)]);

        let without = get_host_groups_impl(&state).unwrap();
        assert!(
            !without.iter().any(|g| netbox::is_synthetic_group_id(&g.id)),
            "synthetic groups need the source enabled"
        );

        enable_netbox(&state, true);
        let merged = get_host_groups_impl(&state).unwrap();

        assert!(
            merged.iter().any(|g| netbox::is_synthetic_group_id(&g.id)),
            "enabled source contributes its synthetic groups"
        );
    }

    #[test]
    fn get_host_groups_impl_reads_hosts_then_config_then_netbox() {
        let dir = TempDir::new("hosts-groups-read-order");
        let state = AppState::for_test(&dir);
        enable_netbox(&state, true);
        seed_devices(&state, vec![sample_entry(1, true)]);

        assert_acquired_before(&state.hosts, &state.config, || get_host_groups_impl(&state))
            .unwrap();
        let merged = assert_acquired_before(&state.config, &state.netbox, || {
            get_host_groups_impl(&state)
        })
        .unwrap();

        assert!(merged.iter().any(|g| netbox::is_synthetic_group_id(&g.id)));
    }

    #[test]
    fn move_host_group_impl_rejects_synthetic_groups_before_the_host_store() {
        let dir = TempDir::new("hosts-move-synthetic");
        let state = AppState::for_test(&dir);
        let group = {
            let mut hosts = state.hosts.lock().unwrap();
            hosts.create_group(mk_group("Lab")).unwrap()
        };

        let err = move_host_group_impl(
            &state,
            format!("{}{}", netbox::ROOT_GROUP_ID, "dc1"),
            None,
            0,
        )
        .unwrap_err();

        assert!(err.contains("managed by the NetBox integration"), "{err}");
        let groups = state.hosts.lock().unwrap().get_groups().unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].id, group.id);
    }

    #[test]
    fn delete_host_group_impl_takes_the_platforms_lock_before_hosts() {
        let dir = TempDir::new("hosts-delete-group-order");
        let state = AppState::for_test(&dir);
        let group = {
            let mut hosts = state.hosts.lock().unwrap();
            hosts.create_group(mk_group("Lab")).unwrap()
        };

        // Holding `platforms` must leave `hosts` free.
        assert_acquired_before(&state.platforms, &state.hosts, || {
            delete_host_group_impl(&state, group.id.clone())
        })
        .unwrap();

        assert!(state.hosts.lock().unwrap().get_groups().unwrap().is_empty());
    }

    #[test]
    fn delete_host_group_impl_ungroups_members_before_deleting_the_group() {
        let dir = TempDir::new("hosts-delete-group");
        let state = AppState::for_test(&dir);
        let group = {
            let mut hosts = state.hosts.lock().unwrap();
            hosts.create_group(mk_group("Lab")).unwrap()
        };
        let mut host = mk_host("R1", "10.0.0.1");
        host.group_id = Some(group.id.clone());
        let created = save_host_impl(&state, host).unwrap();
        assert_eq!(created.group_id.as_deref(), Some(group.id.as_str()));

        delete_host_group_impl(&state, group.id.clone()).unwrap();

        assert!(state.hosts.lock().unwrap().get_groups().unwrap().is_empty());
        let hosts = state.hosts.lock().unwrap().get_all().unwrap();
        assert!(
            hosts[0].group_id.is_none(),
            "members must be ungrouped before the group is deleted"
        );
        let on_disk: Vec<HostGroup> =
            serde_json::from_str(&std::fs::read_to_string(dir.join("groups.json")).unwrap())
                .unwrap();
        assert!(on_disk.is_empty(), "the group removal is persisted");
    }

    #[test]
    fn delete_host_group_impl_rejects_synthetic_groups_before_locking() {
        let dir = TempDir::new("hosts-delete-synthetic");
        let state = AppState::for_test(&dir);
        let group = {
            let mut hosts = state.hosts.lock().unwrap();
            hosts.create_group(mk_group("Lab")).unwrap()
        };

        let err =
            delete_host_group_impl(&state, format!("{}site", netbox::ROOT_GROUP_ID)).unwrap_err();

        assert!(err.contains("managed by the NetBox integration"), "{err}");
        assert_eq!(state.hosts.lock().unwrap().get_groups().unwrap().len(), 1);
        assert_eq!(
            state.hosts.lock().unwrap().get_groups().unwrap()[0].id,
            group.id
        );
    }
}
