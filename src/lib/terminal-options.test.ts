import { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearStorage, writeStorage } from "./storage";
import { getTerminalScrollback, setTerminalScrollback } from "./terminal-prefs";
import { bindTerminalScrollback, buildTerminalOptions } from "./terminal-options";

const KEY = "comnd-terminal-scrollback";

describe("terminal constructor options", () => {
  const terminals: Terminal[] = [];

  const openTerminal = (scrollback = getTerminalScrollback()): Terminal => {
    const term = new Terminal(buildTerminalOptions({ fontSize: 14, scrollback, theme: {} }));
    terminals.push(term);
    return term;
  };

  beforeEach(() => clearStorage());
  afterEach(() => {
    for (const term of terminals.splice(0)) term.dispose();
  });

  it("hands the stored scrollback preference to xterm", () => {
    writeStorage(KEY, "20000");
    expect(openTerminal().options.scrollback).toBe(20_000);
  });

  it("never leaves xterm's 1000-line default in place", () => {
    expect(getTerminalScrollback()).not.toBe(1_000);
    const term = openTerminal();
    expect(term.options.scrollback).toBe(getTerminalScrollback());
  });

  it("updates an already-open terminal when the preference changes", () => {
    const term = openTerminal(1_000);
    const unbind = bindTerminalScrollback(term);
    try {
      setTerminalScrollback(25_000);
      expect(term.options.scrollback).toBe(25_000);
    } finally {
      unbind();
    }

    setTerminalScrollback(3_000);
    expect(term.options.scrollback).toBe(25_000);
  });
});
