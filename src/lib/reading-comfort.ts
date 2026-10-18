/**
 * Reading Comfort mode — a preset *initialiser*, not a lock. ON stamps
 * evidence-based readability defaults into the individual controls; every
 * value stays adjustable via sliders afterwards. OFF reverts typography only
 * (font size from `prevFontSize`, scale/attribute removed); the user's theme
 * choice is kept.
 *
 * User-adjusted values survive a toggle cycle: the key persists across OFF
 * (an `enabled` flag flips) and `lastFontSize` remembers the size last used
 * while ON. Re-enabling restores those values instead of re-stamping the
 * preset. First-ever ON still stamps defaults.
 *
 * Persistence: localStorage `comnd-reading-comfort` (flat object, created on
 * first ON, kept across OFF) + `comnd-terminal-font-size` (via
 * terminal-prefs). Presentational → localStorage, never config.json.
 * Zero Rust changes.
 *
 * Derived tokens (--ghost-opacity, --prose-*) and the fixed non-slider bumps
 * are driven by the `data-reading-comfort="on"` attribute in CSS; this module
 * only sets the slider-driven `--text-scale` inline plus that one attribute.
 *
 * See docs/specs/12-dyslexia-mode.md (source of truth) and
 * docs/plans/plan-reading-comfort.md.
 */

import { getTerminalFontSize, setTerminalFontSize } from "./terminal-prefs";
import { getTerminalTheme, setTerminalTheme, getAppTheme, setAppTheme } from "./theme";

export interface ReadingComfortState {
  prevFontSize: number; // font size before the mode was enabled — OFF restore target
  uiScale: number; // --text-scale, 1.0–1.5
  lineHeight: number; // xterm lineHeight (em), 1.0–1.8
  letterSpacing: number; // xterm letterSpacing (px), 0–6
}

/** Stored shape — internal. `enabled` flag + `lastFontSize` make the toggle
 *  cycle lossless: OFF never deletes the key, re-ON restores user values. */
interface StoredRC extends ReadingComfortState {
  enabled: boolean;
  lastFontSize?: number; // size last used while ON — re-ON restore target
}

const KEY = "comnd-reading-comfort";

export const RC_PRESET = { fontSize: 16, uiScale: 1.15, lineHeight: 1.4, letterSpacing: 2 };

const UI_SCALE_MIN = 1.0;
const UI_SCALE_MAX = 1.5;
const LINE_HEIGHT_MIN = 1.0;
const LINE_HEIGHT_MAX = 1.8;
const LETTER_SPACING_MIN = 0;
const LETTER_SPACING_MAX = 6;

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

/** Parse the stored key regardless of enabled state. Corrupt JSON → null. */
function readStored(): StoredRC | null {
  const raw = localStorage.getItem(KEY);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    if (typeof p !== "object" || p === null || typeof p.prevFontSize !== "number") return null;
    return {
      enabled: typeof p.enabled === "boolean" ? p.enabled : true, // legacy keys were on-only
      prevFontSize: p.prevFontSize,
      lastFontSize: typeof p.lastFontSize === "number" ? p.lastFontSize : undefined,
      uiScale: typeof p.uiScale === "number" ? p.uiScale : RC_PRESET.uiScale,
      lineHeight: typeof p.lineHeight === "number" ? p.lineHeight : RC_PRESET.lineHeight,
      letterSpacing: typeof p.letterSpacing === "number" ? p.letterSpacing : RC_PRESET.letterSpacing,
    };
  } catch {
    return null; // corrupt JSON → treated as off
  }
}

/** Public getter — null while off (consumers keep treating null as "off"). */
export function getReadingComfortState(): ReadingComfortState | null {
  const s = readStored();
  if (!s || !s.enabled) return null;
  return { prevFontSize: s.prevFontSize, uiScale: s.uiScale, lineHeight: s.lineHeight, letterSpacing: s.letterSpacing };
}

