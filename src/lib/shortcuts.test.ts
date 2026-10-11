/**
 * Shortcut registry unit tests (docs/plans/058 phase 1).
 *
 * Covers: registry structure (sections), parseCombo canonicalization,
 * platformMod, matches on defaults and overrides, the bareKeyOnly
 * input-focus gate, modLocked, the reserved-keystroke guard in matches(),
 * formatCombo, ctrlByteForCombo, and the netssh:shortcuts dispatch from
 * setOverrides.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  SECTION_TITLES,
  SHORTCUT_DEFS,
  SHORTCUT_SECTIONS,
  ctrlByteForCombo,
  findMapConflict,
  formatCombo,
  getOverrides,
  initShortcuts,
  matches,
  parseCombo,
  platformMod,
  reservedComboReason,
  resolvedCombo,
  setOverrides,
} from "./shortcuts";
import { createHarness } from "../../tests/harness";

interface Mods {
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
}

const key = (k: string, mods: Mods = {}) =>
  new KeyboardEvent("keydown", {
    key: k,
    ctrlKey: !!mods.ctrl,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
    metaKey: !!mods.meta,
  });

/** Pin the platform so results do not depend on the host running vitest.
 *  Default stub = Windows/Linux semantics ("Ctrl"); mac tests re-stub. */
function stubPlatform(platform: string, userAgent: string): () => void {
  Object.defineProperty(navigator, "platform", { value: platform, configurable: true });
  Object.defineProperty(navigator, "userAgent", { value: userAgent, configurable: true });
  return () => {
    delete (navigator as { platform?: string }).platform;
    delete (navigator as { userAgent?: string }).userAgent;
  };
}

const WIN = () => stubPlatform("", "Mozilla/5.0 jsdom");
const MAC = () => stubPlatform("MacIntel", "Mozilla/5.0 (Macintosh)");

let restorePlatform: () => void;

beforeEach(() => {
  restorePlatform = WIN();
  setOverrides({});
});

afterEach(() => {
  restorePlatform();
});

// ─── registry structure ─────────────────────────────────────────────

describe("registry structure", () => {
  it("every def belongs to a declared section that has a title", () => {
    for (const def of SHORTCUT_DEFS) {
      expect(SHORTCUT_SECTIONS).toContain(def.section);
      expect(SECTION_TITLES[def.section]).toBeTruthy();
    }
  });

  it("every declared section has at least one def", () => {
    for (const section of SHORTCUT_SECTIONS) {
      expect(SHORTCUT_DEFS.some((d) => d.section === section)).toBe(true);
    }
  });
});

// ─── platformMod ─────────────────────────────────────────────────────

describe("platformMod", () => {
  it("returns Ctrl on Windows/Linux", () => {
    expect(platformMod()).toBe("Ctrl");
  });

  it("returns Cmd on macOS", () => {
    const restore = MAC();
    expect(platformMod()).toBe("Cmd");
    restore();
  });
});

// ─── parseCombo ──────────────────────────────────────────────────────

describe("parseCombo canonicalization", () => {
  it("normalizes the platform modifier to Mod", () => {
    expect(parseCombo(key("K", { ctrl: true, shift: true }))).toBe("Mod+Shift+K");
    expect(parseCombo(key("k", { ctrl: true }))).toBe("Mod+K");
    expect(parseCombo(key(",", { ctrl: true }))).toBe("Mod+,");
  });

  it("canonicalizes + to = so zoom-in accepts both keys", () => {
    expect(parseCombo(key("=", { ctrl: true }))).toBe("Mod+=");
    expect(parseCombo(key("+", { ctrl: true, shift: true }))).toBe("Mod+=");
    expect(parseCombo(key("+", { ctrl: true }))).toBe("Mod+=");
  });

  it("emits Space for the space key", () => {
    expect(parseCombo(key(" ", { ctrl: true }))).toBe("Mod+Space");
  });

  it("bare keys are the key itself, shift not a token for punctuation", () => {
    expect(parseCombo(key("/"))).toBe("/");
    expect(parseCombo(key("?", { shift: true }))).toBe("?");
  });

  it("keeps shift explicit for letters", () => {
    expect(parseCombo(key("K", { ctrl: true, shift: true }))).toBe("Mod+Shift+K");
    expect(parseCombo(key("K", { ctrl: true }))).toBe("Mod+K");
  });

  it("returns empty string for modifier-only presses", () => {
    expect(parseCombo(key("Control", { ctrl: true }))).toBe("");
    expect(parseCombo(key("Shift", { shift: true }))).toBe("");
  });

  it("macOS: Cmd is Mod, literal Ctrl stays Ctrl", () => {
    const restore = MAC();
    expect(parseCombo(key("K", { meta: true, shift: true }))).toBe("Mod+Shift+K");
    expect(parseCombo(key("K", { ctrl: true, shift: true }))).toBe("Ctrl+Shift+K");
    restore();
  });
});

