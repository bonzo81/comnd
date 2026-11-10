/**
 * Sidebar Content — renders command detail in the side panel
 * Syntax highlighting, examples, metadata, tags.
 *
 * Layout: an identity band (name, syntax, caller-supplied actions, description)
 * over a two-pane payload grid (token help, examples) and a footer rail of
 * facts, tags and the reference link. The band's hairline is the only rule in
 * the pane; the panes reflow to a single column when the pane is narrow.
 *
 * Phase 5.7: when `command.tokens` is present, per-token help is rendered as a
 * two-column list. The tokenized notation is drawn only as a fallback, for
 * commands whose tokens carry no help text — otherwise it would repeat the
 * `syntax` line already shown in the band. Validation issues come from the Rust
 * validator via the per-platform validation cache (see validation-cache.ts).
 */

import { Command } from "./suggestion-engine";
import { escHtml, formatMode } from "./format";
import { issuesFor } from "./validation-cache";
import { renderToken, renderTokenHelp } from "./tokens";

export class SidebarContent {
  /**
   * Render full command detail HTML.
   * `actions` is caller-owned markup (the KB viewer's edit/ignore/delete
   * buttons, which need their own state); the terminal side panel passes none.
   */
  render(command: Command, referenceUrl: string | null, actions = ""): string {
    return `
      <div class="cmd-detail">
        <div class="cmd-band">
          <div class="cmd-band-top">
            <h3 class="cmd-name">${escHtml(command.name)}${command.overrides
              ? `<span class="badge-custom" title="Overrides built-in KB entry — your version is shown">custom</span>`
              : ""}</h3>
            <code class="cmd-syntax">${this.formatSyntax(command.syntax)}</code>
            ${actions}
          </div>
          <p class="cmd-description">${escHtml(command.description)}</p>
        </div>
        <div class="cmd-grid">
          ${this.renderTokens(command)}
          ${this.renderExamples(command.examples)}
        </div>
        ${this.renderFooter(command, referenceUrl)}
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
    return `
      <section class="cmd-pane">
        <h4 class="cmd-pane-label">Examples</h4>
        <div class="cmd-examples">${items}</div>
      </section>
    `;
  }

  /** Footer rail: mode/category/version facts, tag pills, reference link. */
  private renderFooter(command: Command, referenceUrl: string | null): string {
    const facts: string[] = [];
    if (command.mode) facts.push(this.fact("Mode", formatMode(command.mode)));
    if (command.category) facts.push(this.fact("Category", command.category));
    if (command.versions.introduced) facts.push(this.fact("Since", command.versions.introduced));
    if (command.versions.deprecated) facts.push(this.fact("Deprecated", command.versions.deprecated));

    const tags = (command.tags ?? [])
      .map(t => `<span class="tag-badge">${escHtml(t)}</span>`)
      .join("");
    const docs = referenceUrl
      ? `<a class="cmd-ref-link" href="${escHtml(referenceUrl)}" target="_blank" rel="noopener noreferrer">Documentation ↗</a>`
      : "";

    if (facts.length === 0 && !tags && !docs) return "";
    return `<footer class="cmd-foot">${facts.join("")}${tags}${docs}</footer>`;
  }

  private fact(key: string, value: string): string {
    return `<span class="cmd-fact"><span class="cmd-fact-key">${escHtml(key)}</span>${escHtml(value)}</span>`;
  }

  private formatSyntax(syntax: string): string {
    // Escape first — syntax can originate from LLM-imported KB content.
    // The span-wrapping regexes then match the escaped entities, not raw HTML.
    return escHtml(syntax)
      .replace(/(<[^>]+>)/g, '<span class="syntax-required">$1</span>')
      .replace(/(\[[^\]]+\])/g, '<span class="syntax-optional">$1</span>');
  }

  /**
   * Phase 5.7: render per-token help as a two-column list when `tokens` is
   * present. Falls back to the tokenized notation only when no token carries
   * help text, so the grammar is never lost and never shown twice.
   * Surfaces validator issues inline so a malformed token is visible.
   */
  private renderTokens(command: Command): string {
    const toks = command.tokens;
    if (!toks || toks.length === 0) return "";
    const order = command.order ?? "fixed";
    const orderBadge = order !== "fixed"
      ? `<span class="token-order-badge">${escHtml(order)}</span>`
      : "";

    const help = renderTokenHelp(toks);

    // Inline validator issues — fetched from the Rust validator at load.
    const issues = issuesFor(command.name);
    const issueLine = issues.length > 0
      ? `<div class="token-issues">${issues.map((iss) => `<div class="token-issue">${escHtml(iss.message)}</div>`).join("")}</div>`
      : "";

    if (!help && !issueLine) {
      const parts = toks.map((t) => renderToken(t, { badges: true })).join(" ");
      return `
        <section class="cmd-pane">
          <h4 class="cmd-pane-label">Tokens ${orderBadge}</h4>
          <code class="token-breakdown">${parts}</code>
        </section>
      `;
    }

    return `
      <section class="cmd-pane">
        <h4 class="cmd-pane-label">Tokens ${orderBadge}</h4>
        ${help}
        ${issueLine}
      </section>
    `;
  }
}
