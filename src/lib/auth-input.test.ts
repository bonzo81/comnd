/**
 * Unit tests for AuthInputCollector — keyboard-interactive answer assembly
 * during an SSH connect (issue #12).
 */

import { describe, expect, it } from "vitest";
import { AuthInputCollector } from "./auth-input";

const PW = [{ prompt: "Password: ", echo: false }];

describe("AuthInputCollector", () => {
  it("collects characters and submits one answer on Enter", () => {
    const c = new AuthInputCollector();
    c.setRound(PW);
    expect(c.feed("sec")).toEqual({ kind: "none" });
    expect(c.feed("ret\r")).toEqual({ kind: "submit", responses: ["secret"] });
  });

  it("backspace edits the current line", () => {
    const c = new AuthInputCollector();
    c.setRound(PW);
    c.feed("secr");
    c.feed("et"); // "secret"
    expect(c.feed("\x7f")).toEqual({ kind: "none" }); // "secre"
    expect(c.feed("t\r")).toEqual({ kind: "submit", responses: ["secret"] });
  });

  it("answers multi-prompt rounds one Enter at a time", () => {
    const c = new AuthInputCollector();
    c.setRound([
      { prompt: "New password: ", echo: false },
      { prompt: "Retype new password: ", echo: false },
    ]);
    expect(c.feed("a\r")).toEqual({ kind: "none" });
    expect(c.feed("b\r")).toEqual({ kind: "submit", responses: ["a", "b"] });
  });

  it("submits an empty response for zero-prompt rounds on Enter", () => {
    const c = new AuthInputCollector();
    c.setRound([]);
    expect(c.feed("x")).toEqual({ kind: "none" });
    expect(c.feed("\r")).toEqual({ kind: "submit", responses: [] });
  });

  it("ignores input after submitting until the next round resets it", () => {
    const c = new AuthInputCollector();
    c.setRound(PW);
    c.feed("pw\r");
    // A double Enter must not queue a phantom empty answer.
    expect(c.feed("\r")).toEqual({ kind: "none" });
    // New round (e.g. wrong password re-prompt) collects fresh input.
    c.setRound(PW);
    expect(c.feed("ok\r")).toEqual({ kind: "submit", responses: ["ok"] });
  });

  it("reports cancel on Ctrl+C", () => {
    const c = new AuthInputCollector();
    c.setRound(PW);
    expect(c.feed("pw\x03")).toEqual({ kind: "cancel" });
  });

  it("ignores control and escape sequences except backspace and Enter", () => {
    const c = new AuthInputCollector();
    c.setRound(PW);
    // Arrow keys (ESC [ A / ESC [ D), Ctrl+Z, Ctrl+U, NUL — all consumed.
    expect(c.feed("\x1b[A\x1b[D\x1a\x15\x00")).toEqual({ kind: "none" });
    expect(c.feed("a\r")).toEqual({ kind: "submit", responses: ["a"] });
  });

  it("consumes escape sequences split across chunks", () => {
    const c = new AuthInputCollector();
    c.setRound(PW);
    c.feed("\x1b"); // ESC arrives alone…
    c.feed("["); // …then the CSI introducer…
    expect(c.feed("A")).toEqual({ kind: "none" }); // …then the final byte
    expect(c.feed("ok\r")).toEqual({ kind: "submit", responses: ["ok"] });
  });

  it("a bare ESC does not swallow the next real keypress", () => {
    const c = new AuthInputCollector();
    c.setRound(PW);
    expect(c.feed("\x1b")).toEqual({ kind: "none" });
    // ESC then Enter: the Enter must still submit the line.
    expect(c.feed("pw\r")).toEqual({ kind: "submit", responses: ["pw"] });
  });

  it("a paste with trailing newline submits like typing", () => {
    const c = new AuthInputCollector();
    c.setRound(PW);
    expect(c.feed("pasted-pw\r")).toEqual({ kind: "submit", responses: ["pasted-pw"] });
    // Trailing input after the newline is dropped, not queued.
    expect(c.feed("extra\r")).toEqual({ kind: "none" });
  });
});