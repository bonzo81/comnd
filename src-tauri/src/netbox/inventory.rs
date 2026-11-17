//! In-memory NetBox inventory and the single sync orchestration.
//!
//! `NetBoxInventory` wraps the persisted cache store and owns the write rules a
//! sync must respect: `enabled` and `overlay` are user-owned and survive a sync
//! by `netbox_id`. `sync` resolves nothing — the caller (a Tauri command)
//! passes in config, token and platform policy, so this module never touches
//! `AppState` and no lock guard is held across an await.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use super::cache::{NetBoxCache, NetBoxCacheStore, CACHE_VERSION};
use super::client::{NetBoxClient, RawNetBoxDevice};
use super::{
    sanitize_name, slugify, DeviceOverlay, NetBoxConfig, NetBoxDeviceEntry, NetBoxGeo,
    PlatformPolicy, SyncReport,
};

/// The three sync preconditions. They live here and only here; the settings
/// commands reuse the same text through `client`.
const ERR_DISABLED: &str = "NetBox integration is disabled — enable it in Settings → NetBox";
const ERR_NO_URL: &str = "No NetBox URL configured — set one in Settings → NetBox";
const ERR_NO_TOKEN: &str = "No NetBox API token saved — enter one in Settings → NetBox";

/// Build cache entries from raw devices under a platform policy.
/// Returns the entries plus the sync report (unmatched slugs recorded once each).
pub(crate) fn build_entries(
    raw: &[RawNetBoxDevice],
    policy: &PlatformPolicy,
) -> (Vec<NetBoxDeviceEntry>, SyncReport) {
    let mut report = SyncReport {
        fetched: raw.len(),
        ..Default::default()
    };
    let mut entries = Vec::with_capacity(raw.len());
    for d in raw {
        match policy.resolve(d.platform_slug.as_deref()) {
            Some(platform) => entries.push(NetBoxDeviceEntry {
                netbox_id: d.netbox_id,
                name: sanitize_name(&d.name, d.netbox_id),
                address: d.address.clone(),
                platform,
                site: d.site_slug.as_deref().map(slugify).filter(|s| !s.is_empty()),
                location: d
                    .location_slug
                    .as_deref()
                    .map(slugify)
                    .filter(|s| !s.is_empty()),
                tags: d.tags.clone(),
                status: d.status.clone(),
                enabled: true,
                overlay: DeviceOverlay::default(),
            }),
            None => {
                report.skipped_platform += 1;
                if let Some(slug) = &d.platform_slug {
                    if !report.unmatched_platforms.contains(slug) {
                        report.unmatched_platforms.push(slug.clone());
                    }
                }
            }
        }
    }
    (entries, report)
}

/// Client from resolved config + token, applying the URL and token guards.
/// Shared with the settings commands so the guard text lives once.
pub(crate) fn client(
    config: &NetBoxConfig,
    token: Option<String>,
) -> Result<NetBoxClient, String> {
    if config.base_url.trim().is_empty() {
        return Err(ERR_NO_URL.to_string());
    }
    let token = token.ok_or_else(|| ERR_NO_TOKEN.to_string())?;
    NetBoxClient::new(&config.base_url, &token, config.allow_invalid_certs)
}

/// The cached NetBox devices plus the rules that decide what a sync may
/// overwrite.
pub struct NetBoxInventory {
    store: NetBoxCacheStore,
}

impl NetBoxInventory {
    /// Create an inventory backed by `netbox-cache.json` in `data_dir`.
    pub fn new(data_dir: &Path) -> Result<Self, String> {
        Ok(NetBoxInventory {
            store: NetBoxCacheStore::new(data_dir)?,
        })
    }

    /// In-memory fallback (filesystem unavailable).
    pub fn in_memory() -> Self {
        NetBoxInventory {
            store: NetBoxCacheStore::in_memory(),
        }
    }

    pub fn get(&self) -> &NetBoxCache {
        self.store.get()
    }

    /// Run one sync against the configured NetBox instance.
    ///
    /// Takes the inventory mutex instead of `&mut self` so the lock is only
    /// taken once the network work is done: no guard ever crosses an await.
    /// The three preconditions (enabled, then URL, then token) are checked
    /// here, in that order, and nowhere else.
    pub async fn sync(
        inventory: &Mutex<NetBoxInventory>,
        config: NetBoxConfig,
        token: Option<String>,
        policy: PlatformPolicy,
    ) -> Result<SyncReport, String> {
        if !config.enabled {
            return Err(ERR_DISABLED.to_string());
        }
        let client = client(&config, token)?;
        let fetch = client.fetch_devices(&config.filters).await?;
        let geo = client.fetch_geo().await; // degrades internally — never fails the sync
        let (entries, mut report) = build_entries(&fetch.devices, &policy);
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

        let mut netbox = inventory.lock().map_err(|e| e.to_string())?;
        netbox.apply_sync(report, entries, geo)
    }

