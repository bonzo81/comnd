//! Single source of truth for "which platforms exist": the union of bundled
//! and user KB roots that contain a `<platform>/index.yaml`. Replaces the old
//! hardcoded `VALID_PLATFORMS` const so custom KB platforms validate.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use crate::kb::PlatformIndex;
use crate::state::AppState;

/// Hardcoded fallback for unit tests that don't have a KB directory to scan.
#[cfg(test)]
pub const BUILTIN_PLATFORMS: &[&str] = &["linux-bash", "cisco-iosxe", "cisco-nxos", "f5-tmos"];

#[derive(Debug)]
pub struct PlatformRegistry {
    platforms: BTreeSet<String>,
    bundled_kb: PathBuf,
    user_kb: Option<PathBuf>,
}

impl PlatformRegistry {
    /// Scan the bundled + optional user KB roots for `<platform>/index.yaml` dirs.
    pub fn scan(bundled_kb: impl AsRef<Path>, user_kb: Option<impl AsRef<Path>>) -> Self {
        let bundled_kb = bundled_kb.as_ref().to_path_buf();
        let user_kb = user_kb.map(|p| p.as_ref().to_path_buf());
        let mut platforms = BTreeSet::new();
        scan_root(&bundled_kb, &mut platforms);
        if let Some(ref u) = user_kb {
            scan_root(u, &mut platforms);
        }
        Self {
            platforms,
            bundled_kb,
            user_kb,
        }
    }

    /// True when `platform` is a known KB platform (bundled or user).
    pub fn is_valid(&self, platform: &str) -> bool {
        self.platforms.contains(platform)
    }

    /// Sorted list of all known platforms.
    pub fn all(&self) -> Vec<String> {
        self.platforms.iter().cloned().collect()
    }

    /// Re-scan the roots captured at construction (call after a KB import).
    pub fn rescan(&mut self) {
        *self = Self::scan(&self.bundled_kb, self.user_kb.clone());
    }

    /// Test-only: the four bundled platforms without a disk scan.
    #[cfg(test)]
    pub fn builtin() -> Self {
        Self {
            platforms: BUILTIN_PLATFORMS.iter().map(|s| s.to_string()).collect(),
            bundled_kb: PathBuf::new(),
            user_kb: None,
        }
    }
}

/// Add every `<root>/<platform>/` dir that contains an `index.yaml` to `out`.
pub fn scan_root(root: &Path, out: &mut BTreeSet<String>) {
    let entries = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if path.join("index.yaml").exists() {
            out.insert(entry.file_name().to_string_lossy().to_string());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp(prefix: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("netssh_platform_{}_{}", prefix, uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Make `<root>/<name>/index.yaml` exist.
    fn add_platform(root: &Path, name: &str) {
        let p = root.join(name);
        fs::create_dir_all(&p).unwrap();
        fs::write(p.join("index.yaml"), "platform: x\n").unwrap();
    }

    #[test]
    fn scan_empty_roots() {
        let bundled = tmp("empty-b");
        let user = tmp("empty-u");
        let reg = PlatformRegistry::scan(&bundled, Some(&user));
        assert!(reg.all().is_empty());
        assert!(!reg.is_valid("linux-bash"));
    }

    #[test]
    fn scan_bundled_only() {
        let bundled = tmp("b-only");
        add_platform(&bundled, "linux-bash");
        add_platform(&bundled, "cisco-iosxe");
        let reg = PlatformRegistry::scan(&bundled, None::<&std::path::Path>);
        assert_eq!(reg.all(), vec!["cisco-iosxe", "linux-bash"]);
        assert!(reg.is_valid("linux-bash"));
        assert!(!reg.is_valid("f5-tmos"));
    }

    #[test]
    fn scan_user_only() {
        let bundled = tmp("u-only-b");
        let user = tmp("u-only-u");
        add_platform(&user, "my-custom");
        let reg = PlatformRegistry::scan(&bundled, Some(&user));
        assert_eq!(reg.all(), vec!["my-custom"]);
        assert!(reg.is_valid("my-custom"));
    }

    #[test]
    fn scan_union_and_dedup() {
        let bundled = tmp("union-b");
        let user = tmp("union-u");
        add_platform(&bundled, "linux-bash");
        add_platform(&user, "linux-bash"); // duplicate across roots
        add_platform(&user, "my-custom");
        let reg = PlatformRegistry::scan(&bundled, Some(&user));
        assert_eq!(reg.all(), vec!["linux-bash", "my-custom"]);
    }

    #[test]
    fn dir_without_index_yaml_excluded() {
        let bundled = tmp("noindex");
        fs::create_dir_all(bundled.join("not-a-platform")).unwrap(); // no index.yaml
        add_platform(&bundled, "real");
        let reg = PlatformRegistry::scan(&bundled, None::<&std::path::Path>);
        assert_eq!(reg.all(), vec!["real"]);
    }

    #[test]
    fn rescan_picks_up_new_platform() {
        let bundled = tmp("rescan-b");
        let user = tmp("rescan-u");
        add_platform(&user, "first");
        let mut reg = PlatformRegistry::scan(&bundled, Some(&user));
        assert_eq!(reg.all(), vec!["first"]);
        add_platform(&user, "second"); // appears after initial scan (e.g. import)
        reg.rescan();
        assert_eq!(reg.all(), vec!["first", "second"]);
    }

    #[test]
    fn builtin_has_four() {
        let reg = PlatformRegistry::builtin();
        assert_eq!(reg.all(), vec!["cisco-iosxe", "cisco-nxos", "f5-tmos", "linux-bash"]);
        assert!(reg.is_valid("cisco-nxos"));
        assert!(!reg.is_valid("unknown"));
    }
}

// Tauri Commands (moved from lib.rs)

#[tauri::command]
pub async fn load_platform_index(
    platform: String,
    state: tauri::State<'_, AppState>,
) -> Result<PlatformIndex, String> {
    let mut kb = state.kb.lock().map_err(|e| e.to_string())?;
    kb.get_platform_index(&platform)
}

#[tauri::command]
pub async fn list_kb_platforms(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let platforms = state.platforms.lock().map_err(|e| e.to_string())?;
    Ok(platforms.all())
}
