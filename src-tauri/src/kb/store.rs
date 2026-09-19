//! KB store: loading a platform's KB from disk and merging the two KB layers.
//!
//! **Load-time merge is user-wins-replace** (`KbStore::merge_from`): a user
//! command fully replaces the bundled command with the same name
//! (docs/specs/10-custom-knowledge-base.md § Part 1) and is stamped
//! `source: "custom"` + `overrides: true`; user-only names are added with
//! `source: "custom"`, `overrides: false`. The user platform index (prompt
//! patterns, default mode) also overrides the bundled one.
//!
//! This is deliberately different from the **write-time merge** in
//! `user_files::write_commands_to_yaml`, which is fill-empty-upgrade: import
//! appends into category files and only fills empty fields, while load
//! replaces wholesale. See the `user_files` module doc for the asymmetry.
//!
//! **Tombstone model**: `_deleted.yaml` / `_disabled.yaml` (written by
//! `user_files`) hide commands at load — including bundled-only commands,
//! whose names are tombstoned without a user copy. Deleting a user override
//! un-tombstones the name so the bundled command reappears
//! (`user_files::remove_command`).

use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use super::schema::{Command, PlatformIndex};
use super::user_files::{
    list_disabled, mark_disabled, mark_enabled, read_deleted_list, read_disabled_list,
    remove_command, upsert_command,
};
use super::validate::{validate_command, validate_platform, KbValidationIssue};

/// Wrapper for deserializing command YAML files (they have a top-level `commands:` key)
#[derive(Debug, Deserialize)]
pub(super) struct CommandFile {
    pub(super) commands: Vec<Command>,
}

// ─── KbStore ────────────────────────────────────────────────────────

/// In-memory store for a single platform's KB data.
pub(crate) struct KbStore {
    pub platform: PlatformIndex,
    pub commands: Vec<Command>,
}

