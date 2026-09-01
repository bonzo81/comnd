/**
 * Dropdown — suggestion list with keyboard navigation
 * Positioned near the terminal cursor. Max 8 visible items.
 *
 * Phase 3: rows show a tokenized suffix (remaining tokens) with the current
 * token highlighted. For `choice` tokens, the dropdown can switch into a
 * "choice mode" where rows are the choice options instead of commands. See
 * docs/plan-kb-token-engine.md § 3.2.
 */

import { SuggestionResult, Command, ghostPayloadFor } from "./suggestion-engine";
import { GhostPayload, ghostPayloadAcceptText } from "./ghost-text";
import { escHtml } from "./format";
import { renderToken, isChoice as isChoiceTok } from "./tokens";

export type AcceptFn = (command: Command, payload: GhostPayload | null) => void;

export class Dropdown {
  private container: HTMLElement;
  private el: HTMLDivElement;
  private items: SuggestionResult[] = [];
  private selectedIndex = 0;
  private _visible = false;
  private onAccept: AcceptFn;
  private currentPrefix = "";

  /** When non-null, the dropdown shows choice options instead of commands. */
  private choiceMode: { options: string[]; descriptions?: Record<string, string>; sourceIndex: number } | null = null;

  constructor(container: HTMLElement, onAccept: AcceptFn) {
    this.container = container;
    this.onAccept = onAccept;

    this.el = document.createElement("div");
    this.el.className = "suggestion-dropdown";
    this.el.style.display = "none";
    this.container.appendChild(this.el);
  }

  /** Show the dropdown with results */
  show(results: SuggestionResult[], prefix: string) {
    this.items = results;
    this.currentPrefix = prefix;
    this.selectedIndex = 0;
    this.choiceMode = null;
    this._visible = true;
    this.render();
    this.el.style.display = "block";
  }

  /** Hide the dropdown */
  hide() {
    this._visible = false;
    this.choiceMode = null;
    this.el.style.display = "none";
  }

  /** Is the dropdown currently visible? */
  isVisible(): boolean {
    return this._visible;
  }

  /** Update results (e.g. when user types more) */
  updateResults(results: SuggestionResult[]) {
    if (this.choiceMode) {
      // Refresh choice-mode from the new top result if possible.
      const top = results[0];
      const tm = top?.tokenMatch;
      if (top && tm && top.command.tokens?.[tm.currentTokenIndex] && isChoiceTok(top.command.tokens[tm.currentTokenIndex])) {
        const tok = top.command.tokens[tm.currentTokenIndex] as { choice: string[]; descriptions?: Record<string, string> };
        this.choiceMode = { options: tok.choice, descriptions: tok.descriptions, sourceIndex: this.selectedIndex };
        this.selectedIndex = 0;
        this.renderChoice();
        return;
      }
      this.choiceMode = null;
    }
    this.items = results;
    if (results.length === 0) {
      this.hide();
      return;
    }
    this.selectedIndex = Math.min(this.selectedIndex, results.length - 1);
    this.render();
  }

  /** Move selection up */
  moveUp() {
    const count = this.choiceMode ? this.choiceMode.options.length : this.items.length;
    if (count === 0) return;
    this.selectedIndex = (this.selectedIndex - 1 + count) % count;
    this.render();
  }

  /** Move selection down */
  moveDown() {
    const count = this.choiceMode ? this.choiceMode.options.length : this.items.length;
    if (count === 0) return;
    this.selectedIndex = (this.selectedIndex + 1) % count;
    this.render();
  }

  /**
   * Get the currently selected result + its ghost payload (for accept).
   * In choice mode, returns the top command with a `choice` payload.
   */
  getSelected(): SuggestionResult | null {
    if (!this._visible) return null;
    if (this.choiceMode) {
      const top = this.items[0];
      if (!top) return null;
      const pick = this.choiceMode.options[this.selectedIndex] ?? "";
      // Attach the choice payload as a transient field via a wrapper result.
      // We return the top result and let the caller read the payload via
      // `getSelectedPayload()`.
      this._pendingPayload = { kind: "choice", options: this.choiceMode.options, pick };
      return top;
    }
    this._pendingPayload = null;
    if (this.items.length === 0) return null;
    return this.items[this.selectedIndex] ?? null;
  }

