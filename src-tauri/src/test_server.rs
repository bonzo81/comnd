//! Minimal russh SSH server for QA testing.
//!
//! Used by agent-executed QA to verify SSH connection behavior
//! (e.g., auth banner parsing, password auth, shell session).
//!
//! The server sends a known `authentication_banner` with a test URL,
//! accepts any password, and opens a shell session with a welcome message.
//!
//! Keyboard-interactive mirrors Tailscale check mode: one InfoRequest round
//! carrying the URL, then Accept on the (empty) response.

use std::sync::Arc;

use async_trait::async_trait;
use russh::keys::key::safe_rng;
use russh::keys::{Algorithm, PrivateKey, PublicKey};
use russh::server::{self, Auth, Msg, Server as _, Session};
use russh::{Channel, ChannelId, Pty};
use tokio::net::TcpListener;

// ─── Mock Server Handler ─────────────────────────────────────────────

/// Per-connection state for one SSH connection. Lives on the handler
/// (created once per connection by `new_client`), so no locking is needed.
#[derive(Default)]
struct ConnState {
    /// Authenticated username — selects the shell persona (`cisco` vs bash).
    user: String,
    /// Current prompt text (changes on cisco `enable`/`disable`).
    prompt: String,
    /// Printable content of the current input line (what the user has typed).
    line: Vec<u8>,
    /// Inside a `top` burst — only `q` is honored until it ends.
    in_top: bool,
    /// Pending escape-sequence bytes; survives across `data()` calls so a
    /// sequence split over packets still parses.
    esc_buf: Vec<u8>,
}

/// Per-connection handler: auth (captures username) + interactive shell.
struct MockHandler {
    state: ConnState,
}

impl MockHandler {
    const ESC: u8 = 0x1b;

    /// Re-send the whole current line: CR, erase-to-EOL, prompt, buffered
    /// input. Used for every line-editing key (arrows, backspace, Ctrl+W/U)
    /// so the screen and the LineTracker stay in sync. Real readline edits in
    /// place; the mock repaints instead so `contentAfter()` can reconcile.
    fn redraw(&self, out: &mut Vec<u8>) {
        out.push(b'\r');
        out.push(Self::ESC);
        out.push(b'[');
        out.push(b'K');
        out.extend_from_slice(self.state.prompt.as_bytes());
        out.extend_from_slice(&self.state.line);
    }

    /// Start a `top` burst: ~30 lines of fake output with NO trailing prompt.
    /// The missing prompt is what drives the LineTracker into passthrough.
    fn start_top(&mut self, out: &mut Vec<u8>) {
        for i in 0..30u32 {
            out.extend_from_slice(
                format!("top - {}s up 1 day, load averages: 10.0.0.1 {}\r\n", i, i % 100).as_bytes(),
            );
        }
        self.state.in_top = true;
    }

    /// Handle a submitted command (Enter). Mutates the prompt on cisco
    /// `enable`/`disable`; everything else yields canned output containing an
    /// IP so the output highlighter has something to match.
    fn dispatch_command(&mut self, cmd: &str, out: &mut Vec<u8>) {
        if cmd == "top" {
            self.start_top(out);
            return;
        }
        if self.state.user == "cisco" {
            match cmd {
                "enable" => {
                    self.state.prompt = "Router#".into();
                    out.extend_from_slice(b"\r\nRouter#");
                    return;
                }
                "disable" => {
                    self.state.prompt = "Router>".into();
                    out.extend_from_slice(b"\r\nRouter>");
                    return;
                }
                _ => {}
            }
        }
        out.extend_from_slice(format!("\r\n10.0.0.1\r\n{}", self.state.prompt).as_bytes());
    }

    /// A completed escape sequence arrived. Line-editing sequences (arrows,
    /// home/end, ins/del via CSI or SS3) repaint the current line; anything
    /// else is consumed silently.
    fn on_escape_sequence(&mut self, seq: &[u8], out: &mut Vec<u8>) {
        let is_line_edit = matches!(
            seq,
            [Self::ESC, _, b'A'..=b'D' | b'H' | b'F'] | [Self::ESC, b'[', b'1'..=b'4', b'~']
        );
        if is_line_edit && !self.state.in_top {
            self.redraw(out);
        }
    }

