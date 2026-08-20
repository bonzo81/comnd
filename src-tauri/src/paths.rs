//! Centralized data-dir helpers: directory creation with restrictive perms,
//! and atomic file writes (tmp + rename).
//!
//! Windows relies on the parent dir's user-only ACL (inherited from the user
//! profile / Tauri's scoped data dir). Explicit file-ACL tightening needs the
//! `windows` crate — YAGNI while everything lives under the app data dir.

use std::path::{Path, PathBuf};

/// Bundle identifier — must match `identifier` in `tauri.conf.json`.
const BUNDLE_ID: &str = "com.netsh.app";

/// Resolve the app data dir without an `AppHandle` (replicates Tauri's
/// `app_local_data_dir` = `dirs::data_local_dir()` + bundle id). Used at
/// startup, before the `AppHandle` exists.
/// - Windows: `%LOCALAPPDATA%\com.netsh.app` (Local, not Roaming)
/// - macOS: `~/Library/Application Support/com.netsh.app`
/// - Linux: `$XDG_DATA_HOME/com.netsh.app` or `~/.local/share/com.netsh.app`
pub fn app_data_dir() -> Result<PathBuf, String> {
    dirs::data_local_dir()
        .map(|d| d.join(BUNDLE_ID))
        .ok_or_else(|| "Could not resolve app data dir".to_string())
}

/// Log dir, colocated with the data dir. No `AppHandle` is available at
/// logger-init time (runs before Tauri `setup`), so this derives from
/// `app_data_dir()` rather than a separate base.
pub fn log_dir() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("logs"))
}

/// One-shot migration: copy persisted JSON files from the legacy
/// `dirs::data_dir()/netsh` location to `new_dir` when `new_dir` has no
/// `hosts.json` yet. Copy, not move — the old dir is left as a backup.
pub fn migrate_data_dir(new_dir: &Path) {
    let old_dir = match dirs::data_dir().map(|d| d.join("netsh")) {
        Some(d) => d,
        None => return,
    };
    if !old_dir.join("hosts.json").exists() {
        return;
    }
    if new_dir.join("hosts.json").exists() {
        return; // Already migrated or fresh install with data
    }
    log::info!(
        "Migrating data dir {} -> {}",
        old_dir.display(),
        new_dir.display()
    );
    for name in ["hosts.json", "groups.json", "config.json", "known_hosts.json"] {
        let src = old_dir.join(name);
        if src.exists() {
            if let Err(e) = std::fs::copy(&src, new_dir.join(name)) {
                log::warn!("Failed to migrate {}: {}", name, e);
            }
        }
    }
}

/// Create `dir` (and parents) if missing, then lock perms to owner-only on unix.
pub fn ensure_data_dir(dir: &Path) -> Result<(), String> {
    if !dir.exists() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
        }
    }
    Ok(())
}

/// Atomic write: write to a sibling `.tmp` file, then rename over the target.
/// No permission changes — for non-secret user files (e.g. KB YAML) where the
/// user may want to share the directory.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        ensure_data_dir(parent)?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes).map_err(|e| format!("write tmp: {}", e))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("rename: {}", e)
    })?;
    Ok(())
}

/// Atomic write with restrictive perms (0o600 on unix) — for files that hold
/// host metadata or other data that should not be world-readable.
pub fn secure_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        ensure_data_dir(parent)?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes).map_err(|e| format!("write tmp: {}", e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("chmod tmp: {}", e))?;
    }

    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("rename: {}", e)
    })?;

    #[cfg(unix)]
    if let Some(parent) = path.parent() {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

/// Rename a corrupt JSON file to `<name>.corrupt-<ts>` so the next `save()`
/// writes a fresh file to the original path and the corrupt copy survives for
/// manual recovery. Falls back to copy if the rename fails (cross-device).
pub fn preserve_corrupt(path: &Path) {
    let ts = chrono::Utc::now().format("%Y%m%dT%H%M%S");
    let backup = path.with_extension(format!("json.corrupt-{}", ts));
    if let Err(e) = std::fs::rename(path, &backup) {
        log::error!("Failed to rename corrupt {}: {}", path.display(), e);
        let _ = std::fs::copy(path, &backup);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_atomic_write_roundtrip() {
        let dir = std::env::temp_dir().join(format!("netsh_paths_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("data.txt");
        atomic_write(&path, b"hello").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"hello");
        // No lingering tmp file
        assert!(!dir.join("data.tmp").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_secure_write_roundtrip() {
        let dir = std::env::temp_dir().join(format!("netsh_paths_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("secret.json");
        secure_write(&path, b"{}").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"{}");
        assert!(!dir.join("secret.tmp").exists());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o077, 0, "file must not be group/world accessible");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    #[cfg(unix)]
    fn test_log_dir_created_with_secure_perms() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("netsh_logperm_{}", uuid::Uuid::new_v4()));
        ensure_data_dir(&dir).unwrap();
        let mode = std::fs::metadata(&dir).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700, "log/data dir must be owner-only");

        // Mirror the file-perm step lib.rs applies to netsh.log
        let file = dir.join("netsh.log");
        std::fs::write(&file, "").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        let fmode = std::fs::metadata(&file).unwrap().permissions().mode();
        assert_eq!(fmode & 0o777, 0o600, "log file must be owner-only");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_atomic_write_overwrites_existing() {
        let dir = std::env::temp_dir().join(format!("netsh_paths_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("data.txt");
        atomic_write(&path, b"v1").unwrap();
        atomic_write(&path, b"v2-longer").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"v2-longer");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
