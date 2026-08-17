//! Minimal russh SSH server for QA testing.
//!
//! Used by agent-executed QA to verify SSH connection behavior
//! (e.g., auth banner parsing, password auth, shell session).
//!
//! The server sends a known `authentication_banner` with a test URL,
//! accepts any password, and opens a shell session with a welcome message.

use std::sync::Arc;

use async_trait::async_trait;
use russh::keys::key::KeyPair;
use russh::server::{self, Auth, Msg, Server as _, Session};
use russh::{Channel, ChannelId, Pty};
use tokio::net::TcpListener;

// ─── Mock Server Handler ─────────────────────────────────────────────

/// Minimal SSH server handler — accepts any password, sends test auth banner.
#[derive(Clone)]
struct MockServer;

impl server::Server for MockServer {
    type Handler = Self;

    fn new_client(&mut self, _peer_addr: Option<std::net::SocketAddr>) -> Self::Handler {
        self.clone()
    }
}

#[async_trait]
impl server::Handler for MockServer {
    type Error = russh::Error;

    /// Accept any username/password combination.
    async fn auth_password(
        &mut self,
        _user: &str,
        _password: &str,
    ) -> Result<Auth, Self::Error> {
        Ok(Auth::Accept)
    }

    /// Accept session channel open requests.
    async fn channel_open_session(
        &mut self,
        _channel: Channel<Msg>,
        _session: &mut Session,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }

    /// Accept PTY allocation requests.
    #[allow(clippy::too_many_arguments)]
    async fn pty_request(
        &mut self,
        channel: ChannelId,
        _term: &str,
        _col_width: u32,
        _row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        _modes: &[(Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel);
        Ok(())
    }

    /// Accept shell requests and send a welcome message.
    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel);
        session.data(
            channel,
            "Welcome to mock device\nDocs: https://example.com\r\n$ ".as_bytes().to_vec().into(),
        );
        Ok(())
    }
}

// ─── Public API ──────────────────────────────────────────────────────

/// Start a mock SSH server bound to `127.0.0.1:0` (random port).
///
/// # Returns
/// - `u16` — the assigned port number
/// - `JoinHandle<()>` — handle to the server task; abort to stop the server
pub async fn start_mock_server() -> (u16, tokio::task::JoinHandle<()>) {
    // Generate an ephemeral Ed25519 key pair
    let key = KeyPair::generate_ed25519();

    let config = Arc::new(server::Config {
        keys: vec![key],
        auth_banner: Some(
            "To authenticate, visit: https://login.tailscale.com/a/test123\n",
        ),
        inactivity_timeout: None, // Don't time out during tests
        auth_rejection_time: std::time::Duration::from_secs(1),
        ..Default::default()
    });

    let socket = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("Failed to bind mock server socket");
    let port = socket
        .local_addr()
        .expect("Failed to get local address")
        .port();

    // Move socket and server into a spawned task so they outlive this function
    let handle = tokio::spawn(async move {
        let mut server = MockServer;
        let running = server.run_on_socket(config, &socket);
        running.await.expect("Mock server encountered an error");
    });

    (port, handle)
}
