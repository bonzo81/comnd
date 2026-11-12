/**
 * Dropdown — suggestion list with keyboard navigation
 * Positioned near the terminal cursor. Max 8 visible items.
 *
 * Phase 3: rows show a tokenized suffix (remaining tokens) with the current
 * token highlighted. For `choice` tokens, the dropdown switches into a
 * "choice mode" where rows are the choice options instead of commands. See
 * docs/plans/010-plan-kb-token-engine.md § 3.2.
 */

import { SuggestionResult, Command, ghostPayloadFor } from "./suggestion-engine";
import { GhostPayload, ghostPayloadAcceptText } from "./ghost-text";
import { escHtml } from "./format";
import { renderToken, isChoice as isChoiceTok } from "./tokens";
import { moveListItem } from "./listbox-nav";

export type AcceptFn = (command: Command, payload: GhostPayload | null) => void;

interface ChoiceMode {
  options: string[];
  descriptions?: Record<string, string>;
  /** The partially typed current word, from the live token match. */
  typed: string;
}

export class Dropdown {
  private container: HTMLElement;
  private el: HTMLDivElement;
  private items: SuggestionResult[] = [];
  private selectedIndex = 0;
  private _visible = false;
  private onAccept: AcceptFn;
  private currentPrefix = "";

  /** When non-null, the dropdown shows choice options instead of commands. */
  private choiceMode: ChoiceMode | null = null;

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
    this.choiceMode = this.deriveChoiceMode(results);
    this.selectedIndex = this.choiceMode ? firstCompatibleIndex(this.choiceMode) : 0;
    this._pendingPayload = null;
    this._visible = true;
    if (this.choiceMode) this.renderChoice();
    else this.render();
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
    this.items = results;
    if (results.length === 0) {
      this.hide();
      return;
    }

    const next = this.deriveChoiceMode(results);
    const prevOptions = this.choiceMode?.options;

    this.choiceMode = next;
    if (next) {
      // Typing the partial word leaves the options unchanged — keep the
      // arrow-key position as long as the row can still complete that word.
      const keep = !!prevOptions
        && sameOptionsInOrder(next.options, prevOptions)
        && isCompatible(next, this.selectedIndex);
      this.selectedIndex = keep ? this.selectedIndex : firstCompatibleIndex(next);
      this.renderChoice();
      return;
    }

    this.selectedIndex = Math.min(this.selectedIndex, results.length - 1);
    this.render();
  }

  /**
   * Choice mode is derived from the results the dropdown already receives:
   * the top result's current token is a `choice` and its words become the
   * rows (docs/plans/010-plan-kb-token-engine.md § 3.2, MVP simplification).
   * Rows are never filtered by the typed word; only the selection skips rows
   * that word cannot complete to.
   */
  private deriveChoiceMode(results: SuggestionResult[]): ChoiceMode | null {
    const top = results[0];
    const tm = top?.tokenMatch;
    if (!top || !tm) return null;
    const tok = top.command.tokens?.[tm.currentTokenIndex];
    if (!tok || !isChoiceTok(tok)) return null;
    const mode: ChoiceMode = {
      options: tok.choice,
      descriptions: tok.descriptions,
      typed: tm.currentTokenInput ?? "",
    };
    // Staying in choice mode with nothing selectable would leave Tab with no
    // row to merge, so fall back to the command rows instead.
    return compatibleIndexes(mode).length > 0 ? mode : null;
  }

  /** Move selection up */
  moveUp() {
    this.move(-1);
  }

  /** Move selection down */
  moveDown() {
    this.move(1);
  }

  private move(delta: number) {
    if (this.choiceMode) {
      const compat = compatibleIndexes(this.choiceMode);
      if (compat.length === 0) return;
      const pos = compat.indexOf(this.selectedIndex);
      const step = pos < 0 ? 0 : (pos + delta + compat.length) % compat.length;
      this.selectedIndex = compat[step];
      this.renderChoice();
      return;
    }
    moveListItem(this.items.length, this.selectedIndex, (i) => {
      this.selectedIndex = i;
      this.render();
    }, delta);
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
      this._pendingPayload = {
        kind: "choice",
        options: this.choiceMode.options,
        pick: this.mergeChoiceRemainder(pick),
      };
      return top;
    }
    this._pendingPayload = null;
    if (this.items.length === 0) return null;
    return this.items[this.selectedIndex] ?? null;
  }

  /**
   * Remainder to send for a choice pick, merged with the partially typed
   * word. The token match carries the live word; `currentPrefix` is frozen
   * when the dropdown opens, so it is only a fallback.
   */
  private mergeChoiceRemainder(pick: string): string {
    const typed = this.choiceMode?.typed
      ?? this.items[0]?.tokenMatch?.currentTokenInput
      ?? this.currentPrefix.match(/\S*$/)?.[0]
      ?? "";
    return typed && pick.toLowerCase().startsWith(typed.toLowerCase())
      ? pick.substring(typed.length)
      : pick;
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
      // Prefix results (sudo X / tmsh X) matched the stripped remainder — the
      // raw input (with "sudo ") never prefix-matches the name, so skip
      // highlight for those rows.
      const hl = item.prefix ? "" : this.currentPrefix;
      const name = this.highlightPrefix(item.command.name, hl);
      const category = item.command.category;
      const suffix = this.tokenSuffix(item);
      // docs/10 § Part 2: "custom" tag when this command overrides a bundled
      // entry with the same name.
      const customBadge = item.command.overrides
        ? `<span class="badge-custom" title="Overrides built-in KB entry — your version is shown">custom</span>`
        : "";
      return `<div class="suggestion-item${isSelected ? " selected" : ""}" data-index="${i}">
        <span class="suggestion-name">${name}${customBadge}</span>
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
    const mode = this.choiceMode;
    if (!mode) return;
    const opts = mode.options;
    const descs = mode.descriptions;
    this.el.innerHTML = opts.map((opt, i) => {
      const isSelected = i === this.selectedIndex;
      // Rows the typed word cannot complete stay visible but are not
      // selectable — accepting one would append a different word to it.
      const disabled = !isCompatible(mode, i);
      return `<div class="suggestion-item choice-row${isSelected ? " selected" : ""}" data-index="${i}"${disabled ? ' aria-disabled="true"' : ""}>
        <span class="suggestion-name">${escHtml(opt)}</span>
        ${descs?.[opt] ? `<span class="choice-desc">${escHtml(descs[opt])}</span>` : ""}
      </div>`;
    }).join("");
    this.el.querySelectorAll(".choice-row").forEach((el) => {
      const idx = parseInt((el as HTMLElement).dataset.index ?? "0", 10);
      if (!isCompatible(mode, idx)) return;
      el.addEventListener("click", () => {
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
        this.onAccept(top.command, {
          kind: "choice",
          options: this.choiceMode.options,
          pick: this.mergeChoiceRemainder(pick),
        });
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

function sameOptionsInOrder(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((opt, i) => opt === b[i]);
}

/** Can the partially typed word still complete to this option? */
function isCompatible(mode: ChoiceMode, index: number): boolean {
  const opt = mode.options[index];
  if (!opt) return false;
  return !mode.typed || opt.toLowerCase().startsWith(mode.typed.toLowerCase());
}

function compatibleIndexes(mode: ChoiceMode): number[] {
  return mode.options
    .map((_, i) => i)
    .filter((i) => isCompatible(mode, i));
}

function firstCompatibleIndex(mode: ChoiceMode): number {
  return compatibleIndexes(mode)[0] ?? 0;
}
