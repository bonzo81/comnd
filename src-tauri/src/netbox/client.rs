//! NetBox REST client — device parsing, pagination, and the read-only HTTP
//! guard. Every request the app makes to a NetBox instance goes through
//! `ReadOnlyHttp` below.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::{NetBoxChoice, NetBoxFilters, NetBoxGeo, NetBoxGeoNode};

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
