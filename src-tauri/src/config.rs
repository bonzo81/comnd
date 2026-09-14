//! Application configuration — persisted settings for the LLM API, KB paths, etc.
//!
//! Config lives in the app data directory as `config.json`,
//! alongside `hosts.json` and `credentials.json`.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Emitter;
use crate::state::AppState;

// ─── Types ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    /// LLM API wire format: "openai" (OpenAI-compatible) or "anthropic".
    /// Any provider is reachable via base_url; the format only selects the
    /// endpoint/auth shape.
    #[serde(default = "default_llm_api_format")]
    pub llm_api_format: String,
    #[serde(default = "default_llm_base_url", alias = "ollama_base_url")]
    pub llm_base_url: String,
    #[serde(default = "default_llm_model", alias = "ollama_model")]
    pub llm_model: String,
    /// Transient — loaded from the OS keychain at runtime, never persisted
    /// to config.json.
    #[serde(skip)]
    pub llm_api_key: Option<String>,
    #[serde(default = "default_llm_context_length", alias = "ollama_context_length")]
    pub llm_context_length: u32,
    #[serde(default = "default_log_level")]
    pub log_level: String,
    #[serde(default = "default_log_max_size_mb")]
    pub log_max_size_mb: u32,
    #[serde(default)]
    pub log_file_path: Option<String>,
    /// Maximum concurrent SSH sessions. Default 30. 0 = unlimited.
    #[serde(default = "default_max_sessions")]
    pub max_sessions: u32,
    /// Per-session output logging to file. Default true.
    #[serde(default = "default_true")]
    pub session_logging: bool,
    /// Include `[HH:MM:SS]` timestamp per chunk in session logs. Default true.
    #[serde(default = "default_true")]
    pub session_log_timestamps: bool,
    /// Custom session log directory. `None` = default `<data_dir>/session-logs`.
    #[serde(default)]
    pub session_log_dir: Option<String>,
    /// Per-provider settings (chunk 6+). Key = provider id, value =
    /// provider-specific JSON parsed by that provider. Secrets never live
    /// here — they go in the OS keychain (`netssh_provider_<id>`).
    #[serde(default)]
    pub providers: std::collections::HashMap<String, serde_json::Value>,
    /// Host source integrations (NetBox, future LibreNMS). Key = source id,
    /// value = source-specific JSON. Mirrors `providers`; secrets never live
    /// here — they go in the OS keyring (`netssh_source_<id>_*`).
    #[serde(default)]
    pub host_sources: std::collections::HashMap<String, serde_json::Value>,
}

impl Default for AppConfig {
    fn default() -> Self {
        AppConfig {
            llm_api_format: default_llm_api_format(),
            llm_base_url: default_llm_base_url(),
            llm_model: default_llm_model(),
            llm_api_key: None,
            llm_context_length: default_llm_context_length(),
            log_level: default_log_level(),
            log_max_size_mb: default_log_max_size_mb(),
            log_file_path: None,
            max_sessions: default_max_sessions(),
            session_logging: true,
            session_log_timestamps: true,
            session_log_dir: None,
            providers: Default::default(),
            host_sources: Default::default(),
        }
    }
}

fn default_llm_api_format() -> String {
    "openai".to_string()
}

fn default_llm_base_url() -> String {
    "http://localhost:11434".to_string()
}

fn default_llm_model() -> String {
    String::new()
}

fn default_llm_context_length() -> u32 {
    64000
}

fn default_log_level() -> String {
    "info".to_string()
}

fn default_log_max_size_mb() -> u32 {
    10
}

fn default_max_sessions() -> u32 {
    30
}

