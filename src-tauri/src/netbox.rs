//! NetBox host source — REST client, device parsing, platform mapping,
//! and the local device cache (Phase 1 of docs/plans/plan-netbox-host-source.md).
//!
//! The cache is the only local storage: `netbox-cache.json` in the app data
//! dir, written with `secure_write`, loaded with `preserve_corrupt` fallback.
//! NetBox data NEVER enters hosts.json — merge happens at read time (Phase 2).
//!
//! NetBox instances live on LANs, so the URL validator only checks the
//! scheme — `import::validate_fetch_url` (which blocks private IPs) must
//! never be applied here (plan §3 warning, §11).

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::credentials::{self, CredentialSource};
use crate::platform::PlatformRegistry;
use crate::state::AppState;

// ─── Filters ────────────────────────────────────────────────────────

/// Server-side sync filters (all slug lists, exact-match, repeatable).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct NetBoxFilters {
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub sites: Vec<String>,
    #[serde(default)]
    pub roles: Vec<String>,
    #[serde(default)]
    pub tags: Vec<String>,
}

/// A single choice option returned by the filter-list endpoints.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetBoxChoice {
    pub slug: String,
    pub name: String,
}

// ─── Geography (nav-tree hierarchy, plan §8.3) ─────────────────────

/// One geography node (region, site, or location) from the NetBox API,
/// flattened to the links needed to rebuild the hierarchy: regions nest
/// recursively via `parent`, sites point at a `region`, and locations
/// nest recursively via `parent` within a `site`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct NetBoxGeoNode {
    #[serde(default)]
    pub slug: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub parent_slug: Option<String>,
    /// Locations only: the site this location belongs to.
    #[serde(default)]
    pub site_slug: Option<String>,
    /// Sites only: the region this site belongs to.
    #[serde(default)]
    pub region_slug: Option<String>,
}

/// The geography tables cached for nav-tree building (cache v2). Empty
/// tables (pre-v2 cache, or an endpoint unavailable on old NetBox
/// versions) degrade to a slug-named site → flat-location tree.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct NetBoxGeo {
    #[serde(default)]
    pub regions: Vec<NetBoxGeoNode>,
    #[serde(default)]
    pub sites: Vec<NetBoxGeoNode>,
    #[serde(default)]
    pub locations: Vec<NetBoxGeoNode>,
}

// ─── Raw device (API response shape, plan §4.1) ─────────────────────

/// One device parsed out of the NetBox API response. Field extraction goes
/// through `serde_json::Value` because the response shape is nullable in
/// places a derived struct cannot express (null `name`, dual-shape `tags`,
/// choice-object `status` with historical integer values).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RawNetBoxDevice {
    pub netbox_id: u64,
    pub name: String,
    /// Primary IP with the CIDR mask suffix stripped.
    pub address: String,
    pub platform_slug: Option<String>,
    pub site_slug: Option<String>,
    pub location_slug: Option<String>,
    pub tags: Vec<String>,
    pub status: String,
    pub description: String,
}

/// Parse one device object per plan §4.1 rules 1-5.
/// Returns `None` when the device has neither primary_ip4 nor primary_ip6
/// (cannot be connected — skipped and counted by the caller).
fn parse_device(v: &serde_json::Value) -> Option<RawNetBoxDevice> {
    let netbox_id = v.get("id").and_then(|i| i.as_u64())?;

    // Rule 1: name is nullable → display → "device-<id>"
    let name = v
        .get("name")
        .and_then(|n| n.as_str())
        .filter(|s| !s.trim().is_empty())
        .or_else(|| v.get("display").and_then(|d| d.as_str()))
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("device-{}", netbox_id));

    // Rule 3: primary_ip4 first, primary_ip6 fallback; strip CIDR at first '/'
    let address = ["primary_ip4", "primary_ip6"]
        .iter()
        .find_map(|k| {
            v.get(k)
                .and_then(|ip| ip.get("address"))
                .and_then(|a| a.as_str())
        })
        .map(|a| a.split('/').next().unwrap_or(a).to_string())?;

    // Rules 2: platform/location nullable; site not nullable (defensive Option anyway)
    let platform_slug = nested_slug(v, "platform");
    let site_slug = nested_slug(v, "site");
    let location_slug = nested_slug(v, "location");

    // Rule 4: status is a choice object; .value if string, else .label lowercase
    let status = v
        .get("status")
        .map(|s| {
            match s.get("value").and_then(|x| x.as_str()) {
                Some(val) => val.to_string(),
                None => s
                    .get("label")
                    .and_then(|l| l.as_str())
                    .map(|l| l.to_lowercase())
                    .unwrap_or_default(),
            }
        })
        .unwrap_or_default();

    // Rule 5: tags — nested objects take .slug; plain strings (ancient 2.x) verbatim
    let tags = v
        .get("tags")
        .and_then(|t| t.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|t| match t {
                    serde_json::Value::String(s) => Some(s.clone()),
                    other => other
                        .get("slug")
                        .and_then(|s| s.as_str())
                        .map(|s| s.to_string()),
                })
                .collect()
        })
        .unwrap_or_default();

    let description = v
        .get("description")
        .and_then(|d| d.as_str())
        .unwrap_or_default()
        .to_string();

    Some(RawNetBoxDevice {
        netbox_id,
        name,
        address,
        platform_slug,
        site_slug,
        location_slug,
        tags,
        status,
        description,
    })
}

/// `.slug` from a nullable nested object (`{"slug": "dc1"}` → `Some("dc1")`).
fn nested_slug(v: &serde_json::Value, field: &str) -> Option<String> {
    v.get(field)?
        .get("slug")?
        .as_str()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

// ─── Platform mapping (plan §7.2) ───────────────────────────────────

/// NetBox platform slug → comnd platform. Materialized hosts must carry
/// one of the four VALID_PLATFORMS values.
const PLATFORM_TABLE: &[(&str, &str)] = &[
    ("cisco-ios", "cisco-iosxe"),
    ("ios", "cisco-iosxe"),
    ("ios-xe", "cisco-iosxe"),
    ("cisco-iosxe", "cisco-iosxe"),
    ("cisco-nx-os", "cisco-nxos"),
    ("nx-os", "cisco-nxos"),
    ("nxos", "cisco-nxos"),
    ("f5-tmos", "f5-tmos"),
    ("tmos", "f5-tmos"),
    ("big-ip", "f5-tmos"),
    ("linux", "linux-bash"),
    ("ubuntu", "linux-bash"),
    ("debian", "linux-bash"),
    ("centos", "linux-bash"),
    ("rhel", "linux-bash"),
];

/// Built-in table lookup.
pub fn map_platform(slug: &str) -> Option<&'static str> {
    PLATFORM_TABLE
        .iter()
        .find(|(k, _)| *k == slug)
        .map(|(_, v)| *v)
}

/// Policy for platform slugs the built-in table does not know:
/// skip the device (default) or treat it as a fallback platform,
/// with a per-slug overrides map taking precedence over both.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PlatformPolicy {
    /// `Some(platform)` = treat unknown slugs as this platform; `None` = skip.
    pub fallback: Option<String>,
    /// User overrides: slug → platform. Wins over the built-in table.
    pub overrides: HashMap<String, String>,
}

impl PlatformPolicy {
    /// Resolve a NetBox platform slug to a comnd platform, or `None` to
    /// skip the device.
    pub fn resolve(&self, slug: Option<&str>) -> Option<String> {
        let slug = match slug {
            Some(s) => s,
            None => return self.fallback.clone(),
        };
        if let Some(p) = self.overrides.get(slug) {
            return Some(p.clone());
        }
        if let Some(p) = map_platform(slug) {
            return Some(p.to_string());
        }
        self.fallback.clone()
    }
}

// ─── Sync report + cached entries (plan §7.3) ───────────────────────

/// Per-device credential/username overlay (plan §6). `None` everywhere =
/// inherit source-level defaults.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct DeviceOverlay {
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub credential: Option<CredentialSource>,
    #[serde(default)]
    pub last_connected: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
}

/// One cached device. `enabled` and `overlay` are the only user-owned
/// fields — everything else is replaced wholesale by a sync.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NetBoxDeviceEntry {
    pub netbox_id: u64,
    pub name: String,
    pub address: String,
    pub platform: String,
    #[serde(default)]
    pub site: Option<String>,
    #[serde(default)]
    pub location: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub status: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub overlay: DeviceOverlay,
}

fn default_true() -> bool {
    true
}

/// Summary of one sync run, shown in the settings UI.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SyncReport {
    pub fetched: usize,
    pub no_primary_ip: usize,
    pub skipped_platform: usize,
    #[serde(default)]
    pub unmatched_platforms: Vec<String>,
}

/// Host id for a cached device (`netbox:<netbox_id>` — globally unique PK).
pub fn host_id(netbox_id: u64) -> String {
    format!("netbox:{}", netbox_id)
}

/// Sanitize a device name for display: drop control chars, trim, cap at the
/// same 128-char limit `validate_host` enforces, never empty.
fn sanitize_name(name: &str, netbox_id: u64) -> String {
    let cleaned: String = name.chars().filter(|c| !c.is_control()).collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        return format!("device-{}", netbox_id);
    }
    trimmed.chars().take(128).collect()
}

/// Force a string into NetBox-slug shape (`[a-z0-9-]`). NetBox slugs already
/// comply; this is defense for anything odd ending up in the cache, since
/// site/location slugs are embedded in synthetic group ids. Double dashes
/// and trailing dashes pass through — the ids are opaque, never parsed.
fn slugify(s: &str) -> String {
    s.to_ascii_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect()
}

