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
    #[serde(default = "default_ollama_api_key")]
    pub ollama_api_key: Option<String>,
    #[serde(default = "default_ollama_context_length")]
    pub ollama_context_length: u32,
}

impl Default for AppConfig {
    fn default() -> Self {
        AppConfig {
            ollama_base_url: default_ollama_base_url(),
            ollama_model: default_ollama_model(),
            ollama_api_key: default_ollama_api_key(),
            ollama_context_length: default_ollama_context_length(),
        }
    }
}

fn default_ollama_base_url() -> String {
    "http://localhost:11434".to_string()
}

fn default_ollama_model() -> String {
    "gemma4:26b".to_string()
}

fn default_ollama_api_key() -> Option<String> {
    None
}

fn default_ollama_context_length() -> u32 {
    64000
}

// ─── Config Store ──────────────────────────────────────────────────

pub struct ConfigStore {
    config_path: PathBuf,
    config: AppConfig,
}

impl ConfigStore {
    /// Create a new ConfigStore backed by config.json in the app data directory.
    pub fn new() -> Result<Self, String> {
        let data_dir = dirs::data_dir()
            .ok_or_else(|| "Could not find app data directory".to_string())?
            .join("netsh");

        std::fs::create_dir_all(&data_dir)
            .map_err(|e| format!("Failed to create data dir: {}", e))?;

        let config_path = data_dir.join("config.json");
        let config = load_config_from_file(&config_path);

        Ok(ConfigStore {
            config_path,
            config,
        })
    }

    /// Create a ConfigStore with an explicit path (for fallback scenarios).
    pub fn new_with_path(config_path: PathBuf) -> Result<Self, String> {
        if let Some(parent) = config_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create config dir: {}", e))?;
        }
        let config = load_config_from_file(&config_path);
        Ok(ConfigStore {
            config_path,
            config,
        })
    }

    /// Get the current config.
    pub fn get(&self) -> &AppConfig {
        &self.config
    }

    /// Update Ollama settings and persist.
    pub fn save_ollama_settings(
        &mut self,
        base_url: String,
        model: String,
        api_key: Option<String>,
        context_length: u32,
    ) -> Result<(), String> {
        self.config.ollama_base_url = base_url;
        self.config.ollama_model = model;
        self.config.ollama_api_key = api_key;
        self.config.ollama_context_length = context_length;
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
        std::fs::write(&self.config_path, json)
            .map_err(|e| format!("Failed to write config file: {}", e))?;
        log::info!("Config saved to {}", self.config_path.display());
        Ok(())
    }
}

/// Load config from JSON file, returning default on any error.
fn load_config_from_file(path: &PathBuf) -> AppConfig {
    match std::fs::read_to_string(path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_else(|e| {
            log::warn!("Failed to parse config.json: {}. Using defaults.", e);
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
        assert!(config.ollama_api_key.is_none());
        assert_eq!(config.ollama_context_length, 64000);
    }

    #[test]
    fn test_config_serialization_roundtrip() {
        let config = AppConfig::default();
        let json = serde_json::to_string(&config).unwrap();
        let parsed: AppConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.ollama_base_url, config.ollama_base_url);
        assert_eq!(parsed.ollama_model, config.ollama_model);
    }
}
