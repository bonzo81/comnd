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

use base64::Engine as _;
use serde::Serialize;
use tauri::Emitter;

use crate::session_log::SessionLog;

/// Payload for the `ssh-output` event. Moved from ssh.rs (it is part of the
/// sink contract) — keep the derives it had there.
#[derive(Clone, Serialize)]
pub struct SshOutputPayload {
    pub data: String, // base64 encoded bytes
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
