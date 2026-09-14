//! Centralized data-dir helpers: directory creation with restrictive perms,
//! and atomic file writes (tmp + rename).
//!
//! Windows relies on the parent dir's user-only ACL (inherited from the user
//! profile / Tauri's scoped data dir). Explicit file-ACL tightening needs the
//! `windows` crate — YAGNI while everything lives under the app data dir.

pub mod commands;

use std::path::{Path, PathBuf};

/// Bundle identifier — must match `identifier` in `tauri.conf.json`.
const BUNDLE_ID: &str = "com.netssh.app";

/// Resolve the app data dir without an `AppHandle` (replicates Tauri's
/// `app_local_data_dir` = `dirs::data_local_dir()` + bundle id). Used at
/// startup, before the `AppHandle` exists.
/// - Windows: `%LOCALAPPDATA%\com.netssh.app` (Local, not Roaming)
/// - macOS: `~/Library/Application Support/com.netssh.app`
/// - Linux: `$XDG_DATA_HOME/com.netssh.app` or `~/.local/share/com.netssh.app`
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

/// Bundled (read-only, repo-shipped) knowledge-base root. Primary is
/// `resource_dir()/knowledge-base` (correct in release builds); the dev-build
/// fallback is `<repo>/knowledge-base` (`CARGO_MANIFEST_DIR`'s parent). Single
/// source of truth for both the startup KB load and the import pipeline.
pub fn bundled_kb_path(resource_dir: &Path) -> PathBuf {
    let release = resource_dir.join("knowledge-base");
    if release.exists() {
        return release;
    }
    let dev = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("knowledge-base");
    if dev.exists() {
        return dev;
    }
    release
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

/// Load a JSON file into T. Missing file → default. Corrupt file →
/// preserved as `.corrupt-<ts>`, default returned (the store pattern every
/// data file already follows).
pub fn load_json_or_preserve<T: serde::de::DeserializeOwned + Default>(path: &Path) -> T {
    match std::fs::read_to_string(path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_else(|e| {
            log::error!(
                "Failed to parse {}. Preserving as .corrupt: {}",
                path.display(), e
            );
            preserve_corrupt(path);
            T::default()
        }),
        Err(_) => T::default(),
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

/// Import mode for the overwrite path. Merge goes through scan_merge →
/// apply_merge (two-phase with conflict resolution).
pub enum ImportMode {
    Overwrite,
}

/// A conflict between a current entry and a backup entry with the same key.
/// `current` and `backup` are human-readable summaries (not full JSON) so
/// the frontend can show them without understanding the full data model.
#[derive(serde::Serialize)]
pub struct MergeConflict {
    /// Which file this conflict is in: "hosts", "groups", "known_hosts", "config".
    pub file: String,
    /// Unique key within that file (host id, group id, hostname:port, or
    /// config key name).
    pub key: String,
    /// Human-readable label for the current entry (e.g. display name).
    pub current_label: String,
    /// Human-readable label for the backup entry.
    pub backup_label: String,
}

/// Result of scanning a backup for merge conflicts.
#[derive(serde::Serialize)]
pub struct MergeScan {
    /// Path to the extracted temp dir (passed back so apply_merge can find it).
    pub temp_dir: String,
    /// New entries in the backup that don't conflict (will be added).
    pub new_count: usize,
    /// Conflicts — same key exists in both current and backup with different data.
    pub conflicts: Vec<MergeConflict>,
}

/// Resolution choice for a single conflict.
#[derive(serde::Deserialize, Clone, Copy)]
pub enum ConflictResolution {
    /// Keep the current entry, ignore the backup.
    KeepCurrent,
    /// Replace with the backup entry.
    UseBackup,
}

/// Scan a backup zip for merge conflicts without writing anything.
/// Extracts to a temp dir, parses both sides, and returns a conflict list.
/// The temp dir path is returned so the subsequent `apply_merge` can reuse it.
pub fn scan_merge(src: &Path) -> Result<MergeScan, String> {
    let data_dir = app_data_dir()?;
    let temp_dir = extract_zip_to_temp(src)?;

    // Validate: at least one expected file must be present.
    let has_valid = BACKUP_ENTRIES.iter().any(|name| temp_dir.join(name).exists());
    if !has_valid {
        let _ = std::fs::remove_dir_all(&temp_dir);
        return Err("Import file does not contain any recognizable netssh data files".to_string());
    }

    let mut conflicts = Vec::new();
    let mut new_count = 0usize;

    // Hosts: conflict key = id
    new_count += scan_json_array_conflicts::<crate::hosts::Host>(
        &data_dir.join("hosts.json"),
        &temp_dir.join("hosts.json"),
        "hosts",
        |h| h.id.clone(),
        |h| format!("{} ({}@{}:{})", h.display_name, h.username, h.hostname, h.port),
        &mut conflicts,
    );

    // Groups: conflict key = id
    new_count += scan_json_array_conflicts::<crate::hosts::HostGroup>(
        &data_dir.join("groups.json"),
        &temp_dir.join("groups.json"),
        "groups",
        |g| g.id.clone(),
        |g| g.name.clone(),
        &mut conflicts,
    );

    // Known hosts: conflict key = hostname:port (the JSON map key)
    new_count += scan_known_hosts_conflicts(
        &data_dir.join("known_hosts.json"),
        &temp_dir.join("known_hosts.json"),
        &mut conflicts,
    );

    // Config: conflict = keys where both sides have a value and they differ.
    // Not a "merge or skip" — config is a single object. We treat each
    // top-level key as a potential conflict.
    new_count += scan_config_conflicts(
        &data_dir.join("config.json"),
        &temp_dir.join("config.json"),
        &mut conflicts,
    );

    Ok(MergeScan {
        temp_dir: temp_dir.to_string_lossy().to_string(),
        new_count,
        conflicts,
    })
}

/// Apply a merge with user-provided conflict resolutions.
/// `resolutions` is a map of conflict key (file:key) to the user's choice.
/// Entries with no conflict are auto-merged (new entries added, matching
/// entries kept as-is). The temp_dir from scan_merge is reused.
pub fn apply_merge(
    temp_dir: &Path,
    resolutions: &std::collections::HashMap<String, ConflictResolution>,
) -> Result<String, String> {
    // temp_dir arrives over IPC — only accept a path that actually sits
    // inside the OS temp dir (canonicalized, so `..` and symlinks resolve
    // before the ancestry check). Otherwise a crafted IPC call could merge
    // data from (or delete via cleanup) any directory it names.
    let canon = temp_dir
        .canonicalize()
        .map_err(|_| "Merge staging directory not found".to_string())?;
    let temp_base = std::env::temp_dir()
        .canonicalize()
        .map_err(|e| format!("Failed to resolve temp dir: {}", e))?;
    if !canon.starts_with(&temp_base) {
        return Err(format!(
            "Rejecting merge from outside the temp directory: {}",
            canon.display()
        ));
    }

    let data_dir = app_data_dir()?;

    // Back up current data first.
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

    let mut added = 0usize;

    // Hosts
    added += merge_json_array::<crate::hosts::Host>(
        &data_dir.join("hosts.json"),
        &temp_dir.join("hosts.json"),
        "hosts",
        |h| h.id.clone(),
        &resolutions,
    )?;
    // Groups
    added += merge_json_array::<crate::hosts::HostGroup>(
        &data_dir.join("groups.json"),
        &temp_dir.join("groups.json"),
        "groups",
        |g| g.id.clone(),
        &resolutions,
    )?;
    // Known hosts
    added += merge_known_hosts(
        &data_dir.join("known_hosts.json"),
        &temp_dir.join("known_hosts.json"),
        &resolutions,
    )?;
    // Config
    merge_config(
        &data_dir.join("config.json"),
        &temp_dir.join("config.json"),
        &resolutions,
    )?;

    // KB: per-platform merge (copy platform dirs from backup that don't exist
    // locally; overwrite platform dirs that do exist in the backup)
    let kb_temp = temp_dir.join("knowledge-base");
    if kb_temp.exists() {
        let kb_dest = data_dir.join("knowledge-base");
        if let Ok(platforms) = std::fs::read_dir(&kb_temp) {
            for platform in platforms.flatten() {
                let platform_name = platform.file_name();
                let dest_platform = kb_dest.join(&platform_name);
                if dest_platform.exists() {
                    let _ = std::fs::remove_dir_all(&dest_platform);
                }
                std::fs::create_dir_all(&dest_platform)
                    .map_err(|e| format!("Failed to create KB platform dir: {}", e))?;
                copy_dir_recursive(&platform.path(), &dest_platform)?;
                added += 1;
            }
        }
    }

    // Clean up temp dir
    let _ = std::fs::remove_dir_all(temp_dir);

    // Apply restrictive perms
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&data_dir, std::fs::Permissions::from_mode(0o700));
    }

    let msg = format!(
        "Merge complete: {} entries added, {} conflicts resolved. Backup at {}",
        added,
        resolutions.len(),
        backup_dir.display()
    );
    log::info!("{}", msg);
    Ok(msg)
}

// ─── Merge helpers ───────────────────────────────────────────────────

/// Total uncompressed bytes a single import zip may extract. netssh backups
/// (hosts/config/KB YAML) are a few MB — 512 MB leaves huge headroom while
/// stopping zip bombs from filling the disk.
const MAX_IMPORT_UNCOMPRESSED: u64 = 512 * 1024 * 1024;

/// Copy with a hard byte cap. Returns the total written so far; errors when
/// the running total exceeds `cap` (zip bomb guard).
fn copy_capped<R: std::io::Read, W: std::io::Write>(
    mut src: R,
    mut dest: W,
    total: &mut u64,
    cap: u64,
) -> Result<(), String> {
    use std::io::{Read, Write};
    let mut buf = [0u8; 65536];
    loop {
        let n = src
            .read(&mut buf)
            .map_err(|e| format!("Failed to read zip entry: {}", e))?;
        if n == 0 {
            return Ok(());
        }
        *total += n as u64;
        if *total > cap {
            return Err("Import file exceeds the 512 MB extraction limit".to_string());
        }
        dest
            .write_all(&buf[..n])
            .map_err(|e| format!("Failed to extract zip entry: {}", e))?;
    }
}

/// Extract a zip to a temp dir and return the path. Shared by scan and apply.
fn extract_zip_to_temp(src: &Path) -> Result<PathBuf, String> {
    let file = std::fs::File::open(src)
        .map_err(|e| format!("Failed to open import file: {}", e))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Failed to read zip: {}", e))?;

    let temp_dir = std::env::temp_dir().join(format!(
        "netssh-import-{}",
        chrono::Utc::now().format("%Y%m%dT%H%M%S%3f")
    ));
    ensure_data_dir(&temp_dir)?;
    let mut total: u64 = 0;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)
            .map_err(|e| format!("Failed to read zip entry {}: {}", i, e))?;
        let outpath = match entry.enclosed_name() {
            Some(p) => temp_dir.join(p),
            None => continue,
        };
        if entry.is_dir() {
            std::fs::create_dir_all(&outpath)
                .map_err(|e| format!("Failed to create dir {}: {}", outpath.display(), e))?;
        } else {
            if let Some(parent) = outpath.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create parent dir: {}: {}", parent.display(), e))?;
            }
            let mut outfile = std::fs::File::create(&outpath)
                .map_err(|e| format!("Failed to create {}: {}", outpath.display(), e))?;
            if let Err(e) = copy_capped(&mut entry, &mut outfile, &mut total, MAX_IMPORT_UNCOMPRESSED) {
                let _ = std::fs::remove_dir_all(&temp_dir);
                return Err(e);
            }
        }
    }
    Ok(temp_dir)
}

