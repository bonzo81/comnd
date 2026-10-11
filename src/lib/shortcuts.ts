/**
 * Shortcut registry — the single source of truth for key bindings
 * (docs/specs/11-shortcut-customization.md).
 *
 * One table drives the global handler (main.ts), the terminal-scope handler
 * (terminal-view.ts, suggestion-controller.ts), the shortcuts help modal,
 * and the Settings pane. Canonical combos are platform-agnostic: "Mod" is
 * the platform modifier (Ctrl on Windows/Linux, Cmd on macOS) and resolves
 * at match and display time. Terminal-scope bindings that must emit control
 * bytes to the remote (Ctrl+Space) pin literal "Ctrl" via modLocked.
 *
 * Fixed semantics stay OUTSIDE the registry (AGENTS.md): the Ctrl+W
 * pass-through guard, Tab / arrows / Enter / Escape widget navigation, and
 * Ctrl+C / Ctrl+V clipboard handling are never mappable.
 */

import { getAppConfig } from "./tauri-api";

// ─── Definitions ─────────────────────────────────────────────────────

export type ShortcutAction =
  | "open-settings"
  | "toggle-kb"
  | "close-session-tab"
  | "font-zoom-in"
  | "font-zoom-out"
  | "font-zoom-reset"
  | "toggle-suggestions" // terminal scope
  | "scrollback-search" // terminal scope
  | "focus-search" // bare key
  | "shortcuts-modal"; // bare key
// Phase 5 adds: "new-connection" | "disconnect".

export type ShortcutScope = "global" | "terminal";

/** UI grouping — mirrors the docs/07 sections. */
export type ShortcutSection = "navigation" | "view" | "terminal";

export interface ShortcutDef {
  id: ShortcutAction;
  /** Shown in the help modal and settings rows. */
  label: string;
  /** Canonical, platform-agnostic combo ("Mod+Shift+K", "/", "?"). */
  defaultKey: string;
  scope: ShortcutScope;
  section: ShortcutSection;
  /** Bare keys ("/", "?") only fire when the focus is not in an input. */
  bareKeyOnly?: boolean;
  /** Pinned to literal Ctrl on every platform — the terminal byte path
   *  needs a control byte, and Cmd+Space collides with macOS Spotlight.
   *  Settings shows these locked and non-editable. */
  modLocked?: boolean;
}

/** Section order for the help modal and the settings pane. */
export const SHORTCUT_SECTIONS: ShortcutSection[] = ["navigation", "view", "terminal"];

/** Display titles per section — help modal headers and settings groups. */
export const SECTION_TITLES: Record<ShortcutSection, string> = {
  navigation: "Navigation",
  view: "View",
  terminal: "Terminal",
};

/** The registry. Handlers, the help modal, and Settings all read this. */
export const SHORTCUT_DEFS: ShortcutDef[] = [
  // Navigation
  { id: "open-settings", label: "Open settings", defaultKey: "Mod+,", scope: "global", section: "navigation" },
  { id: "focus-search", label: "Focus global search", defaultKey: "/", scope: "global", section: "navigation", bareKeyOnly: true },
  // View
  { id: "toggle-kb", label: "Toggle Knowledge Base", defaultKey: "Mod+Shift+K", scope: "global", section: "view" },
  { id: "shortcuts-modal", label: "Toggle shortcuts help", defaultKey: "?", scope: "global", section: "view", bareKeyOnly: true },
  { id: "font-zoom-in", label: "Zoom terminal font in", defaultKey: "Mod+=", scope: "global", section: "view" },
  { id: "font-zoom-out", label: "Zoom terminal font out", defaultKey: "Mod+-", scope: "global", section: "view" },
  { id: "font-zoom-reset", label: "Reset terminal font size", defaultKey: "Mod+0", scope: "global", section: "view" },
  // Terminal
  { id: "close-session-tab", label: "Close session tab", defaultKey: "Mod+Shift+W", scope: "global", section: "terminal" },
  { id: "scrollback-search", label: "Scrollback search", defaultKey: "Mod+Shift+F", scope: "terminal", section: "terminal" },
  { id: "toggle-suggestions", label: "Toggle suggestions", defaultKey: "Ctrl+Space", scope: "terminal", section: "terminal", modLocked: true },
];

