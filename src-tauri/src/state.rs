//! Shared application state managed by Tauri.
//!
//! Every domain module owns its own `#[tauri::command]` handlers and reaches
//! shared stores through this struct. Fields are `pub` so handlers in sibling
//! modules can lock the store they need; each handler clones data out and
//! never holds a guard across an await.

use std::sync::Mutex;

use crate::config::ConfigStore;
use crate::hosts::HostStore;
use crate::kb::KbManager;
use crate::netbox::NetBoxCacheStore;
use crate::platform::PlatformRegistry;
use crate::secrets::ProviderRegistry;
use crate::ssh::SshManager;

pub struct AppState {
    pub kb: Mutex<KbManager>,
    pub hosts: Mutex<HostStore>,
    pub ssh: tokio::sync::Mutex<SshManager>,
    pub config: Mutex<ConfigStore>,
    /// Secret providers enabled in config. Rebuilt when provider settings
    /// change (chunk 7). Handles are cloned out before awaiting so the lock
    /// is never held across an await.
    pub providers: Mutex<ProviderRegistry>,
    /// NetBox device cache (host source). Like the other std-Mutex stores:
    /// clone data out, never hold the guard across an await.
    pub netbox: Mutex<NetBoxCacheStore>,
    /// Known platforms (bundled + user KB dirs). Rescanned after KB reloads.
    pub platforms: Mutex<PlatformRegistry>,
    /// Human-readable reason the custom log path fell back to the default at
    /// startup, if any. Pulled by the frontend on mount (no emit race).
    pub log_status: Mutex<Option<String>>,
    /// Debug-only handle to the in-process mock NetBox server that the
    /// app-level NetBox suite (`npm run smoke:netbox`) drives. Compiled out
    /// of release builds along with its commands.
    #[cfg(debug_assertions)]
    pub netbox_mock: Mutex<Option<crate::netbox::mock::MockNetBox>>,
}
