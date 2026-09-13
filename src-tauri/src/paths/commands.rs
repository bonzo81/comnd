//! Tauri command handlers for backup / restore / merge / restart.
//!
//! Thin IPC wrappers over the module-level functions in `super` (mod.rs).
//! Lived in lib.rs before the domain split. They live in a submodule because
//! each handler shares its name with the function it wraps, so they cannot
//! coexist in one module (E0428).

use super::{ConflictResolution, ImportMode, MergeScan};

#[tauri::command]
pub async fn export_data(dest_path: String) -> Result<(), String> {
    let path = std::path::PathBuf::from(&dest_path);
    super::export_data(&path)
}

/// Overwrite mode: replaces all data with the zip contents.
#[tauri::command]
pub async fn import_data(src_path: String) -> Result<(), String> {
    let path = std::path::PathBuf::from(&src_path);
    super::import_data(&path, ImportMode::Overwrite)?;
    Ok(())
}

/// Restart the app process (used after data restore).
#[tauri::command]
pub async fn restart_app(app_handle: tauri::AppHandle) -> Result<(), String> {
    // Dev builds serve the frontend from the Vite dev server managed by
    // `tauri dev`. That server's lifecycle is tied to the ORIGINAL process:
    // restarting the exe directly leaves the new webview pointing at a dead
    // devUrl (ERR_CONNECTION_REFUSED). Only allow real restarts in release
    // builds, where assets are bundled into the binary.
    if cfg!(debug_assertions) {
        return Err("Restart is only supported in release builds — in dev, quit the app and re-run `npm run tauri dev`".to_string());
    }
    log::info!("Restart requested by user — relaunching app");
    app_handle.restart();
}

/// Merge step 1: scan the backup for conflicts without writing anything.
#[tauri::command]
pub async fn scan_merge(src_path: String) -> Result<MergeScan, String> {
    let path = std::path::PathBuf::from(&src_path);
    super::scan_merge(&path)
}

/// Merge step 2: apply the merge with user-provided conflict resolutions.
#[tauri::command]
pub async fn apply_merge(
    temp_dir: String,
    resolutions: std::collections::HashMap<String, ConflictResolution>,
) -> Result<String, String> {
    let path = std::path::PathBuf::from(&temp_dir);
    super::apply_merge(&path, &resolutions)
}
