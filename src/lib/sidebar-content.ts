/**
 * Sidebar Content — renders command detail in the side panel
 * Syntax highlighting, examples, metadata, tags.
 */

import { Command } from "./suggestion-engine";
import { escHtml, formatMode } from "./format";

export class SidebarContent {
  /** Render full command detail HTML */
  render(command: Command, referenceUrl: string | null): string {
    return `
      <div class="cmd-detail">
        <h3 class="cmd-name">${escHtml(command.name)}</h3>
        <div class="syntax-block"><code>${this.formatSyntax(command.syntax)}</code></div>
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
    // Colour-code: <required> in accent, [optional] in muted, keywords in primary
    return syntax
      .replace(/(<[^>]+>)/g, '<span class="syntax-required">$1</span>')
      .replace(/(\[[^\]]+\])/g, '<span class="syntax-optional">$1</span>');
  }
}
