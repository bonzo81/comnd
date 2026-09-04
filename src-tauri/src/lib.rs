//! netssh — Tauri backend
//!
//! Handles: SSH connections (russh), KB loading/querying,
//! credential management, config, and KB import.

mod ssh;
#[cfg(debug_assertions)]
pub mod test_server;
mod kb;
mod hosts;
mod credentials;
mod netbox;
mod config;
mod llm;
mod import;
mod paths;
mod session_log;
mod replay;
mod secrets;

use std::process::Command as StdCommand;
use std::sync::Mutex;
use tauri::{Emitter, Manager};
use kb::{KbManager, Command, PlatformIndex, KbValidationIssue};
use hosts::{Host, HostStore, HostGroup, HostGroupStore};
use credentials::ResolvedCredentials;
use ssh::SshManager;
use config::{ConfigStore, parse_log_level_filter, get_llm_api_key};
use import::{ImportRequest, ImportResult, ExtractPreview, CommandPreview};
use paths::{MergeScan, ConflictResolution};

// ─── Log MultiWriter ────────────────────────────────────────────────

/// Caps dependency crates (russh, tao, ...) at warn: their debug output is
/// wire/crypto chatter and dumps raw SSH packets (usernames, key material)
/// into log files. App crates (netssh*) log at the configured level.
/// simplelog 0.12 has no per-target filter, hence the wrapper.
struct DepCapLogger(Box<simplelog::WriteLogger<MultiWriter>>);

impl log::Log for DepCapLogger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        let t = metadata.target();
        t.starts_with("netssh_lib") || t.starts_with("netssh") || metadata.level() <= log::Level::Warn
    }
    fn log(&self, record: &log::Record) {
        if self.enabled(record.metadata()) {
            self.0.log(record);
        }
    }
    fn flush(&self) {
        self.0.flush();
    }
}

/// File writer that truncates to 0 bytes when the file exceeds `max_bytes`.
/// ponytail: single-file cap, no rotation history. Reopen on truncate.
struct SizeCapWriter {
    inner: std::fs::File,
    path: std::path::PathBuf,
    max_bytes: u64,
    size: u64,
}

impl SizeCapWriter {
    fn new(file: std::fs::File, path: std::path::PathBuf, max_bytes: u64) -> Self {
        let size = file.metadata().map(|m| m.len()).unwrap_or(0);
        Self { inner: file, path, max_bytes, size }
    }
}

impl std::io::Write for SizeCapWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let n = self.inner.write(buf)?;
        self.size += n as u64;
        if self.max_bytes > 0 && self.size >= self.max_bytes {
            self.inner.flush()?;
            self.inner = std::fs::OpenOptions::new()
                .write(true)
                .truncate(true)
                .open(&self.path)?;
            self.size = 0;
        }
        Ok(n)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

struct MultiWriter(Vec<Box<dyn std::io::Write + Send + Sync>>);

impl std::io::Write for MultiWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        for w in self.0.iter_mut() {
            w.write_all(buf)?;
        }
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        for w in self.0.iter_mut() {
            w.flush()?;
        }
        Ok(())
    }
}

// ─── Browser URL Opener ─────────────────────────────────────────────

fn open_url(url: &str) {
    log::info!("Opening URL in browser: {}", url);
    let _ = if cfg!(target_os = "windows") {
        // Avoid `cmd /C start` — cmd.exe re-parses the URL and shell
        // metacharacters (&, |, >) in the URL can chain arbitrary commands.
        // `explorer.exe` opens URLs via ShellExecute without shell parsing.
        StdCommand::new("explorer.exe").arg(url).spawn()
    } else if cfg!(target_os = "macos") {
        StdCommand::new("open").arg(url).spawn()
    } else {
        StdCommand::new("xdg-open").arg(url).spawn()
    };
}

