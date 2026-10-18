# Plan: Terminal Transcript Module

**Status: proposed — not implemented.**

Origin: architecture review of logging (2026-09-19), candidate 1 "Deepen the
terminal-output seam into a Transcript module" (Strong). This plan is
self-contained; the review's findings are restated below so no prior context
is needed. Line numbers are as of 2026-09-19 and may drift — re-locate by the
symbol names given.

**Re-verified 2026-09-21** against `main` @ `45fe61d`: every file this plan
references (`ssh.rs`, `session_log.rs`, `lib.rs`, `config.rs`,
`session-channel.ts`, `session-channel.test.ts`, `AGENTS.md`) is identical
between the 2026-09-19 snapshot and `main`, so all line references remain
valid.

## Problem

Terminal-bound output has no single owner. `src-tauri/src/ssh.rs` emits the
`ssh-output` Tauri event from **five** hand-rolled call sites, and only two of
them also write the per-session log file (`crate::session_log`):

| # | Site (ssh.rs) | Emits to terminal | Writes session log |
|---|---|---|---|
| 1 | `ClientHandler::data` (~line 250) | yes | yes |
| 2 | `ClientHandler::extended_data` (~line 264) | yes | yes |
| 3 | `ClientHandler::auth_banner` (~line 280) | yes | **no — gap** |
| 4 | kbd-interactive instructions in `SshSession::authenticate` (~line 635) | yes | **no — gap** |
| 5 | kbd-interactive prompts in `SshSession::authenticate` (~line 640) | yes | **no — gap** |

Consequences:

1. **The session log diverges from the screen.** Pre-auth banners and
   keyboard-interactive prompts (sudo/enable password prompts, Tailscale-style
   login URLs) appear on the user's terminal but never in the session log —
   which is the audit artifact. The Settings UI warns users that session logs
   "capture everything on screen", which is currently untrue for auth output.
2. **The fan-out is unreachable by tests.** The write path lives inside the
   russh `client::Handler` impl, which requires a live SSH session (or a real
   `tauri::AppHandle`) to exercise. `session_log.rs` itself is unit-tested, but
   the "write on every output chunk" wiring is only verified manually.
3. **Every new output source must remember the fan-out.** Sites 3–5 forgot the
   log half; the next one will too.

## Goal

| Item | Why |
|---|---|
| One seam: all terminal-bound byte streams pass through `Transcript::output` | Fan-out can't be forgotten or diverge |
| Auth-phase output reaches the session log | Transcript == screen, by construction |
| The fan-out is unit-testable without SSH or a Tauri app handle | Bugs concentrate where tests can reach |
| Zero frontend changes, zero event-contract changes | `session-channel.ts` must keep working untouched |

## Non-goals

- Session-log retention/pruning (explicitly deferred by
  `plan-phase1-session-management.md`; separate review candidate).
- Eager session-log file creation (see Open questions).
- Fixing `get_session_log_dir` (config.rs — returns the default dir and
  ignores `session_log_dir`; separate issue).
- Consolidating app-log setup out of lib.rs (separate review candidate).
- Driving the full `ClientHandler` wiring from the mock SSH server (possible
  future integration test; the seam this plan creates is the prerequisite).

## Current state (what we build on)

- **Event contract (load-bearing, must not change):** the frontend listens on
  `"ssh-output"` with payload `{ data: <base64 string>, session_id: <number> }`
  and base64-decodes `data` (see `src/lib/session-channel.ts:142-147` and
  `src/lib/session-channel.test.ts:66`). Rust's payload struct:
  `SshOutputPayload { data: String, session_id: u64 }` (ssh.rs ~line 141, with
  derive attributes — copy them verbatim when moving).
- **SessionLog** (`src-tauri/src/session_log.rs`) is already a clean module
  with a test seam (`SessionLog::new_in(dir, ...)`). File opens lazily on first
  `write()`, a `# host=…` header is written then, optional per-chunk local-time
  stamps, flush per chunk. This plan does **not** change `session_log.rs`.
