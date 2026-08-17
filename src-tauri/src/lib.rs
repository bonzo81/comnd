//! net.sh — Tauri backend
//!
//! Handles: SSH connections (russh), KB loading/querying,
//! credential management, config, and KB import.

mod ssh;
#[cfg(debug_assertions)]
pub mod test_server;
mod kb;
mod hosts;
mod config;
mod ollama;
mod import;

use std::process::Command as StdCommand;
use std::sync::Mutex;
use tauri::Manager;
use kb::{KbManager, Command, PlatformIndex};
use hosts::{Host, HostStore, HostGroup, HostGroupStore};
use ssh::SshManager;
use config::{AppConfig, ConfigStore};
use import::{ImportRequest, ImportResult};

// ─── Browser URL Opener ─────────────────────────────────────────────

fn open_url(url: &str) {
    let _ = if cfg!(target_os = "windows") {
        StdCommand::new("cmd").args(["/C", "start", "", url]).spawn()
    } else if cfg!(target_os = "macos") {
        StdCommand::new("open").arg(url).spawn()
    } else {
        StdCommand::new("xdg-open").arg(url).spawn()
    };
}

#[tauri::command]
async fn open_url_cmd(url: String) -> Result<(), String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("Only HTTP/HTTPS URLs are allowed".to_string());
    }
    open_url(&url);
    Ok(())
}

// ─── App State ──────────────────────────────────────────────────────

struct AppState {
    kb: Mutex<KbManager>,
    hosts: Mutex<HostStore>,
    groups: Mutex<HostGroupStore>,
    ssh: tokio::sync::Mutex<SshManager>,
    config: Mutex<ConfigStore>,
}

// ─── KB Commands ────────────────────────────────────────────────────

