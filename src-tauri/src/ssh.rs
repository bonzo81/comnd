//! SSH connection management via russh
//!
//! Handles: connection lifecycle, authentication (password + keyboard-interactive + key),
//! host key verification (TOFU), PTY allocation, and data streaming via Tauri events.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use base64::Engine as _;
use russh::keys::{PublicKey, PublicKeyOrCertificate};
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

/// Test-only override: the runtime log test runs a real connect, whose TOFU
/// accept would otherwise append an entry to the developer's real
/// known_hosts.json. Compiled out of production builds.
#[cfg(test)]
fn known_hosts_override() -> &'static std::sync::Mutex<Option<PathBuf>> {
    static OVERRIDE: std::sync::OnceLock<std::sync::Mutex<Option<PathBuf>>> =
        std::sync::OnceLock::new();
    OVERRIDE.get_or_init(|| std::sync::Mutex::new(None))
}

fn known_hosts_path() -> Option<PathBuf> {
    #[cfg(test)]
    if let Some(path) = known_hosts_override()
        .lock()
        .ok()
        .and_then(|override_path| override_path.clone())
    {
        return Some(path);
    }
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

// ─── TOFU Confirmation ──────────────────────────────────────────────

/// Pending TOFU confirmations keyed by session_id. check_server_key parks
/// on the oneshot receiver; tofu_respond resolves the sender. std Mutex is
/// safe: guards are dropped before every await point.
fn pending_tofu() -> &'static std::sync::Mutex<HashMap<u64, tokio::sync::oneshot::Sender<bool>>> {
    static MAP: std::sync::OnceLock<std::sync::Mutex<HashMap<u64, tokio::sync::oneshot::Sender<bool>>>> =
        std::sync::OnceLock::new();
    MAP.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

#[derive(Clone, Serialize)]
pub struct SshTofuPendingPayload {
    pub host_key: String,
    pub fingerprint: String,
    pub key_type: String,
    pub session_id: u64,
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
/// 0.60: the agent lists `AgentIdentity` (public key or certificate) instead
/// of bare public keys.
fn select_agent_keys(
    agent: &crate::hosts::AgentAuth,
    keys: Vec<russh::keys::agent::AgentIdentity>,
) -> Vec<russh::keys::agent::AgentIdentity> {
    match agent {
        crate::hosts::AgentAuth::Off => Vec::new(),
        crate::hosts::AgentAuth::All => keys,
        crate::hosts::AgentAuth::Fingerprint(fp) => keys
            .into_iter()
            .filter(|k| crate::secrets::agent::fingerprint_b64(&k.public_key()) == *fp)
            .collect(),
    }
}

/// Emit a detected browser-auth URL to the frontend. Never opens the
/// browser itself — a server-supplied URL must not launch anything without
/// an explicit user click (phishing surface). The frontend shows an "Open"
/// button in the connect overlay.
fn try_open_auth_url(
    events: &dyn ConnectionEvents,
    text: &str,
    session_id: u64,
) {
    if let Some(url) = extract_https_url(text) {
        log::info!("Auth URL detected: {}", url);
        events.emit(ConnectionEvent::AuthUrl(SshAuthUrlPayload {
            url,
            session_id,
        }));
    }
}

// ─── Interactive Auth (issue #12) ───────────────────────────────────

/// Frontend→backend control for an in-flight interactive auth round.
/// Answers are handed straight to the auth loop — never logged, never
/// written to the transcript, never persisted.
#[derive(Debug)]
pub enum AuthControl {
    /// User-typed answers for the current credential round.
    Respond(Vec<String>),
    /// User cancelled the connect — abort the auth loop.
    Cancel,
}

/// Pending interactive-auth senders keyed by session_id, mirroring
/// `pending_tofu`. The auth loop parks on the receiving end
/// (`await_auth_responses`); `ssh_auth_respond` delivers answers and
/// `ssh_disconnect` cancels. std Mutex is safe: guards are dropped before
/// every await point.
fn pending_auth() -> &'static std::sync::Mutex<HashMap<u64, tokio::sync::mpsc::UnboundedSender<AuthControl>>> {
    static MAP: std::sync::OnceLock<
        std::sync::Mutex<HashMap<u64, tokio::sync::mpsc::UnboundedSender<AuthControl>>>,
    > = std::sync::OnceLock::new();
    MAP.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

/// Session ids whose connect the user cancelled while it was still
/// pending. The `AuthControl::Cancel` channel only interrupts a *parked*
/// auth round — the user can also close the view while the server is
/// processing a submitted answer or during channel setup, when nobody
/// is parked to read it. `ssh_disconnect` marks the id under the
/// SSH-manager lock; `ssh_connect` re-checks the mark under the same
/// lock before registering, so a cancelled attempt can never leave a
/// live session behind a torn-down frontend.
fn cancelled_auth() -> &'static std::sync::Mutex<std::collections::HashSet<u64>> {
    static SET: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<u64>>> =
        std::sync::OnceLock::new();
    SET.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()))
}

/// Consume the cancel mark for a pending connect. `Ok(true)` = the user
/// cancelled while auth was in flight — the session must not register.
fn take_cancel_mark(session_id: u64) -> Result<bool, String> {
    cancelled_auth()
        .lock()
        .map(|mut marks| marks.remove(&session_id))
        .map_err(|e| e.to_string())
}

/// Drop a dead cancel mark — the connect failed, nothing will register.
fn discard_cancel_mark(session_id: u64) -> Result<(), String> {
    cancelled_auth()
        .lock()
        .map(|mut marks| {
            marks.remove(&session_id);
        })
        .map_err(|e| e.to_string())
}

/// True when the host is saved as password auth but has no stored password
/// (issue #12): nothing can answer the device's prompt automatically, so
/// the user must type it in the terminal during connect. The gate is on the
/// host record + resolved secret, so it covers HostStore and NetBox hosts
/// alike. Stored-password, key, agent, and secret-ref hosts are excluded;
/// credential-less hosts (browser-auth gateways) stay on the overlay flow.
fn needs_interactive_auth(
    credential: Option<&credentials::CredentialSource>,
    creds: &ResolvedCredentials,
) -> bool {
    matches!(credential, Some(credentials::CredentialSource::Password)) && creds.password.is_none()
}

