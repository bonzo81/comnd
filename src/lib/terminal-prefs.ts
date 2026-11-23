/**
 * Terminal preferences — single source of truth, persisted in Web Storage and
 * synced across tabs via window CustomEvent. Mode-independent: the terminal
 * zoom shortcuts, Reading Comfort mode and the Settings panes all read/write
 * these keys.
 *
 * Follows the output-highlight / timestamps toggle pattern (key + event).
 */

import { readStorage, writeStorage } from "./storage";

const SIZE_KEY = "comnd-terminal-font-size";
const SCROLLBACK_KEY = "comnd-terminal-scrollback";

export const TERMINAL_FONT_MIN = 8;
export const TERMINAL_FONT_MAX = 32;
export const TERMINAL_FONT_DEFAULT = 14;

// Scrollback memory: xterm stores 12 bytes per cell (3 × Uint32) and only
// allocates a line's cells once the line exists, so an upper bound is
// lines × cols × 12 bytes. At a typical 160 columns, 1,000 lines ≈ 1.9 MB,
// 10,000 ≈ 19 MB and 50,000 ≈ 96 MB (at 200 cols: ~2.4 MB / ~24 MB / ~120 MB).
// 1,000 is xterm's own default, so the floor keeps the previous behaviour
// reachable; 10,000 holds a large `show running-config` without the default
// being invisible in code.
export const TERMINAL_SCROLLBACK_MIN = 1_000;
export const TERMINAL_SCROLLBACK_MAX = 50_000;
export const TERMINAL_SCROLLBACK_DEFAULT = 10_000;

function clampFont(px: number): number {
  return Math.min(Math.max(Math.round(px), TERMINAL_FONT_MIN), TERMINAL_FONT_MAX);
}

function clampScrollback(lines: number): number {
  return Math.min(Math.max(Math.round(lines), TERMINAL_SCROLLBACK_MIN), TERMINAL_SCROLLBACK_MAX);
}

export function getTerminalFontSize(): number {
  const raw = parseInt(readStorage(SIZE_KEY) ?? "", 10);
  if (!Number.isFinite(raw)) return TERMINAL_FONT_DEFAULT;
  return clampFont(raw);
}

export function setTerminalFontSize(px: number): void {
  const clamped = clampFont(px);
  writeStorage(SIZE_KEY, String(clamped));
  window.dispatchEvent(new CustomEvent("comnd:terminal-font-size", { detail: clamped }));
}

export function getTerminalScrollback(): number {
  const raw = parseInt(readStorage(SCROLLBACK_KEY) ?? "", 10);
  if (!Number.isFinite(raw)) return TERMINAL_SCROLLBACK_DEFAULT;
  return clampScrollback(raw);
}

export function setTerminalScrollback(lines: number): void {
  const clamped = clampScrollback(lines);
  writeStorage(SCROLLBACK_KEY, String(clamped));
  window.dispatchEvent(new CustomEvent("comnd:terminal-scrollback", { detail: clamped }));
}
