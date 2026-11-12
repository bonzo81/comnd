/**
 * Strip ANSI escape sequences from text.
 *
 * Handles:
 * - **CSI** (Control Sequence Introducer): `ESC [` … letter
 *   e.g. `"\x1b[32mHello\x1b[0m"` → `"Hello"`
 * - **OSC** (Operating System Command): `ESC ]` … `BEL` or `ST`
 *   e.g. `"\x1b]0;title\x07text"` → `"text"`
 *
 * Not handled (documented limitation):
 * - DCS, SOS, PM, APC — rare in terminal output
 * - Single-character escape sequences (e.g. `ESC c`)
 *
 * This function focuses on ANSI stripping only and does NOT normalize
 * control characters (e.g. `\r\n`, null bytes).
 */
export function stripAnsi(text: string): string {
  // Strip OSC sequences first — they can contain embedded CSI-like bytes
  return (
    text
      // OSC: ESC ] … terminated by BEL (0x07) or ST (ESC \)
      .replace(/\x1b\].*?(?:\x07|\x1b\\)/g, "")
      // CSI: ESC [ params… final byte (? is a valid param byte, e.g. ?2004h)
      .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
  );
}

function isCsiParam(ch: string): boolean {
  return (ch >= "0" && ch <= "9") || ch === ";" || ch === "?";
}

function isAsciiLetter(ch: string): boolean {
  return (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z");
}

/**
 * Stateful variant of {@link stripAnsi} for streams whose chunks can split an
 * escape sequence (SSH output arrives in arbitrary event-sized pieces).
 *
 * An incomplete trailing CSI or OSC sequence is held until the next chunk;
 * everything else is stripped exactly as {@link stripAnsi} strips it. Call
 * {@link reset} when the stream ends or a new session starts.
 */
export class AnsiStripper {
  private pending = "";

  /** Strip one chunk, retaining any incomplete trailing escape sequence. */
  feed(chunk: string): string {
    const text = this.pending + chunk;
    this.pending = "";
    let out = "";
    let i = 0;

    while (i < text.length) {
      const esc = text.indexOf("\x1b", i);
      if (esc === -1) {
        out += text.slice(i);
        break;
      }
      out += text.slice(i, esc);
      const next = text[esc + 1];

      if (next === undefined) {
        // Lone trailing ESC — could be the start of a split sequence.
        this.pending = text.slice(esc);
        break;
      }

      if (next === "[") {
        let j = esc + 2;
        while (j < text.length && isCsiParam(text[j])) j++;
        if (j >= text.length) {
          this.pending = text.slice(esc);
          break;
        }
        if (isAsciiLetter(text[j])) {
          i = j + 1; // complete CSI — stripped
          continue;
        }
        // Not a recognised CSI (documented limitation) — keep it literally.
        out += text[esc];
        i = esc + 1;
        continue;
      }

      if (next === "]") {
        let j = esc + 2;
        let end = -1;
        while (j < text.length) {
          if (text[j] === "\x07") {
            end = j + 1;
            break;
          }
          if (text[j] === "\x1b") {
            // ST is ESC \ — hold the sequence if the backslash is still to come.
            if (j + 1 >= text.length) break;
            if (text[j + 1] === "\\") {
              end = j + 2;
              break;
            }
          }
          j++;
        }
        if (end === -1) {
          this.pending = text.slice(esc);
          break;
        }
        i = end; // complete OSC — stripped, payload included
        continue;
      }

      // Lone ESC not starting a supported sequence (e.g. ESC c) — keep literal.
      out += text[esc];
      i = esc + 1;
    }

    return out;
  }

  /** Drop any pending partial sequence (stream ended or new session). */
  reset(): void {
    this.pending = "";
  }
}
