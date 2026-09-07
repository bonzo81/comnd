import { describe, it, expect } from "vitest";
import {
  routeKeystroke,
  S_ACCEPT_GHOST,
  S_ACCEPT_NEXTWORD,
  S_ACCEPT_DROPDOWN,
  type RouteView,
} from "./keystroke-router";

const v = (over: Partial<RouteView> = {}): RouteView => ({
  connected: true,
  dropdownVisible: false,
  ghostShowing: false,
  sidebarOpen: false,
  ...over,
});

describe("routeKeystroke â€” connection gate", () => {
  it("no-ops when not connected", () => {
    const r = routeKeystroke("a", v({ connected: false }));
    expect(r.send).toEqual([]);
    expect(r.shadowOps).toEqual([]);
  });

  it("forwards a printable char when connected", () => {
    const r = routeKeystroke("a", v());
    expect(r.send).toEqual(["a"]);
    expect(r.shadowOps).toEqual([{ op: "append", ch: "a" }]);
  });
});

describe("routeKeystroke â€” Tab", () => {
  it("accepts dropdown selection when dropdown is visible", () => {
    const r = routeKeystroke("\t", v({ dropdownVisible: true }));
    expect(r.send).toEqual([S_ACCEPT_DROPDOWN]);
    expect(r.shadowOps).toEqual([]);
  });

  it("accepts ghost when no dropdown but ghost showing", () => {
    const r = routeKeystroke("\t", v({ ghostShowing: true }));
    expect(r.send).toEqual([S_ACCEPT_GHOST]);
  });

  it("passes through and resets shadow when nothing is showing", () => {
    const r = routeKeystroke("\t", v());
    expect(r.send).toEqual(["\t"]);
    expect(r.shadowOps).toEqual([{ op: "reset" }]);
  });

  it("prefers dropdown over ghost when both are set", () => {
    const r = routeKeystroke("\t", v({ dropdownVisible: true, ghostShowing: true }));
    expect(r.send).toEqual([S_ACCEPT_DROPDOWN]);
  });
});

describe("routeKeystroke â€” Escape cascade", () => {
  it("closes dropdown first (does not forward)", () => {
    const r = routeKeystroke("\x1b", v({ dropdownVisible: true }));
    expect(r.send).toEqual([]);
    expect(r.hideDropdown).toBe(true);
  });

  it("dismisses sidebar when no dropdown but sidebar open (does not forward)", () => {
    const r = routeKeystroke("\x1b", v({ sidebarOpen: true }));
    expect(r.send).toEqual([]);
    expect(r.dismissSidebar).toBe(true);
  });

  it("hides ghost and forwards bare ESC when only ghost showing", () => {
    const r = routeKeystroke("\x1b", v({ ghostShowing: true }));
    expect(r.send).toEqual(["\x1b"]);
    expect(r.hideGhost).toBe(true);
    expect(r.shadowOps).toEqual([]);
  });

  it("forwards bare ESC with no side effects when nothing is open", () => {
    const r = routeKeystroke("\x1b", v());
    expect(r.send).toEqual(["\x1b"]);
    expect(r.hideGhost).toBeUndefined();
    expect(r.shadowOps).toEqual([]);
  });

  it("prefers dropdown over sidebar when both set", () => {
    const r = routeKeystroke("\x1b", v({ dropdownVisible: true, sidebarOpen: true }));
    expect(r.hideDropdown).toBe(true);
    expect(r.dismissSidebar).toBeUndefined();
  });
});

describe("routeKeystroke â€” Ctrl+Space", () => {
  it("toggles suggestions and does not forward", () => {
    const r = routeKeystroke("\x00", v());
    expect(r.send).toEqual([]);
    expect(r.toggleSuggestions).toBe(true);
  });
});

describe("routeKeystroke â€” dropdown navigation", () => {
  it("moves up when dropdown visible (does not forward)", () => {
    const r = routeKeystroke("\x1b[A", v({ dropdownVisible: true }));
    expect(r.send).toEqual([]);
    expect(r.moveDropdown).toBe("up");
    expect(r.rebuildGhost).toBe(true);
  });

  it("moves down when dropdown visible (does not forward)", () => {
    const r = routeKeystroke("\x1b[B", v({ dropdownVisible: true }));
    expect(r.send).toEqual([]);
    expect(r.moveDropdown).toBe("down");
    expect(r.rebuildGhost).toBe(true);
  });

  it("treats arrow-up as history (reset) when dropdown NOT visible", () => {
    const r = routeKeystroke("\x1b[A", v());
    expect(r.send).toEqual(["\x1b[A"]);
    expect(r.shadowOps).toEqual([{ op: "reset" }]);
    expect(r.markCursorMoved).toBeUndefined();
    expect(r.hideGhost).toBe(true);
    expect(r.hideDropdown).toBeUndefined();
  });
});

