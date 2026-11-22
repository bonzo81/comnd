//! NetBox host source — shared types, source config, and host materialization.
//!
//! Submodules: `client` (REST client behind the read-only HTTP guard),
//! `cache` (persisted device cache), `inventory` (in-memory inventory and the
//! sync orchestration), `commands` (the Tauri command surface) and `mock`
//! (debug-only in-process NetBox server). This module holds the types,
//! constants and pure helpers they share — no I/O, no `AppState`.
//!
//! The cache is the only local storage: `netbox-cache.json` in the app data
//! dir, written with `secure_write`, loaded with `preserve_corrupt` fallback.
//! NetBox data NEVER enters hosts.json — merge happens at read time.
//!
//! NetBox instances live on LANs, so the URL validator only checks the
//! scheme — `import::validate_fetch_url` (which blocks private IPs) must
//! never be applied here (plan §3 warning, §11).

pub(crate) mod cache;
pub(crate) mod client;
pub(crate) mod commands;
pub(crate) mod inventory;
#[cfg(any(test, debug_assertions))]
pub(crate) mod mock;

pub use commands::*;
pub use inventory::NetBoxInventory;

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::credentials::CredentialSource;
use crate::platform::PlatformRegistry;

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

// ─── Device summary (side-panel tab, issue #177 phase 1) ────────────

/// One address on an interface, as shown in the NetBox side-panel tab.
/// `address` keeps NetBox's CIDR suffix. `vrf` is the VRF name when the
/// address belongs to one, so duplicate addresses in different VRFs stay
/// distinguishable.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DeviceSummaryAddress {
    pub address: String,
    #[serde(default)]
    pub vrf: Option<String>,
}

/// Interface addresses grouped under the interface that owns them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DeviceSummaryInterface {
    pub id: u64,
    pub name: String,
    pub addresses: Vec<DeviceSummaryAddress>,
}

/// One VLAN the device is a member of, from the union of `untagged_vlan` and
/// `tagged_vlans` across its own interfaces. `group_id` is the grouping key
/// (group names are only unique within a scope); `group` is the group's name,
/// used as the displayed label.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DeviceSummaryVlan {
    pub id: u64,
    pub vid: u16,
    pub name: String,
    #[serde(default)]
    pub group_id: Option<u64>,
    #[serde(default)]
    pub group: Option<String>,
}

/// One subnet related to the device: either a prefix assigned to one of its
/// VLANs or a prefix containing one of its interface addresses (same VRF).
/// Deduplicated by NetBox prefix id, so a prefix reachable from both sources
/// appears once.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DeviceSummarySubnet {
    pub id: u64,
    pub prefix: String,
    #[serde(default)]
    pub vrf: Option<String>,
}

/// A device cabled to this one. The panel resolves the NetBox id, primary IP
/// and name against Comnd's host list; the summary only carries the NetBox
/// facts (the renderer and the undocked window never see the host list).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DeviceSummaryPeer {
    pub netbox_id: u64,
    pub name: String,
    #[serde(default)]
    pub display: Option<String>,
    /// Primary IPv4 first, then IPv6, CIDR retained. Matching strips the mask.
    #[serde(default)]
    pub primary_ip: Option<String>,
}