/// Park one credential round until the user's answers arrive. Err = the
/// user cancelled (or the frontend went away) — the connect must abort.
async fn await_auth_responses(
    rx: &mut tokio::sync::mpsc::UnboundedReceiver<AuthControl>,
) -> Result<Vec<String>, String> {
    match rx.recv().await {
        Some(AuthControl::Respond(responses)) => Ok(responses),
        Some(AuthControl::Cancel) => Err("cancelled".to_string()),
        None => Err("cancelled".to_string()),
    }
}

// ─── Client Handler ─────────────────────────────────────────────────

/// Tauri event payloads
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

/// One keyboard-interactive prompt surfaced to the terminal (issue #12).
#[derive(Clone, Serialize)]
pub struct SshAuthPromptPayload {
    pub prompt: String,
    pub echo: bool,
}

/// A credential round the user must answer in the terminal.
#[derive(Clone, Serialize)]
pub struct SshAuthRoundPayload {
    pub session_id: u64,
    pub prompts: Vec<SshAuthPromptPayload>,
}

// ─── Connection Event Seam ──────────────────────────────────────────

/// Connection-phase events emitted to the frontend. Shaped like the
/// `OutputSink` seam in `transcript.rs`: production emits Tauri events, the
/// unit test observes them. Terminal bytes have their own seam; logging has
/// none — the test captures it through the global logger.
pub enum ConnectionEvent {
    Error(SshEventPayload),
    Disconnected(SshEventPayload),
    TofuPending(SshTofuPendingPayload),
    Tofu(SshEventPayload),
    AuthUrl(SshAuthUrlPayload),
    AuthRound(SshAuthRoundPayload),
    Connected(SshEventPayload),
}

#[async_trait::async_trait]
pub trait ConnectionEvents: Send + Sync {
    fn emit(&self, event: ConnectionEvent);
    /// Drop a dead session from the shared registry (remote close). Prod
    /// resolves `AppState` from its handle; the test has nothing to evict.
    async fn evict(&self, session_id: u64);
}

/// Prod adapter: the only place the connection path touches `AppHandle`.
pub struct TauriConnectionEvents {
    app_handle: tauri::AppHandle,
}

impl TauriConnectionEvents {
    pub fn new(app_handle: tauri::AppHandle) -> Self {
        Self { app_handle }
    }
}

#[async_trait::async_trait]
impl ConnectionEvents for TauriConnectionEvents {
    fn emit(&self, event: ConnectionEvent) {
        let _ = match event {
            ConnectionEvent::Error(p) => self.app_handle.emit("ssh-error", p),
            ConnectionEvent::Disconnected(p) => self.app_handle.emit("ssh-disconnected", p),
            ConnectionEvent::TofuPending(p) => self.app_handle.emit("ssh-tofu-pending", p),
            ConnectionEvent::Tofu(p) => self.app_handle.emit("ssh-tofu", p),
            ConnectionEvent::AuthUrl(p) => self.app_handle.emit("ssh-auth-url", p),
            ConnectionEvent::AuthRound(p) => self.app_handle.emit("ssh-auth-round", p),
            ConnectionEvent::Connected(p) => self.app_handle.emit("ssh-connected", p),
        };
    }

    async fn evict(&self, session_id: u64) {
        use tauri::Manager;
        let state = self.app_handle.state::<AppState>();
        let mut mgr = state.ssh.lock().await;
        if mgr.take_session(session_id).is_some() {
            log::debug!("Evicted session {} after remote close", session_id);
        }
    }
}

struct ClientHandler {
    events: Arc<dyn ConnectionEvents>,
    host_key: String, // "hostname:port"
    session_id: u64,
    transcript: crate::transcript::SharedTranscript,
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        // 0.63: the server may present a raw key or an SSH certificate; the
        // known-hosts / TOFU logic below works on the underlying public key.
        let server_public_key = server_public_key.public_key();
        let mut known = load_known_hosts();
        let key_b64 = key_to_base64(&server_public_key);
        let key_type = key_type_name(&server_public_key);

        if let Some(entry) = known.get(&self.host_key) {
            if entry.key_base64 == key_b64 && entry.key_type == key_type {
                log::info!("Host key verified for {} ({})", self.host_key, key_type);
                return Ok(true);
            } else {
                log::warn!("HOST KEY CHANGED for {} — prev: {}, new: {}", self.host_key, entry.key_type, key_type);
                self.events.emit(ConnectionEvent::Error(SshEventPayload {
                    reason: format!(
                        "HOST KEY HAS CHANGED for {}. This could indicate a man-in-the-middle attack. \
                         Previous key type: {}, new key type: {}. Connection rejected.",
                        self.host_key, entry.key_type, key_type
                    ),
                    session_id: self.session_id,
                }));
                return Ok(false);
            }
        }

        // First time — ask the user to verify the fingerprint (OpenSSH-style).
        // The handshake parks on a oneshot until tofu_respond (or timeout).
        let fingerprint = format!(
            "SHA256:{}",
            server_public_key.fingerprint(russh::keys::HashAlg::Sha256)
                .to_string()
                .trim_start_matches("SHA256:")
        );
        log::info!("TOFU: prompting user for new host key for {} ({})", self.host_key, key_type);

        let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
        {
            let mut map = pending_tofu().lock().expect("tofu map poisoned");
            map.insert(self.session_id, tx);
        }
        self.events.emit(ConnectionEvent::TofuPending(SshTofuPendingPayload {
            host_key: self.host_key.clone(),
            fingerprint: fingerprint.clone(),
            key_type: key_type.clone(),
            session_id: self.session_id,
        }));
        // Fail-safe: never hang forever on a lost/ignored dialog.
        let accepted = match tokio::time::timeout(std::time::Duration::from_secs(60), rx).await {
            Ok(Ok(true)) => true,
            _ => {
                log::warn!("TOFU confirmation not accepted for {} — rejecting", self.host_key);
                false
            }
        };
        pending_tofu().lock().expect("tofu map poisoned").remove(&self.session_id);

        if !accepted {
            self.events.emit(ConnectionEvent::Error(SshEventPayload {
                reason: format!("Host key for {} was not verified — connection rejected.", self.host_key),
                session_id: self.session_id,
            }));
            return Ok(false);
        }