impl KbStore {
    /// Load a platform from disk.
    pub(crate) fn load(platform_id: &str, kb_path: &Path) -> Result<Self, String> {
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

        // Load deleted + disabled command lists
        let deleted_commands = read_deleted_list(&platform_dir);
        let disabled_commands = read_disabled_list(&platform_dir);

        // Filter out deleted and disabled commands
        commands.retain(|c| !deleted_commands.contains(&c.name) && !disabled_commands.contains(&c.name));

        // Sort alphabetically by name
        commands.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

        // Validate tokens — log warnings, never fail the load (a single typo
        // should not brick the app). See docs/plans/plan-kb-token-engine.md § 1.1.
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
    /// with the same name (docs/specs/10-custom-knowledge-base.md § Part 1) and is
    /// stamped `source: "custom"` + `overrides: true`. User-only names are
    /// added with `source: "custom"`, `overrides: false`.
    pub(super) fn merge_from(&mut self, other: KbStore) {
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

}

// ─── Global KB Manager ─────────────────────────────────────────────

/// Manages loaded KB stores, one per platform.
/// Supports two KB paths: a bundled (read-only) path and a user (writable) path.
/// User path is searched first, allowing imported commands to override bundled ones.
pub(crate) struct KbManager {
    stores: HashMap<String, KbStore>,
    /// Bundled KB path (from app resources or project root)
    kb_path: PathBuf,
    /// User-writable KB path (in app data directory)
    user_kb_path: Option<PathBuf>,
}

impl KbManager {
    /// Create a KbManager with both bundled and user KB paths.
    pub(crate) fn with_user_path(kb_path: PathBuf, user_kb_path: PathBuf) -> Self {
        KbManager {
            stores: HashMap::new(),
            kb_path,
            user_kb_path: Some(user_kb_path),
        }
    }

    /// The user KB path, or an error if not configured.
    fn user_path(&self) -> Result<&Path, String> {
        self.user_kb_path.as_deref().ok_or_else(|| "No user KB path configured".to_string())
    }

    /// Get or load a platform's KB store.
    /// Loads from bundled KB, then merges the user KB on top (user wins).
    /// Platforms that exist only in the user KB (custom platforms,
    /// docs/specs/10-custom-knowledge-base.md § Part 5) load directly from the
    /// user path with no merge.
    pub(super) fn get_or_load(&mut self, platform_id: &str) -> Result<&KbStore, String> {
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

                    // Also filter by user KB's deleted + disabled lists
                    // (catches bundled-only commands)
                    let user_deleted = read_deleted_list(&user_platform_dir);
                    let user_disabled = read_disabled_list(&user_platform_dir);
                    let hidden: HashSet<String> =
                        user_deleted.union(&user_disabled).cloned().collect();
                    if !hidden.is_empty() {
                        let before = store.commands.len();
                        store.commands.retain(|c| !hidden.contains(&c.name));
                        log::info!(
                            "Filtered {} hidden commands for '{}' ({} → {})",
                            hidden.len(),
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
    pub(crate) fn reload_all(&mut self) {
        self.stores.clear();
        log::info!("KB stores cleared — will reload on next query");
    }

    /// Get all commands for a platform (no filtering — version eligibility
    /// is filtered in the frontend suggestion engine).
    pub(super) fn get_all_commands(&mut self, platform_id: &str) -> Result<Vec<Command>, String> {
        let store = self.get_or_load(platform_id)?;
        Ok(store.commands.clone())
    }

    /// Get a platform's index.
    pub(crate) fn get_platform_index(&mut self, platform_id: &str) -> Result<PlatformIndex, String> {
        let store = self.get_or_load(platform_id)?;
        Ok(store.platform.clone())
    }

    /// Unique category names for a platform's loaded commands.
    pub(crate) fn categories_for_platform(&mut self, platform_id: &str) -> Vec<String> {
        self.get_or_load(platform_id)
            .map(|store| {
                store
                    .commands
                    .iter()
                    .map(|c| c.category.clone())
                    .collect::<std::collections::BTreeSet<_>>()
                    .into_iter()
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Save (create or update-by-name) a user command. Validation is policy that
    /// belongs with the model: error-severity issues block the write and are
    /// returned to the UI as `Ok(Err(issues))`; warnings don't block. The nested
    /// Result preserves the frontend contract (outer = plumbing, inner = validation).
    pub(super) fn save_user_command(
        &mut self,
        platform: &str,
        category: &str,
        command: &Command,
    ) -> Result<Result<(), Vec<KbValidationIssue>>, String> {
        let user_kb_path = self.user_path()?;

        let errors: Vec<KbValidationIssue> = validate_command(command)
            .into_iter()
            .filter(|i| i.severity == "error")
            .collect();
        if !errors.is_empty() {
            return Ok(Err(errors));
        }

        upsert_command(&user_kb_path, platform, category, command)?;
        self.stores.remove(platform);
        Ok(Ok(()))
    }

    /// Delete a user command (tombstone logic per overrides flag).
    pub(super) fn delete_user_command(
        &mut self,
        platform: &str,
        category: &str,
        name: &str,
        overrides: bool,
    ) -> Result<(), String> {
        let user_kb_path = self.user_path()?;

        remove_command(user_kb_path, platform, category, name, overrides)?;
        self.stores.remove(platform);
        Ok(())
    }

    /// Disable a command (hide from suggestions without deleting).
    pub(super) fn disable_command(&mut self, platform: &str, name: &str) -> Result<(), String> {
        let user_kb_path = self.user_path()?;

        mark_disabled(user_kb_path, platform, name)?;
        self.stores.remove(platform);
        Ok(())
    }

    /// Re-enable a previously disabled command.
    pub(super) fn enable_command(&mut self, platform: &str, name: &str) -> Result<(), String> {
        let user_kb_path = self.user_path()?;

        mark_enabled(user_kb_path, platform, name)?;
        self.stores.remove(platform);
        Ok(())
    }

    /// Names of disabled commands for a platform (read-only).
    pub(super) fn disabled_commands(&self, platform: &str) -> Vec<String> {
        self.user_kb_path
            .as_deref()
            .map(|p| list_disabled(p, platform))
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::kb::schema::CommandToken;
    use crate::kb::test_util::*;

    #[test]
    fn test_load_cisco_iosxe() {
        let kb_path = get_kb_path();
        let store = KbStore::load("cisco-iosxe", &kb_path).unwrap();
        assert_eq!(store.platform.id, "cisco-iosxe");
        assert!(!store.commands.is_empty());
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

    // ─── Custom KB: user-wins merge + provenance (docs/10 § Part 1) ────

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

    // ─── Mutation through a single persistent KbManager (invalidation) ──
    // These prove each manager method invalidates its own store in place:
    // the SAME instance must reflect the change on the next get_or_load,
    // not serve a stale cached snapshot.

    #[test]
    fn test_manager_save_adds_and_invalidates() {
        let (bundled, user) = kb_fixture("mgr-save", &cmd_yaml("show version", "bundled"), None);
        // User platform needs an index.yaml to be loadable on merge (see KbStore::load).
        std::fs::write(user.join("test-plat/index.yaml"), INDEX_YAML).unwrap();
        let mut mgr = KbManager::with_user_path(bundled.clone(), user.clone());

        let before = mgr.get_or_load("test-plat").unwrap();
        assert!(!before.commands.iter().any(|c| c.name == "my new cmd"));

        mgr.save_user_command("test-plat", "test", &mk_cmd("my new cmd", vec![]))
            .unwrap()
            .expect("no validation issues");

        let after = mgr.get_or_load("test-plat").unwrap();
        assert!(after.commands.iter().any(|c| c.name == "my new cmd"));

        drop_fixture(&bundled);
    }

    #[test]
    fn test_manager_delete_removes_and_invalidates() {
        let (bundled, user) = kb_fixture("mgr-del", &cmd_yaml("show version", "bundled"), None);
        let mut mgr = KbManager::with_user_path(bundled.clone(), user.clone());

        assert!(mgr.get_or_load("test-plat").unwrap().commands.iter().any(|c| c.name == "show version"));

        mgr.delete_user_command("test-plat", "test", "show version", false).unwrap();

        let after = mgr.get_or_load("test-plat").unwrap();
        assert!(!after.commands.iter().any(|c| c.name == "show version"));

        drop_fixture(&bundled);
    }

    #[test]
    fn test_manager_disable_hides_and_invalidates() {
        let (bundled, user) = kb_fixture("mgr-dis", &cmd_yaml("show version", "bundled"), None);
        let mut mgr = KbManager::with_user_path(bundled.clone(), user.clone());

        assert!(mgr.get_or_load("test-plat").unwrap().commands.iter().any(|c| c.name == "show version"));

        mgr.disable_command("test-plat", "show version").unwrap();

        let after = mgr.get_or_load("test-plat").unwrap();
        assert!(!after.commands.iter().any(|c| c.name == "show version"));
        assert!(mgr.disabled_commands("test-plat").contains(&"show version".to_string()));

        drop_fixture(&bundled);
    }

    #[test]
    fn test_manager_enable_restores_and_invalidates() {
        let (bundled, user) = kb_fixture("mgr-en", &cmd_yaml("show version", "bundled"), None);
        let mut mgr = KbManager::with_user_path(bundled.clone(), user.clone());

        mgr.disable_command("test-plat", "show version").unwrap();
        assert!(!mgr.get_or_load("test-plat").unwrap().commands.iter().any(|c| c.name == "show version"));

        mgr.enable_command("test-plat", "show version").unwrap();

        let after = mgr.get_or_load("test-plat").unwrap();
        assert!(after.commands.iter().any(|c| c.name == "show version"));
        assert!(!mgr.disabled_commands("test-plat").contains(&"show version".to_string()));

        drop_fixture(&bundled);
    }

    #[test]
    fn test_manager_disabled_commands_empty_when_none() {
        let (bundled, user) = kb_fixture("mgr-dis-none", &cmd_yaml("show version", "bundled"), None);
        let mgr = KbManager::with_user_path(bundled.clone(), user.clone());
        assert!(mgr.disabled_commands("test-plat").is_empty());
        drop_fixture(&bundled);
    }

    #[test]
    fn test_manager_save_returns_validation_issues() {
        let (bundled, user) = kb_fixture("mgr-val", &cmd_yaml("show version", "bundled"), None);
        let mut mgr = KbManager::with_user_path(bundled.clone(), user.clone());

        let bad = mk_cmd("bad cmd", vec![CommandToken::Lit { lit: String::new(), optional: false }]);

        match mgr.save_user_command("test-plat", "test", &bad).unwrap() {
            Ok(()) => panic!("expected validation issues"),
            Err(issues) => assert!(!issues.is_empty(), "must report the empty-literal issue"),
        }

        assert!(!mgr.get_or_load("test-plat").unwrap().commands.iter().any(|c| c.name == "bad cmd"));

        drop_fixture(&bundled);
    }
}