/// Scan a JSON array file for conflicts. Returns the count of new (non-conflicting)
/// entries from the backup.
fn scan_json_array_conflicts<T>(
    current_path: &Path,
    backup_path: &Path,
    file_label: &str,
    get_key: impl Fn(&T) -> String,
    get_label: impl Fn(&T) -> String,
    conflicts: &mut Vec<MergeConflict>,
) -> usize
where
    T: serde::de::DeserializeOwned + serde::Serialize,
{
    if !backup_path.exists() {
        return 0;
    }

    let current: Vec<T> = read_json_file(current_path).unwrap_or_default();
    let backup: Vec<T> = read_json_file(backup_path).unwrap_or_default();

    let current_keys: std::collections::HashMap<String, T> = current
        .into_iter()
        .map(|item| (get_key(&item), item))
        .collect();

    let mut new_count = 0;
    for item in &backup {
        let key = get_key(item);
        if let Some(current_item) = current_keys.get(&key) {
            // Same key exists — check if data differs by comparing serialized form
            let current_json = serde_json::to_string(current_item).unwrap_or_default();
            let backup_json = serde_json::to_string(item).unwrap_or_default();
            if current_json != backup_json {
                conflicts.push(MergeConflict {
                    file: file_label.to_string(),
                    key: format!("{}:{}", file_label, key),
                    current_label: get_label(current_item),
                    backup_label: get_label(item),
                });
            }
        } else {
            new_count += 1;
        }
    }
    new_count
}