  private _pendingPayload: GhostPayload | null = null;

  /** Payload to send on accept (set by getSelected in choice mode). */
  getSelectedPayload(): GhostPayload | null {
    const p = this._pendingPayload;
    this._pendingPayload = null;
    return p;
  }

  /** Clean up DOM */
  destroy() {
    this.el.remove();
  }

  private render() {
    const maxVisible = 8;
    const visibleItems = this.items.slice(0, maxVisible);

    this.el.innerHTML = visibleItems.map((item, i) => {
      const isSelected = i === this.selectedIndex;
      const name = this.highlightPrefix(item.command.name, this.currentPrefix);
      const category = item.command.category;
      const suffix = this.tokenSuffix(item);
      return `<div class="suggestion-item${isSelected ? " selected" : ""}" data-index="${i}">
        <span class="suggestion-name">${name}</span>
        <span class="token-suffix">${suffix}</span>
        <span class="suggestion-category">${escHtml(category)}</span>
      </div>`;
    }).join("");

    // Scroll indicator
    if (this.items.length > maxVisible) {
      this.el.innerHTML += `<div class="scroll-indicator">+${this.items.length - maxVisible} more</div>`;
    }

    // Click handlers
    this.el.querySelectorAll(".suggestion-item").forEach((el) => {
      el.addEventListener("click", () => {
        const idx = parseInt((el as HTMLElement).dataset.index ?? "0", 10);
        if (this.items[idx]) {
          this.selectedIndex = idx;
          this.acceptCurrent();
        }
      });
    });
  }

  private renderChoice() {
    if (!this.choiceMode) return;
    const opts = this.choiceMode.options;
    const descs = this.choiceMode.descriptions;
    this.el.innerHTML = opts.map((opt, i) => {
      const isSelected = i === this.selectedIndex;
      return `<div class="suggestion-item choice-row${isSelected ? " selected" : ""}" data-index="${i}">
        <span class="suggestion-name">${escHtml(opt)}</span>
        ${descs?.[opt] ? `<span class="choice-desc">${escHtml(descs[opt])}</span>` : ""}
      </div>`;
    }).join("");
    this.el.querySelectorAll(".choice-row").forEach((el) => {
      el.addEventListener("click", () => {
        const idx = parseInt((el as HTMLElement).dataset.index ?? "0", 10);
        this.selectedIndex = idx;
        this.acceptCurrent();
      });
    });
  }

  /** Accept the current selection (command or choice option). */
  private acceptCurrent() {
    if (this.choiceMode) {
      const pick = this.choiceMode.options[this.selectedIndex] ?? "";
      const top = this.items[0];
      if (top) {
        this.onAccept(top.command, { kind: "choice", options: this.choiceMode.options, pick });
      }
    } else {
      const selected = this.items[this.selectedIndex];
      if (selected) {
        // Build payload for the selected command (same derivation as ghost).
        const payload = selected.tokenMatch ? ghostPayloadFor(selected.tokenMatch, selected.command) : null;
        this.onAccept(selected.command, payload);
      }
    }
    this.hide();
  }

  /**
   * Render the remaining tokens after the matched name as a tokenized suffix.
   * Literals plain, choices in brackets, variables in <>, current token
   * highlighted.
   */
  private tokenSuffix(item: SuggestionResult): string {
    const tm = item.tokenMatch;
    if (!tm) return "";
    const toks = item.command.tokens;
    if (!toks || toks.length === 0) return "";
    const currentIdx = tm.currentTokenIndex;
    // Render from the current token onward.
    const parts: string[] = [];
    for (let i = currentIdx; i < toks.length; i++) {
      const t = toks[i];
      const isCurrent = i === currentIdx;
      parts.push(renderToken(t, { current: isCurrent, litWordIdx: tm.litWordIndex }));
    }
    return parts.join(" ");
  }

  private highlightPrefix(name: string, prefix: string): string {
    if (!prefix) return escHtml(name);
    const lower = name.toLowerCase();
    const lowerPrefix = prefix.toLowerCase();
    if (lower.startsWith(lowerPrefix)) {
      const matched = name.substring(0, prefix.length);
      const rest = name.substring(prefix.length);
      return `<span class="prefix-match">${escHtml(matched)}</span>${escHtml(rest)}`;
    }
    return escHtml(name);
  }
}