//! Minimal russh SSH server for QA testing.
//!
//! Used by agent-executed QA to verify SSH connection behavior
//! (e.g., auth banner parsing, password auth, shell session).
//!
//! The server sends a known `authentication_banner` with a test URL,
//! accepts any password, and opens a shell session with a welcome message.
//!
//! Four keyboard-interactive personas (per server instance):
//! - Browser auth mirrors Tailscale check mode: one InfoRequest round
//!   carrying the URL, then Accept on the (empty) response.
//! - Password prompt (issue #12) mirrors a Cisco-style device: one
//!   `Password:` round; only the expected password accepts, and publickey
//!   and password methods are rejected so keyboard-interactive is the
//!   only way in.
//! - Password-only (issue #12) mirrors a Linux box with
//!   `KbdInteractiveAuthentication no`: the keyboard-interactive method is
//!   refused outright and only the `password` method accepts — pins the
//!   client-side password prompt fallback.
//! - Informational round (issue #12 review): a zero-prompt round precedes
//!   the `Password:` round — pins that empty rounds are auto-answered
//!   instead of stalling auth until the 120s timeout.

use std::sync::Arc;

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
    kbd_int: KbdIntPersona,
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

/// The keyboard-interactive persona one server instance plays.
#[derive(Clone)]
enum KbdIntPersona {
    /// Tailscale check mode: one URL round; any (empty) response accepts,
    /// and any publickey is accepted too (check-mode semantics).
    BrowserAuth,
    /// Cisco-style password round (issue #12): one `Password:` prompt;
    /// only `expected` accepts. Publickey and password methods are
    /// rejected so keyboard-interactive is the only way in.
    Password { expected: String },
    /// Linux-style password-only server (issue #12): the
    /// keyboard-interactive method is refused outright; only the
    /// `password` method accepts, and only with `expected`. Pins the
    /// client-side password prompt fallback.
    PasswordOnly { expected: String },
    /// Informational round before the password round (issue #12 review):
    /// the first keyboard-interactive round carries instructions but
    /// zero prompts. Pins that empty rounds are auto-answered with an
    /// empty response — auth proceeds instead of stalling on the user.
    PasswordInfoRound { expected: String },
}

/// The SSH server. One handler is created per connection.
#[derive(Clone)]
struct MockServer {
    kbd_int: KbdIntPersona,
}

impl server::Server for MockServer {
    type Handler = MockHandler;

    fn new_client(&mut self, _peer_addr: Option<std::net::SocketAddr>) -> Self::Handler {
        MockHandler {
            state: ConnState::default(),
            kbd_int: self.kbd_int.clone(),
        }
    }
}

impl server::Handler for MockHandler {
    type Error = russh::Error;

    /// Auth method acceptance per persona: browser-auth servers accept any
    /// password and any publickey (check mode); the password-round persona
    /// forces keyboard-interactive; the password-only persona (Linux-style,
    /// issue #12) accepts only the right password via the `password` method.
    async fn auth_password(
        &mut self,
        user: &str,
        password: &str,
    ) -> Result<Auth, Self::Error> {
        self.state.user = user.to_string();
        match &self.kbd_int {
            KbdIntPersona::BrowserAuth => Ok(Auth::Accept),
            KbdIntPersona::PasswordOnly { expected } => {
                if password == expected.as_str() {
                    Ok(Auth::Accept)
                } else {
                    Ok(Auth::reject())
                }
            }
            KbdIntPersona::Password { .. } | KbdIntPersona::PasswordInfoRound { .. } => {
                Ok(Auth::reject())
            }
        }
    }

    /// Check-mode semantics (Tailscale): accept ANY publickey. Russh verifies
    /// the signature; acceptance means the session opens pending browser auth.
    /// Device personas reject unknown keys, like real gear.
    async fn auth_publickey(
        &mut self,
        user: &str,
        _public_key: &PublicKey,
    ) -> Result<Auth, Self::Error> {
        self.state.user = user.to_string();
        match self.kbd_int {
            KbdIntPersona::BrowserAuth => Ok(Auth::Accept),
            KbdIntPersona::Password { .. }
            | KbdIntPersona::PasswordOnly { .. }
            | KbdIntPersona::PasswordInfoRound { .. } => {
                Ok(Auth::reject())
            }
        }
    }

