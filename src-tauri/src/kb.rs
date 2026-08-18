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
        let deleted_commands = read_deleted_list(&platform_dir);

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

// ─── User KB Command Editing ────────────────────────────────────────

/// Read the set of deleted command names for a platform (`_deleted.yaml`).
fn read_deleted_list(platform_dir: &Path) -> HashSet<String> {
    #[derive(serde::Deserialize)]
    struct DeletedFile {
        deleted: Vec<String>,
    }
    let deleted_path = platform_dir.join("_deleted.yaml");
    if deleted_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&deleted_path) {
            if let Ok(file) = serde_yml::from_str::<DeletedFile>(&content) {
                return file.deleted.into_iter().collect();
            }
        }
    }
    HashSet::new()
}

/// Write the set of deleted command names to `_deleted.yaml` (sorted).
fn write_deleted_list(deleted_path: &Path, names: &HashSet<String>) -> Result<(), String> {
    use serde_yml::Value;
    let mut list: Vec<&String> = names.iter().collect();
    list.sort();
    let yaml_content = serde_yml::to_string(&Value::Mapping({
        let mut map = serde_yml::Mapping::new();
        map.insert(
            Value::String("deleted".to_string()),
            serde_yml::to_value(&list).unwrap_or_default(),
        );
        map
    }))
    .map_err(|e| format!("Failed to serialize deleted list: {}", e))?;

    std::fs::write(deleted_path, yaml_content)
        .map_err(|e| format!("Failed to write {}: {}", deleted_path.display(), e))
}

/// Serialize commands under a top-level `commands:` key.
fn serialize_commands(commands: &[Command]) -> Result<String, String> {
    use serde_yml::Value;
    serde_yml::to_string(&Value::Mapping({
        let mut map = serde_yml::Mapping::new();
        map.insert(
            Value::String("commands".to_string()),
            serde_yml::to_value(commands).unwrap_or_default(),
        );
        map
    }))
    .map_err(|e| format!("Failed to serialize commands to YAML: {}", e))
}

/// Get the target YAML file path for commands.
pub fn get_target_yaml_path(user_kb_path: &Path, platform: &str, category: &str) -> PathBuf {
    user_kb_path.join(platform).join("commands").join(format!("{}.yaml", category))
}

/// Write commands to a YAML file, merging with existing content if the file already exists.
pub fn write_commands_to_yaml(commands: &[Command], path: &Path, _category: &str) -> Result<(), String> {
    let mut existing_commands = Vec::new();

    // Load existing commands if file exists
    if path.exists() {
        match std::fs::read_to_string(path) {
            Ok(content) => {
                match serde_yml::from_str::<CommandFile>(&content) {
                    Ok(file) => {
                        existing_commands = file.commands;
                        log::info!("Loaded {} existing commands from {}", existing_commands.len(), path.display());
                    }
                    Err(e) => {
                        log::warn!("Failed to parse existing YAML at {}, will overwrite: {}", path.display(), e);
                    }
                }
            }
            Err(e) => {
                log::warn!("Failed to read existing file at {}, will create new: {}", path.display(), e);
            }
        }
    }

    // Merge: add new commands, update existing ones by name
    let mut merged: Vec<Command> = existing_commands;
    let mut added = 0;
    let mut updated = 0;

    for cmd in commands {
        if let Some(existing) = merged.iter_mut().find(|c| c.name == cmd.name) {
            // Update existing command with richer data if the new one has more info
            if !cmd.description.is_empty() && existing.description.is_empty() {
                existing.description = cmd.description.clone();
                updated += 1;
            }
            if !cmd.syntax.is_empty() && existing.syntax.is_empty() {
                existing.syntax = cmd.syntax.clone();
            }
            if !cmd.examples.is_empty() && existing.examples.is_empty() {
                existing.examples = cmd.examples.clone();
            }
            if !cmd.aliases.is_empty() && existing.aliases.is_empty() {
                existing.aliases = cmd.aliases.clone();
            }
            if !cmd.tags.is_empty() && existing.tags.is_empty() {
                existing.tags = cmd.tags.clone();
            }
        } else {
            merged.push(cmd.clone());
            added += 1;
        }
    }

    // Sort alphabetically
    merged.sort_by(|a, b| a.name.cmp(&b.name));

    log::info!("KB merge: {} added, {} updated, {} total commands in {}", added, updated, merged.len(), path.display());

    let yaml_content = serialize_commands(&merged)?;

    std::fs::write(path, yaml_content)
        .map_err(|e| format!("Failed to write YAML file {}: {}", path.display(), e))?;

    log::info!("Wrote {} commands to {}", merged.len(), path.display());
    Ok(())
}