- **Creation:** `SshSession::connect` (ssh.rs ~386-398) builds
  `Option<SessionLog>` from three config params (`session_logging`,
  `session_log_timestamps`, `session_log_dir`), read per-connect by the
  `ssh_connect` command (ssh.rs ~1009-1013). Toggles apply to new sessions —
  unchanged by this plan.
- **Why shared ownership is required:** the handler is *moved into*
  `client::connect(...)` (ssh.rs ~410-416), so `ClientHandler` owns the session
  log during the connection, but the keyboard-interactive emits happen in
  `SshSession::authenticate`, which runs *after* `client::connect` returns and
  cannot reach the handler. Both phases must write to the **same**
  `SessionLog` (one ordered transcript per session), so the transcript handle
  must be shared: `Arc<std::sync::Mutex<Transcript>>`.

## Design decisions (recorded — do not re-litigate)

1. **`std::sync::Mutex`, not `tokio::sync::Mutex`.** `Transcript::output` is
   synchronous (file write + event emit) and the lock is never held across an
   `.await`. Locking per output chunk costs nanoseconds against network-sized
   chunks.
2. **Poison recovery via `PoisonError::into_inner`.** If a write panics while
   holding the lock, later output must still flow — a poisoned transcript must
   not brick the terminal. `SessionLog::write` already swallows IO errors
   (`let _ = …`), so this is defense against panics only.
3. **`SshOutputPayload` moves to `transcript.rs`.** It is part of the sink
   contract, and after this plan ssh.rs no longer constructs it. Keep its
   existing derive attributes (`Clone`, `Serialize`) verbatim. ssh.rs keeps
   `SshEventPayload`, `SshTofuPendingPayload`, `SshAuthUrlPayload` where they
   are.
4. **A sink trait, not a closure.** Two adapters justify the seam:
   `TauriOutputSink` in prod, capture sinks in tests. This mirrors the
   frontend's `SessionTransport` idiom (`session-channel.ts:30-49`:
   interface + prod impl + in-memory test impl).
5. **Order inside `output()`: session log first, then emit** — matching
   today's `data()` callback and keeping file order aligned with what the user
   saw.
6. **Lazy file creation stays.** A session that produces no output still
   creates no file (see Open questions).

## P1 — New module `src-tauri/src/transcript.rs`

```rust
//! Transcript — the single seam for terminal-bound output.
//!
//! Every byte stream that belongs on the user's terminal (channel data,
//! stderr, pre-auth banners, keyboard-interactive prompts) passes through
//! `Transcript::output`, which fans it out to two places:
//!   1. the per-session log file (crate::session_log::SessionLog), and
//!   2. the frontend terminal, via the `ssh-output` Tauri event.
//! Before this module existed the fan-out was hand-rolled at each call site,
//! so auth-phase output reached the screen but never the session log — the
//! transcript silently diverged from what the user saw.
//!
//! Event contract (load-bearing): session-channel.ts listens for
//! "ssh-output" and decodes `data` from base64. Do not change the event name
//! or payload shape.
//!
//! `OutputSink` is the test seam: prod emits a Tauri event, tests capture.

use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::Emitter;

use crate::session_log::SessionLog;

/// Payload for the `ssh-output` event. Moved from ssh.rs (it is part of the
/// sink contract) — keep the derives it had there.
#[derive(Clone, Serialize)]
pub struct SshOutputPayload {
    pub data: String,
    pub session_id: u64,
}

/// Where terminal-bound output goes besides the session log.
/// Two adapters justify the seam: Tauri event emit in prod, capture in tests.
pub trait OutputSink: Send + Sync {
    fn emit_output(&self, encoded: &str);
}

/// Prod sink: emits `ssh-output` to the frontend terminal.
pub struct TauriOutputSink {
    app_handle: tauri::AppHandle,
    session_id: u64,
}

impl TauriOutputSink {
    pub fn new(app_handle: tauri::AppHandle, session_id: u64) -> Self {
        Self { app_handle, session_id }
    }
}

impl OutputSink for TauriOutputSink {
    fn emit_output(&self, encoded: &str) {
        let _ = self.app_handle.emit(
            "ssh-output",
            SshOutputPayload { data: encoded.to_string(), session_id: self.session_id },
        );
    }
}

/// One fan-out point for terminal-bound output. Session log first (file
/// ordering matches what the user saw), then the event emit.
pub struct Transcript {
    session_log: Option<SessionLog>,
    sink: Box<dyn OutputSink>,
}

/// Shared handle: auth-phase output is written from `SshSession::authenticate`
/// while post-auth output arrives in the russh `Handler` callbacks — both
/// need the same SessionLog writer, so the Transcript is shared. The lock is
/// never held across an await; `output` is synchronous.
pub type SharedTranscript = Arc<Mutex<Transcript>>;

impl Transcript {
    pub fn new(session_log: Option<SessionLog>, sink: Box<dyn OutputSink>) -> Self {
        Self { session_log, sink }
    }

    /// Wrap in the shared handle (see `SharedTranscript`).
    pub fn shared(self) -> SharedTranscript {
        Arc::new(Mutex::new(self))
    }

    /// The seam. Every terminal-bound byte stream calls this.
    pub fn output(&mut self, data: &[u8]) {
        if let Some(log) = self.session_log.as_mut() {
            log.write(data);
        }
        let encoded = base64::engine::general_purpose::STANDARD.encode(data);
        self.sink.emit_output(&encoded);
    }
}

/// Lock and write, recovering from poisoning — one panicked write (e.g. a
/// failing session-log file) must not brick all later terminal output.
pub fn write_output(shared: &SharedTranscript, data: &[u8]) {
    match shared.lock() {
        Ok(mut transcript) => transcript.output(data),
        Err(poisoned) => poisoned.into_inner().output(data),
    }
}
```

