import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { mountPanelWindow, type PanelWindowBridge } from "./panel-window";
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
    onState: (fn) => {
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

const key = (k: string, mods: { ctrl?: boolean; shift?: boolean } = {}) => {
  const e = new KeyboardEvent("keydown", {
    key: k,
    ctrlKey: !!mods.ctrl,
    shiftKey: !!mods.shift,
    bubbles: true,
    cancelable: true,
  });
  document.dispatchEvent(e);
  return e;
};

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  delete document.documentElement.dataset.comndWindow;
});

describe("undocked panel window", () => {
  it("marks the document as the panel window and asks for state on mount", () => {
    const { root, b } = mount();
    expect(document.documentElement.dataset.comndWindow).toBe("panel");
    expect(b.requestState).toHaveBeenCalledTimes(1);
    expect(root.querySelector(".pw-title")?.textContent).toBe("Panel");
  });

  it("offers a dock control that is reachable by keyboard and names its shortcut", () => {
    const { root, b } = mount();
    const dock = root.querySelector<HTMLButtonElement>("#panel-dock")!;
    expect(dock.textContent).toBe("Dock");
    expect(dock.getAttribute("aria-keyshortcuts")).toBe("Control+Shift+B");
    dock.click();
    expect(b.send).toHaveBeenCalledWith({ type: "dock" });
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

  it("docks on the toggle-panel shortcut, the same key that undocked it", () => {
    const { b } = mount();
    key("B", { ctrl: true, shift: true });
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
    mount();
    mounted.pop()!();
    key("Escape");
    expect(document.documentElement.dataset.comndWindow).toBeUndefined();
  });
});
