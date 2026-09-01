/**
 * Tokens — the single home for KB token type guards and token→HTML
 * rendering. Consumed by the suggestion engine, the dropdown, and the
 * terminal sidebar. See docs/plan-kb-schema-deepening.md.
 */

import type { CommandToken, VarType, VarSource, PipeFilter } from "./tauri-api";
import { escHtml } from "./format";

// ─── Type guards ────────────────────────────────────────────────────

export function isLit(t: CommandToken): t is { lit: string; optional?: boolean } {
  return typeof (t as { lit?: unknown }).lit === "string";
}
export function isChoice(t: CommandToken): t is { choice: string[]; optional?: boolean; repeatable?: boolean } {
  return Array.isArray((t as { choice?: unknown }).choice);
}
export function isVar(t: CommandToken): t is {
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
export function isPipe(t: CommandToken): t is {
  pipe: boolean;
  filters?: PipeFilter[];
  optional?: boolean;
  repeatable?: boolean;
} {
  return typeof (t as { pipe?: unknown }).pipe === "boolean";
}

// ─── Rendering ─────────────────────────────────────────────────────

export interface RenderTokenOpts {
  /** dropdown: highlight the current token */
  current?: boolean;
  /** dropdown: first lit word index to highlight */
  litWordIdx?: number;
  /** sidebar: opt/rep/type/source badges */
  badges?: boolean;
}

/**
 * Render one token as HTML. Output for the shared cases is
 * byte-identical to the former dropdown and sidebar renderers.
 */
export function renderToken(t: CommandToken, opts: RenderTokenOpts = {}): string {
  const cls = opts.current ? "current" : "";
  if (isLit(t)) {
    if (opts.badges) {
      return `<span class="token-lit">${escHtml(t.lit)}</span>`;
    }
    const words = t.lit.trim().split(/\s+/);
    const rendered = words.map((w, idx) => {
      const wCls = opts.current && idx >= (opts.litWordIdx ?? 0) ? "current" : "";
      return wCls ? `<span class="token-lit ${wCls}">${escHtml(w)}</span>` : `<span class="token-lit">${escHtml(w)}</span>`;
    }).join(" ");
    return `<span class="${cls}">${rendered}</span>`;
  }
  if (isChoice(t)) {
    if (opts.badges) {
      const opt = t.optional ? " opt" : "";
      const rep = t.repeatable ? " rep" : "";
      return `<span class="token-choice${opt}${rep}">[${t.choice.map(escHtml).join(" | ")}]</span>`;
    }
    return `<span class="token-choice ${cls}">[${t.choice.map(escHtml).join(" | ")}]</span>`;
  }
  if (isVar(t)) {
    if (opts.badges) {
      const typeBadge = t.type && t.type !== "free"
        ? `<span class="token-type-badge">${escHtml(t.type)}</span>`
        : "";
      const srcBadge = t.source && t.source !== "none"
        ? `<span class="token-source-badge">${escHtml(t.source)}</span>`
        : "";
      const opt = t.optional ? " opt" : "";
      return `<span class="token-var${opt}">&lt;${escHtml(t.var)}&gt;${typeBadge}${srcBadge}</span>`;
    }
    return `<span class="token-var ${cls}">&lt;${escHtml(t.var)}&gt;</span>`;
  }
  if (isPipe(t)) {
    const fs = (t.filters ?? []).map((f) => escHtml(f.lit)).join(" | ");
    if (opts.badges) {
      return `<span class="token-pipe">| ${fs}</span>`;
    }
    return `<span class="token-pipe ${cls}">| ${fs}</span>`;
  }
  return "";
}