//! Crate-level test fixtures — the Rust counterpart of `tests/harness.ts`.
//!
//! Holds the temp-directory guard every test uses instead of hand-managing
//! `std::env::temp_dir()`, and builders for the structs the unit tests
//! construct. Compiled only under `#[cfg(test)]`.

use std::ops::Deref;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use crate::credentials::CredentialSource;
use crate::hosts::{Host, HostGroup};
use crate::kb::{
    Command, CommandOrder, CommandToken, CommandVersions, KbManager, KbStore, PlatformIndex,
};
use crate::netbox::{DeviceOverlay, NetBoxConfig, NetBoxDeviceEntry};

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
    /// a code path creates no directory, and for tests where the code path under
    /// test must create the directory itself (e.g. with owner-only permissions).
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

impl AsRef<Path> for TempDir {
    fn as_ref(&self) -> &Path {
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

// ─── Lock-order probe ─────────────────────────────────────────────────────

/// Proves that `op` takes `first` before `second`, by contention: `first` is
/// held here, so `op` blocks on it, and `second` must stay acquirable for as
/// long as that lasts. An operation that grabbed `second` first would hold it
/// while waiting for `first`, and the probe fails.
///
/// Use it with the pair the code documents: for a chain `a -> b -> c`, probe
/// (`a`, `b`) then (`b`, `c`). Do not probe a lock the operation takes and
/// releases *before* blocking on the held one - the transient hold would make
/// the poll flake.
pub(crate) fn assert_acquired_before<'env, A, B, T>(
    first: &'env Mutex<A>,
    second: &'env Mutex<B>,
    op: impl FnOnce() -> T + Send + 'env,
) -> T
where
    A: Send + 'env,
    B: Send + 'env,
    T: Send + 'env,
{
    let guard = first.lock().unwrap();
    std::thread::scope(|scope| {
        let handle = scope.spawn(op);
        // The window only has to outlast thread start-up; if `op` has not
        // reached its first lock yet, the probe passes harmlessly.
        for _ in 0..100 {
            assert!(
                second.try_lock().is_ok(),
                "lock order violated: the second lock was taken before the first was released"
            );
            std::thread::sleep(Duration::from_millis(2));
        }
        assert!(
            !handle.is_finished(),
            "the operation completed while the first lock was held"
        );
        drop(guard);
        handle.join().unwrap()
    })
}

// ─── Command and KB builders (folded in from kb/test_util.rs) ─────────────

pub(crate) fn get_kb_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("knowledge-base")
}

pub(crate) fn mk_cmd(name: &str, tokens: Vec<CommandToken>) -> Command {
    Command {
        name: name.to_string(),
        syntax: String::new(),
        description: String::new(),
        category: "test".to_string(),
        mode: "privileged-exec".to_string(),
        aliases: vec![],
        examples: vec![],
        versions: CommandVersions::default(),
        tags: vec![],
        tokens,
        order: CommandOrder::Fixed,
        negatable: false,
        source: None,
        overrides: false,
        disabled: false,
    }
}

pub(crate) fn mk_full_cmd(name: &str, description: &str) -> Command {
    Command {
        name: name.to_string(),
        syntax: name.to_string(),
        description: description.to_string(),
        ..mk_cmd(name, vec![])
    }
}

pub(crate) fn mk_test_store(cmds: Vec<Command>) -> KbStore {
    KbStore {
        platform: PlatformIndex {
            id: "test".to_string(),
            name: "Test".to_string(),
            description: String::new(),
            reference_url: String::new(),
            versions: vec![],
            prompt_patterns: std::collections::HashMap::new(),
            secret_prompt_patterns: None,
            default_mode: "privileged-exec".to_string(),
            negation_prefix: None,
            prefix_commands: std::collections::HashMap::new(),
        },
        commands: cmds,
    }
}

pub(crate) const INDEX_YAML: &str = "id: test-plat\nname: Test\ndescription: \"\"\nreference_url: \"\"\nversions: []\nprompt_patterns: {}\ndefault_mode: default\n";

