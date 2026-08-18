import { describe, it, expect } from "vitest";
import { activateTab, closeTab, TabState } from "../src/lib/tab-state";

function tabs(hostIds: string[], activeIdx = -1): TabState[] {
  return hostIds.map((hostId, i) => ({ hostId, active: i === activeIdx }));
}

describe("activateTab", () => {
  it("marks exactly one tab active (F7)", () => {
    const next = activateTab(tabs(["a", "b", "c"], 0), "b");
    expect(next.filter((t) => t.active)).toEqual([{ hostId: "b", active: true }]);
  });
});

describe("closeTab", () => {
  it("activates last remaining tab (F8)", () => {
    const next = closeTab(tabs(["a", "b", "c"], 1), "b");
    expect(next.map((t) => t.hostId)).toEqual(["a", "c"]);
    expect(next.find((t) => t.active)?.hostId).toBe("c");
  });

  it("returns empty array when last tab closed (F9)", () => {
    expect(closeTab(tabs(["a"], 0), "a")).toEqual([]);
  });

  it("is a no-op for unknown host id (F10)", () => {
    const input = tabs(["a", "b"], 0);
    expect(closeTab(input, "z")).toEqual(input);
  });
});