Notes:

- `use tauri::Emitter;` is required in Tauri v2 (`emit` lives on the `Emitter`
  trait) — ssh.rs already imports it; transcript.rs needs its own import.
- The `base64` engine is the same one ssh.rs uses today
  (`base64::engine::general_purpose::STANDARD`); dependency already in
  Cargo.toml.

## P2 — Register the module

`src-tauri/src/lib.rs` module list (~lines 6-21): add

```rust
mod transcript;
```

next to `mod session_log;`.

Also update the file map in `AGENTS.md` (src-tauri/src section) with a line
after `session_log.rs`:

```
    transcript.rs        # Terminal output seam: session log + ssh-output fan-out
```

## P3 — Rewire `ssh.rs`

### 3.1 `ClientHandler` struct (~line 158)

```rust
struct ClientHandler {
    app_handle: tauri::AppHandle,
    host_key: String, // "hostname:port"
    session_id: u64,
    transcript: crate::transcript::SharedTranscript,   // was: session_log: Option<crate::session_log::SessionLog>
}
```

### 3.2 `data` and `extended_data` callbacks (~lines 250-278)

Both callbacks become identical — the emit-and-log body is replaced by one
call (delete the manual `log.write(data)`, the base64 encode, and the
`emit(...)`):

```rust
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
        crate::transcript::write_output(&self.transcript, data);
        Ok(())
    }
```

### 3.3 `auth_banner` (~line 280)

```rust
    async fn auth_banner(
        &mut self,
        banner: &str,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        if !banner.is_empty() {
            try_open_auth_url(&self.app_handle, banner, self.session_id);
            // Banners are terminal output — they now reach the session log
            // too, instead of only the screen.
            crate::transcript::write_output(&self.transcript, banner.as_bytes());
        }
        Ok(())
    }
```

(`try_open_auth_url` and the `ssh-auth-url` event are unchanged.)

### 3.4 `SshSession::connect` (~lines 384-405)

Keep the `session_log` construction exactly as-is, then wrap it and pass the
shared handle to both the handler and `authenticate`:

```rust
        let host_key = format!("{}:{}", hostname, port);

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
        let transcript = crate::transcript::Transcript::new(
            session_log,
            Box::new(crate::transcript::TauriOutputSink::new(app_handle.clone(), session_id)),
        )
        .shared();

        let handler = ClientHandler {
            app_handle: app_handle.clone(),
            host_key,
            session_id,
            transcript: transcript.clone(),
        };
```

