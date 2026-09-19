//! Tauri IPC handlers for the KB.
//!
//! Thin: lock the AppState store, delegate to `KbManager`. No policy lives
//! here — validation and write semantics are in `store` / `user_files` /
//! `validate`.

use crate::state::AppState;

use super::schema::{Command, CommandOrder, CommandToken, CommandVersions};
use super::validate::{validate_platform, KbValidationIssue};

// ─── Tauri Commands (plan: lib.rs domain split) ─────────────────────

/// Commands for the suggestion pipeline: full merged set, unfiltered.
/// Version eligibility is applied in the frontend (suggestion-engine.ts).
#[tauri::command]
pub(crate) async fn query_kb(
    platform: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<Command>, String> {
    let mut kb = state.kb.lock().map_err(|e| e.to_string())?;
    kb.get_all_commands(&platform)
}

#[tauri::command]
pub(crate) async fn validate_kb(
    platform: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<KbValidationIssue>, String> {
    let mut kb = state.kb.lock().map_err(|e| e.to_string())?;
    let commands = kb.get_all_commands(&platform)?;
    Ok(validate_platform(&commands))
}

#[tauri::command]
pub(crate) async fn get_all_kb_commands(
    platform: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<Command>, String> {
    let mut kb = state.kb.lock().map_err(|e| e.to_string())?;
    kb.get_all_commands(&platform)
}

#[tauri::command]
pub(crate) async fn save_kb_command(
    platform: String,
    category: String,
    name: String,
    syntax: String,
    description: String,
    mode: String,
    aliases: Vec<String>,
    tags: Vec<String>,
    // Phase 5.8: optional token fields. `tokens_json` is a JSON array of
    // CommandToken; absent/blank → no tokens (legacy entry). Malformed JSON is
    // an outer error — we never silently drop bad input on save.
    tokens_json: Option<String>,
    order: Option<String>,
    negatable: Option<bool>,
    state: tauri::State<'_, AppState>,
) -> Result<Result<(), Vec<KbValidationIssue>>, String> {
    // Malformed token JSON is a hard error (outer Err), not a silent downgrade.
    let tokens: Vec<CommandToken> = parse_tokens(tokens_json.as_deref())?;

    let order_val = match order.as_deref() {
        Some("flags-anywhere") => CommandOrder::FlagsAnywhere,
        Some("free") => CommandOrder::Free,
        _ => CommandOrder::Fixed,
    };

    let command = Command {
        name,
        syntax,
        description,
        category: category.clone(),
        mode,
        aliases,
        examples: vec![],
        versions: CommandVersions {
            introduced: None,
            deprecated: None,
            notes: None,
        },
        tags,
        tokens,
        order: order_val,
        negatable: negatable.unwrap_or(false),
        source: None,
        overrides: false,
    };

    // Validation + write + invalidation live in the manager (policy with model).
    let mut kb = state.kb.lock().map_err(|e| e.to_string())?;
    kb.save_user_command(&platform, &category, &command)
}

#[tauri::command]
pub(crate) async fn delete_kb_command(
    platform: String,
    category: String,
    command_name: String,
    overrides: bool,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mut kb = state.kb.lock().map_err(|e| e.to_string())?;
    kb.delete_user_command(&platform, &category, &command_name, overrides)
}

#[tauri::command]
pub(crate) async fn disable_kb_command(
    platform: String,
    command_name: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mut kb = state.kb.lock().map_err(|e| e.to_string())?;
    kb.disable_command(&platform, &command_name)
}

#[tauri::command]
pub(crate) async fn enable_kb_command(
    platform: String,
    command_name: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mut kb = state.kb.lock().map_err(|e| e.to_string())?;
    kb.enable_command(&platform, &command_name)
}

#[tauri::command]
pub(crate) async fn get_disabled_commands(
    platform: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let kb = state.kb.lock().map_err(|e| e.to_string())?;
    Ok(kb.disabled_commands(&platform))
}

/// Parse an optional JSON array of CommandToken. Absent/blank → empty list;
/// present-but-malformed → Err so the caller can surface the exact failure.
fn parse_tokens(tokens_json: Option<&str>) -> Result<Vec<CommandToken>, String> {
    match tokens_json {
        Some(s) if !s.trim().is_empty() => serde_json::from_str(s)
            .map_err(|e| format!("Invalid tokens JSON: {}", e)),
        _ => Ok(Vec::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_tokens_malformed_is_err() {
        assert!(parse_tokens(Some("not json at all")).is_err());
    }
}