/// Build cache entries from raw devices under a platform policy.
/// Returns the entries plus the sync report (unmatched slugs recorded once each).
pub fn build_entries(
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

// ─── Cache store (plan §7.3) ────────────────────────────────────────

const CACHE_VERSION: u32 = 2;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct NetBoxCache {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub last_synced: Option<String>,
    #[serde(default)]
    pub sync_report: Option<SyncReport>,
    #[serde(default)]
    pub devices: Vec<NetBoxDeviceEntry>,
    /// Geography tables for the nav-tree hierarchy (v2): regions, sites,
    /// locations with parent links. Empty on pre-v2 caches — the tree
    /// degrades to slug-named site → flat locations.
    #[serde(default)]
    pub geo: NetBoxGeo,
}

pub struct NetBoxCacheStore {
    cache_path: Option<PathBuf>,
    cache: NetBoxCache,
}

impl NetBoxCacheStore {
    /// Create a store backed by `netbox-cache.json` in `data_dir`.
    pub fn new(data_dir: &std::path::Path) -> Result<Self, String> {
        crate::paths::ensure_data_dir(data_dir)
            .map_err(|e| format!("Failed to create data dir: {}", e))?;
        let cache_path = data_dir.join("netbox-cache.json");
        Ok(NetBoxCacheStore {
            cache: load_cache_from_file(&cache_path),
            cache_path: Some(cache_path),
        })
    }

    /// In-memory fallback (filesystem unavailable).
    pub fn in_memory() -> Self {
        NetBoxCacheStore {
            cache_path: None,
            cache: NetBoxCache::default(),
        }
    }

    pub fn get(&self) -> &NetBoxCache {
        &self.cache
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
        let old: HashMap<u64, (bool, DeviceOverlay)> = self
            .cache
            .devices
            .iter()
            .map(|d| (d.netbox_id, (d.enabled, d.overlay.clone())))
            .collect();
        self.cache.devices = devices
            .into_iter()
            .map(|mut d| {
                if let Some((enabled, overlay)) = old.get(&d.netbox_id) {
                    d.enabled = *enabled;
                    d.overlay = overlay.clone();
                }
                d
            })
            .collect();
        self.cache.version = CACHE_VERSION;
        self.cache.geo = geo;
        self.cache.last_synced = Some(chrono::Utc::now().to_rfc3339());
        self.cache.sync_report = Some(report.clone());
        self.save()?;
        log::info!("NetBox cache applied: {} devices ({} previously known)", self.cache.devices.len(), old.len());
        Ok(report)
    }

    pub fn set_enabled(&mut self, netbox_id: u64, enabled: bool) -> Result<(), String> {
        let device = self
            .cache
            .devices
            .iter_mut()
            .find(|d| d.netbox_id == netbox_id)
            .ok_or_else(|| format!("NetBox device not found: {}", netbox_id))?;
        device.enabled = enabled;
        self.save()?;
        log::info!("NetBox device {} enabled={}", netbox_id, enabled);
        Ok(())
    }

    pub fn set_overlay(&mut self, netbox_id: u64, overlay: DeviceOverlay) -> Result<(), String> {
        let device = self
            .cache
            .devices
            .iter_mut()
            .find(|d| d.netbox_id == netbox_id)
            .ok_or_else(|| format!("NetBox device not found: {}", netbox_id))?;
        device.overlay = overlay;
        self.save()?;
        log::info!("NetBox device {} overlay saved", netbox_id);
        Ok(())
    }

    /// Look up a cached device by materialized host id (`netbox:<id>`).
    pub fn find_by_host_id(&self, host_id: &str) -> Option<NetBoxDeviceEntry> {
        let id = host_id.strip_prefix("netbox:")?;
        let id: u64 = id.parse().ok()?;
        self.cache.devices.iter().find(|d| d.netbox_id == id).cloned()
    }

    /// Update `overlay.last_connected` for a device.
    pub fn touch(&mut self, netbox_id: u64) -> Result<(), String> {
        let device = self
            .cache
            .devices
            .iter_mut()
            .find(|d| d.netbox_id == netbox_id)
            .ok_or_else(|| format!("NetBox device not found: {}", netbox_id))?;
        device.overlay.last_connected = Some(chrono::Utc::now().to_rfc3339());
        self.save()?;
        log::debug!("NetBox device {} touched", netbox_id);
        Ok(())
    }

    fn save(&self) -> Result<(), String> {
        if let Some(ref path) = self.cache_path {
            let json = serde_json::to_string_pretty(&self.cache)
                .map_err(|e| format!("Failed to serialize netbox cache: {}", e))?;
            crate::paths::secure_write(path, json.as_bytes())
                .map_err(|e| {
                    log::error!("Failed to write netbox cache to {}: {}", path.display(), e);
                    format!("Failed to write netbox cache: {}", e)
                })?;
        }
        Ok(())
    }
}

/// Load the cache from disk; corrupt files are preserved as `.corrupt-<ts>`
/// and an empty cache is returned (mirrors `load_hosts_from_file`).
fn load_cache_from_file(path: &PathBuf) -> NetBoxCache {
    crate::paths::load_json_or_preserve::<NetBoxCache>(path)
}

// ─── Source config + materialization (plan §8) ──────────────────────

/// Keyring keys (plan §8.1/§11 — secrets never live in config.json).
pub const TOKEN_KEY: &str = "comnd_source_netbox_token";
pub const DEFAULT_PW_KEY: &str = "comnd_source_netbox_default_pw";

/// Connection parameters resolved for one NetBox-sourced device.
pub struct ConnectParams {
    pub hostname: String,
    pub port: u16,
    pub username: String,
    pub credential: Option<CredentialSource>,
    pub secret_key: String,
}

/// Resolve connection parameters for a NetBox-sourced device from its overlay
/// and the source defaults. Overlay wins over source defaults; empty-string
/// overlays are treated as absent (plan §6). Pure — no locks or I/O, so the
/// precedence rules are unit-testable in isolation.
pub fn resolve_connect_params(
    device: &NetBoxDeviceEntry,
    cfg: &NetBoxConfig,
) -> Result<ConnectParams, String> {
    let username = device
        .overlay
        .username
        .clone()
        .filter(|u| !u.trim().is_empty())
        .or_else(|| cfg.default_username.clone())
        .filter(|u| !u.trim().is_empty())
        .ok_or_else(|| {
            "No username configured for this device — set one via Configure or the NetBox source defaults".to_string()
        })?;
    let port = device.overlay.port.unwrap_or(cfg.default_port);
    let credential = device
        .overlay
        .credential
        .clone()
        .or_else(|| cfg.default_credential.clone());
    if credential.is_none() {
        return Err(
            "No authentication method configured for this device — set one via Configure or the NetBox source defaults"
                .to_string(),
        );
    }
    // Per-device password secret when the overlay pins its own credential,
    // otherwise the shared source-default password secret.
    let secret_key = if device.overlay.credential.is_some() {
        crate::credentials::host_key(&host_id(device.netbox_id))
    } else {
        DEFAULT_PW_KEY.to_string()
    };
    Ok(ConnectParams {
        hostname: device.address.clone(),
        port,
        username,
        credential,
        secret_key,
    })
}

/// Synthetic group ids (plan §8.3): root, region, site, location. Model
/// slugs are unique within NetBox, so each node is addressable by its own
/// slug — ancestry lives in the cached geo tables, not the id.
pub const ROOT_GROUP_ID: &str = "__netbox__";

fn region_group_id(slug: &str) -> String {
    format!("{}:region:{}", ROOT_GROUP_ID, slug)
}

fn site_group_id(slug: &str) -> String {
    format!("{}:site:{}", ROOT_GROUP_ID, slug)
}

fn loc_group_id(slug: &str) -> String {
    format!("{}:loc:{}", ROOT_GROUP_ID, slug)
}

/// Non-secret NetBox source config, stored as JSON under
/// `host_sources["netbox"]`. The API token and source-default password live
/// in the OS keyring, never here.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NetBoxConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub show_empty_folders: bool,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub filters: NetBoxFilters,
    /// `"skip"` (default — unknown platform slugs are not synced) or
    /// `"fallback"` (treat as `platform_fallback`).
    #[serde(default = "default_platform_policy")]
    pub platform_policy: String,
    #[serde(default)]
    pub platform_fallback: Option<String>,
    #[serde(default)]
    pub platform_overrides: HashMap<String, String>,
    #[serde(default)]
    pub default_username: Option<String>,
    #[serde(default = "default_netbox_port")]
    pub default_port: u16,
    #[serde(default)]
    pub default_credential: Option<CredentialSource>,
    /// Accept self-signed/invalid TLS certificates on the NetBox instance.
    /// Opt-in escape hatch for home labs — downgrades security (token and
    /// device data become MITM-able), so it defaults to false.
    #[serde(default)]
    pub allow_invalid_certs: bool,
}

fn default_platform_policy() -> String {
    "skip".to_string()
}

fn default_netbox_port() -> u16 {
    22
}

impl Default for NetBoxConfig {
    fn default() -> Self {
        NetBoxConfig {
            enabled: false,
            show_empty_folders: false,
            base_url: String::new(),
            filters: NetBoxFilters::default(),
            platform_policy: default_platform_policy(),
            platform_fallback: None,
            platform_overrides: HashMap::new(),
            default_username: None,
            default_port: default_netbox_port(),
            default_credential: None,
            allow_invalid_certs: false,
        }
    }
}

impl NetBoxConfig {
    /// Parse from the raw `host_sources` JSON value (defaults on any
    /// malformed field, so a bad hand-edited config can never break reads).
    pub fn from_json(v: Option<&serde_json::Value>) -> Self {
        v.cloned()
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default()
    }

    /// Effective platform policy for `build_entries`.
    pub fn platform_policy(&self, platforms: &PlatformRegistry) -> PlatformPolicy {
        PlatformPolicy {
            fallback: if self.platform_policy == "fallback" {
                self.platform_fallback
                    .clone()
                    .filter(|p| platforms.is_valid(p))
            } else {
                None
            },
            overrides: self
                .platform_overrides
                .iter()
                .filter(|(_, p)| platforms.is_valid(p))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
        }
    }

    /// Validate user-editable fields before persisting.
    pub fn validate(&self, platforms: &PlatformRegistry) -> Result<(), String> {
        if !self.base_url.trim().is_empty() {
            let trimmed = self.base_url.trim().trim_end_matches('/');
            if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
                return Err("NetBox URL must start with http:// or https://".to_string());
            }
        }
        if self.default_port == 0 {
            return Err("Default port must be between 1 and 65535".to_string());
        }
        match self.platform_policy.as_str() {
            "skip" => {}
            "fallback" => {
                let fallback = self.platform_fallback.as_deref().unwrap_or("");
                if !platforms.is_valid(fallback) {
                    return Err(format!(
                        "Fallback platform '{}' is not valid (must be one of: {})",
                        fallback,
                        platforms.all().join(", ")
                    ));
                }
            }
            other => return Err(format!("Unknown platform policy '{}' (must be skip or fallback)", other)),
        }
        for (slug, platform) in &self.platform_overrides {
            if !platforms.is_valid(platform) {
                return Err(format!(
                    "Platform override '{}' -> '{}' is not a valid platform",
                    slug, platform
                ));
            }
        }
        Ok(())
    }
}

/// True when the host id belongs to a NetBox-sourced host (`netbox:<id>`).
pub fn is_netbox_host_id(id: &str) -> bool {
    id.strip_prefix("netbox:")
        .map(|rest| !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit()))
        .unwrap_or(false)
}

/// True for synthetic NetBox group ids (`__netbox__...`).
pub fn is_synthetic_group_id(id: &str) -> bool {
    id.starts_with(ROOT_GROUP_ID)
}

/// Effective group id for a device: its location group when set, else its
/// site group, else the NetBox root (plan §8.3). Region/location ancestry
/// is resolved from the geo tables at tree-build time, not encoded here.
fn group_id_for(device: &NetBoxDeviceEntry) -> String {
    if let Some(loc) = device.location.as_deref().filter(|l| !l.is_empty()) {
        return loc_group_id(loc);
    }
    if let Some(site) = device.site.as_deref().filter(|s| !s.is_empty()) {
        return site_group_id(site);
    }
    ROOT_GROUP_ID.to_string()
}

/// Materialize a cached device into a `Host` for the merged host list
/// (plan §8.3). Never persisted to hosts.json — built at read time.
pub fn materialize_host(device: &NetBoxDeviceEntry, cfg: &NetBoxConfig) -> crate::hosts::Host {
    crate::hosts::Host {
        id: host_id(device.netbox_id),
        display_name: device.name.clone(),
        hostname: device.address.clone(),
        port: device.overlay.port.unwrap_or(cfg.default_port),
        username: device
            .overlay
            .username
            .clone()
            .filter(|u| !u.trim().is_empty())
            .or_else(|| cfg.default_username.clone())
            .unwrap_or_default(),
        auth_type: "password".to_string(), // legacy field, not serialized
        ssh_key_path: None,
        credential: device
            .overlay
            .credential
            .clone()
            .or_else(|| cfg.default_credential.clone()),
        platform: device.platform.clone(),
        os_version: None,
        highlight_profile: None,
        notes: device.overlay.notes.clone(),
        last_connected: device.overlay.last_connected.clone(),
        created_at: String::new(),
        sort_order: device.netbox_id as u32,
        tags: device.tags.clone(),
        group_id: Some(group_id_for(device)),
        source: Some("netbox".to_string()),
    }
}

// ─── Synthetic nav-tree groups (plan §8.3) ──────────────────────────
//
// Mirrors the NetBox geography hierarchy:
//
//     NetBox root → Region (recursive) → Site → Location (recursive)
//
// Sites carry their region, locations carry their parent location and
// site; both chains are walked from the cached geo tables (v2). Empty
// tables (pre-v2 cache, geography fetch failure) degrade to slug-named
// site → flat-location folders, never a broken tree.

fn index_nodes(nodes: &[NetBoxGeoNode]) -> HashMap<String, NetBoxGeoNode> {
    nodes.iter().map(|n| (n.slug.clone(), n.clone())).collect()
}

fn display_name(n: &NetBoxGeoNode) -> String {
    if n.name.is_empty() {
        n.slug.clone()
    } else {
        n.name.clone()
    }
}

/// Ancestor chain of `slug` in `table`, top-most first, ending at `slug`.
/// Unknown slugs, missing parents, and parent cycles all fall back to
/// `[slug]` (node attaches to its site / the root — never an orphan or an
/// infinite loop). NetBox slugs are unique per model, so slug chains are
/// collision-free.
fn parent_chain(table: &HashMap<String, NetBoxGeoNode>, slug: &str) -> Vec<String> {
    let mut visited: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut chain: Vec<String> = Vec::new();
    let mut cur = slug.to_string();
    loop {
        if !visited.insert(cur.clone()) {
            return vec![slug.to_string()]; // cycle guard — flatten
        }
        match table.get(&cur) {
            Some(node) => {
                chain.push(cur.clone());
                match node.parent_slug.as_deref().filter(|p| !p.is_empty()) {
                    Some(p) => cur = p.to_string(),
                    None => break,
                }
            }
            None => break,
        }
    }
    if chain.is_empty() {
        return vec![slug.to_string()]; // slug not in table → stand alone
    }
    chain.reverse();
    chain
}

/// Insert a synthetic group unless already emitted (id-deduped). Sibling
/// order follows first-seen (geo table) order.
fn ensure_group(
    seen: &mut std::collections::HashSet<String>,
    groups: &mut Vec<crate::hosts::HostGroup>,
    id: String,
    name: String,
    parent_id: Option<String>,
) {
    if seen.insert(id.clone()) {
        groups.push(crate::hosts::HostGroup {
            sort_order: groups.len() as u32,
            id,
            name,
            parent_id,
            color: None,
            icon: None,
            created_at: String::new(),
        });
    }
}

/// Emit a slug chain (top-most first) as nested groups under
/// `start_parent`, naming each from `table` (slug fallback). Returns the
/// group id of the chain's deepest node.
fn ensure_chain(
    table: &HashMap<String, NetBoxGeoNode>,
    seen: &mut std::collections::HashSet<String>,
    groups: &mut Vec<crate::hosts::HostGroup>,
    id_for: fn(&str) -> String,
    chain: &[String],
    start_parent: &str,
) -> String {
    let mut parent = start_parent.to_string();
    for slug in chain {
        let name = table
            .get(slug)
            .map(display_name)
            .unwrap_or_else(|| slug.clone());
        let id = id_for(slug);
        ensure_group(seen, groups, id.clone(), name, Some(parent));
        parent = id;
    }
    parent
}

