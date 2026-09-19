//! Token validation (docs/plans/plan-kb-token-engine.md § 1.1).
//!
//! Validator returns a list of human-readable issues per command; the loader
//! logs warnings and surfaces them to the UI via the `validate_kb` Tauri
//! command (Phase 5).

use serde::Serialize;
use std::collections::HashMap;

use super::schema::{Command, CommandOrder, CommandToken, VarSource, VarType};

/// A validation issue for a single command.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct KbValidationIssue {
    pub command: String,
    pub severity: String, // "error" | "warning"
    pub message: String,
}

/// Validate a single command's `tokens` list.
/// Errors are correctness problems that would break matching; warnings are
/// suspicious-but-harmless configurations.
pub(crate) fn validate_command(cmd: &Command) -> Vec<KbValidationIssue> {
    let mut issues = Vec::new();
    let name = &cmd.name;

    // Duplicate (name, mode) within a platform is caught at the platform
    // level (validate_platform), not here — we only inspect one command.

    if cmd.tokens.is_empty() {
        // Legacy command — no tokens to validate.
        return issues;
    }

    for (i, tok) in cmd.tokens.iter().enumerate() {
        match tok {
            CommandToken::Lit { lit, .. } => {
                if lit.trim().is_empty() {
                    issues.push(KbValidationIssue {
                        command: name.clone(),
                        severity: "error".into(),
                        message: format!("tokens[{}]: lit is empty", i),
                    });
                }
            }
            CommandToken::Choice { choice, .. } => {
                if choice.is_empty() {
                    issues.push(KbValidationIssue {
                        command: name.clone(),
                        severity: "error".into(),
                        message: format!("tokens[{}]: choice list is empty", i),
                    });
                }
                for c in choice {
                    if c.trim().is_empty() {
                        issues.push(KbValidationIssue {
                            command: name.clone(),
                            severity: "error".into(),
                            message: format!("tokens[{}]: choice element is empty", i),
                        });
                    }
                }
            }
            CommandToken::Var(v) => {
                if v.var.trim().is_empty() {
                    issues.push(KbValidationIssue {
                        command: name.clone(),
                        severity: "error".into(),
                        message: format!("tokens[{}]: var name is empty", i),
                    });
                }
                if matches!(v.r#type, VarType::Numeric) {
                    if let (Some(min), Some(max)) = (v.min, v.max) {
                        if min > max {
                            issues.push(KbValidationIssue {
                                command: name.clone(),
                                severity: "error".into(),
                                message: format!("tokens[{}]: numeric var '{}' has min ({}) > max ({})", i, v.var, min, max),
                            });
                        }
                    }
                }
                if matches!(v.source, VarSource::Kb) && v.values.is_empty() {
                    issues.push(KbValidationIssue {
                        command: name.clone(),
                        severity: "error".into(),
                        message: format!("tokens[{}]: var '{}' source: kb requires non-empty values", i, v.var),
                    });
                }
                if matches!(v.source, VarSource::Device) && !v.values.is_empty() {
                    issues.push(KbValidationIssue {
                        command: name.clone(),
                        severity: "warning".into(),
                        message: format!("tokens[{}]: var '{}' source: device should not carry values (static fallback is harmless)", i, v.var),
                    });
                }
            }
            CommandToken::Pipe(p) => {
                if !p.pipe {
                    issues.push(KbValidationIssue {
                        command: name.clone(),
                        severity: "error".into(),
                        message: format!("tokens[{}]: pipe token must set pipe: true", i),
                    });
                }
                for (j, f) in p.filters.iter().enumerate() {
                    if f.lit.trim().is_empty() {
                        issues.push(KbValidationIssue {
                            command: name.clone(),
                            severity: "error".into(),
                            message: format!("tokens[{}].filters[{}]: filter lit is empty", i, j),
                        });
                    }
                }
            }
        }
    }

    // Order-rule sanity: flags-anywhere / free need at least one optional token
    // to be meaningful.
    if matches!(cmd.order, CommandOrder::FlagsAnywhere | CommandOrder::Free) {
        let has_optional = cmd.tokens.iter().any(|t| match t {
            CommandToken::Lit { optional, .. } => *optional,
            CommandToken::Choice { optional, .. } => *optional,
            CommandToken::Var(v) => v.optional,
            CommandToken::Pipe(p) => p.optional,
        });
        if !has_optional {
            issues.push(KbValidationIssue {
                command: name.clone(),
                severity: "warning".into(),
                message: format!("order: {:?} but no optional tokens — order rule is meaningless", cmd.order),
            });
        }
    }

    // negatable on show commands is suspicious but not wrong.
    if cmd.negatable && cmd.name.starts_with("show ") {
        issues.push(KbValidationIssue {
            command: name.clone(),
            severity: "warning".into(),
            message: "negatable: true on a show command is unusual (some platforms allow `no show ...` quirks)".into(),
        });
    }

    issues
}

