/**
 * Shadow Buffer — mirrors user input for suggestion matching
 * Does NOT control terminal echo. Observes keystrokes only.
 */

/** Suggestion queries are suppressed above this length (pastes, floods). */
export const MAX_SHADOW_LEN = 128;

export class ShadowBuffer {
  private buffer = "";
  private onUpdate: (content: string) => void;

  constructor(onUpdate: (content: string) => void) {
    this.onUpdate = onUpdate;
  }

  /** Add a printable character */
  append(char: string) {
    this.buffer += char;
    this.onUpdate(this.buffer);
  }

  /** Handle backspace */
  backspace() {
    if (this.buffer.length > 0) {
      this.buffer = this.buffer.slice(0, -1);
      this.onUpdate(this.buffer);
    }
  }

  /** Reset on Enter or new prompt detected */
  reset() {
    this.buffer = "";
    this.onUpdate(this.buffer);
  }

  /** Set buffer from external source (echo re-sync); fires only on change */
  setContent(text: string) {
    if (this.buffer === text) return;
    this.buffer = text;
    this.onUpdate(this.buffer);
  }

  /** Append every printable char of a string (test convenience). */
  appendAll(text: string) {
    for (const ch of text) {
      if (ch.charCodeAt(0) >= 32) this.append(ch);
    }
  }

  /** Get current buffer contents */
  get content(): string {
    return this.buffer;
  }
}