/// Synthetic host groups for the nav tree (plan §8.3): NetBox root →
/// region(s) → site → location(s), hiding branches without enabled devices
/// unless show_empty_folders is set. Devices whose site/location slug is
/// missing from the tables (stale cache) still get slug-named fallback groups so no
/// enabled device is orphaned. The whole tree disappears when no enabled
/// device is cached; the root sorts after every user group.
pub fn synthetic_groups(
    devices: &[NetBoxDeviceEntry],
    geo: &NetBoxGeo,
    show_empty_folders: bool,
) -> Vec<crate::hosts::HostGroup> {
    let enabled: Vec<&NetBoxDeviceEntry> = devices.iter().filter(|d| d.enabled).collect();
    if enabled.is_empty() {
        return Vec::new();
    }

    let regions = index_nodes(&geo.regions);
    let sites = index_nodes(&geo.sites);
    let locations = index_nodes(&geo.locations);

    let mut groups = vec![crate::hosts::HostGroup {
        id: ROOT_GROUP_ID.to_string(),
        name: "NetBox".to_string(),
        parent_id: None,
        sort_order: u32::MAX,
        color: None,
        icon: Some("netbox".to_string()),
        created_at: String::new(),
    }];
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    seen.insert(ROOT_GROUP_ID.to_string());

    // Regions with their ancestry, in table order.
    for r in &geo.regions {
        let chain = parent_chain(&regions, &r.slug);
        ensure_chain(&regions, &mut seen, &mut groups, region_group_id, &chain, ROOT_GROUP_ID);
    }
    // Sites: region ancestry first (usually already emitted), then the site.
    for s in &geo.sites {
        let mut parent = ROOT_GROUP_ID.to_string();
        if let Some(region_slug) = s.region_slug.as_deref().filter(|x| !x.is_empty()) {
            let chain = parent_chain(&regions, region_slug);
            parent = ensure_chain(&regions, &mut seen, &mut groups, region_group_id, &chain, &parent);
        }
        let id = site_group_id(&s.slug);
        ensure_group(&mut seen, &mut groups, id, display_name(s), Some(parent));
    }
    // Locations: parent chain under the location's site. The site group is
    // ensured first (slug-named if the sites table lacks it) so a partial
    // sites fetch never orphans the chain.
    for l in &geo.locations {
        let site_id = match l.site_slug.as_deref().filter(|x| !x.is_empty()) {
            Some(s) => {
                let name = sites.get(s).map(display_name).unwrap_or_else(|| s.to_string());
                let id = site_group_id(s);
                ensure_group(
                    &mut seen,
                    &mut groups,
                    id.clone(),
                    name,
                    Some(ROOT_GROUP_ID.to_string()),
                );
                id
            }
            None => ROOT_GROUP_ID.to_string(), // defensive: NetBox requires a site
        };
        let chain = parent_chain(&locations, &l.slug);
        ensure_chain(&locations, &mut seen, &mut groups, loc_group_id, &chain, &site_id);
    }
    // Stale-cache fallback: device slugs missing from the geo tables still
    // get slug-named groups so no enabled device is orphaned.
    for d in &enabled {
        let site_slug = match d.site.as_deref().filter(|s| !s.is_empty()) {
            Some(s) => s,
            None => continue, // no site → device sits in the NetBox root
        };
        if !sites.contains_key(site_slug) {
            ensure_group(
                &mut seen,
                &mut groups,
                site_group_id(site_slug),
                site_slug.to_string(),
                Some(ROOT_GROUP_ID.to_string()),
            );
        }
        if let Some(loc_slug) = d.location.as_deref().filter(|l| !l.is_empty()) {
            if !locations.contains_key(loc_slug) {
                ensure_group(
                    &mut seen,
                    &mut groups,
                    loc_group_id(loc_slug),
                    loc_slug.to_string(),
                    Some(site_group_id(site_slug)),
                );
            }
        }
    }

    if !show_empty_folders {
        let parents: HashMap<&str, Option<&str>> = groups
            .iter()
            .map(|g| (g.id.as_str(), g.parent_id.as_deref()))
            .collect();
        let mut populated = std::collections::HashSet::new();
        populated.insert(ROOT_GROUP_ID.to_string());
        for device in enabled {
            let mut id = group_id_for(device);
            while populated.insert(id.clone()) {
                match parents.get(id.as_str()).copied().flatten() {
                    Some(parent) => id = parent.to_string(),
                    None => break,
                }
            }
        }
        groups.retain(|g| populated.contains(&g.id));
    }

    groups
}

// ─── Client (plan §7.1, ollama.rs structure) ────────────────────────

/// Result of a device fetch: parsed devices plus the no-primary-IP count.
#[derive(Debug, Default)]
pub struct FetchResult {
    pub devices: Vec<RawNetBoxDevice>,
    pub no_primary_ip: usize,
}

// ─── Read-only HTTP guard (AGENTS.md) ────────────────────────────────
//
// The NetBox integration is strictly read-only: it must never
// POST/PUT/PATCH/DELETE to the configured instance. `ReadOnlyHttp` is the
// only route from this module to the network, and its `reqwest::Client` is
// private to the child module below — so nothing outside it (including
// `NetBoxClient` and the tests) can reach a write-verb builder. Do not:
//   - expose the client or a `RequestBuilder` here (`.method()` can
//     rewrite the verb),
//   - add a raw `reqwest::Client` field to `NetBoxClient`
//     (`test_netbox_source_has_no_write_http_methods` fails CI).

mod readonly_http {
    use std::time::Duration;

    /// GET-only wrapper around `reqwest::Client`. The private field makes
    /// the write verbs unreachable outside this module.
    pub struct ReadOnlyHttp {
        inner: reqwest::Client,
    }

    impl ReadOnlyHttp {
        /// 30s-timeout client. `allow_invalid_certs` accepts self-signed/
        /// unverifiable TLS certs (opt-in, off by default).
        pub fn new(allow_invalid_certs: bool) -> Result<Self, reqwest::Error> {
            let mut builder = reqwest::Client::builder().timeout(Duration::from_secs(30));
            if allow_invalid_certs {
                builder = builder.danger_accept_invalid_certs(true);
            }
            Ok(ReadOnlyHttp {
                inner: builder.build()?,
            })
        }

        /// Issue one authenticated GET and return the raw response. The
        /// `RequestBuilder` never leaves this module. `timeout` overrides
        /// the 30s client default when set. This is the ONLY HTTP verb
        /// `NetBoxClient` can perform.
        pub async fn get(
            &self,
            url: &reqwest::Url,
            auth: &str,
            timeout: Option<Duration>,
        ) -> Result<reqwest::Response, reqwest::Error> {
            let mut request = self.inner.get(url.clone());
            if let Some(t) = timeout {
                request = request.timeout(t);
            }
            request.header("Authorization", auth).send().await
        }
    }
}
use readonly_http::ReadOnlyHttp;

pub struct NetBoxClient {
    base_url: String,
    token: String,
    http: ReadOnlyHttp,
}

const MAX_PAGES: usize = 200;

