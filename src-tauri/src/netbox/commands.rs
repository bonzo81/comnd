//! Tauri command surface for the NetBox settings form and host source.
//!
//! Commands resolve their own inputs (config, keyring token, platform policy)
//! and hand them to `NetBoxInventory::sync` — no guard lives here, and no
//! lock guard is ever held across an await.

use crate::credentials::{self, CredentialSource};
use crate::state::AppState;

use super::client::NetBoxClient;
use super::inventory::{self, NetBoxInventory};
use super::{
    host_id, DeviceOverlay, DeviceSummary, NetBoxChoice, NetBoxConfig, NetBoxDeviceEntry,
    SyncReport, DEFAULT_PW_KEY, TOKEN_KEY,
};

// ─── Tauri Commands (plan §8.2) ─────────────────────────────────────

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
pub struct NetBoxConfigState {
    pub config: NetBoxConfig,
    pub has_token: bool,
}

/// Read order: config lock (released) → keyring token probe.
fn netbox_get_config_impl(state: &AppState) -> Result<NetBoxConfigState, String> {
    let config = {
        let store = state.config.lock().map_err(|e| e.to_string())?;
        NetBoxConfig::from_json(store.host_source_config("netbox"))
    };
    let has_token = credentials::get_secret(TOKEN_KEY)?.is_some();
    Ok(NetBoxConfigState { config, has_token })
}

#[tauri::command]
pub async fn netbox_get_config(
    state: tauri::State<'_, AppState>,
) -> Result<NetBoxConfigState, String> {
    netbox_get_config_impl(&state)
}

