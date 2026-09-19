//! User-KB file mutation: writing commands to user YAML files and the
//! `_deleted.yaml` / `_disabled.yaml` list-file formats (one platform-level
//! names list each, keyed by `deleted:` / `disabled:`).
//!
//! **Write-time merge is fill-empty-upgrade** (`write_commands_to_yaml`):
//! importing appends into existing category files and only fills fields that
//! are empty on disk (upgrading legacy entries, Phase 5.4), so re-imports
//! enrich instead of clobbering hand-set values. This is deliberately
//! different from the **load-time merge** (`store` module), which is
//! user-wins-replace: import appends into category files, load replaces
//! wholesale (docs/specs/10-custom-knowledge-base.md).

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use super::schema::{Command, CommandOrder};
use super::store::CommandFile;

// ─── User KB Command Editing ────────────────────────────────────────

/// Read a set of command names from a platform-level list file
/// (`_deleted.yaml` / `_disabled.yaml`) keyed by `key`.
fn read_name_list(platform_dir: &Path, filename: &str, key: &str) -> HashSet<String> {
    let path = platform_dir.join(filename);
    if path.exists() {
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(value) = serde_yml::from_str::<serde_yml::Value>(&content) {
                if let Some(serde_yml::Value::Sequence(seq)) = value.get(key) {
                    return seq.iter().filter_map(|v| v.as_str().map(String::from)).collect();
                }
            }
        }
    }
    HashSet::new()
}

/// Write a set of command names to a list file under `key` (sorted).
fn write_name_list(path: &Path, key: &str, names: &HashSet<String>) -> Result<(), String> {
    use serde_yml::Value;
    let mut list: Vec<&String> = names.iter().collect();
    list.sort();
    let mut map = serde_yml::Mapping::new();
    map.insert(Value::String(key.to_string()), serde_yml::to_value(&list).unwrap_or_default());
    let yaml_content = serde_yml::to_string(&Value::Mapping(map))
        .map_err(|e| format!("Failed to serialize list: {}", e))?;

    crate::paths::atomic_write(path, yaml_content.as_bytes())
        .map_err(|e| format!("Failed to write {}: {}", path.display(), e))
}

/// Read the set of deleted command names for a platform (`_deleted.yaml`).
pub(super) fn read_deleted_list(platform_dir: &Path) -> HashSet<String> {
    read_name_list(platform_dir, "_deleted.yaml", "deleted")
}

/// Write the set of deleted command names to `_deleted.yaml` (sorted).
fn write_deleted_list(deleted_path: &Path, names: &HashSet<String>) -> Result<(), String> {
    write_name_list(deleted_path, "deleted", names)
}

/// Read the set of disabled command names for a platform (`_disabled.yaml`).
pub(super) fn read_disabled_list(platform_dir: &Path) -> HashSet<String> {
    read_name_list(platform_dir, "_disabled.yaml", "disabled")
}

/// Write the set of disabled command names to `_disabled.yaml` (sorted).
fn write_disabled_list(disabled_path: &Path, names: &HashSet<String>) -> Result<(), String> {
    write_name_list(disabled_path, "disabled", names)
}