impl NetBoxClient {
    /// 30s-timeout client. `base_url` must be `http://` or `https://` —
    /// scheme check only, LAN addresses are expected (plan §7.1).
    /// `allow_invalid_certs` accepts self-signed/unverifiable TLS certs
    /// (opt-in, off by default — a security downgrade, home labs only).
    pub fn new(base_url: &str, token: &str, allow_invalid_certs: bool) -> Result<Self, String> {
        let trimmed = base_url.trim().trim_end_matches('/');
        if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
            return Err("NetBox URL must start with http:// or https://".to_string());
        }
        if trimmed.is_empty() {
            return Err("NetBox URL is empty".to_string());
        }
        if allow_invalid_certs {
            log::warn!(
                "NetBox client for {} built with TLS verification disabled — home-lab mode, token is MITM-able",
                trimmed
            );
        }
        let http = ReadOnlyHttp::new(allow_invalid_certs)
            .map_err(|e| format!("Failed to build HTTP client: {}", e))?;
        Ok(NetBoxClient {
            base_url: trimmed.to_string(),
            token: token.trim().to_string(),
            http,
        })
    }

    /// Auth header value: v2 tokens (`nbt_...`) use Bearer, v1 legacy
    /// tokens use the Token scheme (plan §4).
    fn auth_header(&self) -> String {
        if self.token.starts_with("nbt_") {
            format!("Bearer {}", self.token)
        } else {
            format!("Token {}", self.token)
        }
    }

    /// One `GET /api/dcim/devices/?limit=1&exclude=config_context` — the
    /// `API-Version` response header plus `count` from the body (plan §4.2).
    pub async fn test_connection(&self) -> Result<(String, u32), String> {
        let url = reqwest::Url::parse(&format!(
            "{}/api/dcim/devices/?limit=1&exclude=config_context",
            self.base_url
        ))
        .map_err(|e| format!("Invalid NetBox URL: {}", e))?;
        log::info!("NetBox test_connection -> {}", url);
        let response = self
            .http
            .get(&url, &self.auth_header(), Some(Duration::from_secs(5)))
            .await
            .map_err(|e| {
                log::warn!("NetBox test_connection request failed: {}", e);
                self.map_request_error(&e)
            })?;

        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            log::warn!("NetBox test_connection non-2xx (HTTP {})", status);
            return Err(map_status_error(status, &body, None));
        }

        let version = response
            .headers()
            .get("API-Version")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("unknown")
            .to_string();
        let count = response
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|v| v.get("count").and_then(|c| c.as_u64()))
            .unwrap_or(0) as u32;
        log::info!(
            "NetBox test_connection ok — API-Version {}, {} devices",
            version,
            count
        );
        Ok((version, count))
    }

    /// Fetch all devices matching `filters`, following offset pagination
    /// (`next` links) with a hard page cap.
    pub async fn fetch_devices(&self, filters: &NetBoxFilters) -> Result<FetchResult, String> {
        let mut query: Vec<(&str, &str)> = vec![("limit", "100"), ("exclude", "config_context")];
        if let Some(ref status) = filters.status {
            if !status.is_empty() {
                query.push(("status", status));
            }
        }
        for s in &filters.sites {
            query.push(("site", s));
        }
        for r in &filters.roles {
            query.push(("role", r));
        }
        for t in &filters.tags {
            query.push(("tag", t));
        }

        let mut url = reqwest::Url::parse_with_params(
            &format!("{}/api/dcim/devices/", self.base_url),
            query,
        )
        .map_err(|e| format!("Failed to build request URL: {}", e))?;

        log::info!("NetBox fetch_devices -> {} (status={:?} sites={:?} roles={:?} tags={:?})",
            url, filters.status, filters.sites, filters.roles, filters.tags);

        let mut result = FetchResult::default();
        let mut pages = 0;
        loop {
            pages += 1;
            if pages > MAX_PAGES {
                log::error!("NetBox fetch_devices exceeded {} pages — aborting", MAX_PAGES);
                return Err(format!(
                    "NetBox pagination did not terminate after {} pages",
                    MAX_PAGES
                ));
            }

            let body = self.get_json(&url).await?;
            let page_count = body.get("results").and_then(|r| r.as_array()).map(|a| a.len()).unwrap_or(0);
            log::debug!("NetBox fetch_devices page {} — {} devices", pages, page_count);
            if let Some(items) = body.get("results").and_then(|r| r.as_array()) {
                for item in items {
                    match parse_device(item) {
                        Some(d) => result.devices.push(d),
                        None => result.no_primary_ip += 1,
                    }
                }
            }

            match body.get("next").and_then(|n| n.as_str()) {
                Some(next) if !next.is_empty() => {
                    log::debug!("NetBox fetch_devices following next -> {}", next);
                    url = reqwest::Url::parse(next)
                        .map_err(|e| format!("NetBox returned an invalid next-page URL: {}", e))?;
                }
                _ => break,
            }
        }
        log::info!(
            "NetBox fetch_devices done — {} pages, {} devices, {} without primary IP",
            pages,
            result.devices.len(),
            result.no_primary_ip
        );
        Ok(result)
    }

    /// Fetch all site choices (slug + name) for the filter dropdown.
    pub async fn fetch_sites(&self) -> Result<Vec<NetBoxChoice>, String> {
        self.fetch_choices("/api/dcim/sites/").await
    }

    /// Fetch all device-role choices for the filter dropdown.
    pub async fn fetch_device_roles(&self) -> Result<Vec<NetBoxChoice>, String> {
        self.fetch_choices("/api/dcim/device-roles/").await
    }

    /// Fetch all tag choices for the filter dropdown.
    pub async fn fetch_tags(&self) -> Result<Vec<NetBoxChoice>, String> {
        self.fetch_choices("/api/extras/tags/").await
    }

    /// Fetch the geography tables (regions, sites, locations with parent
    /// links) for the nav-tree hierarchy (plan §8.3). One call each,
    /// `limit=0` = every object. Each fetch degrades independently: an
    /// endpoint error logs a warning and yields an empty table — the tree
    /// falls back to slug-named site → flat locations for that model.
    pub async fn fetch_geo(&self) -> NetBoxGeo {
        NetBoxGeo {
            regions: self.fetch_geo_table("/api/dcim/regions/").await,
            sites: self.fetch_geo_table("/api/dcim/sites/").await,
            locations: self.fetch_geo_table("/api/dcim/locations/").await,
        }
    }

    /// Fetch one geography table; empty on any error (the tree degrades to
    /// slug-named groups for that model, never a broken tree).
    async fn fetch_geo_table(&self, path: &str) -> Vec<NetBoxGeoNode> {
        let url = reqwest::Url::parse(&format!("{}{}?limit=0", self.base_url, path))
            .map_err(|e| format!("Invalid URL: {}", e));
        let url = match url {
            Ok(u) => u,
            Err(e) => {
                log::warn!("NetBox geo {} unavailable: {}", path, e);
                return Vec::new();
            }
        };
        log::info!("NetBox fetch_geo -> {}", url);
        match self.get_json(&url).await {
            Ok(body) => body
                .get("results")
                .and_then(|r| r.as_array())
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| {
                            let slug = item.get("slug")?.as_str()?.to_string();
                            let name = item
                                .get("name")
                                .and_then(|n| n.as_str())
                                .unwrap_or(&slug)
                                .to_string();
                            Some(NetBoxGeoNode {
                                slug,
                                name,
                                parent_slug: nested_slug(item, "parent"),
                                site_slug: nested_slug(item, "site"),
                                region_slug: nested_slug(item, "region"),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default(),
            Err(e) => {
                log::warn!("NetBox geo {} unavailable: {} — tree degrades for this model", path, e);
                Vec::new()
            }
        }
    }

    async fn fetch_choices(&self, path: &str) -> Result<Vec<NetBoxChoice>, String> {
        let url = reqwest::Url::parse(&format!(
            "{}{}?limit=1000&fields=slug,name",
            self.base_url, path
        ))
        .map_err(|e| format!("Invalid URL: {}", e))?;
        log::info!("NetBox fetch_choices -> {}", url);
        let body = self.get_json(&url).await?;
        let items = body
            .get("results")
            .and_then(|r| r.as_array())
            .ok_or_else(|| "Unexpected NetBox response shape (missing results)".to_string())?;
        Ok(items
            .iter()
            .filter_map(|item| {
                let slug = item.get("slug")?.as_str()?.to_string();
                let name = item
                    .get("name")
                    .and_then(|n| n.as_str())
                    .unwrap_or(&slug)
                    .to_string();
                Some(NetBoxChoice { slug, name })
            })
            .collect())
    }

    /// GET a URL with auth, map errors, parse the JSON body.
    async fn get_json(&self, url: &reqwest::Url) -> Result<serde_json::Value, String> {
        let response = self
            .http
            .get(url, &self.auth_header(), None)
            .await
            .map_err(|e| {
                log::warn!("NetBox GET {} failed: {}", url, e);
                self.map_request_error(&e)
            })?;

        let status = response.status();
        if !status.is_success() {
            let retry_after = response
                .headers()
                .get("Retry-After")
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string());
            let body = response.text().await.unwrap_or_default();
            log::warn!("NetBox GET {} non-2xx (HTTP {})", url, status);
            return Err(map_status_error(status, &body, retry_after.as_deref()));
        }

        response
            .json()
            .await
            .map_err(|e| format!("Failed to parse NetBox response: {}", e))
    }

    /// Friendly mapping for transport-level failures.
    fn map_request_error(&self, e: &reqwest::Error) -> String {
        if e.is_timeout() {
            format!("NetBox at {} timed out — instance unreachable or slow", self.base_url)
        } else if e.is_connect() {
            format!(
                "Could not connect to NetBox at {} — check the URL and that the instance is running",
                self.base_url
            )
        } else {
            format!("NetBox request failed: {}", e)
        }
    }
}

/// Friendly mapping for HTTP status codes (plan §4).
fn map_status_error(status: reqwest::StatusCode, body: &str, retry_after: Option<&str>) -> String {
    match status.as_u16() {
        401 => "Invalid or expired NetBox API token".to_string(),
        403 => "NetBox token lacks permission to list devices (DCIM > Device needs read access)"
            .to_string(),
        429 => match retry_after {
            Some(ra) => format!("Rate limited by NetBox — retry after {}s", ra),
            None => "Rate limited by NetBox — wait a moment and try again".to_string(),
        },
        s if s >= 500 => format!("NetBox server error (HTTP {})", s),
        s => format!("NetBox API error (HTTP {}): {}", s, body),
    }
}

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
    if !config.enabled {
        return Err("NetBox integration is disabled — enable it in Settings → NetBox".to_string());
    }
    if config.base_url.trim().is_empty() {
        return Err("No NetBox URL configured — set one in Settings → NetBox".to_string());
    }
    let token = credentials::get_secret(TOKEN_KEY)?
        .ok_or_else(|| "No NetBox API token saved — enter one in Settings → NetBox".to_string())?;

    let policy = {
        let platforms = state.platforms.lock().map_err(|e| e.to_string())?;
        config.platform_policy(&platforms)
    };
    let client = NetBoxClient::new(&config.base_url, &token, config.allow_invalid_certs)?;
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

    let mut netbox = state.netbox.lock().map_err(|e| e.to_string())?;
    netbox.apply_sync(report, entries, geo)
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
    if config.base_url.trim().is_empty() {
        return Err("No NetBox URL configured — set one in Settings → NetBox".to_string());
    }
    let token = credentials::get_secret(TOKEN_KEY)?
        .ok_or_else(|| "No NetBox API token saved — enter one in Settings → NetBox".to_string())?;
    NetBoxClient::new(&config.base_url, &token, config.allow_invalid_certs)
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

// ─── Debug-gated mock NetBox server (plan 064) ──────────────────────

/// In-process NetBox HTTP mock shared by the unit tests below and the
/// app-level `npm run smoke:netbox` suite (driven through debug-only Tauri
/// commands). Compiled for tests and debug builds only — never into a
/// release binary.
///
/// The fixtures are hand-written to the shapes the client parses. A
/// passing run proves the client and the sync pipeline agree with these
/// fixtures; it is NOT evidence of compatibility with any real NetBox
/// version.
#[cfg(any(test, debug_assertions))]
pub(crate) mod mock {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// Responder: (method, path-with-query, Authorization header) →
    /// (status, JSON body, extra headers like API-Version). The method is
    /// the REAL one from the request line, and the responder runs for
    /// every request — rejected ones included, so tests can record the
    /// true verb — but a non-GET is always answered with a 405 whatever
    /// the responder returns (read-only contract).
    pub(crate) type Responder =
        Arc<dyn Fn(&str, &str, &str) -> (u16, String, Vec<(String, String)>) + Send + Sync>;

    async fn bind() -> (TcpListener, String) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        (listener, base)
    }

    /// Accept loop shared by `start_mock` and `MockNetBox`. Enforces the
    /// read-only contract (AGENTS.md): a request whose method is not GET
    /// is answered with a 405, so a client regression to a write verb
    /// fails whichever test exercises it. The responder still sees
    /// rejected request lines, so tests can assert on the verb.
    fn serve(listener: TcpListener, responder: Responder) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else { break };
                let responder = responder.clone();
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut tmp = [0u8; 4096];
                    // GET requests only — headers terminate the request.
                    loop {
                        match tokio::time::timeout(Duration::from_secs(5), socket.read(&mut tmp))
                            .await
                        {
                            Ok(Ok(0)) | Err(_) => return,
                            Ok(Ok(n)) => {
                                buf.extend_from_slice(&tmp[..n]);
                                if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                                    break;
                                }
                            }
                            Ok(Err(_)) => return,
                        }
                    }
                    let text = String::from_utf8_lossy(&buf);
                    let mut lines = text.lines();
                    let request_line = lines.next().unwrap_or_default().to_string();
                    let mut parts = request_line.split(' ');
                    let method = parts.next().unwrap_or_default().to_string();
                    let path = parts.next().unwrap_or("/").to_string();
                    let mut auth = String::new();
                    for line in lines {
                        let mut parts = line.splitn(2, ':');
                        let name = parts.next().unwrap_or_default().trim().to_ascii_lowercase();
                        let value = parts.next().unwrap_or_default().trim().to_string();
                        if name == "authorization" {
                            auth = value;
                        }
                    }
                    // Read-only contract tripwire (AGENTS.md): the NetBox
                    // integration issues GETs only. The responder runs for
                    // every request line — rejected ones included — so a
                    // test-side recorder sees the true verb even when the
                    // client call swallows the rejection; but a non-GET is
                    // ALWAYS answered with a 405, which surfaces as an error
                    // in the client call that made it and fails whichever
                    // test exercises it.
                    let (status, body, extra_headers) = responder(&method, &path, &auth);
                    let (status, body, extra_headers) = if method == "GET" {
                        (status, body, extra_headers)
                    } else {
                        (
                            405,
                            "{\"detail\":\"comnd's NetBox integration is read-only; only GET is allowed\"}"
                                .into(),
                            vec![],
                        )
                    };
                    let reason = match status {
                        200 => "OK",
                        401 => "Unauthorized",
                        403 => "Forbidden",
                        404 => "Not Found",
                        405 => "Method Not Allowed",
                        429 => "Too Many Requests",
                        _ => "Error",
                    };
                    let mut response = format!(
                        "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n",
                        status, reason, body.len()
                    );
                    for (k, v) in extra_headers {
                        response.push_str(&format!("{}: {}\r\n", k, v));
                    }
                    response.push_str("\r\n");
                    response.push_str(&body);
                    let _ = socket.write_all(response.as_bytes()).await;
                    let _ = socket.flush().await;
                });
            }
        })
    }

    /// Minimal one-shot-connection HTTP server on 127.0.0.1:0 for NetBox
    /// API tests. `make` receives the base URL so `next` links can point
    /// back. Only the Rust unit tests need a custom responder; the
    /// app-level suite drives `MockNetBox`.
    #[cfg(test)]
    pub(crate) async fn start_mock<F>(make: F) -> (String, tokio::task::JoinHandle<()>)
    where
        F: FnOnce(String) -> Responder,
    {
        let (listener, base) = bind().await;
        let responder = make(base.clone());
        (base, serve(listener, responder))
    }

    pub(crate) fn page(
        next: Option<String>,
        results: Vec<serde_json::Value>,
    ) -> (u16, String, Vec<(String, String)>) {
        (
            200,
            serde_json::json!({
                "count": results.len(),
                "next": next,
                "previous": null,
                "results": results
            })
            .to_string(),
            vec![],
        )
    }

    // ─── Fixtures ──────────────────────────────────────────────────
    //
    // Synthetic devices only — no real hostnames, addresses, or tokens.

    /// Devices the mock reports on a normal sync, before pagination.
    pub(crate) const DEVICE_COUNT: u64 = 6;

    fn device(
        id: u64,
        name: &str,
        address: Option<&str>,
        platform: Option<&str>,
        site: Option<&str>,
        location: Option<&str>,
        tags: &[&str],
    ) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "url": format!("http://netbox.invalid/api/dcim/devices/{}/", id),
            "display": name,
            "name": name,
            "description": "Synthetic fixture device",
            "status": { "value": "active", "label": "Active" },
            "site": site.map(|s| serde_json::json!({ "id": 1, "name": s, "slug": s })),
            "location": location.map(|l| serde_json::json!({ "id": 1, "name": l, "slug": l })),
            "platform": platform.map(|p| serde_json::json!({ "id": 1, "name": p, "slug": p })),
            "primary_ip4": address.map(|a| serde_json::json!({ "id": 1, "family": 4, "address": a })),
            "primary_ip6": null,
            "tags": tags.iter().map(|t| serde_json::json!({ "id": 1, "name": t, "slug": t })).collect::<Vec<_>>(),
        })
    }

    /// Device with every optional field absent, the way NetBox omits keys
    /// that were never set. It must still sync: no site/location puts it in
    /// the NetBox root, and no tags/status/description leave its meta empty.
    fn bare_device() -> serde_json::Value {
        serde_json::json!({
            "id": 106,
            "url": "http://netbox.invalid/api/dcim/devices/106/",
            "display": "bare-device",
            "name": "bare-device",
            "platform": { "id": 1, "name": "ubuntu", "slug": "ubuntu" },
            "primary_ip4": { "id": 1, "family": 4, "address": "10.40.0.9/24" },
            "primary_ip6": null,
        })
    }

    /// Page 1: two devices, both under dc1, one per rack.
    fn devices_page1() -> Vec<serde_json::Value> {
        vec![
            device(101, "edge-rtr-01", Some("10.10.0.1/24"), Some("cisco-ios"), Some("dc1"), Some("rack-1"), &["prod"]),
            device(102, "edge-rtr-02", Some("10.10.0.2/24"), Some("cisco-ios"), Some("dc1"), Some("rack-2"), &["prod"]),
        ]
    }

    /// Page 2: one plain device, one without a primary IP, one on an
    /// unmapped platform, and the bare device.
    fn devices_page2() -> Vec<serde_json::Value> {
        vec![
            device(103, "core-sw-01", Some("10.20.0.1/24"), Some("nx-os"), Some("dc2"), None, &[]),
            device(104, "no-primary-ip", None, Some("cisco-ios"), Some("dc1"), Some("rack-1"), &["prod"]),
            device(105, "mystery-box", Some("10.30.0.5/24"), Some("juniper-junos"), Some("dc2"), None, &[]),
            bare_device(),
        ]
    }

    /// `refresh` scenario page 1: 101 renamed and re-addressed, same site
    /// and rack.
    fn refresh_page1() -> Vec<serde_json::Value> {
        vec![device(
            101,
            "edge-rtr-01-renamed",
            Some("10.10.1.1/24"),
            Some("cisco-ios"),
            Some("dc1"),
            Some("rack-1"),
            &["prod"],
        )]
    }

    /// `refresh` scenario page 2: 102 is gone, 103 and the bare device are
    /// unchanged.
    fn refresh_page2() -> Vec<serde_json::Value> {
        vec![
            device(103, "core-sw-01", Some("10.20.0.1/24"), Some("nx-os"), Some("dc2"), None, &[]),
            bare_device(),
        ]
    }

    fn region_nodes() -> Vec<serde_json::Value> {
        vec![serde_json::json!({
            "id": 1, "name": "EMEA", "slug": "emea", "parent": null,
        })]
    }

    fn site_nodes() -> Vec<serde_json::Value> {
        vec![
            serde_json::json!({
                "id": 1, "name": "DC1 London", "slug": "dc1",
                "region": { "id": 1, "name": "EMEA", "slug": "emea" },
            }),
            serde_json::json!({
                "id": 2, "name": "DC2 Manchester", "slug": "dc2",
                "region": { "id": 1, "name": "EMEA", "slug": "emea" },
            }),
        ]
    }

    fn location_nodes() -> Vec<serde_json::Value> {
        vec![
            serde_json::json!({
                "id": 1, "name": "Rack 1", "slug": "rack-1", "parent": null,
                "site": { "id": 1, "name": "DC1 London", "slug": "dc1" },
            }),
            serde_json::json!({
                "id": 2, "name": "Rack 2", "slug": "rack-2", "parent": null,
                "site": { "id": 1, "name": "DC1 London", "slug": "dc1" },
            }),
        ]
    }

    fn role_nodes() -> Vec<serde_json::Value> {
        vec![
            serde_json::json!({ "slug": "router", "name": "Router" }),
            serde_json::json!({ "slug": "switch", "name": "Switch" }),
        ]
    }

    fn tag_nodes() -> Vec<serde_json::Value> {
        vec![serde_json::json!({ "slug": "prod", "name": "Prod" })]
    }

    /// Choices endpoints are asked for `fields=slug,name`; strip the rest so
    /// a client that relied on dropped fields fails here.
    fn choices(nodes: Vec<serde_json::Value>) -> Vec<serde_json::Value> {
        nodes
            .into_iter()
            .map(|n| {
                serde_json::json!({
                    "slug": n.get("slug").cloned().unwrap_or(serde_json::Value::Null),
                    "name": n.get("name").cloned().unwrap_or(serde_json::Value::Null),
                })
            })
            .collect()
    }

    /// Status/body/headers for the failing scenarios. `ok` and `refresh`
    /// return `None` so the caller serves fixtures.
    fn error_response(scenario: &str) -> Option<(u16, String, Vec<(String, String)>)> {
        match scenario {
            "unauthorized" => Some((401, r#"{"detail":"Invalid token"}"#.into(), vec![])),
            "forbidden" => Some((403, r#"{"detail":"Forbidden"}"#.into(), vec![])),
            "throttled" => Some((
                429,
                r#"{"detail":"Throttled"}"#.into(),
                vec![("Retry-After".into(), "42".into())],
            )),
            "server_error" => Some((500, r#"{"detail":"Server error"}"#.into(), vec![])),
            _ => None,
        }
    }

    // ─── App-level mock handle ─────────────────────────────────────

    /// Scenarios the app-level suite can drive. `ok` is the initial state;
    /// switching keeps the base URL stable so a refresh reuses the same
    /// configured instance.
    pub(crate) const SCENARIOS: [&str; 6] =
        ["ok", "refresh", "unauthorized", "forbidden", "throttled", "server_error"];

    /// One request the mock saw. `has_auth` records only whether an
    /// Authorization header was present, and `auth_scheme` only its first
    /// word (`Bearer`/`Token`) — never the token itself.
    #[derive(Clone, Debug, serde::Serialize)]
    pub struct RecordedRequest {
        pub method: String,
        pub path: String,
        pub has_auth: bool,
        pub auth_scheme: String,
    }

    struct MockState {
        base: String,
        scenario: Mutex<String>,
        requests: Mutex<Vec<RecordedRequest>>,
    }

    impl MockState {
        fn record(&self, method: &str, path: &str, auth: &str) {
            self.requests.lock().unwrap().push(RecordedRequest {
                method: method.to_string(),
                path: path.to_string(),
                has_auth: !auth.is_empty(),
                auth_scheme: auth
                    .split_whitespace()
                    .next()
                    .unwrap_or_default()
                    .to_string(),
            });
        }

        fn scenario(&self) -> String {
            self.scenario.lock().unwrap().clone()
        }
    }

    /// A running mock plus its request log. `stop` aborts the listener;
    /// dropping without `stop` leaves it running until the process exits.
    pub struct MockNetBox {
        pub base_url: String,
        state: Arc<MockState>,
        handle: tokio::task::JoinHandle<()>,
    }

    impl MockNetBox {
        pub async fn start() -> Self {
            let (listener, base) = bind().await;
            let state = Arc::new(MockState {
                base: base.clone(),
                scenario: Mutex::new("ok".to_string()),
                requests: Mutex::new(Vec::new()),
            });
            let handler_state = state.clone();
            let responder: Responder = Arc::new(move |method, path, auth| {
                handler_state.record(method, path, auth);
                respond(&handler_state, method, path)
            });
            Self {
                base_url: base,
                state,
                handle: serve(listener, responder),
            }
        }

        pub fn set_scenario(&self, scenario: &str) -> Result<(), String> {
            if !SCENARIOS.contains(&scenario) {
                return Err(format!(
                    "Unknown NetBox mock scenario '{}' (expected one of: {})",
                    scenario,
                    SCENARIOS.join(", ")
                ));
            }
            *self.state.scenario.lock().unwrap() = scenario.to_string();
            Ok(())
        }

        pub fn requests(&self) -> Vec<RecordedRequest> {
            self.state.requests.lock().unwrap().clone()
        }

        pub fn stop(self) {
            self.handle.abort();
        }
    }

    /// Route one request to the fixtures for the current scenario.
    fn respond(
        state: &MockState,
        _method: &str,
        path: &str,
    ) -> (u16, String, Vec<(String, String)>) {
        let scenario = state.scenario();

        if path.starts_with("/api/dcim/devices/") {
            if let Some(err) = error_response(&scenario) {
                return err;
            }
            // `netbox_test_connection` probes with limit=1 (not limit=100).
            if path.contains("limit=1&") {
                return (
                    200,
                    serde_json::json!({
                        "count": DEVICE_COUNT,
                        "next": null,
                        "previous": null,
                        "results": []
                    })
                    .to_string(),
                    vec![("API-Version".to_string(), "4.15.0".to_string())],
                );
            }
            let (first, second) = if scenario == "refresh" {
                (refresh_page1(), refresh_page2())
            } else {
                (devices_page1(), devices_page2())
            };
            if path.contains("offset=100") {
                return page(None, second);
            }
            let next = format!(
                "{}/api/dcim/devices/?limit=100&exclude=config_context&offset=100",
                state.base
            );
            return page(Some(next), first);
        }
        if path.starts_with("/api/dcim/regions/") {
            return page(None, region_nodes());
        }
        if path.starts_with("/api/dcim/sites/") {
            // `limit=0` is the geo table; the choices call uses limit=1000.
            if path.contains("limit=0") {
                return page(None, site_nodes());
            }
            return page(None, choices(site_nodes()));
        }
        if path.starts_with("/api/dcim/locations/") {
            return page(None, location_nodes());
        }
        if path.starts_with("/api/dcim/device-roles/") {
            return page(None, choices(role_nodes()));
        }
        if path.starts_with("/api/extras/tags/") {
            return page(None, choices(tag_nodes()));
        }
        (
            404,
            r#"{"detail":"Not found"}"#.to_string(),
            vec![],
        )
    }
}

// ─── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ─── Device parsing (plan §4.1) ────────────────────────────────

    fn device_json(id: u64, name: Option<&str>, address: Option<&str>) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "url": format!("http://netbox/api/dcim/devices/{}/", id),
            "display": format!("display-{}", id),
            "name": name,
            "description": "Core router",
            "status": { "value": "active", "label": "Active" },
            "site": { "id": 7, "name": "DC1", "slug": "dc1" },
            "location": { "id": 3, "name": "Rack row 1", "slug": "rack-row-1" },
            "platform": { "id": 2, "name": "Cisco IOS", "slug": "cisco-ios" },
            "primary_ip4": address.map(|a| serde_json::json!({ "id": 991, "family": 4, "address": a })),
            "primary_ip6": null,
            "tags": [ { "id": 5, "name": "prod", "slug": "prod", "color": "f44336" } ]
        })
    }

    #[test]
    fn test_parse_device_full_shape() {
        let d = parse_device(&device_json(231, Some("core-rtr-01"), Some("10.0.0.1/24"))).unwrap();
        assert_eq!(d.netbox_id, 231);
        assert_eq!(d.name, "core-rtr-01");
        assert_eq!(d.address, "10.0.0.1");
        assert_eq!(d.platform_slug.as_deref(), Some("cisco-ios"));
        assert_eq!(d.site_slug.as_deref(), Some("dc1"));
        assert_eq!(d.location_slug.as_deref(), Some("rack-row-1"));
        assert_eq!(d.tags, vec!["prod"]);
        assert_eq!(d.status, "active");
        assert_eq!(d.description, "Core router");
    }

    #[test]
    fn test_parse_device_null_name_falls_back_to_display() {
        let d = parse_device(&device_json(1, None, Some("10.0.0.1/24"))).unwrap();
        assert_eq!(d.name, "display-1");
    }

    #[test]
    fn test_parse_device_null_name_no_display_uses_id() {
        let mut v = device_json(42, None, Some("10.0.0.1/24"));
        v["display"] = serde_json::Value::Null;
        let d = parse_device(&v).unwrap();
        assert_eq!(d.name, "device-42");
    }

    #[test]
    fn test_parse_device_no_primary_ip_returns_none() {
        assert!(parse_device(&device_json(1, Some("x"), None)).is_none());
        // primary_ip6 fallback works
        let mut v = device_json(1, Some("x"), None);
        v["primary_ip6"] = serde_json::json!({ "family": 6, "address": "fd00::1/64" });
        let d = parse_device(&v).unwrap();
        assert_eq!(d.address, "fd00::1");
    }

    #[test]
    fn test_parse_device_null_platform_and_location() {
        let mut v = device_json(1, Some("x"), Some("10.0.0.1/24"));
        v["platform"] = serde_json::Value::Null;
        v["location"] = serde_json::Value::Null;
        let d = parse_device(&v).unwrap();
        assert_eq!(d.platform_slug, None);
        assert_eq!(d.location_slug, None);
        // site missing entirely → defensive None
        let mut v2 = device_json(2, Some("y"), Some("10.0.0.2/24"));
        v2.as_object_mut().unwrap().remove("site");
        let d2 = parse_device(&v2).unwrap();
        assert_eq!(d2.site_slug, None);
    }

    #[test]
    fn test_parse_device_status_defensive_shapes() {
        // Integer value (ancient 2.x) → label lowercased
        let mut v = device_json(1, Some("x"), Some("10.0.0.1/24"));
        v["status"] = serde_json::json!({ "value": 1, "label": "Active" });
        assert_eq!(parse_device(&v).unwrap().status, "active");
        // Missing status → empty
        let mut v2 = device_json(2, Some("x"), Some("10.0.0.2/24"));
        v2.as_object_mut().unwrap().remove("status");
        assert_eq!(parse_device(&v2).unwrap().status, "");
    }

    #[test]
    fn test_parse_device_string_tags_2x_shape() {
        let mut v = device_json(1, Some("x"), Some("10.0.0.1/24"));
        v["tags"] = serde_json::json!(["prod", "edge"]);
        assert_eq!(parse_device(&v).unwrap().tags, vec!["prod", "edge"]);
    }

    // ─── Platform mapping (plan §7.2) ──────────────────────────────

    #[test]
    fn test_map_platform_table() {
        assert_eq!(map_platform("cisco-ios"), Some("cisco-iosxe"));
        assert_eq!(map_platform("ios-xe"), Some("cisco-iosxe"));
        assert_eq!(map_platform("nx-os"), Some("cisco-nxos"));
        assert_eq!(map_platform("nxos"), Some("cisco-nxos"));
        assert_eq!(map_platform("f5-tmos"), Some("f5-tmos"));
        assert_eq!(map_platform("big-ip"), Some("f5-tmos"));
        assert_eq!(map_platform("ubuntu"), Some("linux-bash"));
        assert_eq!(map_platform("rhel"), Some("linux-bash"));
        assert_eq!(map_platform("juniper-junos"), None);
        assert_eq!(map_platform("foo-os"), None);
    }

    #[test]
    fn test_platform_policy_skip_fallback_override() {
        let skip = PlatformPolicy::default();
        assert_eq!(skip.resolve(Some("juniper-junos")), None);
        assert_eq!(skip.resolve(None), None);

        let fallback = PlatformPolicy {
            fallback: Some("linux-bash".into()),
            ..Default::default()
        };
        assert_eq!(fallback.resolve(Some("foo-os")), Some("linux-bash".into()));
        assert_eq!(fallback.resolve(None), Some("linux-bash".into()));
        // Built-in table still wins over fallback
        assert_eq!(fallback.resolve(Some("nxos")), Some("cisco-nxos".into()));

        let mut overrides = HashMap::new();
        overrides.insert("foo-os".to_string(), "f5-tmos".to_string());
        overrides.insert("nxos".to_string(), "linux-bash".to_string());
        let policy = PlatformPolicy {
            fallback: Some("linux-bash".into()),
            overrides,
        };
        // Override wins over fallback AND built-in table
        assert_eq!(policy.resolve(Some("foo-os")), Some("f5-tmos".into()));
        assert_eq!(policy.resolve(Some("nxos")), Some("linux-bash".into()));
    }

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

    #[test]
    fn test_slugify_and_name_caps() {
        assert_eq!(slugify("Rack Row 1"), "rackrow1");
        assert_eq!(slugify("dc-01"), "dc-01");
        assert_eq!(slugify("--weird--"), "--weird--");
        assert_eq!(slugify("a.b_c"), "abc");
        let long = "x".repeat(200);
        assert_eq!(sanitize_name(&long, 9).len(), 128);
        assert_eq!(sanitize_name("  \u{0007} ", 9), "device-9");
        assert_eq!(sanitize_name("", 9), "device-9");
    }

    // ─── Mock HTTP server (plan §10) ──────────────────────────────

    use std::sync::{Arc, Mutex};

    // The server lives in `mock` so the app-level `npm run smoke:netbox`
    // suite drives the same code; the fixtures below are local to these
    // unit tests.
    use super::mock::{page, start_mock};

    /// The app-level suite drives this same mock through debug-only Tauri
    /// commands, so its recorder and scenario switch are pinned here.
    #[tokio::test]
    async fn test_mock_netbox_scenarios_and_request_log() {
        let mock = super::mock::MockNetBox::start().await;
        let client = NetBoxClient::new(&mock.base_url, "nbt_v2.ro", false).unwrap();

        let first = client.fetch_devices(&NetBoxFilters::default()).await.unwrap();
        // Six fixtures, one of which has no primary IP.
        assert_eq!(first.devices.len(), 5);
        assert_eq!(first.no_primary_ip, 1);
        let ids: Vec<u64> = first.devices.iter().map(|d| d.netbox_id).collect();
        assert_eq!(ids, vec![101, 102, 103, 105, 106]);

        let requests = mock.requests();
        assert!(requests.iter().all(|r| r.method == "GET"), "{:?}", requests);
        assert!(requests.iter().all(|r| r.has_auth), "{:?}", requests);
        // The token value never leaves the client; only the scheme is recorded.
        assert!(
            requests.iter().all(|r| r.auth_scheme == "Bearer"),
            "{:?}",
            requests
        );
        assert!(
            requests.iter().any(|r| r.path.contains("offset=100")),
            "second page was not requested: {:?}",
            requests
        );

        // Switching the scenario keeps the base URL and changes the data.
        mock.set_scenario("refresh").unwrap();
        let refreshed = client.fetch_devices(&NetBoxFilters::default()).await.unwrap();
        assert_eq!(refreshed.devices.len(), 3);
        assert_eq!(refreshed.devices[0].name, "edge-rtr-01-renamed");
        assert_eq!(refreshed.devices[0].address, "10.10.1.1");

        // Failing scenarios surface through the normal error mapping.
        for (scenario, needle) in [
            ("unauthorized", "Invalid or expired"),
            ("forbidden", "lacks permission"),
            ("throttled", "42"),
            ("server_error", "server error"),
        ] {
            mock.set_scenario(scenario).unwrap();
            let err = client
                .fetch_devices(&NetBoxFilters::default())
                .await
                .unwrap_err();
            assert!(err.contains(needle), "{} -> {}", scenario, err);
        }
        assert!(mock.set_scenario("nope").is_err());

        // A legacy (non-`nbt_`) token uses the Token scheme. The recorder keeps
        // the scheme distinguishable so the app-level suite can prove that the
        // token typed into the UI, not the environment's, reached the backend.
        mock.set_scenario("ok").unwrap();
        let legacy = NetBoxClient::new(&mock.base_url, "smoke-legacy-token", false).unwrap();
        legacy.fetch_devices(&NetBoxFilters::default()).await.unwrap();
        assert_eq!(mock.requests().last().unwrap().auth_scheme, "Token");

        mock.stop();
    }

    #[tokio::test]
    async fn test_fetch_devices_follows_pagination() {
        let (base, server) = start_mock(|base| {
            Arc::new(move |_, path, _| {
                if path.contains("offset=100") {
                    page(None, vec![device_json(2, Some("sw-02"), Some("10.0.0.2/24"))])
                } else {
                    page(
                        Some(format!(
                            "{}/api/dcim/devices/?limit=100&exclude=config_context&offset=100",
                            base
                        )),
                        vec![device_json(1, Some("sw-01"), Some("10.0.0.1/24"))],
                    )
                }
            })
        })
        .await;

        let client = NetBoxClient::new(&base, "nbt_v2.token", false).unwrap();
        let result = client.fetch_devices(&NetBoxFilters::default()).await.unwrap();
        assert_eq!(result.devices.len(), 2);
        assert_eq!(result.no_primary_ip, 0);
        assert_eq!(result.devices[0].address, "10.0.0.1");
        assert_eq!(result.devices[1].address, "10.0.0.2");
        server.abort();
    }

    #[tokio::test]
    async fn test_fetch_devices_no_primary_ip_counted() {
        let (base, server) = start_mock(|_| {
            Arc::new(|_, _, _| {
                page(
                    None,
                    vec![
                        device_json(1, Some("has-ip"), Some("10.0.0.1/24")),
                        device_json(2, Some("no-ip"), None),
                        device_json(3, Some("no-ip-either"), None),
                    ],
                )
            })
        })
        .await;

        let client = NetBoxClient::new(&base, "t", false).unwrap();
        let result = client.fetch_devices(&NetBoxFilters::default()).await.unwrap();
        assert_eq!(result.devices.len(), 1);
        assert_eq!(result.no_primary_ip, 2);
        server.abort();
    }

    #[tokio::test]
    async fn test_auth_header_forms_v2_bearer_v1_token() {
        let seen = Arc::new(Mutex::new(Vec::<String>::new()));
        let (base, server) = start_mock({
            let seen = seen.clone();
            move |_| {
                let seen = seen.clone();
                Arc::new(move |_, _, auth| {
                    seen.lock().unwrap().push(auth.to_string());
                    page(None, vec![])
                })
            }
        })
        .await;

        NetBoxClient::new(&base, "nbt_abc.def", false)
            .unwrap()
            .fetch_devices(&NetBoxFilters::default())
            .await
            .unwrap();
        NetBoxClient::new(&base, "legacy-plaintext", false)
            .unwrap()
            .fetch_devices(&NetBoxFilters::default())
            .await
            .unwrap();

        let seen = seen.lock().unwrap();
        assert_eq!(seen[0], "Bearer nbt_abc.def");
        assert_eq!(seen[1], "Token legacy-plaintext");
        server.abort();
    }

    #[tokio::test]
    async fn test_fetch_devices_error_mapping() {
        // 401
        let (base, server) = start_mock(|_| {
            Arc::new(|_, _, _| (401, r#"{"detail":"Invalid token"}"#.into(), vec![]))
        })
        .await;
        let client = NetBoxClient::new(&base, "bad", false).unwrap();
        let err = client.fetch_devices(&NetBoxFilters::default()).await.unwrap_err();
        assert!(err.contains("Invalid or expired"), "{}", err);
        server.abort();

        // 403
        let (base, server) = start_mock(|_| {
            Arc::new(|_, _, _| (403, r#"{"detail":"Forbidden"}"#.into(), vec![]))
        })
        .await;
        let client = NetBoxClient::new(&base, "t", false).unwrap();
        let err = client.fetch_devices(&NetBoxFilters::default()).await.unwrap_err();
        assert!(err.contains("lacks permission"), "{}", err);
        server.abort();

        // 429 with Retry-After
        let (base, server) = start_mock(|_| {
            Arc::new(|_, _, _| {
                (
                    429,
                    r#"{"detail":"Throttled"}"#.into(),
                    vec![("Retry-After".into(), "42".into())],
                )
            })
        })
        .await;
        let client = NetBoxClient::new(&base, "t", false).unwrap();
        let err = client.fetch_devices(&NetBoxFilters::default()).await.unwrap_err();
        assert!(err.contains("42"), "{}", err);
        server.abort();

        // 500
        let (base, server) = start_mock(|_| {
            Arc::new(|_, _, _| (500, "boom".into(), vec![]))
        })
        .await;
        let client = NetBoxClient::new(&base, "t", false).unwrap();
        let err = client.fetch_devices(&NetBoxFilters::default()).await.unwrap_err();
        assert!(err.contains("server error"), "{}", err);
        server.abort();
    }

    #[tokio::test]
    async fn test_connection_reads_api_version_and_count() {
        let (base, server) = start_mock(|_| {
            Arc::new(|_, path, _| {
                assert!(path.starts_with("/api/dcim/devices/"), "path: {}", path);
                assert!(path.contains("limit=1"), "path: {}", path);
                (
                    200,
                    r#"{"count": 421, "next": null, "previous": null, "results": []}"#.into(),
                    vec![("API-Version".into(), "4.1".into())],
                )
            })
        })
        .await;

        let client = NetBoxClient::new(&base, "nbt_x.y", false).unwrap();
        let (version, count) = client.test_connection().await.unwrap();
        assert_eq!(version, "4.1");
        assert_eq!(count, 421);
        server.abort();
    }

    #[tokio::test]
    async fn test_fetch_geo_parses_hierarchy_links() {
        let (base, server) = start_mock(|_| {
            Arc::new(|_, path, _| {
                let body = if path.starts_with("/api/dcim/regions/") {
                    r#"{"count": 2, "next": null, "results": [
                        {"id": 1, "name": "EMEA", "slug": "emea", "parent": null, "site": null, "region": null},
                        {"id": 2, "name": "United Kingdom", "slug": "uk", "parent": {"id": 1, "name": "EMEA", "slug": "emea"}, "site": null, "region": null}
                    ]}"#
                } else if path.starts_with("/api/dcim/sites/") {
                    r#"{"count": 1, "next": null, "results": [
                        {"id": 7, "name": "DC1 London", "slug": "dc1", "parent": null, "site": null, "region": {"id": 2, "name": "United Kingdom", "slug": "uk"}}
                    ]}"#
                } else if path.starts_with("/api/dcim/locations/") {
                    r#"{"count": 2, "next": null, "results": [
                        {"id": 11, "name": "Floor 1", "slug": "floor-1", "parent": null, "site": {"id": 7, "name": "DC1 London", "slug": "dc1"}, "region": null},
                        {"id": 12, "name": "Room A", "slug": "room-a", "parent": {"id": 11, "name": "Floor 1", "slug": "floor-1"}, "site": {"id": 7, "name": "DC1 London", "slug": "dc1"}, "region": null}
                    ]}"#
                } else {
                    r#"{"count": 0, "next": null, "results": []}"#
                };
                (200, body.into(), vec![])
            })
        })
        .await;

        let client = NetBoxClient::new(&base, "t", false).unwrap();
        let geo = client.fetch_geo().await;
        assert_eq!(geo.regions.len(), 2);
        assert_eq!(geo.sites.len(), 1);
        assert_eq!(geo.locations.len(), 2);
        assert_eq!(geo.regions[0].parent_slug, None);
        assert_eq!(geo.regions[1].parent_slug.as_deref(), Some("emea"));
        assert_eq!(geo.sites[0].region_slug.as_deref(), Some("uk"));
        assert_eq!(geo.locations[1].parent_slug.as_deref(), Some("floor-1"));
        assert_eq!(geo.locations[1].site_slug.as_deref(), Some("dc1"));
        server.abort();
    }

    #[test]
    fn test_client_rejects_bad_scheme() {
        assert!(NetBoxClient::new("ftp://netbox", "t", false).is_err());
        assert!(NetBoxClient::new("netbox.example.com", "t", false).is_err());
        assert!(NetBoxClient::new("  ", "t", false).is_err());
        assert!(NetBoxClient::new("https://netbox.example.com/", "t", false).is_ok());
        assert!(NetBoxClient::new("http://192.168.1.10:8000", "t", false).is_ok());
    }

    #[tokio::test]
    async fn test_netbox_client_issues_get_requests_only() {
        // AGENTS.md: the NetBox integration is strictly read-only. The
        // recorder sees the true request line of every request every
        // client method makes — including any the mock would reject —
        // and each one must be a GET to an expected endpoint. (The
        // mock 405s non-GETs anyway; this names the offender.)
        let seen = Arc::new(Mutex::new(Vec::<String>::new()));
        let (base, server) = start_mock({
            let seen = seen.clone();
            move |_| {
                let seen = seen.clone();
                Arc::new(move |method, path, _| {
                    seen.lock().unwrap().push(format!("{} {}", method, path));
                    (
                        200,
                        r#"{"count": 0, "next": null, "previous": null, "results": []}"#
                            .into(),
                        vec![],
                    )
                })
            }
        })
        .await;

        let client = NetBoxClient::new(&base, "nbt_v2.ro", false).unwrap();
        client.test_connection().await.unwrap();
        client.fetch_devices(&NetBoxFilters::default()).await.unwrap();
        client.fetch_geo().await;
        client.fetch_sites().await.unwrap();
        client.fetch_device_roles().await.unwrap();
        client.fetch_tags().await.unwrap();

        let seen = seen.lock().unwrap();
        // Exactly the eight requests the calls above issue: one
        // connection check, one device page, three geography reads,
        // three choice reads. Pinning the full set catches a silent
        // drop — fetch_geo degrades an erroring read to an empty
        // table, so without this a rejected geography request would
        // vanish instead of failing the test.
        let expected = [
            "/api/dcim/devices/",      // test_connection
            "/api/dcim/devices/",      // fetch_devices, first page
            "/api/dcim/regions/",      // fetch_geo
            "/api/dcim/sites/",        // fetch_geo
            "/api/dcim/locations/",    // fetch_geo
            "/api/dcim/sites/",        // fetch_sites choices
            "/api/dcim/device-roles/", // fetch_device_roles choices
            "/api/extras/tags/",       // fetch_tags choices
        ];
        assert_eq!(
            seen.len(),
            expected.len(),
            "expected exactly {} requests, saw: {:?}",
            expected.len(),
            seen
        );
        for (request, endpoint) in seen.iter().zip(expected) {
            let (method, path) = request
                .split_once(' ')
                .expect("recorded entries are 'METHOD path'");
            assert_eq!(
                method, "GET",
                "NetBox integration is read-only — unexpected request: {}",
                request
            );
            let path = path.split('?').next().unwrap_or_default();
            assert_eq!(
                path, endpoint,
                "unexpected endpoint in request: {}",
                request
            );
        }
        server.abort();
    }

    #[test]
    fn test_netbox_source_has_no_write_http_methods() {
        // AGENTS.md: the NetBox integration is strictly read-only. All HTTP
        // goes through the GET-only `readonly_http` guard; this tripwire
        // fails CI if anyone reintroduces a write-verb builder call (or
        // the generic request-builder escape hatch) anywhere in netbox.rs.
        // Banned patterns are assembled at runtime so this test's own
        // source never matches itself.
        let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/netbox.rs"))
            .expect("netbox.rs must be readable for the read-only tripwire");
        for verb in ["post", "put", "patch", "delete", "request"] {
            let builder_call = format!(".{}(", verb);
            assert!(
                !src.contains(&builder_call),
                "netbox.rs contains '{}' — the NetBox integration is read-only (AGENTS.md); \
                 route reads through readonly_http::ReadOnlyHttp",
                builder_call
            );
            let method_const = format!("::{}", verb.to_uppercase());
            assert!(
                !src.contains(&method_const),
                "netbox.rs contains '{}' — the NetBox integration is read-only (AGENTS.md)",
                method_const
            );
        }
    }

    // ─── Cache store (plan §7.3) ───────────────────────────────────

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("comnd_netbox_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sample_entry(id: u64, enabled: bool) -> NetBoxDeviceEntry {
        NetBoxDeviceEntry {
            netbox_id: id,
            name: format!("dev-{}", id),
            address: format!("10.0.0.{}", id),
            platform: "cisco-iosxe".into(),
            site: Some("dc1".into()),
            location: Some("rack-1".into()),
            tags: vec!["prod".into()],
            status: "active".into(),
            enabled,
            overlay: DeviceOverlay::default(),
        }
    }

    // ─── Connect param resolution (plan §6) ────────────────────────

    fn cfg_with(username: Option<&str>, port: u16, cred: Option<CredentialSource>) -> NetBoxConfig {
        NetBoxConfig {
            default_username: username.map(str::to_string),
            default_port: port,
            default_credential: cred,
            ..Default::default()
        }
    }

    #[test]
    fn test_resolve_overlay_wins_over_defaults() {
        let mut d = sample_entry(5, true);
        d.overlay.username = Some("overlay-user".into());
        d.overlay.port = Some(2200);
        d.overlay.credential = Some(CredentialSource::SshKey { key_path: "/k".into() });
        let cfg = cfg_with(Some("default-user"), 2222, Some(CredentialSource::Password));

        let p = resolve_connect_params(&d, &cfg).unwrap();
        assert_eq!(p.username, "overlay-user");
        assert_eq!(p.port, 2200);
        assert_eq!(p.credential, Some(CredentialSource::SshKey { key_path: "/k".into() }));
        // Overlay pins its own credential → per-device secret key.
        assert_eq!(p.secret_key, crate::credentials::host_key(&host_id(5)));
    }

    #[test]
    fn test_resolve_falls_back_to_defaults() {
        let d = sample_entry(7, true); // empty overlay
        let cfg = cfg_with(Some("default-user"), 2222, Some(CredentialSource::Password));

        let p = resolve_connect_params(&d, &cfg).unwrap();
        assert_eq!(p.username, "default-user");
        assert_eq!(p.port, 2222);
        assert_eq!(p.credential, Some(CredentialSource::Password));
        // No overlay credential → shared source-default secret key.
        assert_eq!(p.secret_key, DEFAULT_PW_KEY.to_string());
    }

    #[test]
    fn test_resolve_empty_string_username_is_absent() {
        let mut d = sample_entry(9, true);
        d.overlay.username = Some("   ".into()); // blank → treated as absent
        let cfg = cfg_with(Some("default-user"), 22, Some(CredentialSource::Password));

        let p = resolve_connect_params(&d, &cfg).unwrap();
        assert_eq!(p.username, "default-user");
    }

    #[test]
    fn test_resolve_no_username_errors() {
        let d = sample_entry(1, true);
        let cfg = cfg_with(None, 22, Some(CredentialSource::Password));
        assert!(resolve_connect_params(&d, &cfg).is_err());
    }

    #[test]
    fn test_resolve_no_credential_errors() {
        let d = sample_entry(1, true);
        let cfg = cfg_with(Some("admin"), 22, None);
        assert!(resolve_connect_params(&d, &cfg).is_err());
    }

    #[test]
    fn test_cache_roundtrip() {
        let dir = temp_dir();
        let mut store = NetBoxCacheStore::new(&dir).unwrap();
        store
            .apply_sync(
                SyncReport {
                    fetched: 1,
                    ..Default::default()
                },
                vec![sample_entry(1, true)],
                NetBoxGeo::default(),
            )
            .unwrap();
        assert!(store.get().last_synced.is_some());

        let fresh = NetBoxCacheStore::new(&dir).unwrap();
        assert_eq!(fresh.get().devices.len(), 1);
        assert_eq!(fresh.get().devices[0].name, "dev-1");
        assert_eq!(fresh.get().sync_report.as_ref().unwrap().fetched, 1);
        assert_eq!(fresh.get().version, 2);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_cache_preserves_corrupt_file() {
        let dir = temp_dir();
        let path = dir.join("netbox-cache.json");
        std::fs::write(&path, "{not valid json").unwrap();

        let store = NetBoxCacheStore::new(&dir).unwrap();
        assert!(store.get().devices.is_empty());
        assert!(!path.exists(), "corrupt cache should be renamed away");
        let preserved = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("netbox-cache.json.corrupt-")
            });
        assert!(preserved, "expected a .corrupt-<ts> backup file");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_apply_sync_preserves_enabled_and_overlay() {
        let dir = temp_dir();
        let mut store = NetBoxCacheStore::new(&dir).unwrap();
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
        let mut store = NetBoxCacheStore::new(&dir).unwrap();
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
        let fresh = NetBoxCacheStore::new(&dir).unwrap();
        assert!(!fresh.find_by_host_id("netbox:7").unwrap().enabled);
        assert!(fresh.find_by_host_id("netbox:7").unwrap().overlay.last_connected.is_some());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_host_id_format() {
        assert_eq!(host_id(123), "netbox:123");
    }

    // ─── Config, materialization, synthetic groups (plan §8) ───────

    #[test]
    fn test_netbox_config_json_roundtrip_and_defaults() {
        // Absent config → defaults
        let cfg = NetBoxConfig::from_json(None);
        assert!(!cfg.enabled);
        assert!(!cfg.show_empty_folders);
        assert_eq!(cfg.default_port, 22);
        assert_eq!(cfg.platform_policy, "skip");

        let legacy = serde_json::json!({"enabled": true, "base_url": "https://netbox.example.com"});
        let cfg = NetBoxConfig::from_json(Some(&legacy));
        assert!(cfg.enabled);
        assert!(!cfg.show_empty_folders);

        // Malformed JSON → defaults (never break reads)
        let bad = serde_json::json!({"enabled": "yes please", "default_port": "abc"});
        let cfg = NetBoxConfig::from_json(Some(&bad));
        assert!(!cfg.enabled);
        assert_eq!(cfg.default_port, 22);

        // Full roundtrip
        let cfg = NetBoxConfig {
            enabled: true,
            show_empty_folders: true,
            base_url: "https://netbox.example.com/".into(),
            filters: NetBoxFilters {
                status: Some("active".into()),
                sites: vec!["dc1".into()],
                roles: vec![],
                tags: vec!["prod".into()],
            },
            platform_policy: "fallback".into(),
            platform_fallback: Some("linux-bash".into()),
            platform_overrides: {
                let mut m = HashMap::new();
                m.insert("foo-os".to_string(), "f5-tmos".to_string());
                m
            },
            default_username: Some("admin".into()),
            default_port: 2222,
            default_credential: Some(CredentialSource::Password),
            allow_invalid_certs: true,
        };
        let json = serde_json::to_value(&cfg).unwrap();
        let parsed = NetBoxConfig::from_json(Some(&json));
        assert_eq!(parsed, cfg);
        assert!(parsed.validate(&PlatformRegistry::builtin()).is_ok());
    }

    #[test]
    fn test_netbox_config_validation() {
        let mut cfg = NetBoxConfig::default();
        assert!(cfg.validate(&PlatformRegistry::builtin()).is_ok());

        cfg.base_url = "ftp://bad".into();
        assert!(cfg.validate(&PlatformRegistry::builtin()).is_err());
        cfg.base_url = "http://192.168.1.10:8000".into();
        assert!(cfg.validate(&PlatformRegistry::builtin()).is_ok());

        cfg.default_port = 0;
        assert!(cfg.validate(&PlatformRegistry::builtin()).is_err());
        cfg.default_port = 22;

        cfg.platform_policy = "fallback".into();
        assert!(cfg.validate(&PlatformRegistry::builtin()).is_err(), "fallback without a platform");
        cfg.platform_fallback = Some("juniper-junos".into());
        assert!(cfg.validate(&PlatformRegistry::builtin()).is_err(), "invalid fallback platform");
        cfg.platform_fallback = Some("linux-bash".into());
        assert!(cfg.validate(&PlatformRegistry::builtin()).is_ok());

        cfg.platform_policy = "bogus".into();
        assert!(cfg.validate(&PlatformRegistry::builtin()).is_err());

        cfg.platform_policy = "skip".into();
        cfg.platform_overrides.insert("x".into(), "not-a-platform".into());
        assert!(cfg.validate(&PlatformRegistry::builtin()).is_err());
        cfg.platform_overrides.insert("x".into(), "cisco-nxos".into());
        assert!(cfg.validate(&PlatformRegistry::builtin()).is_ok());
    }

    #[test]
    fn test_override_to_custom_platform_validates_when_in_registry() {
        let dir = std::env::temp_dir().join(format!("comnd_netbox_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("my-custom")).unwrap();
        std::fs::write(dir.join("my-custom/index.yaml"), "platform: my-custom\n").unwrap();
        let platforms = PlatformRegistry::scan(&dir, None::<&std::path::Path>);

        let mut cfg = NetBoxConfig::default();
        cfg.platform_overrides.insert("foo-os".into(), "my-custom".into());
        assert!(cfg.validate(&platforms).is_ok());
        // Fails against a registry that lacks the custom platform
        assert!(cfg.validate(&PlatformRegistry::builtin()).is_err());
    }

    #[test]
    fn test_platform_policy_from_config() {
        let mut cfg = NetBoxConfig {
            platform_policy: "fallback".into(),
            platform_fallback: Some("linux-bash".into()),
            ..Default::default()
        };
        // Invalid fallback/override values are dropped, not fatal
        cfg.platform_overrides.insert("foo".into(), "bogus".into());
        let policy = cfg.platform_policy(&PlatformRegistry::builtin());
        assert_eq!(policy.resolve(Some("anything")), Some("linux-bash".into()));
        assert_eq!(policy.resolve(Some("nxos")), Some("cisco-nxos".into()));
        assert!(policy.overrides.is_empty());

        // skip policy → no fallback even if a fallback platform is set
        let mut cfg = NetBoxConfig::default();
        cfg.platform_policy = "skip".into();
        cfg.platform_fallback = Some("linux-bash".into());
        assert_eq!(cfg.platform_policy(&PlatformRegistry::builtin()).resolve(Some("foo")), None);
    }

    #[test]
    fn test_host_id_and_group_id_guards() {
        assert!(is_netbox_host_id("netbox:123"));
        assert!(!is_netbox_host_id("netbox:"));
        assert!(!is_netbox_host_id("netbox:abc"));
        assert!(!is_netbox_host_id("some-uuid"));
        assert!(is_synthetic_group_id("__netbox__"));
        assert!(is_synthetic_group_id("__netbox__:region:emea"));
        assert!(is_synthetic_group_id("__netbox__:site:dc1"));
        assert!(is_synthetic_group_id("__netbox__:loc:rack-1"));
        assert!(!is_synthetic_group_id("user-group"));
        // The guard prefix must not collide with user uuids
        assert!(!is_synthetic_group_id("550e8400-e29b-41d4"));
    }

    #[test]
    fn test_materialize_host_overlays() {
        let cfg = NetBoxConfig {
            default_username: Some("netadmin".into()),
            default_port: 2222,
            default_credential: Some(CredentialSource::SshKey { key_path: "/keys/default".into() }),
            ..Default::default()
        };
        let mut device = sample_entry(5, true);
        device.site = Some("dc1".into());
        device.location = Some("rack-1".into());

        // No overlay → source defaults
        let h = materialize_host(&device, &cfg);
        assert_eq!(h.id, "netbox:5");
        assert_eq!(h.username, "netadmin");
        assert_eq!(h.port, 2222);
        assert_eq!(
            h.credential,
            Some(CredentialSource::SshKey { key_path: "/keys/default".into() })
        );
        assert_eq!(h.group_id.as_deref(), Some("__netbox__:loc:rack-1"));
        assert_eq!(h.source.as_deref(), Some("netbox"));
        assert_eq!(h.platform, "cisco-iosxe");
        assert_eq!(h.display_name, "dev-5");

        // Overlay wins over source defaults; blank username falls back
        device.overlay = DeviceOverlay {
            username: Some("  ".into()),
            port: Some(2022),
            credential: Some(CredentialSource::Agent { identity: None }),
            last_connected: Some("2026-08-27T10:00:00Z".into()),
            notes: Some("core".into()),
        };
        let h = materialize_host(&device, &cfg);
        assert_eq!(h.username, "netadmin");
        assert_eq!(h.port, 2022);
        assert_eq!(h.credential, Some(CredentialSource::Agent { identity: None }));
        assert_eq!(h.notes.as_deref(), Some("core"));

        // No default username anywhere → empty string (device still listed).
        // The overlay port still wins over the source default.
        let bare = NetBoxConfig::default();
        let h = materialize_host(&device, &bare);
        assert_eq!(h.username, "");
        assert_eq!(h.port, 2022);

        // Bare config + bare overlay → pure defaults
        device.overlay = DeviceOverlay::default();
        let h = materialize_host(&device, &bare);
        assert_eq!(h.username, "");
        assert_eq!(h.port, 22);

        // Group placement: no location → site group; no site → root
        device.location = None;
        assert_eq!(
            materialize_host(&device, &cfg).group_id.as_deref(),
            Some("__netbox__:site:dc1")
        );
        device.site = None;
        assert_eq!(materialize_host(&device, &cfg).group_id.as_deref(), Some("__netbox__"));
    }

    #[test]
    fn test_synthetic_groups_only_enabled_devices() {
        let mut d1 = sample_entry(1, true);
        d1.site = Some("dc1".into());
        d1.location = Some("rack-1".into());
        let mut d2 = sample_entry(2, true);
        d2.site = Some("dc1".into());
        d2.location = None;
        let mut d3 = sample_entry(3, false); // disabled — excluded
        d3.site = Some("dc9".into());
        let mut d4 = sample_entry(4, true); // no site → root only
        d4.site = None;
        d4.location = None;

        let groups = synthetic_groups(&[d1, d2, d3.clone(), d4], &NetBoxGeo::default(), false);
        let ids: Vec<&str> = groups.iter().map(|g| g.id.as_str()).collect();
        assert_eq!(ids, vec!["__netbox__", "__netbox__:site:dc1", "__netbox__:loc:rack-1"]);
        // Location falls back to its site parent when no geo tables (pre-v2
        // cache): flat site → location, slug-named.
        assert_eq!(groups[1].name, "dc1");
        assert_eq!(groups[2].parent_id.as_deref(), Some("__netbox__:site:dc1"));

        let root = &groups[0];
        assert_eq!(root.name, "NetBox");
        assert_eq!(root.parent_id, None);
        assert_eq!(root.icon.as_deref(), Some("netbox"));
        assert_eq!(root.sort_order, u32::MAX);

        // Empty / all-disabled cache → no groups at all
        for show_empty in [false, true] {
            assert!(synthetic_groups(&[d3.clone()], &NetBoxGeo::default(), show_empty).is_empty());
            assert!(synthetic_groups(&[], &NetBoxGeo::default(), show_empty).is_empty());
        }
    }

    #[test]
    fn test_synthetic_groups_full_hierarchy() {
        // Geography: region EMEA > region UK > site DC1 > loc floor-1 > loc room-a
        let geo = NetBoxGeo {
            regions: vec![
                NetBoxGeoNode { slug: "emea".into(), name: "EMEA".into(), parent_slug: None, site_slug: None, region_slug: None },
                NetBoxGeoNode { slug: "uk".into(), name: "United Kingdom".into(), parent_slug: Some("emea".into()), site_slug: None, region_slug: None },
            ],
            sites: vec![
                NetBoxGeoNode { slug: "dc1".into(), name: "DC1 London".into(), parent_slug: None, site_slug: None, region_slug: Some("uk".into()) },
                NetBoxGeoNode { slug: "dc2".into(), name: "DC2 Paris".into(), parent_slug: None, site_slug: None, region_slug: Some("emea".into()) },
            ],
            locations: vec![
                NetBoxGeoNode { slug: "floor-1".into(), name: "Floor 1".into(), parent_slug: None, site_slug: Some("dc1".into()), region_slug: None },
                NetBoxGeoNode { slug: "room-a".into(), name: "Room A".into(), parent_slug: Some("floor-1".into()), site_slug: Some("dc1".into()), region_slug: None },
            ],
        };
        let mut d1 = sample_entry(1, true); // deepest chain: region>region>site>loc>loc
        d1.site = Some("dc1".into());
        d1.location = Some("room-a".into());
        let mut d2 = sample_entry(2, true); // sibling device in same room → no new groups
        d2.site = Some("dc1".into());
        d2.location = Some("room-a".into());
        let mut d3 = sample_entry(3, true); // site without region, no location
        d3.site = Some("dc2".into());
        d3.location = None;

        let groups = synthetic_groups(&[d1, d2, d3], &geo, false);
        let by_id: HashMap<&str, &crate::hosts::HostGroup> =
            groups.iter().map(|g| (g.id.as_str(), g)).collect();

        // Full chain emitted with real names and correct parents
        assert_eq!(by_id["__netbox__:region:emea"].name, "EMEA");
        assert_eq!(by_id["__netbox__:region:emea"].parent_id.as_deref(), Some("__netbox__"));
        assert_eq!(by_id["__netbox__:region:uk"].name, "United Kingdom");
        assert_eq!(by_id["__netbox__:region:uk"].parent_id.as_deref(), Some("__netbox__:region:emea"));
        assert_eq!(by_id["__netbox__:site:dc1"].name, "DC1 London");
        assert_eq!(by_id["__netbox__:site:dc1"].parent_id.as_deref(), Some("__netbox__:region:uk"));
        assert_eq!(by_id["__netbox__:loc:floor-1"].name, "Floor 1");
        assert_eq!(by_id["__netbox__:loc:floor-1"].parent_id.as_deref(), Some("__netbox__:site:dc1"));
        assert_eq!(by_id["__netbox__:loc:room-a"].name, "Room A");
        assert_eq!(by_id["__netbox__:loc:room-a"].parent_id.as_deref(), Some("__netbox__:loc:floor-1"));

        // An enabled device directly under a site keeps that branch visible.
        assert_eq!(by_id["__netbox__:site:dc2"].parent_id.as_deref(), Some("__netbox__:region:emea"));
        assert_eq!(groups.len(), 7); // root + 2 regions + 2 sites + 2 locations
    }

    #[test]
    fn test_synthetic_groups_site_without_region_and_nested_locations() {
        // NetBox semantics: a site needs no region; a location needs a site
        // and may nest under a parent location. Site attaches directly to
        // the NetBox root; the location chain nests under its site.
        let geo = NetBoxGeo {
            sites: vec![NetBoxGeoNode {
                slug: "living-room".into(),
                name: "Living Room".into(),
                parent_slug: None,
                site_slug: None,
                region_slug: None,
            }],
            locations: vec![
                NetBoxGeoNode {
                    slug: "floor-1".into(),
                    name: "Floor 1".into(),
                    parent_slug: None,
                    site_slug: Some("living-room".into()),
                    region_slug: None,
                },
                NetBoxGeoNode {
                    slug: "room-a".into(),
                    name: "Room A".into(),
                    parent_slug: Some("floor-1".into()),
                    site_slug: Some("living-room".into()),
                    region_slug: None,
                },
            ],
            ..Default::default()
        };
        let mut d = sample_entry(1, true);
        d.site = Some("living-room".into());
        d.location = Some("room-a".into());

        let groups = synthetic_groups(&[d], &geo, false);
        let ids: Vec<&str> = groups.iter().map(|g| g.id.as_str()).collect();
        assert_eq!(
            ids,
            vec![
                "__netbox__",
                "__netbox__:site:living-room",
                "__netbox__:loc:floor-1",
                "__netbox__:loc:room-a",
            ]
        );
        // Site without region → direct child of the NetBox root
        assert_eq!(groups[1].parent_id.as_deref(), Some("__netbox__"));
        // Location chain: top-level loc under its site, child loc under parent
        assert_eq!(groups[2].parent_id.as_deref(), Some("__netbox__:site:living-room"));
        assert_eq!(groups[3].parent_id.as_deref(), Some("__netbox__:loc:floor-1"));
        assert_eq!(groups[1].name, "Living Room");
        assert_eq!(groups[3].name, "Room A");
    }

    #[test]
    fn test_synthetic_groups_unknown_slugs_flatten() {
        // Stale cache: device points at a location slug missing from the geo
        // tables → location attaches directly to its site, slug-named.
        let geo = NetBoxGeo {
            sites: vec![NetBoxGeoNode {
                slug: "dc1".into(), name: "DC1".into(), parent_slug: None,
                site_slug: None, region_slug: None,
            }],
            ..Default::default()
        };
        let mut d = sample_entry(1, true);
        d.site = Some("dc1".into());
        d.location = Some("ghost-loc".into());
        let groups = synthetic_groups(&[d], &geo, false);
        let ids: Vec<&str> = groups.iter().map(|g| g.id.as_str()).collect();
        assert_eq!(ids, vec!["__netbox__", "__netbox__:site:dc1", "__netbox__:loc:ghost-loc"]);
        assert_eq!(groups[2].name, "ghost-loc");
        assert_eq!(groups[2].parent_id.as_deref(), Some("__netbox__:site:dc1"));
    }

    #[test]
    fn test_synthetic_groups_full_geography_includes_empty_branches() {
        // Full-geography mode: a region > site > location chain with zero
        // devices still appears in the tree.
        let geo = NetBoxGeo {
            regions: vec![NetBoxGeoNode {
                slug: "region-1".into(), name: "Region 1".into(),
                parent_slug: None, site_slug: None, region_slug: None,
            }],
            sites: vec![NetBoxGeoNode {
                slug: "demo-site".into(), name: "Demo Site".into(),
                parent_slug: None, site_slug: None, region_slug: Some("region-1".into()),
            }],
            locations: vec![NetBoxGeoNode {
                slug: "demo-loc".into(), name: "Demo Location".into(),
                parent_slug: None, site_slug: Some("demo-site".into()), region_slug: None,
            }],
        };
        let mut d = sample_entry(1, true); // device lives elsewhere
        d.site = Some("study".into());
        d.location = None;

        let groups = synthetic_groups(&[d], &geo, true);
        let ids: Vec<&str> = groups.iter().map(|g| g.id.as_str()).collect();
        assert!(ids.contains(&"__netbox__:region:region-1"));
        assert!(ids.contains(&"__netbox__:site:demo-site"));
        assert!(ids.contains(&"__netbox__:loc:demo-loc"));
        // The device's own site also appears (fallback: not in sites table)
        assert!(ids.contains(&"__netbox__:site:study"));
        let by_id: HashMap<&str, &crate::hosts::HostGroup> =
            groups.iter().map(|g| (g.id.as_str(), g)).collect();
        assert_eq!(by_id["__netbox__:site:demo-site"].parent_id.as_deref(), Some("__netbox__:region:region-1"));
        assert_eq!(by_id["__netbox__:loc:demo-loc"].parent_id.as_deref(), Some("__netbox__:site:demo-site"));
    }

    #[test]
    fn test_synthetic_groups_prunes_empty_and_disabled_only_subtrees() {
        let geo = NetBoxGeo {
            regions: vec![
                NetBoxGeoNode { slug: "world".into(), name: "World".into(), parent_slug: None, site_slug: None, region_slug: None },
                NetBoxGeoNode { slug: "active".into(), name: "Active".into(), parent_slug: Some("world".into()), site_slug: None, region_slug: None },
                NetBoxGeoNode { slug: "empty".into(), name: "Empty".into(), parent_slug: Some("world".into()), site_slug: None, region_slug: None },
            ],
            sites: vec![
                NetBoxGeoNode { slug: "dc1".into(), name: "DC1".into(), parent_slug: None, site_slug: None, region_slug: Some("active".into()) },
                NetBoxGeoNode { slug: "dc2".into(), name: "DC2".into(), parent_slug: None, site_slug: None, region_slug: Some("empty".into()) },
                NetBoxGeoNode { slug: "dc3".into(), name: "DC3".into(), parent_slug: None, site_slug: None, region_slug: Some("active".into()) },
            ],
            locations: vec![
                NetBoxGeoNode { slug: "floor".into(), name: "Floor".into(), parent_slug: None, site_slug: Some("dc1".into()), region_slug: None },
                NetBoxGeoNode { slug: "room".into(), name: "Room".into(), parent_slug: Some("floor".into()), site_slug: Some("dc1".into()), region_slug: None },
                NetBoxGeoNode { slug: "unused".into(), name: "Unused".into(), parent_slug: Some("floor".into()), site_slug: Some("dc1".into()), region_slug: None },
                NetBoxGeoNode { slug: "disabled".into(), name: "Disabled".into(), parent_slug: None, site_slug: Some("dc2".into()), region_slug: None },
            ],
        };
        let mut enabled = sample_entry(1, true);
        enabled.site = Some("dc1".into());
        enabled.location = Some("room".into());
        let mut disabled = sample_entry(2, false);
        disabled.site = Some("dc2".into());
        disabled.location = Some("disabled".into());
        let devices = [enabled, disabled];

        let groups = synthetic_groups(&devices, &geo, false);
        let ids: Vec<&str> = groups.iter().map(|g| g.id.as_str()).collect();
        assert_eq!(ids, vec![
            "__netbox__", "__netbox__:region:world", "__netbox__:region:active",
            "__netbox__:site:dc1", "__netbox__:loc:floor", "__netbox__:loc:room",
        ]);
        assert_eq!(synthetic_groups(&devices, &geo, true).len(), 11);
        assert!(synthetic_groups(&[], &geo, true).is_empty());

        let mut root_device = sample_entry(3, true);
        root_device.site = None;
        root_device.location = None;
        assert_eq!(synthetic_groups(&[root_device], &geo, false).len(), 1);
    }

    #[test]
    fn test_synthetic_groups_parent_cycle_flattens() {
        // Corrupt geo data: a→b→a cycle. The chain guard flattens each node
        // to stand alone rather than loop forever.
        let geo = NetBoxGeo {
            locations: vec![
                NetBoxGeoNode { slug: "a".into(), name: "A".into(), parent_slug: Some("b".into()), site_slug: Some("dc1".into()), region_slug: None },
                NetBoxGeoNode { slug: "b".into(), name: "B".into(), parent_slug: Some("a".into()), site_slug: Some("dc1".into()), region_slug: None },
            ],
            sites: vec![NetBoxGeoNode { slug: "dc1".into(), name: "DC1".into(), parent_slug: None, site_slug: None, region_slug: None }],
            ..Default::default()
        };
        let mut d = sample_entry(1, true);
        d.site = Some("dc1".into());
        d.location = Some("a".into());
        let groups = synthetic_groups(&[d.clone()], &geo, true);
        // Cycle guard: "a" and "b" each flatten to attach under the site
        // instead of nesting into each other.
        let by_id: HashMap<&str, &crate::hosts::HostGroup> =
            groups.iter().map(|g| (g.id.as_str(), g)).collect();
        assert_eq!(by_id["__netbox__:loc:a"].parent_id.as_deref(), Some("__netbox__:site:dc1"));
        assert_eq!(by_id["__netbox__:loc:b"].parent_id.as_deref(), Some("__netbox__:site:dc1"));
        let pruned = synthetic_groups(&[d], &geo, false);
        let ids: Vec<&str> = pruned.iter().map(|g| g.id.as_str()).collect();
        assert_eq!(ids, vec!["__netbox__", "__netbox__:site:dc1", "__netbox__:loc:a"]);
    }
}
