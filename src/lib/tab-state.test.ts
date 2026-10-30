import { describe, expect, it } from "vitest";
import { activateTab, closeTab, type TabState } from "./tab-state";

const tabs = (): TabState<number>[] => [
  { id: 1, active: true },
  { id: 2, active: false },
];

describe("activateTab", () => {
  it("marks exactly the requested session active", () => {
    expect(activateTab(tabs(), 2)).toEqual([
      { id: 1, active: false },
      { id: 2, active: true },
    ]);
  });

  it("does not disturb sibling sessions to the same host", () => {
    const next = activateTab(tabs(), 2);
    expect(next).toHaveLength(2);
    expect(next[0].id).toBe(1);
  });

  it("leaves all tabs inactive for an unknown id", () => {
    expect(activateTab(tabs(), 99).every((t) => !t.active)).toBe(true);
  });
});

describe("closeTab", () => {
  it("removes only the requested session", () => {
    expect(closeTab(tabs(), 1)).toEqual([{ id: 2, active: true }]);
  });

  it("closing one of two sessions keeps the other present", () => {
    const next = closeTab(tabs(), 2);
    expect(next).toHaveLength(1);
    expect(next[0].id).toBe(1);
  });

  it("returns the same array for an unknown id", () => {
    const current = tabs();
    expect(closeTab(current, 99)).toBe(current);
  });

  it("returns an empty list when the last session closes", () => {
    expect(closeTab([{ id: 1, active: true }], 1)).toEqual([]);
  });

  it("activates the last remaining tab after a close", () => {
    const three: TabState<number>[] = [
      { id: 1, active: false },
      { id: 2, active: true },
      { id: 3, active: false },
    ];
    expect(closeTab(three, 2)).toEqual([
      { id: 1, active: false },
      { id: 3, active: true },
    ]);
  });
});
