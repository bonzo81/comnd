//! SSH connection management via russh
//!
//! Handles: connection lifecycle, authentication (password + keyboard-interactive + key),
//! host key verification (TOFU), PTY allocation, and data streaming via Tauri events.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use base64::Engine as _;
use russh::keys::key::PublicKey;
use russh::{client, ChannelId, Disconnect};
use russh::client::DisconnectReason;
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

// ─── Client Handler ─────────────────────────────────────────────────

/// Tauri event payloads
#[derive(Clone, Serialize)]
pub struct SshOutputPayload {
    pub data: String, // base64 encoded bytes
}

#[derive(Clone, Serialize)]
pub struct SshEventPayload {
    pub reason: String,
}

#[derive(Clone, Serialize)]
pub struct SshAuthPromptPayload {
    pub name: String,
    pub instructions: String,
    pub prompts: Vec<String>,
}

struct ClientHandler {
    app_handle: tauri::AppHandle,
    host_key: String, // "hostname:port"
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
                });
                return Ok(false);
            }
        }

        // First time — TOFU: accept and save
        log::info!("TOFU: accepting new host key for {} ({})", self.host_key, key_type);
        known.insert(
            self.host_key.clone(),
            KnownHostEntry {
                key_type,
                key_base64: key_b64,
                first_seen: chrono::Utc::now().to_rfc3339(),
            },
        );
        let _ = save_known_hosts(&known);
        Ok(true)
    }

    async fn data(
        &mut self,
        _channel: ChannelId,
        data: &[u8],
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let encoded = base64::engine::general_purpose::STANDARD.encode(data);
        let _ = self.app_handle.emit("ssh-output", SshOutputPayload { data: encoded });
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
        let _ = self.app_handle.emit("ssh-output", SshOutputPayload { data: encoded });
        Ok(())
    }

    async fn auth_banner(
        &mut self,
        banner: &str,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        if !banner.is_empty() {
            let encoded = base64::engine::general_purpose::STANDARD.encode(banner.as_bytes());
            let _ = self.app_handle.emit("ssh-output", SshOutputPayload { data: encoded });
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
    ) -> Result<Self, String> {
        log::info!("SSH connecting to {}:{} as '{}' ({}x{})", hostname, port, username, cols, rows);

        // Build russh config
        let config = Arc::new(client::Config {
            keepalive_interval: Some(std::time::Duration::from_secs(15)),
            keepalive_max: 3,
            ..Default::default()
        });

        let host_key = format!("{}:{}", hostname, port);

        let handler = ClientHandler {
            app_handle: app_handle.clone(),
            host_key,
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

        // Authenticate (with timeout to prevent indefinite hangs)
        let auth_success = tokio::time::timeout(
            std::time::Duration::from_secs(15),
            Self::authenticate(&mut session, username, password, key_path),
        )
        .await
        .map_err(|_| format!("Authentication timed out after 15s for {}@{}", username, addr))?
        ?;

        if !auth_success {
            log::warn!("SSH authentication failed for {}@{}", username, addr);
            return Err("Authentication failed".to_string());
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

        // Emit connected event
        let _ = app_handle.emit("ssh-connected", SshEventPayload {
            reason: "ok".to_string(),
        });

        Ok(SshSession {
            session,
            channel,
        })
    }

    async fn authenticate(
        session: &mut client::Handle<ClientHandler>,
        username: &str,
        password: Option<&str>,
        key_path: Option<&str>,
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

    /// Send a keyboard-interactive auth response from the frontend
    /// (placeholder for future keyboard-interactive support)
    pub async fn send_auth_response(&self, _response: String) -> Result<(), String> {
        // Keyboard-interactive auth responses will be implemented
        // when full challenge/response flow is added
        Ok(())
    }
}

// ─── Session Manager (app state) ───────────────────────────────────

pub struct SshManager {
    session: Option<SshSession>,
}

impl SshManager {
    pub fn new() -> Self {
        SshManager { session: None }
    }

    pub fn set_session(&mut self, session: SshSession) {
        self.session = Some(session);
    }

    pub fn take_session(&mut self) -> Option<SshSession> {
        self.session.take()
    }

    pub fn get_session(&self) -> Option<&SshSession> {
        self.session.as_ref()
    }

    pub fn is_connected(&self) -> bool {
        self.session.is_some()
    }
}
