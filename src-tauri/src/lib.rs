//! net.sh — Tauri backend
//!
//! Handles: SSH connections (russh), KB loading/querying,
//! credential management, and config storage.

mod ssh;
mod kb;
mod hosts;

use std::sync::Mutex;
use tauri::Manager;
use kb::{KbManager, Command, PlatformIndex};
use hosts::{Host, HostStore};
use ssh::SshManager;

// ─── App State ──────────────────────────────────────────────────────

struct AppState {
    kb: Mutex<KbManager>,
    hosts: Mutex<HostStore>,
    ssh: tokio::sync::Mutex<SshManager>,
}

// ─── KB Commands ────────────────────────────────────────────────────

#[tauri::command]
async fn query_kb(
    prefix: String,
    platform: String,
    mode: Option<String>,
    version: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<Command>, String> {
    let mut kb = state.kb.lock().map_err(|e| e.to_string())?;
    kb.query(
        &platform,
        &prefix,
        mode.as_deref(),
        version.as_deref(),
    )
}

#[tauri::command]
async fn load_platform_index(
    platform: String,
    state: tauri::State<'_, AppState>,
) -> Result<PlatformIndex, String> {
    let mut kb = state.kb.lock().map_err(|e| e.to_string())?;
    kb.get_platform_index(&platform)
}

// ─── Host Commands ──────────────────────────────────────────────────

#[tauri::command]
async fn get_hosts(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<Host>, String> {
    let hosts = state.hosts.lock().map_err(|e| e.to_string())?;
    hosts.get_all()
}

#[tauri::command]
async fn save_host(
    host: Host,
    state: tauri::State<'_, AppState>,
) -> Result<Host, String> {
    let mut hosts = state.hosts.lock().map_err(|e| e.to_string())?;
    if host.id.is_empty() {
        hosts.create(host)
    } else {
        hosts.update(host)
    }
}

#[tauri::command]
async fn delete_host(
    id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mut hosts = state.hosts.lock().map_err(|e| e.to_string())?;
    hosts.delete(&id)?;
    // Also delete credential
    hosts::delete_credential(&id).ok();
    Ok(())
}

#[tauri::command]
async fn reorder_hosts(
    ids: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mut hosts = state.hosts.lock().map_err(|e| e.to_string())?;
    hosts.reorder(&ids)
}

#[tauri::command]
async fn touch_host(
    id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mut hosts = state.hosts.lock().map_err(|e| e.to_string())?;
    hosts.touch(&id)
}

// ─── Credential Commands ────────────────────────────────────────────

#[tauri::command]
async fn save_credential(host_id: String, password: String) -> Result<(), String> {
    hosts::save_credential(&host_id, &password)
}

#[tauri::command]
async fn get_credential(host_id: String) -> Result<Option<String>, String> {
    hosts::get_credential(&host_id)
}

// ─── SSH Commands ───────────────────────────────────────────────────

#[tauri::command]
async fn ssh_connect(
    app_handle: tauri::AppHandle,
    hostname: String,
    port: u16,
    username: String,
    password: Option<String>,
    key_path: Option<String>,
    cols: u32,
    rows: u32,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    // Disconnect existing session if any
    {
        let mut mgr = state.ssh.lock().await;
        if let Some(old) = mgr.take_session() {
            let _ = old.disconnect().await;
        }
    }

    let session = ssh::SshSession::connect(
        app_handle,
        &hostname,
        port,
        &username,
        password.as_deref(),
        key_path.as_deref(),
        cols,
        rows,
    )
    .await?;

    let mut mgr = state.ssh.lock().await;
    mgr.set_session(session);
    Ok(())
}

#[tauri::command]
async fn ssh_send(
    data: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mgr = state.ssh.lock().await;
    match mgr.get_session() {
        Some(session) => session.send(data.as_bytes()).await,
        None => Err("No active SSH session".to_string()),
    }
}

#[tauri::command]
async fn ssh_disconnect(
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mut mgr = state.ssh.lock().await;
    match mgr.take_session() {
        Some(session) => session.disconnect().await,
        None => Ok(()),
    }
}

#[tauri::command]
async fn ssh_resize(
    cols: u32,
    rows: u32,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mgr = state.ssh.lock().await;
    match mgr.get_session() {
        Some(session) => session.resize(cols, rows).await,
        None => Err("No active SSH session".to_string()),
    }
}

#[tauri::command]
async fn ssh_auth_response(
    response: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mgr = state.ssh.lock().await;
    match mgr.get_session() {
        Some(session) => session.send_auth_response(response).await,
        None => Err("No active SSH session".to_string()),
    }
}

// ─── App Entry ──────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("info")
    ).init();

    log::info!("net.sh v{} starting", env!("CARGO_PKG_VERSION"));

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Resolve KB path — in dev, it's relative to project root
            let kb_path = app.path()
                .resource_dir()
                .unwrap_or_else(|_| {
                    std::env::current_dir().unwrap_or_default()
                })
                .join("knowledge-base");

            // Fallback: try relative to manifest dir (for dev)
            let kb_path = if kb_path.exists() {
                kb_path
            } else {
                // In dev mode, try the project root
                let dev_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .parent()
                    .unwrap()
                    .join("knowledge-base");
                if dev_path.exists() {
                    dev_path
                } else {
                    kb_path // Use original, will error on first query
                }
            };

            log::info!("KB path: {}", kb_path.display());

            let host_store = HostStore::new().unwrap_or_else(|e| {
                log::warn!("Failed to init host store: {}. Using in-memory fallback.", e);
                HostStore::in_memory()
            });

            log::info!("Host store initialized");

            app.manage(AppState {
                kb: Mutex::new(KbManager::new(kb_path)),
                hosts: Mutex::new(host_store),
                ssh: tokio::sync::Mutex::new(SshManager::new()),
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            query_kb,
            load_platform_index,
            get_hosts,
            save_host,
            delete_host,
            reorder_hosts,
            touch_host,
            save_credential,
            get_credential,
            ssh_connect,
            ssh_send,
            ssh_disconnect,
            ssh_resize,
            ssh_auth_response,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
