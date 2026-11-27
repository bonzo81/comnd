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

/** The window effects are queued, so state settles over a few microtasks. */
async function flush(times = 8) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

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
    await flush();
    expect(getSidePanelState().undocked).toBe(true);
    expect(h.setUndocked).toHaveBeenCalledWith(true);
    expect(h.openWindow).toHaveBeenCalledTimes(1);

    cycleSidePanel();
    await flush();
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
    await flush();
    expect(h.openWindow).toHaveBeenCalledTimes(1);
    // Already undocked: the cycle docks rather than opening another window.
    cycleSidePanel();
    await flush();
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
    await flush();
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
    await flush();
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
    await flush();
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

  it("flushes a pending width write", async () => {
    vi.useFakeTimers();
    const h = harness();
    setSidePanelDockedWidth(500);
    await flushSidePanelWidth();
    expect(h.setDockedWidth).toHaveBeenCalledWith(500);
    vi.advanceTimersByTime(1000);
    expect(h.setDockedWidth).toHaveBeenCalledTimes(1);
  });

  it("rolls the home back when the dock preference cannot be saved", async () => {
    const h = harness();
    await initSidePanel();
    openSidePanel();
    await setPanelUndocked(true);
    h.setUndocked.mockRejectedValueOnce(new Error("disk full"));

    await setPanelUndocked(false);

    // Rust keeps the old home when the write fails, and only destroys the panel
    // window after a successful one — the frontend must not claim a dock it
    // does not have.
    expect(getSidePanelState().undocked).toBe(true);
    expect(getSidePanelState().open).toBe(true);
    expect(h.closeWindow).not.toHaveBeenCalled();
    const snapshot = getSidePanelState().snapshot;
    expect(snapshot.kind === "placeholder" && snapshot.text).toMatch(/Failed to dock/);
  });

  it("keeps the toggle usable when the window cannot open", async () => {
    const h = harness({ undocked: true });
    h.openWindow.mockRejectedValueOnce(new Error("no window"));
    await initSidePanel();
    openSidePanel();
    await flush();
    expect(getSidePanelState().open).toBe(false);
    const snapshot = getSidePanelState().snapshot;
    expect(snapshot.kind === "placeholder" && snapshot.text).toMatch(/Failed to open/);
    // The next press must try again rather than return early on a stale flag.
    openSidePanel();
    await flush();
    expect(h.openWindow).toHaveBeenCalledTimes(2);
  });

  it("does not reopen a window a later dock already ordered away", async () => {
    const h = harness();
    let finishOpen: (() => void) | null = null;
    h.openWindow.mockImplementationOnce(
      () => new Promise((resolve) => {
        finishOpen = () => resolve({ x: 0, y: 0, width: 420, height: 640 });
      }),
    );
    await initSidePanel();
    openSidePanel();

    const undocking = setPanelUndocked(true);
    await flush();
    expect(finishOpen).not.toBeNull();

    // Dock while the window is still being created.
    const docking = setPanelUndocked(false);
    await flush();
    finishOpen!();
    await docking;
    await undocking;
    await flush();

    expect(getSidePanelState().undocked).toBe(false);
    // The window that arrived late is closed again: one window, and the panel is
    // docked.
    expect(h.closeWindow).toHaveBeenCalledTimes(1);
  });

  it("does not let a stale open failure clear a newer open", async () => {
    const h = harness({ undocked: true });
    let rejectFirst: ((error: unknown) => void) | null = null;
    h.openWindow.mockImplementationOnce(
      () => new Promise((_resolve, reject) => {
        rejectFirst = reject;
      }),
    );
    await initSidePanel();
    openSidePanel();
    await flush();
    expect(rejectFirst).not.toBeNull();

    // Close and reopen while the first window creation is still pending.
    closeSidePanel();
    openSidePanel();
    rejectFirst!(new Error("boom"));
    await flush();

    // The newer open owns the state, so the older failure must not clear it or
    // report itself over the panel.
    expect(getSidePanelState().open).toBe(true);
    expect(h.openWindow).toHaveBeenCalledTimes(2);
    const snapshot = getSidePanelState().snapshot;
    expect(snapshot.kind === "placeholder" ? snapshot.text : "").not.toMatch(/Failed/);
  });

  it("announces the docked home only after the write succeeds", async () => {
    const h = harness();
    await initSidePanel();
    openSidePanel();
    await setPanelUndocked(true);

    const seen: boolean[] = [];
    subscribeSidePanel((s) => seen.push(s.undocked));
    let finish: (() => void) | null = null;
    h.setUndocked.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );

    const docking = setPanelUndocked(false);
    await flush();
    // Rust still has the window open, so the docked panel must not appear yet.
    expect(seen).toEqual([]);
    expect(h.closeWindow).not.toHaveBeenCalled();

    finish!();
    await docking;
    await flush();
    expect(seen[seen.length - 1]).toBe(false);
    // Docking destroyed the window inside the write; no second close.
    expect(h.closeWindow).not.toHaveBeenCalled();
  });

  it("never publishes a home whose write has not finished", async () => {
    const h = harness();
    await initSidePanel();
    openSidePanel();
    await setPanelUndocked(true);

    const seen: boolean[] = [];
    subscribeSidePanel((s) => seen.push(s.undocked));
    let reject: ((error: unknown) => void) | null = null;
    h.setUndocked.mockImplementationOnce(
      () => new Promise<void>((_resolve, rejectWrite) => {
        reject = rejectWrite;
      }),
    );

    const docking = setPanelUndocked(false);
    await flush();
    // An unrelated update during the pending write must not leak the new home:
    // the docked panel would appear beside a window that is still open.
    setSidePanelSnapshot({ kind: "placeholder", text: "mid-write" });
    expect(seen.every((undocked) => undocked === true)).toBe(true);

    reject!(new Error("disk full"));
    await docking;
    await flush();
    expect(seen.every((undocked) => undocked === true)).toBe(true);
    expect(getSidePanelState().undocked).toBe(true);
    const snapshot = getSidePanelState().snapshot;
    expect(snapshot.kind === "placeholder" && snapshot.text).toMatch(/Failed to dock/);
  });

  it("writes the home in the order the user asked for it", async () => {
    const h = harness();
    await initSidePanel();
    openSidePanel();
    await setPanelUndocked(true);

    const order: boolean[] = [];
    const finishers: (() => void)[] = [];
    h.setUndocked.mockImplementation((undocked: boolean) => {
      order.push(undocked);
      return new Promise<void>((resolve) => {
        finishers.push(resolve);
      });
    });

    const docking = setPanelUndocked(false);
    await flush();
    const undocking = setPanelUndocked(true);
    await flush();
    // The second write waits for the first: the saved home cannot be left
    // undocked by an earlier write landing late.
    expect(order).toEqual([false]);

    finishers[0]();
    await flush();
    expect(order).toEqual([false, true]);
    finishers[1]();
    await docking;
    await undocking;
    await flush();
    expect(getSidePanelState().undocked).toBe(true);
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
    applySidePanelAction({ type: "switch", sessionId: 7 });
    applySidePanelAction({ type: "open-url", url: "https://nb.example.com/dcim/devices/201/" });
    expect(forwarded).toEqual(["play", "add", "switch", "open-url"]);

    applySidePanelAction({ type: "dock" });
    // The write and the window effect are queued, so they run over a few ticks.
    await flush();
    // Rust destroys the window as part of docking, so the frontend must not
    // ask for a second close.
    expect(h.setUndocked).toHaveBeenCalledWith(false);
    expect(h.closeWindow).not.toHaveBeenCalled();
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
