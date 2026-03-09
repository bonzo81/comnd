//! Host storage — JSON file in app data dir + OS keychain for credentials.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

// ─── Types ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Host {
    #[serde(default)]
    pub id: String,
    pub display_name: String,
    pub hostname: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub username: String,
    #[serde(default = "default_auth_type")]
    pub auth_type: String, // "password" | "ssh_key"
    pub ssh_key_path: Option<String>,
    #[serde(default = "default_platform")]
    pub platform: String,
    pub os_version: Option<String>,
    pub notes: Option<String>,
    pub last_connected: Option<String>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub sort_order: u32,
}

fn default_port() -> u16 { 22 }
fn default_auth_type() -> String { "password".to_string() }
fn default_platform() -> String { "cisco-iosxe".to_string() }

// ─── Host Store ─────────────────────────────────────────────────────

pub struct HostStore {
    hosts_path: Option<PathBuf>,
    hosts: Vec<Host>,
}

impl HostStore {
    /// Create a new HostStore backed by a JSON file in the app data directory.
    pub fn new() -> Result<Self, String> {
        let data_dir = dirs::data_dir()
            .ok_or_else(|| "Could not find app data directory".to_string())?
            .join("netsh");

        std::fs::create_dir_all(&data_dir)
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
    pub fn create(&mut self, mut host: Host) -> Result<Host, String> {
        host.id = uuid::Uuid::new_v4().to_string();
        host.created_at = chrono::Utc::now().to_rfc3339();
        host.sort_order = self.hosts.len() as u32;
        log::info!("Host created: '{}' ({}@{}:{})", host.display_name, host.username, host.hostname, host.port);
        self.hosts.push(host.clone());
        self.save()?;
        Ok(host)
    }

    /// Update an existing host by id.
    pub fn update(&mut self, host: Host) -> Result<Host, String> {
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

    /// Reorder hosts by providing new ID order.
    pub fn reorder(&mut self, ids: &[String]) -> Result<(), String> {
        for (i, id) in ids.iter().enumerate() {
            if let Some(host) = self.hosts.iter_mut().find(|h| &h.id == id) {
                host.sort_order = i as u32;
            }
        }
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
            std::fs::write(path, json)
                .map_err(|e| format!("Failed to write hosts file: {}", e))?;
        }
        Ok(())
    }
}

/// Load hosts from JSON file, returning empty vec on any error.
fn load_hosts_from_file(path: &PathBuf) -> Vec<Host> {
    match std::fs::read_to_string(path) {
        Ok(content) => {
            serde_json::from_str(&content).unwrap_or_else(|e| {
                log::warn!("Failed to parse hosts.json: {}. Starting with empty list.", e);
                Vec::new()
            })
        }
        Err(_) => Vec::new(), // File doesn't exist yet
    }
}

// ─── Credential Management ──────────────────────────────────────────
// Using simple file-based credential storage for MVP.
// The keyring crate requires system dependencies that complicate builds.
// In production, we'd use the OS keychain via the keyring crate.

/// Save a credential (password) for a host.
pub fn save_credential(host_id: &str, password: &str) -> Result<(), String> {
    let cred_path = get_credentials_path()?;
    let mut creds = load_credentials(&cred_path);
    creds.insert(host_id.to_string(), password.to_string());
    save_credentials(&cred_path, &creds)
}

/// Get a credential (password) for a host.
pub fn get_credential(host_id: &str) -> Result<Option<String>, String> {
    let cred_path = get_credentials_path()?;
    let creds = load_credentials(&cred_path);
    Ok(creds.get(host_id).cloned())
}

/// Delete a credential for a host.
pub fn delete_credential(host_id: &str) -> Result<(), String> {
    let cred_path = get_credentials_path()?;
    let mut creds = load_credentials(&cred_path);
    creds.remove(host_id);
    save_credentials(&cred_path, &creds)
}

fn get_credentials_path() -> Result<PathBuf, String> {
    let data_dir = dirs::data_dir()
        .ok_or_else(|| "Could not find app data directory".to_string())?
        .join("netsh");
    std::fs::create_dir_all(&data_dir)
        .map_err(|e| format!("Failed to create data dir: {}", e))?;
    Ok(data_dir.join("credentials.json"))
}

fn load_credentials(path: &PathBuf) -> std::collections::HashMap<String, String> {
    match std::fs::read_to_string(path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => std::collections::HashMap::new(),
    }
}

fn save_credentials(path: &PathBuf, creds: &std::collections::HashMap<String, String>) -> Result<(), String> {
    let json = serde_json::to_string_pretty(creds)
        .map_err(|e| format!("Failed to serialize credentials: {}", e))?;
    std::fs::write(path, json)
        .map_err(|e| format!("Failed to write credentials file: {}", e))?;
    Ok(())
}

// ─── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_create_and_get_hosts() {
        let mut store = HostStore::in_memory();
        let host = Host {
            id: String::new(),
            display_name: "Test Router".to_string(),
            hostname: "192.168.1.1".to_string(),
            port: 22,
            username: "admin".to_string(),
            auth_type: "password".to_string(),
            ssh_key_path: None,
            platform: "cisco-iosxe".to_string(),
            os_version: None,
            notes: None,
            last_connected: None,
            created_at: String::new(),
            sort_order: 0,
        };

