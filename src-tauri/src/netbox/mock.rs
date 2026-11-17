//! Debug-gated in-process NetBox HTTP mock shared by the unit tests and the
//! app-level `npm run smoke:netbox` suite. Compiled for tests and debug builds
//! only — never into a release binary.

use std::sync::{Arc, Mutex};
use std::time::Duration;
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
pub(crate) const SCENARIOS: [&str; 7] = [
    "ok",
    "refresh",
    "unauthorized",
    "forbidden",
    "throttled",
    "server_error",
    "second_page_error",
];

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
            // Page 1 already reached the client, so the suite uses this to
            // prove a mid-sync error is never persisted as a truncated sync.
            if scenario == "second_page_error" {
                return error_response("server_error").expect("the server_error fixture must exist");
            }
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