/// Live NetBox summary for one device (issue #177): identity and status,
/// device type, geography, rack/U position, interface addresses, VLANs,
/// subnets and cabled peers. Built per fetch and never cached.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DeviceSummary {
    pub netbox_id: u64,
    pub name: String,
    /// Choice value (`active`) and human label (`Active`).
    pub status: String,
    pub status_label: String,
    #[serde(default)]
    pub device_type: Option<String>,
    #[serde(default)]
    pub site: Option<String>,
    #[serde(default)]
    pub location: Option<String>,
    #[serde(default)]
    pub rack: Option<String>,
    #[serde(default)]
    pub position: Option<f64>,
    #[serde(default)]
    pub face: Option<String>,
    #[serde(default)]
    pub primary_ip: Option<String>,
    #[serde(default)]
    pub interfaces: Vec<DeviceSummaryInterface>,
    #[serde(default)]
    pub vlans: Vec<DeviceSummaryVlan>,
    #[serde(default)]
    pub subnets: Vec<DeviceSummarySubnet>,
    #[serde(default)]
    pub peers: Vec<DeviceSummaryPeer>,
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
            other => {
                return Err(format!(
                    "Unknown platform policy '{}' (must be skip or fallback)",
                    other
                ))
            }
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
        ensure_chain(
            &regions,
            &mut seen,
            &mut groups,
            region_group_id,
            &chain,
            ROOT_GROUP_ID,
        );
    }
    // Sites: region ancestry first (usually already emitted), then the site.
    for s in &geo.sites {
        let mut parent = ROOT_GROUP_ID.to_string();
        if let Some(region_slug) = s.region_slug.as_deref().filter(|x| !x.is_empty()) {
            let chain = parent_chain(&regions, region_slug);
            parent = ensure_chain(
                &regions,
                &mut seen,
                &mut groups,
                region_group_id,
                &chain,
                &parent,
            );
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
                let name = sites
                    .get(s)
                    .map(display_name)
                    .unwrap_or_else(|| s.to_string());
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
        ensure_chain(
            &locations,
            &mut seen,
            &mut groups,
            loc_group_id,
            &chain,
            &site_id,
        );
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

// --------------------------------------------------------------------------
// Test fixtures shared by the module unit tests.
// --------------------------------------------------------------------------
#[cfg(test)]
pub(crate) mod test_fixtures {
    use super::*;
    use std::path::PathBuf;

    pub(crate) fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("comnd_netbox_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    pub(crate) fn sample_entry(id: u64, enabled: bool) -> NetBoxDeviceEntry {
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

    pub(crate) fn cfg_with(
        username: Option<&str>,
        port: u16,
        cred: Option<CredentialSource>,
    ) -> NetBoxConfig {
        NetBoxConfig {
            default_username: username.map(str::to_string),
            default_port: port,
            default_credential: cred,
            ..Default::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::netbox::test_fixtures::*;

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

    // ─── Connect param resolution (plan §6) ────────────────────────

    #[test]
    fn test_resolve_overlay_wins_over_defaults() {
        let mut d = sample_entry(5, true);
        d.overlay.username = Some("overlay-user".into());
        d.overlay.port = Some(2200);
        d.overlay.credential = Some(CredentialSource::SshKey {
            key_path: "/k".into(),
        });
        let cfg = cfg_with(Some("default-user"), 2222, Some(CredentialSource::Password));

        let p = resolve_connect_params(&d, &cfg).unwrap();
        assert_eq!(p.username, "overlay-user");
        assert_eq!(p.port, 2200);
        assert_eq!(
            p.credential,
            Some(CredentialSource::SshKey {
                key_path: "/k".into()
            })
        );
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
        assert!(
            !cfg.allow_invalid_certs,
            "TLS verification must default to on"
        );
        assert_eq!(cfg.default_port, 22);
        assert_eq!(cfg.platform_policy, "skip");

        let legacy = serde_json::json!({"enabled": true, "base_url": "https://netbox.example.com"});
        let cfg = NetBoxConfig::from_json(Some(&legacy));
        assert!(cfg.enabled);
        assert!(!cfg.show_empty_folders);
        assert!(
            !cfg.allow_invalid_certs,
            "a config predating the field must not opt out of TLS verification"
        );

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
        assert!(
            cfg.validate(&PlatformRegistry::builtin()).is_err(),
            "fallback without a platform"
        );
        cfg.platform_fallback = Some("juniper-junos".into());
        assert!(
            cfg.validate(&PlatformRegistry::builtin()).is_err(),
            "invalid fallback platform"
        );
        cfg.platform_fallback = Some("linux-bash".into());
        assert!(cfg.validate(&PlatformRegistry::builtin()).is_ok());

        cfg.platform_policy = "bogus".into();
        assert!(cfg.validate(&PlatformRegistry::builtin()).is_err());

        cfg.platform_policy = "skip".into();
        cfg.platform_overrides
            .insert("x".into(), "not-a-platform".into());
        assert!(cfg.validate(&PlatformRegistry::builtin()).is_err());
        cfg.platform_overrides
            .insert("x".into(), "cisco-nxos".into());
        assert!(cfg.validate(&PlatformRegistry::builtin()).is_ok());
    }

    #[test]
    fn test_override_to_custom_platform_validates_when_in_registry() {
        let dir = std::env::temp_dir().join(format!("comnd_netbox_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("my-custom")).unwrap();
        std::fs::write(dir.join("my-custom/index.yaml"), "platform: my-custom\n").unwrap();
        let platforms = PlatformRegistry::scan(&dir, None::<&std::path::Path>);

        let mut cfg = NetBoxConfig::default();
        cfg.platform_overrides
            .insert("foo-os".into(), "my-custom".into());
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
        assert_eq!(
            cfg.platform_policy(&PlatformRegistry::builtin())
                .resolve(Some("foo")),
            None
        );
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
            default_credential: Some(CredentialSource::SshKey {
                key_path: "/keys/default".into(),
            }),
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
            Some(CredentialSource::SshKey {
                key_path: "/keys/default".into()
            })
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
        assert_eq!(
            h.credential,
            Some(CredentialSource::Agent { identity: None })
        );
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
        assert_eq!(
            materialize_host(&device, &cfg).group_id.as_deref(),
            Some("__netbox__")
        );
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
        assert_eq!(
            ids,
            vec!["__netbox__", "__netbox__:site:dc1", "__netbox__:loc:rack-1"]
        );
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
                NetBoxGeoNode {
                    slug: "emea".into(),
                    name: "EMEA".into(),
                    parent_slug: None,
                    site_slug: None,
                    region_slug: None,
                },
                NetBoxGeoNode {
                    slug: "uk".into(),
                    name: "United Kingdom".into(),
                    parent_slug: Some("emea".into()),
                    site_slug: None,
                    region_slug: None,
                },
            ],
            sites: vec![
                NetBoxGeoNode {
                    slug: "dc1".into(),
                    name: "DC1 London".into(),
                    parent_slug: None,
                    site_slug: None,
                    region_slug: Some("uk".into()),
                },
                NetBoxGeoNode {
                    slug: "dc2".into(),
                    name: "DC2 Paris".into(),
                    parent_slug: None,
                    site_slug: None,
                    region_slug: Some("emea".into()),
                },
            ],
            locations: vec![
                NetBoxGeoNode {
                    slug: "floor-1".into(),
                    name: "Floor 1".into(),
                    parent_slug: None,
                    site_slug: Some("dc1".into()),
                    region_slug: None,
                },
                NetBoxGeoNode {
                    slug: "room-a".into(),
                    name: "Room A".into(),
                    parent_slug: Some("floor-1".into()),
                    site_slug: Some("dc1".into()),
                    region_slug: None,
                },
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
        assert_eq!(
            by_id["__netbox__:region:emea"].parent_id.as_deref(),
            Some("__netbox__")
        );
        assert_eq!(by_id["__netbox__:region:uk"].name, "United Kingdom");
        assert_eq!(
            by_id["__netbox__:region:uk"].parent_id.as_deref(),
            Some("__netbox__:region:emea")
        );
        assert_eq!(by_id["__netbox__:site:dc1"].name, "DC1 London");
        assert_eq!(
            by_id["__netbox__:site:dc1"].parent_id.as_deref(),
            Some("__netbox__:region:uk")
        );
        assert_eq!(by_id["__netbox__:loc:floor-1"].name, "Floor 1");
        assert_eq!(
            by_id["__netbox__:loc:floor-1"].parent_id.as_deref(),
            Some("__netbox__:site:dc1")
        );
        assert_eq!(by_id["__netbox__:loc:room-a"].name, "Room A");
        assert_eq!(
            by_id["__netbox__:loc:room-a"].parent_id.as_deref(),
            Some("__netbox__:loc:floor-1")
        );

        // An enabled device directly under a site keeps that branch visible.
        assert_eq!(
            by_id["__netbox__:site:dc2"].parent_id.as_deref(),
            Some("__netbox__:region:emea")
        );
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
        assert_eq!(
            groups[2].parent_id.as_deref(),
            Some("__netbox__:site:living-room")
        );
        assert_eq!(
            groups[3].parent_id.as_deref(),
            Some("__netbox__:loc:floor-1")
        );
        assert_eq!(groups[1].name, "Living Room");
        assert_eq!(groups[3].name, "Room A");
    }

    #[test]
    fn test_synthetic_groups_unknown_slugs_flatten() {
        // Stale cache: device points at a location slug missing from the geo
        // tables → location attaches directly to its site, slug-named.
        let geo = NetBoxGeo {
            sites: vec![NetBoxGeoNode {
                slug: "dc1".into(),
                name: "DC1".into(),
                parent_slug: None,
                site_slug: None,
                region_slug: None,
            }],
            ..Default::default()
        };
        let mut d = sample_entry(1, true);
        d.site = Some("dc1".into());
        d.location = Some("ghost-loc".into());
        let groups = synthetic_groups(&[d], &geo, false);
        let ids: Vec<&str> = groups.iter().map(|g| g.id.as_str()).collect();
        assert_eq!(
            ids,
            vec![
                "__netbox__",
                "__netbox__:site:dc1",
                "__netbox__:loc:ghost-loc"
            ]
        );
        assert_eq!(groups[2].name, "ghost-loc");
        assert_eq!(groups[2].parent_id.as_deref(), Some("__netbox__:site:dc1"));
    }

    #[test]
    fn test_synthetic_groups_full_geography_includes_empty_branches() {
        // Full-geography mode: a region > site > location chain with zero
        // devices still appears in the tree.
        let geo = NetBoxGeo {
            regions: vec![NetBoxGeoNode {
                slug: "region-1".into(),
                name: "Region 1".into(),
                parent_slug: None,
                site_slug: None,
                region_slug: None,
            }],
            sites: vec![NetBoxGeoNode {
                slug: "demo-site".into(),
                name: "Demo Site".into(),
                parent_slug: None,
                site_slug: None,
                region_slug: Some("region-1".into()),
            }],
            locations: vec![NetBoxGeoNode {
                slug: "demo-loc".into(),
                name: "Demo Location".into(),
                parent_slug: None,
                site_slug: Some("demo-site".into()),
                region_slug: None,
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
        assert_eq!(
            by_id["__netbox__:site:demo-site"].parent_id.as_deref(),
            Some("__netbox__:region:region-1")
        );
        assert_eq!(
            by_id["__netbox__:loc:demo-loc"].parent_id.as_deref(),
            Some("__netbox__:site:demo-site")
        );
    }

    #[test]
    fn test_synthetic_groups_prunes_empty_and_disabled_only_subtrees() {
        let geo = NetBoxGeo {
            regions: vec![
                NetBoxGeoNode {
                    slug: "world".into(),
                    name: "World".into(),
                    parent_slug: None,
                    site_slug: None,
                    region_slug: None,
                },
                NetBoxGeoNode {
                    slug: "active".into(),
                    name: "Active".into(),
                    parent_slug: Some("world".into()),
                    site_slug: None,
                    region_slug: None,
                },
                NetBoxGeoNode {
                    slug: "empty".into(),
                    name: "Empty".into(),
                    parent_slug: Some("world".into()),
                    site_slug: None,
                    region_slug: None,
                },
            ],
            sites: vec![
                NetBoxGeoNode {
                    slug: "dc1".into(),
                    name: "DC1".into(),
                    parent_slug: None,
                    site_slug: None,
                    region_slug: Some("active".into()),
                },
                NetBoxGeoNode {
                    slug: "dc2".into(),
                    name: "DC2".into(),
                    parent_slug: None,
                    site_slug: None,
                    region_slug: Some("empty".into()),
                },
                NetBoxGeoNode {
                    slug: "dc3".into(),
                    name: "DC3".into(),
                    parent_slug: None,
                    site_slug: None,
                    region_slug: Some("active".into()),
                },
            ],
            locations: vec![
                NetBoxGeoNode {
                    slug: "floor".into(),
                    name: "Floor".into(),
                    parent_slug: None,
                    site_slug: Some("dc1".into()),
                    region_slug: None,
                },
                NetBoxGeoNode {
                    slug: "room".into(),
                    name: "Room".into(),
                    parent_slug: Some("floor".into()),
                    site_slug: Some("dc1".into()),
                    region_slug: None,
                },
                NetBoxGeoNode {
                    slug: "unused".into(),
                    name: "Unused".into(),
                    parent_slug: Some("floor".into()),
                    site_slug: Some("dc1".into()),
                    region_slug: None,
                },
                NetBoxGeoNode {
                    slug: "disabled".into(),
                    name: "Disabled".into(),
                    parent_slug: None,
                    site_slug: Some("dc2".into()),
                    region_slug: None,
                },
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
        assert_eq!(
            ids,
            vec![
                "__netbox__",
                "__netbox__:region:world",
                "__netbox__:region:active",
                "__netbox__:site:dc1",
                "__netbox__:loc:floor",
                "__netbox__:loc:room",
            ]
        );
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
                NetBoxGeoNode {
                    slug: "a".into(),
                    name: "A".into(),
                    parent_slug: Some("b".into()),
                    site_slug: Some("dc1".into()),
                    region_slug: None,
                },
                NetBoxGeoNode {
                    slug: "b".into(),
                    name: "B".into(),
                    parent_slug: Some("a".into()),
                    site_slug: Some("dc1".into()),
                    region_slug: None,
                },
            ],
            sites: vec![NetBoxGeoNode {
                slug: "dc1".into(),
                name: "DC1".into(),
                parent_slug: None,
                site_slug: None,
                region_slug: None,
            }],
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
        assert_eq!(
            by_id["__netbox__:loc:a"].parent_id.as_deref(),
            Some("__netbox__:site:dc1")
        );
        assert_eq!(
            by_id["__netbox__:loc:b"].parent_id.as_deref(),
            Some("__netbox__:site:dc1")
        );
        let pruned = synthetic_groups(&[d], &geo, false);
        let ids: Vec<&str> = pruned.iter().map(|g| g.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["__netbox__", "__netbox__:site:dc1", "__netbox__:loc:a"]
        );
    }
}
