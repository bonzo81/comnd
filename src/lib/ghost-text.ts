/**
 * Ghost Text — inline suggestion overlay for xterm.js
 * Renders semi-transparent completion text at the cursor position.
 */

import { Terminal } from "@xterm/xterm";

export class GhostText {
  private terminal: Terminal;
  private container: HTMLElement;
  private el: HTMLSpanElement;
  private badgeEl: HTMLSpanElement;
  private currentRemainder = "";
  private visible = false;

  constructor(terminal: Terminal, container: HTMLElement) {
    this.terminal = terminal;
    this.container = container;

    this.el = document.createElement("span");
    this.el.className = "ghost-text";
    this.container.appendChild(this.el);

    this.badgeEl = document.createElement("span");
    this.badgeEl.className = "match-count-badge";
    this.container.appendChild(this.badgeEl);
  }

  /** Show ghost text with the command remainder after user's typed prefix */
  show(remainder: string, extraMatchCount: number) {
    if (!remainder) {
      this.hide();
      return;
    }
    this.currentRemainder = remainder;
    this.el.textContent = remainder;
    this.visible = true;
    this.el.style.display = "inline";

    // Position at cursor
    this.positionAtCursor();

    // Match count badge
    if (extraMatchCount > 0) {
      this.badgeEl.textContent = `(+${extraMatchCount})`;
      this.badgeEl.style.display = "inline";
    } else {
      this.badgeEl.style.display = "none";
    }
  }

  /** Hide ghost text */
  hide() {
    this.visible = false;
    this.currentRemainder = "";
    this.el.style.display = "none";
    this.badgeEl.style.display = "none";
  }

  /** Check if ghost text is currently visible */
  isShowing(): boolean {
    return this.visible;
  }

  /** Get the current remainder (for Tab-accept) */
  getCurrentRemainder(): string | null {
    return this.visible ? this.currentRemainder : null;
  }

  /** Reposition ghost text (called on resize/scroll) */
  reposition() {
    if (this.visible) {
      this.positionAtCursor();
    }
  }

  /** Clean up DOM elements */
  destroy() {
    this.el.remove();
    this.badgeEl.remove();
  }

  private positionAtCursor() {
    const buffer = this.terminal.buffer.active;
    const cursorX = buffer.cursorX;
    const cursorY = buffer.cursorY;

    // Get cell dimensions from the terminal's rendered size
    const termEl = this.container.querySelector(".xterm-screen") as HTMLElement;
    if (!termEl) return;

    const termRect = termEl.getBoundingClientRect();
    const containerRect = this.container.getBoundingClientRect();

    // Calculate cell dimensions from the terminal viewport
    const viewportRows = this.terminal.rows;
    const viewportCols = this.terminal.cols;
    const cellWidth = termRect.width / viewportCols;
    const cellHeight = termRect.height / viewportRows;

    const x = termRect.left - containerRect.left + cursorX * cellWidth;
    const y = termRect.top - containerRect.top + cursorY * cellHeight;

    this.el.style.left = `${x}px`;
    this.el.style.top = `${y}px`;
    this.el.style.height = `${cellHeight}px`;
    this.el.style.lineHeight = `${cellHeight}px`;
    this.el.style.fontSize = `${this.terminal.options.fontSize ?? 14}px`;

    // Position badge right after ghost text
    const ghostWidth = this.el.offsetWidth;
    this.badgeEl.style.left = `${x + ghostWidth + 8}px`;
    this.badgeEl.style.top = `${y}px`;
    this.badgeEl.style.height = `${cellHeight}px`;
    this.badgeEl.style.lineHeight = `${cellHeight}px`;
  }
}
