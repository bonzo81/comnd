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

  it("ignores Enter before the first round — no phantom empty answer", () => {
    const c = new AuthInputCollector();
    // The terminal is armed (ssh-auth-interactive) but no prompt has
    // arrived yet — an impatient Enter must not queue an empty response
    // that later answers the real round.
    expect(c.feed("pw\r")).toEqual({ kind: "none" });
    c.setRound(PW);
    expect(c.feed("secret\r")).toEqual({ kind: "submit", responses: ["secret"] });
  });

  it("still cancels with Ctrl+C before the first round", () => {
    const c = new AuthInputCollector();
    expect(c.feed("\x03")).toEqual({ kind: "cancel" });
  });

  it("cancels with Ctrl+C after submitting, while the server processes", () => {
    const c = new AuthInputCollector();
    c.setRound(PW);
    c.feed("pw\r");
    expect(c.feed("\x03")).toEqual({ kind: "cancel" });
    // …including later in a chunk, after other stale keys.
    expect(c.feed("xy\x03")).toEqual({ kind: "cancel" });
  });

  it("treats a pasted CRLF as one Enter, not two", () => {
    const c = new AuthInputCollector();
    c.setRound([
      { prompt: "Username: ", echo: true },
      { prompt: "Password: ", echo: false },
    ]);
    // Windows clipboard text must not turn the second answer empty.
    expect(c.feed("user\r\npassword\r\n")).toEqual({
      kind: "submit",
      responses: ["user", "password"],
    });
  });

  it("lone CR and lone LF each count as one Enter", () => {
    const c = new AuthInputCollector();
    c.setRound(PW);
    expect(c.feed("a\r")).toEqual({ kind: "submit", responses: ["a"] });
    c.setRound(PW);
    expect(c.feed("b\n")).toEqual({ kind: "submit", responses: ["b"] });
  });

  it("backspace removes a full code point (emoji span two UTF-16 units)", () => {
    const c = new AuthInputCollector();
    c.setRound(PW);
    c.feed("a😀");
    expect(c.feed("\x7f")).toEqual({ kind: "none" }); // drop just the emoji
    expect(c.feed("\r")).toEqual({ kind: "submit", responses: ["a"] });
  });

  it("reset() deactivates the collector until the next round", () => {
    const c = new AuthInputCollector();
    c.setRound(PW);
    c.feed("stale\r");
    c.reset();
    expect(c.feed("x\r")).toEqual({ kind: "none" });
    c.setRound(PW);
    expect(c.feed("fresh\r")).toEqual({ kind: "submit", responses: ["fresh"] });
  });
});