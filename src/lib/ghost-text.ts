/**
 * Ghost Text — inline suggestion overlay for xterm.js
 * Renders semi-transparent completion text at the cursor position.
 *
 * Phase 3: token-aware payload. `literal`/`choice` are completable (Tab
 * accepts); `variable` is a placeholder hint (Tab passes through). Legacy
 * `text` (name remainder) stays completable.
 * See docs/plans/plan-kb-token-engine.md § 3.1.
 */

import { Terminal, IDisposable } from "@xterm/xterm";

export type GhostPayload =
  | { kind: "text"; text: string }                              // legacy: name remainder
  | { kind: "literal"; text: string }                           // completing a lit word
  | { kind: "choice"; options: string[]; pick: string }         // choice token
  | { kind: "variable"; placeholder: string; hint?: string };  // var token

/**
 * How long a pending repaint waits for the keystroke's echo before painting
 * against whatever the screen shows. Comfortably above a WAN round trip and
 * below the point where the prediction is worse than no prediction; a host
 * that echoes very slowly, or not at all (stty -echo, a TUI), still gets a
 * ghost rather than losing the suggestion altogether.
 */
const ECHO_ANCHOR_WAIT_MS = 500;

export class GhostText {
  private terminal: Terminal;
  private container: HTMLElement;
  private el: HTMLSpanElement;
  private badgeEl: HTMLSpanElement;
  private currentPayload: GhostPayload | null = null;
  private currentRemainder = "";
  private visible = false;
  private cursorHidden = false;
  private writeParsedDisposable: IDisposable;
  private pendingPaint: {
    payload: GhostPayload;
    /** Rendered text, carried separately so word acceptance can advance it. */
    text: string;
    extraMatchCount: number;
    input: string;
  } | null = null;
  private echoWaitTimer: number | null = null;

  constructor(terminal: Terminal, container: HTMLElement) {
    this.terminal = terminal;
    this.container = container;

    this.el = document.createElement("span");
    this.el.className = "ghost-text";
    this.container.appendChild(this.el);

    this.badgeEl = document.createElement("span");
    this.badgeEl.className = "match-count-badge";
    this.container.appendChild(this.badgeEl);

    // The remote echoes the keystroke that triggered this ghost, and that echo
    // can land after the ghost is positioned. A pending repaint waits for it;
    // an already-painted ghost follows the cursor once the parse moves it.
    this.writeParsedDisposable = terminal.onWriteParsed(() => {
      const pending = this.pendingPaint;
      if (pending) {
        if (this.screenShowsInput(pending.input)) {
          this.paint(pending.payload, pending.text, pending.extraMatchCount);
        }
        // Somewhere short of the full input: the echo is still arriving, and
        // the glyphs on screen belong to the anchor they were painted at.
        // Moving them now would draw them past the part of the input that has
        // landed, reading as the word twice over. Wait for the paint instead.
        return;
      }
      this.reposition();
    });
  }

  /** Show ghost text with the command remainder after user's typed prefix (legacy) */
  show(remainder: string, extraMatchCount: number) {
    this.showPayload({ kind: "text", text: remainder }, extraMatchCount);
  }

  /**
   * Show ghost text from a token-aware payload. `input` is the shadow buffer
   * the payload was derived from; when it is given, the paint waits for the
   * echo of the keystroke that produced it.
   */
  showPayload(payload: GhostPayload, extraMatchCount: number, input?: string) {
    const text = ghostPayloadText(payload);
    if (!text) {
      this.hide();
      return;
    }
    if (input && !this.screenShowsInput(input)) {
      // The screen has not caught up with the typed input yet, so this
      // prediction has no correct cell to sit on: painting it now puts the
      // glyphs in the cells the echo is about to write, and the parse then
      // steps the whole overlay sideways — a visible blink on every keystroke
      // whose echo is slower than the query debounce. Keep the glyphs already
      // on screen, which are the tail of the same prediction and so cover the
      // same cells, and paint on the parse that catches up. The logical
      // remainder advances now, so Tab sends what that parse will show.
      this.currentPayload = payload;
      this.currentRemainder = text;
      this.deferPaint(payload, text, extraMatchCount, input);
      return;
    }
    this.paint(payload, text, extraMatchCount);
  }

