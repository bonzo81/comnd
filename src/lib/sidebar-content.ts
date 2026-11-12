/**
 * Sidebar Content — renders command detail in the side panel
 * Syntax highlighting, examples, metadata, tags.
 *
 * Layout: an identity band (name, caller-supplied actions, description) over a
 * two-pane payload grid (tokens, examples) and a stacked metadata footer of
 * facts, tags and the reference link. The band's hairline is the only rule above
 * the payload; the panes reflow to a single column when the pane is narrow.
 *
 * Phase 5.7: the syntax line heads the Tokens pane as its grammar, followed by
 * per-token help as a two-column list; each help row repeats the flag or
 * keyword that takes its value. The tokenized notation is drawn only when the
 * authored syntax is absent, so the pane never states the grammar twice.
 * Validation issues come from the Rust validator via the per-platform
 * validation cache (see validation-cache.ts).
 */

import { Command } from "./suggestion-engine";
import { escHtml, formatMode } from "./format";
import { icons } from "./icons";
import { issuesFor } from "./validation-cache";
import { renderToken, renderTokenHelp } from "./tokens";
import { showToast } from "./toast";

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
      `<div class="example-item" data-command="${escHtml(ex.command)}">
        <code class="example-cmd">${escHtml(ex.command)}</code>
        <span class="example-desc">${escHtml(ex.description)}</span>
        <button type="button" class="example-copy" data-command="${escHtml(ex.command)}" aria-label="Copy ${escHtml(ex.command)}" title="Copy command">${icons.copy}</button>
      </div>`
    ).join("");
    return `
      <section class="cmd-pane">
        <h4 class="cmd-pane-label">Examples</h4>
        <div class="cmd-examples">${items}</div>
      </section>
    `;
  }

  /** Footer: stacked mode/category/version facts, tag pills, reference link. */
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
    const factList = facts.length > 0 ? `<dl class="cmd-facts">${facts.join("")}</dl>` : "";
    const tagList = tags ? `<div class="cmd-tags">${tags}</div>` : "";
    return `<footer class="cmd-foot">${factList}${tagList}${docs}</footer>`;
  }

  private fact(key: string, value: string): string {
    return `<dt>${escHtml(key)}</dt><dd>${escHtml(value)}</dd>`;
  }

  private formatSyntax(syntax: string): string {
    // Escape first — syntax can originate from LLM-imported KB content.
    // The span-wrapping regexes then match the escaped entities, not raw HTML.
    return escHtml(syntax)
      .replace(/(<[^>]+>)/g, '<span class="syntax-required">$1</span>')
      .replace(/(\[[^\]]+\])/g, '<span class="syntax-optional">$1</span>');
  }

  /**
   * Phase 5.7: the syntax line heads this pane as the grammar the tokens belong
   * to, followed by per-token help as a two-column list. A command whose tokens
   * carry no help text still shows its authored syntax here rather than the
   * tokenized notation, because only the authored form keeps the `[ ]` grouping
   * that marks a keyword optional; conversely a command with no authored syntax
   * falls back to the notation so no token goes undrawn. Surfaces validator
   * issues inline so a malformed token is visible.
   */
  private renderTokens(command: Command): string {
    const toks = command.tokens;
    const order = command.order ?? "fixed";
    const orderBadge = order !== "fixed"
      ? `<span class="token-order-badge">${escHtml(order)}</span>`
      : "";

    // A command with no tokens still needs somewhere for its grammar to live.
    if (!toks || toks.length === 0) {
      if (!command.syntax) return "";
      return `
        <section class="cmd-pane">
          <h4 class="cmd-pane-label">Syntax</h4>
          <code class="cmd-syntax">${this.formatSyntax(command.syntax)}</code>
        </section>
      `;
    }

    const help = renderTokenHelp(toks);

    // Inline validator issues — fetched from the Rust validator at load.
    const issues = issuesFor(command.name);
    const issueLine = issues.length > 0
      ? `<div class="token-issues">${issues.map((iss) => `<div class="token-issue">${escHtml(iss.message)}</div>`).join("")}</div>`
      : "";

    // The authored syntax anchors the grammar. The tokenized notation stands in
    // only when a command arrives without one, so a token that carries no help
    // text is never left with no visible representation.
    const grammar = command.syntax
      ? `<code class="cmd-syntax">${this.formatSyntax(command.syntax)}</code>`
      : `<code class="token-breakdown">${toks.map((t) => renderToken(t, { badges: true })).join(" ")}</code>`;

    if (!help && !issueLine) {
      return `
        <section class="cmd-pane">
          <h4 class="cmd-pane-label">Tokens ${orderBadge}</h4>
          ${grammar}
        </section>
      `;
    }

    return `
      <section class="cmd-pane">
        <h4 class="cmd-pane-label">Tokens ${orderBadge}</h4>
        ${grammar}
        ${help}
        ${issueLine}
      </section>
    `;
  }
}

/**
 * Wire the copy buttons in a freshly rendered detail pane. The rows themselves
 * may also be click-to-run (the terminal side panel sends the command), so the
 * button's click must not bubble to the row.
 *
 * A pointer press is cancelled so the button never takes focus: in the terminal
 * side panel xterm owns focus, and losing it would swallow keystrokes until the
 * user clicked back. Cancelling `pointerdown` leaves keyboard activation alone —
 * the button is still tab-focusable and still copies on Enter or Space.
 */
export function wireExampleCopy(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>(".example-copy").forEach((btn) => {
    btn.addEventListener("pointerdown", (event) => event.preventDefault());
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      const command = btn.dataset.command;
      if (!command) return;
      if (!navigator.clipboard) {
        showToast("Clipboard is unavailable", "error");
        return;
      }
      navigator.clipboard.writeText(command).then(
        () => showToast("Command copied", "success"),
        () => showToast("Could not copy the command", "error"),
      );
    });
  });
}