fn default_true() -> bool {
    true
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

// ─── LLM API Key (OS keychain) ─────────────────────────────────────

// ponytail: entry name predates the provider-generic rename; keep so existing
// users don't lose their stored key.
const LLM_KEY_ENTRY: &str = "netssh_ollama_api_key";

/// Save the LLM API key to the OS keychain, or delete it when `None`/empty.
pub fn save_llm_api_key(key: Option<String>) -> Result<(), String> {
    match key {
        Some(k) if !k.is_empty() => keyring::Entry::new("netssh", LLM_KEY_ENTRY)
            .and_then(|e| e.set_password(&k))
            .map_err(|e| e.to_string()),
        _ => keyring::Entry::new("netssh", LLM_KEY_ENTRY)
            .and_then(|e| e.delete_credential())
            .or_else(|e| {
                // Deleting a non-existent entry is not an error.
                if matches!(e, keyring::Error::NoEntry) { Ok(()) } else { Err(e) }
            })
            .map_err(|e| e.to_string()),
    }
}

/// Get the LLM API key from the OS keychain. `None` when unset.
pub fn get_llm_api_key() -> Result<Option<String>, String> {
    match keyring::Entry::new("netssh", LLM_KEY_ENTRY).and_then(|e| e.get_password()) {
        Ok(k) => Ok(Some(k)),
        Err(e) if matches!(e, keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

// ─── Provider secrets (OS keychain) ────────────────────────────────

/// Save a provider secret (PAT, session key) to the OS keychain under
/// `netssh_provider_<id>`, or delete it when `None`/empty.
pub fn save_provider_secret(id: &str, secret: Option<String>) -> Result<(), String> {
    let entry = keyring::Entry::new("netssh", &format!("netssh_provider_{}", id))
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
    match keyring::Entry::new("netssh", &format!("netssh_provider_{}", id))
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
        config.llm_api_key = get_llm_api_key().ok().flatten();

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
        config.llm_api_key = get_llm_api_key().ok().flatten();
        Ok(ConfigStore {
            config_path,
            config,
        })
    }

    /// Create an in-memory-only ConfigStore (fallback if filesystem fails).
    /// `persist()` will be a no-op (writes to a path that nothing reads back),
    /// but all get/set operations work for the session.
    pub fn in_memory() -> Self {
        let path = std::env::temp_dir().join("netssh-config-in-memory.json");
        ConfigStore {
            config_path: path,
            config: AppConfig::default(),
        }
    }

    /// Get the current config.
    pub fn get(&self) -> &AppConfig {
        &self.config
    }

    /// Update LLM API settings and persist. The API key is stored in the OS
    /// keychain, not in config.json.
    pub fn save_llm_settings(
        &mut self,
        api_format: String,
        base_url: String,
        model: String,
        api_key: Option<String>,
        context_length: u32,
    ) -> Result<(), String> {
        save_llm_api_key(api_key.clone())?;
        self.config.llm_api_format = api_format;
        self.config.llm_base_url = base_url;
        self.config.llm_model = model;
        self.config.llm_api_key = api_key;
        self.config.llm_context_length = context_length;
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

    /// Update the max concurrent SSH sessions and persist.
    pub fn save_max_sessions(&mut self, max: u32) -> Result<(), String> {
        self.config.max_sessions = max;
        self.persist()
    }

    /// Update session logging enabled/disabled and persist.
    pub fn save_session_logging(&mut self, enabled: bool) -> Result<(), String> {
        self.config.session_logging = enabled;
        self.persist()
    }

    /// Update session log timestamps enabled/disabled and persist.
    pub fn save_session_log_timestamps(&mut self, enabled: bool) -> Result<(), String> {
        self.config.session_log_timestamps = enabled;
        self.persist()
    }

    /// Update custom session log directory and persist. `None` = use default.
    pub fn save_session_log_dir(&mut self, dir: Option<String>) -> Result<(), String> {
        self.config.session_log_dir = dir;
        self.persist()
    }

    // ─── Provider config (chunk 6) ─────────────────────────────────

    /// Non-secret provider config for `id` (None when unset).
    #[cfg(test)]
    pub fn provider_config(&self, id: &str) -> Option<&serde_json::Value> {
        self.config.providers.get(id)
    }

    /// Whether the provider is enabled in config.
    #[cfg(test)]
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

    // ─── Host source config (NetBox plan §8.1) ─────────────────────

    /// Non-secret host source config for `id` (None when unset).
    pub fn host_source_config(&self, id: &str) -> Option<&serde_json::Value> {
        self.config.host_sources.get(id)
    }

    /// Whether the host source is enabled in config.
    pub fn host_source_enabled(&self, id: &str) -> bool {
        self.config
            .host_sources
            .get(id)
            .and_then(|v| v.get("enabled"))
            .and_then(|e| e.as_bool())
            .unwrap_or(false)
    }

    /// Replace a host source's non-secret config and persist.
    pub fn save_host_source_config(&mut self, id: &str, value: serde_json::Value) -> Result<(), String> {
        self.config.host_sources.insert(id.to_string(), value);
        self.persist()
    }

    /// Remove a host source's config and persist.
    #[cfg(test)]
    pub fn clear_host_source(&mut self, id: &str) -> Result<(), String> {
        self.config.host_sources.remove(id);
        self.persist()
    }

    /// Remove a provider's config (and its keyring secret) and persist.
    #[cfg(test)]
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
    if get_llm_api_key().ok().flatten().is_none() {
        match save_llm_api_key(Some(key.to_string())) {
            Ok(()) => log::info!("Migrated ollama_api_key from config.json to keychain"),
            Err(e) => log::warn!("Failed to migrate ollama_api_key to keychain: {} (re-enter in Settings)", e),
        }
    }
}

/// Load config from JSON file, returning default on any error.
fn load_config_from_file(path: &PathBuf) -> AppConfig {
    crate::paths::load_json_or_preserve::<AppConfig>(path)
}

// ─── Tauri Commands (config + logging, plan: lib.rs domain split) ───

#[tauri::command]
pub async fn get_app_config(
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let config = state.config.lock().map_err(|e| e.to_string())?;
    let mut v = serde_json::to_value(config.get())
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    // API key lives in the OS keychain, not in config.json.
    if let Some(obj) = v.as_object_mut() {
        obj.insert(
            "llm_api_key".to_string(),
            serde_json::Value::from(get_llm_api_key()?),
        );
    }
    Ok(v)
}

#[tauri::command]
pub async fn save_llm_settings(
    api_format: String,
    base_url: String,
    model: String,
    api_key: Option<String>,
    context_length: u32,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.save_llm_settings(api_format, base_url, model, api_key, context_length)
}

#[tauri::command]
pub async fn get_log_level(
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let config = state.config.lock().map_err(|e| e.to_string())?;
    Ok(config.get().log_level.clone())
}

#[tauri::command]
pub async fn set_log_level(
    level: String,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let level = level.to_ascii_lowercase();
    match level.as_str() {
        "debug" | "info" | "warn" | "error" => {}
        _ => return Err(format!("Invalid log level: {}", level)),
    }

    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.save_log_level(level.clone())?;
    drop(config);

    // simplelog reads the level filter per-record, so both raising and
    // lowering take effect live via log::set_max_level.
    log::set_max_level(parse_log_level_filter(&level));
    log::info!("Log level set to {}", level);

    let _ = app_handle.emit("log-level-changed", &level);
    Ok(())
}

#[tauri::command]
pub async fn set_log_max_size(
    max_mb: u32,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.save_log_max_size_mb(max_mb)?;
    log::info!(
        "Log file size cap set to {}MB (takes effect on next app start)",
        max_mb
    );
    Ok(())
}

#[tauri::command]
pub async fn set_max_sessions(
    max: u32,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.save_max_sessions(max)?;
    log::info!("Max sessions set to {}", if max == 0 { "unlimited".into() } else { max.to_string() });
    Ok(())
}

#[tauri::command]
pub async fn get_session_log_dir() -> Result<String, String> {
    let dir = crate::paths::app_data_dir()?.join("session-logs");
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn set_session_logging(
    enabled: bool,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.save_session_logging(enabled)?;
    Ok(())
}

#[tauri::command]
pub async fn set_session_log_timestamps(
    enabled: bool,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.save_session_log_timestamps(enabled)?;
    Ok(())
}

#[tauri::command]
pub async fn set_session_log_dir(
    dir: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.save_session_log_dir(dir)?;
    Ok(())
}

#[tauri::command]
pub async fn get_log_status(
    state: tauri::State<'_, AppState>,
) -> Result<Option<String>, String> {
    let status = state.log_status.lock().map_err(|e| e.to_string())?;
    Ok(status.clone())
}

#[tauri::command]
pub async fn set_log_file_path(
    path: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.save_log_file_path(path.clone())?;
    log::info!(
        "Log file path set to {} (takes effect on next app start)",
        path.as_deref().unwrap_or("<default>")
    );
    Ok(())
}

#[tauri::command]
pub async fn log_frontend(level: String, tag: String, msg: String, args: Option<String>) -> Result<(), String> {
    let line = match args.as_deref() {
        Some(a) if !a.is_empty() => format!("{} {}", msg, a),
        _ => msg.clone(),
    };
    match level.as_str() {
        "debug" => log::debug!("[fe:{}] {}", tag, line),
        "info" => log::info!("[fe:{}] {}", tag, line),
        "warn" => log::warn!("[fe:{}] {}", tag, line),
        "error" => log::error!("[fe:{}] {}", tag, line),
        _ => return Err("invalid level".into()),
    }
    Ok(())
}

// ─── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_config() {
        let config = AppConfig::default();
        assert_eq!(config.llm_api_format, "openai");
        assert_eq!(config.llm_base_url, "http://localhost:11434");
        assert_eq!(config.llm_model, "");
        assert_eq!(config.llm_context_length, 64000);
        assert_eq!(config.log_level, "info");
        assert_eq!(config.log_max_size_mb, 10);
        assert!(config.log_file_path.is_none());
    }

    #[test]
    fn test_config_serialization_roundtrip() {
        let config = AppConfig::default();
        let json = serde_json::to_string(&config).unwrap();
        let parsed: AppConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.llm_base_url, config.llm_base_url);
        assert_eq!(parsed.llm_model, config.llm_model);
        assert_eq!(parsed.log_level, config.log_level);
        assert!(parsed.log_file_path.is_none());

        let mut custom = AppConfig::default();
        custom.log_file_path = Some("/var/log/netssh/netssh.log".to_string());
        let json = serde_json::to_string(&custom).unwrap();
        let parsed: AppConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.log_file_path.as_deref(), Some("/var/log/netssh/netssh.log"));
    }

    #[test]
    fn test_log_file_path_persist_and_read() {
        let dir = std::env::temp_dir().join(format!("netssh_test_{}", uuid::Uuid::new_v4()));
        let config_path = dir.join("config.json");
        let mut store = ConfigStore::new_with_path(config_path.clone()).unwrap();
        store.save_log_file_path(Some("/var/log/netssh/netssh.log".to_string())).unwrap();

        let fresh = ConfigStore::new_with_path(config_path.clone()).unwrap();
        assert_eq!(
            fresh.get().log_file_path.as_deref(),
            Some("/var/log/netssh/netssh.log")
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
    fn test_save_and_get_llm_api_key() {
        // Best-effort: skip when the OS keychain is unavailable (e.g. CI).
        let probe = keyring::Entry::new("netssh", "netssh_test_probe");
        if probe.is_err() {
            return;
        }
        let test_key = "test-llm-key-123";
        // Note: Windows Credential Manager has a session-scoping quirk where
        // a credential written by one Entry instance may not be visible from
        // a subsequent Entry instance in the same process. We verify the
        // roundtrip within a single Entry, then clean up.
        let id = format!("netssh_test_llm_{}", uuid::Uuid::new_v4());
        let entry = keyring::Entry::new("netssh", &id).unwrap();
        entry.set_password(test_key).unwrap();
        assert_eq!(entry.get_password().unwrap(), test_key);
        entry.delete_credential().unwrap();
        // After delete, get should return NoEntry
        let e2 = keyring::Entry::new("netssh", &id).unwrap();
        assert!(matches!(e2.get_password(), Err(keyring::Error::NoEntry)));
    }

    #[test]
    fn test_migrate_plaintext_key() {
        let dir = std::env::temp_dir().join(format!("netssh_test_{}", uuid::Uuid::new_v4()));
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
        let dir = std::env::temp_dir().join(format!("netssh_test_{}", uuid::Uuid::new_v4()));
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
        // Pre-rename ollama_* fields alias onto the llm_* fields.
        assert_eq!(v.llm_base_url, "http://localhost:11434");
        assert_eq!(v.llm_model, "gemma4:26b");
        assert_eq!(v.llm_api_format, "openai");
    }

    #[test]
    fn test_save_and_get_provider_secret() {
        // Best-effort: skip when the OS keychain is unavailable (e.g. CI).
        if keyring::Entry::new("netssh", "netssh_test_probe").is_err() {
            return;
        }
        let id = format!("test_{}", uuid::Uuid::new_v4());
        // Windows Credential Manager has a session-scoping quirk where a
        // credential written by one Entry instance may not be visible from a
        // subsequent Entry instance in the same process. Verify the roundtrip
        // within a single Entry, then clean up (same approach as the ollama
        // key test above).
        let entry = keyring::Entry::new("netssh", &format!("netssh_provider_{}", id)).unwrap();
        entry.set_password("pat-123").unwrap();
        assert_eq!(entry.get_password().unwrap(), "pat-123");
        entry.delete_credential().unwrap();

        // Wrapper: deleting a missing entry is not an error.
        save_provider_secret(&id, None).unwrap();
    }
}
