//! Per-session SSH output logging to disk.
//!
//! One file per session: `<data_dir>/session-logs/<host>_<timestamp>_<session_id>.log`
//! Format: header line + `[YYYY-MM-DD HH:MM:SS]` per write chunk (optional) + raw bytes.

use std::fs::File;
use std::io::BufWriter;
use std::path::PathBuf;

pub struct SessionLog {
    writer: Option<BufWriter<File>>,
    timestamps: bool,
    file_path: PathBuf,
}

impl SessionLog {
    /// Create a session log in the default location. File is opened lazily on first `write()`.
    pub fn new(host_key: &str, session_id: u64, timestamps: bool) -> Self {
        let dir = crate::paths::app_data_dir()
            .unwrap_or_else(|e| {
                log::warn!("session-log: cannot resolve data dir: {}", e);
                std::env::temp_dir()
            })
            .join("session-logs");
        Self::new_in(&dir, host_key, session_id, timestamps)
    }

    /// Create a session log in a specific directory.
    pub fn new_in(dir: &std::path::Path, host_key: &str, session_id: u64, timestamps: bool) -> Self {
        let host = sanitize_filename(host_key);
        let now = chrono::Utc::now();
        let ts = now.format("%Y%m%d-%H%M%S");
        let file_path = dir.join(format!("{}_{}_{}.log", host, ts, session_id));
        Self {
            writer: None,
            timestamps,
            file_path,
        }
    }

    /// Write a chunk of raw SSH output bytes. Lazily opens the file and
    /// writes a header line on first call.
    pub fn write(&mut self, data: &[u8]) {
        if self.writer.is_none() {
            let dir = self.file_path.parent().unwrap();
            if crate::paths::ensure_data_dir(dir).is_err() {
                log::warn!("session-log: failed to create dir {}", dir.display());
                return;
            }
            match File::create(&self.file_path) {
                Ok(f) => {
                    // Session logs contain typed passwords (enable/sudo prompts) —
                    // lock perms on unix, mirroring open_log_file in lib.rs.
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        let _ = std::fs::set_permissions(&self.file_path, std::fs::Permissions::from_mode(0o600));
                        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
                    }
                    let mut w = BufWriter::new(f);
                    use std::io::Write;
                    let header = format!(
                        "# host={}, started={}\n",
                        self.file_path
                            .file_name()
                            .map(|n| n.to_string_lossy().to_string())
                            .unwrap_or_default(),
                        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
                    );
                    let _ = w.write_all(header.as_bytes());
                    self.writer = Some(w);
                }
                Err(e) => {
                    log::warn!("session-log: failed to open file {}: {}", self.file_path.display(), e);
                    return;
                }
            }
        }

        let writer = match self.writer.as_mut() {
            Some(w) => w,
            None => return,
        };

        use std::io::Write;
        if self.timestamps {
            // Skip leading newlines so the stamp lands on the first content
            // line, not orphaned on its own line (chunks often start with \r\n).
            let lead = data.iter().take_while(|&&b| b == b'\r' || b == b'\n').count();
            if lead < data.len() {
                let _ = writer.write_all(&data[..lead]);
                let stamp = format!("[{}] ", chrono::Local::now().format("%Y-%m-%d %H:%M:%S"));
                let _ = writer.write_all(stamp.as_bytes());
                let _ = writer.write_all(&data[lead..]);
            } else {
                let _ = writer.write_all(data);
            }
        } else {
            let _ = writer.write_all(data);
        }
        // ponytail: sync flush per chunk; switch to flush-on-idle (200ms) if large-output sessions show measurable cost
        let _ = writer.flush();
    }

    #[allow(dead_code)]
    pub fn path(&self) -> &PathBuf {
        &self.file_path
    }
}

fn sanitize_filename(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            ':' | '\\' | '/' | '<' | '>' | '|' | '?' | '*' => '-',
            _ => c,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_sanitize_filename() {
        assert_eq!(sanitize_filename("my-host:22"), "my-host-22");
        assert_eq!(sanitize_filename("a\\b/c<d>e|f?g*h"), "a-b-c-d-e-f-g-h");
        assert_eq!(sanitize_filename("normal.host"), "normal.host");
    }

    #[test]
    fn test_write_and_read() {
        let dir = std::env::temp_dir().join(format!("comnd_session_log_test_{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();

        let mut log = SessionLog::new_in(&dir, "test-host:22", 1, true);
        log.write(b"hello world\n");
        log.write(b"second chunk\n");

        let content = fs::read_to_string(log.path()).unwrap();
        assert!(content.starts_with("# host="));
        assert!(content.contains("started="));
        assert!(content.contains("["));
        assert!(content.contains("hello world\n"));
        assert!(content.contains("second chunk\n"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_timestamp_not_orphaned_on_leading_newline() {
        let dir = std::env::temp_dir().join(format!("comnd_session_log_test_lead_{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();

        let mut log = SessionLog::new_in(&dir, "host:22", 3, true);
        log.write(b"line1");
        // chunk that starts with \r\n must not orphan the timestamp on its own line
        log.write(b"\r\nline2\r\n");

        let content = fs::read_to_string(log.path()).unwrap();
        // no "[HH:MM:SS] " immediately followed by a newline (the orphan bug)
        assert!(!content.contains("] \r\n") && !content.contains("] \n"), "orphaned timestamp found:\n{content}");
        assert!(content.contains("line2"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_write_no_timestamps() {
        let dir = std::env::temp_dir().join(format!("comnd_session_log_test_notime_{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();

        let mut log = SessionLog::new_in(&dir, "host:22", 2, false);
        log.write(b"plain bytes\n");

        let content = fs::read_to_string(log.path()).unwrap();
        assert!(content.starts_with("# host="));
        assert!(!content.contains("[0"));
        assert!(content.contains("plain bytes\n"));

        let _ = fs::remove_dir_all(&dir);
    }
}
