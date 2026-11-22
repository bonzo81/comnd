//! NetBox REST client — device parsing, pagination, and the read-only HTTP
//! guard. Every request the app makes to a NetBox instance goes through
//! `ReadOnlyHttp` below.

use std::collections::{BTreeSet, HashMap};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::{
    DeviceSummary, DeviceSummaryAddress, DeviceSummaryInterface, DeviceSummaryPeer,
    DeviceSummarySubnet, DeviceSummaryVlan, NetBoxChoice, NetBoxFilters, NetBoxGeo,
    NetBoxGeoNode,
};

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

// ─── Device summary parsing (issue #177 phase 1) ─────────────────────

/// Top-level fields for the device-detail request. Nested serializers default
/// to their brief shape, so this keeps the payload to the facts the tab shows.
/// `display` is requested because it is the fallback for an unnamed device.
const SUMMARY_DEVICE_FIELDS: &str = "id,name,display,status,device_type,site,location,rack,position,face,primary_ip4,primary_ip6";
/// Top-level fields for the IP request. `assigned_object` is brief (interface
/// plus brief device), which is all the grouping needs.
const SUMMARY_IP_FIELDS: &str =
    "id,address,vrf,status,assigned_object,assigned_object_type,assigned_object_id";
/// Interface fields for the VLAN membership request. `device` is requested so
/// the parser can drop a virtual-chassis sibling's interface; the two VLAN
/// fields are absent from the brief serializer and are only present because
/// they are listed here.
const SUMMARY_INTERFACE_FIELDS: &str = "id,name,device,untagged_vlan,tagged_vlans";
/// Top-level fields for the VLAN-details request. A nested VLAN is brief and
/// therefore has no `group`, which is why this second request exists.
const SUMMARY_VLAN_FIELDS: &str = "id,vid,name,group";
/// Prefix fields for the subnet request. `vrf` and `vlan` are nested brief.
const SUMMARY_PREFIX_FIELDS: &str = "id,prefix,vrf,vlan";
/// Cable fields: both ends, each a `GenericObjectSerializer` whose `object`
/// is the nested brief termination (an interface carries its brief device).
const SUMMARY_CABLE_FIELDS: &str = "id,a_terminations,b_terminations";
/// Peer-device fields for the batched primary-IP lookup. A nested
/// `primary_ip4/6` is brief and does carry `address`.
const SUMMARY_PEER_DEVICE_FIELDS: &str = "id,name,display,primary_ip4,primary_ip6";

/// Trimmed, non-empty string from a JSON value.
fn summary_text(v: Option<&serde_json::Value>) -> Option<String> {
    v.and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// `name` (fallback `display`) from a nullable nested object.
fn summary_nested_name(v: &serde_json::Value, field: &str) -> Option<String> {
    let obj = v.get(field)?;
    summary_text(obj.get("name")).or_else(|| summary_text(obj.get("display")))
}

/// Device `status` is a choice object (`{"value": "active", "label": "Active"}`)
/// in every supported NetBox version; a bare string is tolerated for old data.
fn summary_status(v: &serde_json::Value) -> (String, String) {
    let Some(status) = v.get("status") else {
        return (String::new(), String::new());
    };
    let value = summary_text(status.get("value"))
        .or_else(|| summary_text(Some(status)))
        .unwrap_or_default();
    let label = summary_text(status.get("label")).unwrap_or_else(|| value.clone());
    (value, label)
}

/// Rack face is a choice object; tolerate a bare string.
fn summary_face(v: &serde_json::Value) -> Option<String> {
    let face = v.get("face")?;
    summary_text(face.get("value")).or_else(|| summary_text(Some(face)))
}

/// Primary IPv4 first, then IPv6. The CIDR suffix is kept: it is useful in the
/// panel even though the SSH host address strips it.
fn summary_primary_ip(v: &serde_json::Value) -> Option<String> {
    ["primary_ip4", "primary_ip6"].iter().find_map(|key| {
        summary_text(v.get(*key)?.get("address"))
    })
}

/// Compose `manufacturer.name` and `model`. NetBox's `DeviceType.__str__`
/// returns the model only, so `display` cannot carry the manufacturer; it is
/// kept as the fallback when the brief response omits the pair.
fn summary_device_type(v: &serde_json::Value) -> Option<String> {
    let kind = v.get("device_type")?;
    let manufacturer = kind.get("manufacturer").and_then(|manufacturer| {
        summary_text(manufacturer.get("name")).or_else(|| summary_text(manufacturer.get("display")))
    });
    let model = summary_text(kind.get("model"));
    match (manufacturer, model) {
        (Some(manufacturer), Some(model)) => {
            if model.to_lowercase().contains(&manufacturer.to_lowercase()) {
                Some(model)
            } else {
                Some(format!("{} {}", manufacturer, model))
            }
        }
        (_, Some(model)) => Some(model),
        (Some(manufacturer), None) => Some(manufacturer),
        (None, None) => summary_text(kind.get("display")),
    }
}

/// The interface object that owns an address, when that owner belongs to this
/// device. Only `dcim.interface` owners are considered, and only interfaces
/// whose owner device is the requested one: NetBox's IP `device_id` filter
/// includes virtual-chassis siblings. A missing nested device passes, because
/// the interfaces list's own `device_id` filter is exact.
fn summary_ip_owner<'a>(
    ip: &'a serde_json::Value,
    device_id: u64,
) -> Option<&'a serde_json::Value> {
    if summary_text(ip.get("assigned_object_type")).as_deref() != Some("dcim.interface") {
        return None;
    }
    let owner = ip.get("assigned_object").filter(|obj| !obj.is_null())?;
    if let Some(owner_id) = owner
        .get("device")
        .and_then(|device| device.get("id"))
        .and_then(|id| id.as_u64())
    {
        if owner_id != device_id {
            return None;
        }
    }
    Some(owner)
}

/// An address and its VRF, used for subnet containment.
struct SummaryIpRef {
    address: String,
    vrf_id: Option<u64>,
}