// ─── Platform resolution ────────────────────────────────────────────

/** The platform modifier: Ctrl on Windows/Linux, Cmd on macOS. */
export function platformMod(): "Ctrl" | "Cmd" {
  if (typeof navigator === "undefined") return "Ctrl";
  const plat = typeof navigator.platform === "string" ? navigator.platform : "";
  const ua = typeof navigator.userAgent === "string" ? navigator.userAgent : "";
  return /mac|iphone|ipad|ipod|darwin/i.test(`${plat} ${ua}`) ? "Cmd" : "Ctrl";
}

// ─── Combo parsing ──────────────────────────────────────────────────

/** Keydowns that are only a modifier press — no complete combo yet. */
const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "OS", "Dead", "Unidentified"]);

/** Modifier names that may appear in a canonical combo string. */
const MODIFIER_TOKENS = new Set(["Mod", "Ctrl", "Cmd", "Meta", "Shift", "Alt"]);

/** Normalize a key to its canonical token: letters uppercased, " " → Space,
 *  "+" → "=" (the zoom-in combo accepts = and + exactly like the old
 *  inline handler did). */
function keyToken(key: string): string {
  if (key === " ") return "Space";
  if (key === "+") return "=";
  if (key.length === 1) return key.toUpperCase();
  return key;
}

/** A combo split into matchable parts. mod/ctrl/cmd are kept distinct so
 *  modLocked defs can demand literal Ctrl even on macOS (where Mod = Cmd). */
