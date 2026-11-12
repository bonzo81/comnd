import { describe, expect, it } from "vitest";
import { StreamingTextDecoder } from "./stream-decoder";

describe("StreamingTextDecoder", () => {
  it("reconstructs a UTF-8 codepoint split across two chunks", () => {
    const bytes = new TextEncoder().encode("é");
    const d = new StreamingTextDecoder();

    const first = d.decode(bytes.slice(0, 1));
    const second = d.decode(bytes.slice(1));

    expect(first + second).toBe("é");
    expect(first + second).not.toContain("\ufffd");
  });

  it("reconstructs a multibyte sample fed one byte at a time", () => {
    const text = "Router# café — 日本語";
    const bytes = new TextEncoder().encode(text);
    const d = new StreamingTextDecoder();

    let out = "";
    for (const byte of bytes) out += d.decode(Uint8Array.of(byte));

    expect(out).toBe(text);
  });

  it("reset discards an incomplete trailing sequence", () => {
    const bytes = new TextEncoder().encode("é");
    const d = new StreamingTextDecoder();
    d.decode(bytes.slice(0, 1));

    d.reset();

    expect(d.decode(new TextEncoder().encode("ok"))).toBe("ok");
  });
});