// ─── matches ────────────────────────────────────────────────────────

describe("matches on defaults", () => {
  it("resolves every global default", () => {
    expect(matches(key("K", { ctrl: true, shift: true }), "global")).toBe("toggle-kb");
    expect(matches(key(",", { ctrl: true }), "global")).toBe("open-settings");
    expect(matches(key("W", { ctrl: true, shift: true }), "global")).toBe("close-session-tab");
    expect(matches(key("n", { ctrl: true }), "global")).toBe("new-connection");
    expect(matches(key("Q", { ctrl: true, shift: true }), "global")).toBe("disconnect");
    expect(matches(key("=", { ctrl: true }), "global")).toBe("font-zoom-in");
    expect(matches(key("-", { ctrl: true }), "global")).toBe("font-zoom-out");
    expect(matches(key("0", { ctrl: true }), "global")).toBe("font-zoom-reset");
    expect(matches(key("/"), "global")).toBe("focus-search");
    expect(matches(key("?"), "global")).toBe("shortcuts-modal");
  });

  it("resolves terminal-scope defaults and filters by scope", () => {
    expect(matches(key("F", { ctrl: true, shift: true }), "terminal")).toBe("scrollback-search");
    expect(matches(key(" ", { ctrl: true }), "terminal")).toBe("toggle-suggestions");
    // Terminal combos never fire from the global listener, and global
    // combos never fire from the terminal handler.
    expect(matches(key("F", { ctrl: true, shift: true }), "global")).toBeNull();
    expect(matches(key("K", { ctrl: true, shift: true }), "terminal")).toBeNull();
  });

  it("shift-delivery case does not fork the combo", () => {
    expect(matches(key("K", { ctrl: true, shift: true }), "global")).toBe("toggle-kb");
    expect(matches(key("k", { ctrl: true, shift: true }), "global")).toBe("toggle-kb");
  });

  it("does not match unbound or partial combos", () => {
    expect(matches(key("K", { ctrl: true }), "global")).toBeNull(); // Ctrl+K belongs to the shell
    expect(matches(key("x", { ctrl: true }), "global")).toBeNull();
    expect(matches(key("Control", { ctrl: true }), "global")).toBeNull();
    expect(matches(key(","), "global")).toBeNull(); // bare unbound key
  });

  it("zoom-in accepts = and + like the old inline handler", () => {
    expect(matches(key("+", { ctrl: true, shift: true }), "global")).toBe("font-zoom-in");
    expect(matches(key("+", { ctrl: true }), "global")).toBe("font-zoom-in");
  });

  it("Win/Meta combos never match a Mod binding on Windows/Linux", () => {
    expect(matches(key("K", { meta: true, shift: true }), "global")).toBeNull();
  });
});

describe("matches with overrides", () => {
  it("override wins and the old combo stops matching", () => {
    setOverrides({ "toggle-kb": "Mod+Shift+T" });
    expect(matches(key("T", { ctrl: true, shift: true }), "global")).toBe("toggle-kb");
    expect(matches(key("K", { ctrl: true, shift: true }), "global")).toBeNull();
    expect(resolvedCombo("toggle-kb")).toBe("Mod+Shift+T");
  });

  it("unknown ids in a hand-edited map are ignored", () => {
    setOverrides({ "bogus-action": "Mod+X" });
    expect(matches(key("K", { ctrl: true, shift: true }), "global")).toBe("toggle-kb");
    expect(matches(key("X", { ctrl: true }), "global")).toBeNull();
  });

  it("invalid overrides fall back to the default", () => {
    setOverrides({ "toggle-kb": "" });
    expect(matches(key("K", { ctrl: true, shift: true }), "global")).toBe("toggle-kb");
    setOverrides({ "toggle-kb": "Mod" }); // modifier-only string
    expect(matches(key("K", { ctrl: true, shift: true }), "global")).toBe("toggle-kb");
  });

  it("honors an Alt-modifier override", () => {
    setOverrides({ "open-settings": "Mod+Alt+S" });
    expect(matches(key("S", { ctrl: true, alt: true }), "global")).toBe("open-settings");
  });
});