And pass the handle into `authenticate` at the existing call site
(~line 423-429), adding one argument:

```rust
        let auth_success = tokio::time::timeout(
            std::time::Duration::from_secs(120),
            Self::authenticate(&app_handle, &mut session, username, password, key_path, agent, session_id, &transcript),
        )
```

### 3.5 `SshSession::authenticate`

Add one parameter (last position):

```rust
        transcript: &crate::transcript::SharedTranscript,
```

Then replace the two manual emit blocks (~lines 635-647). Keep the existing
order — instructions first, then prompts; within the loop, `try_open_auth_url`
and the URL check still run before the write:

```rust
                    if !instructions.is_empty() {
                        log::info!("Keyboard-interactive instructions: {}", instructions);
                        // Auth-phase prompts now reach the session log.
                        crate::transcript::write_output(transcript, instructions.as_bytes());
                    }
                    for prompt in &prompts {
                        try_open_auth_url(app_handle, &prompt.prompt, session_id);
                        url_round |= extract_https_url(&prompt.prompt).is_some();
                        if !prompt.prompt.is_empty() {
                            crate::transcript::write_output(transcript, prompt.prompt.as_bytes());
                        }
                    }
```

(Delete the two base64 encodes and two `emit("ssh-output", …)` calls these
replace — the encoding now lives inside `Transcript::output`.)

### 3.6 Delete the moved struct

Remove `SshOutputPayload` (and its derive attributes) from ssh.rs — it now
lives in `transcript.rs`. Grep to confirm no remaining ssh.rs references
(`SshEventPayload` etc. stay).

## P4 — Tests

Add to `src-tauri/src/transcript.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// Captures encoded output instead of emitting a Tauri event.
    #[derive(Default)]
    struct CapturedSink(Mutex<Vec<String>>);

    impl OutputSink for CapturedSink {
        fn emit_output(&self, encoded: &str) {
            self.0.lock().unwrap().push(encoded.to_string());
        }
    }

    /// Arc wrapper so the test keeps a handle after moving the sink into the
    /// Transcript (which owns it as Box<dyn OutputSink>).
    struct SharedSink(Arc<CapturedSink>);

    impl OutputSink for SharedSink {
        fn emit_output(&self, encoded: &str) {
            self.0.emit_output(encoded);
        }
    }

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("comnd_transcript_{}_{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn only_log_file(dir: &std::path::Path) -> String {
        let entry = std::fs::read_dir(dir).unwrap().next().unwrap().unwrap();
        std::fs::read_to_string(entry.path()).unwrap()
    }

    #[test]
    fn output_writes_session_log_and_emits_base64() {
        let dir = temp_dir("fanout");
        let session_log = crate::session_log::SessionLog::new_in(&dir, "h:22", 1, false);
        let captured = Arc::new(CapturedSink::default());
        let mut transcript = Transcript::new(Some(session_log), Box::new(SharedSink(captured.clone())));
        transcript.output(b"hello ");
        transcript.output(b"world\n");

        let emitted = captured.0.lock().unwrap().clone();
        assert_eq!(emitted.len(), 2);
        assert_eq!(emitted[0], base64::engine::general_purpose::STANDARD.encode(b"hello "));
        assert_eq!(emitted[1], base64::engine::general_purpose::STANDARD.encode(b"world\n"));

        assert!(only_log_file(&dir).contains("hello world\n"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn output_without_session_log_still_emits() {
        // Session logging disabled: the terminal still gets its output.
        let captured = Arc::new(CapturedSink::default());
        let mut transcript = Transcript::new(None, Box::new(SharedSink(captured.clone())));
        transcript.output(b"hi");
        assert_eq!(captured.0.lock().unwrap().len(), 1);
    }

    #[test]
    fn shared_handle_preserves_order() {
        let dir = temp_dir("shared");
        let session_log = crate::session_log::SessionLog::new_in(&dir, "h:22", 7, false);
        let captured = Arc::new(CapturedSink::default());
        let shared = Transcript::new(Some(session_log), Box::new(SharedSink(captured.clone()))).shared();
        write_output(&shared, b"a");
        write_output(&shared, b"b");
        assert_eq!(captured.0.lock().unwrap().len(), 2);
        assert!(only_log_file(&dir).contains("ab"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A sink that panics once, to poison the mutex; recovery must let the
    /// next write through instead of bricking the terminal.
    #[test]
    fn write_output_recovers_from_poisoned_lock() {
        struct PanicsOnceSink(std::sync::atomic::AtomicBool);
        impl OutputSink for PanicsOnceSink {
            fn emit_output(&self, _encoded: &str) {
                if self.0.swap(false, std::sync::atomic::Ordering::SeqCst) {
                    panic!("sink boom");
                }
            }
        }
        let shared = Transcript::new(
            None,
            Box::new(PanicsOnceSink(std::sync::atomic::AtomicBool::new(true))),
        )
        .shared();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            write_output(&shared, b"first");
        }));
        assert!(result.is_err()); // first write panicked while holding the lock
        // Recovery: poisoned lock reclaimed, second write flows.
        write_output(&shared, b"second");
    }
}
```

