//! SSH connection management via russh
//!
//! Handles: connection lifecycle, authentication (password + keyboard-interactive + key),
//! host key verification (TOFU), PTY allocation, and data streaming via Tauri events.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use async_trait::async_trait;
use base64::Engine as _;
use russh::keys::PublicKey;
use russh::{client, ChannelId, Disconnect};
use russh::client::{DisconnectReason, KeyboardInteractiveAuthResponse};
use serde::{Deserialize, Serialize};
use tauri::Emitter;

use crate::state::AppState;
use crate::credentials::{self, ResolvedCredentials};
use crate::netbox;

// ─── Known Hosts ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
struct KnownHostEntry {
    key_type: String,
    key_base64: String,
    first_seen: String,
}

fn known_hosts_path() -> Option<PathBuf> {
    Some(crate::paths::app_data_dir().ok()?.join("known_hosts.json"))
}

fn load_known_hosts() -> HashMap<String, KnownHostEntry> {
    let Some(path) = known_hosts_path() else {
        return HashMap::new();
    };
    if !path.exists() {
        return HashMap::new();
    }
    match std::fs::read_to_string(&path) {
        Ok(data) => serde_json::from_str(&data).unwrap_or_default(),
        Err(_) => HashMap::new(),
    }
}

fn save_known_hosts(hosts: &HashMap<String, KnownHostEntry>) -> Result<(), String> {
    let path = known_hosts_path()
        .ok_or_else(|| "Could not resolve app data dir for known_hosts".to_string())?;
    let data = serde_json::to_string_pretty(hosts).map_err(|e| e.to_string())?;
    crate::paths::secure_write(&path, data.as_bytes())
}