describe("matches on macOS", () => {
  it("resolves Cmd-delivered defaults and keeps literal Ctrl distinct", () => {
    const restore = MAC();
    expect(matches(key(",", { meta: true }), "global")).toBe("open-settings");
    expect(matches(key("W", { meta: true, shift: true }), "global")).toBe("close-session-tab");
    // Literal Ctrl is not the Mac Mod — ⌃, matches nothing.
    expect(matches(key(",", { ctrl: true }), "global")).toBeNull();
    restore();
  });
});

describe("reserved keystrokes never resolve (hand-edited overrides)", () => {
  // The capture UI rejects these combos (reservedComboReason), but a
  // hand-edited config.json can still name them. matches() must keep the
  // physical keystroke on its fixed path — the terminal attach handler
  // consults matches() with no other guard in front of it (AGENTS.md
  // rule 6: Ctrl+W is remote delete-word, never a registry action).
  it("literal Ctrl+W stays pass-through for a hand-edited Mod+W (global scope)", () => {
    setOverrides({ "new-connection": "Mod+W" });
    expect(matches(key("w", { ctrl: true }), "global")).toBeNull();
    // Caps-lock delivery: uppercase W without Shift is still Ctrl+W.
    expect(matches(key("W", { ctrl: true }), "global")).toBeNull();
  });

  it("literal Ctrl+W stays pass-through for a hand-edited Mod+W (terminal scope)", () => {
    setOverrides({ "scrollback-search": "Mod+W" });
    expect(matches(key("w", { ctrl: true }), "terminal")).toBeNull();
  });

  it("literal Ctrl+C / Ctrl+V never resolve — clipboard stays fixed", () => {
    setOverrides({ "open-settings": "Mod+C", "toggle-kb": "Mod+V" });
    expect(matches(key("c", { ctrl: true }), "global")).toBeNull();
    expect(matches(key("v", { ctrl: true }), "global")).toBeNull();
  });

  it("bare Tab never resolves — Tab stays context-sensitive terminal input", () => {
    setOverrides({ "scrollback-search": "Tab" });
    expect(matches(key("Tab"), "terminal")).toBeNull();
  });

  it("macOS: Cmd+W is deliberately not reserved — literal Ctrl+W is", () => {
    const restore = MAC();
    setOverrides({ "scrollback-search": "Mod+W" });
    // Mod+W is Cmd+W on macOS; the spec's reserved list names Ctrl+W only.
    expect(matches(key("w", { meta: true }), "terminal")).toBe("scrollback-search");
    expect(matches(key("w", { ctrl: true }), "terminal")).toBeNull();
    restore();
  });

  it("shifted variants stay free — Ctrl+Shift+W is a registry default", () => {
    setOverrides({ "open-settings": "Mod+Shift+P" });
    expect(matches(key("P", { ctrl: true, shift: true }), "global")).toBe("open-settings");
  });
});

describe("bareKeyOnly input-focus gate", () => {
  it("bare keys do not fire while an input has focus", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    try {
      expect(matches(key("/"), "global")).toBeNull();
      expect(matches(key("?"), "global")).toBeNull();
    } finally {
      input.remove();
    }
    expect(matches(key("/"), "global")).toBe("focus-search");
  });

  it("modifier combos still fire while an input has focus", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    try {
      expect(matches(key("K", { ctrl: true, shift: true }), "global")).toBe("toggle-kb");
    } finally {
      input.remove();
    }
  });
});

describe("modLocked", () => {
  it("Ctrl+Space matches via ctrlKey on Windows/Linux", () => {
    expect(matches(key(" ", { ctrl: true }), "terminal")).toBe("toggle-suggestions");
  });

  it("macOS: literal Ctrl matches, Cmd (platform Mod) does not", () => {
    const restore = MAC();
    expect(matches(key(" ", { ctrl: true }), "terminal")).toBe("toggle-suggestions");
    expect(matches(key(" ", { meta: true }), "terminal")).toBeNull();
    restore();
  });
});

