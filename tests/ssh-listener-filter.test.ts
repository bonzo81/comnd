import { describe, it, expect } from "vitest";
import { shouldAcceptEvent } from "../src/lib/session-filter";

describe("shouldAcceptEvent", () => {
  it("accepts event matching view session id (F4)", () => {
    expect(shouldAcceptEvent(5, 5)).toBe(true);
  });

  it("rejects event from a foreign session (F5)", () => {
    expect(shouldAcceptEvent(6, 5)).toBe(false);
  });

  it("pins the unset/unset edge case (F6)", () => {
    // Both unset (0) — matches by equality. TerminalView mints a real
    // session_id before sshConnect, so 0/0 only occurs before the first
    // connect, when no events should be in flight.
    expect(shouldAcceptEvent(0, 0)).toBe(true);
  });
});