    /// Feed one input byte into the mock shell, appending any device output to
    /// `out`. Handles escape-sequence buffering, interactive-app (`top`) mode,
    /// control keys, and printable echo.
    fn handle_byte(&mut self, b: u8, out: &mut Vec<u8>) {
        // Escape-sequence buffering (CSI / SS3). A sequence is complete once we
        // have at least ESC + introducer + a final byte in 0x40..=0x7e.
        if !self.state.esc_buf.is_empty() {
            // Bare ESC followed by a plain char is not a sequence — drop the
            // ESC and process the char normally so input never gets stuck.
            if self.state.esc_buf.len() == 1
                && self.state.esc_buf[0] == Self::ESC
                && b >= 0x20
                && b != b'['
                && b != b'O'
            {
                self.state.esc_buf.clear();
            } else {
                self.state.esc_buf.push(b);
                if self.state.esc_buf.len() >= 3 && (0x40..=0x7e).contains(&b) {
                    let seq = std::mem::take(&mut self.state.esc_buf);
                    self.on_escape_sequence(&seq, out);
                }
                return;
            }
        } else if b == Self::ESC {
            self.state.esc_buf.push(b);
            return;
        }

        // Interactive-app mode: swallow everything except `q`, which exits.
        // No echo here — `top` consumes its input, and echoing CR would
        // double-send the prompt.
        if self.state.in_top {
            if b == b'q' {
                self.state.in_top = false;
                out.extend_from_slice(b"\r\n");
                out.extend_from_slice(self.state.prompt.as_bytes());
            }
            return;
        }

        match b {
            0x03 => {
                // Ctrl+C: clear the line, then a fresh prompt.
                self.state.line.clear();
                out.extend_from_slice(b"^C\r\n");
                out.extend_from_slice(self.state.prompt.as_bytes());
            }
            0x15 => {
                // Ctrl+U: kill the whole line.
                self.state.line.clear();
                self.redraw(out);
            }
            0x17 => {
                // Ctrl+W: delete the last word (must pass through to remote).
                while let Some(&c) = self.state.line.last() {
                    if c != b' ' {
                        self.state.line.pop();
                    } else {
                        break;
                    }
                }
                while let Some(&c) = self.state.line.last() {
                    if c == b' ' {
                        self.state.line.pop();
                    } else {
                        break;
                    }
                }
                self.redraw(out);
            }
            0x0d | 0x0a => {
                let cmd = String::from_utf8_lossy(&self.state.line).into_owned();
                self.state.line.clear();
                self.dispatch_command(&cmd, out);
            }
            0x7f | 0x08 => {
                // Backspace / DEL: drop the last char and repaint.
                if !self.state.line.is_empty() {
                    self.state.line.pop();
                    self.redraw(out);
                }
            }
            _ if b >= 0x20 => {
                // Printable: echo it and append to the buffered line.
                self.state.line.push(b);
                out.push(b);
            }
            _ => {}
        }
    }
}

/// The SSH server (unit type). One handler is created per connection.
#[derive(Clone)]
struct MockServer;

impl server::Server for MockServer {
    type Handler = MockHandler;

    fn new_client(&mut self, _peer_addr: Option<std::net::SocketAddr>) -> Self::Handler {
        MockHandler { state: ConnState::default() }
    }
}

#[async_trait]
impl server::Handler for MockHandler {
    type Error = russh::Error;

    /// Accept any username/password combination.
    async fn auth_password(
        &mut self,
        user: &str,
        _password: &str,
    ) -> Result<Auth, Self::Error> {
        self.state.user = user.to_string();
        Ok(Auth::Accept)
    }

    /// Check-mode semantics (Tailscale): accept ANY publickey. Russh verifies
    /// the signature; acceptance means the session opens pending browser auth.
    async fn auth_publickey(
        &mut self,
        user: &str,
        _public_key: &PublicKey,
    ) -> Result<Auth, Self::Error> {
        self.state.user = user.to_string();
        Ok(Auth::Accept)
    }

    /// Tailscale-style browser auth: first round sends the URL prompt,
    /// any response (empty = browser login done) is accepted.
    async fn auth_keyboard_interactive(
        &mut self,
        user: &str,
        _submethods: &str,
        response: Option<server::Response<'async_trait>>,
    ) -> Result<Auth, Self::Error> {
        self.state.user = user.to_string();
        if response.is_none() {
            Ok(Auth::Partial {
                name: "Tailscale SSH authentication".into(),
                instructions: "To authenticate, visit:\nhttps://login.tailscale.com/a/test123\n".into(),
                prompts: vec![(
                    "Visit https://login.tailscale.com/a/test123 and press enter".into(),
                    true,
                )]
                .into(),
            })
        } else {
            Ok(Auth::Accept)
        }
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
        session.channel_success(channel)?;
        Ok(())
    }

    /// Open a shell session and send a persona-appropriate banner + prompt.
    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        let (banner, prompt) = if self.state.user == "cisco" {
            ("Welcome to mock IOS-XE", "Router>")
        } else {
            ("Welcome to mock Linux box", "user@host:~$ ")
        };
        self.state.prompt = prompt.into();
        session.data(
            channel,
            format!("\r\n{}\r\n{}", banner, prompt).as_bytes().to_vec().into(),
        )?;
        Ok(())
    }

    /// Interactive shell input: feed each byte through the mock shell and send
    /// back any device output (echoes, redraws, command results).
    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let mut out = Vec::new();
        for &b in data {
            self.handle_byte(b, &mut out);
        }
        if !out.is_empty() {
            session.data(channel, out.into())?;
        }
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
    let key = PrivateKey::random(&mut safe_rng(), Algorithm::Ed25519)
        .expect("Failed to generate mock server key");

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

