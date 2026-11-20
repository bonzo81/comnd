import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  DOCKED_WIDTH_MAX,
  DOCKED_WIDTH_MIN,
  __configureSidePanel,
  __resetSidePanel,
  applySidePanelAction,
  closeSidePanel,
  cycleSidePanel,
  flushSidePanelWidth,
  getSidePanelState,
  handlePanelWindowClosed,
  initSidePanel,
  onSidePanelAction,
  openSidePanel,
  setPanelUndocked,
  setSidePanelDockedWidth,
  setSidePanelMode,
  setSidePanelSnapshot,
  subscribeSidePanel,
  toggleSidePanel,
} from "./side-panel";
import type { SidePanelState } from "./side-panel";
import type { PanelConfig } from "./tauri-api";

interface Harness {
  getConfig: Mock<() => Promise<PanelConfig>>;
  setUndocked: Mock<(undocked: boolean) => Promise<void>>;
  setDockedWidth: Mock<(width: number) => Promise<number>>;
  openWindow: Mock<() => Promise<{ x: number; y: number; width: number; height: number }>>;
  closeWindow: Mock<() => Promise<void>>;
  publish: Mock<(state: SidePanelState) => void>;
}

function harness(config: Partial<PanelConfig> = {}): Harness {
  const h: Harness = {
    getConfig: vi.fn(async () => ({ undocked: false, docked_width: 320, window: null, ...config })),
    setUndocked: vi.fn(async () => {}),
    setDockedWidth: vi.fn(async (width: number) => width),
    openWindow: vi.fn(async () => ({ x: 0, y: 0, width: 420, height: 640 })),
    closeWindow: vi.fn(async () => {}),
    publish: vi.fn(),
  };
  __configureSidePanel(h);
  return h;
}

beforeEach(() => {
  __resetSidePanel();
});

afterEach(() => {
  __resetSidePanel();
  vi.useRealTimers();
});

