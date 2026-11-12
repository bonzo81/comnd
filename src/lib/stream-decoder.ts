/**
 * Streaming UTF-8 decoder for SSH output.
 *
 * `ssh-output` events carry arbitrary byte boundaries (the backend
 * base64-encodes whatever `russh` delivers), so a multibyte codepoint can be
 * split across two events. Decoding each event with a fresh `TextDecoder`
 * turns both halves into U+FFFD; this wrapper keeps one decoder per session
 * and uses `{ stream: true }` to hold incomplete trailing bytes until the
 * next chunk.
 */
export class StreamingTextDecoder {
  private decoder = new TextDecoder();

  /** Decode one chunk, retaining bytes of an incomplete trailing codepoint. */
  decode(bytes: Uint8Array): string {
    return this.decoder.decode(bytes, { stream: true });
  }

  /** Drop buffered bytes (session teardown or a new session). */
  reset(): void {
    this.decoder = new TextDecoder();
  }
}
