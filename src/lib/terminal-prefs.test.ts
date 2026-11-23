import { beforeEach, describe, expect, it } from "vitest";
import { clearStorage, readStorage, writeStorage } from "./storage";
import {
  getTerminalScrollback,
  setTerminalScrollback,
  TERMINAL_SCROLLBACK_DEFAULT,
  TERMINAL_SCROLLBACK_MAX,
  TERMINAL_SCROLLBACK_MIN,
} from "./terminal-prefs";

const KEY = "comnd-terminal-scrollback";

describe("terminal scrollback preference", () => {
  beforeEach(() => clearStorage());

  it("defaults to 10,000 lines", () => {
    expect(TERMINAL_SCROLLBACK_DEFAULT).toBe(10_000);
    expect(getTerminalScrollback()).toBe(TERMINAL_SCROLLBACK_DEFAULT);
  });

  it("round-trips a set value through storage", () => {
    setTerminalScrollback(20_000);
    expect(readStorage(KEY)).toBe("20000");
    expect(getTerminalScrollback()).toBe(20_000);
  });

  it("clamps out-of-range stored values", () => {
    writeStorage(KEY, "0");
    expect(getTerminalScrollback()).toBe(TERMINAL_SCROLLBACK_MIN);
    writeStorage(KEY, "99999999");
    expect(getTerminalScrollback()).toBe(TERMINAL_SCROLLBACK_MAX);
  });

  it("clamps on write and reports the clamped value", () => {
    const seen: number[] = [];
    const on = (e: Event) => seen.push((e as CustomEvent<number>).detail);
    window.addEventListener("comnd:terminal-scrollback", on);
    try {
      setTerminalScrollback(99_999);
      expect(readStorage(KEY)).toBe(String(TERMINAL_SCROLLBACK_MAX));
      setTerminalScrollback(42.6); // rounds, then clamps
      expect(getTerminalScrollback()).toBe(TERMINAL_SCROLLBACK_MIN);
    } finally {
      window.removeEventListener("comnd:terminal-scrollback", on);
    }
    expect(seen).toEqual([TERMINAL_SCROLLBACK_MAX, TERMINAL_SCROLLBACK_MIN]);
  });

  it("falls back to the default for unreadable storage", () => {
    writeStorage(KEY, "not a number");
    expect(getTerminalScrollback()).toBe(TERMINAL_SCROLLBACK_DEFAULT);
  });
});