/// Serialize commands under a top-level `commands:` key.
/// Strips merge-generated provenance (`source`/`overrides`) — they are
/// computed at load, never authored (docs/specs/10-custom-knowledge-base.md § 1.3).
pub(super) fn serialize_commands(commands: &[Command]) -> Result<String, String> {
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

/// KB path segment check: platform/category ids reach the filesystem, so
/// only lowercase slug characters pass. Blocks `../` traversal via IPC.
fn valid_kb_slug(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Get the target YAML file path for commands.
///
/// Invariant: this always resolves inside the user (custom) KB path. LLM
/// import writes ONLY to the custom (user) KB — never the bundled KB; see
/// docs/specs/10-custom-knowledge-base.md.
pub(crate) fn get_target_yaml_path(user_kb_path: &Path, platform: &str, category: &str) -> Result<PathBuf, String> {
    if !valid_kb_slug(platform) {
        return Err(format!("Invalid platform id '{}'", platform));
    }
    if !valid_kb_slug(category) {
        return Err(format!("Invalid category id '{}'", category));
    }
    Ok(user_kb_path.join(platform).join("commands").join(format!("{}.yaml", category)))
}

/// Write commands to a YAML file, merging with existing content if the file already exists.
pub(crate) fn write_commands_to_yaml(commands: &[Command], path: &Path) -> Result<(), String> {
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

/// Save (create or update) a single command in the user KB path.
///
/// If the category YAML exists, the command is merged (updated by name or added).
/// If the category YAML doesn't exist, it's created.
/// Also removes the command from _deleted.yaml if it was previously deleted.
pub(super) fn upsert_command(
    user_kb_path: &Path,
    platform: &str,
    category: &str,
    command: &Command,
) -> Result<(), String> {
    let path = get_target_yaml_path(user_kb_path, platform, category)?;

    // Ensure the directory exists
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directory {}: {}", parent.display(), e))?;
    }

    write_commands_to_yaml(&[command.clone()], &path)?;

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
/// Class-aware semantics (docs/specs/10-custom-knowledge-base.md):
/// - `overrides == true` (user override of a bundled command): remove the user
///   copy AND un-tombstone the name so the built-in version reappears.
/// - `overrides == false` with a user copy present (user-only custom command):
///   just remove the user copy — nothing to hide, no tombstone.
/// - `overrides == false` with no user copy (bundled-only command): record the
///   name in `_deleted.yaml` so the loader hides the bundled version.
pub(super) fn remove_command(
    user_kb_path: &Path,
    platform: &str,
    category: &str,
    command_name: &str,
    overrides: bool,
) -> Result<(), String> {
    if !valid_kb_slug(platform) {
        return Err(format!("Invalid platform id '{}'", platform));
    }
    let path = get_target_yaml_path(user_kb_path, platform, category)?;

    // 1. Remove the user copy from the category file if it exists.
    let mut had_user_copy = false;
    if path.exists() {
        let content = std::fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;

        let mut cmd_file: CommandFile = serde_yml::from_str(&content)
            .map_err(|e| format!("Failed to parse {}: {}", path.display(), e))?;

        let len_before = cmd_file.commands.len();
        cmd_file.commands.retain(|c| c.name != command_name);
        let removed = len_before - cmd_file.commands.len();
        had_user_copy = removed > 0;

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

    // 2. Tombstone logic by class.
    let platform_dir = user_kb_path.join(platform);
    std::fs::create_dir_all(&platform_dir)
        .map_err(|e| format!("Failed to create {}: {}", platform_dir.display(), e))?;

    let deleted_path = platform_dir.join("_deleted.yaml");
    let mut names = read_deleted_list(&platform_dir);

    if overrides {
        // Override: un-tombstone so the built-in version reappears.
        if names.remove(command_name) {
            write_deleted_list(&deleted_path, &names)?;
            log::info!(
                "Restored built-in '{}' (removed tombstone from {})",
                command_name,
                deleted_path.display()
            );
        }
    } else if !had_user_copy {
        // Bundled-only: record tombstone so the loader hides it.
        names.insert(command_name.to_string());
        write_deleted_list(&deleted_path, &names)?;
        log::info!(
            "Deleted command '{}' (recorded in {})",
            command_name,
            deleted_path.display()
        );
    } else {
        // User-only custom: nothing to hide.
        log::info!("Deleted user-only command '{}'", command_name);
    }

    Ok(())
}

/// Disable a single command (non-destructive): record its name in
/// `_disabled.yaml` so the loader hides it without touching the YAML.
pub(super) fn mark_disabled(
    user_kb_path: &Path,
    platform: &str,
    command_name: &str,
) -> Result<(), String> {
    if !valid_kb_slug(platform) {
        return Err(format!("Invalid platform id '{}'", platform));
    }
    let platform_dir = user_kb_path.join(platform);
    std::fs::create_dir_all(&platform_dir)
        .map_err(|e| format!("Failed to create {}: {}", platform_dir.display(), e))?;

    let disabled_path = platform_dir.join("_disabled.yaml");
    let mut names = read_disabled_list(&platform_dir);
    if names.insert(command_name.to_string()) {
        write_disabled_list(&disabled_path, &names)?;
        log::info!("Disabled command '{}' (recorded in {})", command_name, disabled_path.display());
    }
    Ok(())
}

/// Enable a single command: remove its name from `_disabled.yaml` so it reappears.
pub(super) fn mark_enabled(
    user_kb_path: &Path,
    platform: &str,
    command_name: &str,
) -> Result<(), String> {
    if !valid_kb_slug(platform) {
        return Err(format!("Invalid platform id '{}'", platform));
    }
    let platform_dir = user_kb_path.join(platform);

    let disabled_path = platform_dir.join("_disabled.yaml");
    let mut disabled = read_disabled_list(&platform_dir);
    if disabled.remove(command_name) {
        write_disabled_list(&disabled_path, &disabled)?;
    }

    log::info!("Enabled command '{}'", command_name);
    Ok(())
}

/// List the disabled command names for a platform (for the UI's "Ignored" section).
pub(super) fn list_disabled(user_kb_path: &Path, platform: &str) -> Vec<String> {
    let platform_dir = user_kb_path.join(platform);
    let mut names: Vec<String> = read_disabled_list(&platform_dir).into_iter().collect();
    names.sort();
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::kb::schema::{
        CommandExample, CommandToken, CommandVersions, PipeFilter, PipeToken, VarSource,
        VarToken, VarType,
    };
    use crate::kb::test_util::*;

    #[test]
    fn test_get_target_yaml_path() {
        let kb_path = PathBuf::from("/data/kb");
        let path = get_target_yaml_path(&kb_path, "cisco-iosxe", "networking").unwrap();
        assert_eq!(path, PathBuf::from("/data/kb/cisco-iosxe/commands/networking.yaml"));
    }

    #[test]
    fn test_get_target_yaml_path_rejects_traversal() {
        let kb_path = PathBuf::from("/data/kb");
        assert!(get_target_yaml_path(&kb_path, "../hosts", "networking").is_err());
        assert!(get_target_yaml_path(&kb_path, "cisco-iosxe", "../../etc/passwd").is_err());
        assert!(get_target_yaml_path(&kb_path, "", "networking").is_err());
        assert!(get_target_yaml_path(&kb_path, "cisco-iosxe", "Other…").is_err());
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
        write_commands_to_yaml(&[legacy], &path).unwrap();

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
        write_commands_to_yaml(&[upgraded], &path).unwrap();

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

    // ─── Delete / disable / enable (docs/plans/plan-kb-ignore-disable.md) ──────

    #[test]
    fn test_delete_override_restores_bundled() {
        let (bundled, user) = kb_fixture(
            "del-override",
            &cmd_yaml("show version", "bundled"),
            Some(&cmd_yaml("show version", "user override")),
        );

        // Fixture sanity: the user copy must win and be flagged as an override.
        let pre = loaded_cmd(&bundled, &user, "show version").expect("override must load");
        assert!(pre.overrides, "fixture must be an override");

        remove_command(&user, "test-plat", "test", "show version", true).unwrap();

        // Bundled copy reappears with no provenance; no tombstone left behind.
        let post = loaded_cmd(&bundled, &user, "show version").expect("bundled command must reappear");
        assert!(!post.overrides);
        assert!(post.source.is_none(), "must be the bundled copy, got {:?}", post.source);
        assert!(!read_deleted_list(&user.join("test-plat")).contains("show version"));

        drop_fixture(&bundled);
    }

    #[test]
    fn test_delete_user_only_no_tombstone() {
        let (bundled, user) = kb_fixture(
            "del-useronly",
            &cmd_yaml("other cmd", "bundled"),
            Some(&cmd_yaml("my-command", "user only")),
        );

        remove_command(&user, "test-plat", "test", "my-command", false).unwrap();

        let names = loaded_names(&bundled, &user);
        assert!(!names.contains(&"my-command".to_string()));
        assert!(names.contains(&"other cmd".to_string()));
        assert!(!read_deleted_list(&user.join("test-plat")).contains("my-command"));

        drop_fixture(&bundled);
    }

    #[test]
    fn test_delete_bundled_only_tombstones() {
        let (bundled, user) = kb_fixture("del-bundled", &cmd_yaml("show version", "bundled"), None);

        remove_command(&user, "test-plat", "test", "show version", false).unwrap();

        assert!(!loaded_names(&bundled, &user).contains(&"show version".to_string()));
        assert!(read_deleted_list(&user.join("test-plat")).contains("show version"));

        drop_fixture(&bundled);
    }

    #[test]
    fn test_disable_hides_command() {
        let (bundled, user) = kb_fixture("disable", &cmd_yaml("show version", "bundled"), None);

        mark_disabled(&user, "test-plat", "show version").unwrap();

        assert!(!loaded_names(&bundled, &user).contains(&"show version".to_string()));
        assert!(read_disabled_list(&user.join("test-plat")).contains("show version"));

        drop_fixture(&bundled);
    }

    #[test]
    fn test_enable_after_disable_restores() {
        let (bundled, user) = kb_fixture("enable", &cmd_yaml("show version", "bundled"), None);

        mark_disabled(&user, "test-plat", "show version").unwrap();
        mark_enabled(&user, "test-plat", "show version").unwrap();

        assert!(loaded_names(&bundled, &user).contains(&"show version".to_string()));
        assert!(!read_disabled_list(&user.join("test-plat")).contains("show version"));

        drop_fixture(&bundled);
    }
}