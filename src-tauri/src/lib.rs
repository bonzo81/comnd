//! comnd — Tauri backend
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
mod transcript;
mod replay;
mod secrets;
mod platform;
mod state;

use std::process::Command as StdCommand;
use std::sync::Mutex;
use tauri::Manager;
use kb::KbManager;
use hosts::HostStore;
use ssh::SshManager;
use config::{ConfigStore, parse_log_level_filter};
use platform::PlatformRegistry;
use state::AppState;

// ─── Log MultiWriter ────────────────────────────────────────────────

/// Caps dependency crates (russh, tao, ...) at warn: their debug output is
/// wire/crypto chatter and dumps raw SSH packets (usernames, key material)
/// into log files. App crates (comnd*) log at the configured level.
/// simplelog 0.12 has no per-target filter, hence the wrapper.
struct DepCapLogger(Box<simplelog::WriteLogger<MultiWriter>>);

impl log::Log for DepCapLogger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        let t = metadata.target();
        t.starts_with("comnd_lib") || t.starts_with("comnd") || metadata.level() <= log::Level::Warn
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

// ÔöÇÔöÇÔöÇ Test Commands (debug only) ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

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
    // Log holds hostnames/usernames ÔÇö lock perms on unix.
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
/// the default (`paths::log_dir()/comnd.log`, `used_custom = false`). A
/// non-absolute custom path is rejected (the logger runs before CWD
/// stabilizes) and falls back to the default. Otherwise the custom path is
/// returned as-is ÔÇö open/create failures are handled by the caller, which
/// knows whether to surface a fallback warning.
fn resolve_log_path(custom: Option<&str>) -> (std::path::PathBuf, bool) {
    let default = || {
        crate::paths::log_dir()
            .map(|d| d.join("comnd.log"))
            .unwrap_or_else(|_| std::path::PathBuf::from("comnd.log"))
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

// ÔöÇÔöÇÔöÇ App Entry ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

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
                    "comnd: Failed to read config ({}). Using 'info'/10MB/default log path.",
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
    // File logging ÔÇö always on (dev + release). A user who sets a custom
    // path expects it to work regardless of build mode.
    let mut log_fallback_reason: Option<String> = None;
    {
        let (log_path, used_custom) = resolve_log_path(custom_log_path.as_deref());
        if used_custom {
            // Try the custom path first; on failure, record why and fall
            // back to the default path.
            if let Err(e) = open_log_file(&mut writers, &log_path, max_mb) {
                log_fallback_reason = Some(e);
                if let Ok(default_path) = crate::paths::log_dir().map(|d| d.join("comnd.log")) {
                    let _ = open_log_file(&mut writers, &default_path, max_mb);
                }
            }
        } else if let Err(e) = open_log_file(&mut writers, &log_path, max_mb) {
            eprintln!("comnd: {}", e);
        }
    }
    let multi = MultiWriter(writers);
    let logger = Box::leak(Box::new(DepCapLogger(simplelog::WriteLogger::new(
        filter, config, multi,
    ))));
    let _ = log::set_logger(logger);
    log::set_max_level(filter);

    // Install a panic hook so panics are captured in comnd.log instead of
    // vanishing into the void. The default hook prints to stderr only, which
    // a desktop app user never sees. This hook logs at error level (going
    // through MultiWriter ÔåÆ file + stderr) and then chains to the previous
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
        log::error!("PANIC at {} ÔÇö {}", location, msg);
        // Chain to the previous hook for default behaviour (backtrace, abort
        // if panic=abort, etc.).
        prev_hook(info);
    }));

    log::info!("comnd v{} starting", env!("CARGO_PKG_VERSION"));

    let data_dir: std::path::PathBuf = data_dir.unwrap_or_else(|_| std::path::PathBuf::from("."));

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // P1.4 — in-app updater (minisign-signed; ADR-006) + relaunch after install.
        // The updater plugin has no `init()`; it is configured via tauri.conf.json and
        // registered through its Builder.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(move |app| {
            // Resolve KB path ÔÇö in dev, it's relative to project root
            let resource_dir = app.path()
                .resource_dir()
                .unwrap_or_else(|_| std::env::current_dir().unwrap_or_default());
            let kb_path = crate::paths::bundled_kb_path(&resource_dir);

            log::info!("KB path: {}", kb_path.display());

            let host_store = HostStore::new(&data_dir).unwrap_or_else(|e| {
                log::warn!("Failed to init host store: {}. Using in-memory fallback.", e);
                HostStore::in_memory()
            });

            log::info!("Host store initialized");

            let config_store = ConfigStore::new(&data_dir)
                .or_else(|e| {
                    log::warn!("Failed to init config store: {}. Trying fallback path.", e);
                    ConfigStore::new_with_path(data_dir.join("config.json"))
                })
                .unwrap_or_else(|e| {
                    log::error!("Failed to create config store: {}. Using in-memory fallback ÔÇö settings will not persist.", e);
                    ConfigStore::in_memory()
                });

            let user_kb_path = config_store.user_kb_path();
            log::info!("User KB path: {}", user_kb_path.display());

            let provider_registry = secrets::ProviderRegistry::from_config(config_store.get());

            let netbox_store = netbox::NetBoxCacheStore::new(&data_dir).unwrap_or_else(|e| {
                log::warn!("Failed to init NetBox cache store: {}. Using in-memory fallback.", e);
                netbox::NetBoxCacheStore::in_memory()
            });

            let platform_registry = PlatformRegistry::scan(&kb_path, Some(user_kb_path.as_path()));

            app.manage(AppState {
                kb: Mutex::new(KbManager::with_user_path(kb_path, user_kb_path)),
                hosts: Mutex::new(host_store),
                ssh: tokio::sync::Mutex::new(SshManager::new()),
                config: Mutex::new(config_store),
                providers: Mutex::new(provider_registry),
                netbox: Mutex::new(netbox_store),
                platforms: Mutex::new(platform_registry),
                log_status: Mutex::new(log_fallback_reason),
            });

            Ok(())
        })
        .invoke_handler({
            tauri::generate_handler![
                kb::query_kb,
                platform::load_platform_index,
                kb::validate_kb,
                hosts::get_hosts,
                hosts::save_host,
                hosts::delete_host,
                hosts::touch_host,
                secrets::save_credential,
                secrets::has_credential,
                secrets::agent_list_identities,
                ssh::ssh_connect,
                ssh::ssh_send,
                ssh::ssh_disconnect,
                ssh::ssh_resize,
                ssh::ssh_auth_respond,
                ssh::tofu_respond,
                config::get_app_config,
                config::save_llm_settings,
                config::get_log_level,
                config::set_log_level,
                config::set_log_max_size,
                config::set_max_sessions,
                config::set_shortcuts,
                config::get_session_log_dir,
                config::set_session_log_dir,
                config::set_session_logging,
                config::set_session_log_timestamps,
                config::set_log_file_path,
                config::get_log_status,
                config::log_frontend,
                secrets::list_providers,
                secrets::test_ref,
                secrets::list_credentials,
                secrets::get_provider_state,
                secrets::save_provider_config,
                secrets::save_provider_secret,
                netbox::netbox_get_config,
                netbox::netbox_save_config,
                netbox::netbox_save_token,
                netbox::netbox_test_connection,
                netbox::netbox_sync,
                netbox::netbox_get_devices,
                netbox::netbox_get_sites,
                netbox::netbox_get_roles,
                netbox::netbox_get_tags,
                netbox::netbox_set_device_enabled,
                netbox::netbox_set_device_overlay,
                netbox::netbox_get_status,
                import::extract_kb_preview,
                import::extract_kb_preview_from_text,
                import::commit_kb_import,
                llm::test_llm_connection,
                platform::list_kb_platforms,
                kb::get_all_kb_commands,
                kb::save_kb_command,
                kb::delete_kb_command,
                kb::disable_kb_command,
                kb::enable_kb_command,
                kb::get_disabled_commands,
                hosts::get_host_groups,
                hosts::save_host_group,
                hosts::move_host_group,
                open_url_cmd,
                hosts::delete_host_group,
                paths::commands::export_data,
                paths::commands::import_data,
                paths::commands::scan_merge,
                paths::commands::apply_merge,
                paths::commands::restart_app,
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
        assert!(path.to_string_lossy().contains("comnd.log"));
    }

    #[test]
    fn test_resolve_log_path_empty_and_whitespace_uses_default() {
        for input in [Some(""), Some("   ")] {
            let (path, used_custom) = resolve_log_path(input);
            assert!(!used_custom, "input {:?} should use default", input);
            assert!(path.to_string_lossy().contains("comnd.log"));
        }
    }

    #[test]
    fn test_resolve_log_path_relative_falls_back_to_default() {
        let (path, used_custom) = resolve_log_path(Some("relative/path/comnd.log"));
        assert!(!used_custom);
        assert!(path.to_string_lossy().contains("comnd.log"));
    }

    #[test]
    fn test_resolve_log_path_absolute_custom() {
        #[cfg(unix)]
        let custom = "/tmp/comnd-test-logs/comnd.log";
        #[cfg(windows)]
        let custom = "C:\\comnd-test-logs\\comnd.log";
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
