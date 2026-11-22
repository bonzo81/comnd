//! Crate-level test fixtures — the Rust counterpart of `tests/harness.ts`.
//!
//! Holds the temp-directory guard every test uses instead of hand-managing
//! `std::env::temp_dir()`, and builders for the structs the unit tests
//! construct. Compiled only under `#[cfg(test)]`.

use std::ops::Deref;
use std::path::{Path, PathBuf};

// ─── Temp directory guard ─────────────────────────────────────────────────

/// A uniquely named temp tree that removes itself when it drops, so a failing
/// or panicking test cannot leave one behind.
pub(crate) struct TempDir {
    path: PathBuf,
}

impl TempDir {
    /// `<os temp>/comnd-<prefix>-<uuid>`, created eagerly.
    pub(crate) fn new(prefix: &str) -> Self {
        let path = Self::unique_path(prefix);
        std::fs::create_dir_all(&path).expect("create fixture temp dir");
        Self { path }
    }

    /// Same unique naming, but the tree is never created. For tests that assert
    /// a code path creates no directory at all.
    pub(crate) fn absent(prefix: &str) -> Self {
        Self {
            path: Self::unique_path(prefix),
        }
    }

    fn unique_path(prefix: &str) -> PathBuf {
        std::env::temp_dir().join(format!("comnd-{}-{}", prefix, uuid::Uuid::new_v4()))
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn join(&self, suffix: impl AsRef<Path>) -> PathBuf {
        self.path.join(suffix)
    }
}

impl Deref for TempDir {
    type Target = Path;

    fn deref(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        // Best-effort: a test that already removed the tree, or a still-open
        // handle on Windows, must not turn teardown into a failure.
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guard_names_each_tree_uniquely_and_only_new_creates_it() {
        let first = TempDir::new("guard-unique");
        let second = TempDir::new("guard-unique");
        assert_ne!(first.path(), second.path());
        assert!(first.path().is_dir());
        assert!(second.path().is_dir());

        let absent = TempDir::absent("guard-absent");
        assert!(!absent.path().exists(), "absent() must not create the tree");
    }

    #[test]
    fn guard_removes_the_tree_after_a_panic() {
        let dir = TempDir::new("guard-panic");
        let path = dir.path().to_path_buf();
        std::fs::write(dir.join("artifact"), b"left behind").unwrap();

        let outcome = std::panic::catch_unwind(move || {
            let _dir = dir;
            panic!("intentional fixture panic");
        });

        assert!(outcome.is_err(), "the fixture use did not panic");
        assert!(
            !path.exists(),
            "temp tree survived the panic: {}",
            path.display()
        );
    }
}