// ─── formatCombo ────────────────────────────────────────────────────

describe("formatCombo", () => {
  it("renders plain text on Windows/Linux", () => {
    expect(formatCombo("Mod+Shift+K")).toBe("Ctrl+Shift+K");
    expect(formatCombo("Ctrl+Space")).toBe("Ctrl+Space");
    expect(formatCombo("Mod+=")).toBe("Ctrl+=");
    expect(formatCombo("/")).toBe("/");
  });

  it("renders platform symbols on macOS", () => {
    const restore = MAC();
    expect(formatCombo("Mod+Shift+K")).toBe("⌘⇧K");
    expect(formatCombo("Ctrl+Space")).toBe("⌃Space");
    expect(formatCombo("Mod+=")).toBe("⌘=");
    restore();
  });
});

// ─── ctrlByteForCombo ───────────────────────────────────────────────

describe("ctrlByteForCombo", () => {
  it("maps single-Ctrl combos to control bytes", () => {
    expect(ctrlByteForCombo("Ctrl+Space")).toBe("\x00");
    expect(ctrlByteForCombo("Ctrl+O")).toBe("\x0F");
    expect(ctrlByteForCombo("Ctrl+Shift+O")).toBe("\x0F"); // shift collapses
  });

  it("resolves Mod to Ctrl on Windows/Linux", () => {
    expect(ctrlByteForCombo("Mod+Space")).toBe("\x00");
    expect(ctrlByteForCombo("Mod+O")).toBe("\x0F");
    expect(ctrlByteForCombo("Mod+Shift+K")).toBe("\x0B"); // shift collapses
  });

  it("returns null for Cmd combos, multi-key and bare combos", () => {
    expect(ctrlByteForCombo("Cmd+O")).toBeNull();
    expect(ctrlByteForCombo("/")).toBeNull();
    expect(ctrlByteForCombo("?")).toBeNull();
    expect(ctrlByteForCombo("Ctrl+Alt+P")).toBeNull();
    expect(ctrlByteForCombo("Ctrl+Enter")).toBeNull();
    expect(ctrlByteForCombo("")).toBeNull();
  });

  it("macOS: Mod is Cmd — null; literal Ctrl still maps", () => {
    const restore = MAC();
    expect(ctrlByteForCombo("Mod+O")).toBeNull();
    expect(ctrlByteForCombo("Ctrl+O")).toBe("\x0F");
    restore();
  });

  it("no other action's resolved combo maps to \\x00", () => {
    for (const def of SHORTCUT_DEFS) {
      if (def.id === "toggle-suggestions") continue;
      expect(ctrlByteForCombo(resolvedCombo(def.id)), `default combo of ${def.id}`).not.toBe("\x00");
    }
    setOverrides({ "open-settings": "Mod+Alt+S" });
    for (const def of SHORTCUT_DEFS) {
      if (def.id === "toggle-suggestions") continue;
      expect(ctrlByteForCombo(resolvedCombo(def.id)), `resolved combo of ${def.id}`).not.toBe("\x00");
    }
  });
});

// ─── validation (settings pane) ──────────────────────────────────────

describe("getOverrides", () => {
  it("returns a copy of the current overrides, not a live reference", () => {
    setOverrides({ "toggle-kb": "Mod+Shift+T" });
    const map = getOverrides();
    expect(map).toEqual({ "toggle-kb": "Mod+Shift+T" });
    map["toggle-kb"] = "Mod+K";
    expect(getOverrides()["toggle-kb"]).toBe("Mod+Shift+T");
  });
});