fn key_to_base64(key: &PublicKey) -> String {
    let bytes = key.to_bytes().unwrap_or_default();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn key_type_name(key: &PublicKey) -> String {
    key.algorithm().as_str().to_string()
}

// ─── Auth URL Detection ─────────────────────────────────────────────

// ponytail: first https token wins; upgrade to regex if gateways wrap URLs oddly
fn extract_https_url(text: &str) -> Option<String> {
    text.split_whitespace()
        .find(|w| w.starts_with("https://"))
        .map(|url| {
            url.trim_end_matches(|c: char| matches!(c, '.' | ',' | ')' | '>' | ';' | '\'' | '"'))
                .to_string()
        })
}

// ponytail: global Mutex map; fine at human connect rates, shard per host if throughput ever matters
/// Browser-auth dedup across reconnect attempts. Tailscale check-mode
/// gateways mint a fresh URL token per connection, so reconnects must not
/// re-open the browser — the first open for a given host is enough; the user
/// either already finished the login or the terminal shows the URL anyway.
fn recently_opened_hosts() -> &'static std::sync::Mutex<HashMap<String, std::time::Instant>> {
    use std::sync::Mutex;
    static MAP: std::sync::OnceLock<Mutex<HashMap<String, std::time::Instant>>> = std::sync::OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// True (and records the host) if this host hasn't had an auth URL opened
/// recently. Re-seen within 5 minutes (reconnect loop) → false.
fn should_open_auth_url(host_key: &str) -> bool {
    let mut map = recently_opened_hosts().lock().expect("auth-url map poisoned");
    let now = std::time::Instant::now();
    map.retain(|_, t| now.duration_since(*t) < std::time::Duration::from_secs(5 * 60));
    match map.get(host_key) {
        Some(_) => false,
        None => {
            map.insert(host_key.to_string(), now);
            true
        }
    }
}

/// Choose keyboard-interactive responses for one round of prompts.
/// Browser-auth rounds (a URL is present) get empty answers — the real auth
/// happens in the browser and the server holds the reply until login completes.
/// Credential rounds get the stored password, if we have one.
fn responses_for_round(url_round: bool, stored_password: Option<&str>, n_prompts: usize) -> Vec<String> {
    match (url_round, stored_password) {
        (false, Some(pw)) => vec![pw.to_string(); n_prompts],
        _ => vec![String::new(); n_prompts],
    }
}

/// Pick which agent identities to offer, per the host's agent config (chunk 4).
fn select_agent_keys(agent: &crate::hosts::AgentAuth, keys: Vec<PublicKey>) -> Vec<PublicKey> {
    match agent {
        crate::hosts::AgentAuth::Off => Vec::new(),
        crate::hosts::AgentAuth::All => keys,
        crate::hosts::AgentAuth::Fingerprint(fp) => keys
            .into_iter()
            .filter(|k| crate::secrets::agent::fingerprint_b64(k) == *fp)
            .collect(),
    }
}

fn try_open_auth_url(
    app_handle: &tauri::AppHandle,
    auth_url_opened: &AtomicBool,
    host_key: &str,
    text: &str,
    session_id: u64,
) {
    if let Some(url) = extract_https_url(text) {
        // Atomic check-and-set: the banner callback and the keyboard-interactive
        // loop run on separate tasks and can race. Only the first caller that
        // flips false→true opens the browser; others see true and bail.
        if auth_url_opened
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        log::info!("Auth URL detected: {}", url);
        let _ = app_handle.emit("ssh-auth-url", SshAuthUrlPayload {
            url: url.clone(),
            session_id,
        });
        // Reconnects mint fresh URLs (fresh AtomicBool per attempt) — the
        // per-host recent map is what actually stops the browser-tab storm.
        if should_open_auth_url(host_key) {
            crate::open_url(&url);
        } else {
            log::info!("Auth URL already opened recently for {} — skipping browser open: {}", host_key, url);
        }
    }
}

// ─── Client Handler ─────────────────────────────────────────────────

/// Tauri event payloads
#[derive(Clone, Serialize)]
pub struct SshOutputPayload {
    pub data: String, // base64 encoded bytes
    pub session_id: u64,
}

#[derive(Clone, Serialize)]
pub struct SshEventPayload {
    pub reason: String,
    pub session_id: u64,
}

#[derive(Clone, Serialize)]
pub struct SshAuthUrlPayload {
    pub url: String,
    pub session_id: u64,
}

struct ClientHandler {
    app_handle: tauri::AppHandle,
    host_key: String, // "hostname:port"
    session_id: u64,
    auth_url_opened: Arc<AtomicBool>,
    session_log: Option<crate::session_log::SessionLog>,
}

#[async_trait]
impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        let mut known = load_known_hosts();
        let key_b64 = key_to_base64(server_public_key);
        let key_type = key_type_name(server_public_key);

        if let Some(entry) = known.get(&self.host_key) {
            if entry.key_base64 == key_b64 && entry.key_type == key_type {
                log::info!("Host key verified for {} ({})", self.host_key, key_type);
                return Ok(true);
            } else {
                log::warn!("HOST KEY CHANGED for {} — prev: {}, new: {}", self.host_key, entry.key_type, key_type);
                let _ = self.app_handle.emit("ssh-error", SshEventPayload {
                    reason: format!(
                        "HOST KEY HAS CHANGED for {}. This could indicate a man-in-the-middle attack. \
                         Previous key type: {}, new key type: {}. Connection rejected.",
                        self.host_key, entry.key_type, key_type
                    ),
                    session_id: self.session_id,
                });
                return Ok(false);
            }
        }

        // First time — TOFU: accept and save
        log::info!("TOFU: accepting new host key for {} ({})", self.host_key, key_type);
        // Full SHA-256 fingerprint in standard ssh-keygen format:
        // SHA256:<base64-no-pad>. Matches `ssh-keygen -lf` output so users
        // can compare against ssh-keyscan / known_hosts.
        let fingerprint = format!(
            "SHA256:{}",
            server_public_key.fingerprint(russh::keys::HashAlg::Sha256)
                .to_string()
                .trim_start_matches("SHA256:")
        );
        known.insert(
            self.host_key.clone(),
            KnownHostEntry {
                key_type,
                key_base64: key_b64,
                first_seen: chrono::Utc::now().to_rfc3339(),
            },
        );
        let _ = save_known_hosts(&known);
        let _ = self.app_handle.emit("ssh-tofu", SshEventPayload {
            reason: format!("New host key accepted for {} — fingerprint: {}", self.host_key, fingerprint),
            session_id: self.session_id,
        });
        Ok(true)
    }

    async fn data(
        &mut self,
        _channel: ChannelId,
        data: &[u8],
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        if let Some(ref mut log) = self.session_log {
            log.write(data);
        }
        let encoded = base64::engine::general_purpose::STANDARD.encode(data);
        let _ = self.app_handle.emit("ssh-output", SshOutputPayload { data: encoded, session_id: self.session_id });
        Ok(())
    }

    async fn extended_data(
        &mut self,
        _channel: ChannelId,
        _ext: u32,
        data: &[u8],
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        // stderr output — forward the same way
        if let Some(ref mut log) = self.session_log {
            log.write(data);
        }
        let encoded = base64::engine::general_purpose::STANDARD.encode(data);
        let _ = self.app_handle.emit("ssh-output", SshOutputPayload { data: encoded, session_id: self.session_id });
        Ok(())
    }

    async fn auth_banner(
        &mut self,
        banner: &str,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        if !banner.is_empty() {
            try_open_auth_url(&self.app_handle, &self.auth_url_opened, &self.host_key, banner, self.session_id);
            let encoded = base64::engine::general_purpose::STANDARD.encode(banner.as_bytes());
            let _ = self.app_handle.emit("ssh-output", SshOutputPayload { data: encoded, session_id: self.session_id });
        }
        Ok(())
    }

    async fn channel_close(
        &mut self,
        _channel: ChannelId,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        log::info!("SSH channel closed for {}", self.host_key);
        let _ = self.app_handle.emit("ssh-disconnected", SshEventPayload {
            reason: "channel_closed".to_string(),
            session_id: self.session_id,
        });
        Ok(())
    }

    async fn channel_eof(
        &mut self,
        _channel: ChannelId,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        log::info!("SSH channel EOF for {}", self.host_key);
        let _ = self.app_handle.emit("ssh-disconnected", SshEventPayload {
            reason: "channel_eof".to_string(),
            session_id: self.session_id,
        });
        Ok(())
    }

    async fn disconnected(
        &mut self,
        reason: DisconnectReason<Self::Error>,
    ) -> Result<(), Self::Error> {
        log::info!("SSH disconnected for {}", self.host_key);
        let _ = self.app_handle.emit("ssh-disconnected", SshEventPayload {
            reason: "connection_lost".to_string(),
            session_id: self.session_id,
        });
        match reason {
            DisconnectReason::ReceivedDisconnect(_) => Ok(()),
            DisconnectReason::Error(e) => Err(e),
        }
    }
}

