//! Command Replay — user-saved commands with named variables.
//! JSON file in the app data dir (`replay.json`), one command template per
//! entry with `{{name}}` markers. See docs/specs/09-command-replay.md.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::platform::PlatformRegistry;
use crate::state::AppState;
use crate::paths::{app_data_dir, secure_write};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReplayVariable {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReplayCommand {
    #[serde(default)]
    pub id: String,
    pub command: String,
    #[serde(default)]
    pub variables: Vec<ReplayVariable>,
    pub platform: String,
    #[serde(default)]
    pub created_at: String,
}

// Field caps — mirrors hosts.rs rationale (log pollution / UI rendering).
const MAX_COMMAND: usize = 4096;
const MAX_VARS: usize = 16;
const MAX_VAR_NAME: usize = 64;

fn file_path() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("replay.json"))
}

/// Read the command list at `path`. `load_json_or_preserve` treats a corrupt
/// file as empty and renames it aside, so a bad file can't break startup.
fn load_at(path: &Path) -> Vec<ReplayCommand> {
    crate::paths::load_json_or_preserve(path)
}

fn save_at(path: &Path, cmds: &[ReplayCommand]) -> Result<(), String> {
    let json = serde_json::to_string_pretty(cmds).map_err(|e| e.to_string())?;
    secure_write(path, json.as_bytes())
}

/// Insert or replace `cmd` in the list at `path`. New entries get an id and
/// timestamp; an update whose id is gone is an error, not a silent insert.
fn upsert_at(path: &Path, cmd: &ReplayCommand) -> Result<(), String> {
    let mut cmds = load_at(path);
    if cmd.id.is_empty() {
        // New entry
        let mut new = cmd.clone();
        new.id = uuid::Uuid::new_v4().to_string();
        new.created_at = chrono::Utc::now().to_rfc3339();
        cmds.push(new);
    } else {
        match cmds.iter_mut().find(|c| c.id == cmd.id) {
            Some(existing) => *existing = cmd.clone(),
            None => return Err(format!("No such command: {}", cmd.id)),
        }
    }
    save_at(path, &cmds)
}

/// Remove `id` from the list at `path`, erroring when nothing matched so the
/// UI can't report a delete that never happened.
fn delete_at(path: &Path, id: &str) -> Result<(), String> {
    let mut cmds = load_at(path);
    let before = cmds.len();
    cmds.retain(|c| c.id != id);
    if cmds.len() == before {
        return Err(format!("No such command: {}", id));
    }
    save_at(path, &cmds)
}

/// Validate a replay command's user-editable fields before persisting.
pub fn validate(cmd: &ReplayCommand, platforms: &PlatformRegistry) -> Result<(), String> {
    let trimmed = cmd.command.trim();
    if trimmed.is_empty() {
        return Err("Command is required".to_string());
    }
    if cmd.command.len() > MAX_COMMAND {
        return Err(format!("Command exceeds {} characters", MAX_COMMAND));
    }
    if !platforms.is_valid(&cmd.platform) {
        return Err(format!("Invalid platform: {}", cmd.platform));
    }
    if cmd.variables.len() > MAX_VARS {
        return Err(format!("Too many variables (max {})", MAX_VARS));
    }
    let mut seen = std::collections::HashSet::new();
    for v in &cmd.variables {
        let name = v.name.trim();
        if name.is_empty() {
            return Err("Variable name is required".to_string());
        }
        if name.len() > MAX_VAR_NAME {
            return Err(format!("Variable name exceeds {} characters", MAX_VAR_NAME));
        }
        if !seen.insert(name.to_string()) {
            return Err(format!("Duplicate variable name: {}", name));
        }
        // Every declared variable must appear in the template.
        if !cmd.command.contains(&format!("{{{{{}}}}}", name)) {
            return Err(format!("Variable '{}' is not present in the command", name));
        }
    }
    Ok(())
}

// ─── Tauri Commands ──────────────────────────────────────────────────

#[tauri::command]
pub async fn replay_list() -> Result<Vec<ReplayCommand>, String> {
    Ok(load_at(&file_path()?))
}

#[tauri::command]
pub async fn replay_save(
    cmd: ReplayCommand,
    state: tauri::State<'_, AppState>,
) -> Result<ReplayCommand, String> {
    let platforms = state.platforms.lock().map_err(|e| e.to_string())?;
    validate(&cmd, &platforms)?;
    upsert_at(&file_path()?, &cmd)?;
    Ok(cmd)
}

