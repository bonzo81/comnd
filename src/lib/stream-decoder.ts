/**
 * Streaming UTF-8 decoder for SSH output.
 *
 * `ssh-output` events carry arbitrary byte boundaries (the backend
 * base64-encodes whatever `russh` delivers), so a multibyte codepoint can be
 * split across two events. Decoding each event with a fresh `TextDecoder`
 * turns both halves into U+FFFD; this wrapper keeps one decoder per session
 * and uses `{ stream: true }` to hold incomplete trailing bytes until the
 * next chunk.
 *
 * The held bytes are also kept out of {@link DecodedChunk.bytes}, because
 * xterm receives raw bytes whenever output highlighting is off. A raw write
 * carrying only the continuation half of a character displays a replacement
 * character, so both write paths are handed complete characters only.
 */

/** One decoded chunk: the text, and the bytes that text was decoded from. */
export interface DecodedChunk {
  text: string;
  /**
   * The bytes behind `text` — complete characters only. An incomplete trailing
   * codepoint is held back and prepended to the next chunk's bytes.
   */
  bytes: Uint8Array;
}

const EMPTY = new Uint8Array(0);

/**
 * Length of a trailing UTF-8 sequence that is valid so far but is still
 * missing continuation bytes (0 when the chunk ends on a character boundary).
 * Mirrors what `TextDecoder` withholds, so the two stay in step.
 */
function incompleteTailLength(bytes: Uint8Array): number {
  for (let back = 1; back <= Math.min(3, bytes.length); back++) {
    const b = bytes[bytes.length - back];
    // Continuation byte — the lead byte is further back.
    if ((b & 0xc0) === 0x80) continue;
    const needed = b >= 0xf0 && b <= 0xf4 ? 4 : b >= 0xe0 ? 3 : b >= 0xc2 ? 2 : 0;
    return needed > back ? back : 0;
  }
  return 0;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export class StreamingTextDecoder {
  private decoder = new TextDecoder();
  private held: Uint8Array = EMPTY;

  /** Decode one chunk, retaining bytes of an incomplete trailing codepoint. */
  decode(bytes: Uint8Array): DecodedChunk {
    // The decoder buffers a partial codepoint itself, so it only ever sees the
    // new bytes; `held` exists solely to keep those bytes out of `bytes`.
    const text = this.decoder.decode(bytes, { stream: true });
    const all = this.held.length === 0 ? bytes : concat(this.held, bytes);
    const tail = all.length === 0 ? 0 : incompleteTailLength(all);
    this.held = tail === 0 ? EMPTY : all.slice(all.length - tail);
    return {
      text,
      bytes: tail === 0 ? all : all.subarray(0, all.length - tail),
    };
  }

  /** Drop buffered bytes (session teardown or a new session). */
  reset(): void {
    this.decoder = new TextDecoder();
    this.held = EMPTY;
  }
}