Existing `session_log.rs` tests must keep passing untouched (they use
`SessionLog::new_in` directly, which this plan does not modify).

## Behavior invariants (assert during review)

- Event name `"ssh-output"`, payload shape `{ data, session_id }`, base64
  encoding — byte-identical to before. `session-channel.test.ts` untouched.
- Session logging **disabled** → terminal output still flows (Transcript with
  `session_log: None`).
- One file per session; naming, header, timestamps, per-chunk flush —
  unchanged (`session_log.rs` untouched).
- `auth_banner` output is now *additionally* logged — the only observable
  behavior change, and the point of the plan.
- Ordering within a chunk stream: log write then emit (same as the old
  `data()`).

## Verification

1. `cargo check` in `src-tauri/` — exit 0.
2. `cargo test` in `src-tauri/` — all pass (4 new transcript tests + existing
   suites, incl. session_log tests).
3. Frontend untouched; `npm run build` as a no-regression check is optional
   but cheap.
4. Manual (dev app): enable Session Logging (Settings → Session Logging),
   connect to any host, confirm:
   - the terminal renders output normally;
   - the session-logs file contains the same output;
   - connecting to a host that shows a **pre-auth banner or
     keyboard-interactive prompt** (e.g. an sshd with a Banner configured, or
     a Tailscale-style gateway that prints a login URL) now writes that text
     into the session log — before this plan it did not.

## Files touched

| File | Change |
|---|---|
| `src-tauri/src/transcript.rs` | **New** — `OutputSink` trait, `TauriOutputSink`, `Transcript`, `SharedTranscript`, `write_output`, `SshOutputPayload` (moved), tests |
| `src-tauri/src/ssh.rs` | `ClientHandler` field swap; `data`/`extended_data`/`auth_banner` rewired; `authenticate` gains a param + two call sites rewired; `connect` builds the Transcript; delete moved struct + manual emits |
| `src-tauri/src/lib.rs` | `mod transcript;` |
| `AGENTS.md` | File-map line for `transcript.rs` |

## Open questions

- **Resolved:** shared handle (Arc+Mutex) vs handler-only ownership — shared
  is required, because auth-phase writes come from `authenticate` after the
  handler was consumed by `client::connect`. Std Mutex, poison recovery,
  payload move, and the sink trait are all decided above.
- **Deferred:** eager file creation. Today a zero-output session creates no
  file (lazy open). If audits ever need "session happened but said nothing"
  recorded, flip `SessionLog` to open + write the header eagerly in a
  separate change — do not smuggle it into this plan.
- **Future:** a mock-server-driven integration test that exercises the real
  `ClientHandler → Transcript` wiring (needs a constructible
  `tauri::AppHandle` or a second sink adapter injected from the test server
  path). The seam this plan creates is the prerequisite.