/// Merge a JSON array file: keep all current entries, add new backup entries,
/// and resolve conflicts per the user's choices.
fn merge_json_array<T>(
    current_path: &Path,
    backup_path: &Path,
    file_label: &str,
    get_key: impl Fn(&T) -> String,
    resolutions: &std::collections::HashMap<String, ConflictResolution>,
) -> Result<usize, String>
where
    T: serde::de::DeserializeOwned + serde::Serialize + Clone,
{
    if !backup_path.exists() {
        return Ok(0);
    }

    let mut current: Vec<T> = read_json_file(current_path).unwrap_or_default();
    let backup: Vec<T> = read_json_file(backup_path).unwrap_or_default();

    let current_keys: std::collections::HashMap<String, usize> = current
        .iter()
        .enumerate()
        .map(|(i, item)| (get_key(item), i))
        .collect();

    let mut added = 0;
    for item in backup {
        let key = get_key(&item);
        let conflict_key = format!("{}:{}", file_label, key);
        if let Some(&idx) = current_keys.get(&key) {
            // Conflict — check resolution
            if let Some(ConflictResolution::UseBackup) = resolutions.get(&conflict_key) {
                current[idx] = item;
            }
            // KeepCurrent → do nothing
        } else {
            // New entry — add it
            current.push(item);
            added += 1;
        }
    }

    let json = serde_json::to_string_pretty(&current)
        .map_err(|e| format!("Failed to serialize {}: {}", file_label, e))?;
    secure_write(current_path, json.as_bytes())?;
    Ok(added)
}

