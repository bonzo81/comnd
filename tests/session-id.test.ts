import { describe, it, expect, beforeEach } from "vitest";
import { mintSessionId, __resetSessionId } from "../src/lib/session-id";

describe("mintSessionId", () => {
  beforeEach(() => {
    __resetSessionId();
  });

  it("returns distinct values on consecutive calls (F1)", () => {
    const a = mintSessionId();
    const b = mintSessionId();
    expect(a).not.toBe(b);
  });

  it("is monotonic increasing (F2)", () => {
    const a = mintSessionId();
    const b = mintSessionId();
    const c = mintSessionId();
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it("resets to 1 after __resetSessionId (F3)", () => {
    mintSessionId();
    mintSessionId();
    __resetSessionId();
    expect(mintSessionId()).toBe(1);
  });
});
