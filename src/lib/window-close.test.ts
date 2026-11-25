import { describe, expect, it } from "vitest";
import { type SessionLifecycle } from "./duplicate-session";
import { describeWindowClose } from "./window-close";

const states = (...all: SessionLifecycle[]) => all;

describe("describeWindowClose", () => {
  it("does not prompt when no tab is open", () => {
    expect(describeWindowClose(states())).toBeNull();
  });

  it("does not prompt for failed tabs", () => {
    expect(describeWindowClose(states("disconnected", "error"))).toBeNull();
  });

  it("names a single connected session in the singular", () => {
    expect(describeWindowClose(states("connected"))).toEqual({
      sessionCount: 1,
      title: "Close Comnd?",
      message: "1 SSH session will be terminated.",
      confirmLabel: "Close Comnd",
    });
  });

  it("counts a connecting session as live", () => {
    expect(describeWindowClose(states("connecting"))?.sessionCount).toBe(1);
  });

  it("pluralises several sessions", () => {
    const prompt = describeWindowClose(states("connected", "connecting", "connected"));
    expect(prompt?.sessionCount).toBe(3);
    expect(prompt?.message).toBe("3 SSH sessions will be terminated.");
  });

  it("counts only the live half of a mixed tab list", () => {
    const prompt = describeWindowClose(
      states("connected", "error", "disconnected", "connecting"),
    );
    expect(prompt?.sessionCount).toBe(2);
    expect(prompt?.message).toBe("2 SSH sessions will be terminated.");
  });
});
