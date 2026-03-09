//! Knowledge Base loader and query engine
//!
//! Loads YAML command files per platform into an in-memory index.
//! Supports fast prefix matching for the suggestion engine.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

// ─── Structs ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlatformIndex {
    pub id: String,
    pub name: String,
    pub description: String,
    pub reference_url: String,
    pub versions: Vec<String>,
    pub prompt_patterns: HashMap<String, String>,
    pub default_mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Command {
    pub name: String,
    pub syntax: String,
    pub description: String,
    pub category: String,
    pub mode: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub examples: Vec<CommandExample>,
    #[serde(default)]
    pub versions: CommandVersions,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandExample {
    pub command: String,
    pub description: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CommandVersions {
    pub introduced: Option<String>,
    pub deprecated: Option<String>,
    pub notes: Option<String>,
}

/// Wrapper for deserializing command YAML files (they have a top-level `commands:` key)
#[derive(Debug, Deserialize)]
struct CommandFile {
    commands: Vec<Command>,
}

// ─── KbStore ────────────────────────────────────────────────────────

/// In-memory store for a single platform's KB data.
pub struct KbStore {
    pub platform: PlatformIndex,
    pub commands: Vec<Command>,
}

impl KbStore {
    /// Load a platform from disk.
    pub fn load(platform_id: &str, kb_path: &Path) -> Result<Self, String> {
        let platform_dir = kb_path.join(platform_id);
        if !platform_dir.exists() {
            return Err(format!("Platform directory not found: {}", platform_dir.display()));
        }

        // Load index.yaml
        let index_path = platform_dir.join("index.yaml");
        let index_content = std::fs::read_to_string(&index_path)
            .map_err(|e| format!("Failed to read {}: {}", index_path.display(), e))?;
        let platform: PlatformIndex = serde_yml::from_str(&index_content)
            .map_err(|e| format!("Failed to parse {}: {}", index_path.display(), e))?;

        // Load all command YAML files
        let commands_dir = platform_dir.join("commands");
        let mut commands: Vec<Command> = Vec::new();

        if commands_dir.exists() {
            let entries = std::fs::read_dir(&commands_dir)
                .map_err(|e| format!("Failed to read commands dir: {}", e))?;

            for entry in entries {
                let entry = entry.map_err(|e| format!("Failed to read dir entry: {}", e))?;
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) == Some("yaml") {
                    let content = std::fs::read_to_string(&path)
                        .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
                    let cmd_file: CommandFile = serde_yml::from_str(&content)
                        .map_err(|e| format!("Failed to parse {}: {}", path.display(), e))?;
                    commands.extend(cmd_file.commands);
                }
            }
        }

        // Sort alphabetically by name
        commands.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

        log::info!("KB loaded platform '{}': {} commands", platform_id, commands.len());

        Ok(KbStore { platform, commands })
    }

    /// Query commands by prefix, mode, and version.
    pub fn query(
        &self,
        prefix: &str,
        mode: Option<&str>,
        version: Option<&str>,
        limit: usize,
    ) -> Vec<&Command> {
        let lower_prefix = prefix.to_lowercase();
        let host_major = version.and_then(|v| parse_major_version(v));

        let mut name_matches: Vec<&Command> = Vec::new();
        let mut alias_matches: Vec<&Command> = Vec::new();

        for cmd in &self.commands {
            // Mode filter
            if let Some(m) = mode {
                if !m.is_empty() && cmd.mode != m {
                    continue;
                }
            }

            // Version filter
            if let Some(host_maj) = host_major {
                if let Some(ref intro) = cmd.versions.introduced {
                    if let Some(intro_maj) = parse_major_version(intro) {
                        if intro_maj > host_maj {
                            continue;
                        }
                    }
                }
                if let Some(ref depr) = cmd.versions.deprecated {
                    if let Some(depr_maj) = parse_major_version(depr) {
                        if depr_maj <= host_maj {
                            continue;
                        }
                    }
                }
            }

            // Empty prefix → return all (filtered by mode/version)
            if lower_prefix.is_empty() {
                name_matches.push(cmd);
                continue;
            }

            // Name prefix match
            if cmd.name.to_lowercase().starts_with(&lower_prefix) {
                name_matches.push(cmd);
                continue;
            }

            // Alias prefix match
            let mut alias_matched = false;
            for alias in &cmd.aliases {
                if alias.to_lowercase().starts_with(&lower_prefix) {
                    alias_matched = true;
                    break;
                }
            }
            if alias_matched {
                alias_matches.push(cmd);
            }
        }

        // Name matches first, then alias matches
        let mut results: Vec<&Command> = Vec::new();
        results.extend(name_matches);
        results.extend(alias_matches);
        results.truncate(limit);
        results
    }
}

/// Parse major version from a version string ("17.6" → 17)
fn parse_major_version(version: &str) -> Option<u32> {
    let cleaned = version.trim();
    if cleaned.is_empty() {
        return None;
    }
    let first_segment = cleaned.split('.').next()?;
    let numeric: String = first_segment.chars().take_while(|c| c.is_ascii_digit()).collect();
    numeric.parse().ok()
}

// ─── Global KB Manager ─────────────────────────────────────────────

/// Manages loaded KB stores, one per platform.
pub struct KbManager {
    stores: HashMap<String, KbStore>,
    kb_path: PathBuf,
}

impl KbManager {
    pub fn new(kb_path: PathBuf) -> Self {
        KbManager {
            stores: HashMap::new(),
            kb_path,
        }
    }

    /// Get or load a platform's KB store.
    pub fn get_or_load(&mut self, platform_id: &str) -> Result<&KbStore, String> {
        if !self.stores.contains_key(platform_id) {
            let store = KbStore::load(platform_id, &self.kb_path)?;
            self.stores.insert(platform_id.to_string(), store);
        }
        self.stores.get(platform_id).ok_or_else(|| "Store not found after load".to_string())
    }

    /// Query a platform's KB.
    pub fn query(
        &mut self,
        platform_id: &str,
        prefix: &str,
        mode: Option<&str>,
        version: Option<&str>,
    ) -> Result<Vec<Command>, String> {
        let store = self.get_or_load(platform_id)?;
        let results = store.query(prefix, mode, version, 50);
        log::debug!("KB query: platform='{}' prefix='{}' mode={:?} → {} results",
            platform_id, prefix, mode, results.len());
        Ok(results.into_iter().cloned().collect())
    }

    /// Get a platform's index.
    pub fn get_platform_index(&mut self, platform_id: &str) -> Result<PlatformIndex, String> {
        let store = self.get_or_load(platform_id)?;
        Ok(store.platform.clone())
    }
}

// ─── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn get_kb_path() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("knowledge-base")
    }

    #[test]
    fn test_load_cisco_iosxe() {
        let kb_path = get_kb_path();
        let store = KbStore::load("cisco-iosxe", &kb_path).unwrap();
        assert_eq!(store.platform.id, "cisco-iosxe");
        assert!(!store.commands.is_empty());
    }

    #[test]
    fn test_prefix_match_show_ip() {
        let kb_path = get_kb_path();
        let store = KbStore::load("cisco-iosxe", &kb_path).unwrap();
        let results = store.query("show ip", None, None, 50);
        assert!(!results.is_empty());
        for cmd in &results {
            let name_match = cmd.name.to_lowercase().starts_with("show ip");
            let alias_match = cmd.aliases.iter().any(|a| a.to_lowercase().starts_with("show ip"));
            assert!(name_match || alias_match, "Command '{}' doesn't match 'show ip'", cmd.name);
        }
    }

    #[test]
    fn test_mode_filter() {
        let kb_path = get_kb_path();
        let store = KbStore::load("cisco-iosxe", &kb_path).unwrap();
        let results = store.query("", Some("privileged-exec"), None, 50);
        for cmd in &results {
            assert_eq!(cmd.mode, "privileged-exec", "Command '{}' has wrong mode", cmd.name);
        }
    }

    #[test]
    fn test_empty_prefix_returns_all() {
        let kb_path = get_kb_path();
        let store = KbStore::load("cisco-iosxe", &kb_path).unwrap();
        let all = store.query("", None, None, 100);
        assert_eq!(all.len(), store.commands.len().min(100));
    }

    #[test]
    fn test_case_insensitive() {
        let kb_path = get_kb_path();
        let store = KbStore::load("cisco-iosxe", &kb_path).unwrap();
        let upper = store.query("SHOW", None, None, 50);
        let lower = store.query("show", None, None, 50);
        assert_eq!(upper.len(), lower.len());
    }

    #[test]
    fn test_no_match() {
        let kb_path = get_kb_path();
        let store = KbStore::load("cisco-iosxe", &kb_path).unwrap();
        let results = store.query("zzzznotacommand", None, None, 50);
        assert!(results.is_empty());
    }

    #[test]
    fn test_parse_major_version() {
        assert_eq!(parse_major_version("17.6"), Some(17));
        assert_eq!(parse_major_version("16.12.4a"), Some(16));
        assert_eq!(parse_major_version("12.0"), Some(12));
        assert_eq!(parse_major_version(""), None);
    }

    #[test]
    fn test_alias_match() {
        let kb_path = get_kb_path();
        let store = KbStore::load("cisco-iosxe", &kb_path).unwrap();
        let results = store.query("sh ip int", None, None, 50);
        assert!(!results.is_empty(), "Should match via alias 'sh ip int br'");
    }
}
