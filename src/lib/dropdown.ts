/**
 * Dropdown — suggestion list with keyboard navigation
 * Positioned near the terminal cursor. Max 8 visible items.
 */

import { SuggestionResult, Command } from "./suggestion-engine";

export class Dropdown {
  private container: HTMLElement;
  private el: HTMLDivElement;
  private items: SuggestionResult[] = [];
  private selectedIndex = 0;
  private _visible = false;
  private onAccept: (command: Command) => void;
  private currentPrefix = "";

  constructor(container: HTMLElement, onAccept: (command: Command) => void) {
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
    this._visible = true;
    this.render();
    this.el.style.display = "block";
  }

  /** Hide the dropdown */
  hide() {
    this._visible = false;
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
    this.selectedIndex = Math.min(this.selectedIndex, results.length - 1);
    this.render();
  }

  /** Move selection up */
  moveUp() {
    if (this.items.length === 0) return;
    this.selectedIndex = (this.selectedIndex - 1 + this.items.length) % this.items.length;
    this.render();
  }

  /** Move selection down */
  moveDown() {
    if (this.items.length === 0) return;
    this.selectedIndex = (this.selectedIndex + 1) % this.items.length;
    this.render();
  }

  /** Get the currently selected result */
  getSelected(): SuggestionResult | null {
    if (!this._visible || this.items.length === 0) return null;
    return this.items[this.selectedIndex] ?? null;
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
      return `<div class="suggestion-item${isSelected ? " selected" : ""}" data-index="${i}">
        <span class="suggestion-name">${name}</span>
        <span class="suggestion-category">${this.escapeHtml(category)}</span>
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
          this.onAccept(this.items[idx].command);
          this.hide();
        }
      });
    });
  }

  private highlightPrefix(name: string, prefix: string): string {
    if (!prefix) return this.escapeHtml(name);
    const lower = name.toLowerCase();
    const lowerPrefix = prefix.toLowerCase();
    if (lower.startsWith(lowerPrefix)) {
      const matched = name.substring(0, prefix.length);
      const rest = name.substring(prefix.length);
      return `<span class="prefix-match">${this.escapeHtml(matched)}</span>${this.escapeHtml(rest)}`;
    }
    return this.escapeHtml(name);
  }

  private escapeHtml(text: string): string {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }
}