describe("reservedComboReason", () => {
  it("reserves pass-through, clipboard, Tab and Escape semantics", () => {
    expect(reservedComboReason("Mod+W")).toBeTruthy();
    expect(reservedComboReason("Ctrl+W")).toBeTruthy();
    expect(reservedComboReason("Mod+C")).toBeTruthy();
    expect(reservedComboReason("Ctrl+C")).toBeTruthy();
    expect(reservedComboReason("Mod+V")).toBeTruthy();
    expect(reservedComboReason("Ctrl+V")).toBeTruthy();
    expect(reservedComboReason("Tab")).toBeTruthy();
    expect(reservedComboReason("Escape")).toBeTruthy();
  });

  it("macOS: Cmd+W and literal Ctrl+W are both reserved", () => {
    const restore = MAC();
    expect(reservedComboReason("Mod+W")).toBeTruthy();
    expect(reservedComboReason("Ctrl+W")).toBeTruthy();
    restore();
  });

  it("allows shifted variants, registry defaults, and free combos", () => {
    expect(reservedComboReason("Mod+Shift+W")).toBeNull(); // close-tab default
    expect(reservedComboReason("Mod+Shift+C")).toBeNull();
    expect(reservedComboReason("Ctrl+Space")).toBeNull(); // toggle-suggestions default
    expect(reservedComboReason("Mod+Shift+K")).toBeNull();
    expect(reservedComboReason("/")).toBeNull();
    expect(reservedComboReason("?")).toBeNull();
    expect(reservedComboReason("Mod+Shift+Tab")).toBeNull(); // only bare Tab is fixed
  });
});

describe("findMapConflict", () => {
  it("the defaults map is conflict-free", () => {
    expect(findMapConflict({})).toBeNull();
  });

  it("detects an override colliding with another def, across scopes", () => {
    // open-settings (global) rebinds onto scrollback-search's default (terminal)
    const c = findMapConflict({ "open-settings": "Mod+Shift+F" });
    expect(c).toBeTruthy();
    expect([c!.a, c!.b].sort()).toEqual(["open-settings", "scrollback-search"].sort());
  });

  it("detects two overrides colliding with each other", () => {
    const c = findMapConflict({ "focus-search": "Mod+Shift+T", "toggle-kb": "Mod+Shift+T" });
    expect(c).toBeTruthy();
  });

  it("an override equal to its own default is not a conflict", () => {
    expect(findMapConflict({ "toggle-kb": "Mod+Shift+K" })).toBeNull();
  });

  it("an unparseable override falls back to the def default", () => {
    expect(findMapConflict({ "toggle-kb": "not+a+combo++" })).toBeNull();
  });
});

// ─── setOverrides dispatch + initShortcuts ───────────────────────────

describe("setOverrides dispatch", () => {
  it("dispatches netssh:shortcuts with the new map", () => {
    const spy = vi.fn();
    window.addEventListener("netssh:shortcuts", spy);
    try {
      setOverrides({ "toggle-kb": "Mod+Shift+T" });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0].detail).toEqual({ "toggle-kb": "Mod+Shift+T" });
    } finally {
      window.removeEventListener("netssh:shortcuts", spy);
    }
  });
});

describe("initShortcuts", () => {
  it("seeds overrides from app config", async () => {
    const harness = createHarness();
    harness.ipc.mockImpl("get_app_config", () => ({ shortcuts: { "toggle-kb": "Mod+Shift+B" } }));
    await initShortcuts();
    expect(resolvedCombo("toggle-kb")).toBe("Mod+Shift+B");
    expect(matches(key("B", { ctrl: true, shift: true }), "global")).toBe("toggle-kb");
  });

  it("missing shortcuts key leaves defaults", async () => {
    const harness = createHarness();
    harness.ipc.mockImpl("get_app_config", () => ({}));
    await initShortcuts();
    expect(resolvedCombo("toggle-kb")).toBe("Mod+Shift+K");
  });
});

// ─── registry sanity ────────────────────────────────────────────────

describe("SHORTCUT_DEFS", () => {
  it("defaults match the spec table and are unique per id", () => {
    expect(SHORTCUT_DEFS.length).toBe(12);
    const ids = new Set(SHORTCUT_DEFS.map((d) => d.id));
    expect(ids.size).toBe(SHORTCUT_DEFS.length);
    for (const def of SHORTCUT_DEFS) {
      // Every default must at least parse.
      expect(resolvedCombo(def.id)).not.toBe("");
    }
  });

  it("new-connection and disconnect resolve to their spec-table defaults", () => {
    expect(resolvedCombo("new-connection")).toBe("Mod+N");
    expect(resolvedCombo("disconnect")).toBe("Mod+Shift+Q");
  });
});