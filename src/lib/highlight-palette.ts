/**
 * ANSI color palette for terminal output highlighting.
 *
 * Maps semantic color names (used in highlight-rules.ts) to ANSI SGR codes.
 * These are FIXED constants — they go into the byte stream as ANSI escape
 * codes, not CSS variables. Chosen for contrast on both dark (#0F172A) and
 * light (#F8FAFC) terminal themes.
 *
 * See docs/plans/plan-terminal-output-highlighting.md.
 */

export type AnsiColor =
  | "cyan"
  | "green"
  | "red"
  | "orange"
  | "yellow"
  | "blue"
  | "magenta"
  | "muted"
  | "bold";

export const ANSI_CODES: Record<AnsiColor, string> = {
  cyan:    "38;5;51",
  green:   "38;5;34",
  red:     "38;5;196",
  orange:  "38;5;208",
  yellow:  "38;5;220",
  blue:    "38;5;33",
  magenta: "38;5;141",
  muted:   "38;5;245",
  bold:    "1",
};

export const ANSI_RESET = "\x1b[0m";

export function colorize(text: string, color: AnsiColor): string {
  return `\x1b[${ANSI_CODES[color]}m${text}${ANSI_RESET}`;
}