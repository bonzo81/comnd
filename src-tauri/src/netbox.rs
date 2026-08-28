//! NetBox host source — REST client, device parsing, platform mapping,
//! and the local device cache (Phase 1 of docs/plan-netbox-host-source.md).
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

use crate::credentials::CredentialSource;

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

/// NetBox platform slug → net.sh platform. Materialized hosts must carry
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
    /// Resolve a NetBox platform slug to a net.sh platform, or `None` to
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

const CACHE_VERSION: u32 = 1;

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
    /// are gone locally (overlay dropped with them).
    pub fn apply_sync(
        &mut self,
        report: SyncReport,
        devices: Vec<NetBoxDeviceEntry>,
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
    match std::fs::read_to_string(path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_else(|e| {
            log::error!("Failed to parse netbox-cache.json: {}. Preserving as .corrupt.", e);
            crate::paths::preserve_corrupt(path);
            NetBoxCache::default()
        }),
        Err(_) => NetBoxCache::default(),
    }
}

// ─── Source config + materialization (plan §8) ──────────────────────

/// Keyring keys (plan §8.1/§11 — secrets never live in config.json).
pub const TOKEN_KEY: &str = "netsh_source_netbox_token";
pub const DEFAULT_PW_KEY: &str = "netsh_source_netbox_default_pw";

/// Synthetic group ids (plan §8.3): root, site, location.
pub const ROOT_GROUP_ID: &str = "__netbox__";

