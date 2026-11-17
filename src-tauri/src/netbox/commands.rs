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
    host_id, DeviceOverlay, NetBoxChoice, NetBoxConfig, NetBoxDeviceEntry, SyncReport,
    DEFAULT_PW_KEY, TOKEN_KEY,
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

#[tauri::command]
pub async fn netbox_get_config(
    state: tauri::State<'_, AppState>,
) -> Result<NetBoxConfigState, String> {
    let config = {
        let store = state.config.lock().map_err(|e| e.to_string())?;
        NetBoxConfig::from_json(store.host_source_config("netbox"))
    };
    let has_token = credentials::get_secret(TOKEN_KEY)?.is_some();
    Ok(NetBoxConfigState { config, has_token })
}

#[tauri::command]
pub async fn netbox_save_config(
    config: NetBoxConfig,
    default_password: Option<String>,
    state: tauri::State<'_, AppState>,
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
pub async fn netbox_save_token(token: Option<String>) -> Result<(), String> {
    save_optional_secret(TOKEN_KEY, token.clone())?;
    log::info!("NetBox API token {}", if token.is_some() { "saved" } else { "cleared" });
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

#[tauri::command]
pub async fn netbox_sync(
    state: tauri::State<'_, AppState>,
) -> Result<SyncReport, String> {
    let config = {
        let store = state.config.lock().map_err(|e| e.to_string())?;
        NetBoxConfig::from_json(store.host_source_config("netbox"))
    };
    // Read before the guards so no lock is held while the keyring is queried;
    // `sync` owns the disabled / URL / token decisions from here on.
    let token = credentials::get_secret(TOKEN_KEY)?;
    let policy = {
        let platforms = state.platforms.lock().map_err(|e| e.to_string())?;
        config.platform_policy(&platforms)
    };
    NetBoxInventory::sync(&state.netbox, config, token, policy).await
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
#[tauri::command]
pub async fn netbox_set_device_overlay(
    netbox_id: u64,
    overlay: DeviceOverlay,
    password: Option<String>,
    state: tauri::State<'_, AppState>,
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

/// Header-line status for the NetBox settings section.
#[tauri::command]
pub async fn netbox_get_status(
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let (enabled, last_synced, device_count) = {
        let store = state.config.lock().map_err(|e| e.to_string())?;
        let enabled = store.host_source_enabled("netbox");
        let netbox = state.netbox.lock().map_err(|e| e.to_string())?;
        (enabled, netbox.get().last_synced.clone(), netbox.get().devices.len())
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

