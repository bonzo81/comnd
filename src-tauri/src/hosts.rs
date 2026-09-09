//! Host storage — JSON file in app data dir + OS keychain for credentials.
//! Host groups — separate JSON file, hierarchical (parent_id for nesting).

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

// Credential types live in credentials.rs (Phase 0 of the host-source
// plan); re-exported here so existing `hosts::...` paths keep compiling.
pub use crate::credentials::{AgentAuth, CredentialSource};
use crate::platform::PlatformRegistry;

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

fn default_port() -> u16 { 22 }
fn default_auth_type() -> String { "password".to_string() }
fn default_platform() -> String { "cisco-iosxe".to_string() }

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
        return Err(format!("Display name is too long (max {} chars)", MAX_DISPLAY_NAME));
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
            return Err(format!("OS version is too long (max {} chars)", MAX_OS_VERSION));
        }
        if ver.chars().any(|c| c.is_control()) {
            return Err("OS version contains control characters".to_string());
        }
    }

    if let Some(ref notes) = host.notes {
        if notes.len() > MAX_NOTES {
            return Err(format!("Notes are too long (max {} chars)", MAX_NOTES));
        }
        if notes.chars().any(|c| c.is_control() && c != '\n' && c != '\r' && c != '\t') {
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
    hosts: Vec<Host>,
}

impl HostStore {
    /// Create a new HostStore backed by a JSON file in `data_dir`.
    pub fn new(data_dir: &std::path::Path) -> Result<Self, String> {
        crate::paths::ensure_data_dir(data_dir)
            .map_err(|e| format!("Failed to create data dir: {}", e))?;

        let hosts_path = data_dir.join("hosts.json");
        let hosts = load_hosts_from_file(&hosts_path);

        Ok(HostStore {
            hosts_path: Some(hosts_path),
            hosts,
        })
    }

    /// Create an in-memory-only store (fallback if filesystem fails).
    pub fn in_memory() -> Self {
        HostStore {
            hosts_path: None,
            hosts: Vec::new(),
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
        log::info!("Host created: '{}' ({}@{}:{})", host.display_name, host.username, host.hostname, host.port);
        self.hosts.push(host.clone());
        self.save()?;
        Ok(host)
    }

    /// Update an existing host by id.
    pub fn update(&mut self, mut host: Host, platforms: &PlatformRegistry) -> Result<Host, String> {
        validate_host(&host, platforms)?;
        host.normalize_credential();
        let pos = self.hosts.iter().position(|h| h.id == host.id)
            .ok_or_else(|| format!("Host not found: {}", host.id))?;
        self.hosts[pos] = host.clone();
        self.save()?;
        Ok(host)
    }

    /// Delete a host by id.
    pub fn delete(&mut self, id: &str) -> Result<(), String> {
        let pos = self.hosts.iter().position(|h| h.id == id)
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

    /// Persist hosts to disk.
    fn save(&self) -> Result<(), String> {
        if let Some(ref path) = self.hosts_path {
            let json = serde_json::to_string_pretty(&self.hosts)
                .map_err(|e| format!("Failed to serialize hosts: {}", e))?;
            crate::paths::secure_write(path, json.as_bytes())
                .map_err(|e| format!("Failed to write hosts file: {}", e))?;
        }
        Ok(())
    }
}

/// Load hosts from JSON file, returning empty vec on any error.
fn load_hosts_from_file(path: &PathBuf) -> Vec<Host> {
    match std::fs::read_to_string(path) {
        Ok(content) => {
            let loaded = serde_json::from_str::<Vec<Host>>(&content).unwrap_or_else(|e| {
                log::error!("Failed to parse hosts.json: {}. Preserving as .corrupt.", e);
                crate::paths::preserve_corrupt(path);
                Vec::new()
            });
            loaded.into_iter().map(|mut h| {
                h.normalize_credential();
                h
            }).collect()
        }
        Err(_) => Vec::new(), // File doesn't exist yet
    }
}

// ─── Host Group Store ────────────────────────────────────────────────

pub struct HostGroupStore {
    groups_path: Option<PathBuf>,
    groups: Vec<HostGroup>,
}

impl HostGroupStore {
    pub fn new(data_dir: &std::path::Path) -> Result<Self, String> {
        crate::paths::ensure_data_dir(data_dir)
            .map_err(|e| format!("Failed to create data dir: {}", e))?;

        let groups_path = data_dir.join("groups.json");
        let groups = load_groups_from_file(&groups_path);

        Ok(HostGroupStore {
            groups_path: Some(groups_path),
            groups,
        })
    }

    pub fn in_memory() -> Self {
        HostGroupStore {
            groups_path: None,
            groups: Vec::new(),
        }
    }

    pub fn get_all(&self) -> Result<Vec<HostGroup>, String> {
        let mut sorted = self.groups.clone();
        sorted.sort_by_key(|g| g.sort_order);
        Ok(sorted)
    }

    pub fn create(&mut self, mut group: HostGroup) -> Result<HostGroup, String> {
        group.id = uuid::Uuid::new_v4().to_string();
        group.created_at = chrono::Utc::now().to_rfc3339();
        group.sort_order = self.groups.len() as u32;
        log::info!("Host group created: '{}'", group.name);
        self.groups.push(group.clone());
        self.save()?;
        Ok(group)
    }

    pub fn update(&mut self, group: HostGroup) -> Result<HostGroup, String> {
        let pos = self.groups.iter().position(|g| g.id == group.id)
            .ok_or_else(|| format!("Host group not found: {}", group.id))?;
        self.groups[pos] = group.clone();
        self.save()?;
        Ok(group)
    }

    pub fn delete(&mut self, id: &str) -> Result<(), String> {
        let pos = self.groups.iter().position(|g| g.id == id)
            .ok_or_else(|| format!("Host group not found: {}", id))?;
        log::info!("Host group deleted: '{}' ({})", self.groups[pos].name, id);
        self.groups.remove(pos);
        self.save()?;
        Ok(())
    }

    fn save(&self) -> Result<(), String> {
        if let Some(ref path) = self.groups_path {
            let json = serde_json::to_string_pretty(&self.groups)
                .map_err(|e| format!("Failed to serialize groups: {}", e))?;
            crate::paths::secure_write(path, json.as_bytes())
                .map_err(|e| format!("Failed to write groups file: {}", e))?;
        }
        Ok(())
    }
}

fn load_groups_from_file(path: &PathBuf) -> Vec<HostGroup> {
    match std::fs::read_to_string(path) {
        Ok(content) => {
            serde_json::from_str(&content).unwrap_or_else(|e| {
                log::error!("Failed to parse groups.json: {}. Preserving as .corrupt.", e);
                crate::paths::preserve_corrupt(path);
                Vec::new()
            })
        }
        Err(_) => Vec::new(),
    }
}

// ─── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn make_host(name: &str, hostname: &str) -> Host {
        Host {
            id: String::new(),
            display_name: name.to_string(),
            hostname: hostname.to_string(),
            port: 22,
            username: "admin".to_string(),
            auth_type: "password".to_string(),
            ssh_key_path: None,
            credential: None,
            platform: "cisco-iosxe".to_string(),
            os_version: None,
            highlight_profile: None,
            notes: None,
            last_connected: None,
            created_at: String::new(),
            sort_order: 0,
            tags: vec![],
            group_id: None,
            source: None,
        }
    }

    #[test]
    fn test_create_and_get_hosts() {
        let mut store = HostStore::in_memory();
        let host = make_host("Test Router", "192.168.1.1");

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
        let host = make_host("Router A", "10.0.0.1");

        let created = store.create(host, &PlatformRegistry::builtin()).unwrap();
        let mut updated = created.clone();
        updated.display_name = "Router B".to_string();

        let result = store.update(updated, &PlatformRegistry::builtin()).unwrap();
        assert_eq!(result.display_name, "Router B");
    }

    #[test]
    fn test_delete_host() {
        let mut store = HostStore::in_memory();
        let host = make_host("Delete Me", "10.0.0.2");

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
        assert_eq!(hosts.remove(0).credential, Some(CredentialSource::SshKey { key_path: "~/.ssh/id_rsa".to_string() }));
    }

    #[test]
    fn test_roundtrip_serializes_credential_only() {
        let mut host = make_host("R1", "10.0.0.1");
        host.normalize_credential();
        let json = serde_json::to_string(&host).unwrap();
        assert!(json.contains("\"credential\""), "credential must serialize: {}", json);
        assert!(!json.contains("auth_type"), "legacy field must not serialize: {}", json);
        assert!(!json.contains("ssh_key_path"), "legacy field must not serialize: {}", json);
        // Reload roundtrip keeps the variant
        let reloaded: Host = serde_json::from_str(&json).unwrap();
        assert_eq!(reloaded.credential, Some(CredentialSource::Password));
    }

    #[test]
    fn test_corrupt_file_preserved() {
        let dir = std::env::temp_dir().join(format!("netssh_hosts_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("hosts.json");
        std::fs::write(&path, "{not valid json").unwrap();

        let hosts = load_hosts_from_file(&path);
        assert!(hosts.is_empty());
        assert!(!path.exists(), "corrupt file should be renamed away");
        let preserved = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("hosts.json.corrupt-")
            });
        assert!(preserved, "expected a .corrupt-<ts> backup file");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ─── Validation tests ───────────────────────────────────────────

    #[test]
    fn test_validate_host_accepts_valid() {
        let host = make_host("Core Switch", "core-sw-01.lab.local");
        assert!(validate_host(&host, &PlatformRegistry::builtin()).is_ok());
    }

    #[test]
    fn test_validate_host_accepts_ipv6_bracketed() {
        let mut host = make_host("IPv6 Host", "[::1]");
        host.platform = "linux-bash".to_string();
        assert!(validate_host(&host, &PlatformRegistry::builtin()).is_ok());
    }

    #[test]
    fn test_validate_host_rejects_empty_display_name() {
        let mut host = make_host("", "10.0.0.1");
        host.display_name = "   ".to_string();
        let err = validate_host(&host, &PlatformRegistry::builtin()).unwrap_err();
        assert!(err.contains("Display name"));
    }

    #[test]
    fn test_validate_host_rejects_empty_hostname() {
        let mut host = make_host("R1", "");
        host.hostname = "  ".to_string();
        let err = validate_host(&host, &PlatformRegistry::builtin()).unwrap_err();
        assert!(err.contains("Hostname"));
    }

    #[test]
    fn test_validate_host_rejects_empty_username() {
        let mut host = make_host("R1", "10.0.0.1");
        host.username = "".to_string();
        let err = validate_host(&host, &PlatformRegistry::builtin()).unwrap_err();
        assert!(err.contains("Username"));
    }

    #[test]
    fn test_validate_host_rejects_control_chars_in_hostname() {
        let mut host = make_host("R1", "10.0.0.1\nbad");
        host.hostname = "evil.com\nSSH-2.0".to_string();
        let err = validate_host(&host, &PlatformRegistry::builtin()).unwrap_err();
        assert!(err.contains("invalid character"));
    }

    #[test]
    fn test_validate_host_rejects_control_chars_in_username() {
        let mut host = make_host("R1", "10.0.0.1");
        host.username = "root\n".to_string();
        let err = validate_host(&host, &PlatformRegistry::builtin()).unwrap_err();
        assert!(err.contains("control character"));
    }

    #[test]
    fn test_validate_host_rejects_control_chars_in_display_name() {
        let mut host = make_host("R1", "10.0.0.1");
        host.display_name = "Bad\x07Name".to_string();
        let err = validate_host(&host, &PlatformRegistry::builtin()).unwrap_err();
        assert!(err.contains("control character"));
    }

    #[test]
    fn test_validate_host_rejects_leading_hyphen_hostname() {
        let mut host = make_host("R1", "10.0.0.1");
        host.hostname = "-bad".to_string();
        let err = validate_host(&host, &PlatformRegistry::builtin()).unwrap_err();
        assert!(err.contains("hyphen"));
    }

    #[test]
    fn test_validate_host_rejects_invalid_platform() {
        let mut host = make_host("R1", "10.0.0.1");
        host.platform = "juniper-junos".to_string();
        let err = validate_host(&host, &PlatformRegistry::builtin()).unwrap_err();
        assert!(err.contains("not valid"));
        assert!(err.contains("juniper-junos"));
    }

    #[test]
    fn test_validate_host_rejects_oversized_display_name() {
        let mut host = make_host("R1", "10.0.0.1");
        host.display_name = "x".repeat(129);
        let err = validate_host(&host, &PlatformRegistry::builtin()).unwrap_err();
        assert!(err.contains("too long"));
    }

    #[test]
    fn test_validate_host_rejects_oversized_notes() {
        let mut host = make_host("R1", "10.0.0.1");
        host.notes = Some("x".repeat(4097));
        let err = validate_host(&host, &PlatformRegistry::builtin()).unwrap_err();
        assert!(err.contains("too long"));
    }

    #[test]
    fn test_validate_host_allows_newlines_in_notes() {
        let mut host = make_host("R1", "10.0.0.1");
        host.notes = Some("Line 1\nLine 2\r\nLine 3\tTabbed".to_string());
        assert!(validate_host(&host, &PlatformRegistry::builtin()).is_ok());
    }

    #[test]
    fn test_validate_host_rejects_non_tab_control_in_notes() {
        let mut host = make_host("R1", "10.0.0.1");
        host.notes = Some("bad\x00data".to_string());
        let err = validate_host(&host, &PlatformRegistry::builtin()).unwrap_err();
        assert!(err.contains("control character"));
    }

    #[test]
    fn test_create_rejects_invalid_host() {
        let mut store = HostStore::in_memory();
        let mut host = make_host("R1", "10.0.0.1");
        host.hostname = "bad\nname".to_string();
        assert!(store.create(host, &PlatformRegistry::builtin()).is_err());
    }

    #[test]
    fn test_update_rejects_invalid_host() {
        let mut store = HostStore::in_memory();
        let platforms = PlatformRegistry::builtin();
        let created = store.create(make_host("R1", "10.0.0.1"), &platforms).unwrap();
        let mut updated = created;
        updated.username = "".to_string();
        assert!(store.update(updated, &platforms).is_err());
    }

    #[test]
    fn test_custom_platform_host_validates_when_in_registry() {
        let dir = std::env::temp_dir().join(format!("netssh_hosts_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("my-custom")).unwrap();
        std::fs::write(dir.join("my-custom/index.yaml"), "platform: my-custom\n").unwrap();
        let platforms = PlatformRegistry::scan(&dir, None::<&std::path::Path>);

        let mut host = make_host("R1", "10.0.0.1");
        host.platform = "my-custom".to_string();
        assert!(validate_host(&host, &platforms).is_ok());
        // Fails against a registry that lacks the custom platform
        assert!(validate_host(&host, &PlatformRegistry::builtin()).is_err());
    }
}
