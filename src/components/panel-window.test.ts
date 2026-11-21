import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { mountPanelWindow, applyPanelPreferences, type PanelWindowBridge } from "./panel-window";
import { ariaKeyShortcuts, platformMod, setOverrides } from "../lib/shortcuts";
import type { SidePanelAction, SidePanelState } from "../lib/side-panel";
import type { Command } from "../lib/tauri-api";

/**
 * The undocked panel is the only window the user can close, dock or navigate
 * without the terminal, so its controls are the ones a regression would strand
 * them with. These tests drive it through a fake bridge: no Tauri, no window.
 */

function makeCommand(over: Partial<Command> = {}): Command {
  return {
    name: "show",
    syntax: "show version",
    description: "Device version",
    category: "show",
    mode: "exec",
    aliases: [],
    examples: [{ command: "show version", description: "IOS version" }],
    versions: { introduced: null, deprecated: null, notes: null },
    tags: [],
    ...over,
  };
}

const state = (over: Partial<SidePanelState> = {}): SidePanelState => ({
  open: true,
  undocked: true,
  dockedWidth: 320,
  mode: "kb",
  snapshot: { kind: "placeholder", text: "Start typing to see suggestions" },
  ...over,
});

interface FakeBridge extends PanelWindowBridge {
  send: Mock<(action: SidePanelAction) => void>;
  requestState: Mock<() => void>;
  push: (next: SidePanelState) => void;
}

function bridge(): FakeBridge {
  let listener: ((state: SidePanelState) => void) | null = null;
  const send: Mock<(action: SidePanelAction) => void> = vi.fn();
  const requestState: Mock<() => void> = vi.fn();
  return {
    send,
    requestState,
    push: (next) => listener?.(next),
    onState: async (fn) => {
      listener = fn;
      return () => {
        listener = null;
      };
    },
  };
}

const mounted: (() => void)[] = [];

function mount() {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const b = bridge();
  const teardown = mountPanelWindow(root, b);
  mounted.push(() => {
    teardown();
    root.remove();
  });
  return { root, b };
}

const key = (k: string, mods: { ctrl?: boolean; meta?: boolean; shift?: boolean } = {}) => {
  const e = new KeyboardEvent("keydown", {
    key: k,
    ctrlKey: !!mods.ctrl,
    metaKey: !!mods.meta,
    shiftKey: !!mods.shift,
    bubbles: true,
    cancelable: true,
  });
  document.dispatchEvent(e);
  return e;
};

/** "Mod" is Ctrl on Windows/Linux and Cmd on macOS — the same resolution
 *  `matches()` applies, so this test follows the platform it runs on. */
const modChord = () =>
  platformMod() === "Cmd" ? { meta: true, shift: true } : { ctrl: true, shift: true };

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  delete document.documentElement.dataset.comndWindow;
  setOverrides({});
});

