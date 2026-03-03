/**
 * Shadow Buffer — mirrors user input for suggestion matching
 * Does NOT control terminal echo. Observes keystrokes only.
 */

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

  /** Get current buffer contents */
  get content(): string {
    return this.buffer;
  }
}