/// Validate all commands in a platform, including duplicate (name, mode) detection.
pub(super) fn validate_platform(commands: &[Command]) -> Vec<KbValidationIssue> {
    let mut issues = Vec::new();
    let mut seen: HashMap<(String, String), usize> = HashMap::new();
    for (idx, cmd) in commands.iter().enumerate() {
        let key = (cmd.name.to_lowercase(), cmd.mode.to_lowercase());
        if let Some(&prev_idx) = seen.get(&key) {
            issues.push(KbValidationIssue {
                command: cmd.name.clone(),
                severity: "warning".into(),
                message: format!("duplicate (name, mode) pair with command at index {}", prev_idx),
            });
        } else {
            seen.insert(key, idx);
        }
        issues.extend(validate_command(cmd));
    }
    issues
}

#[cfg(test)]
mod tests {
    use super::*;

    use CommandToken::*;
    use crate::kb::schema::{PipeFilter, PipeToken, VarToken};
    use crate::kb::store::KbStore;
    use crate::kb::test_util::{get_kb_path, mk_cmd};

    fn has_error(issues: &[KbValidationIssue], needle: &str) -> bool {
        issues.iter().any(|i| i.severity == "error" && i.message.contains(needle))
    }

    fn has_warning(issues: &[KbValidationIssue], needle: &str) -> bool {
        issues.iter().any(|i| i.severity == "warning" && i.message.contains(needle))
    }

    #[test]
    fn test_validator_pass_lit() {
        let cmd = mk_cmd("show version", vec![Lit { lit: "show version".into(), optional: false }]);
        let issues = validate_command(&cmd);
        assert!(issues.is_empty(), "expected no issues, got {:?}", issues);
    }

    #[test]
    fn test_validator_pass_choice() {
        let cmd = mk_cmd("show interfaces", vec![
            Lit { lit: "show interfaces".into(), optional: false },
            Choice { choice: vec!["status".into(), "trunk".into()], optional: true, repeatable: false, descriptions: Default::default() },
        ]);
        let issues = validate_command(&cmd);
        assert!(issues.is_empty(), "expected no issues, got {:?}", issues);
    }

    #[test]
    fn test_validator_pass_var_numeric() {
        let cmd = mk_cmd("vlan", vec![
            Lit { lit: "vlan".into(), optional: false },
            Var(VarToken {
                var: "vlan-id".into(),
                description: None,
                r#type: VarType::Numeric,
                source: VarSource::None,
                optional: false,
                values: vec![],
                min: Some(1),
                max: Some(4094),
            }),
        ]);
        let issues = validate_command(&cmd);
        assert!(issues.is_empty(), "expected no issues, got {:?}", issues);
    }

    #[test]
    fn test_validator_pass_var_kb_source() {
        let cmd = mk_cmd("interface", vec![
            Lit { lit: "interface".into(), optional: false },
            Var(VarToken {
                var: "iface".into(),
                description: None,
                r#type: VarType::Enumerable,
                source: VarSource::Kb,
                optional: false,
                values: vec!["GigabitEthernet".into()],
                min: None,
                max: None,
            }),
        ]);
        let issues = validate_command(&cmd);
        assert!(issues.is_empty(), "expected no issues, got {:?}", issues);
    }

    #[test]
    fn test_validator_pass_pipe() {
        let cmd = mk_cmd("show run", vec![
            Lit { lit: "show running-config".into(), optional: false },
            Pipe(PipeToken {
                pipe: true,
                filters: vec![PipeFilter {
                    lit: "section".into(),
                    var: Some("regex".into()),
                    r#type: Some(VarType::Free),
                }],
                optional: true,
                repeatable: true,
            }),
        ]);
        let issues = validate_command(&cmd);
        assert!(issues.is_empty(), "expected no issues, got {:?}", issues);
    }

    #[test]
    fn test_validator_fail_empty_lit() {
        let cmd = mk_cmd("bad", vec![Lit { lit: "   ".into(), optional: false }]);
        let issues = validate_command(&cmd);
        assert!(has_error(&issues, "lit is empty"));
    }

    #[test]
    fn test_validator_fail_empty_choice() {
        let cmd = mk_cmd("bad", vec![Choice { choice: vec![], optional: false, repeatable: false, descriptions: Default::default() }]);
        let issues = validate_command(&cmd);
        assert!(has_error(&issues, "choice list is empty"));
    }

    #[test]
    fn test_validator_fail_empty_choice_element() {
        let cmd = mk_cmd("bad", vec![Choice { choice: vec!["".into()], optional: false, repeatable: false, descriptions: Default::default() }]);
        let issues = validate_command(&cmd);
        assert!(has_error(&issues, "choice element is empty"));
    }

    #[test]
    fn test_validator_fail_empty_var_name() {
        let cmd = mk_cmd("bad", vec![Var(VarToken {
            var: "  ".into(),
            description: None,
            r#type: VarType::Free,
            source: VarSource::None,
            optional: false,
            values: vec![],
            min: None,
            max: None,
        })]);
        let issues = validate_command(&cmd);
        assert!(has_error(&issues, "var name is empty"));
    }

