import { describe, expect, it } from "vitest";
import { StreamingTextDecoder } from "./stream-decoder";

describe("StreamingTextDecoder", () => {
  it("reconstructs a UTF-8 codepoint split across two chunks", () => {
    const bytes = new TextEncoder().encode("é");
    const d = new StreamingTextDecoder();

    const first = d.decode(bytes.slice(0, 1));
    const second = d.decode(bytes.slice(1));

    expect(first.text + second.text).toBe("é");
    expect(first.text + second.text).not.toContain("\ufffd");
  });

  it("reconstructs a multibyte sample fed one byte at a time", () => {
    const text = "Router# café — 日本語";
    const bytes = new TextEncoder().encode(text);
    const d = new StreamingTextDecoder();

    let out = "";
    for (const byte of bytes) out += d.decode(Uint8Array.of(byte)).text;

    expect(out).toBe(text);
  });

  it("holds a split codepoint's bytes out of both write paths until it completes", () => {
    // The highlighting path writes `text` and the raw path writes `bytes`; a
    // branch switch between chunks must not hand either one half a character.
    const bytes = new TextEncoder().encode("\né");
    const d = new StreamingTextDecoder();

    const first = d.decode(bytes.slice(0, 2));
    const second = d.decode(bytes.slice(2));

    expect(first.text).toBe("\n");
    expect([...first.bytes]).toEqual([0x0a]);
    expect(second.text).toBe("é");
    expect([...second.bytes]).toEqual([0xc3, 0xa9]);
  });

  it("reset discards an incomplete trailing sequence", () => {
    const bytes = new TextEncoder().encode("é");
    const d = new StreamingTextDecoder();
    d.decode(bytes.slice(0, 1));

    d.reset();

    const next = d.decode(new TextEncoder().encode("ok"));
    expect(next.text).toBe("ok");
    expect(new TextDecoder().decode(next.bytes)).toBe("ok");
  });
});
