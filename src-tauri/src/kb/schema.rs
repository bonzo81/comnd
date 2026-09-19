//! KB wire-format schema (docs/specs/06-knowledge-base.md).
//!
//! Serde types only — no logic. Loading and validation live in `store` and
//! `validate`; file mutation lives in `user_files`. The phase-1 contract test
//! (`mod contract` below, docs/plans/plan-kb-contract-test.md) pins this
//! schema to tests/kb-schema.fixture.json from both sides of the IPC seam.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ─── Structs ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct PlatformIndex {
    pub id: String,
    pub name: String,
    pub description: String,
    pub reference_url: String,
    pub versions: Vec<String>,
    pub prompt_patterns: HashMap<String, String>,
    pub default_mode: String,
    #[serde(default)]
    pub negation_prefix: Option<String>,
    /// Commands that may precede other commands (e.g. linux `sudo`, F5 bash
    /// `tmsh`). Keyed by prefix word. See docs/specs/06-knowledge-base.md § Prefix Commands.
    #[serde(default)]
    pub prefix_commands: HashMap<String, PrefixCommand>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct PrefixCommand {
    /// Modes whose commands become matchable after the prefix is stripped.
    pub unlocks: Vec<String>,
    /// Flags (before the inner command) that take a value which should be
    /// skipped when stripping, e.g. sudo's `-u <user>`.
    #[serde(default)]
    pub skip_flag_value: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct Command {
    pub name: String,
    pub syntax: String,
    pub description: String,
    pub category: String,
    pub mode: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub examples: Vec<CommandExample>,
    #[serde(default)]
    pub versions: CommandVersions,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub tokens: Vec<CommandToken>,
    #[serde(default)]
    pub order: CommandOrder,
    #[serde(default)]
    pub negatable: bool,
    /// Provenance (docs/specs/10-custom-knowledge-base.md): Some("custom") when the
    /// command came from the user KB layer; None (bundled). Merge-generated,
    /// never authored — stripped from YAML writes in `serialize_commands`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// True when this command replaced a bundled command with the same name.
    /// Merge-generated; stripped from YAML writes.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub overrides: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct CommandExample {
    pub command: String,
    pub description: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct CommandVersions {
    pub introduced: Option<String>,
    pub deprecated: Option<String>,
    pub notes: Option<String>,
}

// ─── Token schema (machine-readable syntax) ─────────────────────────
// See docs/specs/06-knowledge-base.md § Token Schema. Optional; legacy commands
// without `tokens` fall back to name/alias prefix matching.

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub(crate) enum CommandToken {
    /// Fixed literal keyword(s). May be multi-word.
    Lit { lit: String, #[serde(default)] optional: bool },
    /// One of a fixed set of keywords. `repeatable` (Phase 4) allows the same
    /// choice token to match more than once — used for repeatable flags such
    /// as `ls -l -a`. The engine honours it; the validator accepts it.
    Choice {
        choice: Vec<String>,
        #[serde(default)]
        optional: bool,
        #[serde(default)]
        repeatable: bool,
        /// Per-option help text (flag → meaning). Display-only.
        #[serde(default)]
        descriptions: std::collections::HashMap<String, String>,
    },
    /// A variable slot.
    Var(VarToken),
    /// Pipe / filter separator. See docs § Token Schema.
    Pipe(PipeToken),
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct VarToken {
    pub var: String,
    /// Help text for the variable slot. Display-only.
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub r#type: VarType,
    #[serde(default)]
    pub source: VarSource,
    #[serde(default)]
    pub optional: bool,
    #[serde(default)]
    pub values: Vec<String>,
    #[serde(default)]
    pub min: Option<i64>,
    #[serde(default)]
    pub max: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum VarType {
    #[default]
    Free,
    Enumerable,
    Numeric,
    Choice,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum VarSource {
    #[default]
    None,
    Device,
    Kb,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct PipeToken {
    #[serde(default = "default_true")]
    pub pipe: bool,
    #[serde(default)]
    pub filters: Vec<PipeFilter>,
    #[serde(default)]
    pub optional: bool,
    #[serde(default)]
    pub repeatable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct PipeFilter {
    pub lit: String,
    #[serde(default)]
    pub var: Option<String>,
    #[serde(default)]
    pub r#type: Option<VarType>,
}

fn default_true() -> bool { true }

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub(crate) enum CommandOrder {
    #[default]
    #[serde(rename = "fixed")]
    Fixed,
    #[serde(rename = "flags-anywhere")]
    FlagsAnywhere,
    #[serde(rename = "free")]
    Free,
}

#[cfg(test)]
mod contract {
    //! KB Command/CommandToken schema contract (docs/plans/plan-kb-contract-test.md).
    //! tests/kb-schema.fixture.json is asserted from both sides of the IPC seam:
    //! this module (serde wire shape) and src/lib/kb-schema.contract.test.ts
    //! (type guards + renderer). A schema change must update the fixture in the
    //! same commit or both suites fail.

    use super::*;
    use crate::kb::store::CommandFile;
    use crate::kb::user_files::serialize_commands;
    use crate::kb::validate::validate_command;

    /// Canonical fixture commands — one per schema corner case. These literals are
    /// the Rust-side input; tests/kb-schema.fixture.json holds the expected wire JSON.
    fn fixture_commands() -> Vec<Command> {
        vec![
            Command {
                name: "show ip interface brief".into(),
                syntax: "show ip interface [brief | detail] [<interface-name>]".into(),
                description: "Show IP interface status and addresses.".into(),
                category: "interfaces".into(),
                mode: "privileged-exec".into(),
                aliases: vec!["sh ip int b".into()],
                examples: vec![CommandExample { command: "show ip interface brief".into(), description: "Brief view of all interfaces".into() }],
                versions: CommandVersions { introduced: Some("12.0(0)".into()), deprecated: None, notes: None },
                tags: vec!["interface".into()],
                tokens: vec![
                    CommandToken::Lit { lit: "show ip interface".into(), optional: false },
                    CommandToken::Choice { choice: vec!["brief".into(), "detail".into()], optional: true, repeatable: false, descriptions: HashMap::from([("brief".to_string(), "One line per interface".to_string())]) },
                    CommandToken::Var(VarToken { var: "interface-name".into(), description: Some("Interface to inspect".into()), r#type: VarType::Enumerable, source: VarSource::Device, optional: true, values: vec![], min: None, max: None }),
                ],
                order: CommandOrder::Fixed,
                negatable: false,
                source: None,
                overrides: false,
            },
            Command {
                name: "ls".into(),
                syntax: "ls [-l | -a | -h] [<count>] | grep <pattern>".into(),
                description: "List directory contents.".into(),
                category: "filesystem".into(),
                mode: "user-exec".into(),
                aliases: vec![],
                examples: vec![],
                versions: CommandVersions::default(),
                tags: vec![],
                tokens: vec![
                    CommandToken::Lit { lit: "ls".into(), optional: false },
                    CommandToken::Choice { choice: vec!["-l".into(), "-a".into(), "-h".into()], optional: true, repeatable: true, descriptions: HashMap::new() },
                    CommandToken::Var(VarToken { var: "count".into(), description: None, r#type: VarType::Numeric, source: VarSource::None, optional: true, values: vec![], min: Some(1), max: Some(99) }),
                    CommandToken::Pipe(PipeToken { pipe: true, filters: vec![PipeFilter { lit: "grep".into(), var: Some("pattern".into()), r#type: Some(VarType::Free) }], optional: true, repeatable: false }),
                ],
                order: CommandOrder::FlagsAnywhere,
                negatable: false,
                source: None,
                overrides: false,
            },
            Command {
                name: "set profile".into(),
                syntax: "set [<profile-type>] [commit]".into(),
                description: "Select the active configuration profile.".into(),
                category: "config".into(),
                mode: "admin".into(),
                aliases: vec![],
                examples: vec![],
                versions: CommandVersions::default(),
                tags: vec![],
                tokens: vec![
                    CommandToken::Lit { lit: "set".into(), optional: false },
                    CommandToken::Var(VarToken { var: "profile-type".into(), description: None, r#type: VarType::Choice, source: VarSource::Kb, optional: true, values: vec!["blue".into(), "green".into()], min: None, max: None }),
                    CommandToken::Lit { lit: "commit".into(), optional: true },
                ],
                order: CommandOrder::Free,
                negatable: true,
                source: None,
                overrides: false,
            },
            Command {
                name: "copy running-config startup".into(),
                syntax: "copy <src> <dst> [force]".into(),
                description: "Copy the running configuration to startup.".into(),
                category: "config".into(),
                mode: "privileged-exec".into(),
                aliases: vec![],
                examples: vec![],
                versions: CommandVersions::default(),
                tags: vec![],
                tokens: vec![
                    CommandToken::Lit { lit: "copy".into(), optional: false },
                    CommandToken::Var(VarToken { var: "src".into(), description: None, r#type: VarType::Free, source: VarSource::None, optional: false, values: vec![], min: None, max: None }),
                    CommandToken::Var(VarToken { var: "dst".into(), description: None, r#type: VarType::Free, source: VarSource::None, optional: false, values: vec![], min: None, max: None }),
                    CommandToken::Lit { lit: "force".into(), optional: true },
                ],
                order: CommandOrder::Fixed,
                negatable: false,
                source: Some("custom".into()),
                overrides: true,
            },
        ]
    }

    fn load_fixture() -> serde_json::Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/kb-schema.fixture.json");
        let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("fixture missing at {:?}: {}", path, e));
        serde_json::from_str(&raw).expect("fixture is valid JSON")
    }

    #[test]
    fn contract_ipc_json_matches_fixture() {
        let actual = serde_json::to_value(fixture_commands()).expect("fixture commands serialize");
        let expected = load_fixture()["expected_ipc_json"].clone();
        assert_eq!(actual, expected, "wire shape drifted — update tests/kb-schema.fixture.json in the same commit");
    }

    #[test]
    fn contract_kind_coverage() {
        let mut multi_word_lit = 0;
        let mut optional_lit = 0;
        let mut choice_optional = 0;
        let mut choice_repeatable = 0;
        let mut choice_descriptions = 0;
        // [free, enumerable, numeric, choice] / [none, device, kb] / [fixed, flags-anywhere, free]
        let mut var_types = [0usize; 4];
        let mut var_sources = [0usize; 3];
        let mut orders = [0usize; 3];
        let mut numeric_bounds = 0;
        let mut kb_values = 0;
        let mut optional_var = 0;
        let mut pipe_filters = 0;
        let mut optional_pipe = 0;

        for cmd in fixture_commands() {
            match cmd.order {
                CommandOrder::Fixed => orders[0] += 1,
                CommandOrder::FlagsAnywhere => orders[1] += 1,
                CommandOrder::Free => orders[2] += 1,
            }
            for t in &cmd.tokens {
                match t {
                    CommandToken::Lit { lit, optional } => {
                        if lit.contains(' ') { multi_word_lit += 1; }
                        if *optional { optional_lit += 1; }
                    }
                    CommandToken::Choice { optional, repeatable, descriptions, .. } => {
                        if *optional { choice_optional += 1; }
                        if *repeatable { choice_repeatable += 1; }
                        if !descriptions.is_empty() { choice_descriptions += 1; }
                    }
                    CommandToken::Var(v) => {
                        match v.r#type {
                            VarType::Free => var_types[0] += 1,
                            VarType::Enumerable => var_types[1] += 1,
                            VarType::Numeric => var_types[2] += 1,
                            VarType::Choice => var_types[3] += 1,
                        }
                        match v.source {
                            VarSource::None => var_sources[0] += 1,
                            VarSource::Device => var_sources[1] += 1,
                            VarSource::Kb => var_sources[2] += 1,
                        }
                        if matches!(v.r#type, VarType::Numeric) && v.min.is_some() && v.max.is_some() { numeric_bounds += 1; }
                        if matches!(v.source, VarSource::Kb) && !v.values.is_empty() { kb_values += 1; }
                        if v.optional { optional_var += 1; }
                    }
                    CommandToken::Pipe(p) => {
                        pipe_filters += p.filters.len();
                        if p.optional { optional_pipe += 1; }
                    }
                }
            }
        }

        assert!(multi_word_lit >= 1, "need a multi-word lit");
        assert!(optional_lit >= 1, "need an optional lit");
        assert!(choice_optional >= 1, "need an optional choice");
        assert!(choice_repeatable >= 1, "need a repeatable choice");
        assert!(choice_descriptions >= 1, "need a choice with descriptions");
        assert!(var_types.iter().all(|&n| n >= 1), "need all four var types: {:?}", var_types);
        assert!(var_sources.iter().all(|&n| n >= 1), "need none/device/kb var sources: {:?}", var_sources);
        assert!(numeric_bounds >= 1, "need a numeric var with min+max");
        assert!(kb_values >= 1, "need a kb-source var with values");
        assert!(optional_var >= 1, "need an optional var");
        assert!(pipe_filters >= 1, "need pipe filters");
        assert!(optional_pipe >= 1, "need an optional pipe");
        assert!(orders.iter().all(|&n| n >= 1), "need all three order modes: {:?}", orders);
    }

    #[test]
    fn contract_llm_shape_round_trip() {
        let fixture = load_fixture();
        let expected = fixture["expected_ipc_json"].as_array().expect("fixture has expected_ipc_json array").clone();

        // LLM import parse path: ExtractionResult must accept the same token shapes.
        serde_json::from_value::<crate::llm::ExtractionResult>(serde_json::json!({ "commands": expected }))
            .expect("LLM import shape must accept fixture commands");

        // validate_command on the IPC-shape deserialization — zero issues for valid entries.
        let cmds: Vec<Command> = serde_json::from_value(fixture["expected_ipc_json"].clone())
            .expect("IPC JSON must deserialize to Command");
        for cmd in &cmds {
            let issues = validate_command(cmd);
            assert!(issues.is_empty(), "fixture command '{}' must be validation-clean: {:?}", cmd.name, issues);
        }
    }

}