/**
 * Echo Line Tracker — reconstructs the current remote input line from
 * keystroke echo. Root-cause fix for shadow-buffer drift after line-editing
 * keys (arrows, Ctrl+W/U, history recall): the remote echoes the final line
 * content, so the tracker can rebuild what the user actually sees.
 * See docs/plan-suggestion-ghost-text-hardening.md Phase 5.
 */

import { stripAnsi } from "./ansi";

export class EchoLineTracker {
  private line = "";
  // Line content before the last \r/\n — the prompt line when the prompt is
  // echoed with a trailing CRLF (typed echo then lands on a fresh line)
  private lastLineValue = "";
  // Prompt prefix learned from trusted EOL states (line = prompt + buffer).
  // Used when the platform has no prompt patterns (linux-bash ships {}).
  private learnedPrompt = "";

  reset() {
    this.line = "";
    this.lastLineValue = "";
    this.learnedPrompt = "";
  }

  feed(text: string) {
    const clean = stripAnsi(text);
    for (const ch of clean) {
      if (ch === "\n") {
        if (this.line) this.lastLineValue = this.line;
        this.line = "";
      } else if (ch === "\r") {
        if (this.line) this.lastLineValue = this.line;
        this.line = "";
      } else if (ch === "\b") {
        // Backspace echo (`\b \b` runs erase characters naturally)
        this.line = this.line.slice(0, -1);
      } else if (ch >= " ") {
        this.line += ch;
      }
      // Other control bytes (BEL, etc.) ignored
    }
  }

  get currentLine(): string {
    return this.line;
  }

  /**
   * Learn the prompt prefix from a trusted state: cursor at EOL, simulated
   * buffer reliable, so the echoed line is exactly prompt + buffer. Only
   * learns when both parts are non-empty (an empty buffer can't separate
   * prompt from junk). Call on echo chunks while cursorMoved is false.
   */
  learnPrompt(expected: string) {
    if (!expected || !this.line) return;
    if (this.line.endsWith(expected) && this.line.length > expected.length) {
      this.learnedPrompt = this.line.substring(0, this.line.length - expected.length);
    }
  }

  /**
   * Current echoed command content, or null when the line can't be
   * reconciled (trust nothing).
   *
   * Prompt priority: detected prompt (Cisco/F5) → learned prompt (bash) →
   * consistency fallback (echo ends with the simulated buffer; also covers
   * backspacing past the prompt start where the prefix can't be stripped).
   */
  contentAfter(prompt: string, expected: string): string | null {
    const p = prompt || this.learnedPrompt;
    if (p) {
      if (this.line.startsWith(p)) {
        // Detected prompts are trimmed — leading whitespace is the prompt
        // separator, never part of the command.
        return this.line.substring(p.length).replace(/^\s+/, "");
      }
      // Prompt echoed with trailing CRLF: the prompt sat on its own line and
      // the typed echo accumulates on a fresh line without the prefix.
      if (this.lastLineValue.startsWith(p)) {
        return this.line.replace(/^\s+/, "");
      }
    }
    if (!expected) return "";
    return this.line.endsWith(expected) ? expected : null;
  }
}
