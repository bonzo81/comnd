//! Command Replay — user-saved commands with named variables.
//! JSON file in the app data dir (`replay.json`), one command template per
//! entry with `{{name}}` markers. See docs/specs/09-command-replay.md.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::platform::PlatformRegistry;
use crate::state::AppState;
use crate::paths::{app_data_dir, preserve_corrupt, secure_write};

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

fn load() -> Result<Vec<ReplayCommand>, String> {
    let path = file_path()?;
    match std::fs::read_to_string(&path) {
        Ok(s) => {
            let cmds: Vec<ReplayCommand> = serde_json::from_str(&s).map_err(|e| {
                preserve_corrupt(&path);
                format!("Corrupt replay.json: {}", e)
            })?;
            Ok(cmds)
        }
        Err(_) => Ok(Vec::new()),
    }
}

fn save(cmds: &[ReplayCommand]) -> Result<(), String> {
    let json = serde_json::to_string_pretty(cmds).map_err(|e| e.to_string())?;
    secure_write(&file_path()?, json.as_bytes())
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
    load()
}

#[tauri::command]
pub async fn replay_save(
    cmd: ReplayCommand,
    state: tauri::State<'_, AppState>,
) -> Result<ReplayCommand, String> {
    let platforms = state.platforms.lock().map_err(|e| e.to_string())?;
    validate(&cmd, &platforms)?;
    let mut cmds = load()?;
    if cmd.id.is_empty() {
        // New entry
        let mut new = cmd.clone();
        new.id = uuid::Uuid::new_v4().to_string();
        new.created_at = chrono::Utc::now().to_rfc3339();
        cmds.push(new.clone());
    } else {
        match cmds.iter_mut().find(|c| c.id == cmd.id) {
            Some(existing) => *existing = cmd.clone(),
            None => return Err(format!("No such command: {}", cmd.id)),
        }
    }
    save(&cmds)?;
    Ok(cmd)
}

#[tauri::command]
pub async fn replay_delete(id: String) -> Result<(), String> {
    let mut cmds = load()?;
    let before = cmds.len();
    cmds.retain(|c| c.id != id);
    if cmds.len() == before {
        return Err(format!("No such command: {}", id));
    }
    save(&cmds)
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
    fn test_validate_custom_platform_when_in_registry() {
        let dir = std::env::temp_dir().join(format!("netssh_replay_{}", uuid::Uuid::new_v4()));
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
}