/// Scan known_hosts.json for conflicts (keyed by hostname:port).
fn scan_known_hosts_conflicts(
    current_path: &Path,
    backup_path: &Path,
    conflicts: &mut Vec<MergeConflict>,
) -> usize {
    if !backup_path.exists() {
        return 0;
    }

    let current: std::collections::HashMap<String, serde_json::Value> =
        read_json_file(current_path).unwrap_or_default();
    let backup: std::collections::HashMap<String, serde_json::Value> =
        read_json_file(backup_path).unwrap_or_default();

    let mut new_count = 0;
    for (key, backup_val) in &backup {
        if let Some(current_val) = current.get(key) {
            let current_json = serde_json::to_string(current_val).unwrap_or_default();
            let backup_json = serde_json::to_string(backup_val).unwrap_or_default();
            if current_json != backup_json {
                conflicts.push(MergeConflict {
                    file: "known_hosts".to_string(),
                    key: format!("known_hosts:{}", key),
                    current_label: format!("{} (current)", key),
                    backup_label: format!("{} (backup)", key),
                });
            }
        } else {
            new_count += 1;
        }
    }
    new_count
}

/// Merge known_hosts.json: keep all current entries, add new backup entries,
/// resolve conflicts per user choices.
fn merge_known_hosts(
    current_path: &Path,
    backup_path: &Path,
    resolutions: &std::collections::HashMap<String, ConflictResolution>,
) -> Result<usize, String> {
    if !backup_path.exists() {
        return Ok(0);
    }

    let mut current: std::collections::HashMap<String, serde_json::Value> =
        read_json_file(current_path).unwrap_or_default();
    let backup: std::collections::HashMap<String, serde_json::Value> =
        read_json_file(backup_path).unwrap_or_default();

    let mut added = 0;
    for (key, backup_val) in backup {
        let conflict_key = format!("known_hosts:{}", key);
        if current.contains_key(&key) {
            if let Some(ConflictResolution::UseBackup) = resolutions.get(&conflict_key) {
                current.insert(key, backup_val);
            }
        } else {
            current.insert(key, backup_val);
            added += 1;
        }
    }

    let json = serde_json::to_string_pretty(&current)
        .map_err(|e| format!("Failed to serialize known_hosts: {}", e))?;
    secure_write(current_path, json.as_bytes())?;
    Ok(added)
}