interface ParsedCombo {
  mod: boolean;
  ctrl: boolean;
  cmd: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

/** Parse a canonical combo string ("Mod+Shift+K") into parts.
 *  Returns null when the string is empty or has no key part
 *  (unknown/invalid overrides fall back to their def default). */
function parseComboString(combo: string): ParsedCombo | null {
  if (!combo) return null;
  const parts = combo.split("+");
  const key = keyToken(parts.pop() ?? "");
  if (!key || MODIFIER_TOKENS.has(key)) return null;
  const out: ParsedCombo = { mod: false, ctrl: false, cmd: false, shift: false, alt: false, key };
  for (const p of parts) {
    if (p === "Mod") out.mod = true;
    else if (p === "Ctrl") out.ctrl = true;
    else if (p === "Cmd" || p === "Meta") out.cmd = true;
    else if (p === "Shift") out.shift = true;
    else if (p === "Alt") out.alt = true;
  }
  return out;
}

/** Canonical combo string for a keyboard event. The platform modifier
 *  normalizes to "Mod" (Ctrl+Shift+K on Windows and Cmd+Shift+K on macOS
 *  both parse to "Mod+Shift+K"); literal Ctrl on macOS stays "Ctrl".
 *  Shift is only a token for letters — punctuation keys carry it
 *  inherently ("?" is Shift+/ on every layout that has it). */
export function parseCombo(e: KeyboardEvent): string {
  const key = e.key;
  if (!key || MODIFIER_KEYS.has(key)) return "";
  const mod = platformMod();
  const mods: string[] = [];
  if (mod === "Cmd" ? e.metaKey : e.ctrlKey) mods.push("Mod");
  if (mod === "Cmd" && e.ctrlKey) mods.push("Ctrl");
  if (mod !== "Cmd" && e.metaKey) mods.push("Meta");
  const letter = key.length === 1 && /[a-z]/i.test(key);
  if (e.shiftKey && letter) mods.push("Shift");
  if (e.altKey) mods.push("Alt");
  const k = keyToken(key);
  return mods.length ? `${mods.join("+")}+${k}` : k;
}

// ─── Matching ───────────────────────────────────────────────────────

/** Alias the platform's primary modifier: on Windows/Linux Ctrl is both
 *  "Mod" and "Ctrl" (same physical key); on macOS Cmd is both "Mod" and
 *  "Cmd". Literal Ctrl on macOS stays distinct from Mod. */
function normalizeForPlatform(p: ParsedCombo): ParsedCombo {
  if (platformMod() === "Cmd") {
    return p.mod || p.cmd ? { ...p, mod: true, cmd: true } : p;
  }
  return p.mod || p.ctrl ? { ...p, mod: true, ctrl: true } : p;
}

function combosEqual(a: ParsedCombo, b: ParsedCombo): boolean {
  return (
    a.mod === b.mod && a.ctrl === b.ctrl && a.cmd === b.cmd &&
    a.shift === b.shift && a.alt === b.alt && a.key === b.key
  );
}

/** The focus check the old inline handlers ran for bare keys: "/" and "?"
 *  never fire while typing in an input (the xterm helper textarea
 *  included — typing "/" in the terminal goes to the remote). */
function focusInInput(): boolean {
  if (typeof document === "undefined") return false;
  const t = document.activeElement;
  return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement;
}

/** Resolve an event to a registry action within `scope`, or null.
 *  Overrides win over defaults; unknown ids in the map are ignored and
 *  unparseable combos fall back to the def default. */
export function matches(e: KeyboardEvent, scope: ShortcutScope): ShortcutAction | null {
  const key = e.key;
  if (!key || MODIFIER_KEYS.has(key)) return null;
  const mod = platformMod();
  const ev: ParsedCombo = {
    mod: mod === "Cmd" ? e.metaKey : e.ctrlKey,
    ctrl: e.ctrlKey,
    cmd: e.metaKey,
    shift: e.shiftKey && key.length === 1 && /[a-z]/i.test(key),
    alt: e.altKey,
    key: keyToken(key),
  };
  const evNorm = normalizeForPlatform(ev);
  const inInput = focusInInput();
  for (const def of SHORTCUT_DEFS) {
    if (def.scope !== scope) continue;
    if (def.bareKeyOnly && inInput) continue;
    const parsed = parseComboString(resolvedCombo(def.id));
    if (!parsed) continue;
    if (combosEqual(normalizeForPlatform(parsed), evNorm)) return def.id;
  }
  return null;
}

// ─── Overrides + persistence ────────────────────────────────────────

/** actionId -> canonical combo. Only ids present in SHORTCUT_DEFS are
 *  ever consulted; anything else in the map is ignored. */
const overrides = new Map<string, string>();

/** The combo for `id`: the user override when one is set and parses,
 *  otherwise the default. */
export function resolvedCombo(id: ShortcutAction): string {
  const def = SHORTCUT_DEFS.find((d) => d.id === id);
  if (!def) return "";
  const o = overrides.get(id);
  return o && parseComboString(o) ? o : def.defaultKey;
}

/** Replace the overrides map and notify listeners (the open help modal
 *  and settings pane re-render on "netssh:shortcuts"). */
export function setOverrides(map: Record<string, string>): void {
  overrides.clear();
  for (const [k, v] of Object.entries(map)) {
    if (typeof v === "string" && v) overrides.set(k, v);
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("netssh:shortcuts", { detail: { ...map } }));
  }
}

/** Copy of the current overrides map — the settings pane edits a copy,
 *  then saves it back through setOverrides. */
export function getOverrides(): Record<string, string> {
  return Object.fromEntries(overrides);
}

/** Seed overrides from app config. Called once at boot, before the global
 *  shortcut handler registers; until it resolves, matches() runs on
 *  defaults — no race. */
export async function initShortcuts(): Promise<void> {
  try {
    const config = await getAppConfig();
    setOverrides(config.shortcuts ?? {});
  } catch {
    // Config unreadable — defaults stand.
  }
}

// ─── Display + control-byte lookup ──────────────────────────────────

/** Display label for a canonical combo: "Ctrl+Shift+K" on Windows/Linux,
 *  platform symbols on macOS ("⌘⇧K" — spec 11 §macOS). */
