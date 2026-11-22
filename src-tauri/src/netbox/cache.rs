//! Persisted NetBox device cache (`netbox-cache.json`).
//!
//! The store owns the file and the in-memory copy; the sync rules that decide
//! what a sync may overwrite live in `inventory` — a device's `enabled` and
//! `overlay` are the only user-owned fields and survive a sync there.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::{NetBoxDeviceEntry, NetBoxGeo, SyncReport};

// ─── Cache store (plan §7.3) ────────────────────────────────────────

pub(crate) const CACHE_VERSION: u32 = 2;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct NetBoxCache {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub last_synced: Option<String>,
    #[serde(default)]
    pub sync_report: Option<SyncReport>,
    #[serde(default)]
    pub devices: Vec<NetBoxDeviceEntry>,
    /// Geography tables for the nav-tree hierarchy (v2): regions, sites,
    /// locations with parent links. Empty on pre-v2 caches — the tree
    /// degrades to slug-named site → flat locations.
    #[serde(default)]
    pub geo: NetBoxGeo,
}

pub struct NetBoxCacheStore {
    cache_path: Option<PathBuf>,
    cache: NetBoxCache,
}

impl NetBoxCacheStore {
    /// Create a store backed by `netbox-cache.json` in `data_dir`.
    pub fn new(data_dir: &std::path::Path) -> Result<Self, String> {
        crate::paths::ensure_data_dir(data_dir)
            .map_err(|e| format!("Failed to create data dir: {}", e))?;
        let cache_path = data_dir.join("netbox-cache.json");
        Ok(NetBoxCacheStore {
            cache: load_cache_from_file(&cache_path),
            cache_path: Some(cache_path),
        })
    }

    /// In-memory fallback (filesystem unavailable).
    pub fn in_memory() -> Self {
        NetBoxCacheStore {
            cache_path: None,
            cache: NetBoxCache::default(),
        }
    }

    pub fn get(&self) -> &NetBoxCache {
        &self.cache
    }

    /// Mutable access for the sync/settings rules in `inventory`. Mutations
    /// stay in memory until `save` is called.
    pub(crate) fn get_mut(&mut self) -> &mut NetBoxCache {
        &mut self.cache
    }

    pub(crate) fn save(&self) -> Result<(), String> {
        if let Some(ref path) = self.cache_path {
            let json = serde_json::to_string_pretty(&self.cache)
                .map_err(|e| format!("Failed to serialize netbox cache: {}", e))?;
            crate::paths::secure_write(path, json.as_bytes()).map_err(|e| {
                log::error!("Failed to write netbox cache to {}: {}", path.display(), e);
                format!("Failed to write netbox cache: {}", e)
            })?;
        }
        Ok(())
    }
}

/// Load the cache from disk; corrupt files are preserved as `.corrupt-<ts>`
/// and an empty cache is returned (mirrors `load_hosts_from_file`).
fn load_cache_from_file(path: &PathBuf) -> NetBoxCache {
    crate::paths::load_json_or_preserve::<NetBoxCache>(path)
}

// --------------------------------------------------------------------------
// Cache store.
// --------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    use crate::netbox::test_fixtures::*;

    #[test]
    fn test_cache_preserves_corrupt_file() {
        let dir = temp_dir();
        let path = dir.join("netbox-cache.json");
        std::fs::write(&path, "{not valid json").unwrap();

        let store = NetBoxCacheStore::new(&dir).unwrap();
        assert!(store.get().devices.is_empty());
        assert!(!path.exists(), "corrupt cache should be renamed away");
        let preserved = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("netbox-cache.json.corrupt-")
            });
        assert!(preserved, "expected a .corrupt-<ts> backup file");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
