import { afterEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { GhostText } from "./ghost-text";

const cleanups: Array<() => void> = [];

/**
 * jsdom has no layout: getBoundingClientRect() and offsetWidth are 0, which
 * would make a cursor-position assertion pass even with repositioning broken
 * (0 === 0). Stub the terminal geometry explicitly and assert deltas only.
 */
function makeGhost(cursorX = 3) {
  const container = document.createElement("div");
  const screen = document.createElement("div");
  screen.className = "xterm-screen";
  container.appendChild(screen);
  document.body.appendChild(container);

  const rect = {
    width: 100,
    height: 100,
    left: 0,
    top: 0,
    right: 100,
    bottom: 100,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect;
  screen.getBoundingClientRect = () => rect;
  container.getBoundingClientRect = () => rect;

  const buffer = { cursorX, cursorY: 2 };
  const terminal = {
    buffer: {
      get active() {
        return buffer;
      },
    },
    rows: 10,
    cols: 10,
    options: { fontSize: 14 },
    write: vi.fn(),
  } as unknown as Terminal;

  const ghost = new GhostText(terminal, container);
  const el = container.querySelector(".ghost-text") as HTMLElement;
  const badge = container.querySelector(".match-count-badge") as HTMLElement;
  // 25px of rendered text; jsdom reports 0 without this stub.
  Object.defineProperty(el, "offsetWidth", { value: 25, configurable: true });

  cleanups.push(() => {
    ghost.destroy();
    container.remove();
  });

  return { ghost, buffer, el, badge, cellWidth: rect.width / 10 };
}

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

describe("GhostText — positioning", () => {
  it("shifts style.left by exactly one cell width when the cursor moves one column", () => {
    const { ghost, buffer, el, cellWidth } = makeGhost(3);
    ghost.showPayload({ kind: "text", text: "faces" }, 0);

    const before = parseFloat(el.style.left);
    buffer.cursorX = 4;
    ghost.reposition();
    const after = parseFloat(el.style.left);

    expect(after - before).toBe(cellWidth);
  });

  it("moves the match-count badge by the same cell width and keeps it after the ghost", () => {
    const { ghost, buffer, el, badge, cellWidth } = makeGhost(3);
    ghost.showPayload({ kind: "text", text: "faces" }, 3);

    const ghostBefore = parseFloat(el.style.left);
    const badgeBefore = parseFloat(badge.style.left);
    expect(badgeBefore - ghostBefore).toBe(25 + 8);

    buffer.cursorX = 4;
    ghost.reposition();

    expect(parseFloat(el.style.left) - ghostBefore).toBe(cellWidth);
    expect(parseFloat(badge.style.left) - badgeBefore).toBe(cellWidth);
    expect(parseFloat(badge.style.left) - parseFloat(el.style.left)).toBe(25 + 8);
  });

  it("does not reposition while hidden", () => {
    const { ghost, buffer, el } = makeGhost(3);
    ghost.showPayload({ kind: "text", text: "faces" }, 0);
    const before = parseFloat(el.style.left);

    ghost.hide();
    buffer.cursorX = 5;
    ghost.reposition();

    expect(parseFloat(el.style.left)).toBe(before);
  });
});

describe("GhostText — arrival settle", () => {
  // showPayload runs on every keystroke while a suggestion is showing, so an
  // unguarded entrance class would replay the fade under each character.
  it("marks the hidden→shown edge but not an update while already showing", () => {
    const { ghost, el, badge } = makeGhost(3);

    ghost.showPayload({ kind: "text", text: "faces" }, 2);
    expect(el.classList.contains("ghost-text--enter")).toBe(true);
    expect(badge.classList.contains("match-count-badge--enter")).toBe(true);

    // Pretend the 120ms fade has run: the class is still on the element.
    el.classList.remove("ghost-text--enter");
    badge.classList.remove("match-count-badge--enter");
    ghost.showPayload({ kind: "text", text: "faceset" }, 1);
    expect(el.classList.contains("ghost-text--enter")).toBe(false);
    expect(badge.classList.contains("match-count-badge--enter")).toBe(false);
  });

  it("clears the class on hide so a later appearance animates again", () => {
    const { ghost, el, badge } = makeGhost(3);

    ghost.showPayload({ kind: "text", text: "faces" }, 2);
    ghost.hide();
    expect(el.classList.contains("ghost-text--enter")).toBe(false);
    expect(badge.classList.contains("match-count-badge--enter")).toBe(false);

    ghost.showPayload({ kind: "text", text: "faces" }, 2);
    expect(el.classList.contains("ghost-text--enter")).toBe(true);
  });
});