/// Lock order: platforms (validate, released) → config (save, released) →
/// keyring. Validation runs before either write, so a rejected config leaves
/// config.json untouched.
fn netbox_save_config_impl(
    state: &AppState,
    config: NetBoxConfig,
    default_password: Option<String>,
) -> Result<NetBoxConfig, String> {
    {
        let platforms = state.platforms.lock().map_err(|e| e.to_string())?;
        config.validate(&platforms)?;
    }
    {
        let mut store = state.config.lock().map_err(|e| e.to_string())?;
        let json = serde_json::to_value(&config)
            .map_err(|e| format!("Failed to serialize NetBox config: {}", e))?;
        store.save_host_source_config("netbox", json)?;
    }
    // Source-default password: set when supplied, cleared when the default
    // credential is no longer Password. Blank = unchanged.
    match config.default_credential.as_ref() {
        Some(CredentialSource::Password) => {
            if default_password.is_some() {
                save_optional_secret(DEFAULT_PW_KEY, default_password)?;
            }
        }
        _ => credentials::delete_secret(DEFAULT_PW_KEY)?,
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
pub async fn netbox_save_config(
    config: NetBoxConfig,
    default_password: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<NetBoxConfig, String> {
    netbox_save_config_impl(&state, config, default_password)
}

#[tauri::command]
pub async fn netbox_save_token(token: Option<String>) -> Result<(), String> {
    save_optional_secret(TOKEN_KEY, token.clone())?;
    log::info!(
        "NetBox API token {}",
        if token.is_some() { "saved" } else { "cleared" }
    );
    Ok(())
}

/// Test a URL + token against the NetBox API without saving anything.
/// A blank token falls back to the stored one (test-before-save, re-test).
/// `allow_invalid_certs` must be passed explicitly by the caller so the
/// toggle state in the form is what gets tested, not the saved config.
#[tauri::command]
pub async fn netbox_test_connection(
    base_url: String,
    token: Option<String>,
    allow_invalid_certs: bool,
) -> Result<serde_json::Value, String> {
    let token = match token {
        Some(t) if !t.trim().is_empty() => t.trim().to_string(),
        _ => credentials::get_secret(TOKEN_KEY)?
            .ok_or_else(|| "No NetBox API token saved — enter one first".to_string())?,
    };
    let client = NetBoxClient::new(&base_url, &token, allow_invalid_certs)?;
    let (version, device_count) = client.test_connection().await?;
    Ok(serde_json::json!({ "version": version, "device_count": device_count }))
}

/// Read order: config (released) → config-error preflight → keyring → platforms
/// (released) → the netbox lock inside `sync`. No lock is held across an await.
async fn netbox_sync_impl(state: &AppState) -> Result<SyncReport, String> {
    let config = {
        let store = state.config.lock().map_err(|e| e.to_string())?;
        NetBoxConfig::from_json(store.host_source_config("netbox"))
    };
    // Configuration errors keep precedence over the keyring, as before the
    // split; `sync` re-checks the same guards from the same helpers.
    inventory::preflight(&config)?;
    // Then the keyring, still with no lock held; `sync` owns the token guard.
    let token = credentials::get_secret(TOKEN_KEY)?;
    let policy = {
        let platforms = state.platforms.lock().map_err(|e| e.to_string())?;
        config.platform_policy(&platforms)
    };
    NetBoxInventory::sync(&state.netbox, config, token, policy).await
}

#[tauri::command]
pub async fn netbox_sync(state: tauri::State<'_, AppState>) -> Result<SyncReport, String> {
    netbox_sync_impl(&state).await
}

#[tauri::command]
pub async fn netbox_get_devices(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<NetBoxDeviceEntry>, String> {
    let netbox = state.netbox.lock().map_err(|e| e.to_string())?;
    Ok(netbox.get().devices.clone())
}

fn build_netbox_client(state: &AppState) -> Result<NetBoxClient, String> {
    let config = {
        let store = state.config.lock().map_err(|e| e.to_string())?;
        NetBoxConfig::from_json(store.host_source_config("netbox"))
    };
    // URL error before the keyring, as before the split.
    inventory::ensure_url(&config)?;
    let token = credentials::get_secret(TOKEN_KEY)?;
    inventory::client(&config, token)
}

#[tauri::command]
pub async fn netbox_get_sites(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<NetBoxChoice>, String> {
    let client = build_netbox_client(&state)?;
    client.fetch_sites().await
}

#[tauri::command]
pub async fn netbox_get_roles(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<NetBoxChoice>, String> {
    let client = build_netbox_client(&state)?;
    client.fetch_device_roles().await
}

#[tauri::command]
pub async fn netbox_get_tags(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<NetBoxChoice>, String> {
    let client = build_netbox_client(&state)?;
    client.fetch_tags().await
}

/// Live device summary for the side-panel NetBox tab (issue #177 phase 1).
///
/// The NetBox id is resolved from the host id exactly the way `touch_host`
/// does — `is_netbox_host_id` then the numeric suffix — so a user host id is
/// rejected before any network call and no second scheme exists. Nothing is
/// read from the sync cache: each call fetches both requests fresh.
///
/// The id guard runs before the config/keyring/client resolution, so a user
/// host id never reaches the network.
async fn netbox_get_device_summary_impl(
    state: &AppState,
    host_id: String,
) -> Result<DeviceSummary, String> {
    if !super::is_netbox_host_id(&host_id) {
        return Err("Not a NetBox-sourced host".to_string());
    }
    let netbox_id: u64 = host_id
        .strip_prefix("netbox:")
        .and_then(|rest| rest.parse().ok())
        .ok_or_else(|| "Not a NetBox-sourced host".to_string())?;
    let client = build_netbox_client(state)?;
    client.fetch_device_summary(netbox_id).await
}

#[tauri::command]
pub async fn netbox_get_device_summary(
    host_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<DeviceSummary, String> {
    netbox_get_device_summary_impl(&state, host_id).await
}

#[tauri::command]
pub async fn netbox_set_device_enabled(
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
///
/// Order: netbox lock (overlay saved, released) → per-device keyring entry. An
/// unknown device id fails before the secret step.
fn netbox_set_device_overlay_impl(
    state: &AppState,
    netbox_id: u64,
    overlay: DeviceOverlay,
    password: Option<String>,
) -> Result<(), String> {
    let host_key = credentials::host_key(&host_id(netbox_id));
    {
        let mut netbox = state.netbox.lock().map_err(|e| e.to_string())?;
        netbox.set_overlay(netbox_id, overlay.clone())?;
    }
    match overlay.credential.as_ref() {
        Some(CredentialSource::Password) => {
            if password.is_some() {
                save_optional_secret(&host_key, password)?;
            }
        }
        _ => credentials::delete_secret(&host_key)?,
    }
    Ok(())
}

#[tauri::command]
pub async fn netbox_set_device_overlay(
    netbox_id: u64,
    overlay: DeviceOverlay,
    password: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    netbox_set_device_overlay_impl(&state, netbox_id, overlay, password)
}

/// Header-line status for the NetBox settings section.
///
/// Lock order: config → netbox (nested, both released before the keyring
/// probes). This nesting is the one nothing pinned before.
fn netbox_get_status_impl(state: &AppState) -> Result<serde_json::Value, String> {
    let (enabled, last_synced, device_count) = {
        let store = state.config.lock().map_err(|e| e.to_string())?;
        let enabled = store.host_source_enabled("netbox");
        let netbox = state.netbox.lock().map_err(|e| e.to_string())?;
        (
            enabled,
            netbox.get().last_synced.clone(),
            netbox.get().devices.len(),
        )
    };
    let has_token = credentials::get_secret(TOKEN_KEY)?.is_some();
    let has_default_pw = credentials::get_secret(DEFAULT_PW_KEY)?.is_some();
    Ok(serde_json::json!({
        "enabled": enabled,
        "has_token": has_token,
        "has_default_pw": has_default_pw,
        "last_synced": last_synced,
        "device_count": device_count,
    }))
}

#[tauri::command]
pub async fn netbox_get_status(
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    netbox_get_status_impl(&state)
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::collections::HashMap;

    use crate::fixtures::{sample_entry, TempDir};
    use crate::netbox::NetBoxGeo;

    fn seed_netbox_config(state: &AppState, config: &NetBoxConfig) {
        state
            .config
            .lock()
            .unwrap()
            .save_host_source_config("netbox", serde_json::to_value(config).unwrap())
            .unwrap();
    }

    #[test]
    fn netbox_save_config_impl_validates_platforms_before_the_config_write() {
        let dir = TempDir::new("netbox-save-invalid");
        let state = AppState::for_test(&dir);
        let config = NetBoxConfig {
            platform_overrides: HashMap::from([("ios".to_string(), "not-a-platform".to_string())]),
            ..Default::default()
        };

        assert!(netbox_save_config_impl(&state, config, None).is_err());

        assert!(
            state
                .config
                .lock()
                .unwrap()
                .host_source_config("netbox")
                .is_none(),
            "a rejected config must not reach the config store"
        );
        assert!(
            !dir.join("config.json").exists(),
            "a rejected config must not be written to disk"
        );
    }

    #[test]
    fn netbox_save_config_impl_writes_config_before_the_blank_password_keyring_step() {
        let dir = TempDir::new("netbox-save-ok");
        let state = AppState::for_test(&dir);
        // Password credential with no supplied secret: the keyring step is a
        // no-op, so the test never touches (or clears) a real default password.
        let config = NetBoxConfig {
            enabled: true,
            base_url: "https://netbox.example".to_string(),
            default_username: Some("admin".to_string()),
            default_credential: Some(CredentialSource::Password),
            ..Default::default()
        };

        let saved = netbox_save_config_impl(&state, config.clone(), None).unwrap();

        assert_eq!(saved, config);
        assert!(state.config.lock().unwrap().host_source_enabled("netbox"));
        let fresh = crate::config::ConfigStore::new_with_path(dir.join("config.json")).unwrap();
        assert!(fresh.host_source_enabled("netbox"));
        assert_eq!(
            NetBoxConfig::from_json(fresh.host_source_config("netbox")),
            config
        );
    }

    #[tokio::test]
    async fn netbox_sync_impl_reports_config_errors_before_the_keyring_or_platform_policy() {
        let dir = TempDir::new("netbox-sync-guards");
        let state = AppState::for_test(&dir);

        let disabled = netbox_sync_impl(&state).await.unwrap_err();
        assert!(
            disabled.contains("disabled"),
            "unexpected error: {disabled}"
        );

        seed_netbox_config(
            &state,
            &NetBoxConfig {
                enabled: true,
                ..Default::default()
            },
        );
        let no_url = netbox_sync_impl(&state).await.unwrap_err();
        assert!(
            no_url.contains("No NetBox URL"),
            "config errors must outrank the keyring and platform policy: {no_url}"
        );
    }

    #[test]
    fn netbox_get_config_impl_reads_config_before_the_token_probe() {
        if !crate::credentials::keychain_available_or_skip(
            "netbox::commands::netbox_get_config_impl_reads_config_before_the_token_probe",
        ) {
            return;
        }
        let dir = TempDir::new("netbox-get-config");
        let state = AppState::for_test(&dir);
        let config = NetBoxConfig {
            enabled: true,
            base_url: "https://netbox.example".to_string(),
            ..Default::default()
        };
        seed_netbox_config(&state, &config);

        let got = netbox_get_config_impl(&state).unwrap();

        assert_eq!(got.config, config);
    }

    #[test]
    fn netbox_get_status_impl_nests_the_netbox_lock_inside_the_config_lock() {
        if !crate::credentials::keychain_available_or_skip(
            "netbox::commands::netbox_get_status_impl_nests_the_netbox_lock_inside_the_config_lock",
        ) {
            return;
        }
        let dir = TempDir::new("netbox-status");
        let state = AppState::for_test(&dir);
        seed_netbox_config(
            &state,
            &NetBoxConfig {
                enabled: true,
                ..Default::default()
            },
        );
        state
            .netbox
            .lock()
            .unwrap()
            .apply_sync(
                SyncReport::default(),
                vec![sample_entry(1, true), sample_entry(2, true)],
                NetBoxGeo::default(),
            )
            .unwrap();

        let status = netbox_get_status_impl(&state).unwrap();

        assert_eq!(status["enabled"], serde_json::json!(true));
        assert_eq!(status["device_count"], serde_json::json!(2));
        assert!(status["last_synced"].is_string());
    }

    #[test]
    fn netbox_set_device_overlay_impl_rejects_an_unknown_device_before_the_secret_write() {
        let dir = TempDir::new("netbox-overlay-reject");
        let state = AppState::for_test(&dir);
        let overlay = DeviceOverlay {
            username: Some("ops".to_string()),
            credential: Some(CredentialSource::Password),
            ..Default::default()
        };

        let err = netbox_set_device_overlay_impl(&state, 99, overlay, Some("hunter2".to_string()))
            .unwrap_err();

        assert!(err.contains("not found"), "unexpected error: {err}");
        assert!(state.netbox.lock().unwrap().get().devices.is_empty());
    }

    #[test]
    fn netbox_set_device_overlay_impl_stores_the_overlay_before_the_blank_secret_step() {
        let dir = TempDir::new("netbox-overlay-save");
        let state = AppState::for_test(&dir);
        state
            .netbox
            .lock()
            .unwrap()
            .apply_sync(
                SyncReport::default(),
                vec![sample_entry(1, true)],
                NetBoxGeo::default(),
            )
            .unwrap();
        // Password credential with no supplied secret: no keyring write.
        let overlay = DeviceOverlay {
            username: Some("ops".to_string()),
            credential: Some(CredentialSource::Password),
            ..Default::default()
        };

        netbox_set_device_overlay_impl(&state, 1, overlay.clone(), None).unwrap();

        assert_eq!(
            state.netbox.lock().unwrap().get().devices[0].overlay,
            overlay
        );
    }

    #[tokio::test]
    async fn netbox_get_device_summary_impl_rejects_user_host_ids_before_building_a_client() {
        let dir = TempDir::new("netbox-summary-guard");
        let state = AppState::for_test(&dir);

        for id in ["user-host-id", "netbox:", "netbox:abc"] {
            let err = netbox_get_device_summary_impl(&state, id.to_string())
                .await
                .unwrap_err();
            assert!(
                err.contains("Not a NetBox-sourced host"),
                "{id}: unexpected error: {err}"
            );
        }
    }
}