/// Scan config.json for conflicts (top-level keys where both sides differ).
fn scan_config_conflicts(
    current_path: &Path,
    backup_path: &Path,
    conflicts: &mut Vec<MergeConflict>,
) -> usize {
    if !backup_path.exists() {
        return 0;
    }

    let current: serde_json::Value = read_json_file(current_path).unwrap_or(serde_json::Value::Null);
    let backup: serde_json::Value = read_json_file(backup_path).unwrap_or(serde_json::Value::Null);

    let empty = serde_json::Map::new();
    let current_obj = current.as_object().unwrap_or(&empty);
    let backup_obj = backup.as_object().unwrap_or(&empty);

    let mut new_count = 0;
    for (key, backup_val) in backup_obj {
        if let Some(current_val) = current_obj.get(key) {
            if current_val != backup_val {
                conflicts.push(MergeConflict {
                    file: "config".to_string(),
                    key: format!("config:{}", key),
                    current_label: format!("{} = {}", key, summarize_json(current_val)),
                    backup_label: format!("{} = {}", key, summarize_json(backup_val)),
                });
            }
        } else {
            new_count += 1;
        }
    }
    new_count
}

/// Merge config.json: keep all current keys, add new backup keys, resolve
/// conflicts per user choices.
fn merge_config(
    current_path: &Path,
    backup_path: &Path,
    resolutions: &std::collections::HashMap<String, ConflictResolution>,
) -> Result<(), String> {
    if !backup_path.exists() {
        return Ok(());
    }

    let mut current: serde_json::Value = read_json_file(current_path).unwrap_or(serde_json::Value::Null);
    let backup: serde_json::Value = read_json_file(backup_path).unwrap_or(serde_json::Value::Null);

    if let (Some(current_obj), Some(backup_obj)) = (current.as_object_mut(), backup.as_object()) {
        for (key, backup_val) in backup_obj {
            let conflict_key = format!("config:{}", key);
            if current_obj.contains_key(key) {
                if let Some(ConflictResolution::UseBackup) = resolutions.get(&conflict_key) {
                    current_obj.insert(key.clone(), backup_val.clone());
                }
            } else {
                current_obj.insert(key.clone(), backup_val.clone());
            }
        }
    }

    let json = serde_json::to_string_pretty(&current)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    secure_write(current_path, json.as_bytes())?;
    Ok(())
}

/// Read a JSON file and deserialize into T. Returns None on any error.
fn read_json_file<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
}

