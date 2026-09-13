/**
 * Ghost Text — inline suggestion overlay for xterm.js
 * Renders semi-transparent completion text at the cursor position.
 *
 * Phase 3: token-aware payload. `literal`/`choice` are completable (Tab
 * accepts); `variable` is a placeholder hint (Tab passes through). Legacy
 * `text` (name remainder) stays completable.
 * See docs/plans/plan-kb-token-engine.md § 3.1.
 */

import { Terminal } from "@xterm/xterm";

export type GhostPayload =
  | { kind: "text"; text: string }                              // legacy: name remainder
  | { kind: "literal"; text: string }                           // completing a lit word
  | { kind: "choice"; options: string[]; pick: string }         // choice token
  | { kind: "variable"; placeholder: string; hint?: string };  // var token

export class GhostText {
  private terminal: Terminal;
  private container: HTMLElement;
  private el: HTMLSpanElement;
  private badgeEl: HTMLSpanElement;
  private currentPayload: GhostPayload | null = null;
  private currentRemainder = "";
  private visible = false;
  private cursorHidden = false;

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

  /** Show ghost text with the command remainder after user's typed prefix (legacy) */
  show(remainder: string, extraMatchCount: number) {
    this.showPayload({ kind: "text", text: remainder }, extraMatchCount);
  }

  /** Show ghost text from a token-aware payload. */
  showPayload(payload: GhostPayload, extraMatchCount: number) {
    const text = ghostPayloadText(payload);
    if (!text) {
      this.hide();
      return;
    }
    this.currentPayload = payload;
    this.currentRemainder = text;
    this.el.textContent = text;
    this.el.classList.remove("ghost-text--variable", "ghost-text--choice", "ghost-text--literal");
    if (payload.kind === "variable") this.el.classList.add("ghost-text--variable");
    else if (payload.kind === "choice") this.el.classList.add("ghost-text--choice");
    else if (payload.kind === "literal") this.el.classList.add("ghost-text--literal");
    this.visible = true;
    this.el.style.display = "inline";

    // Position at cursor
    this.positionAtCursor();

    // Hide the blinking block cursor — it would sit as a gap between typed
    // text and the ghost (xterm renders it above any DOM overlay). DECTCEM.
    // ponytail: writes an escape code to the terminal buffer; xterm may echo
    // it into scrollback if the app ever dumps the screen. Replace with a
    // cursor-layer DOM overlay if that ever matters.
    if (!this.cursorHidden) {
      this.terminal.write("\x1b[?25l");
      this.cursorHidden = true;
    }

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
    this.currentPayload = null;
    this.currentRemainder = "";
    this.el.style.display = "none";
    this.el.classList.remove("ghost-text--variable", "ghost-text--choice", "ghost-text--literal");
    this.badgeEl.style.display = "none";
    if (this.cursorHidden) {
      this.terminal.write("\x1b[?25h");
      this.cursorHidden = false;
    }
  }

  /** Check if ghost text is currently visible */
  isShowing(): boolean {
    return this.visible;
  }

  /**
   * Get the text to send on Tab accept. Returns null for variable payloads —
   * Tab does not accept a variable placeholder (it's a hint, not completable
   * text). Per AGENTS.md rule 5: Tab only intercepts when there is real
   * completable text.
   */
  getCurrentRemainder(): string | null {
    if (!this.visible || !this.currentPayload) return null;
    if (this.currentPayload.kind === "variable") return null;
    return this.currentRemainder;
  }

  /** Remote showed the cursor (\x1b[?25h) — sync bookkeeping so hide() stays correct */
  notifyCursorShown() {
    this.cursorHidden = false;
  }

  /**
   * Accept the next whitespace-delimited word of the remainder (fish
   * "accept next word", Alt+→). Includes one trailing space when more
   * remainder follows. Returns null for variable payloads / empty remainder;
   * remainder is advanced so the next call accepts the following word.
   */
  acceptNextWord(): string | null {
    if (!this.visible || !this.currentPayload || this.currentPayload.kind === "variable") return null;
    const m = this.currentRemainder.match(/^\S+\s*/);
    if (!m) return null;
    this.currentRemainder = this.currentRemainder.substring(m[0].length);
    return m[0];
  }

  /** Current payload kind (for Tab-behaviour branching in callers). */
  getPayloadKind(): GhostPayload["kind"] | null {
    return this.visible && this.currentPayload ? this.currentPayload.kind : null;
  }

  /** Reposition ghost text (called on resize/scroll) */
  reposition() {
    if (this.visible) {
      this.positionAtCursor();
    }
  }

  /** Clean up DOM elements */
  destroy() {
    if (this.cursorHidden) this.terminal.write("\x1b[?25h");
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

/** Render text for a payload (what the user would see / accept). */
function ghostPayloadText(p: GhostPayload): string {
  switch (p.kind) {
    case "text":
    case "literal":
      return p.text;
    case "choice":
      return p.pick;
    case "variable":
      return `<${p.placeholder}>`;
  }
}

/**
 * Text to send to the remote when accepting a ghost payload. Returns null
 * for variable payloads — they are hints, not completable text. For choice
 * and literal, sends the displayed text.
 */
export function ghostPayloadAcceptText(p: GhostPayload): string | null {
  switch (p.kind) {
    case "text":
    case "literal":
      return p.text || null;
    case "choice":
      return p.pick || null;
    case "variable":
      return null;
  }
}