// ─── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use russh::client::{self, KeyboardInteractiveAuthResponse};

    struct NoopHandler;

    #[async_trait]
    impl client::Handler for NoopHandler {
        type Error = russh::Error;
        async fn check_server_key(
            &mut self,
            _key: &russh::keys::PublicKey,
        ) -> Result<bool, Self::Error> {
            Ok(true) // test key — trust anything
        }
    }

    /// Pins the Tailscale-style browser-auth round-trip that
    /// SshSession::authenticate relies on:
    /// start(None) → InfoRequest carrying an https URL → empty respond → Success.
    #[tokio::test]
    async fn test_keyboard_interactive_browser_auth_roundtrip() {
        let (port, server) = start_mock_server().await;

        let config = Arc::new(client::Config::default());
        let mut session = client::connect(
            config,
            format!("127.0.0.1:{}", port),
            NoopHandler,
        )
        .await
        .expect("connect");

        let first = session
            .authenticate_keyboard_interactive_start("andy", None::<String>)
            .await
            .expect("kbd-int start");
        match first {
            KeyboardInteractiveAuthResponse::InfoRequest { ref instructions, ref prompts, .. } => {
                assert!(instructions.contains("https://login.tailscale.com/"));
                assert_eq!(prompts.len(), 1);
                assert!(prompts[0].prompt.contains("https://"));
            }
            other => panic!("expected InfoRequest, got {:?}", other),
        }

        let second = session
            .authenticate_keyboard_interactive_respond(vec![String::new()])
            .await
            .expect("kbd-int respond");
        assert!(matches!(second, KeyboardInteractiveAuthResponse::Success));

        server.abort();
    }

    /// Pins the ephemeral-key path SshSession::authenticate uses for
    /// credential-less browser-auth gateways: check-mode server accepts
    /// an ephemeral (unknown) publickey.
    #[tokio::test]
    async fn test_ephemeral_publickey_accepted_check_mode() {
        let (port, server) = start_mock_server().await;

        let config = Arc::new(client::Config::default());
        let mut session = client::connect(
            config,
            format!("127.0.0.1:{}", port),
            NoopHandler,
        )
        .await
        .expect("connect");

        let key = PrivateKey::random(&mut safe_rng(), Algorithm::Ed25519).expect("keygen");
        let key = russh::keys::key::PrivateKeyWithHashAlg::new(Arc::new(key), None)
            .expect("wrap key");
        let ok = session
            .authenticate_publickey("andy", key)
            .await
            .expect("pubkey auth");
        assert!(ok);

        server.abort();
    }

    /// Printable chars echo; backspace and Ctrl+W repaint the whole line so
    /// the LineTracker can reconcile via `contentAfter()`.
    #[test]
    fn mock_shell_line_editing_redraws() {
        let mut h = MockHandler {
            state: ConnState { user: "cisco".into(), prompt: "Router>".into(), ..Default::default() },
        };
        let e = MockHandler::ESC;

        let mut out = Vec::new();
        for b in b"enable" { h.handle_byte(*b, &mut out); }
        assert_eq!(out, b"enable");

        out.clear();
        h.handle_byte(0x7f, &mut out);
        let mut expected = vec![b'\r', e, b'[', b'K'];
        expected.extend_from_slice(b"Router>enabl");
        assert_eq!(out, expected);

        out.clear();
        h.handle_byte(0x17, &mut out);
        let mut expect_w = vec![b'\r', e, b'[', b'K'];
        expect_w.extend_from_slice(b"Router>");
        assert_eq!(out, expect_w);

        for b in b"enable" { h.handle_byte(*b, &mut out); }
        out.clear();
        h.handle_byte(0x0d, &mut out);
        assert_eq!(out, b"\r\nRouter#");
        assert_eq!(h.state.prompt, "Router#");
    }

    /// `top` emits a prompt-less burst (drives LineTracker passthrough); only
    /// `q` is honored until it re-prompts.
    #[test]
    fn mock_shell_top_burst_and_quit() {
        let mut h = MockHandler {
            state: ConnState { user: "root".into(), prompt: "user@host:~$ ".into(), ..Default::default() },
        };

        let mut out = Vec::new();
        for b in b"top" { h.handle_byte(*b, &mut out); }
        out.clear();
        h.handle_byte(0x0d, &mut out);
        assert!(h.state.in_top);
        let text = String::from_utf8_lossy(&out).into_owned();
        assert_eq!(text.matches("\r\n").count(), 30);
        assert!(!text.ends_with("user@host:~$ "));

        out.clear();
        h.handle_byte(b'x', &mut out);
        assert!(out.is_empty());
        h.handle_byte(b'q', &mut out);
        assert_eq!(out, b"\r\nuser@host:~$ ");
        assert!(!h.state.in_top);
    }
}