describe("routeKeystroke â€” Alt+ArrowRight", () => {
  for (const seq of ["\x1b[1;3C", "\x1b\x1b[C", "\x1b\x1b[1;3C"]) {
    it(`routes ${JSON.stringify(seq)} to accept-next-word`, () => {
      const r = routeKeystroke(seq, v());
      expect(r.send).toEqual([S_ACCEPT_NEXTWORD]);
      expect(r.shadowOps).toEqual([]);
    });
  }
});

describe("routeKeystroke â€” commit / abort", () => {
  it("Enter resets shadow, hides ghost+dropdown", () => {
    const r = routeKeystroke("\r", v());
    expect(r.send).toEqual(["\r"]);
    expect(r.shadowOps).toEqual([{ op: "reset" }]);
    expect(r.markCursorMoved).toBeUndefined();
    expect(r.hideGhost).toBe(true);
    expect(r.hideDropdown).toBe(true);
  });

  it("Ctrl+C resets shadow, hides ghost+dropdown", () => {
    const r = routeKeystroke("\x03", v());
    expect(r.send).toEqual(["\x03"]);
    expect(r.shadowOps).toEqual([{ op: "reset" }]);
    expect(r.markCursorMoved).toBeUndefined();
    expect(r.hideGhost).toBe(true);
    expect(r.hideDropdown).toBe(true);
  });

  it("backspace (\\x7f) issues a backspace op", () => {
    const r = routeKeystroke("\x7f", v());
    expect(r.send).toEqual(["\x7f"]);
    expect(r.shadowOps).toEqual([{ op: "backspace" }]);
  });

  it("backspace (\\b) issues a backspace op", () => {
    const r = routeKeystroke("\b", v());
    expect(r.send).toEqual(["\b"]);
    expect(r.shadowOps).toEqual([{ op: "backspace" }]);
  });
});

describe("routeKeystroke â€” line editing", () => {
  it("left arrow sets cursorMoved, hides ghost+dropdown, no buffer op", () => {
    const r = routeKeystroke("\x1b[D", v());
    expect(r.send).toEqual(["\x1b[D"]);
    expect(r.markCursorMoved).toBe(true);
    expect(r.hideGhost).toBe(true);
    expect(r.hideDropdown).toBe(true);
    expect(r.shadowOps).toEqual([]);
  });

  it("Ctrl+W sets cursorMoved, no buffer op", () => {
    const r = routeKeystroke("\x17", v());
    expect(r.send).toEqual(["\x17"]);
    expect(r.markCursorMoved).toBe(true);
    expect(r.shadowOps).toEqual([]);
  });

  it("plain right arrow (\\x1b[C) is line-edit, not alt-arrow-right", () => {
    const r = routeKeystroke("\x1b[C", v());
    expect(r.send).toEqual(["\x1b[C"]);
    expect(r.markCursorMoved).toBe(true);
  });
});

describe("routeKeystroke â€” printable / paste", () => {
  it("appends a single printable char", () => {
    const r = routeKeystroke("z", v());
    expect(r.send).toEqual(["z"]);
    expect(r.shadowOps).toEqual([{ op: "append", ch: "z" }]);
  });

  it("appends each printable char of a paste", () => {
    const r = routeKeystroke("abc", v());
    expect(r.send).toEqual(["abc"]);
    expect(r.shadowOps).toEqual([
      { op: "append", ch: "a" },
      { op: "append", ch: "b" },
      { op: "append", ch: "c" },
    ]);
  });

  it("skips non-printable chars inside a paste", () => {
    const r = routeKeystroke("a\x01b", v());
    expect(r.send).toEqual(["a\x01b"]);
    expect(r.shadowOps).toEqual([
      { op: "append", ch: "a" },
      { op: "append", ch: "b" },
    ]);
  });

  it("forwards an unrecognized control char with no buffer op", () => {
    const r = routeKeystroke("\x02", v());
    expect(r.send).toEqual(["\x02"]);
    expect(r.shadowOps).toEqual([]);
  });
});
