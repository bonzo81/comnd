import { describe, it, expect } from "vitest";
import { EchoLineTracker } from "../src/lib/echo-line";

describe("EchoLineTracker", () => {
  it("plain echo accumulates typed characters", () => {
    const t = new EchoLineTracker();
    t.feed("Router# ");
    t.feed("sh");
    t.feed("ow run");
    expect(t.currentLine).toBe("Router# show run");
    expect(t.contentAfter("Router#")).toBe("show run");
  });

  it("backspace echo (\\b \\b) deletes characters", () => {
    const t = new EchoLineTracker();
    t.feed("Router# show rn");
    t.feed("\b \b");
    t.feed("u");
    expect(t.currentLine).toBe("Router# show ru");
  });

  it("\\r repaint replaces the line (history recall)", () => {
    const t = new EchoLineTracker();
    t.feed("Router# sh");
    t.feed("\rRouter# show running-config");
    expect(t.currentLine).toBe("Router# show running-config");
    expect(t.contentAfter("Router#")).toBe("show running-config");
  });

  it("ANSI-wrapped echo is stripped", () => {
    const t = new EchoLineTracker();
    t.feed("\x1b[32mRouter#\x1b[0m \x1b[1msho\x1b[0m");
    expect(t.currentLine).toBe("Router# sho");
  });

  it("Ctrl+W kill echo (\\b \\b runs) leaves final content", () => {
    const t = new EchoLineTracker();
    t.feed("Router# show run");
    // erase "run" then type "start"
    t.feed("\b \b\b \b\b \b");
    t.feed("start");
    expect(t.currentLine).toBe("Router# show start");
  });

  it("newline resets the line", () => {
    const t = new EchoLineTracker();
    t.feed("Router# show run\nsome output");
    expect(t.currentLine).toBe("some output");
  });

  it("prompt echoed with trailing CRLF: typed echo lands on fresh line", () => {
    const t = new EchoLineTracker();
    t.feed("Router# \r\n");
    t.feed("sh");
    t.feed("ow run");
    expect(t.contentAfter("Router#")).toBe("show run");
  });

  it("backspace echo still works after CRLF prompt", () => {
    const t = new EchoLineTracker();
    t.feed("Router# \r\n");
    t.feed("show rn");
    t.feed("\b \b");
    t.feed("u");
    expect(t.contentAfter("Router#")).toBe("show ru");
  });

  it("learned prompt: strip works after learning from trusted EOL state", () => {
    const t = new EchoLineTracker();
    t.feed("andy@host:~$ ");
    t.feed("sudo apt update");
    t.learnPrompt("sudo apt update");
    // cursor mid-line: backspaces delete before the cursor
    t.feed("\b\b\b");
    expect(t.contentAfter("", "sudo apt upd")).toBe("sudo apt upd");
  });

  it("learned prompt: full clear reconciles to empty", () => {
    const t = new EchoLineTracker();
    t.feed("andy@host:~$ ");
    t.feed("sudo");
    t.learnPrompt("sudo");
    t.feed("\b \b\b \b\b \b\b \b");
    expect(t.contentAfter("", "")).toBe("");
  });

  it("learnPrompt ignores empty expected and non-matching lines", () => {
    const t = new EchoLineTracker();
    t.feed("andy@host:~$ sud");
    t.learnPrompt("");
    t.learnPrompt("other");
    expect(t.contentAfter("", "sud")).toBe("sud");
  });

  it("contentAfter returns null when line does not start with prompt", () => {
    const t = new EchoLineTracker();
    t.feed("weird");
    expect(t.contentAfter("Router#", "abc")).toBeNull();
    // empty expected is trusted (backspacing past prompt start can't strip)
    expect(t.contentAfter("Router#", "")).toBe("");
  });

  it("no prompt patterns: echo consistent with buffer reconciles (EOL typing)", () => {
    const t = new EchoLineTracker();
    t.feed("bash-5.1$ sh");
    expect(t.contentAfter("", "sh")).toBe("sh");
  });

  it("no prompt patterns: cleared line reconciles to empty", () => {
    const t = new EchoLineTracker();
    t.feed("bash-5.1$ sh");
    t.feed("\b \b\b \b");
    expect(t.contentAfter("", "")).toBe("");
  });

  it("no prompt patterns: mid-line insert falls back to buffer (known limitation)", () => {
    const t = new EchoLineTracker();
    t.feed("bash-5.1$ sh");
    // Insert at cursor start can't be detected without prompt patterns —
    // endsWith consistency passes and the simulated buffer is kept.
    t.feed("o");
    expect(t.contentAfter("", "sho")).toBe("sho");
  });

  it("empty line reconciles to empty content", () => {
    const t = new EchoLineTracker();
    expect(t.contentAfter("Router#", "")).toBe("");
  });
});