/// Group the device's addresses by interface.
fn summary_interfaces(
    results: &[serde_json::Value],
    device_id: u64,
) -> Vec<DeviceSummaryInterface> {
    let mut by_id: HashMap<u64, DeviceSummaryInterface> = HashMap::new();
    for ip in results {
        let Some(owner) = summary_ip_owner(ip, device_id) else {
            continue;
        };
        let interface_id = owner
            .get("id")
            .and_then(|id| id.as_u64())
            .or_else(|| ip.get("assigned_object_id").and_then(|id| id.as_u64()));
        let Some(interface_id) = interface_id else {
            continue;
        };
        let Some(address) = summary_text(ip.get("address")) else {
            continue;
        };
        let name = summary_text(owner.get("name"))
            .or_else(|| summary_text(owner.get("display")))
            .unwrap_or_else(|| format!("interface-{}", interface_id));
        let vrf = ip.get("vrf").and_then(|v| {
            summary_text(v.get("name")).or_else(|| summary_text(v.get("display")))
        });
        by_id
            .entry(interface_id)
            .or_insert_with(|| DeviceSummaryInterface {
                id: interface_id,
                name,
                addresses: Vec::new(),
            })
            .addresses
            .push(DeviceSummaryAddress { address, vrf });
    }

    let mut interfaces: Vec<DeviceSummaryInterface> = by_id.into_values().collect();
    for interface in &mut interfaces {
        interface.addresses.sort_by(|a, b| a.address.cmp(&b.address));
    }
    interfaces.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then(a.id.cmp(&b.id))
    });
    interfaces
}

/// Every address on one of this device's interfaces, with its VRF id.
fn summary_ip_refs(results: &[serde_json::Value], device_id: u64) -> Vec<SummaryIpRef> {
    results
        .iter()
        .filter_map(|ip| {
            summary_ip_owner(ip, device_id)?;
            Some(SummaryIpRef {
                address: summary_text(ip.get("address"))?,
                vrf_id: ip
                    .get("vrf")
                    .and_then(|vrf| vrf.get("id"))
                    .and_then(|id| id.as_u64()),
            })
        })
        .collect()
}

/// The union of `untagged_vlan` and every `tagged_vlans` entry across the
/// device's own interfaces. De-duplicated and ordered so the request's `?id=`
/// list is deterministic.
fn summary_vlan_ids(interfaces: &[serde_json::Value], device_id: u64) -> Vec<u64> {
    let mut ids = BTreeSet::new();
    for interface in interfaces {
        if let Some(owner_id) = interface
            .get("device")
            .and_then(|device| device.get("id"))
            .and_then(|id| id.as_u64())
        {
            if owner_id != device_id {
                continue;
            }
        }
        if let Some(id) = interface
            .get("untagged_vlan")
            .and_then(|vlan| vlan.get("id"))
            .and_then(|id| id.as_u64())
        {
            ids.insert(id);
        }
        if let Some(tagged) = interface.get("tagged_vlans").and_then(|v| v.as_array()) {
            for vlan in tagged {
                if let Some(id) = vlan.get("id").and_then(|id| id.as_u64()) {
                    ids.insert(id);
                }
            }
        }
    }
    ids.into_iter().collect()
}

/// VLAN rows from the VLAN-details request, deduplicated by id and ordered by
/// group name then VID.
fn summary_vlans(results: &[serde_json::Value]) -> Vec<DeviceSummaryVlan> {
    let mut by_id: HashMap<u64, DeviceSummaryVlan> = HashMap::new();
    for vlan in results {
        let Some(id) = vlan.get("id").and_then(|id| id.as_u64()) else {
            continue;
        };
        let Some(vid) = vlan
            .get("vid")
            .and_then(|vid| vid.as_u64())
            .and_then(|vid| u16::try_from(vid).ok())
        else {
            continue;
        };
        let group = vlan.get("group").filter(|group| !group.is_null());
        let group_id = group
            .and_then(|group| group.get("id"))
            .and_then(|id| id.as_u64());
        let group = group.and_then(|group| {
            summary_text(group.get("name")).or_else(|| summary_text(group.get("display")))
        });
        let name = summary_text(vlan.get("name")).unwrap_or_else(|| format!("VLAN {}", vid));
        by_id.entry(id).or_insert(DeviceSummaryVlan {
            id,
            vid,
            name,
            group_id,
            group,
        });
    }
    let mut vlans: Vec<DeviceSummaryVlan> = by_id.into_values().collect();
    vlans.sort_by(|a, b| {
        a.group
            .as_deref()
            .unwrap_or("")
            .to_lowercase()
            .cmp(&b.group.as_deref().unwrap_or("").to_lowercase())
            .then(a.group_id.cmp(&b.group_id))
            .then(a.vid.cmp(&b.vid))
            .then(a.id.cmp(&b.id))
    });
    vlans
}

/// Parse a CIDR into its address and mask length.
fn parse_cidr(value: &str) -> Option<(std::net::IpAddr, u8)> {
    let (address, length) = value.split_once('/')?;
    let address: std::net::IpAddr = address.parse().ok()?;
    let length: u8 = length.parse().ok()?;
    Some((address, length))
}

/// True when `prefix` contains `address` (same address family only).
fn ip_contained(prefix: &str, address: &str) -> bool {
    let Some((network, length)) = parse_cidr(prefix) else {
        return false;
    };
    let Some((address, _)) = parse_cidr(address) else {
        return false;
    };
    match (network, address) {
        (std::net::IpAddr::V4(network), std::net::IpAddr::V4(address)) => {
            if length > 32 {
                return false;
            }
            let mask = if length == 0 {
                0
            } else {
                u32::MAX << (32 - length)
            };
            u32::from(network) & mask == u32::from(address) & mask
        }
        (std::net::IpAddr::V6(network), std::net::IpAddr::V6(address)) => {
            if length > 128 {
                return false;
            }
            let mask = if length == 0 {
                0
            } else {
                u128::MAX << (128 - length)
            };
            u128::from(network) & mask == u128::from(address) & mask
        }
        _ => false,
    }
}

/// The deduplicated union of the two subnet sources: a prefix assigned to one
/// of the device's VLANs, or a prefix containing one of its interface
/// addresses in the same VRF.
fn summary_subnets(
    prefixes: &[serde_json::Value],
    vlan_ids: &[u64],
    ips: &[SummaryIpRef],
) -> Vec<DeviceSummarySubnet> {
    let mut by_id: HashMap<u64, DeviceSummarySubnet> = HashMap::new();
    for prefix in prefixes {
        let Some(id) = prefix.get("id").and_then(|id| id.as_u64()) else {
            continue;
        };
        let Some(value) = summary_text(prefix.get("prefix")) else {
            continue;
        };
        let vrf_id = prefix
            .get("vrf")
            .and_then(|vrf| vrf.get("id"))
            .and_then(|id| id.as_u64());
        let by_vlan = prefix
            .get("vlan")
            .and_then(|vlan| vlan.get("id"))
            .and_then(|id| id.as_u64())
            .map(|vlan_id| vlan_ids.contains(&vlan_id))
            .unwrap_or(false);
        let by_address = ips
            .iter()
            .any(|ip| ip.vrf_id == vrf_id && ip_contained(&value, &ip.address));
        if !by_vlan && !by_address {
            continue;
        }
        let vrf = prefix.get("vrf").and_then(|vrf| {
            summary_text(vrf.get("name")).or_else(|| summary_text(vrf.get("display")))
        });
        by_id.entry(id).or_insert(DeviceSummarySubnet {
            id,
            prefix: value,
            vrf,
        });
    }
    let mut subnets: Vec<DeviceSummarySubnet> = by_id.into_values().collect();
    subnets.sort_by(|a, b| {
        let key = |subnet: &DeviceSummarySubnet| match parse_cidr(&subnet.prefix) {
            Some((std::net::IpAddr::V4(ip), length)) => {
                (0u8, u128::from(u32::from(ip)), length)
            }
            Some((std::net::IpAddr::V6(ip), length)) => (1u8, u128::from(ip), length),
            None => (2u8, 0u128, 0u8),
        };
        key(a)
            .cmp(&key(b))
            .then(a.prefix.cmp(&b.prefix))
            .then(a.id.cmp(&b.id))
    });
    subnets
}