// ─── SSH Session ────────────────────────────────────────────────────

pub struct SshSession {
    session: client::Handle<ClientHandler>,
    channel: russh::Channel<client::Msg>,
    pub session_id: u64,
}

impl SshSession {
    pub async fn connect(
        app_handle: tauri::AppHandle,
        hostname: &str,
        port: u16,
        username: &str,
        password: Option<&str>,
        key_path: Option<&str>,
        agent: crate::hosts::AgentAuth,
        cols: u32,
        rows: u32,
        session_id: u64,
        session_logging: bool,
        session_log_timestamps: bool,
        session_log_dir: Option<String>,
    ) -> Result<Self, String> {
        log::info!("SSH connecting to {}:{} as '{}' ({}x{})", hostname, port, username, cols, rows);

        // Build russh config
        let config = Arc::new(client::Config {
            keepalive_interval: Some(std::time::Duration::from_secs(15)),
            keepalive_max: 3,
            ..Default::default()
        });

        let host_key = format!("{}:{}", hostname, port);
        let auth_url_opened = Arc::new(AtomicBool::new(false));

        let session_log = if session_logging {
            match session_log_dir.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                Some(dir) => Some(crate::session_log::SessionLog::new_in(
                    std::path::Path::new(dir),
                    &host_key,
                    session_id,
                    session_log_timestamps,
                )),
                None => Some(crate::session_log::SessionLog::new(&host_key, session_id, session_log_timestamps)),
            }
        } else {
            None
        };

        let handler = ClientHandler {
            app_handle: app_handle.clone(),
            host_key,
            session_id,
            auth_url_opened: auth_url_opened.clone(),
            session_log,
        };

