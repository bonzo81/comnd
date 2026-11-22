import { describe, it, expect } from "vitest";
import { TimestampGutter, formatTimestamp } from "../src/lib/timestamps";
import { createTerminalFake, type TerminalFake } from "./harness";

function makeTerminal() {
  const fake = createTerminalFake({ cols: 80, rows: 10 });
  const el = document.createElement("div");
  document.body.appendChild(el);
  fake.terminal.open(el);
  return fake;
}

function writeAsync(fake: TerminalFake, data: string) {
  return new Promise<void>((resolve) => fake.terminal.write(data, () => resolve()));
}

/**
 * Mirror terminal-view: capture cursor before write, stamp after.
 *
 * The fake reproduces xterm's line accounting for the constructs fed here
 * (printable text and CR/LF), so this still exercises the gutter rather than
 * xterm's own parser — the gutter is the subject of these tests.
 */
async function feed(gutter: TimestampGutter, fake: TerminalFake, data: string) {
  const buf = fake.buffer;
  const before = buf.baseY + buf.cursorY;
  await writeAsync(fake, data);
  gutter.onWrite(before, buf.baseY + buf.cursorY);
}

function tick() {
  return new Promise((r) => setTimeout(r, 20));
}

describe("formatTimestamp", () => {
  it("renders each format", () => {
    const d = new Date(2026, 0, 2, 14, 5, 9, 12);
    expect(formatTimestamp(d, "24h")).toBe("14:05:09");
    expect(formatTimestamp(d, "24h-ms")).toBe("14:05:09.012");
    expect(formatTimestamp(d, "12h")).toMatch(/^2:05:09\s?PM$/i);
  });
});

describe("TimestampGutter", () => {
  it("stamps each line once at first contact, clears on demand", async () => {
    const term = makeTerminal();
    const gutter = new TimestampGutter(term.terminal);

    await feed(gutter, term, "hello\r\n");
    await feed(gutter, term, "world\r\n");
    await tick();

    let stamps = document.querySelectorAll(".ts-stamp");
    expect(stamps.length).toBe(3);
    expect(stamps[0].textContent).toMatch(/^\d{2}:\d{2}:\d{2}$/);

    // Continued output on the current line must not double-stamp it
    await feed(gutter, term, "par");
    await feed(gutter, term, "tial\r\n");
    await tick();
    stamps = document.querySelectorAll(".ts-stamp");
    expect(stamps.length).toBe(4);

    gutter.clear();
    expect(document.querySelectorAll(".ts-stamp").length).toBe(0);
    term.terminal.dispose();
  });

  it("re-renders existing stamps when format changes", async () => {
    const term = makeTerminal();
    const gutter = new TimestampGutter(term.terminal);

    await feed(gutter, term, "hello\r\n");
    await tick();
    const stamp = document.querySelector(".ts-stamp")!;
    expect(stamp.textContent).toMatch(/^\d{2}:\d{2}:\d{2}$/);

    gutter.applyFormat("24h-ms");
    expect(stamp.textContent).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
    term.terminal.dispose();
  });

  it("records continuously so stamps can be revealed retroactively", async () => {
    const term = makeTerminal();
    const gutter = new TimestampGutter(term.terminal);

    // No enable step — recording is unconditional; visibility is CSS-only
    await feed(gutter, term, "early output\r\n");
    await tick();
    expect(document.querySelectorAll(".ts-stamp").length).toBe(2);
    term.terminal.dispose();
  });
});
