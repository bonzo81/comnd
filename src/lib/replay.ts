/**
 * Command Replay helpers — template substitution + rendering for {{name}}
 * variables. See docs/specs/09-command-replay.md.
 */

import { ReplayVariable } from "./tauri-api";
import { escHtml } from "./format";

/**
 * Substitute values into a template. Throws when a variable has no value —
 * the caller should prompt instead of sending a partial command.
 */
export function substitute(
  command: string,
  variables: ReplayVariable[],
  values: Record<string, string>,
): string {
  let out = command;
  for (const v of variables) {
    const val = values[v.name];
    if (val === undefined || val.trim() === "") {
      throw new Error(`Missing value for variable '${v.name}'`);
    }
    out = out.replaceAll(`{{${v.name}}}`, val);
  }
  return out;
}

/** Render a template, highlighting {{variables}} as chips. */
export function renderReplayTemplate(command: string): string {
  return escHtml(command).replace(
    /\{\{([^{}]+)\}\}/g,
    (_m, name: string) => `<span class="replay-var">${escHtml(name)}</span>`,
  );
}