        // Connect
        let addr = format!("{}:{}", hostname, port);
        log::info!("SSH TCP connecting to {}", addr);
        let mut session = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            client::connect(config, &addr, handler),
        )
        .await
        .map_err(|_| format!("Connection timed out after 10s to {}", addr))?
        .map_err(|e| format!("Failed to connect to {}: {}", addr, e))?;

        log::info!("SSH TCP connected to {}", addr);

        // Authenticate (with timeout to prevent indefinite hangs).
        // 120s: browser-auth gateways (Tailscale check mode) hold auth open while
        // the user authenticates in the browser — 20s was not enough for a human.
        let auth_success = tokio::time::timeout(
            std::time::Duration::from_secs(120),
            Self::authenticate(&app_handle, &mut session, &addr, username, password, key_path, agent, session_id, &auth_url_opened),
        )
        .await
        .map_err(|_| format!("Authentication timed out after 120s for {}@{}", username, addr))?
        ?;

        if !auth_success {
            log::warn!("SSH authentication failed for {}@{}", username, addr);
            return Err("Authentication failed — server rejected all offered methods (SSH key, password, keyboard-interactive). Check the host's saved credentials.".to_string());
        }

        log::info!("SSH authenticated successfully as {}@{}", username, addr);

        // Open channel and allocate PTY (with timeout)
        let setup = async {
            let channel = session
                .channel_open_session()
                .await
                .map_err(|e| format!("Failed to open session channel: {}", e))?;

            channel
                .request_pty(
                    false,
                    "xterm-256color",
                    cols,
                    rows,
                    0,
                    0,
                    &[],
                )
                .await
                .map_err(|e| format!("Failed to allocate PTY: {}", e))?;

            channel
                .request_shell(false)
                .await
                .map_err(|e| format!("Failed to request shell: {}", e))?;

            Ok::<_, String>(channel)
        };

        let channel = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            setup,
        )
        .await
        .map_err(|_| format!("Channel setup timed out after 10s for {}", addr))?
        ?;

        log::info!("SSH session ready for {}", addr);

        // Emit connected event with session_id
        let _ = app_handle.emit("ssh-connected", SshEventPayload {
            reason: "ok".to_string(),
            session_id,
        });

        Ok(SshSession {
            session,
            channel,
            session_id,
        })
    }

    async fn authenticate(
        app_handle: &tauri::AppHandle,
        session: &mut client::Handle<ClientHandler>,
        host_key_addr: &str,
        username: &str,
        password: Option<&str>,
        key_path: Option<&str>,
        agent: crate::hosts::AgentAuth,
        session_id: u64,
        auth_url_opened: &Arc<AtomicBool>,
    ) -> Result<bool, String> {
        // Agent publickey auth — first in the chain (chunk 4). The agent socket is
        // opened per connect attempt and dropped when this function returns.
        if agent != crate::hosts::AgentAuth::Off {
            let mut client = crate::secrets::agent::connect_agent().await?;
            let keys = client
                .request_identities()
                .await
                .map_err(|e| format!("Failed to query SSH agent identities: {}", e))?;
            let mut offered = false;
            for key in select_agent_keys(&agent, keys) {
                offered = true;
                let fp = crate::secrets::agent::fingerprint_b64(&key);
                log::info!("Attempting agent publickey auth ({fp})");
                // The future of `authenticate_publickey_with` is Send only for
                // specific lifetimes (Signer has no Send bound), which breaks
                // the tauri command's higher-ranked Send requirement. Running
                // it via block_on keeps the borrows synchronous — no Send
                // needed. The same agent socket signs every identity in turn.
                // ponytail: requires a multi-thread runtime (tauri default).
                let result = tokio::task::block_in_place(|| {
                    tokio::runtime::Handle::current().block_on(
                        session.authenticate_publickey_with(username, key, &mut client),
                    )
                })
                .map_err(|e| e.to_string());
                match result {
                    Ok(true) => return Ok(true),
                    Ok(false) => log::info!("Agent identity {fp} rejected by server"),
                    Err(e) => {
                        log::warn!("Agent auth error: {}", e);
                        break;
                    }
                }
            }
            if !offered {
                return Err(match &agent {
                    crate::hosts::AgentAuth::Fingerprint(fp) => format!(
                        "No SSH agent identity with fingerprint {} — run `ssh-add` for that key or pick another identity",
                        fp
                    ),
                    _ => "SSH agent has no identities — run `ssh-add <key>`".to_string(),
                });
            }
        }

        // SSH key auth — only when the host is configured with a key path.
        if let Some(key_path) = key_path {
            let path = Path::new(key_path);
            if path.exists() {
                log::info!("Attempting SSH key auth with {}", key_path);
                // RSA signatures need an explicit hash alg (SHA-1 is dead);
                // everything else ignores it.
                let loaded = russh::keys::load_secret_key(path, None).and_then(|key| {
                    let hash = if key.algorithm().is_rsa() {
                        Some(russh::keys::HashAlg::Sha256)
                    } else {
                        None
                    };
                    russh::keys::key::PrivateKeyWithHashAlg::new(Arc::new(key), hash)
                });
                match loaded {
                    Ok(key) => {
                        let auth_result = session
                            .authenticate_publickey(username, key)
                            .await
                            .map_err(|e| format!("Key auth error: {}", e))?;
                        if auth_result {
                            return Ok(true);
                        }
                        // Key auth failed, fall through to password
                    }
                    Err(e) => {
                        log::warn!("Failed to load SSH key {}: {}. Falling back to password.", key_path, e);
                    }
                }
            }
        }

        // Try password auth (if a password was provided). Keep it around so we can
        // answer keyboard-interactive prompts with it if the server prefers that method.
        let stored_password: Option<String> = password.map(|p| p.to_string());
        if let Some(password) = &stored_password {
            log::info!("Attempting password auth");
            let auth_result = session
                .authenticate_password(username, password)
                .await
                .map_err(|e| format!("Password auth error: {}", e))?;
            if auth_result {
                return Ok(true);
            }
        }

        // Browser-auth gateway rescue (Tailscale check mode): a host with no key
        // path and no stored password has nothing to offer — but check-mode
        // gateways accept ANY publickey to open the session, then print a login
        // URL in the terminal. Offer an ephemeral key, mirroring `tailscale ssh`.
        // Normal servers reject the unknown key and we fall through.
        if stored_password.is_none() && key_path.is_none() {
            log::info!("No credentials configured — trying ephemeral key auth (browser-auth gateways)");
            let key = russh::keys::PrivateKey::random(
                &mut russh::keys::key::safe_rng(),
                russh::keys::Algorithm::Ed25519,
            )
            .map_err(|e| e.to_string())
            .and_then(|key| {
                russh::keys::key::PrivateKeyWithHashAlg::new(Arc::new(key), None)
                    .map_err(|e| e.to_string())
            });
            match key {
                Ok(key) => match session.authenticate_publickey(username, key).await {
                    Ok(true) => return Ok(true),
                    Ok(false) => log::info!("Ephemeral key rejected — server requires configured credentials"),
                    Err(e) => log::info!("Ephemeral key auth error: {}", e),
                },
                Err(e) => log::info!("Ephemeral key generation failed: {}", e),
            }
        }

        // Fallback: keyboard-interactive auth, as a bounded multi-round loop.
        // Two server families land here:
        //  - Browser-auth gateways (Tailscale check mode): prompts carry a login URL.
        //    We open it, reply with EMPTY responses, and the server holds that reply
        //    open until the user finishes the browser login — then answers Success.
        //    The respond().await below IS the browser wait (bounded by the 120s
        //    timeout in connect()).
        //  - Cisco/F5 style: prompts ask for the password → answer with the stored one.
        log::info!("Attempting keyboard-interactive auth");
        let mut current = session
            .authenticate_keyboard_interactive_start(username, None::<String>)
            .await;
        for round in 1..=5u32 {
            match current {
                Ok(KeyboardInteractiveAuthResponse::InfoRequest { instructions, prompts, .. }) => {
                    // Open auth URL in browser (first one only) and detect whether
                    // this round is a browser-auth round.
                    try_open_auth_url(app_handle, auth_url_opened, host_key_addr, &instructions, session_id);
                    let mut url_round = extract_https_url(&instructions).is_some();
                    if !instructions.is_empty() {
                        log::info!("Keyboard-interactive instructions: {}", instructions);
                        let encoded = base64::engine::general_purpose::STANDARD.encode(instructions.as_bytes());
                        let _ = app_handle.emit("ssh-output", SshOutputPayload { data: encoded, session_id });
                    }
                    for prompt in &prompts {
                        try_open_auth_url(app_handle, auth_url_opened, host_key_addr, &prompt.prompt, session_id);
                        url_round |= extract_https_url(&prompt.prompt).is_some();
                        if !prompt.prompt.is_empty() {
                            let encoded = base64::engine::general_purpose::STANDARD.encode(prompt.prompt.as_bytes());
                            let _ = app_handle.emit("ssh-output", SshOutputPayload { data: encoded, session_id });
                        }
                    }
                    let responses = responses_for_round(url_round, stored_password.as_deref(), prompts.len());
                    log::info!(
                        "Keyboard-interactive round {} ({} prompt(s), {} round) — responding",
                        round, prompts.len(), if url_round { "browser-auth" } else { "credential" }
                    );
                    current = session.authenticate_keyboard_interactive_respond(responses).await;
                }
                Ok(KeyboardInteractiveAuthResponse::Success) => {
                    log::info!("Keyboard-interactive auth succeeded");
                    return Ok(true);
                }
                Ok(KeyboardInteractiveAuthResponse::Failure) => {
                    log::info!("Keyboard-interactive auth rejected (server refused method or credentials)");
                    return Ok(false);
                }
                Err(e) => {
                    log::info!("Keyboard-interactive auth not available: {}", e);
                    return Ok(false);
                }
            }
        }
        log::warn!("Keyboard-interactive auth exceeded 5 rounds without resolution");
        Ok(false)
    }

    pub async fn send(&self, data: &[u8]) -> Result<(), String> {
        self.channel
            .data(&data[..])
            .await
            .map_err(|e| format!("Failed to send data: {}", e))
    }

    pub async fn resize(&self, cols: u32, rows: u32) -> Result<(), String> {
        log::debug!("SSH PTY resize to {}x{}", cols, rows);
        self.channel
            .window_change(cols, rows, 0, 0)
            .await
            .map_err(|e| format!("Failed to resize PTY: {}", e))
    }

    pub async fn disconnect(self) -> Result<(), String> {
        log::info!("SSH disconnect requested");
        self.session
            .disconnect(Disconnect::ByApplication, "User disconnect", "en")
            .await
            .map_err(|e| format!("Disconnect error: {}", e))
    }
}

