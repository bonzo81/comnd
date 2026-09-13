/**
 * Sidebar Content — renders command detail in the side panel
 * Syntax highlighting, examples, metadata, tags.
 *
 * Phase 5.7: when `command.tokens` is present, render a tokenized syntax
 * breakdown (lit plain, choice in [brackets], var in <angle>, pipe with
 * filters listed). Falls back to the flat `syntax` string when tokens are
 * absent. Validation issues come from the Rust validator via the
 * per-platform validation cache (see validation-cache.ts).
 */

import { Command } from "./suggestion-engine";
import { escHtml, formatMode } from "./format";
import { issuesFor } from "./validation-cache";
import { renderToken, renderTokenHelp } from "./tokens";

export class SidebarContent {
  /** Render full command detail HTML */
  render(command: Command, referenceUrl: string | null): string {
    return `
      <div class="cmd-detail">
        <h3 class="cmd-name">${escHtml(command.name)}${command.overrides
          ? `<span class="badge-custom" title="Overrides built-in KB entry — your version is shown">custom</span>`
          : ""}</h3>
        <div class="syntax-block"><code>${this.formatSyntax(command.syntax)}</code></div>
        ${this.renderTokens(command)}
        <p class="cmd-description">${escHtml(command.description)}</p>
        ${this.renderExamples(command.examples)}
        ${this.renderMeta(command)}
        ${this.renderTags(command.tags)}
        ${referenceUrl ? `<a class="cmd-ref-link" href="${escHtml(referenceUrl)}" target="_blank">Documentation ↗</a>` : ""}
      </div>
    `;
  }

  private renderExamples(examples: { command: string; description: string }[]): string {
    if (!examples || examples.length === 0) return "";
    const items = examples.map(ex =>
      `<div class="example-item" data-command="${escHtml(ex.command)}" title="Click to run">
        <code class="example-cmd">${escHtml(ex.command)}</code>
        <span class="example-desc">${escHtml(ex.description)}</span>
      </div>`
    ).join("");
    return `<div class="cmd-examples"><h4>Examples</h4>${items}</div>`;
  }

  private renderMeta(command: Command): string {
    const rows: string[] = [];
    if (command.mode) rows.push(`<span class="meta-label">Mode</span><span class="meta-value">${escHtml(formatMode(command.mode))}</span>`);
    if (command.category) rows.push(`<span class="meta-label">Category</span><span class="meta-value">${escHtml(command.category)}</span>`);
    if (command.versions.introduced) rows.push(`<span class="meta-label">Since</span><span class="meta-value">${escHtml(command.versions.introduced)}</span>`);
    if (command.versions.deprecated) rows.push(`<span class="meta-label">Deprecated</span><span class="meta-value">${escHtml(command.versions.deprecated)}</span>`);
    if (rows.length === 0) return "";
    return `<div class="cmd-meta">${rows.map(r => `<div class="meta-row">${r}</div>`).join("")}</div>`;
  }

  private renderTags(tags: string[]): string {
    if (!tags || tags.length === 0) return "";
    const pills = tags.map(t => `<span class="tag-badge">${escHtml(t)}</span>`).join("");
    return `<div class="cmd-tags">${pills}</div>`;
  }

  private formatSyntax(syntax: string): string {
    // Escape first — syntax can originate from LLM-imported KB content.
    // The span-wrapping regexes then match the escaped entities, not raw HTML.
    return escHtml(syntax)
      .replace(/(<[^>]+>)/g, '<span class="syntax-required">$1</span>')
      .replace(/(\[[^\]]+\])/g, '<span class="syntax-optional">$1</span>');
  }

  /**
   * Phase 5.7: render a tokenized syntax breakdown when `tokens` is present.
   * Falls back to empty (the flat `syntax` line above is already shown).
   * Surfaces validator issues inline so a malformed token is visible.
   */
  private renderTokens(command: Command): string {
    const toks = command.tokens;
    if (!toks || toks.length === 0) return "";
    const order = command.order ?? "fixed";
    const orderBadge = order !== "fixed"
      ? `<span class="token-order-badge">${escHtml(order)}</span>`
      : "";

    const parts = toks.map((t) => renderToken(t, { badges: true })).join(" ");

    // Inline validator issues — fetched from the Rust validator at load.
    const issues = issuesFor(command.name);
    const issueLine = issues.length > 0
      ? `<div class="token-issues">${issues.map((iss) => `<div class="token-issue">${escHtml(iss.message)}</div>`).join("")}</div>`
      : "";

    return `
      <div class="cmd-tokens">
        <h4>Tokens ${orderBadge}</h4>
        <code class="token-breakdown">${parts}</code>
        ${renderTokenHelp(toks)}
        ${issueLine}
      </div>
    `;
  }
}