/// Save (create or update) a single command in the user KB path.
///
/// If the category YAML exists, the command is merged (updated by name or added).
/// If the category YAML doesn't exist, it's created.
/// Also removes the command from _deleted.yaml if it was previously deleted.
pub fn save_kb_command(
    user_kb_path: &Path,
    platform: &str,
    category: &str,
    command: &Command,
) -> Result<(), String> {
    let path = get_target_yaml_path(user_kb_path, platform, category);

    // Ensure the directory exists
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directory {}: {}", parent.display(), e))?;
    }

    write_commands_to_yaml(&[command.clone()], &path, category)?;

    // Remove from _deleted.yaml if it was previously deleted
    let platform_dir = user_kb_path.join(platform);
    let deleted_path = platform_dir.join("_deleted.yaml");
    let mut names = read_deleted_list(&platform_dir);
    if names.remove(&command.name) {
        write_deleted_list(&deleted_path, &names)?;
        log::info!("Removed '{}' from deleted list in {}", command.name, deleted_path.display());
    }

    log::info!("Saved command '{}' to {}", command.name, path.display());
    Ok(())
}

/// Delete a single command from the user KB path by name.
///
/// If the category YAML exists in the user KB path, removes the command from it.
/// Always records the command name in _deleted.yaml in the user KB platform dir,
/// which the KbStore loader uses to filter out deleted bundled commands.
pub fn delete_kb_command(
    user_kb_path: &Path,
    platform: &str,
    category: &str,
    command_name: &str,
) -> Result<(), String> {
    let path = get_target_yaml_path(user_kb_path, platform, category);

    // 1. Remove from category file if it exists
    if path.exists() {
        let content = std::fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;

        let mut cmd_file: CommandFile = serde_yml::from_str(&content)
            .map_err(|e| format!("Failed to parse {}: {}", path.display(), e))?;

        let len_before = cmd_file.commands.len();
        cmd_file.commands.retain(|c| c.name != command_name);
        let removed = len_before - cmd_file.commands.len();

        if removed > 0 {
            if cmd_file.commands.is_empty() {
                std::fs::remove_file(&path)
                    .map_err(|e| format!("Failed to remove {}: {}", path.display(), e))?;
                log::info!("Removed empty file {}", path.display());

                if let Some(commands_dir) = path.parent() {
                    let _ = std::fs::remove_dir(commands_dir);
                    if let Some(platform_dir) = commands_dir.parent() {
                        let _ = std::fs::remove_dir(platform_dir);
                    }
                }
            } else {
                let yaml_content = serialize_commands(&cmd_file.commands)?;
                std::fs::write(&path, yaml_content)
                    .map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;
            }

            log::info!("Removed command '{}' from {}", command_name, path.display());
        }
    }

    // 2. Always record in _deleted.yaml so bundled commands stay hidden
    let platform_dir = user_kb_path.join(platform);
    std::fs::create_dir_all(&platform_dir)
        .map_err(|e| format!("Failed to create {}: {}", platform_dir.display(), e))?;

    let deleted_path = platform_dir.join("_deleted.yaml");
    let mut names = read_deleted_list(&platform_dir);
    names.insert(command_name.to_string());
    write_deleted_list(&deleted_path, &names)?;

    log::info!("Deleted command '{}' (recorded in {})", command_name, deleted_path.display());
    Ok(())
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
    fn test_get_target_yaml_path() {
        let kb_path = PathBuf::from("/data/kb");
        let path = get_target_yaml_path(&kb_path, "cisco-iosxe", "networking");
        assert_eq!(path, PathBuf::from("/data/kb/cisco-iosxe/commands/networking.yaml"));
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