// ─── Session Map (testable core) ────────────────────────────────────

/// Keyed session registry. Generic so unit tests can exercise the
/// insert/take/get/route logic without constructing a real SshSession
/// (whose russh handles need a live TCP connection).
pub struct SessionMap<S> {
    sessions: HashMap<u64, S>,
}

impl<S> SessionMap<S> {
    pub fn new() -> Self {
        Self { sessions: HashMap::new() }
    }

    pub fn insert_with(&mut self, id: u64, s: S) {
        self.sessions.insert(id, s);
    }

    pub fn get(&self, id: u64) -> Option<&S> {
        self.sessions.get(&id)
    }

    pub fn take(&mut self, id: u64) -> Option<S> {
        self.sessions.remove(&id)
    }

    pub fn contains(&self, id: u64) -> bool {
        self.sessions.contains_key(&id)
    }

    /// Number of active sessions.
    pub fn len(&self) -> usize {
        self.sessions.len()
    }

    /// Routing guard for ssh_send / ssh_resize — the Tauri command locks
    /// state, calls this, then performs the real send/resize on the session.
    pub fn route_send(&self, id: u64) -> Result<(), String> {
        if self.contains(id) { Ok(()) } else { Err("No such session".to_string()) }
    }

    pub fn route_resize(&self, id: u64, _cols: u32, _rows: u32) -> Result<(), String> {
        if self.contains(id) { Ok(()) } else { Err("No such session".to_string()) }
    }
}

