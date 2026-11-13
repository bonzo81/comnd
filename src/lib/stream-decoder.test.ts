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

  it("reconstructs a 4-byte codepoint fed one byte at a time", () => {
    // Guards the restricted second-byte ranges: a valid F0/F4 prefix must
    // still be held, not rejected.
    const bytes = new TextEncoder().encode("😀");
    const d = new StreamingTextDecoder();

    let text = "";
    const raw: number[] = [];
    for (const byte of bytes) {
      const out = d.decode(Uint8Array.of(byte));
      text += out.text;
      raw.push(...out.bytes);
    }

    expect(text).toBe("😀");
    expect(raw).toEqual([...bytes]);
  });

  it("returns text and bytes that describe the same output for invalid bytes", () => {
    // An invalid lead or continuation is decoded to U+FFFD straight away, so it
    // must not be held: `text` would otherwise contain characters whose bytes
    // are absent from `bytes`, and a write-path flip between chunks would show
    // them a second time.
    const cases = [
      [0xff], // never a lead byte
      [0x80], // stray continuation
      [0xe0, 0x80], // overlong
      [0xed, 0xa0], // surrogate
      [0xf4, 0x90], // above U+10FFFF
    ];

    for (const raw of cases) {
      const out = new StreamingTextDecoder().decode(Uint8Array.from(raw));
      expect(out.text).toContain("\ufffd");
      expect(new TextDecoder().decode(out.bytes)).toBe(out.text);
    }
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
