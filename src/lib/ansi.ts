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
 *
 * OSC payload is discarded as it arrives rather than buffered: payloads can be
 * large (OSC 52 clipboard data, OSC 1337 inline images) and re-scanning a
 * growing buffer on every chunk is quadratic on the UI thread.
 */
export class AnsiStripper {
  // Incomplete CSI (or lone ESC) from the previous chunk — a few bytes at most.
  private pending = "";
  // Inside an OSC sequence: the payload is dropped, only the terminators matter.
  private inOsc = false;
  // An ESC inside an OSC payload that may be the first half of ST (ESC \).
  private oscEsc = false;

  /** Strip one chunk, retaining any incomplete trailing escape sequence. */
  feed(chunk: string): string {
    const text = this.pending + chunk;
    this.pending = "";
    let out = "";
    let i = 0;

    while (i < text.length) {
      if (this.inOsc) {
        i = this.skipOscPayload(text, i);
        continue;
      }

      const esc = text.indexOf("\x1b", i);
      if (esc === -1) {
        out += text.slice(i);
        break;
      }
      out += text.slice(i, esc);
      const next = text[esc + 1];

      if (next === undefined) {
        // Lone trailing ESC — could be the start of a split sequence.
        this.pending = "\x1b";
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
        this.inOsc = true;
        i = esc + 2;
        continue;
      }

      // Lone ESC not starting a supported sequence (e.g. ESC c) — keep literal.
      out += text[esc];
      i = esc + 1;
    }

    return out;
  }

  /**
   * Discard OSC payload from `i`, returning the index just past the terminator
   * (or the end of the chunk when the sequence is still open). Nothing of the
   * payload is retained.
   */
  private skipOscPayload(text: string, i: number): number {
    if (this.oscEsc) {
      this.oscEsc = false;
      if (text[i] === "\\") {
        this.inOsc = false; // ST split between ESC and backslash
        return i + 1;
      }
      // The ESC was payload content — keep scanning.
    }
    while (i < text.length) {
      const ch = text[i];
      if (ch === "\x07") {
        this.inOsc = false;
        return i + 1;
      }
      if (ch === "\x1b") {
        if (i + 1 >= text.length) {
          this.oscEsc = true; // ST may complete in the next chunk
          return text.length;
        }
        if (text[i + 1] === "\\") {
          this.inOsc = false;
          return i + 2;
        }
      }
      i++;
    }
    return i;
  }

  /** Drop any pending partial sequence (stream ended or new session). */
  reset(): void {
    this.pending = "";
    this.inOsc = false;
    this.oscEsc = false;
  }
}