        known.insert(
            self.host_key.clone(),
            KnownHostEntry {
                key_type: key_type.clone(),
                key_base64: key_b64,
                first_seen: chrono::Utc::now().to_rfc3339(),
            },
        );
        let _ = save_known_hosts(&known);
        self.events.emit(ConnectionEvent::Tofu(SshEventPayload {
            reason: format!("New host key accepted for {} — fingerprint: {}", self.host_key, fingerprint),
            session_id: self.session_id,
        }));
        Ok(true)
    }

    async fn data(
        &mut self,
        _channel: ChannelId,
        data: &[u8],
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        crate::transcript::write_output(&self.transcript, data);
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
        crate::transcript::write_output(&self.transcript, data);
        Ok(())
    }

    async fn auth_banner(
        &mut self,
        banner: &str,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        if !banner.is_empty() {
            try_open_auth_url(self.events.as_ref(), banner, self.session_id);
            // Banners are terminal output — they now reach the session log
            // too, instead of only the screen.
            crate::transcript::write_output(&self.transcript, banner.as_bytes());
        }
        Ok(())
    }

    async fn channel_close(
        &mut self,
        _channel: ChannelId,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        log::info!("SSH channel closed for {}", self.host_key);
        self.events.emit(ConnectionEvent::Disconnected(SshEventPayload {
            reason: "channel_closed".to_string(),
            session_id: self.session_id,
        }));
        self.events.evict(self.session_id).await;
        Ok(())
    }

    async fn channel_eof(
        &mut self,
        _channel: ChannelId,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        log::info!("SSH channel EOF for {}", self.host_key);
        self.events.emit(ConnectionEvent::Disconnected(SshEventPayload {
            reason: "channel_eof".to_string(),
            session_id: self.session_id,
        }));
        self.events.evict(self.session_id).await;
        Ok(())
    }

    async fn disconnected(
        &mut self,
        reason: DisconnectReason<Self::Error>,
    ) -> Result<(), Self::Error> {
        log::info!("SSH disconnected for {}", self.host_key);
        self.events.emit(ConnectionEvent::Disconnected(SshEventPayload {
            reason: "connection_lost".to_string(),
            session_id: self.session_id,
        }));
        self.events.evict(self.session_id).await;
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

fn create_session_log(
    enabled: bool,
    session_log_dir: Option<&str>,
    host_key: &str,
    session_id: u64,
    timestamps: bool,
) -> Option<crate::session_log::SessionLog> {
    if !enabled {
        return None;
    }

    match session_log_dir.map(str::trim).filter(|s| !s.is_empty()) {
        Some(dir) => Some(crate::session_log::SessionLog::new_in(
            std::path::Path::new(dir),
            host_key,
            session_id,
            timestamps,
        )),
        None => Some(crate::session_log::SessionLog::new(
            host_key, session_id, timestamps,
        )),
    }
}

impl SshSession {
    pub async fn connect(
        events: Arc<dyn ConnectionEvents>,
        sink: Box<dyn crate::transcript::OutputSink>,
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
        mut auth_rx: Option<tokio::sync::mpsc::UnboundedReceiver<AuthControl>>,
    ) -> Result<Self, String> {
        // Usernames are never logged: comnd.log persists to disk and gets
        // attached to bug reports. host:port plus the session id identifies a
        // connection: the id is an opaque timestamp-minted value, not an
        // account identity, and it is the join key to the session log file
        // name built in session_log.rs.
        log::info!(
            "SSH connecting to {}:{} ({}x{}) [session {}]",
            hostname,
            port,
            cols,
            rows,
            session_id
        );

        // Build russh config
        let config = Arc::new(client::Config {
            keepalive_interval: Some(std::time::Duration::from_secs(15)),
            keepalive_max: 3,
            ..Default::default()
        });

        let host_key = format!("{}:{}", hostname, port);

        let session_log = create_session_log(
            session_logging,
            session_log_dir.as_deref(),
            &host_key,
            session_id,
            session_log_timestamps,
        );
        let transcript = crate::transcript::Transcript::new(session_log, sink).shared();

        let handler = ClientHandler {
            events: events.clone(),
            host_key,
            session_id,
            transcript: transcript.clone(),
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
            Self::authenticate(events.as_ref(), &mut session, username, hostname, password, key_path, agent, session_id, &transcript, &mut auth_rx),
        )
        .await
        .map_err(|_| format!("Authentication timed out after 120s for {}", addr))?
        ?;

        if !auth_success {
            log::warn!(
                "SSH authentication failed for {} [session {}]",
                addr,
                session_id
            );
            return Err("Authentication failed — server rejected all offered methods (SSH key, password, keyboard-interactive). Check the host's saved credentials.".to_string());
        }

        log::info!(
            "SSH authenticated successfully for {} [session {}]",
            addr,
            session_id
        );

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
        events.emit(ConnectionEvent::Connected(SshEventPayload {
            reason: "ok".to_string(),
            session_id,
        }));

        Ok(SshSession {
            session,
            channel,
            session_id,
        })
    }

    async fn authenticate(
        events: &dyn ConnectionEvents,
        session: &mut client::Handle<ClientHandler>,
        username: &str,
        hostname: &str,
        password: Option<&str>,
        key_path: Option<&str>,
        agent: crate::hosts::AgentAuth,
        session_id: u64,
        transcript: &crate::transcript::SharedTranscript,
        auth_rx: &mut Option<tokio::sync::mpsc::UnboundedReceiver<AuthControl>>,
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
            for identity in select_agent_keys(&agent, keys) {
                offered = true;
                let public = identity.public_key().into_owned();
                let fp = crate::secrets::agent::fingerprint_b64(&public);
                log::info!("Attempting agent publickey auth ({fp})");
                // RSA signatures need an explicit hash alg (SHA-1 is dead);
                // everything else takes none.
                let hash_alg = if public.algorithm().is_rsa() {
                    Some(russh::keys::HashAlg::Sha256)
                } else {
                    None
                };
                // The future of `authenticate_publickey_with` is Send only for
                // specific lifetimes (Signer has no Send bound), which breaks
                // the tauri command's higher-ranked Send requirement. Running
                // it via block_on keeps the borrows synchronous — no Send
                // needed. The same agent socket signs every identity in turn.
                // ponytail: requires a multi-thread runtime (tauri default).
                let result = tokio::task::block_in_place(|| {
                    tokio::runtime::Handle::current().block_on(
                        session.authenticate_publickey_with(username, public, hash_alg, &mut client),
                    )
                })
                .map_err(|e| e.to_string());
                match result {
                    Ok(auth) if auth.success() => return Ok(true),
                    Ok(_) => log::info!("Agent identity {fp} rejected by server"),
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
                // The full path leaks the local account name (e.g.
                // /home/alice/.ssh/id_ed25519), so log the file name only: it
                // still says which key was tried without naming the account.
                let key_name = path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "<unnamed>".to_string());
                log::info!("Attempting SSH key auth with {}", key_name);
                // RSA signatures need an explicit hash alg (SHA-1 is dead);
                // everything else ignores it.
                // 0.60: PrivateKeyWithHashAlg::new is infallible (it ignores
                // the hash for non-RSA keys instead of failing).
                let loaded = russh::keys::load_secret_key(path, None)
                    .map(|key| {
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
                        if auth_result.success() {
                            return Ok(true);
                        }
                        // Key auth failed, fall through to password
                    }
                    Err(e) => {
                        log::warn!("Failed to load SSH key {}: {}. Falling back to password.", key_name, e);
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
            if auth_result.success() {
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
            .map(|key| russh::keys::key::PrivateKeyWithHashAlg::new(Arc::new(key), None));
            match key {
                Ok(key) => match session.authenticate_publickey(username, key).await {
                    Ok(result) if result.success() => return Ok(true),
                    Ok(_) => log::info!("Ephemeral key rejected — server requires configured credentials"),
                    Err(e) => log::info!("Ephemeral key auth error: {}", e),
                },
                Err(e) => log::info!("Ephemeral key generation failed: {}", e),
            }
        }

        // Fallback: keyboard-interactive auth, as a bounded multi-round loop.
        // Three server families land here:
        //  - Browser-auth gateways (Tailscale check mode): prompts carry a login URL.
        //    We surface it in the connect overlay, reply with EMPTY responses, and
        //    the server holds that reply open until the user finishes the browser
        //    login — then answers Success. The respond().await below IS the browser
        //    wait (bounded by the 120s timeout in connect()).
        //  - Cisco/F5 style: prompts ask for the password → answer with the stored one.
        //  - Password-method-only servers (issue #12): the method is refused with
        //    no round at all → fall back to a client-side password prompt.
        log::info!("Attempting keyboard-interactive auth");
        let mut current = session
            .authenticate_keyboard_interactive_start(username, None::<String>)
            .await;
        // Whether the server ever showed a round. No round + Failure/Err means
        // the method itself is unavailable (e.g. Linux with
        // `KbdInteractiveAuthentication no`) — the issue #12 fallback applies.
        let mut saw_round = false;
        for round in 1..=5u32 {
            match current {
                Ok(KeyboardInteractiveAuthResponse::InfoRequest { instructions, prompts, .. }) => {
                    saw_round = true;
                    // Emit any auth URL (browser-auth round detection); the
                    // user opens it from the connect overlay — never auto-open.
                    try_open_auth_url(events, &instructions, session_id);
                    let mut url_round = extract_https_url(&instructions).is_some();
                    if !instructions.is_empty() {
                        log::info!("Keyboard-interactive instructions: {}", instructions);
                        // Auth-phase prompts now reach the session log.
                        crate::transcript::write_output(transcript, instructions.as_bytes());
                    }
                    for prompt in &prompts {
                        try_open_auth_url(events, &prompt.prompt, session_id);
                        url_round |= extract_https_url(&prompt.prompt).is_some();
                        if !prompt.prompt.is_empty() {
                            crate::transcript::write_output(transcript, prompt.prompt.as_bytes());
                        }
                    }
                    // Interactive credential round (issue #12): password-auth
                    // host with no stored password. Surface the prompts in
                    // the terminal and park until the user answers — never
                    // answer empty, never log the answers. Empty prompt
                    // lists (informational rounds) are excluded: nothing
                    // can be answered, so the automatic arm below replies
                    // with an empty vector instead of stalling on a user
                    // who was never asked anything.
                    let responses = match auth_rx.as_mut() {
                        Some(rx) if !url_round && stored_password.is_none() && !prompts.is_empty() => {
                            events.emit(ConnectionEvent::AuthRound(SshAuthRoundPayload {
                                session_id,
                                prompts: prompts
                                    .iter()
                                    .map(|p| SshAuthPromptPayload { prompt: p.prompt.clone(), echo: p.echo })
                                    .collect(),
                            }));
                            log::info!(
                                "Keyboard-interactive round {} ({} prompt(s), interactive) — waiting for user",
                                round,
                                prompts.len(),
                            );
                            match await_auth_responses(rx).await {
                                Ok(responses) => responses,
                                Err(_) => {
                                    log::info!("Interactive auth cancelled during round {}", round);
                                    return Err("Connection cancelled during authentication".to_string());
                                }
                            }
                        }
                        _ => {
                            log::info!(
                                "Keyboard-interactive round {} ({} prompt(s), {} round) — responding",
                                round, prompts.len(), if url_round { "browser-auth" } else { "credential" }
                            );
                            responses_for_round(url_round, stored_password.as_deref(), prompts.len())
                        }
                    };
                    current = session.authenticate_keyboard_interactive_respond(responses).await;
                }
                Ok(KeyboardInteractiveAuthResponse::Success) => {
                    log::info!("Keyboard-interactive auth succeeded");
                    return Ok(true);
                }
                Ok(KeyboardInteractiveAuthResponse::Failure { .. }) => {
                    log::info!("Keyboard-interactive auth rejected (server refused method or credentials)");
                    // Refused without a single round → the method is
                    // unavailable. Issue #12: prompt for the password
                    // client-side, like the OpenSSH CLI does.
                    if !saw_round {
                        return Self::password_prompt_fallback(
                            events, session, username, hostname, session_id, transcript, auth_rx,
                        )
                        .await;
                    }
                    return Ok(false);
                }
                Err(e) => {
                    log::info!("Keyboard-interactive auth not available: {}", e);
                    if !saw_round {
                        return Self::password_prompt_fallback(
                            events, session, username, hostname, session_id, transcript, auth_rx,
                        )
                        .await;
                    }
                    return Ok(false);
                }
            }
        }
        log::warn!("Keyboard-interactive auth exceeded 5 rounds without resolution");
        Ok(false)
    }

    /// Issue #12 fallback for servers that offer no keyboard-interactive
    /// method (e.g. Linux with `KbdInteractiveAuthentication no`, password
    /// method only). The `password` method is single-shot — the server
    /// never prompts — so the CLIENT prompts, exactly like the OpenSSH
    /// CLI, and each typed answer is one password attempt (three, like
    /// `ssh`). Not armed (any other flow) → today's unchanged failure.
    /// The typed answer goes straight to russh — never logged, never
    /// written to the transcript.
    #[allow(clippy::too_many_arguments)]
    async fn password_prompt_fallback(
        events: &dyn ConnectionEvents,
        session: &mut client::Handle<ClientHandler>,
        username: &str,
        hostname: &str,
        session_id: u64,
        transcript: &crate::transcript::SharedTranscript,
        auth_rx: &mut Option<tokio::sync::mpsc::UnboundedReceiver<AuthControl>>,
    ) -> Result<bool, String> {
        let Some(rx) = auth_rx.as_mut() else {
            return Ok(false);
        };
        log::info!("Interactive auth: keyboard-interactive unavailable — prompting for password client-side");
        let prompt = format!("{}@{}'s password: ", username, hostname);
        for attempt in 1..=3u32 {
            // Prompt text reaches the terminal via the transcript exactly like
            // device prompts (and the session log); a fresh line per retry.
            if attempt > 1 {
                crate::transcript::write_output(transcript, b"\r\n");
            }
            crate::transcript::write_output(transcript, prompt.as_bytes());
            events.emit(ConnectionEvent::AuthRound(SshAuthRoundPayload {
                session_id,
                prompts: vec![SshAuthPromptPayload { prompt: prompt.clone(), echo: false }],
            }));
            let answers = match await_auth_responses(rx).await {
                Ok(answers) => answers,
                Err(_) => {
                    log::info!("Interactive password prompt cancelled (attempt {})", attempt);
                    return Err("Connection cancelled during authentication".to_string());
                }
            };
            // Counts only — the answer itself is never logged.
            let answer = answers.into_iter().next().unwrap_or_default();
            log::info!("Attempting password auth with typed password (attempt {})", attempt);
            match session.authenticate_password(username, &answer).await {
                Ok(result) if result.success() => {
                    log::info!("Password auth succeeded (attempt {})", attempt);
                    return Ok(true);
                }
                Ok(_) => log::info!("Typed password rejected (attempt {})", attempt),
                Err(e) => return Err(format!("Password auth error: {}", e)),
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

    pub async fn disconnect(&self) -> Result<(), String> {
        log::info!("SSH disconnect requested");
        self.session
            .disconnect(Disconnect::ByApplication, "User disconnect", "en")
            .await
            .map_err(|e| format!("Disconnect error: {}", e))
    }
}

// ─── Session Map (testable core) ────────────────────────────────────

/// Keyed session registry. Generic so unit tests can exercise the
/// insert/take/get logic without constructing a real SshSession (whose
/// russh handles need a live TCP connection). Stores `Arc<S>` so commands
/// can clone a shared handle out, drop the manager lock, then await on it.
pub struct SessionMap<S> {
    sessions: HashMap<u64, Arc<S>>,
}

impl<S> SessionMap<S> {
    pub fn new() -> Self {
        Self { sessions: HashMap::new() }
    }

    pub fn insert_with(&mut self, id: u64, s: S) {
        self.sessions.insert(id, Arc::new(s));
    }

    /// Clone the shared handle out so the caller can drop the lock and await.
    pub fn get(&self, id: u64) -> Option<Arc<S>> {
        self.sessions.get(&id).cloned()
    }

    pub fn take(&mut self, id: u64) -> Option<Arc<S>> {
        self.sessions.remove(&id)
    }

    /// Number of active sessions.
    pub fn len(&self) -> usize {
        self.sessions.len()
    }
}

// ─── Session Manager (app state) ───────────────────────────────────

pub struct SshManager {
    sessions: SessionMap<SshSession>,
    #[cfg(debug_assertions)]
    test_server_handle: Option<tokio::task::JoinHandle<()>>,
    #[cfg(debug_assertions)]
    test_server_received: Option<Arc<std::sync::Mutex<Vec<u8>>>>,
    #[cfg(debug_assertions)]
    test_server_closed: Option<Arc<std::sync::atomic::AtomicBool>>,
    /// Every PTY size the mock host has been asked for, in arrival order.
    #[cfg(debug_assertions)]
    test_server_pty_sizes: Option<Arc<std::sync::Mutex<Vec<(u32, u32)>>>>,
}

impl SshManager {
    pub fn new() -> Self {
        SshManager {
            sessions: SessionMap::new(),
            #[cfg(debug_assertions)]
            test_server_handle: None,
            #[cfg(debug_assertions)]
            test_server_received: None,
            #[cfg(debug_assertions)]
            test_server_closed: None,
            #[cfg(debug_assertions)]
            test_server_pty_sizes: None,
        }
    }

    pub fn insert_session(&mut self, session: SshSession) {
        self.sessions.insert_with(session.session_id, session);
    }

    /// Current number of active sessions.
    pub fn session_count(&self) -> usize {
        self.sessions.len()
    }

    pub fn take_session(&mut self, session_id: u64) -> Option<Arc<SshSession>> {
        self.sessions.take(session_id)
    }

    /// Clone the shared handle out so the caller can drop the lock and await.
    pub fn get_session(&self, session_id: u64) -> Option<Arc<SshSession>> {
        self.sessions.get(session_id)
    }

    #[cfg(debug_assertions)]
    pub fn set_test_server_handle(&mut self, handle: tokio::task::JoinHandle<()>) {
        self.test_server_handle = Some(handle);
    }

    #[cfg(debug_assertions)]
    pub fn set_test_server_received(&mut self, received: Arc<std::sync::Mutex<Vec<u8>>>) {
        self.test_server_received = Some(received);
    }

    #[cfg(debug_assertions)]
    pub fn clear_test_server_received(&mut self) {
        self.test_server_received = None;
        self.test_server_closed = None;
        self.test_server_pty_sizes = None;
    }

    #[cfg(debug_assertions)]
    pub fn set_test_server_pty_sizes(&mut self, sizes: Arc<std::sync::Mutex<Vec<(u32, u32)>>>) {
        self.test_server_pty_sizes = Some(sizes);
    }

    #[cfg(debug_assertions)]
    pub fn test_server_pty_sizes(&self) -> Option<Arc<std::sync::Mutex<Vec<(u32, u32)>>>> {
        self.test_server_pty_sizes.clone()
    }

    #[cfg(debug_assertions)]
    pub fn set_test_server_closed(&mut self, closed: Arc<std::sync::atomic::AtomicBool>) {
        self.test_server_closed = Some(closed);
    }

    #[cfg(debug_assertions)]
    pub fn take_test_server_handle(&mut self) -> Option<tokio::task::JoinHandle<()>> {
        self.test_server_handle.take()
    }

    #[cfg(debug_assertions)]
    pub fn test_server_received(&self) -> Option<Arc<std::sync::Mutex<Vec<u8>>>> {
        self.test_server_received.clone()
    }

    #[cfg(debug_assertions)]
    pub fn test_server_closed(&self) -> Option<Arc<std::sync::atomic::AtomicBool>> {
        self.test_server_closed.clone()
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
    fn test_take_twice_is_none() {
        // Pins eviction idempotence: close+eof double-fire both route through
        // take; the second must be None (no panic, no double-evict).
        let mut m = map_with(&[1]);
        assert!(m.take(1).is_some());
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
    fn disabled_session_logging_does_not_create_a_log_file() {
        struct DiscardSink;
        impl crate::transcript::OutputSink for DiscardSink {
            fn emit_output(&self, _encoded: &str) {}
        }

        let dir = std::env::temp_dir().join(format!(
            "comnd_session_logging_disabled_{}",
            uuid::Uuid::new_v4()
        ));
        let session_log =
            create_session_log(false, Some(dir.to_str().unwrap()), "host:22", 1, true);
        let mut transcript = crate::transcript::Transcript::new(session_log, Box::new(DiscardSink));

        transcript.output(b"remote output that could contain a secret");

        assert!(
            !dir.exists(),
            "disabled session logging created a log directory"
        );
    }

    #[test]
    fn test_get_returns_shared_handles() {
        // Pins handle semantics: two lookups yield the same Arc (same session).
        let m = map_with(&[1]);
        let a = m.get(1).unwrap();
        let b = m.get(1).unwrap();
        assert!(Arc::ptr_eq(&a, &b));
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
        use russh::keys::agent::AgentIdentity;
        use russh::keys::key::safe_rng;
        let key = |()| {
            let pk = russh::keys::PrivateKey::random(&mut safe_rng(), russh::keys::Algorithm::Ed25519)
                .unwrap()
                .public_key()
                .clone();
            AgentIdentity::from(pk)
        };
        let k1 = key(());
        let k2 = key(());
        let fp1 = fingerprint_b64(&k1.public_key());
        let keys = vec![k1, k2];

        assert_eq!(select_agent_keys(&AgentAuth::All, keys.clone()).len(), 2);

        let sel = select_agent_keys(&AgentAuth::Fingerprint(fp1.clone()), keys.clone());
        assert_eq!(sel.len(), 1);
        assert_eq!(fingerprint_b64(&sel[0].public_key()), fp1);

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
    fn test_needs_interactive_auth_gate() {
        use crate::credentials::CredentialSource;
        let password = Some(CredentialSource::Password);
        let key = Some(CredentialSource::SshKey { key_path: "k".into() });
        let none: Option<CredentialSource> = None;
        let with_pw = ResolvedCredentials {
            password: Some("x".into()),
            ..Default::default()
        };
        let without = ResolvedCredentials::default();

        // The only arming combination: password auth AND no stored password.
        assert!(needs_interactive_auth(password.as_ref(), &without));
        // Stored password answers automatically — not interactive.
        assert!(!needs_interactive_auth(password.as_ref(), &with_pw));
        // Key, agent/secret-ref, and credential-less (browser-auth) hosts.
        assert!(!needs_interactive_auth(key.as_ref(), &without));
        assert!(!needs_interactive_auth(none.as_ref(), &without));
    }

    #[tokio::test]
    async fn test_await_auth_responses_receives_respond() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        tx.send(AuthControl::Respond(vec!["pw".into()])).unwrap();
        assert_eq!(
            await_auth_responses(&mut rx).await.unwrap(),
            vec!["pw".to_string()]
        );
    }

    #[tokio::test]
    async fn test_await_auth_responses_cancel_and_close() {
        // Explicit cancel aborts the round…
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        tx.send(AuthControl::Cancel).unwrap();
        assert!(await_auth_responses(&mut rx).await.is_err());
        // …and so does a dropped frontend (channel closed).
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        drop(tx);
        assert!(await_auth_responses(&mut rx).await.is_err());
    }

    #[test]
    fn test_cancel_mark_consumed_once() {
        // ssh_disconnect marks a pending connect…
        cancelled_auth().lock().unwrap().insert(0xC0FFEE);
        // …the registration guard consumes the mark exactly once…
        assert!(take_cancel_mark(0xC0FFEE).unwrap());
        assert!(!take_cancel_mark(0xC0FFEE).unwrap());
        // …and a failed connect discards a dead mark without inventing one.
        discard_cancel_mark(0xC0FFEE).unwrap();
        assert!(!take_cancel_mark(0xC0FFEE).unwrap());
    }

    // ── Runtime guard for ADR-012 (issue #68) ───────────────────────────
    //
    // `tests/log_redaction.rs` is the static half of the guard: it scans the
    // log macros for forbidden variables. This is the runtime half — it drives
    // a real connect against the mock SSH server and inspects what the logger
    // actually received.

    /// Lines captured while `CAPTURING` is set. `cargo test` shares one process
    /// across the lib tests, so the gate plus the probe's unique marker keep a
    /// concurrent test from making this assertion pass or fail by accident.
    fn captured_lines() -> &'static std::sync::Mutex<Vec<String>> {
        static LINES: std::sync::OnceLock<std::sync::Mutex<Vec<String>>> =
            std::sync::OnceLock::new();
        LINES.get_or_init(|| std::sync::Mutex::new(Vec::new()))
    }

    fn captured_snapshot() -> Vec<String> {
        captured_lines()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Serialises the capture window: the logger is process-wide, so two
    /// capturing tests would otherwise interleave their lines.
    fn capture_window() -> &'static std::sync::Mutex<()> {
        static WINDOW: std::sync::Mutex<()> = std::sync::Mutex::new(());
        &WINDOW
    }

    static CAPTURING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

    struct CaptureLogger;

    impl log::Log for CaptureLogger {
        fn enabled(&self, _metadata: &log::Metadata) -> bool {
            true
        }

        fn log(&self, record: &log::Record) {
            // Gate first: nothing is formatted for lines outside the window.
            if !CAPTURING.load(std::sync::atomic::Ordering::SeqCst) {
                return;
            }
            // Only the app's own lines: the mock server logs the probe username
            // through `russh::server`, which is test-harness output, not the
            // app log this assertion is about.
            if !record.target().starts_with("comnd") {
                return;
            }
            if let Ok(mut lines) = captured_lines().lock() {
                lines.push(format!(
                    "{} {}: {}",
                    record.level(),
                    record.target(),
                    record.args()
                ));
            }
        }

        fn flush(&self) {}
    }

    /// The global logger can be installed exactly once per process.
    fn install_capture_logger() {
        static LOGGER: CaptureLogger = CaptureLogger;
        static ONCE: std::sync::OnceLock<()> = std::sync::OnceLock::new();
        ONCE.get_or_init(|| {
            log::set_logger(&LOGGER)
                .expect("capturing logger could not be installed: another logger owns the process");
            log::set_max_level(log::LevelFilter::Trace);
        });
    }

    /// ADR-012: the app log persists to disk and travels in bug reports, so it
    /// must never carry an account identifier. `[session N]` is the only
    /// connection join key allowed on the open and auth-outcome lines.
    #[tokio::test]
    async fn connect_logs_carry_no_account_identifiers() {
        use crate::hosts::AgentAuth;
        use crate::transcript::OutputSink;

        struct DiscardSink;
        impl OutputSink for DiscardSink {
            fn emit_output(&self, _encoded: &str) {}
        }

        struct NoopEvents;
        #[async_trait::async_trait]
        impl ConnectionEvents for NoopEvents {
            fn emit(&self, _event: ConnectionEvent) {}
            async fn evict(&self, _session_id: u64) {}
        }

        // Unique per run, so only this connect can put these in a log line.
        let marker = format!(
            "{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock before the epoch")
                .as_nanos()
        );
        let username = format!("probe-user-{marker}");
        let password = format!("probe-secret-{marker}");
        let session_id: u64 = 0x0068_0000_0000_0001;

        let temp_root = std::env::temp_dir().join(format!("comnd_log_probe_{marker}"));
        std::fs::create_dir_all(&temp_root).expect("create probe temp dir");
        let key_file = temp_root.join("probe_key");
        // Junk contents: the file must exist so the key-auth path runs, and it
        // must fail to decode so the "Failed to load SSH key" line is reached.
        std::fs::write(&key_file, b"not a private key\n").expect("write probe key file");
        let key_path = key_file.to_string_lossy().into_owned();
        let temp_root_str = temp_root.to_string_lossy().into_owned();

        // A real connect parks on a first-seen host key and, once accepted,
        // writes it out. Point that at the probe temp dir so the developer's
        // real known_hosts.json is never touched.
        known_hosts_override()
            .lock()
            .expect("known-hosts override lock")
            .replace(temp_root.join("known_hosts.json"));
        struct KnownHostsGuard;
        impl Drop for KnownHostsGuard {
            fn drop(&mut self) {
                if let Ok(mut override_path) = known_hosts_override().lock() {
                    *override_path = None;
                }
            }
        }
        let _known_hosts_guard = KnownHostsGuard;

        install_capture_logger();
        let _window = capture_window()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        let (port, server) = crate::test_server::start_password_only_mock_server(&password).await;

        // Answer the TOFU dialog as the frontend would. The poll outlasts the
        // 10 s connect timeout, so a handshake that reaches the prompt late is
        // still answered; the task returns as soon as it fires.
        let (tofu_done_tx, tofu_done_rx) = tokio::sync::oneshot::channel::<()>();
        let tofu_task = tokio::spawn(async move {
            for _ in 0..1_500 {
                let sender = pending_tofu()
                    .lock()
                    .ok()
                    .and_then(|mut map| map.remove(&session_id));
                if let Some(sender) = sender {
                    let _ = sender.send(true);
                    let _ = tofu_done_tx.send(());
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        });

        captured_lines()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
        CAPTURING.store(true, std::sync::atomic::Ordering::SeqCst);
        let result = SshSession::connect(
            Arc::new(NoopEvents),
            Box::new(DiscardSink),
            "127.0.0.1",
            port,
            &username,
            Some(&password),
            Some(&key_path),
            AgentAuth::Off,
            80,
            24,
            session_id,
            false,
            true,
            None,
            None,
        )
        .await;
        CAPTURING.store(false, std::sync::atomic::Ordering::SeqCst);
        let lines = captured_snapshot();

        let tofu_answered = tokio::time::timeout(
            std::time::Duration::from_secs(15),
            tofu_done_rx,
        )
        .await
        .is_ok();
        tofu_task.abort();
        let session = result.unwrap_or_else(|error| {
            panic!("connect to the mock SSH server failed: {error}\ncaptured lines:\n{}", lines.join("\n"))
        });
        drop(session);
        server.abort();
        assert!(
            tofu_answered,
            "the test never answered the TOFU prompt: check_server_key did not park on pending_tofu()"
        );

        // The key path must have been exercised, otherwise the "no key path"
        // assertion below would pass vacuously.
        assert!(
            lines
                .iter()
                .any(|line| line.contains("Attempting SSH key auth with probe_key")),
            "the key-auth path did not run; captured lines:\n{}",
            lines.join("\n")
        );

        let mut leaked = Vec::new();
        for line in &lines {
            for (label, needle) in [
                ("username", username.as_str()),
                ("password", password.as_str()),
                ("key path", key_path.as_str()),
                ("key path directory", temp_root_str.as_str()),
            ] {
                if line.contains(needle) {
                    leaked.push(format!("{label} in: {line}"));
                }
            }
        }
        assert!(
            leaked.is_empty(),
            "ADR-012 violation: the app log carries an account identifier\n{}\n\ncaptured lines:\n{}",
            leaked.join("\n"),
            lines.join("\n")
        );

        // Positive side: the open and auth-outcome lines carry the session id.
        // `session_marker` is deliberately kept out of the failure message: CodeQL's
        // rust/cleartext-logging query counts panic messages as log sinks, and the
        // captured lines below already show the marker.
        let session_marker = format!("[session {}]", session_id);
        for (what, needle) in [
            ("connection-open", "SSH connecting to"),
            ("auth-outcome", "SSH authenticated successfully"),
        ] {
            assert!(
                lines
                    .iter()
                    .any(|line| line.contains(&session_marker) && line.contains(needle)),
                "the {what} line for the probe session was not logged; captured lines:\n{}",
                lines.join("\n")
            );
        }

        let _ = std::fs::remove_dir_all(&temp_root);
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
    // ponytail: max-sessions check races concurrent connects (over-limit by at most the burst size); reserve a map slot at check time if it ever matters
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

    // Issue #12: password-auth host with no stored password. Arm interactive
    // auth — the device's prompt (e.g. `Password: `) becomes visible in the
    // terminal and the user's typed answers complete the handshake. All
    // other flows stay exactly as before.
    let mut auth_rx = None;
    if needs_interactive_auth(credential.as_ref(), &creds) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        pending_auth().lock().map_err(|e| e.to_string())?.insert(session_id, tx);
        auth_rx = Some(rx);
        log::info!(
            "Interactive auth armed for session {} (password auth, no stored password)",
            session_id
        );
        let _ = app_handle.emit("ssh-auth-interactive", SshEventPayload {
            reason: "password_prompt".to_string(),
            session_id,
        });
    }

    // Production wiring for the two connection seams, done once per connect:
    // events (frontend lifecycle/auth notifications) and terminal output.
    let events = Arc::new(TauriConnectionEvents::new(app_handle.clone()));
    let sink = Box::new(crate::transcript::TauriOutputSink::new(
        app_handle.clone(),
        session_id,
    ));
    let session = SshSession::connect(
        events,
        sink,
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
        auth_rx,
    )
    .await;
    // Always drop the pending-auth entry — covers success, failure, and the
    // 120s auth timeout dropping the round wait mid-flight. Late
    // ssh_auth_respond calls become no-ops.
    pending_auth().lock().map_err(|e| e.to_string())?.remove(&session_id);

    let session = match session {
        Ok(session) => session,
        Err(e) => {
            // No session will register — the cancel mark, if any, is dead.
            discard_cancel_mark(session_id)?;
            return Err(e);
        }
    };

    // Registration guard (issue #12 review): the user can cancel while auth
    // is in flight — after submitting an answer, during the browser-auth
    // URL wait, or while the channel opens, when no parked round reads the
    // Cancel message. `ssh_disconnect` marks the session under this same
    // lock, so checking the mark under the lock makes cancellation and
    // registration mutually exclusive: a cancelled connect drops the
    // session instead of leaving a live zombie behind a torn-down view.
    let mut mgr = state.ssh.lock().await;
    let cancelled = take_cancel_mark(session_id)?;
    if cancelled {
        drop(mgr);
        log::info!("Session {} cancelled mid-connect — dropping before registration", session_id);
        let _ = session.disconnect().await;
        return Err("Connection cancelled during authentication".to_string());
    }
    mgr.insert_session(session);
    Ok(())
}

/// Debug-only smoke mutation (issue #61). With `COMND_SMOKE_MUTATION=ssh_send`
/// the SSH input boundary drops every byte, so the smoke suite proves it
/// catches a broken app rather than a silent mock. Compiled out of release.
#[cfg(debug_assertions)]
pub fn smoke_mutation_name() -> Option<String> {
    std::env::var("COMND_SMOKE_MUTATION")
        .ok()
        .filter(|value| !value.is_empty())
}

#[cfg(debug_assertions)]
fn smoke_mutation_active(name: &str) -> bool {
    smoke_mutation_name().as_deref() == Some(name)
}

/// Bytes the smoke mutation has dropped in this app process. The runner reads
/// this after the expected failure, so zero bytes at the mock is not accepted
/// as proof that the drop ran (issue #78).
#[cfg(debug_assertions)]
static SMOKE_MUTATION_DROPPED_BYTES: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

#[cfg(debug_assertions)]
pub fn smoke_mutation_dropped_bytes() -> u64 {
    SMOKE_MUTATION_DROPPED_BYTES.load(std::sync::atomic::Ordering::SeqCst)
}

#[tauri::command]
pub async fn ssh_send(
    session_id: u64,
    data: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    // Lock only to look the session up, clone the handle, drop the guard,
    // then await — so one slow send never blocks another terminal.
    let session = {
        let mgr = state.ssh.lock().await;
        mgr.get_session(session_id)
            .ok_or_else(|| "Session not found".to_string())?
    };
    #[cfg(debug_assertions)]
    if smoke_mutation_active("ssh_send") {
        SMOKE_MUTATION_DROPPED_BYTES
            .fetch_add(data.len() as u64, std::sync::atomic::Ordering::SeqCst);
        log::warn!(
            "Smoke mutation COMND_SMOKE_MUTATION=ssh_send: dropping {} bytes of SSH input",
            data.len()
        );
        return Ok(());
    }
    session.send(data.as_bytes()).await
}

#[tauri::command]
pub async fn ssh_disconnect(
    session_id: u64,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    // Take the handle out under the lock, then disconnect without holding it.
    // `None` = already gone (remote close evicted it first) — or the connect
    // is still pending (issue #12). Then: cancel any parked interactive auth
    // round AND mark the session (under this same lock) so `ssh_connect`'s
    // registration guard can never register a live session the frontend
    // has already torn down.
    let session = {
        let mut mgr = state.ssh.lock().await;
        let session = mgr.take_session(session_id);
        if session.is_none() {
            cancelled_auth()
                .lock()
                .map_err(|e| e.to_string())?
                .insert(session_id);
        }
        session
    };
    match session {
        Some(session) => session.disconnect().await,
        None => {
            let tx = pending_auth().lock().map_err(|e| e.to_string())?.remove(&session_id);
            if let Some(tx) = tx {
                let _ = tx.send(AuthControl::Cancel);
            }
            Ok(())
        }
    }
}

#[tauri::command]
pub async fn ssh_resize(
    session_id: u64,
    cols: u32,
    rows: u32,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    // Lock only to look the session up, clone the handle, drop the guard,
    // then await — so one slow resize never blocks another terminal.
    let session = {
        let mgr = state.ssh.lock().await;
        mgr.get_session(session_id)
            .ok_or_else(|| "Session not found".to_string())?
    };
    session.resize(cols, rows).await
}

/// Answer a pending first-seen host-key confirmation (TOFU dialog).
/// Unknown session_id → no-op (dialog raced a timeout/reject).
#[tauri::command]
pub async fn tofu_respond(session_id: u64, accept: bool) -> Result<(), String> {
    let tx = pending_tofu().lock().map_err(|e| e.to_string())?.remove(&session_id);
    if let Some(tx) = tx {
        // Send failure just means check_server_key gave up first (timeout).
        let _ = tx.send(accept);
    }
    Ok(())
}

/// Submit the user's answers for the pending interactive auth round
/// (issue #12). Unknown session_id → no-op (round raced a timeout/cancel).
/// Answers go straight to the auth loop — never logged or persisted.
#[tauri::command]
pub async fn ssh_auth_respond(session_id: u64, responses: Vec<String>) -> Result<(), String> {
    let tx = pending_auth()
        .lock()
        .map_err(|e| e.to_string())?
        .get(&session_id)
        .cloned();
    if let Some(tx) = tx {
        tx.send(AuthControl::Respond(responses))
            .map_err(|_| "Auth round already resolved".to_string())?;
    }
    Ok(())
}