describe("side panel state", () => {
  it("starts closed and docked whatever the config says", async () => {
    const h = harness({ undocked: true, docked_width: 480 });
    await initSidePanel();
    const state = getSidePanelState();
    expect(state.open).toBe(false);
    expect(state.undocked).toBe(true);
    expect(state.dockedWidth).toBe(480);
    expect(h.openWindow).not.toHaveBeenCalled();
  });

  it("falls back to defaults when the config cannot be read", async () => {
    const h = harness();
    h.getConfig.mockRejectedValueOnce(new Error("boom"));
    await initSidePanel();
    expect(getSidePanelState().dockedWidth).toBe(320);
    expect(getSidePanelState().undocked).toBe(false);
  });

  it("clamps a hand-edited docked width on read", async () => {
    harness({ docked_width: 5000 });
    await initSidePanel();
    expect(getSidePanelState().dockedWidth).toBe(DOCKED_WIDTH_MAX);
  });

  it("toggles closed → open → closed", () => {
    toggleSidePanel();
    expect(getSidePanelState().open).toBe(true);
    toggleSidePanel();
    expect(getSidePanelState().open).toBe(false);
  });

  it("cycles the shortcut closed → docked → undocked → docked", async () => {
    const h = harness();
    await initSidePanel();
    cycleSidePanel();
    expect(getSidePanelState().open).toBe(true);
    expect(getSidePanelState().undocked).toBe(false);
    expect(h.openWindow).not.toHaveBeenCalled();

    cycleSidePanel();
    await Promise.resolve();
    expect(getSidePanelState().undocked).toBe(true);
    expect(h.setUndocked).toHaveBeenCalledWith(true);
    expect(h.openWindow).toHaveBeenCalledTimes(1);

    cycleSidePanel();
    await Promise.resolve();
    expect(getSidePanelState().undocked).toBe(false);
    expect(getSidePanelState().open).toBe(true);
    expect(h.setUndocked).toHaveBeenCalledWith(false);
    // Docking never creates a window, so no second copy can appear.
    expect(h.openWindow).toHaveBeenCalledTimes(1);
  });

  it("opens the shortcut in the persisted home without a second window", async () => {
    const h = harness({ undocked: true });
    await initSidePanel();
    cycleSidePanel();
    expect(getSidePanelState().open).toBe(true);
    expect(h.openWindow).toHaveBeenCalledTimes(1);
    // Already undocked: the cycle docks rather than opening another window.
    cycleSidePanel();
    await Promise.resolve();
    expect(h.setUndocked).toHaveBeenCalledWith(false);
    expect(h.openWindow).toHaveBeenCalledTimes(1);
  });

  it("does not open a window at launch even when undocked", async () => {
    const h = harness({ undocked: true });
    await initSidePanel();
    expect(getSidePanelState().open).toBe(false);
    expect(h.openWindow).not.toHaveBeenCalled();
  });

  it("opens the undocked window when the panel is shown", async () => {
    const h = harness({ undocked: true });
    await initSidePanel();
    openSidePanel();
    expect(h.openWindow).toHaveBeenCalledTimes(1);
  });

  it("never creates a second window when undock repeats", async () => {
    const h = harness();
    await initSidePanel();
    openSidePanel();
    await setPanelUndocked(true);
    await setPanelUndocked(true);
    expect(h.openWindow).toHaveBeenCalledTimes(1);
  });

  it("opens the window when undocking an already-open panel", async () => {
    const h = harness();
    await initSidePanel();
    openSidePanel();
    expect(h.openWindow).not.toHaveBeenCalled();
    await setPanelUndocked(true);
    expect(h.openWindow).toHaveBeenCalledTimes(1);
    expect(h.setUndocked).toHaveBeenCalledWith(true);
  });

  it("docks by destroying the window and keeping the panel open", async () => {
    const h = harness();
    await initSidePanel();
    openSidePanel();
    await setPanelUndocked(true);
    const seen: boolean[] = [];
    subscribeSidePanel((s) => seen.push(s.undocked));
    await setPanelUndocked(false);
    expect(h.setUndocked).toHaveBeenCalledWith(false);
    expect(getSidePanelState().undocked).toBe(false);
    expect(getSidePanelState().open).toBe(true);
    expect(seen[seen.length - 1]).toBe(false);
  });

  it("closes the window once when the panel closes undocked", async () => {
    const h = harness();
    await initSidePanel();
    openSidePanel();
    await setPanelUndocked(true);
    closeSidePanel();
    expect(h.closeWindow).toHaveBeenCalledTimes(1);
    handlePanelWindowClosed();
    expect(h.closeWindow).toHaveBeenCalledTimes(1);
    expect(getSidePanelState().open).toBe(false);
  });

  it("does not close a window that is not there", async () => {
    const h = harness();
    await initSidePanel();
    openSidePanel();
    closeSidePanel();
    expect(h.closeWindow).not.toHaveBeenCalled();
  });

  it("publishes snapshots into the window only while undocked and open", async () => {
    const h = harness();
    await initSidePanel();
    setSidePanelSnapshot({ kind: "placeholder", text: "docked" });
    expect(h.publish).not.toHaveBeenCalled();

    openSidePanel();
    await setPanelUndocked(true);
    h.publish.mockClear();

    setSidePanelSnapshot({ kind: "placeholder", text: "undocked" });
    expect(h.publish).toHaveBeenCalledTimes(1);
    const published = h.publish.mock.calls[0][0].snapshot;
    expect(published.kind === "placeholder" && published.text).toBe("undocked");

    await setPanelUndocked(false);
    h.publish.mockClear();
    setSidePanelSnapshot({ kind: "placeholder", text: "docked again" });
    expect(h.publish).not.toHaveBeenCalled();
  });

  it("keeps the tab mode and reports it to both homes", () => {
    const seen: string[] = [];
    subscribeSidePanel((s) => seen.push(s.mode));
    setSidePanelMode("replay");
    setSidePanelMode("replay");
    expect(seen).toEqual(["replay"]);
  });

  it("persists a dragged width once, after the debounce", () => {
    vi.useFakeTimers();
    const h = harness();
    setSidePanelDockedWidth(400);
    setSidePanelDockedWidth(420);
    setSidePanelDockedWidth(430);
    expect(getSidePanelState().dockedWidth).toBe(430);
    expect(h.setDockedWidth).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    expect(h.setDockedWidth).toHaveBeenCalledTimes(1);
    expect(h.setDockedWidth).toHaveBeenCalledWith(430);
  });

  it("clamps widths from below as well", () => {
    setSidePanelDockedWidth(10);
    expect(getSidePanelState().dockedWidth).toBe(DOCKED_WIDTH_MIN);
  });

  it("flushes a pending width write", () => {
    vi.useFakeTimers();
    const h = harness();
    setSidePanelDockedWidth(500);
    flushSidePanelWidth();
    expect(h.setDockedWidth).toHaveBeenCalledWith(500);
    vi.advanceTimersByTime(1000);
    expect(h.setDockedWidth).toHaveBeenCalledTimes(1);
  });

  it("forwards replay actions to the terminal view but handles dock itself", async () => {
    const h = harness();
    await initSidePanel();
    openSidePanel();
    await setPanelUndocked(true);
    const forwarded: string[] = [];
    onSidePanelAction((action) => forwarded.push(action.type));

    applySidePanelAction({ type: "play", id: "abc" });
    applySidePanelAction({ type: "add" });
    expect(forwarded).toEqual(["play", "add"]);

    applySidePanelAction({ type: "dock" });
    // Rust destroys the window as part of docking, so the frontend must not
    // ask for a second close.
    expect(h.setUndocked).toHaveBeenCalledWith(false);
    expect(h.closeWindow).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(getSidePanelState().undocked).toBe(false);
    expect(getSidePanelState().open).toBe(true);
  });

  it("closes on a close action from the window", async () => {
    harness();
    await initSidePanel();
    openSidePanel();
    applySidePanelAction({ type: "close" });
    expect(getSidePanelState().open).toBe(false);
  });
});