#[tauri::command]
pub async fn replay_delete(id: String) -> Result<(), String> {
    delete_at(&file_path()?, &id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> ReplayCommand {
        ReplayCommand {
            id: String::new(),
            command: "show running-config interface {{interface}}".to_string(),
            variables: vec![ReplayVariable {
                name: "interface".to_string(),
            }],
            platform: "cisco-iosxe".to_string(),
            created_at: String::new(),
        }
    }

    #[test]
    fn test_validate_ok() {
        assert!(validate(&sample(), &PlatformRegistry::builtin()).is_ok());
    }

    #[test]
    fn test_validate_rejects() {
        let mut c = sample();
        c.command = "  ".to_string();
        assert!(validate(&c, &PlatformRegistry::builtin()).is_err(), "empty command rejected");

        let mut c = sample();
        c.platform = "not-a-platform".to_string();
        assert!(validate(&c, &PlatformRegistry::builtin()).is_err(), "bad platform rejected");

        let mut c = sample();
        c.variables.push(ReplayVariable {
            name: "interface".to_string(),
        });
        assert!(validate(&c, &PlatformRegistry::builtin()).is_err(), "duplicate names rejected");

        let mut c = sample();
        c.variables.clear();
        assert!(validate(&c, &PlatformRegistry::builtin()).is_ok(), "no variables is fine");

        let mut c = sample();
        c.variables.push(ReplayVariable {
            name: "ghost".to_string(),
        });
        assert!(validate(&c, &PlatformRegistry::builtin()).is_err(), "declared var missing from template rejected");
    }

    #[test]
    fn test_validate_rejects_oversized_and_malformed_fields() {
        // Each cap guards a stored command that cannot be rendered or
        // substituted safely, so the exact message matters to the user.
        let mut c = sample();
        c.variables.clear();
        c.command = "x".repeat(MAX_COMMAND + 1);
        assert_eq!(
            validate(&c, &PlatformRegistry::builtin()).unwrap_err(),
            format!("Command exceeds {} characters", MAX_COMMAND)
        );

        let mut c = sample();
        c.variables = (0..=MAX_VARS)
            .map(|i| ReplayVariable {
                name: format!("v{}", i),
            })
            .collect();
        c.command = c
            .variables
            .iter()
            .map(|v| format!("{{{{{}}}}}", v.name))
            .collect::<Vec<_>>()
            .join(" ");
        assert_eq!(
            validate(&c, &PlatformRegistry::builtin()).unwrap_err(),
            format!("Too many variables (max {})", MAX_VARS)
        );

        let mut c = sample();
        c.variables = vec![ReplayVariable {
            name: "   ".to_string(),
        }];
        assert_eq!(
            validate(&c, &PlatformRegistry::builtin()).unwrap_err(),
            "Variable name is required"
        );

        let mut c = sample();
        c.variables = vec![ReplayVariable {
            name: "n".repeat(MAX_VAR_NAME + 1),
        }];
        assert_eq!(
            validate(&c, &PlatformRegistry::builtin()).unwrap_err(),
            format!("Variable name exceeds {} characters", MAX_VAR_NAME)
        );
    }

    #[test]
    fn test_validate_custom_platform_when_in_registry() {
        let dir = std::env::temp_dir().join(format!("comnd_replay_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("my-custom")).unwrap();
        std::fs::write(dir.join("my-custom/index.yaml"), "platform: my-custom\n").unwrap();
        let platforms = PlatformRegistry::scan(&dir, None::<&std::path::Path>);

        let mut c = sample();
        c.platform = "my-custom".to_string();
        assert!(validate(&c, &platforms).is_ok());
        // Fails against a registry that lacks the custom platform
        assert!(validate(&c, &PlatformRegistry::builtin()).is_err());
    }

    #[test]
    fn test_template_substitution() {
        let c = sample();
        let mut out = c.command.clone();
        for v in &c.variables {
            out = out.replace(&format!("{{{{{}}}}}", v.name), "Gi0/1");
        }
        assert_eq!(out, "show running-config interface Gi0/1");
    }

    // ─── replay.json round-trip (coverage gap R3) ──────────────────

    fn temp_replay_path() -> (std::path::PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "comnd-replay-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("replay.json");
        (dir, path)
    }

    #[test]
    fn test_upsert_assigns_id_and_round_trips_through_disk() {
        let (dir, path) = temp_replay_path();
        let mut c = sample();
        // An entry with no variables still round-trips.
        c.variables.clear();

        upsert_at(&path, &c).unwrap();

        let stored = load_at(&path);
        assert_eq!(stored.len(), 1);
        assert!(!stored[0].id.is_empty(), "new entry gets an id");
        assert!(!stored[0].created_at.is_empty(), "new entry gets created_at");
        assert_eq!(stored[0].command, c.command);
        assert_eq!(stored[0].platform, "cisco-iosxe");

        // Editing an existing id replaces in place, keeping the id and
        // created_at, and does not append a second entry.
        let mut edited = stored[0].clone();
        edited.command = "show version".to_string();
        upsert_at(&path, &edited).unwrap();

        let stored = load_at(&path);
        assert_eq!(stored.len(), 1, "update must not append");
        assert_eq!(stored[0].id, edited.id);
        assert_eq!(stored[0].command, "show version");
        assert_eq!(stored[0].created_at, edited.created_at);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_upsert_and_delete_unknown_id_error() {
        let (dir, path) = temp_replay_path();

        let mut ghost = sample();
        ghost.id = "ghost".to_string();
        assert_eq!(
            upsert_at(&path, &ghost).unwrap_err(),
            "No such command: ghost"
        );
        assert!(!path.exists(), "a rejected update must not create the file");

        // Seeded entry survives a delete of something else, then deletes.
        upsert_at(&path, &sample()).unwrap();
        assert_eq!(
            delete_at(&path, "ghost").unwrap_err(),
            "No such command: ghost"
        );
        assert_eq!(load_at(&path).len(), 1, "failed delete keeps the entry");

        let id = load_at(&path)[0].id.clone();
        delete_at(&path, &id).unwrap();
        assert!(load_at(&path).is_empty(), "delete persists the removal");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