#[tauri::command]
async fn query_kb(
    _prefix: String,
    platform: String,
    _mode: Option<String>,
    version: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<Command>, String> {
    let mut kb = state.kb.lock().map_err(|e| e.to_string())?;
    kb.query(
        &platform,
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

// ─── Host Group Commands ─────────────────────────────────────────────

#[tauri::command]
async fn get_host_groups(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<HostGroup>, String> {
    let groups = state.groups.lock().map_err(|e| e.to_string())?;
    groups.get_all()
}

#[tauri::command]
async fn save_host_group(
    id: Option<String>,
    name: String,
    parent_id: Option<String>,
    color: Option<String>,
    icon: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<HostGroup, String> {
    let mut groups = state.groups.lock().map_err(|e| e.to_string())?;

    if let Some(group_id) = id {
        // Update existing
        let existing = groups.get_all()?.into_iter().find(|g| g.id == group_id)
            .ok_or_else(|| format!("Group not found: {}", group_id))?;
        groups.update(HostGroup {
            id: group_id,
            name,
            parent_id,
            sort_order: existing.sort_order,
            color,
            icon,
            created_at: existing.created_at,
        })
    } else {
        // Create new
        groups.create(HostGroup {
            id: String::new(),
            name,
            parent_id,
            sort_order: 0,
            color,
            icon,
            created_at: String::new(),
        })
    }
}

#[tauri::command]
async fn delete_host_group(
    id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    // Also un-group any hosts in this group
    {
        let mut hosts = state.hosts.lock().map_err(|e| e.to_string())?;
        let all = hosts.get_all()?;
        for host in all {
            if host.group_id.as_deref() == Some(&id) {
                let mut updated = host.clone();
                updated.group_id = None;
                let _ = hosts.update(updated);
            }
        }
    }
    let mut groups = state.groups.lock().map_err(|e| e.to_string())?;
    groups.delete(&id)
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
    session_id: u64,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let session = ssh::SshSession::connect(
        app_handle,
        &hostname,
        port,
        &username,
        password.as_deref(),
        key_path.as_deref(),
        cols,
        rows,
        session_id,
    )
    .await?;

    let mut mgr = state.ssh.lock().await;
    mgr.insert_session(session);
    Ok(())
}

#[tauri::command]
async fn ssh_send(
    session_id: u64,
    data: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mgr = state.ssh.lock().await;
    match mgr.get_session(session_id) {
        Some(session) => session.send(data.as_bytes()).await,
        None => Err("No such session".to_string()),
    }
}

#[tauri::command]
async fn ssh_disconnect(
    session_id: u64,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mut mgr = state.ssh.lock().await;
    match mgr.take_session(session_id) {
        Some(session) => session.disconnect().await,
        None => Ok(()),
    }
}

#[tauri::command]
async fn ssh_resize(
    session_id: u64,
    cols: u32,
    rows: u32,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mgr = state.ssh.lock().await;
    match mgr.get_session(session_id) {
        Some(session) => session.resize(cols, rows).await,
        None => Err("No such session".to_string()),
    }
}

// ─── Config Commands ────────────────────────────────────────────────

#[tauri::command]
async fn get_app_config(
    state: tauri::State<'_, AppState>,
) -> Result<AppConfig, String> {
    let config = state.config.lock().map_err(|e| e.to_string())?;
    Ok(config.get().clone())
}

#[tauri::command]
async fn save_ollama_settings(
    base_url: String,
    model: String,
    api_key: Option<String>,
    context_length: u32,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.save_ollama_settings(base_url, model, api_key, context_length)
}

// ─── KB Import Commands ──────────────────────────────────────────────

#[tauri::command]
async fn import_kb_url(
    url: String,
    platform: String,
    category: String,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<ImportResult, String> {
    let request = ImportRequest {
        url,
        platform,
        category,
    };

    let (config_ref, user_kb_path) = {
        let config = state.config.lock().map_err(|e| e.to_string())?;
        (config.get().clone(), config.user_kb_path())
    };

    let result = import::import_from_url(
        request,
        &config_ref,
        &user_kb_path,
        &app_handle,
    ).await?;

    // Reload KB stores so new commands are immediately available
    {
        let mut kb = state.kb.lock().map_err(|e| e.to_string())?;
        kb.reload_all();
    }

    Ok(result)
}

#[tauri::command]
async fn test_ollama_connection(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let (base_url, model, api_key, context_length) = {
        let config = state.config.lock().map_err(|e| e.to_string())?;
        let cfg = config.get();
        (cfg.ollama_base_url.clone(), cfg.ollama_model.clone(), cfg.ollama_api_key.clone(), cfg.ollama_context_length)
    };

    let ollama = ollama::OllamaClient::new(
        base_url,
        model,
        api_key,
        context_length,
    );

    ollama.list_models().await
}

#[tauri::command]
async fn list_kb_platforms(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let kb = state.kb.lock().map_err(|e| e.to_string())?;
    Ok(kb.list_platforms())
}

#[tauri::command]
async fn get_all_kb_commands(
    platform: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<Command>, String> {
    let mut kb = state.kb.lock().map_err(|e| e.to_string())?;
    kb.get_all_commands(&platform)
}

#[tauri::command]
async fn save_kb_command(
    platform: String,
    category: String,
    name: String,
    syntax: String,
    description: String,
    mode: String,
    aliases: Vec<String>,
    tags: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let user_kb_path = {
        let config = state.config.lock().map_err(|e| e.to_string())?;
        config.user_kb_path()
    };

    let command = Command {
        name,
        syntax,
        description,
        category: category.clone(),
        mode,
        aliases,
        examples: vec![],
        versions: kb::CommandVersions {
            introduced: None,
            deprecated: None,
            notes: None,
        },
        tags,
    };

    import::save_kb_command(&user_kb_path, &platform, &category, &command)?;

    // Reload KB so changes are reflected immediately
    {
        let mut kb = state.kb.lock().map_err(|e| e.to_string())?;
        kb.reload_all();
    }

    Ok(())
}

#[tauri::command]
async fn delete_kb_command(
    platform: String,
    category: String,
    command_name: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let user_kb_path = {
        let config = state.config.lock().map_err(|e| e.to_string())?;
        config.user_kb_path()
    };

    import::delete_kb_command(&user_kb_path, &platform, &category, &command_name)?;

    // Reload KB so changes are reflected immediately
    {
        let mut kb = state.kb.lock().map_err(|e| e.to_string())?;
        kb.reload_all();
    }

    Ok(())
}

// ─── Test Commands (debug only) ─────────────────────────────────────

#[cfg(debug_assertions)]
#[tauri::command]
async fn test_mock_server(state: tauri::State<'_, AppState>) -> Result<u16, String> {
    let (port, handle) = test_server::start_mock_server().await;
    let mut mgr = state.ssh.lock().await;
    mgr.set_test_server_handle(handle);
    Ok(port)
}

#[cfg(debug_assertions)]
#[tauri::command]
async fn test_stop_mock_server(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut mgr = state.ssh.lock().await;
    if let Some(handle) = mgr.take_test_server_handle() {
        handle.abort();
    }
    Ok(())
}

// ─── App Entry ──────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("info")
    ).init();

    log::info!("net.sh v{} starting", env!("CARGO_PKG_VERSION"));

    tauri::Builder::default()
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

            let group_store = HostGroupStore::new().unwrap_or_else(|e| {
                log::warn!("Failed to init group store: {}. Using in-memory fallback.", e);
                HostGroupStore::in_memory()
            });

            log::info!("Group store initialized");

            let config_store = ConfigStore::new().unwrap_or_else(|e| {
                log::warn!("Failed to init config store: {}. Using in-memory fallback.", e);
                // Create in-memory fallback
                let data_dir = dirs::data_dir()
                    .unwrap_or_else(|| std::path::PathBuf::from("."))
                    .join("netsh");
                ConfigStore::new_with_path(data_dir.join("config.json")).unwrap_or_else(|e| {
                    log::error!("Failed to create config store: {}", e);
                    panic!("Cannot continue without config store")
                })
            });

            let user_kb_path = config_store.user_kb_path();
            log::info!("User KB path: {}", user_kb_path.display());

            app.manage(AppState {
                kb: Mutex::new(KbManager::with_user_path(kb_path, user_kb_path)),
                hosts: Mutex::new(host_store),
                groups: Mutex::new(group_store),
                ssh: tokio::sync::Mutex::new(SshManager::new()),
                config: Mutex::new(config_store),
            });

            Ok(())
        })
        .invoke_handler({
            tauri::generate_handler![
                query_kb,
                load_platform_index,
                get_hosts,
                save_host,
                delete_host,
                touch_host,
                save_credential,
                get_credential,
                ssh_connect,
                ssh_send,
                ssh_disconnect,
                ssh_resize,
                get_app_config,
                save_ollama_settings,
                import_kb_url,
                test_ollama_connection,
                list_kb_platforms,
                get_all_kb_commands,
                save_kb_command,
                delete_kb_command,
                get_host_groups,
                save_host_group,
                open_url_cmd,
                delete_host_group,
                #[cfg(debug_assertions)]
                test_mock_server,
                #[cfg(debug_assertions)]
                test_stop_mock_server,
            ]
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
