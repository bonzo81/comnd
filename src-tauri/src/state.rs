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
use crate::netbox::NetBoxInventory;
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
    pub netbox: Mutex<NetBoxInventory>,
    /// Known platforms (bundled + user KB dirs). Rescanned after KB reloads.
    pub platforms: Mutex<PlatformRegistry>,
    /// Human-readable reason the custom log path fell back to the default at
    /// startup, if any. Pulled by the frontend on mount (no emit race).
    pub log_status: Mutex<Option<String>>,
    /// Debug-only handle to the in-process mock NetBox server that the
    /// app-level NetBox suite (`npm run smoke:netbox`) drives. Compiled out
    /// of release builds along with its commands — but kept for test builds
    /// of either profile, because `cargo test --release` compiles with
    /// `debug_assertions` off.
    #[cfg(any(debug_assertions, test))]
    pub netbox_mock: Mutex<Option<crate::netbox::mock::MockNetBox>>,
}

#[cfg(test)]
impl AppState {
    /// The AppState test constructor: the one place a test gets an `AppState`,
    /// with every store pointed at `dir`, so a handler's `_impl` can be called
    /// with a plain `&AppState` instead of a Tauri app handle.
    ///
    /// Assembly only — each store uses the constructor its own tests use.
    pub(crate) fn for_test(dir: &crate::fixtures::TempDir) -> Self {
        let config_store =
            ConfigStore::new_with_path(dir.join("config.json")).expect("fixture ConfigStore");
        let user_kb = config_store.user_kb_path();
        let providers = ProviderRegistry::from_config(config_store.get());
        let bundled_kb = crate::fixtures::get_kb_path();
        let platforms = PlatformRegistry::scan(&bundled_kb, Some(user_kb.as_path()));

        Self {
            kb: Mutex::new(KbManager::with_user_path(bundled_kb, user_kb)),
            hosts: Mutex::new(HostStore::new(dir).expect("fixture HostStore")),
            ssh: tokio::sync::Mutex::new(SshManager::new()),
            config: Mutex::new(config_store),
            providers: Mutex::new(providers),
            netbox: Mutex::new(NetBoxInventory::new(dir).expect("fixture NetBoxInventory")),
            platforms: Mutex::new(platforms),
            log_status: Mutex::new(None),
            #[cfg(any(debug_assertions, test))]
            netbox_mock: Mutex::new(None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::fixtures::{mk_host, TempDir};
    use crate::netbox::{NetBoxGeo, SyncReport};

    #[test]
    fn for_test_points_config_hosts_and_netbox_at_the_temp_dir() {
        let dir = TempDir::new("app-state");
        let state = AppState::for_test(&dir);

        state
            .config
            .lock()
            .unwrap()
            .save_log_level("debug".to_string())
            .unwrap();

        let platforms = state.platforms.lock().unwrap();
        let mut hosts = state.hosts.lock().unwrap();
        hosts.create(mk_host("R1", "10.0.0.1"), &platforms).unwrap();
        drop(hosts);
        drop(platforms);

        state
            .netbox
            .lock()
            .unwrap()
            .apply_sync(SyncReport::default(), vec![], NetBoxGeo::default())
            .unwrap();

        // Each store writes into the temp tree, proving it is not the real one.
        assert!(dir.join("config.json").exists());
        assert!(dir.join("hosts.json").exists());
        assert!(dir.join("netbox-cache.json").exists());
        assert!(state.log_status.lock().unwrap().is_none());
        assert!(state.netbox_mock.lock().unwrap().is_none());
        // The pinned bundled KB path must resolve, or handler tests fail later.
        assert!(state.platforms.lock().unwrap().is_valid("cisco-iosxe"));
    }
}
