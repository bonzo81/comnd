//! Knowledge Base loader and query engine
//!
//! Loads YAML command files per platform into an in-memory index.
//! Supports fast prefix matching for the suggestion engine.
//!
//! Module layout (docs/plans/plan-kb-split-modules.md):
//!
//! - `schema`     — serde types for the KB wire format. No logic.
//! - `validate`   — token-schema validation (`validate_command`, `validate_platform`).
//! - `store`      — `KbStore` / `KbManager`: load, user-wins merge, tombstone filtering.
//! - `user_files` — user-KB YAML mutation (upsert / remove / disable / enable) and
//!   the `_deleted.yaml` / `_disabled.yaml` list-file formats.
//! - `commands`   — thin Tauri IPC handlers (lock state, delegate to the manager).
//!
//! The re-exports below are the module's whole external surface: the schema
//! types and free fns consumed by `import.rs` / `llm.rs` / `platform.rs` /
//! `state.rs`, plus the handlers `lib.rs` registers in `invoke_handler`.
//! Everything else is private to its defining submodule.

mod commands;
mod schema;
mod store;
#[cfg(test)]
mod test_util;
mod user_files;
mod validate;

// Handlers, registered in lib.rs as `kb::query_kb` etc. Glob-reexported
// (not listed) so the #[tauri::command]-generated `__cmd__*` companion
// modules resolve at the `kb::` path too — `generate_handler!` looks them
// up there. `pub(crate)` suffices: the `kb` module is private to the crate.
pub(crate) use commands::*;

// Schema types, re-exported so `crate::kb::Command`-style paths in
// import.rs / llm.rs / platform.rs keep working (zero-diff for consumers).
pub(crate) use schema::{
    Command, CommandExample, CommandOrder, CommandToken, CommandVersions, PlatformIndex,
};

// The store, plus the import.rs-facing free fns — the only kb internals that
// leave the module tree.
pub(crate) use store::{KbManager, KbStore};
pub(crate) use user_files::{get_target_yaml_path, write_commands_to_yaml};
pub(crate) use validate::validate_command;