    /// Keyboard-interactive per persona: Tailscale-style browser auth (first
    /// round sends the URL prompt, any response accepts) or a Cisco-style
    /// `Password:` round where only the expected password accepts.
    async fn auth_keyboard_interactive<'a>(
        &'a mut self,
        user: &str,
        _submethods: &str,
        response: Option<server::Response<'a>>,
    ) -> Result<Auth, Self::Error> {
        self.state.user = user.to_string();
        match &self.kbd_int {
            KbdIntPersona::BrowserAuth => {
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
            KbdIntPersona::Password { expected } => match response {
                None => Ok(Auth::Partial {
                    name: "Password authentication".into(),
                    instructions: "".into(),
                    prompts: vec![("Password: ".into(), false)].into(),
                }),
                Some(mut responses) => {
                    let got = responses
                        .next()
                        .map(|b| String::from_utf8_lossy(&b).into_owned())
                        .unwrap_or_default();
                    if got == *expected {
                        Ok(Auth::Accept)
                    } else {
                        Ok(Auth::reject())
                    }
                }
            },
            KbdIntPersona::PasswordOnly { .. } => {
                // No keyboard-interactive on this server — refuse the method
                // outright, before any round (mirrors Linux with
                // `KbdInteractiveAuthentication no`).
                Ok(Auth::reject())
            }
            KbdIntPersona::PasswordInfoRound { expected } => match response {
                None => Ok(Auth::Partial {
                    name: "Informational".into(),
                    instructions: "Authorized users only.".into(),
                    prompts: vec![].into(),
                }),
                Some(mut responses) => {
                    let first = responses
                        .next()
                        .map(|b| String::from_utf8_lossy(&b).into_owned());
                    match first {
                        // The empty answer to the informational round —
                        // issue the real password challenge.
                        None => Ok(Auth::Partial {
                            name: "Password authentication".into(),
                            instructions: "".into(),
                            prompts: vec![("Password: ".into(), false)].into(),
                        }),
                        Some(got) => {
                            if got == *expected {
                                Ok(Auth::Accept)
                            } else {
                                Ok(Auth::reject())
                            }
                        }
                    }
                }
            },
        }
    }

    /// The auth banner every persona sends (0.60 moved this from
    /// server::Config to the handler).
    async fn authentication_banner(&mut self) -> Result<Option<String>, Self::Error> {
        Ok(Some(
            "To authenticate, visit: https://login.tailscale.com/a/test123\n".to_string(),
        ))
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
        // 0.60: Session::data takes `impl Into<Bytes>` — a plain Vec<u8>
        // converts without the old `.into()` dance.
        session.data(channel, format!("\r\n{}\r\n{}", banner, prompt).as_bytes().to_vec())?;
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
            session.data(channel, out)?;
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
    start_mock_server_with(KbdIntPersona::BrowserAuth).await
}

/// Start a mock SSH server whose keyboard-interactive is a Cisco-style
/// `Password:` round (issue #12). `expected` is the accepting password;
/// publickey and password methods are rejected so keyboard-interactive is
/// the only route in — mirroring a device the user must log into manually.
pub async fn start_credential_mock_server(expected: &str) -> (u16, tokio::task::JoinHandle<()>) {
    start_mock_server_with(KbdIntPersona::Password { expected: expected.to_string() }).await
}

/// Start a mock SSH server with no keyboard-interactive at all — only the
/// `password` method accepts, with `expected` (issue #12). Mirrors a Linux
/// box with `KbdInteractiveAuthentication no`; pins the client-side
/// password prompt fallback.
pub async fn start_password_only_mock_server(expected: &str) -> (u16, tokio::task::JoinHandle<()>) {
    start_mock_server_with(KbdIntPersona::PasswordOnly { expected: expected.to_string() }).await
}

/// Start a mock SSH server whose first keyboard-interactive round is
/// informational (zero prompts), followed by a `Password:` round
/// (issue #12 review). Pins that empty rounds never stall auth: the
/// client answers them automatically with an empty response vector.
pub async fn start_info_round_mock_server(expected: &str) -> (u16, tokio::task::JoinHandle<()>) {
    start_mock_server_with(KbdIntPersona::PasswordInfoRound { expected: expected.to_string() }).await
}

/// Persona-driven server bootstrap shared by both public constructors.
async fn start_mock_server_with(kbd_int: KbdIntPersona) -> (u16, tokio::task::JoinHandle<()>) {
    // Generate an ephemeral Ed25519 key pair
    let key = PrivateKey::random(&mut safe_rng(), Algorithm::Ed25519)
        .expect("Failed to generate mock server key");

    let config = Arc::new(server::Config {
        keys: vec![key],
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
        let mut server = MockServer { kbd_int };
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

    /// Pins the Cisco-style credential round-trip issue #12 relies on:
    /// start(None) → InfoRequest with a `Password:` prompt (no URL, no
    /// echo) → respond with the user's password → Success. A wrong answer
    /// resolves the round to Failure. Mirrors the browser-auth roundtrip
    /// test above, on the password persona.
    #[tokio::test]
    async fn test_keyboard_interactive_credential_roundtrip() {
        let (port, server) = start_credential_mock_server("secret-pw").await;

        // Connection 1: the device surfaces the prompt…
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
                // Credential round: no URL (that would be browser-auth),
                // one password prompt, echo off.
                assert!(!instructions.contains("https://"));
                assert_eq!(prompts.len(), 1);
                assert!(prompts[0].prompt.contains("Password"));
                assert!(!prompts[0].prompt.contains("https://"));
                assert!(!prompts[0].echo, "password prompts must not echo");
            }
            other => panic!("expected InfoRequest, got {:?}", other),
        }

        // …a wrong answer fails the round (server rejects the method)…
        let wrong = session
            .authenticate_keyboard_interactive_respond(vec!["not-the-password".to_string()])
            .await
            .expect("kbd-int respond (wrong password)");
        assert!(matches!(wrong, KeyboardInteractiveAuthResponse::Failure { .. }));

        // …and the right answer on a fresh connection completes auth.
        let mut session = client::connect(
            Arc::new(client::Config::default()),
            format!("127.0.0.1:{}", port),
            NoopHandler,
        )
        .await
        .expect("reconnect");

        session
            .authenticate_keyboard_interactive_start("andy", None::<String>)
            .await
            .expect("kbd-int start (2)");
        let second = session
            .authenticate_keyboard_interactive_respond(vec!["secret-pw".to_string()])
            .await
            .expect("kbd-int respond (right password)");
        assert!(matches!(second, KeyboardInteractiveAuthResponse::Success));

        server.abort();
    }

    /// Pins the client-side password prompt fallback (issue #12) for
    /// servers with no keyboard-interactive: the method is refused with
    /// Failure before any round, and the `password` method — fed the
    /// user's typed password — completes auth on the same session.
    /// A wrong typed password is rejected (client re-prompts).
    #[tokio::test]
    async fn test_password_method_fallback_roundtrip() {
        let (port, server) = start_password_only_mock_server("secret-pw").await;

        let config = Arc::new(client::Config::default());
        let mut session = client::connect(
            config,
            format!("127.0.0.1:{}", port),
            NoopHandler,
        )
        .await
        .expect("connect");

        // The server refuses keyboard-interactive outright — no round.
        let kbd = session
            .authenticate_keyboard_interactive_start("andy", None::<String>)
            .await
            .expect("kbd-int start (refused)");
        assert!(matches!(kbd, KeyboardInteractiveAuthResponse::Failure { .. }));

        // …so the client prompts locally and the typed answer completes
        // auth via the single-shot password method.
        let ok = session
            .authenticate_password("andy", "secret-pw")
            .await
            .expect("password auth after kbd-int refusal");
        assert!(ok.success());

        // A wrong typed password is rejected — the client re-prompts rather
        // than failing the whole connect.
        let mut session = client::connect(
            Arc::new(client::Config::default()),
            format!("127.0.0.1:{}", port),
            NoopHandler,
        )
        .await
        .expect("reconnect");
        let wrong = session
            .authenticate_password("andy", "not-the-password")
            .await
            .expect("password auth (wrong password)");
        assert!(!wrong.success());

        server.abort();
    }

    /// Pins zero-prompt round handling (issue #12 review): an
    /// informational keyboard-interactive round carries no prompts, so it
    /// must be answered with an empty vector — auth proceeds to the real
    /// password round instead of stalling until the 120s timeout.
    #[tokio::test]
    async fn test_zero_prompt_round_auto_answered() {
        let (port, server) = start_info_round_mock_server("secret-pw").await;

        let config = Arc::new(client::Config::default());
        let mut session = client::connect(config, format!("127.0.0.1:{}", port), NoopHandler)
            .await
            .expect("connect");

        // Round 1: informational — instructions, zero prompts.
        let first = session
            .authenticate_keyboard_interactive_start("andy", None::<String>)
            .await
            .expect("kbd-int start (informational)");
        match first {
            KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                assert!(prompts.is_empty());
            }
            _ => panic!("expected an informational InfoRequest round"),
        }

        // The empty round is answered with an empty vector (what the
        // ssh.rs guard now does automatically, without a user round)…
        let second = session
            .authenticate_keyboard_interactive_respond(vec![])
            .await
            .expect("kbd-int respond (empty answer)");
        assert!(matches!(second, KeyboardInteractiveAuthResponse::InfoRequest { .. }));

        // …and the real password round answers normally.
        let third = session
            .authenticate_keyboard_interactive_respond(vec!["secret-pw".to_string()])
            .await
            .expect("kbd-int respond (password)");
        assert!(matches!(third, KeyboardInteractiveAuthResponse::Success));

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
        let key = russh::keys::key::PrivateKeyWithHashAlg::new(Arc::new(key), None);
        let ok = session
            .authenticate_publickey("andy", key)
            .await
            .expect("pubkey auth");
        assert!(ok.success());

        server.abort();
    }

    /// Printable chars echo; backspace and Ctrl+W repaint the whole line so
    /// the LineTracker can reconcile via `contentAfter()`.
    #[test]
    fn mock_shell_line_editing_redraws() {
        let mut h = MockHandler {
            state: ConnState { user: "cisco".into(), prompt: "Router>".into(), ..Default::default() },
            kbd_int: KbdIntPersona::BrowserAuth,
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
            kbd_int: KbdIntPersona::BrowserAuth,
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
