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

/** Length of the sequence `lead` introduces, or 0 when it cannot start one. */
function sequenceLength(lead: number): number {
  if (lead >= 0xc2 && lead <= 0xdf) return 2;
  if (lead >= 0xe0 && lead <= 0xef) return 3;
  if (lead >= 0xf0 && lead <= 0xf4) return 4;
  return 0;
}

/**
 * Whether `byte` is an allowed continuation at `index` (1-based) of a sequence
 * introduced by `lead`. The restricted second-byte ranges are what keeps
 * overlong forms, surrogates and values above U+10FFFF out.
 */
function isContinuation(lead: number, index: number, byte: number): boolean {
  if (index > 1) return (byte & 0xc0) === 0x80;
  switch (lead) {
    case 0xe0:
      return byte >= 0xa0 && byte <= 0xbf;
    case 0xed:
      return byte >= 0x80 && byte <= 0x9f;
    case 0xf0:
      return byte >= 0x90 && byte <= 0xbf;
    case 0xf4:
      return byte >= 0x80 && byte <= 0x8f;
    default:
      return (byte & 0xc0) === 0x80;
  }
}

/**
 * Length of a trailing UTF-8 sequence that is valid so far but is still
 * missing continuation bytes (0 when the chunk ends on a character boundary).
 *
 * Only a prefix `TextDecoder` itself would be withholding counts. An invalid
 * lead (`0xff`, a stray continuation) or an invalid continuation (`0xe0 0x80`,
 * `0xf4 0x90`) is already decoded as U+FFFD, so it must not be held: holding
 * it would put characters in `text` whose bytes are missing from `bytes`.
 */
function incompleteTailLength(bytes: Uint8Array): number {
  const maxBack = Math.min(3, bytes.length);
  let back = 1;
  // Walk back over continuation bytes to the lead byte.
  while (back <= maxBack && (bytes[bytes.length - back] & 0xc0) === 0x80) back++;
  if (back > bytes.length) return 0;
  const start = bytes.length - back;
  const lead = bytes[start];
  if (sequenceLength(lead) <= back) return 0;
  for (let index = 1; index < back; index++) {
    if (!isContinuation(lead, index, bytes[start + index])) return 0;
  }
  return back;
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
    const tail = incompleteTailLength(all);
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
