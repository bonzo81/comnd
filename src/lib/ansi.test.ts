import { describe, expect, it } from "vitest";
import { AnsiStripper, stripAnsi } from "./ansi";

describe("stripAnsi — one-shot", () => {
  it("strips complete CSI and OSC sequences", () => {
    expect(stripAnsi("\x1b[32mRouter#\x1b[0m")).toBe("Router#");
    expect(stripAnsi("\x1b]0;title\x07text")).toBe("text");
  });
});

describe("AnsiStripper — chunk boundaries", () => {
  it("holds a CSI sequence split across chunks until it completes", () => {
    const s = new AnsiStripper();
    expect(s.feed("\x1b[3")).toBe("");
    expect(s.feed("2mRouter#")).toBe("Router#");
  });

  it("holds a split OSC sequence without leaking its payload", () => {
    const s = new AnsiStripper();
    expect(s.feed("\x1b]0;window tit")).toBe("");
    expect(s.feed("le\x07Router#")).toBe("Router#");
  });

  it("holds an ST terminator split between ESC and backslash", () => {
    const s = new AnsiStripper();
    expect(s.feed("\x1b]8;;https://example.test/help\x1b")).toBe("");
    expect(s.feed("\\link text")).toBe("link text");
  });

  it("reset discards a pending partial sequence", () => {
    const s = new AnsiStripper();
    s.feed("\x1b[32");
    s.reset();
    expect(s.feed("Router#")).toBe("Router#");
  });
});