/// Cabled peer devices. Each cable end is a `GenericObjectSerializer`; the
/// nested brief termination carries its device. A cable between two of this
/// device's own ports contributes no peer, and a termination without a device
/// (circuit, power feed) is skipped.
fn summary_peers(cables: &[serde_json::Value], device_id: u64) -> Vec<DeviceSummaryPeer> {
    let mut by_id: HashMap<u64, DeviceSummaryPeer> = HashMap::new();
    for cable in cables {
        for end in ["a_terminations", "b_terminations"] {
            let Some(terminations) = cable.get(end).and_then(|list| list.as_array()) else {
                continue;
            };
            for termination in terminations {
                let Some(object) = termination.get("object").filter(|obj| !obj.is_null()) else {
                    continue;
                };
                let Some(device) = object.get("device").filter(|obj| !obj.is_null()) else {
                    continue;
                };
                let Some(peer_id) = device.get("id").and_then(|id| id.as_u64()) else {
                    continue;
                };
                if peer_id == device_id {
                    continue;
                }
                let display = summary_text(device.get("display"));
                let name = summary_text(device.get("name"))
                    .or_else(|| display.clone())
                    .unwrap_or_else(|| format!("device-{}", peer_id));
                by_id.entry(peer_id).or_insert(DeviceSummaryPeer {
                    netbox_id: peer_id,
                    name,
                    display,
                    primary_ip: None,
                });
            }
        }
    }
    let mut peers: Vec<DeviceSummaryPeer> = by_id.into_values().collect();
    peers.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then(a.netbox_id.cmp(&b.netbox_id))
    });
    peers
}

/// Fill each peer's primary IP from the batched device list.
fn attach_peer_primary_ips(peers: &mut [DeviceSummaryPeer], devices: &[serde_json::Value]) {
    let mut primaries: HashMap<u64, Option<String>> = HashMap::new();
    for device in devices {
        let Some(id) = device.get("id").and_then(|id| id.as_u64()) else {
            continue;
        };
        let primary = ["primary_ip4", "primary_ip6"]
            .iter()
            .find_map(|key| summary_text(device.get(*key)?.get("address")));
        primaries.insert(id, primary);
    }
    for peer in peers {
        if let Some(primary) = primaries.get(&peer.netbox_id) {
            peer.primary_ip = primary.clone();
        }
    }
}

