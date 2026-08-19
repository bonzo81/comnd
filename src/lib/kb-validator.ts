/**
 * KB Token Validator (TypeScript mirror of kb.rs::validate_command).
 *
 * Same checks, same message strings so Rust and TS issues are comparable.
 * Used by the KB viewer (Phase 5) and optionally the import dialog for
 * pre-write validation. See docs/plan-kb-token-engine.md § 1.2.
 */

import type { Command, CommandToken, CommandOrder, VarType, VarSource } from "./tauri-api";

export interface KbValidationIssue {
  command: string;
  severity: "error" | "warning";
  message: string;
}

function isLit(t: CommandToken): t is { lit: string; optional?: boolean } {
  return typeof (t as { lit?: unknown }).lit === "string";
}
function isChoice(t: CommandToken): t is { choice: string[]; optional?: boolean } {
  return Array.isArray((t as { choice?: unknown }).choice);
}
function isVar(t: CommandToken): t is {
  var: string;
  type?: VarType;
  source?: VarSource;
  optional?: boolean;
  values?: string[];
  min?: number;
  max?: number;
} {
  return typeof (t as { var?: unknown }).var === "string";
}
function isPipe(t: CommandToken): t is {
  pipe: boolean;
  filters?: { lit: string; var?: string; type?: VarType }[];
  optional?: boolean;
  repeatable?: boolean;
} {
  return typeof (t as { pipe?: unknown }).pipe === "boolean";
}

/** Validate a single command's `tokens` list. */
export function validateCommand(cmd: Command): KbValidationIssue[] {
  const issues: KbValidationIssue[] = [];
  const name = cmd.name;

  if (!cmd.tokens || cmd.tokens.length === 0) {
    return issues;
  }

  cmd.tokens.forEach((tok, i) => {
    if (isLit(tok)) {
      if (tok.lit.trim().length === 0) {
        issues.push({ command: name, severity: "error", message: `tokens[${i}]: lit is empty` });
      }
    } else if (isChoice(tok)) {
      if (tok.choice.length === 0) {
        issues.push({ command: name, severity: "error", message: `tokens[${i}]: choice list is empty` });
      }
      for (const c of tok.choice) {
        if (c.trim().length === 0) {
          issues.push({ command: name, severity: "error", message: `tokens[${i}]: choice element is empty` });
        }
      }
    } else if (isVar(tok)) {
      if (tok.var.trim().length === 0) {
        issues.push({ command: name, severity: "error", message: `tokens[${i}]: var name is empty` });
      }
      if (tok.type === "numeric") {
        if (tok.min != null && tok.max != null && tok.min > tok.max) {
          issues.push({
            command: name,
            severity: "error",
            message: `tokens[${i}]: numeric var '${tok.var}' has min (${tok.min}) > max (${tok.max})`,
          });
        }
      }
      if (tok.source === "kb" && (!tok.values || tok.values.length === 0)) {
        issues.push({
          command: name,
          severity: "error",
          message: `tokens[${i}]: var '${tok.var}' source: kb requires non-empty values`,
        });
      }
      if (tok.source === "device" && tok.values && tok.values.length > 0) {
        issues.push({
          command: name,
          severity: "warning",
          message: `tokens[${i}]: var '${tok.var}' source: device should not carry values (static fallback is harmless)`,
        });
      }
    } else if (isPipe(tok)) {
      if (!tok.pipe) {
        issues.push({ command: name, severity: "error", message: `tokens[${i}]: pipe token must set pipe: true` });
      }
      (tok.filters ?? []).forEach((f, j) => {
        if (f.lit.trim().length === 0) {
          issues.push({ command: name, severity: "error", message: `tokens[${i}].filters[${j}]: filter lit is empty` });
        }
      });
    }
  });

  // Order-rule sanity.
  const order: CommandOrder = cmd.order ?? "fixed";
  if (order === "flags-anywhere" || order === "free") {
    const hasOptional = cmd.tokens.some((t) => {
      if (isLit(t) || isChoice(t)) return !!t.optional;
      if (isVar(t)) return !!t.optional;
      if (isPipe(t)) return !!t.optional;
      return false;
    });
    if (!hasOptional) {
      issues.push({
        command: name,
        severity: "warning",
        message: `order: ${order} but no optional tokens — order rule is meaningless`,
      });
    }
  }

  // negatable on show commands is suspicious.
  if (cmd.negatable && cmd.name.startsWith("show ")) {
    issues.push({
      command: name,
      severity: "warning",
      message: "negatable: true on a show command is unusual (some platforms allow `no show ...` quirks)",
    });
  }

  return issues;
}

/** Validate all commands in a platform, including duplicate (name, mode) detection. */
export function validatePlatform(commands: Command[]): KbValidationIssue[] {
  const issues: KbValidationIssue[] = [];
  const seen = new Map<string, number>();
  commands.forEach((cmd, idx) => {
    const key = `${cmd.name.toLowerCase()}\u0000${cmd.mode.toLowerCase()}`;
    const prevIdx = seen.get(key);
    if (prevIdx !== undefined) {
      issues.push({
        command: cmd.name,
        severity: "warning",
        message: `duplicate (name, mode) pair with command at index ${prevIdx}`,
      });
    } else {
      seen.set(key, idx);
    }
    issues.push(...validateCommand(cmd));
  });
  return issues;
}