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

// ─── Backup / Restore ────────────────────────────────────────────────

/// Files and directories to include in a backup export. Everything else
/// (logs, tmp files) is excluded.
const BACKUP_ENTRIES: &[&str] = &[
    "hosts.json",
    "groups.json",
    "config.json",
    "known_hosts.json",
    "knowledge-base",
];

/// Export app data to a zip file at `dest`. Excludes the `logs/` directory
/// (ephemeral, potentially large, contains hostnames/usernames).
pub fn export_data(dest: &Path) -> Result<(), String> {
    let data_dir = app_data_dir()?;
    let file = std::fs::File::create(dest)
        .map_err(|e| format!("Failed to create export file: {}", e))?;
    let mut zip = zip::ZipWriter::new(file);
    let options: zip::write::SimpleFileOptions = zip::write::FileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    for &name in BACKUP_ENTRIES {
        let path = data_dir.join(name);
        if !path.exists() {
            continue;
        }
        add_to_zip(&mut zip, &path, name, options)?;
    }

    zip.finish()
        .map_err(|e| format!("Failed to finalize zip: {}", e))?;
    log::info!("Exported app data to {}", dest.display());
    Ok(())
}

/// Recursively add a file or directory to a zip archive.
fn add_to_zip(
    zip: &mut zip::ZipWriter<std::fs::File>,
    path: &Path,
    archive_name: &str,
    options: zip::write::SimpleFileOptions,
) -> Result<(), String> {
    if path.is_dir() {
        // Add the directory entry itself
        let dir_options = options.clone();
        zip.add_directory(archive_name, dir_options)
            .map_err(|e| format!("Failed to add dir {} to zip: {}", archive_name, e))?;
        // Recurse into children
        let entries = std::fs::read_dir(path)
            .map_err(|e| format!("Failed to read dir {}: {}", path.display(), e))?;
        for entry in entries {
            let entry = entry.map_err(|e| format!("Failed to read dir entry: {}", e))?;
            let child_path = entry.path();
            let child_name = format!("{}/{}", archive_name, entry.file_name().to_string_lossy());
            add_to_zip(zip, &child_path, &child_name, options)?;
        }
    } else if path.is_file() {
        zip.start_file(archive_name, options)
            .map_err(|e| format!("Failed to start zip entry {}: {}", archive_name, e))?;
        let mut file = std::fs::File::open(path)
            .map_err(|e| format!("Failed to open {}: {}", path.display(), e))?;
        std::io::copy(&mut file, zip)
            .map_err(|e| format!("Failed to write {} to zip: {}", archive_name, e))?;
    }
    Ok(())
}

/// Import app data from a zip file at `src`. Extracts to a temp dir,
/// validates that it contains expected files, then replaces the current
/// data dir contents (after backing up the current data to a timestamped
/// sibling directory).
///
/// The caller should restart the app after a successful import so all
/// in-memory state reloads from the new files.
pub fn import_data(src: &Path) -> Result<(), String> {
    let data_dir = app_data_dir()?;
    let file = std::fs::File::open(src)
        .map_err(|e| format!("Failed to open import file: {}", e))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Failed to read zip: {}", e))?;

    // Extract to a temp dir first — validate before replacing live data.
    let temp_dir = std::env::temp_dir().join(format!("netsh-import-{}", chrono::Utc::now().format("%Y%m%dT%H%M%S")));
    ensure_data_dir(&temp_dir)?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)
            .map_err(|e| format!("Failed to read zip entry {}: {}", i, e))?;
        let outpath = match entry.enclosed_name() {
            Some(p) => temp_dir.join(p),
            None => continue, // Skip unsafe paths (.. traversal)
        };
        if entry.is_dir() {
            std::fs::create_dir_all(&outpath)
                .map_err(|e| format!("Failed to create dir {}: {}", outpath.display(), e))?;
        } else {
            if let Some(parent) = outpath.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create parent dir: {}", e))?;
            }
            let mut outfile = std::fs::File::create(&outpath)
                .map_err(|e| format!("Failed to create {}: {}", outpath.display(), e))?;
            std::io::copy(&mut entry, &mut outfile)
                .map_err(|e| format!("Failed to extract {}: {}", outpath.display(), e))?;
        }
    }

    // Validate: at least one expected file must be present.
    let has_valid = BACKUP_ENTRIES.iter().any(|name| temp_dir.join(name).exists());
    if !has_valid {
        let _ = std::fs::remove_dir_all(&temp_dir);
        return Err("Import file does not contain any recognizable net.sh data files".to_string());
    }

    // Back up the current data files. We can't rename the whole data dir
    // because the running app holds open handles (log file, config store)
    // — Windows blocks the rename with "Access is denied". Instead, copy
    // each backed-up entry to a sibling .backup-<ts> directory.
    let backup_dir = data_dir.with_extension(format!("backup-{}", chrono::Utc::now().format("%Y%m%dT%H%M%S")));
    ensure_data_dir(&backup_dir)?;
    for &name in BACKUP_ENTRIES {
        let current = data_dir.join(name);
        if current.exists() {
            let backup_path = backup_dir.join(name);
            if current.is_dir() {
                copy_dir_recursive(&current, &backup_path)?;
            } else {
                std::fs::copy(&current, &backup_path)
                    .map_err(|e| format!("Failed to back up {}: {}", name, e))?;
            }
        }
    }

    // Overwrite the live data files with the imported versions. Use
    // atomic_write for files (tmp + rename) so a crash mid-import doesn't
    // leave a half-written file. For the knowledge-base directory, copy
    // file-by-file over the existing tree.
    for &name in BACKUP_ENTRIES {
        let src_path = temp_dir.join(name);
        if !src_path.exists() {
            continue;
        }
        let dest_path = data_dir.join(name);
        if src_path.is_dir() {
            std::fs::create_dir_all(&dest_path)
                .map_err(|e| format!("Failed to create {}: {}", dest_path.display(), e))?;
            // Clear existing KB dir contents first so removed files don't linger
            let _ = std::fs::remove_dir_all(&dest_path);
            std::fs::create_dir_all(&dest_path)
                .map_err(|e| format!("Failed to recreate {}: {}", dest_path.display(), e))?;
            copy_dir_recursive(&src_path, &dest_path)?;
        } else {
            let bytes = std::fs::read(&src_path)
                .map_err(|e| format!("Failed to read {}: {}", src_path.display(), e))?;
            secure_write(&dest_path, &bytes)?;
        }
    }

    // Clean up temp dir
    let _ = std::fs::remove_dir_all(&temp_dir);

    // Apply restrictive perms to the restored files
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&data_dir, std::fs::Permissions::from_mode(0o700));
    }

    log::info!("Imported app data from {} (backup at {})", src.display(), backup_dir.display());
    Ok(())
}

/// Recursively copy a directory's contents.
fn copy_dir_recursive(src: &Path, dest: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest)
        .map_err(|e| format!("Failed to create {}: {}", dest.display(), e))?;
    for entry in std::fs::read_dir(src).map_err(|e| format!("Failed to read {}: {}", src.display(), e))? {
        let entry = entry.map_err(|e| format!("Failed to read dir entry: {}", e))?;
        let src_path = entry.path();
        let dest_path = dest.join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dest_path)?;
        } else {
            std::fs::copy(&src_path, &dest_path)
                .map_err(|e| format!("Failed to copy {}: {}", src_path.display(), e))?;
        }
    }
    Ok(())
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