/// Build the summary from the device-detail response. Addresses are filled in
/// by the caller from the separate IP request.
fn parse_summary_device(
    device: &serde_json::Value,
    netbox_id: u64,
) -> DeviceSummary {
    let name = summary_text(device.get("name"))
        .or_else(|| summary_text(device.get("display")))
        .unwrap_or_else(|| format!("device-{}", netbox_id));
    let (status, status_label) = summary_status(device);
    DeviceSummary {
        netbox_id,
        name,
        status,
        status_label,
        device_type: summary_device_type(device),
        site: summary_nested_name(device, "site"),
        location: summary_nested_name(device, "location"),
        rack: summary_nested_name(device, "rack"),
        position: device.get("position").and_then(|position| {
            position
                .as_f64()
                .or_else(|| position.as_str().and_then(|text| text.parse().ok()))
        }),
        face: summary_face(device),
        primary_ip: summary_primary_ip(device),
        interfaces: Vec::new(),
        vlans: Vec::new(),
        subnets: Vec::new(),
        peers: Vec::new(),
    }
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

    /// Fetch the live summary for one device (issue #177, phases 1 and 2).
    ///
    /// Seven GETs, independent of interface, VLAN, prefix or peer count:
    /// 1. the device detail with `fields=` limited to the facts the tab shows;
    /// 2. every IP assigned to the device's interfaces (`device_id`, `limit=0`);
    /// 3. the device's interfaces with their VLAN membership (`device_id`,
    ///    `limit=0`) — the VLAN fields are absent from the brief serializer;
    /// 4. the VLAN details for those ids (`?id=` repeated, `limit=0`), because
    ///    a nested VLAN is brief and carries no `group`;
    /// 5. every prefix (`limit=0`), filtered client-side for both subnet
    ///    sources — v4.1's `contains` filter is single-valued;
    /// 6. every cable attached to the device (`device_id`, `limit=0`);
    /// 7. the peer devices' primary IPs (`?id=` repeated, `limit=0`), because
    ///    a nested device is brief and carries no primary IP.
    ///
    /// Requests 4 and 7 are skipped only when their set is empty; no request is
    /// ever split by count. The sync cache is never consulted. Any failure
    /// returns the mapped error; no partial summary leaves this function.
    pub async fn fetch_device_summary(&self, netbox_id: u64) -> Result<DeviceSummary, String> {
        let device_url = reqwest::Url::parse_with_params(
            &format!("{}/api/dcim/devices/{}/", self.base_url, netbox_id),
            [("fields", SUMMARY_DEVICE_FIELDS)],
        )
        .map_err(|e| format!("Failed to build request URL: {}", e))?;
        log::info!("NetBox fetch_device_summary device -> {}", device_url);
        let device = self.get_json(&device_url).await?;

        let id = netbox_id.to_string();
        let addresses_url = reqwest::Url::parse_with_params(
            &format!("{}/api/ipam/ip-addresses/", self.base_url),
            [
                ("device_id", id.as_str()),
                ("fields", SUMMARY_IP_FIELDS),
                ("limit", "0"),
            ],
        )
        .map_err(|e| format!("Failed to build request URL: {}", e))?;
        log::info!("NetBox fetch_device_summary addresses -> {}", addresses_url);
        let results = self
            .fetch_summary_list(
                &addresses_url,
                "interface addresses",
                "raise NetBox's API MAX_PAGE_SIZE or reduce this device's address count.",
                Some("reading IP addresses requires IPAM > IP address read access"),
            )
            .await?;

        let mut summary = parse_summary_device(&device, netbox_id);
        summary.interfaces = summary_interfaces(&results, netbox_id);
        let ip_refs = summary_ip_refs(&results, netbox_id);

        let interfaces_url = reqwest::Url::parse_with_params(
            &format!("{}/api/dcim/interfaces/", self.base_url),
            [
                ("device_id", id.as_str()),
                ("fields", SUMMARY_INTERFACE_FIELDS),
                ("limit", "0"),
            ],
        )
        .map_err(|e| format!("Failed to build request URL: {}", e))?;
        log::info!(
            "NetBox fetch_device_summary interfaces -> {}",
            interfaces_url
        );
        let interfaces = self
            .fetch_summary_list(
                &interfaces_url,
                "interfaces",
                "raise NetBox's API MAX_PAGE_SIZE or reduce this device's interface count.",
                Some("reading interfaces requires DCIM > Interface read access"),
            )
            .await?;
        let vlan_ids = summary_vlan_ids(&interfaces, netbox_id);

        if !vlan_ids.is_empty() {
            let mut vlans_url = reqwest::Url::parse(&format!("{}/api/ipam/vlans/", self.base_url))
                .map_err(|e| format!("Failed to build request URL: {}", e))?;
            {
                let mut query = vlans_url.query_pairs_mut();
                query
                    .append_pair("fields", SUMMARY_VLAN_FIELDS)
                    .append_pair("limit", "0");
                for vlan_id in &vlan_ids {
                    query.append_pair("id", &vlan_id.to_string());
                }
            }
            log::info!("NetBox fetch_device_summary vlans -> {}", vlans_url);
            let vlans = self
                .fetch_summary_list(
                    &vlans_url,
                    "VLANs",
                    "raise NetBox's API MAX_PAGE_SIZE or reduce this device's VLAN count.",
                    Some("reading VLANs requires IPAM > VLAN read access"),
                )
                .await?;
            summary.vlans = summary_vlans(&vlans);
        }

        let prefixes_url = reqwest::Url::parse_with_params(
            &format!("{}/api/ipam/prefixes/", self.base_url),
            [("fields", SUMMARY_PREFIX_FIELDS), ("limit", "0")],
        )
        .map_err(|e| format!("Failed to build request URL: {}", e))?;
        log::info!("NetBox fetch_device_summary prefixes -> {}", prefixes_url);
        let prefixes = self
            .fetch_summary_list(
                &prefixes_url,
                "prefixes",
                "raise NetBox's API MAX_PAGE_SIZE for this instance.",
                Some("reading prefixes requires IPAM > Prefix read access"),
            )
            .await?;
        summary.subnets = summary_subnets(&prefixes, &vlan_ids, &ip_refs);

        let cables_url = reqwest::Url::parse_with_params(
            &format!("{}/api/dcim/cables/", self.base_url),
            [
                ("device_id", id.as_str()),
                ("fields", SUMMARY_CABLE_FIELDS),
                ("limit", "0"),
            ],
        )
        .map_err(|e| format!("Failed to build request URL: {}", e))?;
        log::info!("NetBox fetch_device_summary cables -> {}", cables_url);
        let cables = self
            .fetch_summary_list(
                &cables_url,
                "cables",
                "raise NetBox's API MAX_PAGE_SIZE or reduce this device's cable count.",
                Some("reading cables requires DCIM > Cable read access"),
            )
            .await?;
        summary.peers = summary_peers(&cables, netbox_id);

        if !summary.peers.is_empty() {
            let mut peers_url =
                reqwest::Url::parse(&format!("{}/api/dcim/devices/", self.base_url))
                    .map_err(|e| format!("Failed to build request URL: {}", e))?;
            {
                let mut query = peers_url.query_pairs_mut();
                query
                    .append_pair("fields", SUMMARY_PEER_DEVICE_FIELDS)
                    .append_pair("limit", "0");
                for peer in &summary.peers {
                    query.append_pair("id", &peer.netbox_id.to_string());
                }
            }
            log::info!("NetBox fetch_device_summary peers -> {}", peers_url);
            let devices = self
                .fetch_summary_list(
                    &peers_url,
                    "cabled peer devices",
                    "raise NetBox's API MAX_PAGE_SIZE or reduce the number of cabled peers.",
                    None,
                )
                .await?;
            attach_peer_primary_ips(&mut summary.peers, &devices);
        }

        log::info!(
            "NetBox fetch_device_summary done — {} interface(s), {} VLAN(s), {} subnet(s), \
             {} peer(s)",
            summary.interfaces.len(),
            summary.vlans.len(),
            summary.subnets.len(),
            summary.peers.len()
        );
        Ok(summary)
    }

    /// One list request whose full result must fit in a single page. `label`
    /// and `advice` shape the cap error; a capped page is never truncated.
    async fn fetch_summary_list(
        &self,
        url: &reqwest::Url,
        label: &str,
        advice: &str,
        permission_hint: Option<&str>,
    ) -> Result<Vec<serde_json::Value>, String> {
        let body = self.get_json_for(url, permission_hint).await?;
        let results = body
            .get("results")
            .and_then(|results| results.as_array())
            .ok_or_else(|| "Unexpected NetBox response shape (missing results)".to_string())?;

        // `limit=0` disables pagination only when the server's MAX_PAGE_SIZE is
        // 0/unset. Accepting a capped page would silently drop objects, so fail
        // with the prerequisite instead; the fixed-GET contract stays.
        let total = body
            .get("count")
            .and_then(|count| count.as_u64())
            .unwrap_or(results.len() as u64);
        let has_next = body
            .get("next")
            .and_then(|next| next.as_str())
            .map(|next| !next.is_empty())
            .unwrap_or(false);
        if has_next || total > results.len() as u64 {
            return Err(format!(
                "NetBox returned {} of {} {} in one page. The device summary needs them all in \
                 one request; {}",
                results.len(),
                total,
                label,
                advice
            ));
        }
        Ok(results.clone())
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
        self.get_json_for(url, None).await
    }

    /// `permission_hint` names the endpoint a 403 denies. Without it the shared
    /// device-list wording is used, which would wrongly point at DCIM Device
    /// when a different endpoint was the one refused.
    async fn get_json_for(
        &self,
        url: &reqwest::Url,
        permission_hint: Option<&str>,
    ) -> Result<serde_json::Value, String> {
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
            return Err(map_status_error_for(
                status,
                &body,
                retry_after.as_deref(),
                permission_hint,
            ));
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
    map_status_error_for(status, body, retry_after, None)
}

fn map_status_error_for(
    status: reqwest::StatusCode,
    body: &str,
    retry_after: Option<&str>,
    permission_hint: Option<&str>,
) -> String {
    match status.as_u16() {
        401 => "Invalid or expired NetBox API token".to_string(),
        403 => match permission_hint {
            Some(hint) => format!("NetBox token lacks permission for this request — {}", hint),
            None => {
                "NetBox token lacks permission to list devices (DCIM > Device needs read access)"
                    .to_string()
            }
        },
        429 => match retry_after {
            Some(ra) => format!("Rate limited by NetBox — retry after {}s", ra),
            None => "Rate limited by NetBox — wait a moment and try again".to_string(),
        },
        s if s >= 500 => format!("NetBox server error (HTTP {})", s),
        s => format!("NetBox API error (HTTP {}): {}", s, body),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::netbox::*;

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

    // ─── Mock HTTP server (plan §10) ──────────────────────────────

    use std::sync::{Arc, Mutex};

    // The server lives in `mock` so the app-level `npm run smoke:netbox`
    // suite drives the same code; the fixtures below are local to these
    // unit tests.
    use crate::netbox::mock::{page, start_mock};

    /// The app-level suite drives this same mock through debug-only Tauri
    /// commands, so its recorder and scenario switch are pinned here.
    #[tokio::test]
    async fn test_mock_netbox_scenarios_and_request_log() {
        let mock = crate::netbox::mock::MockNetBox::start().await;
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

        // A failure after page 1 must surface as an error: the suite relies on
        // this to prove a truncated sync is never treated as success.
        mock.set_scenario("second_page_error").unwrap();
        let err = client
            .fetch_devices(&NetBoxFilters::default())
            .await
            .unwrap_err();
        assert!(err.contains("server error"), "second_page_error -> {}", err);
        let last = mock.requests().last().cloned().unwrap();
        assert!(
            last.path.contains("offset=100"),
            "the second page was never attempted: {}",
            last.path
        );

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

    // ─── Device summary (issue #177 phase 1) ───────────────────────

    fn summary_device_json(id: u64) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "url": format!("http://netbox/api/dcim/devices/{}/", id),
            "display": format!("device-{}", id),
            "name": format!("device-{}", id),
            "status": { "value": "active", "label": "Active" },
            "device_type": {
                "id": 3,
                // NetBox's DeviceType.__str__ returns the model only.
                "display": "C9300-48P",
                "model": "C9300-48P",
                "manufacturer": { "id": 1, "name": "Cisco", "slug": "cisco" }
            },
            "site": { "id": 7, "name": "DC1 London", "display": "DC1 London", "slug": "dc1" },
            "location": { "id": 9, "name": "Rack row 1", "display": "Rack row 1", "slug": "rack-row-1" },
            "rack": { "id": 4, "name": "rack-1", "display": "rack-1", "slug": "rack-1" },
            "position": "12.5",
            "face": { "value": "front", "label": "Front" },
            "primary_ip4": { "id": 21, "family": 4, "address": "10.0.0.1/24" },
            "primary_ip6": null
        })
    }

    fn summary_ip_json(
        id: u64,
        address: &str,
        interface_id: u64,
        interface_name: &str,
        owner_id: u64,
        vrf: Option<&str>,
    ) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "address": address,
            "assigned_object_type": "dcim.interface",
            "assigned_object_id": interface_id,
            "assigned_object": {
                "id": interface_id,
                "url": format!("http://netbox/api/dcim/interfaces/{}/", interface_id),
                "display": interface_name,
                "device": { "id": owner_id, "display": format!("device-{}", owner_id) },
                "name": interface_name
            },
            "vrf": vrf.map(|name| serde_json::json!({ "id": 1, "name": name, "rd": "65000:1" })),
            "status": { "value": "active", "label": "Active" }
        })
    }

    fn summary_empty_endpoint(path: &str) -> Option<(u16, String, Vec<(String, String)>)> {
        if path.starts_with("/api/dcim/interfaces/")
            || path.starts_with("/api/ipam/vlans/")
            || path.starts_with("/api/ipam/prefixes/")
            || path.starts_with("/api/dcim/cables/")
        {
            return Some(page(None, Vec::new()));
        }
        None
    }

    #[tokio::test]
    async fn test_fetch_device_summary_parses_fields() {
        let (base, server) = start_mock(|_| {
            Arc::new(|_, path, _| {
                if path.starts_with("/api/dcim/devices/1/") {
                    (200, summary_device_json(1).to_string(), vec![])
                } else if path.starts_with("/api/ipam/ip-addresses/") {
                    page(
                        None,
                        vec![summary_ip_json(
                            1,
                            "10.0.0.1/24",
                            11,
                            "GigabitEthernet1/0/1",
                            1,
                            None,
                        )],
                    )
                } else if let Some(empty) = summary_empty_endpoint(path) {
                    empty
                } else {
                    (404, "{}".into(), vec![])
                }
            })
        })
        .await;

        let client = NetBoxClient::new(&base, "t", false).unwrap();
        let summary = client.fetch_device_summary(1).await.unwrap();
        assert_eq!(summary.netbox_id, 1);
        assert_eq!(summary.name, "device-1");
        assert_eq!(summary.status, "active");
        assert_eq!(summary.status_label, "Active");
        assert_eq!(summary.device_type.as_deref(), Some("Cisco C9300-48P"));
        assert_eq!(summary.site.as_deref(), Some("DC1 London"));
        assert_eq!(summary.location.as_deref(), Some("Rack row 1"));
        assert_eq!(summary.rack.as_deref(), Some("rack-1"));
        assert_eq!(summary.position, Some(12.5));
        assert_eq!(summary.face.as_deref(), Some("front"));
        assert_eq!(summary.primary_ip.as_deref(), Some("10.0.0.1/24"));
        assert_eq!(summary.interfaces.len(), 1);
        assert!(summary.vlans.is_empty());
        assert!(summary.subnets.is_empty());
        assert!(summary.peers.is_empty());
        server.abort();
    }

    #[test]
    fn test_parse_summary_device_uses_display_when_name_is_null() {
        let mut device = summary_device_json(201);
        device["name"] = serde_json::Value::Null;
        device["display"] = "display-only-device".into();
        let summary = parse_summary_device(&device, 201);
        assert_eq!(summary.name, "display-only-device");
    }

    #[tokio::test]
    async fn test_device_summary_groups_addresses_by_interface() {
        let results = vec![
            summary_ip_json(
                3,
                "2001:db8::10/64",
                12,
                "TenGigabitEthernet1/1/1",
                1,
                Some("blue"),
            ),
            summary_ip_json(1, "10.0.0.11/24", 11, "GigabitEthernet1/0/1", 1, None),
            summary_ip_json(2, "10.0.0.10/24", 11, "GigabitEthernet1/0/1", 1, None),
            // A virtual-chassis sibling's interface: the device_id filter can
            // return it, but the tab must not show it under this device.
            summary_ip_json(4, "192.0.2.1/24", 21, "GigabitEthernet2/0/1", 999, None),
            // Defensive: an unassigned address never belongs in the tab.
            serde_json::json!({
                "id": 5,
                "address": "198.51.100.1/24",
                "assigned_object_type": "dcim.interface",
                "assigned_object": null
            }),
        ];
        let (base, server) = start_mock(move |_| {
            let results = results.clone();
            Arc::new(move |_, path, _| {
                if path.starts_with("/api/dcim/devices/1/") {
                    (200, summary_device_json(1).to_string(), vec![])
                } else if path.starts_with("/api/ipam/ip-addresses/") {
                    page(None, results.clone())
                } else if let Some(empty) = summary_empty_endpoint(path) {
                    empty
                } else {
                    (404, "{}".into(), vec![])
                }
            })
        })
        .await;

        let client = NetBoxClient::new(&base, "t", false).unwrap();
        let summary = client.fetch_device_summary(1).await.unwrap();
        assert_eq!(summary.interfaces.len(), 2);
        assert_eq!(summary.interfaces[0].name, "GigabitEthernet1/0/1");
        let first: Vec<&str> = summary.interfaces[0]
            .addresses
            .iter()
            .map(|address| address.address.as_str())
            .collect();
        assert_eq!(first, vec!["10.0.0.10/24", "10.0.0.11/24"]);
        assert_eq!(summary.interfaces[1].name, "TenGigabitEthernet1/1/1");
        assert_eq!(summary.interfaces[1].addresses.len(), 1);
        assert_eq!(
            summary.interfaces[1].addresses[0].vrf.as_deref(),
            Some("blue")
        );
        server.abort();
    }

    #[tokio::test]
    async fn test_device_summary_request_count_is_fixed() {
        let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let recorder = seen.clone();
        // Which device the current fetch is for. Every request in one fetch is
        // awaited in order, so this is the device the next request belongs to.
        let current: Arc<Mutex<u64>> = Arc::new(Mutex::new(0));
        let current_reader = current.clone();
        let (base, server) = start_mock(move |_| {
            let recorder = recorder.clone();
            let current = current_reader.clone();
            Arc::new(move |_, path, _| {
                recorder.lock().unwrap().push(path.to_string());
                let device = *current.lock().unwrap();
                if let Some(rest) = path.strip_prefix("/api/dcim/devices/") {
                    let head = rest.split('/').next().unwrap_or("");
                    if let Ok(id) = head.parse::<u64>() {
                        *current.lock().unwrap() = id;
                        return (200, summary_device_json(id).to_string(), vec![]);
                    }
                }
                // 1 interface / 2 VLANs / 2 peers vs 48 / 40 / 40.
                let (interfaces, vlans, peers): (u64, u64, u64) = if device == 1 {
                    (1, 2, 2)
                } else {
                    (48, 40, 40)
                };
                if path.starts_with("/api/ipam/ip-addresses/") {
                    let results = (0..interfaces)
                        .map(|index| {
                            summary_ip_json(
                                100 + index,
                                &format!("10.1.{}.{}/24", index / 254, index % 254 + 1),
                                1000 + index,
                                &format!("GigabitEthernet1/0/{}", index + 1),
                                device,
                                None,
                            )
                        })
                        .collect();
                    return page(None, results);
                }
                if path.starts_with("/api/dcim/interfaces/") {
                    let results = (0..interfaces)
                        .map(|index| {
                            serde_json::json!({
                                "id": 1000 + index,
                                "name": format!("GigabitEthernet1/0/{}", index + 1),
                                "device": { "id": device },
                                "untagged_vlan": { "id": 100 + index % vlans },
                                "tagged_vlans": [ { "id": 100 + (index + 1) % vlans } ]
                            })
                        })
                        .collect();
                    return page(None, results);
                }
                if path.starts_with("/api/ipam/vlans/") {
                    let results = (0..vlans)
                        .map(|index| {
                            serde_json::json!({
                                "id": 100 + index,
                                "vid": 1000 + index,
                                "name": format!("vlan-{}", index),
                                "group": { "id": 1, "name": "DC1" }
                            })
                        })
                        .collect();
                    return page(None, results);
                }
                if path.starts_with("/api/ipam/prefixes/") {
                    let mut results: Vec<serde_json::Value> = (0..vlans)
                        .map(|index| {
                            serde_json::json!({
                                "id": 200 + index,
                                "prefix": format!("10.{}.0.0/24", index % 254),
                                "vrf": null,
                                "vlan": { "id": 100 + index }
                            })
                        })
                        .collect();
                    // Contains the first interface address: source (b).
                    results.push(serde_json::json!({
                        "id": 999,
                        "prefix": "10.1.0.0/16",
                        "vrf": null,
                        "vlan": null
                    }));
                    return page(None, results);
                }
                if path.starts_with("/api/dcim/cables/") {
                    let results = (0..peers)
                        .map(|index| {
                            serde_json::json!({
                                "id": 300 + index,
                                "a_terminations": [{
                                    "object_type": "dcim.interface",
                                    "object_id": 1000,
                                    "object": { "device": { "id": device } }
                                }],
                                "b_terminations": [{
                                    "object_type": "dcim.interface",
                                    "object_id": 5000 + index,
                                    "object": { "device": {
                                        "id": 5000 + index,
                                        "name": format!("peer-{}", index),
                                        "display": format!("peer-{}", index)
                                    } }
                                }]
                            })
                        })
                        .collect();
                    return page(None, results);
                }
                if path.starts_with("/api/dcim/devices/") {
                    let results = (0..peers)
                        .map(|index| {
                            serde_json::json!({
                                "id": 5000 + index,
                                "name": format!("peer-{}", index),
                                "display": format!("peer-{}", index),
                                "primary_ip4": { "address": format!("10.9.{}.1/24", index % 254) },
                                "primary_ip6": null
                            })
                        })
                        .collect();
                    return page(None, results);
                }
                (404, "{}".into(), vec![])
            })
        })
        .await;

        let client = NetBoxClient::new(&base, "t", false).unwrap();
        let one = client.fetch_device_summary(1).await.unwrap();
        let one_requests = seen.lock().unwrap().clone();
        seen.lock().unwrap().clear();
        let many = client.fetch_device_summary(2).await.unwrap();
        let many_requests = seen.lock().unwrap().clone();

        assert_eq!(one_requests.len(), 7, "{:?}", one_requests);
        assert_eq!(many_requests.len(), 7, "{:?}", many_requests);
        assert_eq!(one.interfaces.len(), 1);
        assert_eq!(many.interfaces.len(), 48);
        assert_eq!(one.vlans.len(), 2);
        assert_eq!(many.vlans.len(), 40);
        assert_eq!(one.peers.len(), 2);
        assert_eq!(many.peers.len(), 40);
        assert_eq!(one.subnets.len(), 3);
        assert_eq!(many.subnets.len(), 41);
        assert_eq!(
            one.peers[0].primary_ip.as_deref(),
            Some("10.9.0.1/24"),
            "the batched peer-device request must supply the peer primary IP"
        );

        // Identical endpoint set, normalised for the device id. The one-device
        // path requests `display` for the unnamed-device fallback and uses
        // `limit=0` on every list.
        let endpoint = |path: &str| {
            let path = path.split('?').next().unwrap_or(path).to_string();
            path.replace("/api/dcim/devices/1/", "/api/dcim/devices/{id}/")
                .replace("/api/dcim/devices/2/", "/api/dcim/devices/{id}/")
        };
        let mut one_set: Vec<String> = one_requests.iter().map(|p| endpoint(p)).collect();
        let mut many_set: Vec<String> = many_requests.iter().map(|p| endpoint(p)).collect();
        one_set.sort();
        many_set.sort();
        assert_eq!(one_set, many_set);
        assert_eq!(
            one_set,
            vec![
                "/api/dcim/cables/",
                "/api/dcim/devices/",
                "/api/dcim/devices/{id}/",
                "/api/dcim/interfaces/",
                "/api/ipam/ip-addresses/",
                "/api/ipam/prefixes/",
                "/api/ipam/vlans/",
            ]
        );
        assert!(one_requests.iter().any(|path| {
            path.starts_with("/api/dcim/devices/1/")
                && path.contains("fields=")
                && path.contains("display")
        }));
        assert!(one_requests.iter().any(|path| {
            path.starts_with("/api/ipam/ip-addresses/")
                && path.contains("device_id=1")
                && path.contains("limit=0")
        }));
        server.abort();
    }

    #[tokio::test]
    async fn test_device_summary_second_request_error_returns_err() {
        let (base, server) = start_mock(|_| {
            Arc::new(|_, path, _| {
                if path.starts_with("/api/dcim/devices/1/") {
                    (200, summary_device_json(1).to_string(), vec![])
                } else {
                    (403, r#"{"detail":"Forbidden"}"#.into(), vec![])
                }
            })
        })
        .await;

        let client = NetBoxClient::new(&base, "t", false).unwrap();
        let error = client.fetch_device_summary(1).await.unwrap_err();
        assert!(error.contains("lacks permission"), "{}", error);
        // The denied request is the IP-address one; pointing at DCIM Device
        // would send the user to a permission the first request already used.
        assert!(error.contains("IP address"), "{}", error);
        assert!(!error.contains("DCIM > Device"), "{}", error);
        server.abort();
    }

    #[tokio::test]
    async fn test_device_summary_rejects_capped_address_page() {
        // NetBox's `limit=0` is capped by MAX_PAGE_SIZE (1000 by default). A
        // capped page must fail loudly instead of dropping addresses.
        let (base, server) = start_mock(|_| {
            Arc::new(|_, path, _| {
                if path.starts_with("/api/dcim/devices/1/") {
                    (200, summary_device_json(1).to_string(), vec![])
                } else {
                    (
                        200,
                        serde_json::json!({
                            "count": 3,
                            "next": "http://netbox/api/ipam/ip-addresses/?limit=1000&offset=1000",
                            "previous": null,
                            "results": [
                                summary_ip_json(1, "10.0.0.1/24", 11, "Gi1/0/1", 1, None),
                                summary_ip_json(2, "10.0.0.2/24", 11, "Gi1/0/1", 1, None)
                            ]
                        })
                        .to_string(),
                        vec![],
                    )
                }
            })
        })
        .await;

        let client = NetBoxClient::new(&base, "t", false).unwrap();
        let error = client.fetch_device_summary(1).await.unwrap_err();
        assert!(error.contains("2 of 3"), "{}", error);
        assert!(error.contains("MAX_PAGE_SIZE"), "{}", error);
        server.abort();
    }

    #[test]
    fn test_summary_vlans_group_and_dedupe() {
        let results = vec![
            serde_json::json!({ "id": 2, "vid": 20, "name": "voice", "group": { "id": 1, "name": "DC1" } }),
            serde_json::json!({ "id": 1, "vid": 10, "name": "users", "group": { "id": 1, "name": "DC1" } }),
            serde_json::json!({ "id": 3, "vid": 100, "name": "mgmt", "group": { "id": 2, "name": "MGMT" } }),
            // Same id twice: the request filters by id, but the parser must not
            // depend on that.
            serde_json::json!({ "id": 1, "vid": 10, "name": "users", "group": { "id": 1, "name": "DC1" } }),
            serde_json::json!({ "id": 4, "vid": 30, "name": "orphan", "group": null }),
            // Group names are only unique within a scope: this group shares
            // the DC1 name but has a different id, so both ids must survive.
            serde_json::json!({ "id": 5, "vid": 40, "name": "same-name", "group": { "id": 3, "name": "DC1" } }),
        ];
        let vlans = summary_vlans(&results);
        assert_eq!(vlans.len(), 5);
        // Group name, then group id, then VID; a null group sorts first.
        assert_eq!(
            vlans.iter().map(|vlan| vlan.id).collect::<Vec<_>>(),
            vec![4, 1, 2, 5, 3]
        );
        assert_eq!(vlans[0].group, None);
        assert_eq!(vlans[0].group_id, None);
        assert_eq!(vlans[1].group.as_deref(), Some("DC1"));
        assert_eq!(vlans[1].group_id, Some(1));
        assert_eq!(vlans[2].vid, 20);
        assert_eq!(vlans[2].group_id, Some(1));
        assert_eq!(
            vlans[3].group_id,
            Some(3),
            "a same-named group must keep its own id"
        );
        assert_eq!(vlans[3].group.as_deref(), Some("DC1"));
        assert_eq!(vlans[4].group.as_deref(), Some("MGMT"));
        assert_eq!(vlans[4].group_id, Some(2));
    }

    #[test]
    fn test_summary_subnets_union_dedupes_across_sources() {
        let prefixes = vec![
            // Both sources: assigned to VLAN 1 and contains 10.0.0.10/24.
            serde_json::json!({ "id": 10, "prefix": "10.0.0.0/24", "vrf": null, "vlan": { "id": 1 } }),
            // Source (b) only.
            serde_json::json!({ "id": 11, "prefix": "10.0.0.0/16", "vrf": null, "vlan": null }),
            // Source (a) only, in a VRF.
            serde_json::json!({ "id": 12, "prefix": "10.9.0.0/24", "vrf": { "id": 2, "name": "blue" }, "vlan": { "id": 2 } }),
            // Neither source.
            serde_json::json!({ "id": 13, "prefix": "192.0.2.0/24", "vrf": null, "vlan": null }),
            // Contains the address but in a different VRF: not a match.
            serde_json::json!({ "id": 14, "prefix": "10.0.0.0/8", "vrf": { "id": 9, "name": "red" }, "vlan": null }),
            // Duplicate id: one row.
            serde_json::json!({ "id": 10, "prefix": "10.0.0.0/24", "vrf": null, "vlan": { "id": 1 } }),
        ];
        let ips = vec![
            SummaryIpRef {
                address: "10.0.0.10/24".into(),
                vrf_id: None,
            },
            SummaryIpRef {
                address: "2001:db8::1/64".into(),
                vrf_id: None,
            },
        ];
        let subnets = summary_subnets(&prefixes, &[1, 2], &ips);
        assert_eq!(subnets.iter().map(|s| s.id).collect::<Vec<_>>(), vec![11, 10, 12]);
        assert_eq!(subnets[0].prefix, "10.0.0.0/16");
        assert_eq!(subnets[1].prefix, "10.0.0.0/24");
        assert_eq!(subnets[2].vrf.as_deref(), Some("blue"));
    }

    #[test]
    fn test_summary_peers_dedupe_and_skip_self() {
        let cables = vec![
            serde_json::json!({
                "id": 1,
                "a_terminations": [{ "object": { "device": { "id": 201 } } }],
                "b_terminations": [{ "object": { "device": { "id": 202, "name": "peer-b", "display": "Peer B" } } }]
            }),
            // A second cable to the same peer is still one row.
            serde_json::json!({
                "id": 2,
                "a_terminations": [{ "object": { "device": { "id": 201 } } }],
                "b_terminations": [{ "object": { "device": { "id": 202, "name": "peer-b", "display": "Peer B" } } }]
            }),
            // No name: the fallback id form.
            serde_json::json!({
                "id": 3,
                "a_terminations": [{ "object": { "device": { "id": 201 } } }],
                "b_terminations": [{ "object": { "device": { "id": 203 } } }]
            }),
            // Both ends on this device: no peer.
            serde_json::json!({
                "id": 4,
                "a_terminations": [{ "object": { "device": { "id": 201 } } }],
                "b_terminations": [{ "object": { "device": { "id": 201 } } }]
            }),
            // A termination with no device (circuit, power feed) is skipped.
            serde_json::json!({
                "id": 5,
                "a_terminations": [{ "object": { "device": { "id": 201 } } }],
                "b_terminations": [{ "object": null }]
            }),
        ];
        let peers = summary_peers(&cables, 201);
        assert_eq!(peers.len(), 2);
        assert_eq!(peers[0].netbox_id, 203);
        assert_eq!(peers[0].name, "device-203");
        assert_eq!(peers[1].netbox_id, 202);
        assert_eq!(peers[1].name, "peer-b");
        assert_eq!(peers[1].display.as_deref(), Some("Peer B"));
    }

    #[test]
    fn test_ip_contained_handles_both_families() {
        assert!(ip_contained("10.0.0.0/24", "10.0.0.10/24"));
        assert!(ip_contained("10.0.0.0/8", "10.1.2.3/24"));
        assert!(ip_contained("0.0.0.0/0", "203.0.113.1/24"));
        assert!(!ip_contained("10.0.1.0/24", "10.0.0.10/24"));
        assert!(!ip_contained("10.0.0.0/24", "2001:db8::1/64"));
        assert!(ip_contained("2001:db8::/32", "2001:db8:1::1/64"));
        assert!(ip_contained("::/0", "2001:db8::1/64"));
        assert!(!ip_contained("2001:db8:1::/48", "2001:db8:2::1/64"));
        assert!(!ip_contained("not-a-prefix", "10.0.0.1/24"));
    }

    #[tokio::test]
    async fn test_device_summary_rejects_capped_prefix_page() {
        let (base, server) = start_mock(|_| {
            Arc::new(|_, path, _| {
                if path.starts_with("/api/dcim/devices/1/") {
                    (200, summary_device_json(1).to_string(), vec![])
                } else if path.starts_with("/api/ipam/prefixes/") {
                    (
                        200,
                        serde_json::json!({
                            "count": 1001,
                            "next": "http://netbox/api/ipam/prefixes/?limit=1000&offset=1000",
                            "previous": null,
                            "results": [
                                { "id": 1, "prefix": "10.0.0.0/24", "vrf": null, "vlan": null }
                            ]
                        })
                        .to_string(),
                        vec![],
                    )
                } else if path.starts_with("/api/ipam/ip-addresses/") {
                    page(None, Vec::new())
                } else if let Some(empty) = summary_empty_endpoint(path) {
                    empty
                } else {
                    (404, "{}".into(), vec![])
                }
            })
        })
        .await;

        let client = NetBoxClient::new(&base, "t", false).unwrap();
        let error = client.fetch_device_summary(1).await.unwrap_err();
        assert!(error.contains("1 of 1001 prefixes"), "{}", error);
        assert!(error.contains("MAX_PAGE_SIZE"), "{}", error);
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
        // the generic request-builder escape hatch) anywhere in the module.
        // Banned patterns are assembled at runtime so this test's own
        // source never matches itself.
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/src/netbox");
        let mut scanned = 0_usize;
        for entry in std::fs::read_dir(dir)
            .expect("src/netbox/ must be readable for the read-only tripwire")
        {
            let path = entry.unwrap().path();
            if path.extension().and_then(|e| e.to_str()) != Some("rs") {
                continue;
            }
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            let src = std::fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("{} must be readable for the tripwire: {}", name, e));
            scanned += 1;
            for verb in ["post", "put", "patch", "delete", "request"] {
                let builder_call = format!(".{}(", verb);
                assert!(
                    !src.contains(&builder_call),
                    "{} contains '{}' — the NetBox integration is read-only (AGENTS.md); \
                     route reads through readonly_http::ReadOnlyHttp",
                    name,
                    builder_call
                );
                let method_const = format!("::{}", verb.to_uppercase());
                assert!(
                    !src.contains(&method_const),
                    "{} contains '{}' — the NetBox integration is read-only (AGENTS.md)",
                    name,
                    method_const
                );
            }
        }
        assert!(
            scanned >= 6,
            "expected to scan the six netbox module files, scanned {}",
            scanned
        );
    }
}
