import { describe, expect, it, vi } from "vitest";
import { moveListItem } from "./listbox-nav";

function setup(count: number, selected = 0) {
  const setSelected = vi.fn();
  return { setSelected, run: (delta: number, wrap = true) => moveListItem(count, selected, setSelected, delta, wrap) };
}

describe("moveListItem", () => {
  it("moves down/up", () => {
    const a = setup(3, 1);
    a.run(1);
    expect(a.setSelected).toHaveBeenLastCalledWith(2);
    a.run(-1);
    expect(a.setSelected).toHaveBeenLastCalledWith(0);
  });

  it("wraps at both ends when wrap=true", () => {
    const a = setup(3, 2);
    a.run(1);
    expect(a.setSelected).toHaveBeenLastCalledWith(0);
    const b = setup(3, 0);
    b.run(-1);
    expect(b.setSelected).toHaveBeenLastCalledWith(2);
  });

  it("clamps at both ends when wrap=false", () => {
    const a = setup(3, 2);
    a.run(1, false);
    expect(a.setSelected).toHaveBeenLastCalledWith(2);
    const b = setup(3, 0);
    b.run(-1, false);
    expect(b.setSelected).toHaveBeenLastCalledWith(0);
  });

  it("no-op on empty list", () => {
    const { setSelected } = setup(0);
    moveListItem(0, 0, setSelected, 1);
    expect(setSelected).not.toHaveBeenCalled();
  });
});