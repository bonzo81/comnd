import { describe, expect, it } from "vitest";
import {
  countLiveSessions,
  isAtSessionLimit,
  isLiveSession,
  normalizeDuplicateSessionPolicy,
  resolveDuplicateSessionAction,
} from "./duplicate-session";

describe("normalizeDuplicateSessionPolicy", () => {
  it("keeps known values", () => {
    expect(normalizeDuplicateSessionPolicy("ask")).toBe("ask");
    expect(normalizeDuplicateSessionPolicy("allow")).toBe("allow");
    expect(normalizeDuplicateSessionPolicy("focus")).toBe("focus");
  });

  it("falls back to ask for missing or unknown values", () => {
    expect(normalizeDuplicateSessionPolicy(undefined)).toBe("ask");
    expect(normalizeDuplicateSessionPolicy(null)).toBe("ask");
    expect(normalizeDuplicateSessionPolicy("")).toBe("ask");
    expect(normalizeDuplicateSessionPolicy("always")).toBe("ask");
  });
});

describe("isAtSessionLimit", () => {
  it("treats 0 as unlimited", () => {
    expect(isAtSessionLimit(1000, 0)).toBe(false);
  });

  it("is true once open sessions reach the cap", () => {
    expect(isAtSessionLimit(29, 30)).toBe(false);
    expect(isAtSessionLimit(30, 30)).toBe(true);
    expect(isAtSessionLimit(31, 30)).toBe(true);
  });
});

describe("isLiveSession", () => {
  it("is true only while the session occupies a backend slot", () => {
    expect(isLiveSession("connecting")).toBe(true);
    expect(isLiveSession("connected")).toBe(true);
    expect(isLiveSession("disconnected")).toBe(false);
    expect(isLiveSession("error")).toBe(false);
  });
});

describe("countLiveSessions", () => {
  it("counts connecting and connected sessions", () => {
    expect(countLiveSessions(["connecting", "connected", "connected"])).toBe(3);
  });

  it("ignores failed and disconnected tabs so the limit is not reached early", () => {
    expect(countLiveSessions(["connected", "error", "disconnected"])).toBe(1);
  });

  it("is zero with no tabs", () => {
    expect(countLiveSessions([])).toBe(0);
  });
});

describe("resolveDuplicateSessionAction", () => {
  it("asks by default", () => {
    expect(resolveDuplicateSessionAction({ policy: "ask", atLimit: false })).toBe("prompt");
  });

  it("opens a second session when the policy allows it", () => {
    expect(resolveDuplicateSessionAction({ policy: "allow", atLimit: false })).toBe("new");
  });

  it("focuses the existing session when the policy says so", () => {
    expect(resolveDuplicateSessionAction({ policy: "focus", atLimit: false })).toBe("focus");
  });

  it("never offers a second session at the limit", () => {
    expect(resolveDuplicateSessionAction({ policy: "ask", atLimit: true })).toBe("prompt-limit");
    expect(resolveDuplicateSessionAction({ policy: "allow", atLimit: true })).toBe("prompt-limit");
  });

  it("focuses the existing session at the limit under the focus policy", () => {
    expect(resolveDuplicateSessionAction({ policy: "focus", atLimit: true })).toBe("focus");
  });
});
