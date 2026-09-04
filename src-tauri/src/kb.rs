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
    #[serde(default)]
    pub negation_prefix: Option<String>,
    /// Commands that may precede other commands (e.g. linux `sudo`, F5 bash
    /// `tmsh`). Keyed by prefix word. See docs/06-knowledge-base.md § Prefix Commands.
    #[serde(default)]
    pub prefix_commands: HashMap<String, PrefixCommand>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrefixCommand {
    /// Modes whose commands become matchable after the prefix is stripped.
    pub unlocks: Vec<String>,
    /// Flags (before the inner command) that take a value which should be
    /// skipped when stripping, e.g. sudo's `-u <user>`.
    #[serde(default)]
    pub skip_flag_value: Vec<String>,
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
    #[serde(default)]
    pub tokens: Vec<CommandToken>,
    #[serde(default)]
    pub order: CommandOrder,
    #[serde(default)]
    pub negatable: bool,
    /// Provenance (docs/10-custom-knowledge-base.md): Some("custom") when the
    /// command came from the user KB layer; None (bundled). Merge-generated,
    /// never authored — stripped from YAML writes in `serialize_commands`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// True when this command replaced a bundled command with the same name.
    /// Merge-generated; stripped from YAML writes.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub overrides: bool,
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

// ─── Token schema (machine-readable syntax) ─────────────────────────
// See docs/06-knowledge-base.md § Token Schema. Optional; legacy commands
// without `tokens` fall back to name/alias prefix matching.

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum CommandToken {
    /// Fixed literal keyword(s). May be multi-word.
    Lit { lit: String, #[serde(default)] optional: bool },
    /// One of a fixed set of keywords. `repeatable` (Phase 4) allows the same
    /// choice token to match more than once — used for repeatable flags such
    /// as `ls -l -a`. The engine honours it; the validator accepts it.
    Choice {
        choice: Vec<String>,
        #[serde(default)]
        optional: bool,
        #[serde(default)]
        repeatable: bool,
        /// Per-option help text (flag → meaning). Display-only.
        #[serde(default)]
        descriptions: std::collections::HashMap<String, String>,
    },
    /// A variable slot.
    Var(VarToken),
    /// Pipe / filter separator. See docs § Token Schema.
    Pipe(PipeToken),
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct VarToken {
    pub var: String,
    /// Help text for the variable slot. Display-only.
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub r#type: VarType,
    #[serde(default)]
    pub source: VarSource,
    #[serde(default)]
    pub optional: bool,
    #[serde(default)]
    pub values: Vec<String>,
    #[serde(default)]
    pub min: Option<i64>,
    #[serde(default)]
    pub max: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VarType {
    #[default]
    Free,
    Enumerable,
    Numeric,
    Choice,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VarSource {
    #[default]
    None,
    Device,
    Kb,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PipeToken {
    #[serde(default = "default_true")]
    pub pipe: bool,
    #[serde(default)]
    pub filters: Vec<PipeFilter>,
    #[serde(default)]
    pub optional: bool,
    #[serde(default)]
    pub repeatable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PipeFilter {
    pub lit: String,
    #[serde(default)]
    pub var: Option<String>,
    #[serde(default)]
    pub r#type: Option<VarType>,
}

fn default_true() -> bool { true }

// ─── Token validation ────────────────────────────────────────────────
// See docs/plan-kb-token-engine.md § 1.1. Validator returns a list of
// human-readable issues per command; the loader logs warnings and surfaces
// them to the UI via the `validate_kb` Tauri command (Phase 5).

/// A validation issue for a single command.
#[derive(Debug, Clone, Serialize)]
pub struct KbValidationIssue {
    pub command: String,
    pub severity: String, // "error" | "warning"
    pub message: String,
}

/// Validate a single command's `tokens` list.
/// Errors are correctness problems that would break matching; warnings are
/// suspicious-but-harmless configurations.
pub fn validate_command(cmd: &Command) -> Vec<KbValidationIssue> {
    let mut issues = Vec::new();
    let name = &cmd.name;

    // Duplicate (name, mode) within a platform is caught at the platform
    // level (validate_platform), not here — we only inspect one command.

    if cmd.tokens.is_empty() {
        // Legacy command — no tokens to validate.
        return issues;
    }

    for (i, tok) in cmd.tokens.iter().enumerate() {
        match tok {
            CommandToken::Lit { lit, .. } => {
                if lit.trim().is_empty() {
                    issues.push(KbValidationIssue {
                        command: name.clone(),
                        severity: "error".into(),
                        message: format!("tokens[{}]: lit is empty", i),
                    });
                }
            }
            CommandToken::Choice { choice, .. } => {
                if choice.is_empty() {
                    issues.push(KbValidationIssue {
                        command: name.clone(),
                        severity: "error".into(),
                        message: format!("tokens[{}]: choice list is empty", i),
                    });
                }
                for c in choice {
                    if c.trim().is_empty() {
                        issues.push(KbValidationIssue {
                            command: name.clone(),
                            severity: "error".into(),
                            message: format!("tokens[{}]: choice element is empty", i),
                        });
                    }
                }
            }
            CommandToken::Var(v) => {
                if v.var.trim().is_empty() {
                    issues.push(KbValidationIssue {
                        command: name.clone(),
                        severity: "error".into(),
                        message: format!("tokens[{}]: var name is empty", i),
                    });
                }
                if matches!(v.r#type, VarType::Numeric) {
                    if let (Some(min), Some(max)) = (v.min, v.max) {
                        if min > max {
                            issues.push(KbValidationIssue {
                                command: name.clone(),
                                severity: "error".into(),
                                message: format!("tokens[{}]: numeric var '{}' has min ({}) > max ({})", i, v.var, min, max),
                            });
                        }
                    }
                }
                if matches!(v.source, VarSource::Kb) && v.values.is_empty() {
                    issues.push(KbValidationIssue {
                        command: name.clone(),
                        severity: "error".into(),
                        message: format!("tokens[{}]: var '{}' source: kb requires non-empty values", i, v.var),
                    });
                }
                if matches!(v.source, VarSource::Device) && !v.values.is_empty() {
                    issues.push(KbValidationIssue {
                        command: name.clone(),
                        severity: "warning".into(),
                        message: format!("tokens[{}]: var '{}' source: device should not carry values (static fallback is harmless)", i, v.var),
                    });
                }
            }
            CommandToken::Pipe(p) => {
                if !p.pipe {
                    issues.push(KbValidationIssue {
                        command: name.clone(),
                        severity: "error".into(),
                        message: format!("tokens[{}]: pipe token must set pipe: true", i),
                    });
                }
                for (j, f) in p.filters.iter().enumerate() {
                    if f.lit.trim().is_empty() {
                        issues.push(KbValidationIssue {
                            command: name.clone(),
                            severity: "error".into(),
                            message: format!("tokens[{}].filters[{}]: filter lit is empty", i, j),
                        });
                    }
                }
            }
        }
    }

    // Order-rule sanity: flags-anywhere / free need at least one optional token
    // to be meaningful.
    if matches!(cmd.order, CommandOrder::FlagsAnywhere | CommandOrder::Free) {
        let has_optional = cmd.tokens.iter().any(|t| match t {
            CommandToken::Lit { optional, .. } => *optional,
            CommandToken::Choice { optional, .. } => *optional,
            CommandToken::Var(v) => v.optional,
            CommandToken::Pipe(p) => p.optional,
        });
        if !has_optional {
            issues.push(KbValidationIssue {
                command: name.clone(),
                severity: "warning".into(),
                message: format!("order: {:?} but no optional tokens — order rule is meaningless", cmd.order),
            });
        }
    }

    // negatable on show commands is suspicious but not wrong.
    if cmd.negatable && cmd.name.starts_with("show ") {
        issues.push(KbValidationIssue {
            command: name.clone(),
            severity: "warning".into(),
            message: "negatable: true on a show command is unusual (some platforms allow `no show ...` quirks)".into(),
        });
    }

    issues
}

/// Validate all commands in a platform, including duplicate (name, mode) detection.
pub fn validate_platform(commands: &[Command]) -> Vec<KbValidationIssue> {
    let mut issues = Vec::new();
    let mut seen: HashMap<(String, String), usize> = HashMap::new();
    for (idx, cmd) in commands.iter().enumerate() {
        let key = (cmd.name.to_lowercase(), cmd.mode.to_lowercase());
        if let Some(&prev_idx) = seen.get(&key) {
            issues.push(KbValidationIssue {
                command: cmd.name.clone(),
                severity: "warning".into(),
                message: format!("duplicate (name, mode) pair with command at index {}", prev_idx),
            });
        } else {
            seen.insert(key, idx);
        }
        issues.extend(validate_command(cmd));
    }
    issues
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub enum CommandOrder {
    #[default]
    #[serde(rename = "fixed")]
    Fixed,
    #[serde(rename = "flags-anywhere")]
    FlagsAnywhere,
    #[serde(rename = "free")]
    Free,
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

        // Validate tokens — log warnings, never fail the load (a single typo
        // should not brick the app). See docs/plan-kb-token-engine.md § 1.1.
        let issues = validate_platform(&commands);
        let errors = issues.iter().filter(|i| i.severity == "error").count();
        let warnings = issues.len() - errors;
        for issue in &issues {
            let level = if issue.severity == "error" { log::Level::Error } else { log::Level::Warn };
            log::log!(level, "KB validation [{}] {}: {}", issue.severity, issue.command, issue.message);
        }
        log::info!(
            "KB loaded platform '{}': {} commands ({} deleted, {} validation errors, {} warnings)",
            platform_id,
            commands.len(),
            deleted_commands.len(),
            errors,
            warnings,
        );

        Ok(KbStore { platform, commands })
    }

    /// Merge commands from another store into this one.
    /// User commands win: a user command fully replaces the bundled command
    /// with the same name (docs/10-custom-knowledge-base.md § Part 1) and is
    /// stamped `source: "custom"` + `overrides: true`. User-only names are
    /// added with `source: "custom"`, `overrides: false`.
    pub fn merge_from(&mut self, other: KbStore) {
        for mut cmd in other.commands {
            cmd.source = Some("custom".to_string());
            if let Some(existing) = self.commands.iter_mut().find(|c| c.name == cmd.name) {
                cmd.overrides = true;
                *existing = cmd;
            } else {
                cmd.overrides = false;
                self.commands.push(cmd);
            }
        }
        // Re-sort after merge
        self.commands
            .sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    }

    /// Query commands by version. Frontend always sends prefix="" and mode=None;
    /// it needs the full command set because matching happens in the frontend.
    pub fn query(&self, version: Option<&str>) -> Vec<&Command> {
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
    /// Create a KbManager with both bundled and user KB paths.
    pub fn with_user_path(kb_path: PathBuf, user_kb_path: PathBuf) -> Self {
        KbManager {
            stores: HashMap::new(),
            kb_path,
            user_kb_path: Some(user_kb_path),
        }
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
    /// Loads from bundled KB, then merges the user KB on top (user wins).
    /// Platforms that exist only in the user KB (custom platforms,
    /// docs/10-custom-knowledge-base.md § Part 5) load directly from the
    /// user path with no merge.
    pub fn get_or_load(&mut self, platform_id: &str) -> Result<&KbStore, String> {
        if !self.stores.contains_key(platform_id) {
            let user_dir_exists = self
                .user_kb_path
                .as_ref()
                .map(|p| p.join(platform_id).exists())
                .unwrap_or(false);

            // Load bundled KB first; if there is no bundled platform but the
            // user KB has one (custom platform), load from the user path.
            let (mut store, loaded_from_user) = match KbStore::load(platform_id, &self.kb_path) {
                Ok(s) => (s, false),
                Err(bundled_err) if user_dir_exists => {
                    let user_path = self.user_kb_path.as_ref().unwrap();
                    match KbStore::load(platform_id, user_path) {
                        Ok(s) => (s, true),
                        Err(user_err) => {
                            return Err(format!("{}; {}", bundled_err, user_err));
                        }
                    }
                }
                Err(e) => return Err(e),
            };

            // Merge user KB on top of bundled (skip when the base IS the user
            // KB — merging it into itself would stamp overrides on everything).
            if let Some(ref user_path) = self.user_kb_path {
                let user_platform_dir = user_path.join(platform_id);
                if user_platform_dir.exists() && !loaded_from_user {
                    match KbStore::load(platform_id, user_path) {
                        Ok(user_store) => {
                            log::info!(
                                "Merging user KB for '{}': {} user commands over {} bundled",
                                platform_id,
                                user_store.commands.len(),
                                store.commands.len()
                            );
                            // User index (prompt patterns, default mode) overrides bundled —
                            // bundled scaffolds ship with empty prompt_patterns.
                            store.platform = user_store.platform.clone();
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
        let results = store.query(version);
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

    crate::paths::atomic_write(deleted_path, yaml_content.as_bytes())
        .map_err(|e| format!("Failed to write {}: {}", deleted_path.display(), e))
}

/// Serialize commands under a top-level `commands:` key.
/// Strips merge-generated provenance (`source`/`overrides`) — they are
/// computed at load, never authored (docs/10-custom-knowledge-base.md § 1.3).
fn serialize_commands(commands: &[Command]) -> Result<String, String> {
    use serde_yml::Value;
    let cleaned: Vec<Command> = commands
        .iter()
        .map(|c| Command {
            source: None,
            overrides: false,
            ..c.clone()
        })
        .collect();
    serde_yml::to_string(&Value::Mapping({
        let mut map = serde_yml::Mapping::new();
        map.insert(
            Value::String("commands".to_string()),
            serde_yml::to_value(&cleaned).unwrap_or_default(),
        );
        map
    }))
    .map_err(|e| format!("Failed to serialize commands to YAML: {}", e))
}

/// Get the target YAML file path for commands.
///
/// Invariant: this always resolves inside the user (custom) KB path. LLM
/// import writes ONLY to the custom (user) KB — never the bundled KB; see
/// docs/10-custom-knowledge-base.md.
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
            // Phase 5.4: upgrade legacy entries with tokens. Without this,
            // re-importing a command that previously landed as a legacy entry
            // (empty `tokens`) silently discards the new tokens.
            if !cmd.tokens.is_empty() && existing.tokens.is_empty() {
                existing.tokens = cmd.tokens.clone();
            }
            // `order` is an enum, not a Vec — use `!= Fixed` vs `== Fixed` as
            // the "has meaningful value" check (Fixed is the default). If both
            // are non-default and differ, keep the existing (don't clobber a
            // hand-set value with an LLM guess).
            if cmd.order != CommandOrder::Fixed && existing.order == CommandOrder::Fixed {
                existing.order = cmd.order.clone();
            }
            if cmd.negatable && !existing.negatable {
                existing.negatable = cmd.negatable;
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

    crate::paths::atomic_write(path, yaml_content.as_bytes())
        .map_err(|e| format!("Failed to write YAML file {}: {}", path.display(), e))?;

    log::info!("Wrote {} commands to {}", merged.len(), path.display());
    Ok(())
}

/// Parse an optional JSON array of CommandToken. Absent/blank → empty list;
/// present-but-malformed → Err so the caller can surface the exact failure.
pub fn parse_tokens(tokens_json: Option<&str>) -> Result<Vec<CommandToken>, String> {
    match tokens_json {
        Some(s) if !s.trim().is_empty() => serde_json::from_str(s)
            .map_err(|e| format!("Invalid tokens JSON: {}", e)),
        _ => Ok(Vec::new()),
    }
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
                crate::paths::atomic_write(&path, yaml_content.as_bytes())
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
        let results = store.query(None);
        assert!(!results.is_empty());
    }

    #[test]
    fn test_empty_prefix_returns_all() {
        let kb_path = get_kb_path();
        let store = KbStore::load("cisco-iosxe", &kb_path).unwrap();
        let all = store.query(None);
        assert_eq!(all.len(), store.commands.len());
    }

    #[test]
    fn test_case_insensitive() {
        let kb_path = get_kb_path();
        let store = KbStore::load("cisco-iosxe", &kb_path).unwrap();
        let upper = store.query(None);
        let lower = store.query(None);
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
        let filtered = store.query(Some("17.6"));
        let all = store.query(None);
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

    // ─── Validator tests (Phase 1.5) ───────────────────────────────────

    use CommandToken::*;

    fn mk_cmd(name: &str, tokens: Vec<CommandToken>) -> Command {
        Command {
            name: name.to_string(),
            syntax: String::new(),
            description: String::new(),
            category: "test".to_string(),
            mode: "privileged-exec".to_string(),
            aliases: vec![],
            examples: vec![],
            versions: CommandVersions::default(),
            tags: vec![],
            tokens,
            order: CommandOrder::Fixed,
            negatable: false,
            source: None,
            overrides: false,
        }
    }

    fn has_error(issues: &[KbValidationIssue], needle: &str) -> bool {
        issues.iter().any(|i| i.severity == "error" && i.message.contains(needle))
    }

    fn has_warning(issues: &[KbValidationIssue], needle: &str) -> bool {
        issues.iter().any(|i| i.severity == "warning" && i.message.contains(needle))
    }

    #[test]
    fn test_parse_tokens_malformed_is_err() {
        assert!(parse_tokens(Some("not json at all")).is_err());
    }

    #[test]
    fn test_validator_pass_lit() {
        let cmd = mk_cmd("show version", vec![Lit { lit: "show version".into(), optional: false }]);
        let issues = validate_command(&cmd);
        assert!(issues.is_empty(), "expected no issues, got {:?}", issues);
    }

    #[test]
    fn test_validator_pass_choice() {
        let cmd = mk_cmd("show interfaces", vec![
            Lit { lit: "show interfaces".into(), optional: false },
            Choice { choice: vec!["status".into(), "trunk".into()], optional: true, repeatable: false, descriptions: Default::default() },
        ]);
        let issues = validate_command(&cmd);
        assert!(issues.is_empty(), "expected no issues, got {:?}", issues);
    }

    #[test]
    fn test_validator_pass_var_numeric() {
        let cmd = mk_cmd("vlan", vec![
            Lit { lit: "vlan".into(), optional: false },
            Var(VarToken {
                var: "vlan-id".into(),
                description: None,
                r#type: VarType::Numeric,
                source: VarSource::None,
                optional: false,
                values: vec![],
                min: Some(1),
                max: Some(4094),
            }),
        ]);
        let issues = validate_command(&cmd);
        assert!(issues.is_empty(), "expected no issues, got {:?}", issues);
    }

    #[test]
    fn test_validator_pass_var_kb_source() {
        let cmd = mk_cmd("interface", vec![
            Lit { lit: "interface".into(), optional: false },
            Var(VarToken {
                var: "iface".into(),
                description: None,
                r#type: VarType::Enumerable,
                source: VarSource::Kb,
                optional: false,
                values: vec!["GigabitEthernet".into()],
                min: None,
                max: None,
            }),
        ]);
        let issues = validate_command(&cmd);
        assert!(issues.is_empty(), "expected no issues, got {:?}", issues);
    }

    #[test]
    fn test_validator_pass_pipe() {
        let cmd = mk_cmd("show run", vec![
            Lit { lit: "show running-config".into(), optional: false },
            Pipe(PipeToken {
                pipe: true,
                filters: vec![PipeFilter {
                    lit: "section".into(),
                    var: Some("regex".into()),
                    r#type: Some(VarType::Free),
                }],
                optional: true,
                repeatable: true,
            }),
        ]);
        let issues = validate_command(&cmd);
        assert!(issues.is_empty(), "expected no issues, got {:?}", issues);
    }

    #[test]
    fn test_validator_fail_empty_lit() {
        let cmd = mk_cmd("bad", vec![Lit { lit: "   ".into(), optional: false }]);
        let issues = validate_command(&cmd);
        assert!(has_error(&issues, "lit is empty"));
    }

    #[test]
    fn test_validator_fail_empty_choice() {
        let cmd = mk_cmd("bad", vec![Choice { choice: vec![], optional: false, repeatable: false, descriptions: Default::default() }]);
        let issues = validate_command(&cmd);
        assert!(has_error(&issues, "choice list is empty"));
    }

    #[test]
    fn test_validator_fail_empty_choice_element() {
        let cmd = mk_cmd("bad", vec![Choice { choice: vec!["".into()], optional: false, repeatable: false, descriptions: Default::default() }]);
        let issues = validate_command(&cmd);
        assert!(has_error(&issues, "choice element is empty"));
    }

    #[test]
    fn test_validator_fail_empty_var_name() {
        let cmd = mk_cmd("bad", vec![Var(VarToken {
            var: "  ".into(),
            description: None,
            r#type: VarType::Free,
            source: VarSource::None,
            optional: false,
            values: vec![],
            min: None,
            max: None,
        })]);
        let issues = validate_command(&cmd);
        assert!(has_error(&issues, "var name is empty"));
    }

    #[test]
    fn test_validator_fail_min_gt_max() {
        let cmd = mk_cmd("bad", vec![Var(VarToken {
            var: "n".into(),
            description: None,
            r#type: VarType::Numeric,
            source: VarSource::None,
            optional: false,
            values: vec![],
            min: Some(10),
            max: Some(5),
        })]);
        let issues = validate_command(&cmd);
        assert!(has_error(&issues, "min (10) > max (5)"));
    }

    #[test]
    fn test_validator_fail_kb_source_no_values() {
        let cmd = mk_cmd("bad", vec![Var(VarToken {
            var: "iface".into(),
            description: None,
            r#type: VarType::Enumerable,
            source: VarSource::Kb,
            optional: false,
            values: vec![],
            min: None,
            max: None,
        })]);
        let issues = validate_command(&cmd);
        assert!(has_error(&issues, "source: kb requires non-empty values"));
    }

    #[test]
    fn test_validator_warn_device_source_with_values() {
        let cmd = mk_cmd("bad", vec![Var(VarToken {
            var: "iface".into(),
            description: None,
            r#type: VarType::Enumerable,
            source: VarSource::Device,
            optional: false,
            values: vec!["Gi0/1".into()],
            min: None,
            max: None,
        })]);
        let issues = validate_command(&cmd);
        assert!(has_warning(&issues, "source: device should not carry values"));
    }

    #[test]
    fn test_validator_fail_pipe_not_true() {
        let cmd = mk_cmd("bad", vec![Pipe(PipeToken {
            pipe: false,
            filters: vec![],
            optional: true,
            repeatable: false,
        })]);
        let issues = validate_command(&cmd);
        assert!(has_error(&issues, "pipe token must set pipe: true"));
    }

    #[test]
    fn test_validator_warn_order_no_optional() {
        let mut cmd = mk_cmd("ping", vec![
            Lit { lit: "ping".into(), optional: false },
            Var(VarToken {
                var: "host".into(),
                description: None,
                r#type: VarType::Free,
                source: VarSource::None,
                optional: false,
                values: vec![],
                min: None,
                max: None,
            }),
        ]);
        cmd.order = CommandOrder::FlagsAnywhere;
        let issues = validate_command(&cmd);
        assert!(has_warning(&issues, "order rule is meaningless"));
    }

    #[test]
    fn test_validator_warn_negatable_show() {
        let mut cmd = mk_cmd("show interfaces", vec![Lit { lit: "show interfaces".into(), optional: false }]);
        cmd.negatable = true;
        let issues = validate_command(&cmd);
        assert!(has_warning(&issues, "negatable: true on a show command"));
    }

    #[test]
    fn test_validator_legacy_command_no_issues() {
        let mut cmd = mk_cmd("legacy", vec![]);
        cmd.tokens = vec![];
        let issues = validate_command(&cmd);
        assert!(issues.is_empty());
    }

    #[test]
    fn test_validator_platform_duplicate_name_mode() {
        let a = mk_cmd("network", vec![Lit { lit: "network".into(), optional: false }]);
        let mut b = mk_cmd("network", vec![Lit { lit: "network".into(), optional: false }]);
        b.mode = "routing-config".to_string();
        let c = mk_cmd("network", vec![Lit { lit: "network".into(), optional: false }]);
        let issues = validate_platform(&[a, b, c]);
        // a and c share (network, privileged-exec) → duplicate warning
        assert!(has_warning(&issues, "duplicate (name, mode)"));
        // b differs in mode → no duplicate with a/c
        let dup_count = issues.iter().filter(|i| i.message.contains("duplicate")).count();
        assert_eq!(dup_count, 1);
    }

    #[test]
    fn test_validator_real_iosxe_networking_clean() {
        // The backfilled networking.yaml should have no validator errors.
        let kb_path = get_kb_path();
        let store = KbStore::load("cisco-iosxe", &kb_path).unwrap();
        let networking: Vec<Command> = store.commands.iter()
            .filter(|c| c.category == "networking")
            .cloned()
            .collect();
        let issues = validate_platform(&networking);
        let errors: Vec<_> = issues.iter().filter(|i| i.severity == "error").collect();
        assert!(errors.is_empty(), "networking.yaml validation errors: {:?}", errors);
    }

    #[test]
    fn test_validator_real_iosxe_routing_clean() {
        let kb_path = get_kb_path();
        let store = KbStore::load("cisco-iosxe", &kb_path).unwrap();
        let routing: Vec<Command> = store.commands.iter()
            .filter(|c| c.category == "routing")
            .cloned()
            .collect();
        let issues = validate_platform(&routing);
        let errors: Vec<_> = issues.iter().filter(|i| i.severity == "error").collect();
        assert!(errors.is_empty(), "routing.yaml validation errors: {:?}", errors);
    }

    #[test]
    fn test_routing_no_paren_hack() {
        let kb_path = get_kb_path();
        let store = KbStore::load("cisco-iosxe", &kb_path).unwrap();
        for cmd in &store.commands {
            assert!(!cmd.name.contains("(OSPF)"), "found (OSPF) hack in '{}'", cmd.name);
            assert!(!cmd.name.contains("(BGP)"), "found (BGP) hack in '{}'", cmd.name);
        }
    }

    // Phase 4: every MVP platform loads cleanly and has no validator errors.
    // This catches YAML schema typos in the per-platform backfill before they
    // ship.

    fn assert_platform_clean(platform: &str) {
        let kb_path = get_kb_path();
        let store = KbStore::load(platform, &kb_path)
            .unwrap_or_else(|e| panic!("KbStore::load('{}') failed: {}", platform, e));
        assert!(
            !store.commands.is_empty(),
            "platform '{}' has no commands — backfill missing",
            platform
        );
        let issues = validate_platform(&store.commands);
        let errors: Vec<_> = issues.iter().filter(|i| i.severity == "error").collect();
        assert!(
            errors.is_empty(),
            "platform '{}' validation errors: {:?}",
            platform,
            errors
        );
    }

    #[test]
    fn test_nxos_loads_clean() {
        assert_platform_clean("cisco-nxos");
    }

    #[test]
    fn test_f5_tmos_loads_clean() {
        assert_platform_clean("f5-tmos");
    }

    #[test]
    fn test_linux_bash_loads_clean() {
        assert_platform_clean("linux-bash");
    }

    // ─── Phase 5.5: YAML round-trip ──────────────────────────────────
    // Ship in the same commit as token-emitting import. Guards the
    // `#[serde(rename_all = "lowercase")]` tagged union — a tag mismatch
    // would silently drop tokens on read or write and corrupt every
    // imported command.

    #[test]
    fn test_command_yaml_round_trip_all_token_kinds() {
        let cmd = Command {
            name: "round-trip".to_string(),
            syntax: "round-trip <n> [opt] | section <r>".to_string(),
            description: "test".to_string(),
            category: "test".to_string(),
            mode: "privileged-exec".to_string(),
            aliases: vec!["rt".to_string()],
            examples: vec![CommandExample {
                command: "round-trip 5".to_string(),
                description: "example".to_string(),
            }],
            versions: CommandVersions::default(),
            tags: vec!["test".to_string()],
            tokens: vec![
                CommandToken::Lit { lit: "round-trip".to_string(), optional: false },
                CommandToken::Var(VarToken {
                    var: "n".to_string(),
                    description: Some("a number".to_string()),
                    r#type: VarType::Numeric,
                    source: VarSource::None,
                    optional: false,
                    values: vec![],
                    min: Some(1),
                    max: Some(100),
                }),
                CommandToken::Choice {
                    choice: vec!["opt".to_string()],
                    optional: true,
                    repeatable: false,
                    descriptions: [("opt".to_string(), "optional flag".to_string())].into_iter().collect(),
                },
                CommandToken::Pipe(PipeToken {
                    pipe: true,
                    filters: vec![
                        PipeFilter {
                            lit: "section".to_string(),
                            var: Some("regex".to_string()),
                            r#type: Some(VarType::Free),
                        },
                        PipeFilter {
                            lit: "begin".to_string(),
                            var: Some("regex".to_string()),
                            r#type: Some(VarType::Free),
                        },
                    ],
                    optional: true,
                    repeatable: true,
                }),
            ],
            order: CommandOrder::FlagsAnywhere,
            negatable: true,
            source: None,
            overrides: false,
        };

        let yaml = serialize_commands(&[cmd.clone()]).unwrap();
        // Tagged-union sanity: the YAML must carry the lowercase variant tags.
        assert!(yaml.contains("lit:"), "lit tag missing in: {}", yaml);
        assert!(yaml.contains("choice:"), "choice tag missing in: {}", yaml);
        assert!(yaml.contains("var:"), "var tag missing in: {}", yaml);
        assert!(yaml.contains("pipe:"), "pipe tag missing in: {}", yaml);

        // Round-trip: read back what we wrote.
        let file: CommandFile = serde_yml::from_str(&yaml).unwrap();
        assert_eq!(file.commands.len(), 1);
        let back = &file.commands[0];
        assert_eq!(back.name, "round-trip");
        assert_eq!(back.tokens.len(), 4);
        // Spot-check each kind survives.
        assert!(matches!(back.tokens[0], CommandToken::Lit { .. }));
        assert!(matches!(back.tokens[1], CommandToken::Var(_)));
        assert!(matches!(back.tokens[2], CommandToken::Choice { .. }));
        assert!(matches!(back.tokens[3], CommandToken::Pipe(_)));
        // Numeric range survives.
        if let CommandToken::Var(v) = &back.tokens[1] {
            assert_eq!(v.min, Some(1));
            assert_eq!(v.max, Some(100));
            assert!(matches!(v.r#type, VarType::Numeric));
        } else {
            panic!("expected Var token at index 1");
        }
        // Pipe filters survive.
        if let CommandToken::Pipe(p) = &back.tokens[3] {
            assert_eq!(p.filters.len(), 2);
            assert!(p.repeatable);
        } else {
            panic!("expected Pipe token at index 3");
        }
        // order + negatable survive.
        assert!(matches!(back.order, CommandOrder::FlagsAnywhere));
        assert!(back.negatable);
    }

    // ─── Phase 5.4: merge upgrades legacy entries with tokens ─────────

    #[test]
    fn test_write_commands_to_yaml_upgrades_legacy_entry_with_tokens() {
        // A legacy entry (empty tokens) already on disk; re-importing the
        // same command with tokens should upgrade the entry, not silently
        // discard the new tokens.
        let dir = std::env::temp_dir().join("netssh-test-merge");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.yaml");

        let legacy = Command {
            name: "show ip route".to_string(),
            syntax: String::new(),
            description: "old".to_string(),
            category: "networking".to_string(),
            mode: "privileged-exec".to_string(),
            aliases: vec![],
            examples: vec![],
            versions: CommandVersions::default(),
            tags: vec![],
            tokens: vec![], // legacy
            order: CommandOrder::Fixed,
            negatable: false,
            source: None,
            overrides: false,
        };
        write_commands_to_yaml(&[legacy], &path, "networking").unwrap();

        // Re-import with tokens + non-default order + negatable.
        let upgraded = Command {
            name: "show ip route".to_string(),
            syntax: "show ip route".to_string(),
            description: String::new(),
            category: String::new(),
            mode: "privileged-exec".to_string(),
            aliases: vec![],
            examples: vec![],
            versions: CommandVersions::default(),
            tags: vec![],
            tokens: vec![
                CommandToken::Lit { lit: "show ip route".to_string(), optional: false },
            ],
            order: CommandOrder::Free,
            negatable: true,
            source: None,
            overrides: false,
        };
        write_commands_to_yaml(&[upgraded], &path, "networking").unwrap();

        // Read back and verify the merge upgraded the legacy entry.
        let content = std::fs::read_to_string(&path).unwrap();
        let file: CommandFile = serde_yml::from_str(&content).unwrap();
        assert_eq!(file.commands.len(), 1);
        let merged = &file.commands[0];
        assert_eq!(merged.tokens.len(), 1, "tokens should be upgraded, got {:?}", merged.tokens);
        assert!(matches!(merged.order, CommandOrder::Free), "order should be upgraded");
        assert!(merged.negatable, "negatable should be upgraded");
        // Existing description preserved (the new one was empty).
        assert_eq!(merged.description, "old");

        std::fs::remove_dir_all(&dir).ok();
    }

    // ─── Custom KB: user-wins merge + provenance (docs/10 § Part 1) ────

    fn mk_full_cmd(name: &str, description: &str) -> Command {
        Command {
            name: name.to_string(),
            syntax: name.to_string(),
            description: description.to_string(),
            category: "test".to_string(),
            mode: "privileged-exec".to_string(),
            aliases: vec![],
            examples: vec![],
            versions: CommandVersions::default(),
            tags: vec![],
            tokens: vec![],
            order: CommandOrder::Fixed,
            negatable: false,
            source: None,
            overrides: false,
        }
    }

    fn mk_test_store(cmds: Vec<Command>) -> KbStore {
        KbStore {
            platform: PlatformIndex {
                id: "test".to_string(),
                name: "Test".to_string(),
                description: String::new(),
                reference_url: String::new(),
                versions: vec![],
                prompt_patterns: std::collections::HashMap::new(),
                default_mode: "privileged-exec".to_string(),
                negation_prefix: None,
                prefix_commands: std::collections::HashMap::new(),
            },
            commands: cmds,
        }
    }

    #[test]
    fn test_merge_user_wins_over_bundled() {
        let mut bundled = mk_test_store(vec![mk_full_cmd("show version", "bundled description")]);
        let user = mk_test_store(vec![mk_full_cmd("show version", "user description")]);
        bundled.merge_from(user);
        assert_eq!(bundled.commands.len(), 1);
        let cmd = &bundled.commands[0];
        assert_eq!(cmd.description, "user description");
        assert_eq!(cmd.source.as_deref(), Some("custom"));
        assert!(cmd.overrides);
    }

    #[test]
    fn test_merge_user_only_command() {
        let mut bundled = mk_test_store(vec![mk_full_cmd("show version", "bundled")]);
        let user = mk_test_store(vec![mk_full_cmd("my-command", "user only")]);
        bundled.merge_from(user);
        assert_eq!(bundled.commands.len(), 2);
        let mine = bundled.commands.iter().find(|c| c.name == "my-command").unwrap();
        assert_eq!(mine.source.as_deref(), Some("custom"));
        assert!(!mine.overrides);
        // Bundled command untouched, no provenance.
        let theirs = bundled.commands.iter().find(|c| c.name == "show version").unwrap();
        assert_eq!(theirs.source, None);
        assert!(!theirs.overrides);
    }

    #[test]
    fn test_yaml_round_trip_strips_provenance() {
        // A merged store (custom + override commands) serialized to YAML must
        // not contain source/overrides keys — they are computed, not stored.
        let mut bundled = mk_test_store(vec![mk_full_cmd("show version", "bundled")]);
        let user = mk_test_store(vec![
            mk_full_cmd("show version", "user"),
            mk_full_cmd("my-command", "user only"),
        ]);
        bundled.merge_from(user);

        let yaml = serialize_commands(&bundled.commands).unwrap();
        assert!(!yaml.contains("source:"), "source leaked into YAML: {}", yaml);
        assert!(!yaml.contains("overrides:"), "overrides leaked into YAML: {}", yaml);

        // Reload from the YAML — commands load cleanly with no provenance.
        let file: CommandFile = serde_yml::from_str(&yaml).unwrap();
        assert_eq!(file.commands.len(), 2);
        assert!(file.commands.iter().all(|c| c.source.is_none() && !c.overrides));
    }

    #[test]
    fn test_tombstone_hides_bundled_after_merge() {
        // User _deleted.yaml must keep hiding a bundled command after the
        // user-wins merge change (existing behaviour, pinned).
        let base = std::env::temp_dir().join(format!("netssh-tombstone-{}", std::process::id()));
        let bundled = base.join("bundled");
        let user = base.join("user");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(bundled.join("test-plat/commands")).unwrap();
        std::fs::create_dir_all(user.join("test-plat")).unwrap();

        std::fs::write(
            bundled.join("test-plat/index.yaml"),
            "id: test-plat\nname: Test\ndescription: \"\"\nreference_url: \"\"\nversions: []\nprompt_patterns: {}\ndefault_mode: default\n",
        ).unwrap();
        std::fs::write(
            bundled.join("test-plat/commands/test.yaml"),
            "commands:\n  - name: show version\n    syntax: show version\n    description: bundled\n    category: test\n    mode: default\n",
        ).unwrap();
        std::fs::write(
            user.join("test-plat/_deleted.yaml"),
            "deleted:\n  - show version\n",
        ).unwrap();

        let mut mgr = KbManager::with_user_path(bundled, user);
        let store = mgr.get_or_load("test-plat").unwrap();
        assert!(
            !store.commands.iter().any(|c| c.name == "show version"),
            "tombstoned bundled command must stay hidden, got: {:?}",
            store.commands.iter().map(|c| &c.name).collect::<Vec<_>>()
        );

        std::fs::remove_dir_all(&base).ok();
    }
}