    /// Full-replace the device array from a sync. `enabled` and `overlay`
    /// survive across syncs by `netbox_id` match; devices gone from NetBox
    /// are gone locally (overlay dropped with them). `geo` replaces the
    /// cached geography tables (v2) — empty on fetch failure, which only
    /// degrades tree naming/nesting, never the device list.
    pub fn apply_sync(
        &mut self,
        report: SyncReport,
        devices: Vec<NetBoxDeviceEntry>,
        geo: NetBoxGeo,
    ) -> Result<SyncReport, String> {
        let cache = self.store.get_mut();
        let old: HashMap<u64, (bool, DeviceOverlay)> = cache
            .devices
            .iter()
            .map(|d| (d.netbox_id, (d.enabled, d.overlay.clone())))
            .collect();
        cache.devices = devices
            .into_iter()
            .map(|mut d| {
                if let Some((enabled, overlay)) = old.get(&d.netbox_id) {
                    d.enabled = *enabled;
                    d.overlay = overlay.clone();
                }
                d
            })
            .collect();
        cache.version = CACHE_VERSION;
        cache.geo = geo;
        cache.last_synced = Some(chrono::Utc::now().to_rfc3339());
        cache.sync_report = Some(report.clone());
        let device_count = cache.devices.len();
        self.store.save()?;
        log::info!(
            "NetBox cache applied: {} devices ({} previously known)",
            device_count,
            old.len()
        );
        Ok(report)
    }

    pub fn set_enabled(&mut self, netbox_id: u64, enabled: bool) -> Result<(), String> {
        let device = self
            .store
            .get_mut()
            .devices
            .iter_mut()
            .find(|d| d.netbox_id == netbox_id)
            .ok_or_else(|| format!("NetBox device not found: {}", netbox_id))?;
        device.enabled = enabled;
        self.store.save()?;
        log::info!("NetBox device {} enabled={}", netbox_id, enabled);
        Ok(())
    }

    pub fn set_overlay(&mut self, netbox_id: u64, overlay: DeviceOverlay) -> Result<(), String> {
        let device = self
            .store
            .get_mut()
            .devices
            .iter_mut()
            .find(|d| d.netbox_id == netbox_id)
            .ok_or_else(|| format!("NetBox device not found: {}", netbox_id))?;
        device.overlay = overlay;
        self.store.save()?;
        log::info!("NetBox device {} overlay saved", netbox_id);
        Ok(())
    }

    /// Look up a cached device by materialized host id (`netbox:<id>`).
    pub fn find_by_host_id(&self, host_id: &str) -> Option<NetBoxDeviceEntry> {
        let id = host_id.strip_prefix("netbox:")?;
        let id: u64 = id.parse().ok()?;
        self.store
            .get()
            .devices
            .iter()
            .find(|d| d.netbox_id == id)
            .cloned()
    }

    /// Update `overlay.last_connected` for a device.
    pub fn touch(&mut self, netbox_id: u64) -> Result<(), String> {
        let device = self
            .store
            .get_mut()
            .devices
            .iter_mut()
            .find(|d| d.netbox_id == netbox_id)
            .ok_or_else(|| format!("NetBox device not found: {}", netbox_id))?;
        device.overlay.last_connected = Some(chrono::Utc::now().to_rfc3339());
        self.store.save()?;
        log::debug!("NetBox device {} touched", netbox_id);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    use crate::credentials::CredentialSource;
    use crate::netbox::client::RawNetBoxDevice;
    use crate::netbox::test_fixtures::*;
    use crate::netbox::{DeviceOverlay, NetBoxConfig, NetBoxGeo, PlatformPolicy, SyncReport};

    #[test]
    fn test_build_entries_report_and_sanitization() {
        let raw = vec![
            RawNetBoxDevice {
                netbox_id: 1,
                name: "known-device".into(),
                address: "10.0.0.1".into(),
                platform_slug: Some("cisco-ios".into()),
                site_slug: Some("DC1".into()),
                location_slug: Some("Rack Row 1".into()),
                tags: vec!["prod".into()],
                status: "active".into(),
                description: String::new(),
            },
            RawNetBoxDevice {
                netbox_id: 2,
                name: "weird\u{0007}name".into(),
                address: "10.0.0.2".into(),
                platform_slug: Some("foo-os".into()),
                site_slug: None,
                location_slug: None,
                tags: vec![],
                status: "offline".into(),
                description: String::new(),
            },
        ];
        let (entries, report) = build_entries(&raw, &PlatformPolicy::default());
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].platform, "cisco-iosxe");
        // Site/location slugified for synthetic group ids
        assert_eq!(entries[0].site.as_deref(), Some("dc1"));
        assert_eq!(entries[0].location.as_deref(), Some("rackrow1"));
        assert!(entries[0].enabled);
        assert_eq!(entries[0].overlay, DeviceOverlay::default());
        assert_eq!(report.fetched, 2);
        assert_eq!(report.skipped_platform, 1);
        assert_eq!(report.unmatched_platforms, vec!["foo-os"]);