    #[test]
    fn test_validator_fail_min_gt_max() {
        let cmd = mk_cmd("bad", vec![Var(VarToken {
            var: "n".into(),
            description: None,
            r#type: VarType::Numeric,
            source: VarSource::None,
            optional: false,
            values: vec![],
            min: Some(10),
            max: Some(5),
        })]);
        let issues = validate_command(&cmd);
        assert!(has_error(&issues, "min (10) > max (5)"));
    }

    #[test]
    fn test_validator_fail_kb_source_no_values() {
        let cmd = mk_cmd("bad", vec![Var(VarToken {
            var: "iface".into(),
            description: None,
            r#type: VarType::Enumerable,
            source: VarSource::Kb,
            optional: false,
            values: vec![],
            min: None,
            max: None,
        })]);
        let issues = validate_command(&cmd);
        assert!(has_error(&issues, "source: kb requires non-empty values"));
    }

    #[test]
    fn test_validator_warn_device_source_with_values() {
        let cmd = mk_cmd("bad", vec![Var(VarToken {
            var: "iface".into(),
            description: None,
            r#type: VarType::Enumerable,
            source: VarSource::Device,
            optional: false,
            values: vec!["Gi0/1".into()],
            min: None,
            max: None,
        })]);
        let issues = validate_command(&cmd);
        assert!(has_warning(&issues, "source: device should not carry values"));
    }

    #[test]
    fn test_validator_fail_pipe_not_true() {
        let cmd = mk_cmd("bad", vec![Pipe(PipeToken {
            pipe: false,
            filters: vec![],
            optional: true,
            repeatable: false,
        })]);
        let issues = validate_command(&cmd);
        assert!(has_error(&issues, "pipe token must set pipe: true"));
    }

    #[test]
    fn test_validator_warn_order_no_optional() {
        let mut cmd = mk_cmd("ping", vec![
            Lit { lit: "ping".into(), optional: false },
            Var(VarToken {
                var: "host".into(),
                description: None,
                r#type: VarType::Free,
                source: VarSource::None,
                optional: false,
                values: vec![],
                min: None,
                max: None,
            }),
        ]);
        cmd.order = CommandOrder::FlagsAnywhere;
        let issues = validate_command(&cmd);
        assert!(has_warning(&issues, "order rule is meaningless"));
    }

    #[test]
    fn test_validator_warn_negatable_show() {
        let mut cmd = mk_cmd("show interfaces", vec![Lit { lit: "show interfaces".into(), optional: false }]);
        cmd.negatable = true;
        let issues = validate_command(&cmd);
        assert!(has_warning(&issues, "negatable: true on a show command"));
    }

    #[test]
    fn test_validator_legacy_command_no_issues() {
        let mut cmd = mk_cmd("legacy", vec![]);
        cmd.tokens = vec![];
        let issues = validate_command(&cmd);
        assert!(issues.is_empty());
    }

    #[test]
    fn test_validator_platform_duplicate_name_mode() {
        let a = mk_cmd("network", vec![Lit { lit: "network".into(), optional: false }]);
        let mut b = mk_cmd("network", vec![Lit { lit: "network".into(), optional: false }]);
        b.mode = "routing-config".to_string();
        let c = mk_cmd("network", vec![Lit { lit: "network".into(), optional: false }]);
        let issues = validate_platform(&[a, b, c]);
        // a and c share (network, privileged-exec) → duplicate warning
        assert!(has_warning(&issues, "duplicate (name, mode)"));
        // b differs in mode → no duplicate with a/c
        let dup_count = issues.iter().filter(|i| i.message.contains("duplicate")).count();
        assert_eq!(dup_count, 1);
    }

    #[test]
    fn test_validator_real_iosxe_networking_clean() {
        // The backfilled networking.yaml should have no validator errors.
        let kb_path = get_kb_path();
        let store = KbStore::load("cisco-iosxe", &kb_path).unwrap();
        let networking: Vec<Command> = store.commands.iter()
            .filter(|c| c.category == "networking")
            .cloned()
            .collect();
        let issues = validate_platform(&networking);
        let errors: Vec<_> = issues.iter().filter(|i| i.severity == "error").collect();
        assert!(errors.is_empty(), "networking.yaml validation errors: {:?}", errors);
    }

    #[test]
    fn test_validator_real_iosxe_routing_clean() {
        let kb_path = get_kb_path();
        let store = KbStore::load("cisco-iosxe", &kb_path).unwrap();
        let routing: Vec<Command> = store.commands.iter()
            .filter(|c| c.category == "routing")
            .cloned()
            .collect();
        let issues = validate_platform(&routing);
        let errors: Vec<_> = issues.iter().filter(|i| i.severity == "error").collect();
        assert!(errors.is_empty(), "routing.yaml validation errors: {:?}", errors);
    }
}