        let created = store.create(host).unwrap();
        assert!(!created.id.is_empty());
        assert!(!created.created_at.is_empty());

        let all = store.get_all().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].display_name, "Test Router");
    }

    #[test]
    fn test_update_host() {
        let mut store = HostStore::in_memory();
        let host = Host {
            id: String::new(),
            display_name: "Router A".to_string(),
            hostname: "10.0.0.1".to_string(),
            port: 22,
            username: "admin".to_string(),
            auth_type: "password".to_string(),
            ssh_key_path: None,
            platform: "cisco-iosxe".to_string(),
            os_version: None,
            notes: None,
            last_connected: None,
            created_at: String::new(),
            sort_order: 0,
        };

        let created = store.create(host).unwrap();
        let mut updated = created.clone();
        updated.display_name = "Router B".to_string();

        let result = store.update(updated).unwrap();
        assert_eq!(result.display_name, "Router B");
    }

    #[test]
    fn test_delete_host() {
        let mut store = HostStore::in_memory();
        let host = Host {
            id: String::new(),
            display_name: "Delete Me".to_string(),
            hostname: "10.0.0.2".to_string(),
            port: 22,
            username: "admin".to_string(),
            auth_type: "password".to_string(),
            ssh_key_path: None,
            platform: "cisco-iosxe".to_string(),
            os_version: None,
            notes: None,
            last_connected: None,
            created_at: String::new(),
            sort_order: 0,
        };

        let created = store.create(host).unwrap();
        store.delete(&created.id).unwrap();
        let all = store.get_all().unwrap();
        assert!(all.is_empty());
    }

    #[test]
    fn test_reorder_hosts() {
        let mut store = HostStore::in_memory();

        for name in &["Host C", "Host A", "Host B"] {
            store.create(Host {
                id: String::new(),
                display_name: name.to_string(),
                hostname: "10.0.0.1".to_string(),
                port: 22,
                username: "admin".to_string(),
                auth_type: "password".to_string(),
                ssh_key_path: None,
                platform: "cisco-iosxe".to_string(),
                os_version: None,
                notes: None,
                last_connected: None,
                created_at: String::new(),
                sort_order: 0,
            }).unwrap();
        }

        let all = store.get_all().unwrap();
        let new_order: Vec<String> = all.iter().rev().map(|h| h.id.clone()).collect();
        store.reorder(&new_order).unwrap();

        let reordered = store.get_all().unwrap();
        assert_eq!(reordered[0].display_name, "Host B");
    }
}
