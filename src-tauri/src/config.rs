//! Application configuration — persisted settings for Ollama, KB paths, etc.
//!
//! Config lives in the app data directory as `config.json`,
//! alongside `hosts.json` and `credentials.json`.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

// ─── Types ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    #[serde(default = "default_ollama_base_url")]
    pub ollama_base_url: String,
    #[serde(default = "default_ollama_model")]
    pub ollama_model: String,
    /// Transient — loaded from the OS keychain at runtime, never persisted
    /// to config.json.
    #[serde(skip)]
    pub ollama_api_key: Option<String>,
    #[serde(default = "default_ollama_context_length")]
    pub ollama_context_length: u32,
    #[serde(default = "default_log_level")]
    pub log_level: String,
    #[serde(default = "default_log_max_size_mb")]
    pub log_max_size_mb: u32,
    #[serde(default)]
    pub log_file_path: Option<String>,
    /// Per-provider settings (chunk 6+). Key = provider id, value =
    /// provider-specific JSON parsed by that provider. Secrets never live
    /// here — they go in the OS keychain (`netsh_provider_<id>`).
    #[serde(default)]
    pub providers: std::collections::HashMap<String, serde_json::Value>,
}

impl Default for AppConfig {
    fn default() -> Self {
        AppConfig {
            ollama_base_url: default_ollama_base_url(),
            ollama_model: default_ollama_model(),
            ollama_api_key: None,
            ollama_context_length: default_ollama_context_length(),
            log_level: default_log_level(),
            log_max_size_mb: default_log_max_size_mb(),
            log_file_path: None,
            providers: Default::default(),
        }
    }
}

fn default_ollama_base_url() -> String {
    "http://localhost:11434".to_string()
}

fn default_ollama_model() -> String {
    "gemma4:26b".to_string()
}

fn default_ollama_context_length() -> u32 {
    64000
}

fn default_log_level() -> String {
    "info".to_string()
}

fn default_log_max_size_mb() -> u32 {
    10
}

/// Map a config log-level string to a `log` crate level filter.
/// Unknown values fall back to `Info`.
pub fn parse_log_level_filter(level: &str) -> log::LevelFilter {
    match level.to_ascii_lowercase().as_str() {
        "debug" => log::LevelFilter::Debug,
        "info" => log::LevelFilter::Info,
        "warn" => log::LevelFilter::Warn,
        "error" => log::LevelFilter::Error,
        _ => log::LevelFilter::Info,
    }
}

// ─── Ollama API Key (OS keychain) ──────────────────────────────────

const OLLAMA_KEY_ENTRY: &str = "netsh_ollama_api_key";

/// Save the Ollama API key to the OS keychain, or delete it when `None`/empty.
pub fn save_ollama_api_key(key: Option<String>) -> Result<(), String> {
    match key {
        Some(k) if !k.is_empty() => keyring::Entry::new("netsh", OLLAMA_KEY_ENTRY)
            .and_then(|e| e.set_password(&k))
            .map_err(|e| e.to_string()),
        _ => keyring::Entry::new("netsh", OLLAMA_KEY_ENTRY)
            .and_then(|e| e.delete_credential())
            .or_else(|e| {
                // Deleting a non-existent entry is not an error.
                if matches!(e, keyring::Error::NoEntry) { Ok(()) } else { Err(e) }
            })
            .map_err(|e| e.to_string()),
    }
}