pub(crate) fn cmd_yaml(name: &str, desc: &str) -> String {
    format!(
        "commands:\n  - name: {name}\n    syntax: {name}\n    description: {desc}\n    category: test\n    mode: default\n"
    )
}

/// Isolated bundled + user KB fixture under `root`. Returns (bundled_path, user_path).
pub(crate) fn kb_fixture(
    root: &TempDir,
    bundled_cmds: &str,
    user_cmds: Option<&str>,
) -> (PathBuf, PathBuf) {
    let bundled = root.join("bundled");
    let user = root.join("user");
    std::fs::create_dir_all(bundled.join("test-plat/commands")).unwrap();
    std::fs::write(bundled.join("test-plat/index.yaml"), INDEX_YAML).unwrap();
    std::fs::write(bundled.join("test-plat/commands/test.yaml"), bundled_cmds).unwrap();

    if let Some(yaml) = user_cmds {
        std::fs::create_dir_all(user.join("test-plat/commands")).unwrap();
        std::fs::write(user.join("test-plat/index.yaml"), INDEX_YAML).unwrap();
        std::fs::write(user.join("test-plat/commands/test.yaml"), yaml).unwrap();
    } else {
        std::fs::create_dir_all(user.join("test-plat")).unwrap();
    }
    (bundled, user)
}

/// Fresh manager per call so the store reloads from disk.
pub(crate) fn loaded_names(bundled: &Path, user: &Path) -> Vec<String> {
    let mut mgr = KbManager::with_user_path(bundled.to_path_buf(), user.to_path_buf());
    let store = mgr.get_or_load("test-plat").unwrap();
    store.commands.iter().map(|c| c.name.clone()).collect()
}

pub(crate) fn loaded_cmd(bundled: &Path, user: &Path, name: &str) -> Option<Command> {
    let mut mgr = KbManager::with_user_path(bundled.to_path_buf(), user.to_path_buf());
    let store = mgr.get_or_load("test-plat").unwrap();
    store.commands.iter().find(|c| c.name == name).cloned()
}

// ─── Host and group builders ──────────────────────────────────────────────

pub(crate) fn mk_host(name: &str, hostname: &str) -> Host {
    Host {
        id: String::new(),
        display_name: name.to_string(),
        hostname: hostname.to_string(),
        port: 22,
        username: "admin".to_string(),
        auth_type: "password".to_string(),
        ssh_key_path: None,
        credential: None,
        platform: "cisco-iosxe".to_string(),
        os_version: None,
        highlight_profile: None,
        notes: None,
        last_connected: None,
        created_at: String::new(),
        sort_order: 0,
        tags: vec![],
        group_id: None,
        source: None,
    }
}

pub(crate) fn mk_group(name: &str) -> HostGroup {
    HostGroup {
        id: String::new(),
        name: name.to_string(),
        parent_id: None,
        sort_order: 0,
        color: None,
        icon: None,
        created_at: String::new(),
    }
}

// ─── NetBox builders (folded in from netbox::test_fixtures) ───────────────

pub(crate) fn sample_entry(id: u64, enabled: bool) -> NetBoxDeviceEntry {
    NetBoxDeviceEntry {
        netbox_id: id,
        name: format!("dev-{}", id),
        address: format!("10.0.0.{}", id),
        platform: "cisco-iosxe".into(),
        site: Some("dc1".into()),
        location: Some("rack-1".into()),
        tags: vec!["prod".into()],
        status: "active".into(),
        enabled,
        overlay: DeviceOverlay::default(),
    }
}

pub(crate) fn cfg_with(
    username: Option<&str>,
    port: u16,
    cred: Option<CredentialSource>,
) -> NetBoxConfig {
    NetBoxConfig {
        default_username: username.map(str::to_string),
        default_port: port,
        default_credential: cred,
        ..Default::default()
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