// ─── Session Manager (app state) ───────────────────────────────────

pub struct SshManager {
    sessions: SessionMap<SshSession>,
    #[cfg(debug_assertions)]
    test_server_handle: Option<tokio::task::JoinHandle<()>>,
}

impl SshManager {
    pub fn new() -> Self {
        SshManager {
            sessions: SessionMap::new(),
            #[cfg(debug_assertions)]
            test_server_handle: None,
        }
    }

    pub fn insert_session(&mut self, session: SshSession) {
        self.sessions.insert_with(session.session_id, session);
    }

    /// Current number of active sessions.
    pub fn session_count(&self) -> usize {
        self.sessions.len()
    }

    pub fn take_session(&mut self, session_id: u64) -> Option<SshSession> {
        self.sessions.take(session_id)
    }

    pub fn get_session(&self, session_id: u64) -> Option<&SshSession> {
        self.sessions.get(session_id)
    }

    pub fn route_send(&self, session_id: u64) -> Result<(), String> {
        self.sessions.route_send(session_id)
    }

    pub fn route_resize(&self, session_id: u64, cols: u32, rows: u32) -> Result<(), String> {
        self.sessions.route_resize(session_id, cols, rows)
    }

    #[cfg(debug_assertions)]
    pub fn set_test_server_handle(&mut self, handle: tokio::task::JoinHandle<()>) {
        self.test_server_handle = Some(handle);
    }

    #[cfg(debug_assertions)]
    pub fn take_test_server_handle(&mut self) -> Option<tokio::task::JoinHandle<()>> {
        self.test_server_handle.take()
    }
}

