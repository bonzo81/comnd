//! Shared test fixtures for the kb submodules
//! (docs/plans/plan-kb-split-modules.md): sample `Command` builders, temp KB
//! trees, and load-through-manager helpers used by more than one module's
//! tests. Compiled only under `#[cfg(test)]`.

use std::path::{Path, PathBuf};

use super::schema::{Command, CommandOrder, CommandToken, CommandVersions, PlatformIndex};
use super::store::{KbManager, KbStore};

pub(super) fn get_kb_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("knowledge-base")
}

pub(super) fn mk_cmd(name: &str, tokens: Vec<CommandToken>) -> Command {
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
    }
}

// ─── Custom KB: user-wins merge + provenance (docs/10 § Part 1) ────

pub(super) fn mk_full_cmd(name: &str, description: &str) -> Command {
    Command {
        name: name.to_string(),
        syntax: name.to_string(),
        description: description.to_string(),
        category: "test".to_string(),
        mode: "privileged-exec".to_string(),
        aliases: vec![],
        examples: vec![],
        versions: CommandVersions::default(),
        tags: vec![],
        tokens: vec![],
        order: CommandOrder::Fixed,
        negatable: false,
        source: None,
        overrides: false,
    }
}

pub(super) fn mk_test_store(cmds: Vec<Command>) -> KbStore {
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

// ─── Delete / disable / enable (docs/plans/plan-kb-ignore-disable.md) ──────

pub(super) const INDEX_YAML: &str = "id: test-plat\nname: Test\ndescription: \"\"\nreference_url: \"\"\nversions: []\nprompt_patterns: {}\ndefault_mode: default\n";

pub(super) fn cmd_yaml(name: &str, desc: &str) -> String {
    format!(
        "commands:\n  - name: {name}\n    syntax: {name}\n    description: {desc}\n    category: test\n    mode: default\n"
    )
}

/// Isolated bundled + user KB fixture. Returns (bundled_path, user_path).
pub(super) fn kb_fixture(suffix: &str, bundled_cmds: &str, user_cmds: Option<&str>) -> (PathBuf, PathBuf) {
    let base = std::env::temp_dir().join(format!("comnd-kb-{}-{}", suffix, std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let bundled = base.join("bundled");
    let user = base.join("user");
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
pub(super) fn loaded_names(bundled: &Path, user: &Path) -> Vec<String> {
    let mut mgr = KbManager::with_user_path(bundled.to_path_buf(), user.to_path_buf());
    let store = mgr.get_or_load("test-plat").unwrap();
    store.commands.iter().map(|c| c.name.clone()).collect()
}

pub(super) fn loaded_cmd(bundled: &Path, user: &Path, name: &str) -> Option<Command> {
    let mut mgr = KbManager::with_user_path(bundled.to_path_buf(), user.to_path_buf());
    let store = mgr.get_or_load("test-plat").unwrap();
    store.commands.iter().find(|c| c.name == name).cloned()
}

pub(super) fn drop_fixture(bundled: &Path) {
    std::fs::remove_dir_all(bundled.parent().unwrap()).ok();
}