        // With fallback policy the unmatched device is kept
        let policy = PlatformPolicy {
            fallback: Some("linux-bash".into()),
            ..Default::default()
        };
        let (entries, report) = build_entries(&raw, &policy);
        assert_eq!(entries.len(), 2);
        assert_eq!(report.skipped_platform, 0);
        assert_eq!(report.unmatched_platforms.len(), 0);
        // Control chars stripped from names
        assert_eq!(entries[1].name, "weirdname");
        assert_eq!(entries[1].platform, "linux-bash");
    }

    // ─── Sync orchestration (guards + mock server) ─────────────────

    fn sync_config(base_url: &str) -> NetBoxConfig {
        NetBoxConfig {
            enabled: true,
            base_url: base_url.to_string(),
            ..Default::default()
        }
    }

    /// The three preconditions live in `sync` alone, in this order, with
    /// their original wording.
    #[tokio::test]
    async fn test_sync_guards_disabled_url_then_token() {
        let inventory = Mutex::new(NetBoxInventory::in_memory());

        let disabled = NetBoxConfig::default();
        let err = NetBoxInventory::sync(&inventory, disabled, None, PlatformPolicy::default())
            .await
            .unwrap_err();
        assert_eq!(
            err,
            "NetBox integration is disabled — enable it in Settings → NetBox"
        );

        let err = NetBoxInventory::sync(&inventory, sync_config("   "), None, PlatformPolicy::default())
            .await
            .unwrap_err();
        assert_eq!(err, "No NetBox URL configured — set one in Settings → NetBox");

        let err = NetBoxInventory::sync(
            &inventory,
            sync_config("http://127.0.0.1:1"),
            None,
            PlatformPolicy::default(),
        )
        .await
        .unwrap_err();
        assert_eq!(
            err,
            "No NetBox API token saved — enter one in Settings → NetBox"
        );
    }

    /// A full sync against the mock server, with no Tauri state involved.
    #[tokio::test]
    async fn test_sync_applies_inventory_from_mock_server() {
        let mock = crate::netbox::mock::MockNetBox::start().await;
        let inventory = Mutex::new(NetBoxInventory::in_memory());

        let report = NetBoxInventory::sync(
            &inventory,
            sync_config(&mock.base_url),
            Some("nbt_v2.ro".into()),
            PlatformPolicy::default(),
        )
        .await
        .unwrap();
        mock.stop();

        assert_eq!(report.fetched, 5);
        assert_eq!(report.no_primary_ip, 1);
        assert!(
            report.skipped_platform >= 1,
            "mock serves an unmapped platform slug: {:?}",
            report
        );
        // `fetched` counts the raw devices the API returned (those with no
        // primary IP are already excluded and counted separately).
        assert_eq!(
            report.fetched,
            report.skipped_platform + inventory.lock().unwrap().get().devices.len()
        );

        let inv = inventory.lock().unwrap();
        let cache = inv.get();
        assert_eq!(cache.version, 2);
        assert!(cache.last_synced.is_some());
        assert_eq!(cache.sync_report.as_ref().unwrap().fetched, 5);
        assert!(cache.devices.iter().all(|d| d.enabled));
        assert!(!cache.geo.regions.is_empty(), "geo regions cached");
        assert!(!cache.geo.sites.is_empty(), "geo sites cached");
        assert!(!cache.geo.locations.is_empty(), "geo locations cached");
    }

    /// `fetch_geo` degrades to empty tables — it never fails the sync.
    #[tokio::test]
    async fn test_sync_survives_geo_failure() {
        let (base, server) = crate::netbox::mock::start_mock(|_base| {
            Arc::new(|_method: &str, path: &str, _auth: &str| {
                if path.starts_with("/api/dcim/devices") {
                    crate::netbox::mock::page(
                        None,
                        vec![serde_json::json!({
                            "id": 1,
                            "url": "http://netbox/api/dcim/devices/1/",
                            "display": "r1",
                            "name": "r1",
                            "description": "",
                            "status": { "value": "active", "label": "Active" },
                            "site": null,
                            "location": null,
                            "platform": { "id": 2, "name": "Cisco IOS", "slug": "cisco-ios" },
                            "primary_ip4": { "id": 9, "family": 4, "address": "10.0.0.1/24" },
                            "primary_ip6": null,
                            "tags": []
                        })],
                    )
                } else {
                    (500, r#"{"detail":"boom"}"#.into(), vec![])
                }
            })
        })
        .await;

        let inventory = Mutex::new(NetBoxInventory::in_memory());
        let report = NetBoxInventory::sync(
            &inventory,
            sync_config(&base),
            Some("nbt_v2.ro".into()),
            PlatformPolicy::default(),
        )
        .await
        .expect("a geo failure must not fail the sync");
        server.abort();

        assert_eq!(report.fetched, 1);
        let inv = inventory.lock().unwrap();
        let cache = inv.get();
        assert_eq!(cache.devices.len(), 1);
        assert_eq!(cache.devices[0].platform, "cisco-iosxe");
        assert!(cache.geo.regions.is_empty());
        assert!(cache.geo.sites.is_empty());
        assert!(cache.geo.locations.is_empty());
    }

    #[test]
    fn test_apply_sync_preserves_enabled_and_overlay() {
        let dir = temp_dir();
        let mut store = NetBoxInventory::new(&dir).unwrap();
        store
            .apply_sync(
                SyncReport::default(),
                vec![sample_entry(1, true), sample_entry(2, true)],
                NetBoxGeo::default(),
            )
            .unwrap();

        // User state changes after first sync
        store.set_enabled(1, false).unwrap();
        let overlay = DeviceOverlay {
            username: Some("admin".into()),
            port: Some(2222),
            credential: Some(CredentialSource::Password),
            last_connected: Some("2026-08-27T10:00:00Z".into()),
            notes: Some("core router".into()),
        };
        store.set_overlay(2, overlay.clone()).unwrap();

        // Re-sync: device 1 gone from NetBox, device 2 present, device 3 new
        store
            .apply_sync(
                SyncReport::default(),
                vec![sample_entry(2, true), sample_entry(3, true)],
                NetBoxGeo::default(),
            )
            .unwrap();

        let cache = store.get();
        assert_eq!(cache.devices.len(), 2);
        // Device 1 dropped
        assert!(!cache.devices.iter().any(|d| d.netbox_id == 1));
        // Device 2 kept its overlay
        let d2 = cache.devices.iter().find(|d| d.netbox_id == 2).unwrap();
        assert_eq!(d2.overlay, overlay);
        assert_eq!(d2.overlay.port, Some(2222));
        // Device 3 fresh defaults
        let d3 = cache.devices.iter().find(|d| d.netbox_id == 3).unwrap();
        assert!(d3.enabled);
        assert_eq!(d3.overlay, DeviceOverlay::default());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_find_by_host_id_and_touch_and_setters() {
        let dir = temp_dir();
        let mut store = NetBoxInventory::new(&dir).unwrap();
        store
            .apply_sync(SyncReport::default(), vec![sample_entry(7, true)], NetBoxGeo::default())
            .unwrap();

        assert!(store.find_by_host_id("netbox:7").is_some());
        assert!(store.find_by_host_id("netbox:999").is_none());
        assert!(store.find_by_host_id("some-uuid").is_none());
        assert_eq!(store.find_by_host_id("netbox:7").unwrap().address, "10.0.0.7");

        store.touch(7).unwrap();
        let d = store.find_by_host_id("netbox:7").unwrap();
        assert!(d.overlay.last_connected.is_some());

        store.set_enabled(7, false).unwrap();
        assert!(!store.find_by_host_id("netbox:7").unwrap().enabled);

        // Unknown id errors
        assert!(store.set_enabled(999, true).is_err());
        assert!(store.set_overlay(999, DeviceOverlay::default()).is_err());
        assert!(store.touch(999).is_err());

        // Persisted across reopen
        let fresh = NetBoxInventory::new(&dir).unwrap();
        assert!(!fresh.find_by_host_id("netbox:7").unwrap().enabled);
        assert!(fresh.find_by_host_id("netbox:7").unwrap().overlay.last_connected.is_some());

        let _ = std::fs::remove_dir_all(&dir);
    }


    #[test]
    fn test_cache_roundtrip() {
        let dir = temp_dir();
        let mut inventory = NetBoxInventory::new(&dir).unwrap();
        inventory
            .apply_sync(
                SyncReport {
                    fetched: 1,
                    ..Default::default()
                },
                vec![sample_entry(1, true)],
                NetBoxGeo::default(),
            )
            .unwrap();
        assert!(inventory.get().last_synced.is_some());

        // Reopening reads the cache the sync wrote.
        let fresh = NetBoxInventory::new(&dir).unwrap();
        assert_eq!(fresh.get().devices.len(), 1);
        assert_eq!(fresh.get().devices[0].name, "dev-1");
        assert_eq!(fresh.get().sync_report.as_ref().unwrap().fetched, 1);
        assert_eq!(fresh.get().version, 2);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
