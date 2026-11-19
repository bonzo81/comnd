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

  // One entry per terminal column: a wide character is one entry plus an empty
  // one for its second cell, and a full row is padded out to `cols`.
  type Row = { cells: string[]; isWrapped?: boolean };
  const makeRow = (cells: string[], isWrapped: boolean) => ({
    isWrapped,
    translateToString(trimRight = false, startCol = 0, endCol = cells.length) {
      const text = cells.slice(startCol, endCol).join("");
      return trimRight ? text.replace(/\s+$/, "") : text;
    },
  });

  const buffer = {
    cursorX,
    cursorY: 2,
    baseY: 0,
    /** Text the screen shows on the cursor row, one cell per character. */
    line: "",
    /** Rows by absolute buffer index, for scrollback and soft wraps. */
    rows: new Map<number, Row>(),
    getLine(row: number) {
      const custom = buffer.rows.get(row);
      if (custom) return makeRow(custom.cells, custom.isWrapped ?? false);
      if (row === buffer.baseY + buffer.cursorY) return makeRow([...buffer.line], false);
      return undefined;
    },
  };
  const parsedListeners: Array<() => void> = [];
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
    onWriteParsed: (listener: () => void) => {
      parsedListeners.push(listener);
      return { dispose: () => parsedListeners.splice(parsedListeners.indexOf(listener), 1) };
    },
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

  /** Simulate xterm finishing a parse of remote output. */
  const parseOutput = () => {
    for (const listener of [...parsedListeners]) listener();
  };

  return { ghost, buffer, el, badge, cellWidth: rect.width / 10, parseOutput };
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

  it("re-anchors to the echoed cursor when output is parsed after showing", () => {
    const { ghost, buffer, el, cellWidth, parseOutput } = makeGhost(4);
    ghost.showPayload({ kind: "text", text: "o" }, 0);
    const shownAt = parseFloat(el.style.left);

    // A backspace echo lands late: the buffer cursor retreats one cell, and the
    // ghost must follow it rather than stay one cell past the typed text.
    buffer.cursorX = 3;
    parseOutput();

    expect(shownAt - parseFloat(el.style.left)).toBe(cellWidth);
  });

  it("stops tracking the cursor once destroyed", () => {
    const { ghost, buffer, el, cellWidth, parseOutput } = makeGhost(4);
    ghost.showPayload({ kind: "text", text: "o" }, 0);
    ghost.destroy();
    const before = parseFloat(el.style.left);

    buffer.cursorX = 2;
    parseOutput();

    expect(parseFloat(el.style.left)).toBe(before);
    expect(cellWidth).toBeGreaterThan(0);
  });
});