/// Summarize a JSON value for display in a conflict dialog (truncate long values).
fn summarize_json(v: &serde_json::Value) -> String {
    let s = match v {
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    if s.len() > 60 {
        format!("{}...", &s[..57])
    } else {
        s
    }
}

/// Import app data from a zip file at `src`. Extracts to a temp dir,
/// validates that it contains expected files, then replaces or merges the
/// current data (after backing up the current data to a timestamped
/// sibling directory).
///
/// The caller should restart the app after a successful import so all
/// in-memory state reloads from the new files.
pub fn import_data(src: &Path, mode: ImportMode) -> Result<(), String> {
    let data_dir = app_data_dir()?;
    let file = std::fs::File::open(src)
        .map_err(|e| format!("Failed to open import file: {}", e))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Failed to read zip: {}", e))?;

    // Extract to a temp dir first — validate before replacing live data.
    let temp_dir = std::env::temp_dir().join(format!("netssh-import-{}", chrono::Utc::now().format("%Y%m%dT%H%M%S")));
    ensure_data_dir(&temp_dir)?;
    let mut total: u64 = 0;
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
                    .map_err(|e| format!("Failed to create parent dir: {}: {}", parent.display(), e))?;
            }
            let mut outfile = std::fs::File::create(&outpath)
                .map_err(|e| format!("Failed to create {}: {}", outpath.display(), e))?;
            if let Err(e) = copy_capped(&mut entry, &mut outfile, &mut total, MAX_IMPORT_UNCOMPRESSED) {
                let _ = std::fs::remove_dir_all(&temp_dir);
                return Err(e);
            }
        }
    }

    // Validate: at least one expected file must be present.
    let has_valid = BACKUP_ENTRIES.iter().any(|name| temp_dir.join(name).exists());
    if !has_valid {
        let _ = std::fs::remove_dir_all(&temp_dir);
        return Err("Import file does not contain any recognizable netssh data files".to_string());
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
    // secure_write for files (tmp + rename) so a crash mid-import doesn't
    // leave a half-written file. For the knowledge-base directory, copy
    // file-by-file over the existing tree.
    //
    // Overwrite mode: delete current entries NOT in the zip first, so the
    // result is a clean replace. Merge mode: only touch files present in
    // the zip — everything else stays as-is.
    if matches!(mode, ImportMode::Overwrite) {
        for &name in BACKUP_ENTRIES {
            let dest_path = data_dir.join(name);
            if dest_path.exists() && !temp_dir.join(name).exists() {
                if dest_path.is_dir() {
                    let _ = std::fs::remove_dir_all(&dest_path);
                } else {
                    let _ = std::fs::remove_file(&dest_path);
                }
            }
        }
    }

    for &name in BACKUP_ENTRIES {
        let src_path = temp_dir.join(name);
        if !src_path.exists() {
            continue;
        }
        let dest_path = data_dir.join(name);
        if src_path.is_dir() {
            // Overwrite mode: clear existing dir entirely (clean replace).
            // Merge mode: clear only the platform dirs that exist in the zip
            // so KB categories not in the zip are preserved.
            if matches!(mode, ImportMode::Overwrite) {
                let _ = std::fs::remove_dir_all(&dest_path);
            } else {
                // Merge: remove platform subdirs that are present in the import
                let src_kb = &src_path;
                if dest_path.exists() {
                    if let Ok(entries) = std::fs::read_dir(src_kb) {
                        for entry in entries.flatten() {
                            let platform_dir = dest_path.join(entry.file_name());
                            if platform_dir.exists() {
                                let _ = std::fs::remove_dir_all(&platform_dir);
                            }
                        }
                    }
                }
            }
            std::fs::create_dir_all(&dest_path)
                .map_err(|e| format!("Failed to create {}: {}", dest_path.display(), e))?;
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
        let dir = std::env::temp_dir().join(format!("netssh_paths_{}", uuid::Uuid::new_v4()));
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
        let dir = std::env::temp_dir().join(format!("netssh_paths_{}", uuid::Uuid::new_v4()));
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
        let dir = std::env::temp_dir().join(format!("netssh_logperm_{}", uuid::Uuid::new_v4()));
        ensure_data_dir(&dir).unwrap();
        let mode = std::fs::metadata(&dir).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700, "log/data dir must be owner-only");

        // Mirror the file-perm step lib.rs applies to netssh.log
        let file = dir.join("netssh.log");
        std::fs::write(&file, "").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        let fmode = std::fs::metadata(&file).unwrap().permissions().mode();
        assert_eq!(fmode & 0o777, 0o600, "log file must be owner-only");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_atomic_write_overwrites_existing() {
        let dir = std::env::temp_dir().join(format!("netssh_paths_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("data.txt");
        atomic_write(&path, b"v1").unwrap();
        atomic_write(&path, b"v2-longer").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"v2-longer");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_load_json_or_preserve_defaults_on_missing_and_corrupt() {
        let dir = std::env::temp_dir().join(format!("netssh_paths_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();

        // missing → default
        let missing: Vec<String> = load_json_or_preserve(&dir.join("nope.json"));
        assert!(missing.is_empty());

        // corrupt → preserved + default
        let bad = dir.join("x.json");
        std::fs::write(&bad, "{not json").unwrap();
        let corrupt: Vec<String> = load_json_or_preserve(&bad);
        assert!(corrupt.is_empty());
        assert!(!bad.exists(), "corrupt file should be renamed away");
        let preserved = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| e.file_name().to_string_lossy().starts_with("x.json.corrupt-"));
        assert!(preserved, "expected a .corrupt-<ts> backup file");

        // clean roundtrip
        let ok = dir.join("ok.json");
        std::fs::write(&ok, "[\"a\"]").unwrap();
        let good: Vec<String> = load_json_or_preserve(&ok);
        assert_eq!(good, vec!["a".to_string()]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_apply_merge_rejects_paths_outside_temp() {
        let res = apply_merge(std::path::Path::new("/"), &std::collections::HashMap::new());
        assert!(res.is_err(), "apply_merge must reject staging dirs outside the OS temp dir");
    }

    #[test]
    fn test_copy_capped_errors_past_cap() {
        let mut total = 0u64;
        let data = vec![0u8; 100];
        let err = copy_capped(&data[..], std::io::sink(), &mut total, 50).unwrap_err();
        assert!(err.contains("limit"), "got: {err}");
    }
}