describe("undocked panel window", () => {
  it("marks the document as the panel window and asks for state on mount", async () => {
    const { root, b } = mount();
    expect(document.documentElement.dataset.comndWindow).toBe("panel");
    // The snapshot request is an event: it goes out only once the subscription
    // is live, so the reply cannot arrive before anything is listening.
    await Promise.resolve();
    expect(b.requestState).toHaveBeenCalledTimes(1);
    expect(root.querySelector(".pw-title")?.textContent).toBe("Panel");
  });

  it("offers a dock control that is reachable by keyboard and names its shortcut", () => {
    const { root, b } = mount();
    const dock = root.querySelector<HTMLButtonElement>("#panel-dock")!;
    expect(dock.textContent).toBe("Dock");
    // Resolved, not hard-coded: the platform modifier and any saved override.
    expect(dock.getAttribute("aria-keyshortcuts")).toBe(ariaKeyShortcuts("toggle-side-panel"));
    expect(dock.getAttribute("aria-keyshortcuts")).toMatch(/^(Control|Meta)\+Shift\+B$/);
    dock.click();
    expect(b.send).toHaveBeenCalledWith({ type: "dock" });
  });

  it("makes the frameless window draggable from its header", () => {
    const { root } = mount();
    // The window has no decorations, so this attribute is the only way to move it.
    expect(root.querySelector(".pw-head")!.getAttribute("data-tauri-drag-region")).toBe("deep");
  });

  it("offers a close control after Dock that closes the window without docking", () => {
    const { root, b } = mount();
    const controls = [...root.querySelectorAll<HTMLButtonElement>(".pw-head button")].map((el) => el.id);
    // Dock stays first: Tab from the header reaches the way back before the exit.
    expect(controls).toEqual(["panel-dock", "panel-close"]);

    const close = root.querySelector<HTMLButtonElement>("#panel-close")!;
    expect(close.querySelector("svg")).not.toBeNull();
    expect(close.getAttribute("aria-label")).toBe("Close panel");
    expect(close.getAttribute("aria-keyshortcuts")).toBe("Escape");
    close.click();
    expect(b.send).toHaveBeenCalledWith({ type: "close" });
    expect(b.send).not.toHaveBeenCalledWith({ type: "dock" });
  });

  it("renders the published snapshot and the tab state", () => {
    const { root, b } = mount();
    b.push(state({ mode: "replay", snapshot: { kind: "replay", items: [], platform: "linux-bash" } }));
    expect(root.querySelector(".sb-toggle-replay")!.classList.contains("active")).toBe(true);
    expect(root.querySelector(".sb-content")!.textContent).toContain("No saved commands yet");
    expect(root.querySelector(".sb-content")!.querySelector("[role=tab]")).toBeNull();
  });

  it("does not re-render when only the mode changes", () => {
    const { root, b } = mount();
    const snapshot = { kind: "placeholder", text: "unchanged" } as const;
    b.push(state({ mode: "kb", snapshot }));
    const first = root.querySelector(".sb-content p");
    b.push(state({ mode: "replay", snapshot }));
    expect(root.querySelector(".sb-content p")).toBe(first);
    expect(root.querySelector(".sb-toggle-replay")!.classList.contains("active")).toBe(true);
  });

  it("returns tab clicks to the main window as mode actions", () => {
    const { root, b } = mount();
    root.querySelector<HTMLButtonElement>(".sb-toggle-replay")!.click();
    expect(b.send).toHaveBeenCalledWith({ type: "mode", mode: "replay" });
    root.querySelector<HTMLButtonElement>(".sb-toggle-kb")!.click();
    expect(b.send).toHaveBeenCalledWith({ type: "mode", mode: "kb" });
  });

  it("closes the panel on Escape without docking it", () => {
    const { b } = mount();
    const e = key("Escape");
    expect(e.defaultPrevented).toBe(true);
    expect(b.send).toHaveBeenCalledWith({ type: "close" });
  });

  it("does not ask for a snapshot before the subscription is live", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    let release: (() => void) | null = null;
    const requestState = vi.fn();
    const teardown = mountPanelWindow(root, {
      send: vi.fn(),
      requestState,
      onState: () =>
        new Promise<() => void>((resolve) => {
          release = () => resolve(() => {});
        }),
    });
    expect(requestState).not.toHaveBeenCalled();
    release!();
    await Promise.resolve();
    expect(requestState).toHaveBeenCalledTimes(1);
    teardown();
    root.remove();
  });

  it("applies the theme and reading scale the main window publishes", () => {
    applyPanelPreferences({
      theme: "solarized-light",
      readingComfort: { prevFontSize: 14, uiScale: 1.4, lineHeight: 1.4, letterSpacing: 2 },
    });
    expect(document.documentElement.dataset.theme).toBe("solarized-light");
    expect(document.documentElement.dataset.readingComfort).toBe("on");
    expect(document.documentElement.style.getPropertyValue("--text-scale")).toBe("1.4");

    applyPanelPreferences({ theme: "dark", readingComfort: null });
    expect(document.documentElement.dataset.readingComfort).toBeUndefined();
    expect(document.documentElement.style.getPropertyValue("--text-scale")).toBe("");
  });

  it("sets the advertised shortcut as an attribute, not as markup", () => {
    // A saved binding can hold a quote. Applied with setAttribute after render,
    // it sets the value instead of truncating the attribute or the element.
    setOverrides({ "toggle-side-panel": 'Mod+Shift+"' });
    const { root } = mount();
    const dock = root.querySelector<HTMLButtonElement>("#panel-dock")!;
    const expected = ariaKeyShortcuts("toggle-side-panel");
    expect(dock.getAttribute("aria-keyshortcuts")).toBe(expected);
    expect(expected).toContain('"');
    expect(dock.querySelector("span")?.textContent).toBe("Dock");
    expect(root.querySelectorAll(".pw-head button")).toHaveLength(2);
    expect(root.querySelector(".pw-title")?.textContent).toBe("Panel");
  });

  it("follows a rebound panel shortcut in its advertised combination", () => {
    const { root } = mount();
    const dock = root.querySelector<HTMLButtonElement>("#panel-dock")!;
    setOverrides({ "toggle-side-panel": "Mod+Alt+B" });
    expect(dock.getAttribute("aria-keyshortcuts")).toBe(ariaKeyShortcuts("toggle-side-panel"));
    expect(dock.getAttribute("aria-keyshortcuts")).toMatch(/^(Control|Meta)\+Alt\+B$/);
  });

  it("docks on the toggle-panel shortcut, the same key that undocked it", () => {
    const { b } = mount();
    key("B", modChord());
    expect(b.send).toHaveBeenCalledWith({ type: "dock" });
  });

  it("leaves other shortcuts and modified Escape alone", () => {
    const { b } = mount();
    key("Escape", { shift: true });
    key("B");
    expect(b.send).not.toHaveBeenCalled();
  });

  it("forwards replay and example interactions as actions, never as markup", () => {
    const { root, b } = mount();
    b.push(
      state({
        mode: "replay",
        snapshot: {
          kind: "replay",
          platform: "linux-bash",
          items: [
            { id: "r-1", command: "show ver", variables: [], platform: "linux-bash", created_at: "2026-01-01T00:00:00.000Z" },
          ],
        },
      }),
    );
    root.querySelector<HTMLButtonElement>(".replay-play")!.click();
    expect(b.send).toHaveBeenCalledWith({ type: "play", id: "r-1" });

    root.querySelector<HTMLButtonElement>(".replay-add")!.click();
    expect(b.send).toHaveBeenCalledWith({ type: "add" });

    b.push(
      state({
        snapshot: {
          kind: "replay",
          platform: "",
          items: [
            { id: "r-1", command: "show ver", variables: [], platform: "linux-bash", created_at: "2026-01-01T00:00:00.000Z" },
          ],
        },
      }),
    );
    expect(root.querySelectorAll(".replay-item")).toHaveLength(1);
  });

  it("sends example commands to the main window, which owns the session", () => {
    const { root, b } = mount();
    b.push(state({ snapshot: { kind: "detail", command: makeCommand(), referenceUrl: null } }));
    const example = root.querySelector<HTMLElement>(".example-item");
    expect(example?.dataset.command).toBe("show version");
    example!.click();
    expect(b.send).toHaveBeenCalledWith({ type: "run", command: "show version" });
  });

  it("stops listening after teardown", () => {
    const { root, b } = mount();
    mounted.pop()!();
    key("Escape");
    // The controls are still in the detached DOM, so a leaked listener shows up
    // here as a message sent by a window that no longer exists.
    root.querySelector<HTMLButtonElement>("#panel-dock")!.click();
    root.querySelector<HTMLButtonElement>("#panel-close")!.click();
    expect(document.documentElement.dataset.comndWindow).toBeUndefined();
    expect(b.send).not.toHaveBeenCalled();
  });
});
