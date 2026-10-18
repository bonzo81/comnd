/**
 * Terminal font size — single source of truth, persisted in localStorage and
 * synced across tabs via window CustomEvent. Mode-independent: the terminal
 * zoom shortcuts and Reading Comfort mode both read/write this one key.
 *
 * Follows the output-highlight / timestamps toggle pattern (key + event).
 */

const SIZE_KEY = "comnd-terminal-font-size";

export const TERMINAL_FONT_MIN = 8;
export const TERMINAL_FONT_MAX = 32;
export const TERMINAL_FONT_DEFAULT = 14;

function clamp(px: number): number {
  return Math.min(Math.max(Math.round(px), TERMINAL_FONT_MIN), TERMINAL_FONT_MAX);
}

export function getTerminalFontSize(): number {
  const raw = parseInt(localStorage.getItem(SIZE_KEY) ?? "", 10);
  if (!Number.isFinite(raw)) return TERMINAL_FONT_DEFAULT;
  return clamp(raw);
}

export function setTerminalFontSize(px: number): void {
  const clamped = clamp(px);
  localStorage.setItem(SIZE_KEY, String(clamped));
  window.dispatchEvent(new CustomEvent("comnd:terminal-font-size", { detail: clamped }));
}
