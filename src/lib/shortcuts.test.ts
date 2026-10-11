/**
 * Shortcut registry unit tests (docs/plans/058 phase 1).
 *
 * Covers: registry structure (sections), parseCombo canonicalization,
 * platformMod, matches on defaults and overrides, the bareKeyOnly
 * input-focus gate, modLocked, formatCombo, ctrlByteForCombo, and the
 * netssh:shortcuts dispatch from setOverrides.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  SECTION_TITLES,
  SHORTCUT_DEFS,
  SHORTCUT_SECTIONS,
  ctrlByteForCombo,
  formatCombo,
  initShortcuts,
  matches,
  parseCombo,
  platformMod,
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

  it("does not match unbound or partial combos", () => {
    expect(matches(key("K", { ctrl: true }), "global")).toBeNull(); // Ctrl+K belongs to the shell
    expect(matches(key("x", { ctrl: true }), "global")).toBeNull();
    expect(matches(key("Control", { ctrl: true }), "global")).toBeNull();
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
    expect(SHORTCUT_DEFS.length).toBe(10);
    const ids = new Set(SHORTCUT_DEFS.map((d) => d.id));
    expect(ids.size).toBe(SHORTCUT_DEFS.length);
    for (const def of SHORTCUT_DEFS) {
      // Every default must at least parse.
      expect(resolvedCombo(def.id)).not.toBe("");
    }
  });
});