/// Get the Ollama API key from the OS keychain. `None` when unset.
pub fn get_ollama_api_key() -> Result<Option<String>, String> {
    match keyring::Entry::new("netsh", OLLAMA_KEY_ENTRY).and_then(|e| e.get_password()) {
        Ok(k) => Ok(Some(k)),
        Err(e) if matches!(e, keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

// ─── Provider secrets (OS keychain) ────────────────────────────────

/// Save a provider secret (PAT, session key) to the OS keychain under
/// `netsh_provider_<id>`, or delete it when `None`/empty.
pub fn save_provider_secret(id: &str, secret: Option<String>) -> Result<(), String> {
    let entry = keyring::Entry::new("netsh", &format!("netsh_provider_{}", id))
        .map_err(|e| e.to_string())?;
    match secret {
        Some(k) if !k.is_empty() => entry.set_password(&k).map_err(|e| e.to_string()),
        _ => entry
            .delete_credential()
            .or_else(|e| {
                // Deleting a non-existent entry is not an error.
                if matches!(e, keyring::Error::NoEntry) { Ok(()) } else { Err(e) }
            })
            .map_err(|e| e.to_string()),
    }
}

/// Get a provider secret from the OS keychain. `None` when unset.
pub fn get_provider_secret(id: &str) -> Result<Option<String>, String> {
    match keyring::Entry::new("netsh", &format!("netsh_provider_{}", id))
        .and_then(|e| e.get_password())
    {
        Ok(k) => Ok(Some(k)),
        Err(e) if matches!(e, keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

// ─── Config Store ──────────────────────────────────────────────────

pub struct ConfigStore {
    config_path: PathBuf,
    config: AppConfig,
}

impl ConfigStore {
    /// Create a new ConfigStore backed by config.json in `data_dir`.
    pub fn new(data_dir: &std::path::Path) -> Result<Self, String> {
        crate::paths::ensure_data_dir(data_dir)
            .map_err(|e| format!("Failed to create data dir: {}", e))?;
        let config_path = data_dir.join("config.json");
        migrate_plaintext_api_key(&config_path);
        let mut config = load_config_from_file(&config_path);
        config.ollama_api_key = get_ollama_api_key().ok().flatten();

        Ok(ConfigStore {
            config_path,
            config,
        })
    }

    /// Create a ConfigStore with an explicit path (for fallback scenarios).
    pub fn new_with_path(config_path: PathBuf) -> Result<Self, String> {
        if let Some(parent) = config_path.parent() {
            crate::paths::ensure_data_dir(parent)
                .map_err(|e| format!("Failed to create config dir: {}", e))?;
        }
        let mut config = load_config_from_file(&config_path);
        config.ollama_api_key = get_ollama_api_key().ok().flatten();
        Ok(ConfigStore {
            config_path,
            config,
        })
    }

    /// Get the current config.
    pub fn get(&self) -> &AppConfig {
        &self.config
    }

    /// Update Ollama settings and persist. The API key is stored in the OS
    /// keychain, not in config.json.
    pub fn save_ollama_settings(
        &mut self,
        base_url: String,
        model: String,
        api_key: Option<String>,
        context_length: u32,
    ) -> Result<(), String> {
        save_ollama_api_key(api_key.clone())?;
        self.config.ollama_base_url = base_url;
        self.config.ollama_model = model;
        self.config.ollama_api_key = api_key;
        self.config.ollama_context_length = context_length;
        self.persist()
    }

    /// Update the log level and persist.
    pub fn save_log_level(&mut self, level: String) -> Result<(), String> {
        self.config.log_level = level;
        self.persist()
    }

    /// Update the log file size cap (MB, 0 = off) and persist.
    pub fn save_log_max_size_mb(&mut self, max_mb: u32) -> Result<(), String> {
        self.config.log_max_size_mb = max_mb;
        self.persist()
    }

    /// Update the custom log file path (None = default) and persist.
    pub fn save_log_file_path(&mut self, path: Option<String>) -> Result<(), String> {
        self.config.log_file_path = path;
        self.persist()
    }

    // ─── Provider config (chunk 6) ─────────────────────────────────

    /// Non-secret provider config for `id` (None when unset).
    pub fn provider_config(&self, id: &str) -> Option<&serde_json::Value> {
        self.config.providers.get(id)
    }

    /// Whether the provider is enabled in config.
    pub fn provider_enabled(&self, id: &str) -> bool {
        self.config
            .providers
            .get(id)
            .and_then(|v| v.get("enabled"))
            .and_then(|e| e.as_bool())
            .unwrap_or(false)
    }

    /// Replace a provider's non-secret config and persist.
    pub fn save_provider_config(&mut self, id: String, value: serde_json::Value) -> Result<(), String> {
        self.config.providers.insert(id, value);
        self.persist()
    }

    /// Remove a provider's config (and its keyring secret) and persist.
    pub fn clear_provider(&mut self, id: &str) -> Result<(), String> {
        self.config.providers.remove(id);
        save_provider_secret(id, None)?;
        self.persist()
    }

    /// Get the writable KB path (in app data directory).
    pub fn user_kb_path(&self) -> PathBuf {
        self.config_path
            .parent()
            .unwrap_or_else(|| std::path::Path::new("."))
            .join("knowledge-base")
    }

    fn persist(&self) -> Result<(), String> {
        let json = serde_json::to_string_pretty(&self.config)
            .map_err(|e| format!("Failed to serialize config: {}", e))?;
        crate::paths::secure_write(&self.config_path, json.as_bytes())
            .map_err(|e| format!("Failed to write config file: {}", e))?;
        log::info!("Config saved to {}", self.config_path.display());
        Ok(())
    }
}

/// One-time migration: move `ollama_api_key` out of config.json into the OS
/// keychain. The file is left untouched — the next `persist()` drops the
/// field naturally because `AppConfig` no longer has it.
fn migrate_plaintext_api_key(config_path: &std::path::Path) {
    let raw = match std::fs::read_to_string(config_path) {
        Ok(raw) => raw,
        Err(_) => return,
    };
    let v = match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(v) => v,
        Err(_) => return,
    };
    let Some(key) = v.get("ollama_api_key").and_then(|k| k.as_str()) else {
        return;
    };
    if key.is_empty() {
        return;
    }
    // Only migrate if the keychain has no key — don't clobber a newer key
    // set via the settings UI on another machine.
    if get_ollama_api_key().ok().flatten().is_none() {
        match save_ollama_api_key(Some(key.to_string())) {
            Ok(()) => log::info!("Migrated ollama_api_key from config.json to keychain"),
            Err(e) => log::warn!("Failed to migrate ollama_api_key to keychain: {} (re-enter in Settings)", e),
        }
    }
}

/// Load config from JSON file, returning default on any error.
fn load_config_from_file(path: &PathBuf) -> AppConfig {
    match std::fs::read_to_string(path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_else(|e| {
            log::error!("Failed to parse config.json: {}. Preserving as .corrupt.", e);
            crate::paths::preserve_corrupt(path);
            AppConfig::default()
        }),
        Err(_) => AppConfig::default(),
    }
}

// ─── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_config() {
        let config = AppConfig::default();
        assert_eq!(config.ollama_base_url, "http://localhost:11434");
        assert_eq!(config.ollama_model, "gemma4:26b");
        assert_eq!(config.ollama_context_length, 64000);
        assert_eq!(config.log_level, "info");
        assert_eq!(config.log_max_size_mb, 10);
        assert!(config.log_file_path.is_none());
    }

    #[test]
    fn test_config_serialization_roundtrip() {
        let config = AppConfig::default();
        let json = serde_json::to_string(&config).unwrap();
        let parsed: AppConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.ollama_base_url, config.ollama_base_url);
        assert_eq!(parsed.ollama_model, config.ollama_model);
        assert_eq!(parsed.log_level, config.log_level);
        assert!(parsed.log_file_path.is_none());

        let mut custom = AppConfig::default();
        custom.log_file_path = Some("/var/log/netsh/netsh.log".to_string());
        let json = serde_json::to_string(&custom).unwrap();
        let parsed: AppConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.log_file_path.as_deref(), Some("/var/log/netsh/netsh.log"));
    }

    #[test]
    fn test_log_file_path_persist_and_read() {
        let dir = std::env::temp_dir().join(format!("netsh_test_{}", uuid::Uuid::new_v4()));
        let config_path = dir.join("config.json");
        let mut store = ConfigStore::new_with_path(config_path.clone()).unwrap();
        store.save_log_file_path(Some("/var/log/netsh/netsh.log".to_string())).unwrap();

        let fresh = ConfigStore::new_with_path(config_path.clone()).unwrap();
        assert_eq!(
            fresh.get().log_file_path.as_deref(),
            Some("/var/log/netsh/netsh.log")
        );

        // Reset to default
        store.save_log_file_path(None).unwrap();
        let fresh = ConfigStore::new_with_path(config_path).unwrap();
        assert!(fresh.get().log_file_path.is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_parse_log_level_filter() {
        assert_eq!(parse_log_level_filter("debug"), log::LevelFilter::Debug);
        assert_eq!(parse_log_level_filter("INFO"), log::LevelFilter::Info);
        assert_eq!(parse_log_level_filter("warn"), log::LevelFilter::Warn);
        assert_eq!(parse_log_level_filter("error"), log::LevelFilter::Error);
        assert_eq!(parse_log_level_filter("bogus"), log::LevelFilter::Info);
    }

    #[test]
    fn test_save_and_get_ollama_api_key() {
        // Best-effort: skip when the OS keychain is unavailable (e.g. CI).
        let probe = keyring::Entry::new("netsh", "netsh_test_probe");
        if probe.is_err() {
            return;
        }
        let test_key = "test-ollama-key-123";
        // Note: Windows Credential Manager has a session-scoping quirk where
        // a credential written by one Entry instance may not be visible from
        // a subsequent Entry instance in the same process. We verify the
        // roundtrip within a single Entry, then clean up.
        let entry = keyring::Entry::new("netsh", OLLAMA_KEY_ENTRY).unwrap();
        entry.set_password(test_key).unwrap();
        assert_eq!(entry.get_password().unwrap(), test_key);
        entry.delete_credential().unwrap();
        // After delete, get should return NoEntry
        let e2 = keyring::Entry::new("netsh", OLLAMA_KEY_ENTRY).unwrap();
        assert!(matches!(e2.get_password(), Err(keyring::Error::NoEntry)));
    }

    #[test]
    fn test_migrate_plaintext_key() {
        let dir = std::env::temp_dir().join(format!("netsh_test_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config_path = dir.join("config.json");
        std::fs::write(
            &config_path,
            r#"{"ollama_base_url":"http://localhost:11434","ollama_model":"gemma4:26b","ollama_api_key":"migrate-me","ollama_context_length":64000,"log_level":"debug","log_max_size_mb":10}"#,
        )
        .unwrap();

        // Migration reads the plaintext key and attempts keychain write.
        // The keychain write may silently no-op on some platforms (Windows
        // Credential Manager session scoping), so we verify the file-level
        // behavior: the file is untouched by migration, and the next
        // persist() drops the field because AppConfig no longer serializes it.
        migrate_plaintext_api_key(&config_path);

        // File untouched by migration
        let raw = std::fs::read_to_string(&config_path).unwrap();
        assert!(raw.contains("migrate-me"));

        // Persisting rewrites the file without the api_key field
        let mut store = ConfigStore::new_with_path(config_path.clone()).unwrap();
        store.save_log_level("debug".to_string()).unwrap();
        let raw = std::fs::read_to_string(&config_path).unwrap();
        assert!(!raw.contains("ollama_api_key"));
        assert!(!raw.contains("migrate-me"));
        assert!(raw.contains("\"log_level\": \"debug\""));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_provider_config_roundtrip() {
        let dir = std::env::temp_dir().join(format!("netsh_test_{}", uuid::Uuid::new_v4()));
        let config_path = dir.join("config.json");
        let mut store = ConfigStore::new_with_path(config_path.clone()).unwrap();

        store
            .save_provider_config(
                "proton".into(),
                serde_json::json!({"enabled": true, "org": "acme"}),
            )
            .unwrap();
        assert!(store.provider_enabled("proton"));
        assert_eq!(
            store.provider_config("proton").unwrap().get("org"),
            Some(&serde_json::json!("acme"))
        );

        // Reload from disk: providers map survives, unknown provider disabled.
        let fresh = ConfigStore::new_with_path(config_path.clone()).unwrap();
        assert!(fresh.provider_enabled("proton"));
        assert!(!fresh.provider_enabled("bitwarden"));
        assert!(fresh.provider_config("bitwarden").is_none());

        // clear_provider removes the config entry.
        store.clear_provider("proton").unwrap();
        let fresh = ConfigStore::new_with_path(config_path).unwrap();
        assert!(!fresh.provider_enabled("proton"));
        assert!(fresh.provider_config("proton").is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_legacy_config_without_providers_key() {
        // Configs written before chunk 6 have no `providers` field — must load.
        let v: AppConfig = serde_json::from_str(
            r#"{"ollama_base_url":"http://localhost:11434","ollama_model":"gemma4:26b","log_level":"info","log_max_size_mb":10}"#,
        )
        .unwrap();
        assert!(v.providers.is_empty());
    }

    #[test]
    fn test_save_and_get_provider_secret() {
        // Best-effort: skip when the OS keychain is unavailable (e.g. CI).
        if keyring::Entry::new("netsh", "netsh_test_probe").is_err() {
            return;
        }
        let id = format!("test_{}", uuid::Uuid::new_v4());
        // Windows Credential Manager has a session-scoping quirk where a
        // credential written by one Entry instance may not be visible from a
        // subsequent Entry instance in the same process. Verify the roundtrip
        // within a single Entry, then clean up (same approach as the ollama
        // key test above).
        let entry = keyring::Entry::new("netsh", &format!("netsh_provider_{}", id)).unwrap();
        entry.set_password("pat-123").unwrap();
        assert_eq!(entry.get_password().unwrap(), "pat-123");
        entry.delete_credential().unwrap();

        // Wrapper: deleting a missing entry is not an error.
        save_provider_secret(&id, None).unwrap();
    }
}