describe("GhostText — echo anchor", () => {
  // The remote echoes every keystroke. Until that echo is parsed the buffer
  // cursor sits behind the shadow input, so a repaint would place the
  // prediction in the cells the echo is about to write and the parse would
  // then step it sideways — the per-keystroke blink. Wait for the parse.
  it("defers the repaint until the screen shows the typed input", () => {
    const { ghost, buffer, el, parseOutput } = makeGhost(3);
    buffer.line = "sud";

    ghost.showPayload({ kind: "text", text: "o" }, 0, "sudo");
    expect(ghost.isShowing()).toBe(false);

    buffer.line = "sudo";
    buffer.cursorX = 4;
    parseOutput();

    expect(el.style.display).toBe("inline");
    expect(el.textContent).toBe("o");
    expect(ghost.isShowing()).toBe(true);
  });

  it("paints at once when the screen already shows the typed input", () => {
    const { ghost, buffer, el } = makeGhost(4);
    buffer.line = "sudo";

    ghost.showPayload({ kind: "text", text: "o" }, 0, "sudo");

    expect(el.style.display).toBe("inline");
  });

  it("keeps the painted glyphs and advances the Tab remainder while pending", () => {
    const { ghost, buffer, el, parseOutput } = makeGhost(3);
    buffer.line = "sud";
    ghost.showPayload({ kind: "text", text: "o" }, 0);

    // Backspace: "sud" is still on screen, so the corrected remainder must not
    // be drawn yet — "o" sits in the cell the erase is about to clear, and the
    // two together read as the same word.
    ghost.showPayload({ kind: "text", text: "do" }, 0, "su");
    expect(el.textContent).toBe("o");
    expect(ghost.getCurrentRemainder()).toBe("do");

    buffer.line = "su";
    buffer.cursorX = 2;
    parseOutput();
    expect(el.textContent).toBe("do");
  });

  it("paints anyway when no echo arrives within the wait", () => {
    vi.useFakeTimers();
    try {
      const { ghost, buffer, el } = makeGhost(3);
      buffer.line = "sud";
      ghost.showPayload({ kind: "text", text: "o" }, 0, "sudo");
      expect(ghost.isShowing()).toBe(false);

      vi.advanceTimersByTime(500);

      expect(el.style.display).toBe("inline");
      expect(el.textContent).toBe("o");
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a pending paint when hidden", () => {
    vi.useFakeTimers();
    try {
      const { ghost, buffer, el } = makeGhost(3);
      buffer.line = "sud";
      ghost.showPayload({ kind: "text", text: "o" }, 0, "sudo");

      ghost.hide();
      vi.advanceTimersByTime(500);

      expect(el.style.display).toBe("none");
      expect(ghost.isShowing()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads the cursor row past scrollback, not the row at that viewport offset", () => {
    const { ghost, buffer } = makeGhost(4);
    buffer.baseY = 5;
    // Once the screen has scrolled, the cursor sits five rows into scrollback.
    // Row 2 is what a viewport-relative read lands on, and it holds unrelated
    // scrollback — reading it defers every prediction to the fallback.
    buffer.rows.set(2, { cells: [..."garbage"] });
    buffer.line = "sudo";

    ghost.showPayload({ kind: "text", text: "o" }, 0, "sudo");

    expect(ghost.isShowing()).toBe(true);
  });

  it("bounds the checked prefix by cells, not string characters", () => {
    const { ghost, buffer } = makeGhost(6);
    // `界$ hi` on a ten-column row: the wide glyph takes two cells, so the
    // cursor sits at cell 6 while the prefix is only five characters long.
    buffer.rows.set(2, { cells: ["界", "", "$", " ", "h", "i", " ", " ", " ", " "] });

    ghost.showPayload({ kind: "text", text: "story" }, 0, "hi");

    expect(ghost.isShowing()).toBe(true);
  });

  it("matches input that wrapped onto the next row", () => {
    const { ghost, buffer } = makeGhost(9);
    buffer.cursorY = 3;
    buffer.rows.set(2, { cells: [..."cat /var/l"] });
    buffer.rows.set(3, { cells: [..."og/syslog "], isWrapped: true });

    ghost.showPayload({ kind: "text", text: " x" }, 0, "cat /var/log/syslog");

    expect(ghost.isShowing()).toBe(true);
  });

  it("holds the painted position while the echo is only part way in", () => {
    const { ghost, buffer, el, cellWidth, parseOutput } = makeGhost(3);
    buffer.line = "his";
    ghost.showPayload({ kind: "text", text: "tory" }, 0);

    // `to` typed, but only the `t` has been echoed. The glyphs on screen are
    // anchored after `his`; moving them to the new cursor would draw them past
    // the part of the input that has landed, reading as the word twice over.
    buffer.line = "hist";
    buffer.cursorX = 4;
    ghost.showPayload({ kind: "text", text: "ry" }, 0, "histo");
    const anchored = parseFloat(el.style.left);
    parseOutput();

    expect(parseFloat(el.style.left)).toBe(anchored);
    expect(el.textContent).toBe("tory");

    buffer.line = "histo";
    buffer.cursorX = 5;
    parseOutput();

    expect(el.textContent).toBe("ry");
    expect(parseFloat(el.style.left) - anchored).toBe(2 * cellWidth);
  });

  it("keeps the first deadline when predictions keep arriving", () => {
    vi.useFakeTimers();
    try {
      const { ghost, buffer, el } = makeGhost(3);
      buffer.line = "sud";
      ghost.showPayload({ kind: "text", text: "o" }, 0, "sudo");

      // A host that never echoes defers on every keystroke. Restarting the
      // clock each time would hide the ghost for as long as the typing lasts.
      vi.advanceTimersByTime(300);
      ghost.showPayload({ kind: "text", text: "o " }, 0, "sudo ");
      vi.advanceTimersByTime(200);

      expect(ghost.isShowing()).toBe(true);
      expect(el.textContent).toBe("o ");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not restore a remainder that word acceptance advanced", () => {
    const { ghost, buffer, el, parseOutput } = makeGhost(7);
    buffer.line = "show in";
    ghost.showPayload({ kind: "text", text: "faces brief" }, 0);

    // `inter` typed but not yet echoed: this paint is pending.
    ghost.showPayload({ kind: "text", text: "faces brief" }, 0, "show inter");
    // Alt+Right sends `faces ` and advances the remainder to `brief`.
    expect(ghost.acceptNextWord()).toBe("faces ");

    buffer.line = "show inter";
    buffer.cursorX = 10;
    parseOutput();

    // The echo of `show inter` landed. The pending paint must carry what Tab
    // sends next, not the fragment Tab has already sent.
    expect(el.textContent).toBe("faces brief");
    expect(ghost.getCurrentRemainder()).toBe("brief");

    buffer.line = "show interfaces ";
    buffer.cursorX = 16;
    parseOutput();

    expect(el.textContent).toBe("brief");
    expect(ghost.getCurrentRemainder()).toBe("brief");
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