/// Non-secret NetBox source config, stored as JSON under
/// `host_sources["netbox"]`. The API token and source-default password live
/// in the OS keyring, never here.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NetBoxConfig {
    #[serde(default)]
    pub enabled: bool,
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
    pub fn platform_policy(&self) -> PlatformPolicy {
        PlatformPolicy {
            fallback: if self.platform_policy == "fallback" {
                self.platform_fallback
                    .clone()
                    .filter(|p| crate::hosts::is_valid_platform(p))
            } else {
                None
            },
            overrides: self
                .platform_overrides
                .iter()
                .filter(|(_, p)| crate::hosts::is_valid_platform(p))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
        }
    }

    /// Validate user-editable fields before persisting.
    pub fn validate(&self) -> Result<(), String> {
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
                if !crate::hosts::is_valid_platform(fallback) {
                    return Err(format!(
                        "Fallback platform '{}' is not valid (must be one of: cisco-iosxe, cisco-nxos, f5-tmos, linux-bash)",
                        fallback
                    ));
                }
            }
            other => return Err(format!("Unknown platform policy '{}' (must be skip or fallback)", other)),
        }
        for (slug, platform) in &self.platform_overrides {
            if !crate::hosts::is_valid_platform(platform) {
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

/// Effective group id for a device: location group → site group → root.
fn group_id_for(device: &NetBoxDeviceEntry) -> String {
    match (&device.site, &device.location) {
        (Some(site), Some(loc)) => format!("{}:site:{}:loc:{}", ROOT_GROUP_ID, site, loc),
        (Some(site), None) => format!("{}:site:{}", ROOT_GROUP_ID, site),
        (None, _) => ROOT_GROUP_ID.to_string(),
    }
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

/// Synthetic host groups for the nav tree (plan §8.3): NetBox root →
/// site → location. Only groups holding at least one enabled device are
/// emitted; the root sorts after every user group.
pub fn synthetic_groups(devices: &[NetBoxDeviceEntry]) -> Vec<crate::hosts::HostGroup> {
    let enabled: Vec<&NetBoxDeviceEntry> = devices.iter().filter(|d| d.enabled).collect();
    if enabled.is_empty() {
        return Vec::new();
    }

    let mut groups = vec![crate::hosts::HostGroup {
        id: ROOT_GROUP_ID.to_string(),
        name: "NetBox".to_string(),
        parent_id: None,
        sort_order: u32::MAX,
        color: None,
        icon: Some("netbox".to_string()),
        created_at: String::new(),
    }];

    let mut sites: Vec<&str> = Vec::new();
    let mut locations: Vec<(&str, &str)> = Vec::new();
    for d in &enabled {
        if let Some(site) = d.site.as_deref() {
            if !sites.contains(&site) {
                sites.push(site);
            }
            if let Some(loc) = d.location.as_deref() {
                let pair = (site, loc);
                if !locations.contains(&pair) {
                    locations.push(pair);
                }
            }
        }
    }

    for (i, site) in sites.iter().enumerate() {
        groups.push(crate::hosts::HostGroup {
            id: format!("{}:site:{}", ROOT_GROUP_ID, site),
            name: site.to_string(),
            parent_id: Some(ROOT_GROUP_ID.to_string()),
            sort_order: i as u32,
            color: None,
            icon: None,
            created_at: String::new(),
        });
    }
    for (i, (site, loc)) in locations.iter().enumerate() {
        groups.push(crate::hosts::HostGroup {
            id: format!("{}:site:{}:loc:{}", ROOT_GROUP_ID, site, loc),
            name: loc.to_string(),
            parent_id: Some(format!("{}:site:{}", ROOT_GROUP_ID, site)),
            sort_order: i as u32,
            color: None,
            icon: None,
            created_at: String::new(),
        });
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

pub struct NetBoxClient {
    base_url: String,
    token: String,
    http: reqwest::Client,
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
        let mut builder = reqwest::Client::builder().timeout(Duration::from_secs(30));
        if allow_invalid_certs {
            log::warn!(
                "NetBox client for {} built with TLS verification disabled — home-lab mode, token is MITM-able",
                trimmed
            );
            builder = builder.danger_accept_invalid_certs(true);
        }
        let http = builder
            .build()
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
        let url = format!(
            "{}/api/dcim/devices/?limit=1&exclude=config_context",
            self.base_url
        );
        log::info!("NetBox test_connection -> {}", url);
        let response = self
            .http
            .get(&url)
            .timeout(Duration::from_secs(5))
            .header("Authorization", self.auth_header())
            .send()
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

        let mut url = self
            .http
            .get(format!("{}/api/dcim/devices/", self.base_url))
            .query(&query)
            .build()
            .map_err(|e| format!("Failed to build request URL: {}", e))?
            .url()
            .clone();

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

    /// GET a URL with auth, map errors, parse the JSON body.
    async fn get_json(&self, url: &reqwest::Url) -> Result<serde_json::Value, String> {
        let response = self
            .http
            .get(url.clone())
            .header("Authorization", self.auth_header())
            .send()
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

    // ─── Mock HTTP server (plan §10) ───────────────────────────────

    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// Responder: (method, path-with-query, Authorization header) →
    /// (status, JSON body, extra headers like API-Version).
    type Responder = Arc<
        dyn Fn(&str, &str, &str) -> (u16, String, Vec<(String, String)>) + Send + Sync,
    >;

    /// Minimal one-shot-connection HTTP server on 127.0.0.1:0 for NetBox
    /// API tests. `make` receives the base URL so `next` links can point back.
    async fn start_mock<F>(make: F) -> (String, tokio::task::JoinHandle<()>)
    where
        F: FnOnce(String) -> Responder,
    {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let base = format!("http://{}", addr);
        let responder = make(base.clone());
        let handle = tokio::spawn(async move {
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
                    let path = request_line.split(' ').nth(1).unwrap_or("/").to_string();
                    let mut auth = String::new();
                    for line in lines {
                        let mut parts = line.splitn(2, ':');
                        let name = parts.next().unwrap_or_default().trim().to_ascii_lowercase();
                        let value = parts.next().unwrap_or_default().trim().to_string();
                        if name == "authorization" {
                            auth = value;
                        }
                    }
                    let (status, body, extra_headers) = responder("GET", &path, &auth);
                    let reason = match status {
                        200 => "OK",
                        401 => "Unauthorized",
                        403 => "Forbidden",
                        404 => "Not Found",
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
        });
        (base, handle)
    }

    fn page(next: Option<String>, results: Vec<serde_json::Value>) -> (u16, String, Vec<(String, String)>) {
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

    #[test]
    fn test_client_rejects_bad_scheme() {
        assert!(NetBoxClient::new("ftp://netbox", "t", false).is_err());
        assert!(NetBoxClient::new("netbox.example.com", "t", false).is_err());
        assert!(NetBoxClient::new("  ", "t", false).is_err());
        assert!(NetBoxClient::new("https://netbox.example.com/", "t", false).is_ok());
        assert!(NetBoxClient::new("http://192.168.1.10:8000", "t", false).is_ok());
    }

    // ─── Cache store (plan §7.3) ───────────────────────────────────

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("netsh_netbox_{}", uuid::Uuid::new_v4()));
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
            )
            .unwrap();
        assert!(store.get().last_synced.is_some());

        let fresh = NetBoxCacheStore::new(&dir).unwrap();
        assert_eq!(fresh.get().devices.len(), 1);
        assert_eq!(fresh.get().devices[0].name, "dev-1");
        assert_eq!(fresh.get().sync_report.as_ref().unwrap().fetched, 1);
        assert_eq!(fresh.get().version, 1);

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
            .apply_sync(SyncReport::default(), vec![sample_entry(1, true), sample_entry(2, true)])
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
            .apply_sync(SyncReport::default(), vec![sample_entry(7, true)])
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
        assert_eq!(cfg.default_port, 22);
        assert_eq!(cfg.platform_policy, "skip");

        // Malformed JSON → defaults (never break reads)
        let bad = serde_json::json!({"enabled": "yes please", "default_port": "abc"});
        let cfg = NetBoxConfig::from_json(Some(&bad));
        assert!(!cfg.enabled);
        assert_eq!(cfg.default_port, 22);

        // Full roundtrip
        let cfg = NetBoxConfig {
            enabled: true,
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
        assert!(parsed.validate().is_ok());
    }

    #[test]
    fn test_netbox_config_validation() {
        let mut cfg = NetBoxConfig::default();
        assert!(cfg.validate().is_ok());

        cfg.base_url = "ftp://bad".into();
        assert!(cfg.validate().is_err());
        cfg.base_url = "http://192.168.1.10:8000".into();
        assert!(cfg.validate().is_ok());

        cfg.default_port = 0;
        assert!(cfg.validate().is_err());
        cfg.default_port = 22;

        cfg.platform_policy = "fallback".into();
        assert!(cfg.validate().is_err(), "fallback without a platform");
        cfg.platform_fallback = Some("juniper-junos".into());
        assert!(cfg.validate().is_err(), "invalid fallback platform");
        cfg.platform_fallback = Some("linux-bash".into());
        assert!(cfg.validate().is_ok());

        cfg.platform_policy = "bogus".into();
        assert!(cfg.validate().is_err());

        cfg.platform_policy = "skip".into();
        cfg.platform_overrides.insert("x".into(), "not-a-platform".into());
        assert!(cfg.validate().is_err());
        cfg.platform_overrides.insert("x".into(), "cisco-nxos".into());
        assert!(cfg.validate().is_ok());
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
        let policy = cfg.platform_policy();
        assert_eq!(policy.resolve(Some("anything")), Some("linux-bash".into()));
        assert_eq!(policy.resolve(Some("nxos")), Some("cisco-nxos".into()));
        assert!(policy.overrides.is_empty());

        // skip policy → no fallback even if a fallback platform is set
        let mut cfg = NetBoxConfig::default();
        cfg.platform_policy = "skip".into();
        cfg.platform_fallback = Some("linux-bash".into());
        assert_eq!(cfg.platform_policy().resolve(Some("foo")), None);
    }

    #[test]
    fn test_host_id_and_group_id_guards() {
        assert!(is_netbox_host_id("netbox:123"));
        assert!(!is_netbox_host_id("netbox:"));
        assert!(!is_netbox_host_id("netbox:abc"));
        assert!(!is_netbox_host_id("some-uuid"));
        assert!(is_synthetic_group_id("__netbox__"));
        assert!(is_synthetic_group_id("__netbox__:site:dc1"));
        assert!(is_synthetic_group_id("__netbox__:site:dc1:loc:rack-1"));
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
        assert_eq!(h.group_id.as_deref(), Some("__netbox__:site:dc1:loc:rack-1"));
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

        let groups = synthetic_groups(&[d1, d2, d3.clone(), d4]);
        let ids: Vec<&str> = groups.iter().map(|g| g.id.as_str()).collect();
        assert_eq!(
            ids,
            vec![
                "__netbox__",
                "__netbox__:site:dc1",
                "__netbox__:site:dc1:loc:rack-1",
            ]
        );
        let root = &groups[0];
        assert_eq!(root.name, "NetBox");
        assert_eq!(root.parent_id, None);
        assert_eq!(root.icon.as_deref(), Some("netbox"));
        assert_eq!(root.sort_order, u32::MAX);

        // Empty / all-disabled cache → no groups at all
        assert!(synthetic_groups(&[d3.clone()]).is_empty());
        assert!(synthetic_groups(&[]).is_empty());
    }
}
