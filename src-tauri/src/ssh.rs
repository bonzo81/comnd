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
use russh::keys::key::PublicKey;
use russh::{client, ChannelId, Disconnect};
use russh::client::{DisconnectReason, KeyboardInteractiveAuthResponse};
use serde::{Deserialize, Serialize};
use tauri::Emitter;

// ─── Known Hosts ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
struct KnownHostEntry {
    key_type: String,
    key_base64: String,
    first_seen: String,
}

fn known_hosts_path() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("netsh")
        .join("known_hosts.json")
}

fn load_known_hosts() -> HashMap<String, KnownHostEntry> {
    let path = known_hosts_path();
    if !path.exists() {
        return HashMap::new();
    }
    match std::fs::read_to_string(&path) {
        Ok(data) => serde_json::from_str(&data).unwrap_or_default(),
        Err(_) => HashMap::new(),
    }
}

fn save_known_hosts(hosts: &HashMap<String, KnownHostEntry>) -> Result<(), String> {
    let path = known_hosts_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let data = serde_json::to_string_pretty(hosts).map_err(|e| e.to_string())?;
    std::fs::write(&path, data).map_err(|e| e.to_string())
}

fn key_to_base64(key: &PublicKey) -> String {
    use russh_keys::PublicKeyBase64;
    key.public_key_base64()
}

fn key_type_name(key: &PublicKey) -> String {
    key.name().to_string()
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

fn try_open_auth_url(
    app_handle: &tauri::AppHandle,
    auth_url_opened: &AtomicBool,
    text: &str,
    session_id: u64,
) {
    if auth_url_opened.load(Ordering::Relaxed) {
        return;
    }
    if let Some(url) = extract_https_url(text) {
        auth_url_opened.store(true, Ordering::Relaxed);
        log::info!("Auth URL detected: {}", url);
        let _ = app_handle.emit("ssh-auth-url", SshAuthUrlPayload {
            url: url.clone(),
            session_id,
        });
        crate::open_url(&url);
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
        let fingerprint = format!("SHA256:{}", &key_b64[..16.min(key_b64.len())]);
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
            try_open_auth_url(&self.app_handle, &self.auth_url_opened, banner, self.session_id);
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
        cols: u32,
        rows: u32,
        session_id: u64,
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

        let handler = ClientHandler {
            app_handle: app_handle.clone(),
            host_key,
            session_id,
            auth_url_opened: auth_url_opened.clone(),
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
            Self::authenticate(&app_handle, &mut session, username, password, key_path, session_id, &auth_url_opened),
        )
        .await
        .map_err(|_| format!("Authentication timed out after 120s for {}@{}", username, addr))?
        ?;

        if !auth_success {
            log::warn!("SSH authentication failed for {}@{}", username, addr);
            return Err("Authentication failed — server rejected all offered methods (default SSH keys, password, keyboard-interactive). Check the host's saved credentials.".to_string());
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
        username: &str,
        password: Option<&str>,
        key_path: Option<&str>,
        session_id: u64,
        auth_url_opened: &Arc<AtomicBool>,
    ) -> Result<bool, String> {
        // Try SSH key auth first if key path provided
        if let Some(key_path) = key_path {
            let path = Path::new(key_path);
            if path.exists() {
                log::info!("Attempting SSH key auth with {}", key_path);
                match russh_keys::load_secret_key(path, None) {
                    Ok(key) => {
                        let auth_result = session
                            .authenticate_publickey(username, Arc::new(key))
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

        // Default keys (OpenSSH behavior) when no explicit key configured:
        // ~/.ssh/id_ed25519, id_rsa, id_ecdsa
        // ponytail: gated on key_path.is_none(); also run after explicit-key failure if that ever confuses users
        if key_path.is_none() {
            if let Some(home) = dirs::home_dir() {
                for name in ["id_ed25519", "id_rsa", "id_ecdsa"] {
                    let path = home.join(".ssh").join(name);
                    if !path.exists() {
                        continue;
                    }
                    log::info!("Attempting default SSH key {}", path.display());
                    match russh_keys::load_secret_key(&path, None) {
                        Ok(key) => {
                            match session
                                .authenticate_publickey(username, Arc::new(key))
                                .await
                            {
                                Ok(true) => return Ok(true),
                                Ok(false) => {
                                    log::info!("Default key {} rejected by server", path.display())
                                }
                                Err(e) => {
                                    log::warn!("Default key {} auth error: {}", path.display(), e)
                                }
                            }
                        }
                        Err(e) => log::warn!(
                            "Failed to load default key {}: {} (passphrase-protected keys unsupported)",
                            path.display(),
                            e
                        ),
                    }
                }
            }
        }

        // Try password auth
        if let Some(password) = password {
            log::info!("Attempting password auth");
            let auth_result = session
                .authenticate_password(username, password)
                .await
                .map_err(|e| format!("Password auth error: {}", e))?;
            if auth_result {
                return Ok(true);
            }
        }

        // Fallback: try keyboard-interactive auth
        // Some servers (e.g. Tailscale) send auth URLs or instructions via
        // keyboard-interactive prompts rather than rejecting auth outright.
        // We attempt it to capture those prompts for the user, even though
        // we can't complete the interactive flow.
        log::info!("Attempting keyboard-interactive auth as fallback");
        match session
            .authenticate_keyboard_interactive_start(username, None::<String>)
            .await
        {
            Ok(KeyboardInteractiveAuthResponse::InfoRequest { instructions, prompts, .. }) => {
                try_open_auth_url(app_handle, auth_url_opened, &instructions, session_id);
                for prompt in &prompts {
                    try_open_auth_url(app_handle, auth_url_opened, &prompt.prompt, session_id);
                }
                // Forward the server's instructions/prompts to the frontend as ssh-output
                // so the user can see any auth URLs or instructions
                if !instructions.is_empty() {
                    log::info!("Keyboard-interactive instructions: {}", instructions);
                    let encoded = base64::engine::general_purpose::STANDARD.encode(instructions.as_bytes());
                    let _ = app_handle.emit("ssh-output", SshOutputPayload { data: encoded, session_id });
                }
                for prompt in &prompts {
                    if !prompt.prompt.is_empty() {
                        let encoded = base64::engine::general_purpose::STANDARD.encode(prompt.prompt.as_bytes());
                        let _ = app_handle.emit("ssh-output", SshOutputPayload { data: encoded, session_id });
                    }
                }
                // Don't attempt to respond — auth will fail, but the user saw the prompts
                log::warn!("Keyboard-interactive auth started but no interactive handler — auth will fail");
            }
            Ok(_) => {
                // Success or Failure with no info request — nothing to forward
                log::info!("Keyboard-interactive auth returned {:?}; no prompts to show", "non-info");
            }
            Err(e) => {
                log::info!("Keyboard-interactive auth not available: {}", e);
            }
        }

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
}
