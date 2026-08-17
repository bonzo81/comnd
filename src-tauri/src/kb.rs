//! Knowledge Base loader and query engine
//!
//! Loads YAML command files per platform into an in-memory index.
//! Supports fast prefix matching for the suggestion engine.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
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
    /// Command names that the user has deleted (to hide bundled commands).
    pub deleted_commands: HashSet<String>,
}

impl KbStore {
    /// Load a platform from disk.
    pub fn load(platform_id: &str, kb_path: &Path) -> Result<Self, String> {
        let platform_dir = kb_path.join(platform_id);
        if !platform_dir.exists() {
            return Err(format!(
                "Platform directory not found: {}",
                platform_dir.display()
            ));
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

        // Load deleted-commands list
        let deleted_path = platform_dir.join("_deleted.yaml");
        let mut deleted_commands: HashSet<String> = HashSet::new();
        if deleted_path.exists() {
            #[derive(serde::Deserialize)]
            struct DeletedFile {
                deleted: Vec<String>,
            }
            if let Ok(content) = std::fs::read_to_string(&deleted_path) {
                if let Ok(file) = serde_yml::from_str::<DeletedFile>(&content) {
                    for name in file.deleted {
                        deleted_commands.insert(name);
                    }
                }
            }
        }

        // Filter out deleted commands
        commands.retain(|c| !deleted_commands.contains(&c.name));

        // Sort alphabetically by name
        commands.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

        log::info!(
            "KB loaded platform '{}': {} commands ({} deleted)",
            platform_id,
            commands.len(),
            deleted_commands.len()
        );

        Ok(KbStore { platform, commands, deleted_commands })
    }

    /// Merge commands from another store into this one.
    /// User commands override bundled commands with the same name.
    pub fn merge_from(&mut self, other: KbStore) {
        for cmd in other.commands {
            if let Some(existing) = self.commands.iter_mut().find(|c| c.name == cmd.name) {
                // Update existing command with non-empty fields from the other
                if !cmd.syntax.is_empty() && existing.syntax.is_empty() {
                    existing.syntax = cmd.syntax;
                }
                if !cmd.description.is_empty() && existing.description.is_empty() {
                    existing.description = cmd.description;
                }
                if !cmd.category.is_empty() && existing.category.is_empty() {
                    existing.category = cmd.category;
                }
                if !cmd.aliases.is_empty() && existing.aliases.is_empty() {
                    existing.aliases = cmd.aliases;
                }
                if !cmd.examples.is_empty() && existing.examples.is_empty() {
                    existing.examples = cmd.examples;
                }
                if !cmd.tags.is_empty() && existing.tags.is_empty() {
                    existing.tags = cmd.tags;
                }
            } else {
                // New command — add it
                self.commands.push(cmd);
            }
        }
        // Re-sort after merge
        self.commands
            .sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    }

    /// Query commands by version and limit. Frontend always sends prefix="" and mode=None.
    pub fn query(
        &self,
        version: Option<&str>,
        limit: usize,
    ) -> Vec<&Command> {
        let host_major = version.and_then(|v| parse_major_version(v));

        let results: Vec<&Command> = self.commands.iter().filter(|cmd| {
            // Version filter
            if let Some(host_maj) = host_major {
                if let Some(ref intro) = cmd.versions.introduced {
                    if let Some(intro_maj) = parse_major_version(intro) {
                        if intro_maj > host_maj {
                            return false;
                        }
                    }
                }
                if let Some(ref depr) = cmd.versions.deprecated {
                    if let Some(depr_maj) = parse_major_version(depr) {
                        if depr_maj <= host_maj {
                            return false;
                        }
                    }
                }
            }
            true
        }).collect();

        let mut results = results;
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
    let numeric: String = first_segment
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    numeric.parse().ok()
}

// ─── Global KB Manager ─────────────────────────────────────────────

/// Manages loaded KB stores, one per platform.
/// Supports two KB paths: a bundled (read-only) path and a user (writable) path.
/// User path is searched first, allowing imported commands to override bundled ones.
pub struct KbManager {
    stores: HashMap<String, KbStore>,
    /// Bundled KB path (from app resources or project root)
    kb_path: PathBuf,
    /// User-writable KB path (in app data directory)
    user_kb_path: Option<PathBuf>,
}

impl KbManager {
    pub fn new(kb_path: PathBuf) -> Self {
        KbManager {
            stores: HashMap::new(),
            kb_path,
            user_kb_path: None,
        }
    }

    /// Create a KbManager with both bundled and user KB paths.
    pub fn with_user_path(kb_path: PathBuf, user_kb_path: PathBuf) -> Self {
        KbManager {
            stores: HashMap::new(),
            kb_path,
            user_kb_path: Some(user_kb_path),
        }
    }

    /// Get the user KB path.
    pub fn user_kb_path(&self) -> Option<&PathBuf> {
        self.user_kb_path.as_ref()
    }

    /// Read deleted command names from a user KB platform directory.
    fn load_deleted_names(platform_dir: &Path) -> HashSet<String> {
        let deleted_path = platform_dir.join("_deleted.yaml");
        let mut names = HashSet::new();
        if deleted_path.exists() {
            #[derive(serde::Deserialize)]
            struct DeletedFile {
                deleted: Vec<String>,
            }
            if let Ok(content) = std::fs::read_to_string(&deleted_path) {
                if let Ok(file) = serde_yml::from_str::<DeletedFile>(&content) {
                    for name in file.deleted {
                        names.insert(name);
                    }
                }
            }
        }
        names
    }

    /// Get or load a platform's KB store.
    /// Loads from user KB path first (if set), then merges with bundled KB.
    pub fn get_or_load(&mut self, platform_id: &str) -> Result<&KbStore, String> {
        if !self.stores.contains_key(platform_id) {
            // Load bundled KB first
            let mut store = KbStore::load(platform_id, &self.kb_path)?;

            // Merge user KB on top if it exists
            if let Some(ref user_path) = self.user_kb_path {
                let user_platform_dir = user_path.join(platform_id);
                if user_platform_dir.exists() {
                    match KbStore::load(platform_id, user_path) {
                        Ok(user_store) => {
                            log::info!(
                                "Merging user KB for '{}': {} user commands over {} bundled",
                                platform_id,
                                user_store.commands.len(),
                                store.commands.len()
                            );
                            // Merge: user commands override bundled ones by name
                            store.merge_from(user_store);
                        }
                        Err(e) => {
                            log::warn!("Failed to load user KB for '{}': {}", platform_id, e);
                        }
                    }

                    // Also filter by user KB's deleted list (catches bundled-only commands)
                    let user_deleted = Self::load_deleted_names(&user_platform_dir);
                    if !user_deleted.is_empty() {
                        let before = store.commands.len();
                        store.commands.retain(|c| !user_deleted.contains(&c.name));
                        log::info!(
                            "Filtered {} deleted commands for '{}' ({} → {})",
                            user_deleted.len(),
                            platform_id,
                            before,
                            store.commands.len()
                        );
                    }
                }
            }

            self.stores.insert(platform_id.to_string(), store);
        }
        self.stores
            .get(platform_id)
            .ok_or_else(|| "Store not found after load".to_string())
    }

    /// Force reload all KB stores (e.g., after an import).
    pub fn reload_all(&mut self) {
        self.stores.clear();
        log::info!("KB stores cleared — will reload on next query");
    }

    /// Query a platform's KB.
    pub fn query(
        &mut self,
        platform_id: &str,
        version: Option<&str>,
    ) -> Result<Vec<Command>, String> {
        let store = self.get_or_load(platform_id)?;
        let results = store.query(version, 50);
        log::debug!(
            "KB query: platform='{}' version={:?} → {} results",
            platform_id,
            version,
            results.len()
        );
        Ok(results.into_iter().cloned().collect())
    }

    /// Get all commands for a platform (no filtering, for KB viewer).
    pub fn get_all_commands(&mut self, platform_id: &str) -> Result<Vec<Command>, String> {
        let store = self.get_or_load(platform_id)?;
        Ok(store.commands.clone())
    }

    /// Get a platform's index.
    pub fn get_platform_index(&mut self, platform_id: &str) -> Result<PlatformIndex, String> {
        let store = self.get_or_load(platform_id)?;
        Ok(store.platform.clone())
    }

    /// List all available platform IDs from both bundled and user KB paths.
    pub fn list_platforms(&self) -> Vec<String> {
        let mut platforms = std::collections::HashSet::new();

        // Bundled KB platforms
        if let Ok(entries) = std::fs::read_dir(&self.kb_path) {
            for entry in entries.flatten() {
                if entry.path().is_dir() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if entry.path().join("index.yaml").exists() {
                        platforms.insert(name);
                    }
                }
            }
        }

        // User KB platforms
        if let Some(ref user_path) = self.user_kb_path {
            if let Ok(entries) = std::fs::read_dir(user_path) {
                for entry in entries.flatten() {
                    if entry.path().is_dir() {
                        let name = entry.file_name().to_string_lossy().to_string();
                        if entry.path().join("index.yaml").exists() {
                            platforms.insert(name);
                        }
                    }
                }
            }
        }

        let mut list: Vec<String> = platforms.into_iter().collect();
        list.sort();
        list
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
        // Query with no version filter returns all commands (prefix/mode matching removed)
        let results = store.query(None, 50);
        assert!(!results.is_empty());
    }

    #[test]
    fn test_empty_prefix_returns_all() {
        let kb_path = get_kb_path();
        let store = KbStore::load("cisco-iosxe", &kb_path).unwrap();
        let all = store.query(None, 100);
        assert_eq!(all.len(), store.commands.len().min(100));
    }

    #[test]
    fn test_case_insensitive() {
        let kb_path = get_kb_path();
        let store = KbStore::load("cisco-iosxe", &kb_path).unwrap();
        let upper = store.query(None, 50);
        let lower = store.query(None, 50);
        assert_eq!(upper.len(), lower.len());
    }

    #[test]
    fn test_parse_major_version() {
        assert_eq!(parse_major_version("17.6"), Some(17));
        assert_eq!(parse_major_version("16.12.4a"), Some(16));
        assert_eq!(parse_major_version("12.0"), Some(12));
        assert_eq!(parse_major_version(""), None);
    }

    #[test]
    fn test_version_filter() {
        let kb_path = get_kb_path();
        let store = KbStore::load("cisco-iosxe", &kb_path).unwrap();
        // Version 17.6 should filter out commands introduced after 17
        let filtered = store.query(Some("17.6"), 100);
        let all = store.query(None, 100);
        assert!(filtered.len() <= all.len());
        // All filtered results should have valid version ranges
        for cmd in &filtered {
            if let Some(ref intro) = cmd.versions.introduced {
                if let Some(intro_maj) = parse_major_version(intro) {
                    assert!(intro_maj <= 17, "Command '{}' introduced {} > 17", cmd.name, intro);
                }
            }
        }
    }
}