export function isReadingComfortEnabled(): boolean {
  return getReadingComfortState() !== null;
}

function write(state: StoredRC): void {
  localStorage.setItem(KEY, JSON.stringify(state));
}

/** Enable. First-ever ON stamps the preset; re-ON restores remembered values
 *  (including last-used font size). Themes re-stamp on every ON. */
export function enable(): void {
  const stored = readStored();
  if (stored?.enabled) return; // already on — snapshotting again would corrupt prevFontSize
  const prevFontSize = getTerminalFontSize();
  if (stored) {
    write({ ...stored, enabled: true, prevFontSize });
    setTerminalFontSize(stored.lastFontSize ?? RC_PRESET.fontSize);
  } else {
    write({
      enabled: true,
      prevFontSize,
      lastFontSize: RC_PRESET.fontSize,
      uiScale: RC_PRESET.uiScale,
      lineHeight: RC_PRESET.lineHeight,
      letterSpacing: RC_PRESET.letterSpacing,
    });
    setTerminalFontSize(RC_PRESET.fontSize);
  }
  stampThemes();
  applyReadingComfort();
}

/** Restore font size from prevFontSize, flip enabled off (key kept — values
 *  survive for the next ON), clear DOM. Themes persist. */
export function disable(): void {
  const stored = readStored();
  if (!stored?.enabled) return;
  write({ ...stored, enabled: false, lastFontSize: getTerminalFontSize() });
  setTerminalFontSize(stored.prevFontSize);
  clearDom();
  window.dispatchEvent(new CustomEvent("comnd:reading-comfort", { detail: false }));
}

/** Slider path — patch one or more fields, clamp ranges, re-apply. */
export function update(partial: Partial<ReadingComfortState>): void {
  const stored = readStored();
  if (!stored?.enabled) return; // only meaningful while on
  if (typeof partial.uiScale === "number") stored.uiScale = clamp(partial.uiScale, UI_SCALE_MIN, UI_SCALE_MAX);
  if (typeof partial.lineHeight === "number") stored.lineHeight = clamp(partial.lineHeight, LINE_HEIGHT_MIN, LINE_HEIGHT_MAX);
  if (typeof partial.letterSpacing === "number") stored.letterSpacing = clamp(partial.letterSpacing, LETTER_SPACING_MIN, LETTER_SPACING_MAX);
  write(stored);
  applyReadingComfort();
}

/** Rewrite all preset values over the current state (font size → 16). */
export function resetToPreset(): void {
  const stored = readStored();
  if (!stored?.enabled) return;
  stored.uiScale = RC_PRESET.uiScale;
  stored.lineHeight = RC_PRESET.lineHeight;
  stored.letterSpacing = RC_PRESET.letterSpacing;
  stored.lastFontSize = RC_PRESET.fontSize;
  write(stored);
  setTerminalFontSize(RC_PRESET.fontSize);
  applyReadingComfort();
}

/** Stock-id theme stamping only (spec §Mode semantics). */
function stampThemes(): void {
  const t = getTerminalTheme();
  if (t === "dark") setTerminalTheme("warm-charcoal");
  else if (t === "light") setTerminalTheme("cream");
  const app = getAppTheme();
  if (app === "light" || app === "solarized-light") setAppTheme("solarized-light");
}

/** Set slider-driven --text-scale + the mode attribute; notify terminals. */
export function applyReadingComfort(): void {
  const state = getReadingComfortState();
  if (!state) {
    clearDom();
    return;
  }
  document.documentElement.style.setProperty("--text-scale", String(state.uiScale));
  document.documentElement.dataset.readingComfort = "on";
  window.dispatchEvent(new CustomEvent("comnd:reading-comfort", { detail: state }));
}

function clearDom(): void {
  const root = document.documentElement;
  root.style.removeProperty("--text-scale");
  if (root.dataset.readingComfort) delete root.dataset.readingComfort;
}