  private paint(payload: GhostPayload, text: string, extraMatchCount: number) {
    this.clearPending();
    const appearing = !this.visible;
    this.currentPayload = payload;
    this.currentRemainder = text;
    this.el.textContent = text;
    this.el.classList.remove("ghost-text--variable", "ghost-text--choice", "ghost-text--literal");
    if (payload.kind === "variable") this.el.classList.add("ghost-text--variable");
    else if (payload.kind === "choice") this.el.classList.add("ghost-text--choice");
    else if (payload.kind === "literal") this.el.classList.add("ghost-text--literal");
    this.visible = true;
    this.el.style.display = "inline";

    // Settle on appearance only. showPayload runs on every keystroke while a
    // suggestion is showing, so an unguarded class would replay the fade under
    // each character; hide() clears it so the next real appearance can animate.
    if (appearing) this.el.classList.add("ghost-text--enter");

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
      const badgeAppearing = this.badgeEl.style.display !== "inline";
      this.badgeEl.textContent = `(+${extraMatchCount})`;
      this.badgeEl.style.display = "inline";
      if (badgeAppearing) this.badgeEl.classList.add("match-count-badge--enter");
    } else {
      this.badgeEl.style.display = "none";
    }
  }

  /** Hide ghost text */
  hide() {
    this.clearPending();
    this.visible = false;
    this.currentPayload = null;
    this.currentRemainder = "";
    this.el.style.display = "none";
    this.el.classList.remove(
      "ghost-text--variable",
      "ghost-text--choice",
      "ghost-text--literal",
      "ghost-text--enter",
    );
    this.badgeEl.style.display = "none";
    this.badgeEl.classList.remove("match-count-badge--enter");
    if (this.cursorHidden) {
      this.terminal.write("\x1b[?25h");
      this.cursorHidden = false;
    }
  }

  /**
   * Does the screen text left of the buffer cursor already end with the typed
   * input? If not, the echo has not been parsed yet and the cursor is stale.
   * A missing line (scrollback edge, no buffer) counts as caught up, so the
   * ghost is never withheld for want of a line to check.
   *
   * The cursor row is absolute in the buffer, so it needs `baseY`: without it
   * the check reads a scrollback row once the screen has scrolled. Rows above
   * a soft wrap are joined, or a command longer than the terminal width could
   * never match. The cursor bound is applied in cells rather than string
   * characters, or a wide-character prompt would shift it.
   */
  private screenShowsInput(input: string): boolean {
    const buffer = this.terminal.buffer.active;
    const cols = this.terminal.cols || buffer.cursorX || 1;
    // The input cannot span more rows than its own length needs.
    const maxRows = Math.ceil(input.length / cols) + 1;
    let text = "";
    let row = buffer.baseY + buffer.cursorY;
    for (let i = 0; i < maxRows; i++) {
      const line = buffer.getLine(row);
      if (!line) return true;
      text =
        (i === 0
          ? line.translateToString(false, 0, buffer.cursorX)
          : line.translateToString(false)) + text;
      if (!line.isWrapped || row === 0) break;
      row--;
    }
    return text.endsWith(input);
  }

  private deferPaint(
    payload: GhostPayload,
    text: string,
    extraMatchCount: number,
    input: string,
  ) {
    this.pendingPaint = { payload, text, extraMatchCount, input };
    // The deadline belongs to the deferral, not to the prediction: a host that
    // never echoes would otherwise restart the clock on every keystroke and
    // hold the first ghost back for as long as the user keeps typing.
    if (this.echoWaitTimer !== null) return;
    this.echoWaitTimer = setTimeout(() => {
      this.echoWaitTimer = null;
      const pending = this.pendingPaint;
      if (!pending) return;
      // No echo within the window: a host that does not echo, or one slower
      // than the prediction is useful for. Paint what we have rather than
      // losing the suggestion entirely.
      this.paint(pending.payload, pending.text, pending.extraMatchCount);
    }, ECHO_ANCHOR_WAIT_MS) as unknown as number;
  }

  private clearPending() {
    this.pendingPaint = null;
    if (this.echoWaitTimer !== null) {
      clearTimeout(this.echoWaitTimer);
      this.echoWaitTimer = null;
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
    const pending = this.pendingPaint;
    if (pending) {
      // The word is on its way to the remote and into the shadow input, so a
      // paint that lands afterwards must not restore the fragment Tab just
      // sent. Advance the pending state exactly as the caller advances the
      // shadow buffer: the accepted word leaves the remainder and joins the
      // input whose echo it is waiting for.
      pending.text = this.currentRemainder;
      pending.input += m[0];
      if (!pending.text) this.clearPending();
    }
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
    this.clearPending();
    this.writeParsedDisposable.dispose();
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