// ─── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    struct DummySession;

    fn map_with(ids: &[u64]) -> SessionMap<DummySession> {
        let mut m = SessionMap::new();
        for &id in ids {
            m.insert_with(id, DummySession);
        }
        m
    }

    #[test]
    fn test_insert_and_get() {
        let m = map_with(&[1]);
        assert!(m.get(1).is_some());
        assert!(m.get(2).is_none());
    }

    #[test]
    fn test_take_removes() {
        let mut m = map_with(&[1]);
        assert!(m.take(1).is_some());
        assert!(m.get(1).is_none());
        assert!(m.take(1).is_none());
    }

    #[test]
    fn test_distinct_ids_coexist() {
        let m = map_with(&[1, 2]);
        assert!(m.get(1).is_some());
        assert!(m.get(2).is_some());
    }

    #[test]
    fn test_duplicate_id_overwrites() {
        // Pins the contract: duplicate ids overwrite (HashMap semantics).
        // The frontend must mint unique ids; a future "reject duplicate"
        // guard in the backend would fail this test loudly.
        let mut m = SessionMap::new();
        m.insert_with(1, DummySession);
        m.insert_with(1, DummySession);
        // Exactly one entry: second take yields nothing.
        assert!(m.take(1).is_some());
        assert!(m.take(1).is_none());
    }

    #[test]
    fn test_session_count() {
        assert_eq!(map_with(&[]).len(), 0);
        assert_eq!(map_with(&[1]).len(), 1);
        assert_eq!(map_with(&[1, 2, 3]).len(), 3);
        // Duplicate inserts overwrite — count stays at 1
        let mut m = SessionMap::new();
        m.insert_with(1, DummySession);
        m.insert_with(1, DummySession);
        assert_eq!(m.len(), 1);
        // Take reduces count
        m.take(1);
        assert_eq!(m.len(), 0);
    }

    #[test]
    fn test_route_send_by_session_id() {
        let m = map_with(&[1, 2]);
        assert!(m.route_send(1).is_ok());
        assert!(m.route_send(2).is_ok());
        assert!(m.route_send(3).is_err());
    }

    #[test]
    fn test_route_resize_unknown_id_errors() {
        let m = map_with(&[1]);
        assert!(m.route_resize(1, 80, 24).is_ok());
        assert!(m.route_resize(99, 80, 24).is_err());
    }

    #[test]
    fn test_responses_for_round_browser_auth_gets_empty_answers() {
        // Even with a stored password, URL rounds must answer empty —
        // the browser login is the real auth.
        assert_eq!(responses_for_round(true, Some("pw"), 2), vec!["", ""]);
        assert_eq!(responses_for_round(true, None, 1), vec![""]);
    }

    #[test]
    fn test_responses_for_round_credential_rounds_use_password() {
        assert_eq!(responses_for_round(false, Some("pw"), 2), vec!["pw", "pw"]);
        // No stored password on a credential round — empty best-effort answer.
        assert_eq!(responses_for_round(false, None, 1), vec![""]);
        assert_eq!(responses_for_round(false, Some("pw"), 0), Vec::<String>::new());
    }

    #[test]
    fn test_select_agent_keys_filters_by_fingerprint() {
        use crate::hosts::AgentAuth;
        use crate::secrets::agent::fingerprint_b64;
        use russh::keys::key::safe_rng;
        let key = |()| {
            russh::keys::PrivateKey::random(&mut safe_rng(), russh::keys::Algorithm::Ed25519)
                .unwrap()
                .public_key()
                .clone()
        };
        let k1 = key(());
        let k2 = key(());
        let fp1 = fingerprint_b64(&k1);
        let keys = vec![k1, k2];

        assert_eq!(select_agent_keys(&AgentAuth::All, keys.clone()).len(), 2);

        let sel = select_agent_keys(&AgentAuth::Fingerprint(fp1.clone()), keys.clone());
        assert_eq!(sel.len(), 1);
        assert_eq!(fingerprint_b64(&sel[0]), fp1);

        // Unknown fingerprint offers nothing — caller turns that into a clean error.
        assert!(select_agent_keys(&AgentAuth::Fingerprint("nonexistent".into()), keys.clone()).is_empty());
        assert!(select_agent_keys(&AgentAuth::Off, keys).is_empty());
    }

    #[test]
    fn test_fingerprint_b64_matches_russh046_format() {
        // 0.46 format: sha256 → base64 no-pad, no "SHA256:" prefix (43 chars).
        let key = russh::keys::PrivateKey::random(
            &mut russh::keys::key::safe_rng(),
            russh::keys::Algorithm::Ed25519,
        )
        .unwrap()
        .public_key()
        .clone();
        let fp = crate::secrets::agent::fingerprint_b64(&key);
        assert_eq!(fp.len(), 43);
        assert!(!fp.contains(':'));
        assert!(fp.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/'));
    }

    #[test]
    fn test_extract_https_url_finds_and_trims() {
        assert_eq!(
            extract_https_url("visit https://login.tailscale.com/a/abc123, thanks."),
            Some("https://login.tailscale.com/a/abc123".to_string())
        );
        assert_eq!(extract_https_url("Password:"), None);
    }

    #[test]
    fn test_should_open_auth_url_dedupes_per_host() {
        // First open for a host → true; immediate reconnect (fresh URL token,
        // same host) → false; different host → true.
        let host = "dedupe-test-host:22";
        let other = "dedupe-test-host:2222";
        assert!(should_open_auth_url(host));
        assert!(!should_open_auth_url(host));
        assert!(should_open_auth_url(other));
    }
}

