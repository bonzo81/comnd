/**
 * The seam between the terminal preference store and xterm's constructor
 * options (issue #194). The options object lives here so a unit test can
 * assert what actually reaches xterm without a DOM, and the live scrollback
 * listener lives here so the same test can prove an already-open terminal
 * reacts to the preference change.
 */

import type { ITerminalOptions, ITheme, Terminal } from "@xterm/xterm";
import { getTerminalScrollback } from "./terminal-prefs";

export interface TerminalOptionsInput {
  fontSize: number;
  scrollback: number;
  theme: ITheme;
}

export function buildTerminalOptions(
  { fontSize, scrollback, theme }: TerminalOptionsInput,
): ITerminalOptions {
  return {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize,
    scrollback,
    theme,
    cursorBlink: true,
    allowProposedApi: true, // required for registerDecoration (line timestamps)
  };
}

/** Apply scrollback changes to an open terminal. Returns the unsubscribe so
 *  the caller's teardown removes the listener with its siblings. */
export function bindTerminalScrollback(
  terminal: Pick<Terminal, "options">,
  target: Window = window,
): () => void {
  const handler = () => {
    terminal.options.scrollback = getTerminalScrollback();
  };
  target.addEventListener("comnd:terminal-scrollback", handler);
  return () => target.removeEventListener("comnd:terminal-scrollback", handler);
}