export function formatCombo(combo: string): string {
  const p = parseComboString(combo);
  if (!p) return combo;
  if (platformMod() === "Cmd") {
    const parts: string[] = [];
    if (p.mod || p.cmd) parts.push("⌘");
    if (p.ctrl) parts.push("⌃");
    if (p.shift) parts.push("⇧");
    if (p.alt) parts.push("⌥");
    return parts.join("") + p.key;
  }
  const parts: string[] = [];
  if (p.mod || p.ctrl) parts.push("Ctrl");
  if (p.cmd) parts.push("Meta");
  if (p.shift) parts.push("Shift");
  if (p.alt) parts.push("Alt");
  parts.push(p.key);
  return parts.join("+");
}

/** Control byte a single-Ctrl combo sends to the remote ("Ctrl+Space" →
 *  "\x00", "Ctrl+O" → "\x0F"; Shift collapses — Ctrl+Shift+O sends the
 *  same byte). "Mod" resolves to Ctrl on Windows/Linux and to nothing on
 *  macOS (Cmd combos have no control byte). Null for anything else — the
 *  binding is inert in the terminal byte path (only reachable by
 *  hand-editing config; Settings locks these defs). */
export function ctrlByteForCombo(combo: string): string | null {
  const p = parseComboString(combo);
  if (!p) return null;
  const isCtrl = p.ctrl || (p.mod && platformMod() === "Ctrl");
  if (!isCtrl || p.cmd || p.alt) return null;
  const code = p.key === "Space" ? 32 : p.key.length === 1 ? p.key.charCodeAt(0) : -1;
  if (code < 0) return null;
  return String.fromCharCode(code & 0x1f);
}

// ─── Validation (settings pane) ─────────────────────────────────────

/** Combos that can never be assigned (spec 11 fixed table + §Settings
 *  UI): they are interaction semantics, not shortcuts. Returns the
 *  explanation shown in the capture row, or null when the combo is free.
 *  Only the unshifted forms are reserved — Ctrl+Shift+W is a registry
 *  default, and the copy/paste handlers match the unshifted key. */
export function reservedComboReason(combo: string): string | null {
  const p = parseComboString(combo);
  if (!p) return null;
  const n = normalizeForPlatform(p);
  const modLike = n.mod || n.ctrl;
  if (n.key === "W" && modLike && !n.shift) {
    return "Ctrl+W always passes through to the remote shell as delete-word — it can never be rebound.";
  }
  if (n.key === "C" && modLike && !n.shift) {
    return "Ctrl+C is copy-with-selection and shell interrupt — clipboard muscle memory keeps it fixed.";
  }
  if (n.key === "V" && modLike && !n.shift) {
    return "Ctrl+V is paste — clipboard muscle memory keeps it fixed.";
  }
  const bare = !modLike && !n.cmd && !n.alt && !n.shift;
  if (n.key === "Tab" && bare) {
    return "Tab is context-sensitive terminal input (accept suggestion or pass through) — it stays fixed.";
  }
  if (n.key === "Escape" && bare) {
    return "Escape dismisses modals and clears suggestions — it stays fixed.";
  }
  return null;
}

/** First pair of actions whose combos collide under `overrides` —
 *  defaults fill any gap, and comparison uses the same platform aliasing
 *  matches() applies, so a conflict here means one binding would be
 *  unreachable at match time. Crosses scopes on purpose (spec 11:
 *  a combo must be unique across the whole registry). Null when the map
 *  is conflict-free. */
export function findMapConflict(overrides: Record<string, string>):
  { a: ShortcutAction; b: ShortcutAction; combo: string } | null {
  const entries = SHORTCUT_DEFS.flatMap((def) => {
    const o = overrides[def.id];
    // Same fallback as resolvedCombo: an unparseable override (hand-edited
    // config) never shadows the default.
    const parsedOverride = o ? parseComboString(o) : null;
    const combo = parsedOverride ? o! : def.defaultKey;
    const parsed = parseComboString(combo);
    return parsed ? [{ id: def.id, combo, norm: normalizeForPlatform(parsed) }] : [];
  });
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (combosEqual(entries[i].norm, entries[j].norm)) {
        return { a: entries[i].id, b: entries[j].id, combo: entries[i].combo };
      }
    }
  }
  return null;
}