// ─── SSH Commands ───────────────────────────────────────────────────

#[tauri::command]
pub async fn ssh_connect(
    app_handle: tauri::AppHandle,
    host_id: String,
    cols: u32,
    rows: u32,
    session_id: u64,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    // Resolve connection parameters Rust-side — secrets never enter the
    // webview. HostStore first (fast path), then the NetBox cache for
    // `netbox:` ids (plan §8.3). All std-Mutex guards are dropped before
    // any await point.
    let (hostname, port, username, credential, secret_key) = {
        let hosts = state.hosts.lock().map_err(|e| e.to_string())?;
        match hosts.get_all()?.into_iter().find(|h| h.id == host_id) {
            Some(host) => (
                host.hostname,
                host.port,
                host.username,
                host.credential,
                credentials::host_key(&host_id),
            ),
            None if netbox::is_netbox_host_id(&host_id) => {
                log::info!("Connecting to NetBox-sourced host {}", host_id);
                // Clone the device out, then read source config separately
                // (sequential locks — never nested).
                let device = {
                    drop(hosts);
                    let netbox = state.netbox.lock().map_err(|e| e.to_string())?;
                    netbox
                        .find_by_host_id(&host_id)
                        .filter(|d| d.enabled)
                        .ok_or_else(|| format!("Host not found: {}", host_id))?
                };
                let netbox_cfg = {
                    let config = state.config.lock().map_err(|e| e.to_string())?;
                    netbox::NetBoxConfig::from_json(config.host_source_config("netbox"))
                };

                // Overlay wins over source defaults (plan §6)
                let p = netbox::resolve_connect_params(&device, &netbox_cfg)?;
                (p.hostname, p.port, p.username, p.credential, p.secret_key)
            }
            None => return Err(format!("Host not found: {}", host_id)),
        }
    };

    // Enforce max concurrent sessions. 0 = unlimited. Check before connecting
    // so we don't consume a TCP connection + auth round-trip just to reject.
    let max_sessions = {
        let config = state.config.lock().map_err(|e| e.to_string())?;
        config.get().max_sessions
    };
    if max_sessions > 0 {
        let mgr = state.ssh.lock().await;
        let current = mgr.session_count();
        if current >= max_sessions as usize {
            return Err(format!(
                "Session limit reached ({} of {}). Disconnect a session or raise the limit in Settings → Terminal.",
                current, max_sessions
            ));
        }
    }

    // Resolve credentials Rust-side — secrets never enter the webview.
    // The provider registry is cloned out before the await: `providers` is
    // a std Mutex and its guard must not be held across an await point.
    // The resolved secret is transient: dropped when `creds` dies at the
    // end of this fn, never logged or persisted.
    let registry = state.providers.lock().map_err(|e| e.to_string())?.clone();
    let creds = match credential.as_ref() {
        Some(credential) => credentials::resolve(credential, &secret_key, &registry).await?,
        None => ResolvedCredentials::default(),
    };

    let (session_logging, session_log_timestamps, session_log_dir) = {
        let config = state.config.lock().map_err(|e| e.to_string())?;
        let c = config.get();
        (c.session_logging, c.session_log_timestamps, c.session_log_dir.clone())
    };

    let session = SshSession::connect(
        app_handle,
        &hostname,
        port,
        &username,
        creds.password.as_deref(),
        creds.key_path.as_deref(),
        creds.agent,
        cols,
        rows,
        session_id,
        session_logging,
        session_log_timestamps,
        session_log_dir,
    )
    .await?;

    let mut mgr = state.ssh.lock().await;
    mgr.insert_session(session);
    Ok(())
}

#[tauri::command]
pub async fn ssh_send(
    session_id: u64,
    data: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mgr = state.ssh.lock().await;
    mgr.route_send(session_id)?;
    let session = mgr.get_session(session_id)
        .ok_or_else(|| "Session not found".to_string())?;
    session.send(data.as_bytes()).await
}

#[tauri::command]
pub async fn ssh_disconnect(
    session_id: u64,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mut mgr = state.ssh.lock().await;
    match mgr.take_session(session_id) {
        Some(session) => session.disconnect().await,
        None => Ok(()),
    }
}

#[tauri::command]
pub async fn ssh_resize(
    session_id: u64,
    cols: u32,
    rows: u32,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mgr = state.ssh.lock().await;
    mgr.route_resize(session_id, cols, rows)?;
    let session = mgr.get_session(session_id)
        .ok_or_else(|| "Session not found".to_string())?;
    session.resize(cols, rows).await
}