#[tauri::command]
async fn open_url_cmd(url: String) -> Result<(), String> {
    // Validate scheme AND reject control characters that could confuse the
    // OS opener on any platform.
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("Only HTTP/HTTPS URLs are allowed".to_string());
    }
    if url.chars().any(|c| c.is_control()) {
        return Err("URL contains control characters".to_string());
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
    /// Secret providers enabled in config. Rebuilt when provider settings
    /// change (chunk 7). Handles are cloned out before awaiting so the lock
    /// is never held across an await.
    providers: Mutex<secrets::ProviderRegistry>,
    /// NetBox device cache (host source). Like the other std-Mutex stores:
    /// clone data out, never hold the guard across an await.
    netbox: Mutex<netbox::NetBoxCacheStore>,
    /// Human-readable reason the custom log path fell back to the default at
    /// startup, if any. Pulled by the frontend on mount (no emit race).
    log_status: Mutex<Option<String>>,
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

#[tauri::command]
async fn validate_kb(
    platform: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<KbValidationIssue>, String> {
    let mut kb = state.kb.lock().map_err(|e| e.to_string())?;
    let commands = kb.get_all_commands(&platform)?;
    Ok(kb::validate_platform(&commands))
}

// ─── Host Commands ──────────────────────────────────────────────────

#[tauri::command]
async fn get_hosts(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<Host>, String> {
    let mut all = {
        let hosts = state.hosts.lock().map_err(|e| e.to_string())?;
        hosts.get_all()?
    };

    // NetBox merge (plan §8.3): read-time only — never written to hosts.json.
    let (enabled, netbox_cfg) = {
        let config = state.config.lock().map_err(|e| e.to_string())?;
        (
            config.host_source_enabled("netbox"),
            netbox::NetBoxConfig::from_json(config.host_source_config("netbox")),
        )
    };
    if enabled {
        let netbox = state.netbox.lock().map_err(|e| e.to_string())?;
        for device in netbox.get().devices.iter().filter(|d| d.enabled) {
            all.push(netbox::materialize_host(device, &netbox_cfg));
        }
    }
    Ok(all)
}

#[tauri::command]
async fn save_host(
    host: Host,
    state: tauri::State<'_, AppState>,
) -> Result<Host, String> {
    if host.source.as_deref() == Some("netbox") || netbox::is_netbox_host_id(&host.id) {
        log::warn!("Rejected save_host on NetBox-sourced host {} (plan §8.4 guard)", host.id);
        return Err("Cannot edit NetBox-sourced hosts".to_string());
    }
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
    if netbox::is_netbox_host_id(&id) {
        log::warn!("Rejected delete_host on NetBox-sourced host {} (plan §8.4 guard)", id);
        return Err(
            "Cannot delete NetBox-sourced hosts — disable the device in Settings → NetBox or remove it in NetBox"
                .to_string(),
        );
    }
    let mut hosts = state.hosts.lock().map_err(|e| e.to_string())?;
    hosts.delete(&id)?;
    // Also delete credential (new key + legacy bare-id entry)
    credentials::delete_secret(&credentials::host_key(&id)).ok();
    Ok(())
}

#[tauri::command]
async fn touch_host(
    id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    if netbox::is_netbox_host_id(&id) {
        let netbox_id: u64 = id
            .strip_prefix("netbox:")
            .and_then(|s| s.parse().ok())
            .ok_or_else(|| format!("Host not found: {}", id))?;
        let mut netbox = state.netbox.lock().map_err(|e| e.to_string())?;
        return netbox.touch(netbox_id);
    }
    let mut hosts = state.hosts.lock().map_err(|e| e.to_string())?;
    hosts.touch(&id)
}

// ─── Credential Commands ────────────────────────────────────────────

#[tauri::command]
async fn save_credential(host_id: String, password: String) -> Result<(), String> {
    credentials::save_secret(&credentials::host_key(&host_id), &password)
}

#[tauri::command]
async fn get_credential(host_id: String) -> Result<Option<String>, String> {
    credentials::get_secret(&credentials::host_key(&host_id))
}

// ─── SSH Agent Commands ─────────────────────────────────────────────

#[tauri::command]
async fn agent_list_identities() -> Result<Vec<secrets::agent::AgentIdentity>, String> {
    secrets::agent::list_identities().await
}

// ─── Host Group Commands ─────────────────────────────────────────────

#[tauri::command]
async fn get_host_groups(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<HostGroup>, String> {
    let mut groups = {
        let group_store = state.groups.lock().map_err(|e| e.to_string())?;
        group_store.get_all()?
    };

    // Synthetic NetBox groups (plan §8.3) — emitted only when enabled and
    // at least one enabled device is cached.
    let enabled = {
        let config = state.config.lock().map_err(|e| e.to_string())?;
        config.host_source_enabled("netbox")
    };
    if enabled {
        let netbox = state.netbox.lock().map_err(|e| e.to_string())?;
        groups.extend(netbox::synthetic_groups(&netbox.get().devices, &netbox.get().geo));
    }
    Ok(groups)
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
    if let Some(ref group_id) = id {
        if netbox::is_synthetic_group_id(group_id) {
            log::warn!("Rejected save_host_group on synthetic NetBox group {} (plan §8.4 guard)", group_id);
            return Err("NetBox groups are managed by the NetBox integration".to_string());
        }
    }
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
async fn move_host_group(
    id: String,
    new_parent: Option<String>,
    sort_order: u32,
    state: tauri::State<'_, AppState>,
) -> Result<HostGroup, String> {
    if netbox::is_synthetic_group_id(&id) {
        log::warn!("Rejected move_host_group on synthetic NetBox group {} (plan §8.4 guard)", id);
        return Err("NetBox groups are managed by the NetBox integration".to_string());
    }
    let mut groups = state.groups.lock().map_err(|e| e.to_string())?;
    let existing = groups
        .get_all()?
        .into_iter()
        .find(|g| g.id == id)
        .ok_or_else(|| format!("Group not found: {}", id))?;
    groups.update(HostGroup {
        parent_id: new_parent,
        sort_order,
        ..existing
    })
}

#[tauri::command]
async fn delete_host_group(
    id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    if netbox::is_synthetic_group_id(&id) {
        log::warn!("Rejected delete_host_group on synthetic NetBox group {} (plan §8.4 guard)", id);
        return Err("NetBox groups are managed by the NetBox integration".to_string());
    }
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
    host_id: String,
    cols: u32,
    rows: u32,
    session_id: u64,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    // Resolve connection parameters Rust-side — secrets never enter the
    // webview. HostStore first (fast path), then the NetBox cache for
    // `netbox:` ids (plan §8.3). All std-Mutex guards are dropped before
    // any await point.
    let (hostname, port, username, credential, secret_key) = {
        let hosts = state.hosts.lock().map_err(|e| e.to_string())?;
        match hosts.get_all()?.into_iter().find(|h| h.id == host_id) {
            Some(host) => (
                host.hostname,
                host.port,
                host.username,
                host.credential,
                credentials::host_key(&host_id),
            ),
            None if netbox::is_netbox_host_id(&host_id) => {
                log::info!("Connecting to NetBox-sourced host {}", host_id);
                // Clone the device out, then read source config separately
                // (sequential locks — never nested).
                let device = {
                    drop(hosts);
                    let netbox = state.netbox.lock().map_err(|e| e.to_string())?;
                    netbox
                        .find_by_host_id(&host_id)
                        .filter(|d| d.enabled)
                        .ok_or_else(|| format!("Host not found: {}", host_id))?
                };
                let netbox_cfg = {
                    let config = state.config.lock().map_err(|e| e.to_string())?;
                    netbox::NetBoxConfig::from_json(config.host_source_config("netbox"))
                };

                // Overlay wins over source defaults (plan §6)
                let username = device
                    .overlay
                    .username
                    .clone()
                    .filter(|u| !u.trim().is_empty())
                    .or_else(|| netbox_cfg.default_username.clone())
                    .filter(|u| !u.trim().is_empty())
                    .ok_or_else(|| {
                        log::warn!("NetBox host {}: no username configured (plan §6)", host_id);
                        "No username configured for this device — set one via Configure or the NetBox source defaults".to_string()
                    })?;
                let port = device.overlay.port.unwrap_or(netbox_cfg.default_port);
                let credential = device
                    .overlay
                    .credential
                    .clone()
                    .or_else(|| netbox_cfg.default_credential.clone());
                if credential.is_none() {
                    log::warn!("NetBox host {}: no authentication method configured (plan §6)", host_id);
                    return Err(
                        "No authentication method configured for this device — set one via Configure or the NetBox source defaults"
                            .to_string(),
                    );
                }
                // Per-device password secret vs source-default password secret
                let secret_key = if device.overlay.credential.is_some() {
                    credentials::host_key(&host_id)
                } else {
                    netbox::DEFAULT_PW_KEY.to_string()
                };
                (device.address, port, username, credential, secret_key)
            }
            None => return Err(format!("Host not found: {}", host_id)),
        }
    };

    // Enforce max concurrent sessions. 0 = unlimited. Check before connecting
    // so we don't consume a TCP connection + auth round-trip just to reject.
    let max_sessions = {
        let config = state.config.lock().map_err(|e| e.to_string())?;
        config.get().max_sessions
    };
    if max_sessions > 0 {
        let mgr = state.ssh.lock().await;
        let current = mgr.session_count();
        if current >= max_sessions as usize {
            return Err(format!(
                "Session limit reached ({} of {}). Disconnect a session or raise the limit in Settings → Terminal.",
                current, max_sessions
            ));
        }
    }

    // Resolve credentials Rust-side — secrets never enter the webview.
    // The provider registry is cloned out before the await: `providers` is
    // a std Mutex and its guard must not be held across an await point.
    // The resolved secret is transient: dropped when `creds` dies at the
    // end of this fn, never logged or persisted.
    let registry = state.providers.lock().map_err(|e| e.to_string())?.clone();
    let creds = match credential.as_ref() {
        Some(credential) => credentials::resolve(credential, &secret_key, &registry).await?,
        None => ResolvedCredentials::default(),
    };

    let (session_logging, session_log_timestamps, session_log_dir) = {
        let config = state.config.lock().map_err(|e| e.to_string())?;
        let c = config.get();
        (c.session_logging, c.session_log_timestamps, c.session_log_dir.clone())
    };

    let session = ssh::SshSession::connect(
        app_handle,
        &hostname,
        port,
        &username,
        creds.password.as_deref(),
        creds.key_path.as_deref(),
        creds.agent,
        cols,
        rows,
        session_id,
        session_logging,
        session_log_timestamps,
        session_log_dir,
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
    mgr.route_send(session_id)?;
    let session = mgr.get_session(session_id)
        .ok_or_else(|| "Session not found".to_string())?;
    session.send(data.as_bytes()).await
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
    mgr.route_resize(session_id, cols, rows)?;
    let session = mgr.get_session(session_id)
        .ok_or_else(|| "Session not found".to_string())?;
    session.resize(cols, rows).await
}

// ─── Config Commands ────────────────────────────────────────────────

#[tauri::command]
async fn get_app_config(
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let config = state.config.lock().map_err(|e| e.to_string())?;
    let mut v = serde_json::to_value(config.get())
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    // API key lives in the OS keychain, not in config.json.
    if let Some(obj) = v.as_object_mut() {
        obj.insert(
            "llm_api_key".to_string(),
            serde_json::Value::from(get_llm_api_key()?),
        );
    }
    Ok(v)
}

#[tauri::command]
async fn save_llm_settings(
    api_format: String,
    base_url: String,
    model: String,
    api_key: Option<String>,
    context_length: u32,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.save_llm_settings(api_format, base_url, model, api_key, context_length)
}

#[tauri::command]
async fn get_log_level(
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let config = state.config.lock().map_err(|e| e.to_string())?;
    Ok(config.get().log_level.clone())
}

#[tauri::command]
async fn set_log_level(
    level: String,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let level = level.to_ascii_lowercase();
    match level.as_str() {
        "debug" | "info" | "warn" | "error" => {}
        _ => return Err(format!("Invalid log level: {}", level)),
    }

    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.save_log_level(level.clone())?;
    drop(config);

    // simplelog reads the level filter per-record, so both raising and
    // lowering take effect live via log::set_max_level.
    log::set_max_level(parse_log_level_filter(&level));
    log::info!("Log level set to {}", level);

    let _ = app_handle.emit("log-level-changed", &level);
    Ok(())
}

#[tauri::command]
async fn set_log_max_size(
    max_mb: u32,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.save_log_max_size_mb(max_mb)?;
    log::info!(
        "Log file size cap set to {}MB (takes effect on next app start)",
        max_mb
    );
    Ok(())
}

#[tauri::command]
async fn set_max_sessions(
    max: u32,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.save_max_sessions(max)?;
    log::info!("Max sessions set to {}", if max == 0 { "unlimited".into() } else { max.to_string() });
    Ok(())
}

#[tauri::command]
async fn get_session_log_dir() -> Result<String, String> {
    let dir = crate::paths::app_data_dir()?.join("session-logs");
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
async fn set_session_logging(
    enabled: bool,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.save_session_logging(enabled)?;
    Ok(())
}

#[tauri::command]
async fn set_session_log_timestamps(
    enabled: bool,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.save_session_log_timestamps(enabled)?;
    Ok(())
}

#[tauri::command]
async fn set_session_log_dir(
    dir: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.save_session_log_dir(dir)?;
    Ok(())
}

// ─── Backup / Restore Commands ──────────────────────────────────────

#[tauri::command]
async fn export_data(dest_path: String) -> Result<(), String> {
    let path = std::path::PathBuf::from(&dest_path);
    crate::paths::export_data(&path)
}

/// Overwrite mode: replaces all data with the zip contents.
#[tauri::command]
async fn import_data(src_path: String) -> Result<(), String> {
    let path = std::path::PathBuf::from(&src_path);
    crate::paths::import_data(&path, crate::paths::ImportMode::Overwrite)?;
    Ok(())
}

/// Restart the app process (used after data restore).
#[tauri::command]
async fn restart_app(app_handle: tauri::AppHandle) -> Result<(), String> {
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
async fn scan_merge(src_path: String) -> Result<MergeScan, String> {
    let path = std::path::PathBuf::from(&src_path);
    crate::paths::scan_merge(&path)
}

/// Merge step 2: apply the merge with user-provided conflict resolutions.
#[tauri::command]
async fn apply_merge(
    temp_dir: String,
    resolutions: std::collections::HashMap<String, ConflictResolution>,
) -> Result<String, String> {
    let path = std::path::PathBuf::from(&temp_dir);
    crate::paths::apply_merge(&path, &resolutions)
}

#[tauri::command]
async fn get_log_status(
    state: tauri::State<'_, AppState>,
) -> Result<Option<String>, String> {
    let status = state.log_status.lock().map_err(|e| e.to_string())?;
    Ok(status.clone())
}

#[tauri::command]
async fn set_log_file_path(
    path: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.save_log_file_path(path.clone())?;
    log::info!(
        "Log file path set to {} (takes effect on next app start)",
        path.as_deref().unwrap_or("<default>")
    );
    Ok(())
}

#[tauri::command]
async fn log_frontend(level: String, tag: String, msg: String, args: Option<String>) -> Result<(), String> {
    let line = match args.as_deref() {
        Some(a) if !a.is_empty() => format!("{} {}", msg, a),
        _ => msg.clone(),
    };
    match level.as_str() {
        "debug" => log::debug!("[fe:{}] {}", tag, line),
        "info" => log::info!("[fe:{}] {}", tag, line),
        "warn" => log::warn!("[fe:{}] {}", tag, line),
        "error" => log::error!("[fe:{}] {}", tag, line),
        _ => return Err("invalid level".into()),
    }
    Ok(())
}

// ─── Secret Provider Commands (chunk 6) ─────────────────────────────

#[derive(serde::Serialize)]
struct ProviderInfo {
    id: &'static str,
    status: secrets::ProviderStatus,
    can_list: bool,
}

/// All enabled providers with their live status (settings UI, chunk 7).
#[tauri::command]
async fn list_providers(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ProviderInfo>, String> {
    let providers = {
        let registry = state.providers.lock().map_err(|e| e.to_string())?;
        registry.all()
    };
    let mut out = Vec::with_capacity(providers.len());
    for p in providers {
        out.push(ProviderInfo { id: p.id(), status: p.status().await, can_list: p.can_list() });
    }
    Ok(out)
}

/// Enumerate a provider's credentials for the browse UI (chunk 15).
#[tauri::command]
async fn list_credentials(
    provider: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<secrets::CredentialItem>, String> {
    let p = {
        let registry = state.providers.lock().map_err(|e| e.to_string())?;
        registry.get(&provider)
    }
    .ok_or_else(|| format!("Unknown or disabled provider: {}", provider))?;
    p.list().await
}

/// Validate a provider reference and return its display label without
/// exposing the secret (host form "Test" button, chunk 9).
#[tauri::command]
async fn test_ref(
    provider: String,
    reference: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let p = {
        let registry = state.providers.lock().map_err(|e| e.to_string())?;
        registry.get(&provider)
    }
    .ok_or_else(|| format!("Unknown or disabled provider: {}", provider))?;
    p.test_reference(&reference).await
}

/// Config + secret state for one provider's settings form (chunk 7).
#[derive(serde::Serialize)]
struct ProviderState {
    enabled: bool,
    has_secret: bool,
}

#[tauri::command]
async fn get_provider_state(
    provider: String,
    state: tauri::State<'_, AppState>,
) -> Result<ProviderState, String> {
    let config = state.config.lock().map_err(|e| e.to_string())?;
    let enabled = config
        .get()
        .providers
        .get(&provider)
        .and_then(|v| v.get("enabled"))
        .and_then(|b| b.as_bool())
        .unwrap_or(false);
    let has_secret = crate::config::get_provider_secret(&provider)?.is_some();
    Ok(ProviderState { enabled, has_secret })
}

/// Persist a provider's config and rebuild the live registry (chunk 7).
#[tauri::command]
async fn save_provider_config(
    provider: String,
    config: serde_json::Value,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let new_registry = {
        let mut store = state.config.lock().map_err(|e| e.to_string())?;
        store.save_provider_config(provider, config)?;
        secrets::ProviderRegistry::from_config(store.get())
    };
    *state.providers.lock().map_err(|e| e.to_string())? = new_registry;
    Ok(())
}

/// Store or clear a provider's secret in the OS keyring (chunk 7).
#[tauri::command]
async fn save_provider_secret(
    provider: String,
    secret: Option<String>,
) -> Result<(), String> {
    crate::config::save_provider_secret(&provider, secret)
}

// ─── NetBox Host Source Commands (plan §8.2) ─────────────────────────

/// Save-or-delete a keyring secret: `None`/empty deletes the entry.
fn save_optional_secret(key: &str, secret: Option<String>) -> Result<(), String> {
    match secret {
        Some(s) if !s.is_empty() => credentials::save_secret(key, &s),
        _ => credentials::delete_secret(key),
    }
}

/// Config + secret state for the NetBox settings form. The token itself is
/// never serialized to the frontend — only whether one exists.
#[derive(serde::Serialize)]
struct NetBoxConfigState {
    config: netbox::NetBoxConfig,
    has_token: bool,
}

#[tauri::command]
async fn netbox_get_config(
    state: tauri::State<'_, AppState>,
) -> Result<NetBoxConfigState, String> {
    let config = {
        let store = state.config.lock().map_err(|e| e.to_string())?;
        netbox::NetBoxConfig::from_json(store.host_source_config("netbox"))
    };
    let has_token = credentials::get_secret(netbox::TOKEN_KEY)?.is_some();
    Ok(NetBoxConfigState { config, has_token })
}

#[tauri::command]
async fn netbox_save_config(
    config: netbox::NetBoxConfig,
    default_password: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<netbox::NetBoxConfig, String> {
    config.validate()?;
    {
        let mut store = state.config.lock().map_err(|e| e.to_string())?;
        let json = serde_json::to_value(&config)
            .map_err(|e| format!("Failed to serialize NetBox config: {}", e))?;
        store.save_host_source_config("netbox", json)?;
    }
    // Source-default password: set when supplied, cleared when the default
    // credential is no longer Password. Blank = unchanged.
    match config.default_credential.as_ref() {
        Some(credentials::CredentialSource::Password) => {
            if default_password.is_some() {
                save_optional_secret(netbox::DEFAULT_PW_KEY, default_password)?;
            }
        }
        _ => credentials::delete_secret(netbox::DEFAULT_PW_KEY)?,
    }
    log::info!(
        "NetBox config saved (enabled={} base_url={} default_port={})",
        config.enabled,
        config.base_url,
        config.default_port
    );
    Ok(config)
}

#[tauri::command]
async fn netbox_save_token(token: Option<String>) -> Result<(), String> {
    save_optional_secret(netbox::TOKEN_KEY, token.clone())?;
    log::info!("NetBox API token {}", if token.is_some() { "saved" } else { "cleared" });
    Ok(())
}

/// Test a URL + token against the NetBox API without saving anything.
/// A blank token falls back to the stored one (test-before-save, re-test).
/// `allow_invalid_certs` must be passed explicitly by the caller so the
/// toggle state in the form is what gets tested, not the saved config.
#[tauri::command]
async fn netbox_test_connection(
    base_url: String,
    token: Option<String>,
    allow_invalid_certs: bool,
) -> Result<serde_json::Value, String> {
    let token = match token {
        Some(t) if !t.trim().is_empty() => t.trim().to_string(),
        _ => credentials::get_secret(netbox::TOKEN_KEY)?
            .ok_or_else(|| "No NetBox API token saved — enter one first".to_string())?,
    };
    let client = netbox::NetBoxClient::new(&base_url, &token, allow_invalid_certs)?;
    let (version, device_count) = client.test_connection().await?;
    Ok(serde_json::json!({ "version": version, "device_count": device_count }))
}

#[tauri::command]
async fn netbox_sync(
    state: tauri::State<'_, AppState>,
) -> Result<netbox::SyncReport, String> {
    let config = {
        let store = state.config.lock().map_err(|e| e.to_string())?;
        netbox::NetBoxConfig::from_json(store.host_source_config("netbox"))
    };
    if !config.enabled {
        return Err("NetBox integration is disabled — enable it in Settings → NetBox".to_string());
    }
    if config.base_url.trim().is_empty() {
        return Err("No NetBox URL configured — set one in Settings → NetBox".to_string());
    }
    let token = credentials::get_secret(netbox::TOKEN_KEY)?
        .ok_or_else(|| "No NetBox API token saved — enter one in Settings → NetBox".to_string())?;

    let client = netbox::NetBoxClient::new(&config.base_url, &token, config.allow_invalid_certs)?;
    let fetch = client.fetch_devices(&config.filters).await?;
    let geo = client.fetch_geo().await; // degrades internally — never fails the sync
    let (entries, mut report) = netbox::build_entries(&fetch.devices, &config.platform_policy());
    report.no_primary_ip = fetch.no_primary_ip;

    log::info!(
        "NetBox sync: {} fetched, {} no primary IP, {} skipped platform (unmatched: {}), {} cached",
        report.fetched,
        report.no_primary_ip,
        report.skipped_platform,
        if report.unmatched_platforms.is_empty() {
            "none".to_string()
        } else {
            report.unmatched_platforms.join(", ")
        },
        entries.len()
    );

    let mut netbox = state.netbox.lock().map_err(|e| e.to_string())?;
    netbox.apply_sync(report, entries, geo)
}

#[tauri::command]
async fn netbox_get_devices(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<netbox::NetBoxDeviceEntry>, String> {
    let netbox = state.netbox.lock().map_err(|e| e.to_string())?;
    Ok(netbox.get().devices.clone())
}

fn build_netbox_client(state: &AppState) -> Result<netbox::NetBoxClient, String> {
    let config = {
        let store = state.config.lock().map_err(|e| e.to_string())?;
        netbox::NetBoxConfig::from_json(store.host_source_config("netbox"))
    };
    if config.base_url.trim().is_empty() {
        return Err("No NetBox URL configured — set one in Settings → NetBox".to_string());
    }
    let token = credentials::get_secret(netbox::TOKEN_KEY)?
        .ok_or_else(|| "No NetBox API token saved — enter one in Settings → NetBox".to_string())?;
    netbox::NetBoxClient::new(&config.base_url, &token, config.allow_invalid_certs)
}

#[tauri::command]
async fn netbox_get_sites(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<netbox::NetBoxChoice>, String> {
    let client = build_netbox_client(&state)?;
    client.fetch_sites().await
}

#[tauri::command]
async fn netbox_get_roles(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<netbox::NetBoxChoice>, String> {
    let client = build_netbox_client(&state)?;
    client.fetch_device_roles().await
}

#[tauri::command]
async fn netbox_get_tags(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<netbox::NetBoxChoice>, String> {
    let client = build_netbox_client(&state)?;
    client.fetch_tags().await
}

#[tauri::command]
async fn netbox_set_device_enabled(
    netbox_id: u64,
    enabled: bool,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mut netbox = state.netbox.lock().map_err(|e| e.to_string())?;
    netbox.set_enabled(netbox_id, enabled)
}

/// Save a per-device overlay. A supplied `password` is stored in the keyring
/// under the device's host key; switching the overlay away from Password
/// clears the stored per-device secret. Blank password = unchanged.
#[tauri::command]
async fn netbox_set_device_overlay(
    netbox_id: u64,
    overlay: netbox::DeviceOverlay,
    password: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let host_key = credentials::host_key(&netbox::host_id(netbox_id));
    {
        let mut netbox = state.netbox.lock().map_err(|e| e.to_string())?;
        netbox.set_overlay(netbox_id, overlay.clone())?;
    }
    match overlay.credential.as_ref() {
        Some(credentials::CredentialSource::Password) => {
            if password.is_some() {
                save_optional_secret(&host_key, password)?;
            }
        }
        _ => credentials::delete_secret(&host_key)?,
    }
    Ok(())
}

/// Header-line status for the NetBox settings section.
#[tauri::command]
async fn netbox_get_status(
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let (enabled, last_synced, device_count) = {
        let store = state.config.lock().map_err(|e| e.to_string())?;
        let enabled = store.host_source_enabled("netbox");
        let netbox = state.netbox.lock().map_err(|e| e.to_string())?;
        (enabled, netbox.get().last_synced.clone(), netbox.get().devices.len())
    };
    let has_token = credentials::get_secret(netbox::TOKEN_KEY)?.is_some();
    let has_default_pw = credentials::get_secret(netbox::DEFAULT_PW_KEY)?.is_some();
    Ok(serde_json::json!({
        "enabled": enabled,
        "has_token": has_token,
        "has_default_pw": has_default_pw,
        "last_synced": last_synced,
        "device_count": device_count,
    }))
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

    // Platform index supplies the valid mode vocabulary + default mode for import
    let platform_index = {
        let mut kb = state.kb.lock().map_err(|e| e.to_string())?;
        kb.get_platform_index(&request.platform)?
    };

    let result = import::import_from_url(
        request,
        &config_ref,
        &user_kb_path,
        &app_handle,
        &platform_index,
    ).await?;

    // Reload KB stores so new commands are immediately available
    {
        let mut kb = state.kb.lock().map_err(|e| e.to_string())?;
        kb.reload_all();
    }

    Ok(result)
}

/// Phase 5.6: Stage 1 of the two-stage import — extract + validate without
/// writing. Returns a preview the user reviews before committing.
///
/// `platformName` is supplied only when the user chose "New platform…" in the
/// import dialog (docs/10 § Part 5): it unlocks a placeholder single-mode
/// index for platforms with no bundled/user KB yet. Without it, unknown
/// platforms still fail extraction (guards against platform-id typos).
#[tauri::command]
async fn extract_kb_preview(
    url: String,
    platform: String,
    category: String,
    platform_name: Option<String>,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<ExtractPreview, String> {
    let request = ImportRequest { url, platform, category };

    let (config_ref, _user_kb_path) = {
        let config = state.config.lock().map_err(|e| e.to_string())?;
        (config.get().clone(), config.user_kb_path())
    };

    let platform_index = {
        let mut kb = state.kb.lock().map_err(|e| e.to_string())?;
        match kb.get_platform_index(&request.platform) {
            Ok(idx) => idx,
            Err(e) => match platform_name {
                Some(name) => {
                    log::info!("Import: using placeholder single-mode index for new platform '{}'", request.platform);
                    import::new_platform_index(&request.platform, &name)
                }
                None => return Err(e),
            },
        }
    };

    let preview = import::extract_from_url(
        request,
        &config_ref,
        &app_handle,
        &platform_index,
    ).await?;

    Ok(preview)
}

/// Phase 5.6: Stage 2 of the two-stage import — write the user-approved
/// commands to YAML and reload. Does not re-extract.
///
/// The frontend sends ONLY the accepted previews; committing zero commands
/// is an error. `platformName` names a truly-new platform scaffold (docs/10
/// § Part 5).
#[tauri::command]
async fn commit_kb_import(
    previews: Vec<CommandPreview>,
    platform: String,
    category: String,
    platform_name: Option<String>,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<usize, String> {
    let user_kb_path = {
        let config = state.config.lock().map_err(|e| e.to_string())?;
        config.user_kb_path()
    };

    let commands: Vec<Command> = previews.into_iter().map(|p| p.command).collect();
    let count = commands.len();

    import::commit_import(
        commands,
        &import::default_bundled_kb_path(),
        &user_kb_path,
        &platform,
        &category,
        &app_handle,
        platform_name.as_deref(),
    ).await?;

    // Reload KB stores so new commands are immediately available
    {
        let mut kb = state.kb.lock().map_err(|e| e.to_string())?;
        kb.reload_all();
    }

    Ok(count)
}

#[tauri::command]
async fn test_llm_connection(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let (api_format, base_url, model, context_length) = {
        let config = state.config.lock().map_err(|e| e.to_string())?;
        let cfg = config.get();
        (cfg.llm_api_format.clone(), cfg.llm_base_url.clone(), cfg.llm_model.clone(), cfg.llm_context_length)
    };
    let api_key = get_llm_api_key()?;

    let llm = llm::LlmClient::new(
        base_url,
        model,
        api_key,
        context_length,
        api_format,
    );

    llm.list_models().await
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
    // Phase 5.8: optional token fields. `tokens_json` is a JSON array of
    // CommandToken; absent/blank → no tokens (legacy entry). Malformed JSON is
    // an outer error — we never silently drop bad input on save.
    tokens_json: Option<String>,
    order: Option<String>,
    negatable: Option<bool>,
    state: tauri::State<'_, AppState>,
) -> Result<Result<(), Vec<kb::KbValidationIssue>>, String> {
    let user_kb_path = {
        let config = state.config.lock().map_err(|e| e.to_string())?;
        config.user_kb_path()
    };

    // Malformed token JSON is a hard error (outer Err), not a silent downgrade.
    let tokens: Vec<kb::CommandToken> = kb::parse_tokens(tokens_json.as_deref())?;

    let order_val = match order.as_deref() {
        Some("flags-anywhere") => kb::CommandOrder::FlagsAnywhere,
        Some("free") => kb::CommandOrder::Free,
        _ => kb::CommandOrder::Fixed,
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
        tokens,
        order: order_val,
        negatable: negatable.unwrap_or(false),
        source: None,
        overrides: false,
    };

    // Error-severity issues block the save and are returned to the UI. Warnings
    // don't block — they're surfaced separately via validate_kb.
    let errors: Vec<kb::KbValidationIssue> = kb::validate_command(&command)
        .into_iter()
        .filter(|i| i.severity == "error")
        .collect();
    if !errors.is_empty() {
        return Ok(Err(errors));
    }

    kb::save_kb_command(&user_kb_path, &platform, &category, &command)?;

    // Reload KB so changes are reflected immediately
    {
        let mut kb = state.kb.lock().map_err(|e| e.to_string())?;
        kb.reload_all();
    }

    Ok(Ok(()))
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

    kb::delete_kb_command(&user_kb_path, &platform, &category, &command_name)?;

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

/// Open (creating if needed) the log file at `path`, lock perms on unix, and
/// append a size-capped writer to `writers`.
fn open_log_file(
    writers: &mut Vec<Box<dyn std::io::Write + Send + Sync>>,
    path: &std::path::Path,
    max_mb: u32,
) -> Result<(), String> {
    let dir = path
        .parent()
        .unwrap_or(std::path::Path::new("."))
        .to_path_buf();
    crate::paths::ensure_data_dir(&dir)
        .map_err(|e| format!("create log dir {}: {}", dir.display(), e))?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("open log file {}: {}", path.display(), e))?;
    // Log holds hostnames/usernames — lock perms on unix.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    let cap_bytes = if max_mb == 0 { u64::MAX } else { max_mb as u64 * 1024 * 1024 };
    writers.push(Box::new(SizeCapWriter::new(file, path.to_path_buf(), cap_bytes)));
    Ok(())
}

/// Resolve the log file path. A `None`/empty/whitespace custom path yields
/// the default (`paths::log_dir()/netssh.log`, `used_custom = false`). A
/// non-absolute custom path is rejected (the logger runs before CWD
/// stabilizes) and falls back to the default. Otherwise the custom path is
/// returned as-is — open/create failures are handled by the caller, which
/// knows whether to surface a fallback warning.
fn resolve_log_path(custom: Option<&str>) -> (std::path::PathBuf, bool) {
    let default = || {
        crate::paths::log_dir()
            .map(|d| d.join("netssh.log"))
            .unwrap_or_else(|_| std::path::PathBuf::from("netssh.log"))
    };
    let Some(p) = custom.map(str::trim).filter(|s| !s.is_empty()) else {
        return (default(), false);
    };
    let path = std::path::PathBuf::from(p);
    if !path.is_absolute() {
        return (default(), false);
    }
    (path, true)
}

// ─── App Entry ──────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Resolve the app data dir before the logger so the early config read and
    // the store setup below share one path. No AppHandle exists yet, so use
    // `paths::app_data_dir()` (replicates Tauri's `app_local_data_dir`).
    let data_dir = crate::paths::app_data_dir();

    // One-shot: copy persisted JSON from the legacy `dirs::data_dir()/netsh`
    // location into the new bundle-id dir, before anything reads it.
    if let Ok(d) = &data_dir {
        if crate::paths::ensure_data_dir(d).is_ok() {
            crate::paths::migrate_data_dir(d);
        }
    }

    // Read config once before initializing the logger.
    let (level, max_mb, custom_log_path) = match &data_dir {
        Ok(d) => ConfigStore::new(d)
            .map(|c| {
                (
                    c.get().log_level.clone(),
                    c.get().log_max_size_mb,
                    c.get().log_file_path.clone(),
                )
            })
            .unwrap_or_else(|e| {
                // Logger not yet up; print to stderr as a last resort.
                eprintln!(
                    "netssh: Failed to read config ({}). Using 'info'/10MB/default log path.",
                    e
                );
                ("info".to_string(), 10, None)
            }),
        Err(_) => ("info".to_string(), 10, None),
    };
    let filter = parse_log_level_filter(&level);
    let mut cfg = simplelog::ConfigBuilder::new();
    // local time so app log matches session logs; falls back to UTC if unreadable
    let _ = cfg.set_time_offset_to_local();
    let config = cfg
        .set_time_format_custom(simplelog::format_description!("[year]-[month]-[day] [hour]:[minute]:[second]"))
        .build();
    let mut writers: Vec<Box<dyn std::io::Write + Send + Sync>> =
        vec![Box::new(std::io::stderr())];
    // File logging — always on (dev + release). A user who sets a custom
    // path expects it to work regardless of build mode.
    let mut log_fallback_reason: Option<String> = None;
    {
        let (log_path, used_custom) = resolve_log_path(custom_log_path.as_deref());
        if used_custom {
            // Try the custom path first; on failure, record why and fall
            // back to the default path.
            if let Err(e) = open_log_file(&mut writers, &log_path, max_mb) {
                log_fallback_reason = Some(e);
                if let Ok(default_path) = crate::paths::log_dir().map(|d| d.join("netssh.log")) {
                    let _ = open_log_file(&mut writers, &default_path, max_mb);
                }
            }
        } else if let Err(e) = open_log_file(&mut writers, &log_path, max_mb) {
            eprintln!("netssh: {}", e);
        }
    }
    let multi = MultiWriter(writers);
    let logger = Box::leak(Box::new(DepCapLogger(simplelog::WriteLogger::new(
        filter, config, multi,
    ))));
    let _ = log::set_logger(logger);
    log::set_max_level(filter);

    // Install a panic hook so panics are captured in netssh.log instead of
    // vanishing into the void. The default hook prints to stderr only, which
    // a desktop app user never sees. This hook logs at error level (going
    // through MultiWriter → file + stderr) and then chains to the previous
    // hook to preserve the default unwind/backtrace behaviour.
    let prev_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info.location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown>".to_string());
        let payload = info.payload();
        let msg = if let Some(s) = payload.downcast_ref::<&str>() {
            s.to_string()
        } else if let Some(s) = payload.downcast_ref::<String>() {
            s.clone()
        } else {
            "<non-string panic payload>".to_string()
        };
        log::error!("PANIC at {} — {}", location, msg);
        // Chain to the previous hook for default behaviour (backtrace, abort
        // if panic=abort, etc.).
        prev_hook(info);
    }));

    log::info!("netssh v{} starting", env!("CARGO_PKG_VERSION"));

    let data_dir: std::path::PathBuf = data_dir.unwrap_or_else(|_| std::path::PathBuf::from("."));

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
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

            let host_store = HostStore::new(&data_dir).unwrap_or_else(|e| {
                log::warn!("Failed to init host store: {}. Using in-memory fallback.", e);
                HostStore::in_memory()
            });

            log::info!("Host store initialized");

            let group_store = HostGroupStore::new(&data_dir).unwrap_or_else(|e| {
                log::warn!("Failed to init group store: {}. Using in-memory fallback.", e);
                HostGroupStore::in_memory()
            });

            log::info!("Group store initialized");

            let config_store = ConfigStore::new(&data_dir)
                .or_else(|e| {
                    log::warn!("Failed to init config store: {}. Trying fallback path.", e);
                    ConfigStore::new_with_path(data_dir.join("config.json"))
                })
                .unwrap_or_else(|e| {
                    log::error!("Failed to create config store: {}. Using in-memory fallback — settings will not persist.", e);
                    ConfigStore::in_memory()
                });

            let user_kb_path = config_store.user_kb_path();
            log::info!("User KB path: {}", user_kb_path.display());

            let provider_registry = secrets::ProviderRegistry::from_config(config_store.get());

            let netbox_store = netbox::NetBoxCacheStore::new(&data_dir).unwrap_or_else(|e| {
                log::warn!("Failed to init NetBox cache store: {}. Using in-memory fallback.", e);
                netbox::NetBoxCacheStore::in_memory()
            });

            app.manage(AppState {
                kb: Mutex::new(KbManager::with_user_path(kb_path, user_kb_path)),
                hosts: Mutex::new(host_store),
                groups: Mutex::new(group_store),
                ssh: tokio::sync::Mutex::new(SshManager::new()),
                config: Mutex::new(config_store),
                providers: Mutex::new(provider_registry),
                netbox: Mutex::new(netbox_store),
                log_status: Mutex::new(log_fallback_reason),
            });

            Ok(())
        })
        .invoke_handler({
            tauri::generate_handler![
                query_kb,
                load_platform_index,
                validate_kb,
                get_hosts,
                save_host,
                delete_host,
                touch_host,
                save_credential,
                get_credential,
                agent_list_identities,
                ssh_connect,
                ssh_send,
                ssh_disconnect,
                ssh_resize,
                get_app_config,
                save_llm_settings,
                get_log_level,
                set_log_level,
                set_log_max_size,
                set_max_sessions,
                get_session_log_dir,
                set_session_log_dir,
                set_session_logging,
                set_session_log_timestamps,
                set_log_file_path,
                get_log_status,
                log_frontend,
                list_providers,
                test_ref,
                list_credentials,
                get_provider_state,
                save_provider_config,
                save_provider_secret,
                netbox_get_config,
                netbox_save_config,
                netbox_save_token,
                netbox_test_connection,
                netbox_sync,
                netbox_get_devices,
                netbox_get_sites,
                netbox_get_roles,
                netbox_get_tags,
                netbox_set_device_enabled,
                netbox_set_device_overlay,
                netbox_get_status,
                import_kb_url,
                extract_kb_preview,
                commit_kb_import,
                test_llm_connection,
                list_kb_platforms,
                get_all_kb_commands,
                save_kb_command,
                delete_kb_command,
                get_host_groups,
                save_host_group,
                move_host_group,
                open_url_cmd,
                delete_host_group,
                export_data,
                import_data,
                scan_merge,
                apply_merge,
                restart_app,
                replay::replay_list,
                replay::replay_save,
                replay::replay_delete,
                #[cfg(debug_assertions)]
                test_mock_server,
                #[cfg(debug_assertions)]
                test_stop_mock_server,
            ]
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resolve_log_path_none_uses_default() {
        let (path, used_custom) = resolve_log_path(None);
        assert!(!used_custom);
        assert!(path.to_string_lossy().contains("netssh.log"));
    }

    #[test]
    fn test_resolve_log_path_empty_and_whitespace_uses_default() {
        for input in [Some(""), Some("   ")] {
            let (path, used_custom) = resolve_log_path(input);
            assert!(!used_custom, "input {:?} should use default", input);
            assert!(path.to_string_lossy().contains("netssh.log"));
        }
    }

    #[test]
    fn test_resolve_log_path_relative_falls_back_to_default() {
        let (path, used_custom) = resolve_log_path(Some("relative/path/netssh.log"));
        assert!(!used_custom);
        assert!(path.to_string_lossy().contains("netssh.log"));
    }

    #[test]
    fn test_resolve_log_path_absolute_custom() {
        #[cfg(unix)]
        let custom = "/tmp/netssh-test-logs/netssh.log";
        #[cfg(windows)]
        let custom = "C:\\netssh-test-logs\\netssh.log";
        let (path, used_custom) = resolve_log_path(Some(custom));
        assert!(used_custom);
        assert_eq!(path, std::path::PathBuf::from(custom));
    }

    #[test]
    fn test_panic_hook_logs_and_chains() {
        // The panic hook logs the message via `log::error!` and chains to
        // the previous hook. We can't easily test the log output without a
        // test logger, but we can verify the hook doesn't double-panic and
        // that the chained hook runs. Use catch_unwind to isolate.
        use std::panic::{catch_unwind, take_hook, set_hook};

        // Save and restore the current hook so this test doesn't pollute
        // other tests.
        let saved = take_hook();

        // Install a chain: our hook sets a flag, then calls the "prev" hook.
        let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag_clone = flag.clone();
        let prev = take_hook(); // the default hook
        set_hook(Box::new(move |info| {
            flag_clone.store(true, std::sync::atomic::Ordering::SeqCst);
            prev(info);
        }));

        let result = catch_unwind(|| {
            panic!("test panic from test_panic_hook_logs_and_chains");
        });
        assert!(result.is_err());
        assert!(flag.load(std::sync::atomic::Ordering::SeqCst),
            "chained hook should have run");

        // Restore
        let _ = take_hook();
        set_hook(saved);
    }
}
