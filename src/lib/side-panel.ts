/**
 * Side panel state — one app-wide panel that follows the active tab
 * (ADR-013), which can live in one of two homes:
 *
 * - docked: inside the active terminal view, pushing the terminal narrower
 *   (ADR-003 — never an overlay);
 * - undocked: in its own OS window, so the terminal takes the full width
 *   (docs/plans/066-plan-side-panel-undock.md).
 *
 * This module owns the choice of home, the open flag, the docked width and the
 * content snapshot both homes render. It always starts closed: the app never
 * reopens the panel at launch, even when it was quit undocked, because a second
 * window appearing before the user asks for it reads as a startup bug.
 *
 * Nothing here touches the keystroke or suggestion path: snapshots change when
 * the panel's subject changes (prompt idle, selection move, replay reload), not
 * once per key.
 */

import type {
  Command,
  NetBoxDeviceSummary,
  PanelConfig,
  ReplayCommand,
} from "./tauri-api";
import {
  netboxGetDeviceSummary,
  panelClose,
  panelGetState,
  panelOpen,
  panelSetDockedWidth,
  panelSetUndocked,
} from "./tauri-api";
import { isNetboxHostId } from "./netbox-host";

export type SidePanelMode = "kb" | "replay" | "netbox";

/** What the panel is currently about. Raw command data, never markup, so both
 *  homes run the same renderer over the same value and cannot drift. */
export type SidePanelSnapshot =
  | { kind: "detail"; command: Command; referenceUrl: string | null }
  | { kind: "placeholder"; text: string }
  | { kind: "replay"; items: ReplayCommand[]; platform: string }
  | { kind: "netbox"; hostId: string; phase: "loading" }
  | { kind: "netbox"; hostId: string; phase: "ready"; summary: NetBoxDeviceSummary }
  | { kind: "netbox"; hostId: string; phase: "error"; message: string };

export interface SidePanelState {
  open: boolean;
  undocked: boolean;
  dockedWidth: number;
  mode: SidePanelMode;
  /**
   * `netbox:<id>` of the active tab's host when that host came from NetBox,
   * else null. Both homes show the NetBox tab from this one field; a user host
   * therefore never has the tab. Published to the undocked window with the
   * rest of the state.
   */
  netboxHostId: string | null;
  snapshot: SidePanelSnapshot;
}

/**
 * Messages the undocked window sends back. `play` and `add` need the live SSH
 * session and its dialogs, so they are forwarded to the terminal view rather
 * than handled here.
 */
export type SidePanelAction =
  | { type: "dock" }
  | { type: "close" }
  | { type: "mode"; mode: SidePanelMode }
  | { type: "retry-netbox" }
  | { type: "play"; id: string }
  | { type: "add" }
  | { type: "run"; command: string };

export interface SidePanelDeps {
  /** Persisted home, docked width and window geometry. */
  getConfig: () => Promise<PanelConfig>;
  setUndocked: (undocked: boolean) => Promise<void>;
  setDockedWidth: (width: number) => Promise<number>;
  openWindow: () => Promise<unknown>;
  closeWindow: () => Promise<void>;
  /** One live NetBox device summary, fetched fresh from the backend. */
  loadNetbox: (hostId: string) => Promise<NetBoxDeviceSummary>;
  /** Mirror the state into the undocked window. Called only when it is both
   *  open and undocked, so no IPC happens for the docked home. */
  publish: (state: SidePanelState) => void;
}

/** Mirrors the Rust clamp (panel.rs DOCKED_WIDTH_MIN/MAX) so a drag and a
 *  hand-edited config agree about how narrow the docked panel may get. */
export const DOCKED_WIDTH_MIN = 240;
export const DOCKED_WIDTH_MAX = 1200;
const DEFAULT_DOCKED_WIDTH = 320;
const WIDTH_PERSIST_DEBOUNCE_MS = 400;

const PLACEHOLDER_SELECT = "Select a suggestion to see command details";
const PLACEHOLDER_TYPING = "Start typing to see suggestions";

const defaultDeps: SidePanelDeps = {
  getConfig: panelGetState,
  setUndocked: panelSetUndocked,
  setDockedWidth: panelSetDockedWidth,
  openWindow: panelOpen,
  closeWindow: panelClose,
  loadNetbox: netboxGetDeviceSummary,
  publish: () => {},
};

function clampWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_DOCKED_WIDTH;
  return Math.min(DOCKED_WIDTH_MAX, Math.max(DOCKED_WIDTH_MIN, Math.round(width)));
}

let deps: SidePanelDeps = defaultDeps;
let state: SidePanelState = initialState();
const listeners = new Set<(state: SidePanelState) => void>();
const actionListeners = new Set<(action: SidePanelAction) => void>();
let widthTimer: ReturnType<typeof setTimeout> | null = null;
/** Invalidates a NetBox fetch whose subject changed (host or tab switch). */
let netboxSeq = 0;
/** Serialises the lifecycle steps; see `applyPanelLifecycle`. */
let lifecycle: Promise<void> = Promise.resolve();
/** Bumped by every lifecycle request, so a completion can tell whether it still
 *  owns the state it is about to publish or roll back. */
let lifecycleSeq = 0;
/** Best-effort mirror of the window Rust owns. Rust's open/close are
 *  idempotent, so a wrong guess costs one no-op call, never a second window. */
let windowOpen = false;
/** The home actually written to the config, so a failed write knows what to
 *  restore and a later step does not rewrite it. */
let persistedHome = false;
/** A home the user asked for whose write has not finished yet. Kept apart from
 *  `state.undocked` so no other update — a snapshot, a mode change — can publish
 *  a home the config does not have. */
let requestedHome: boolean | null = null;

function initialState(): SidePanelState {
  return {
    open: false,
    undocked: false,
    dockedWidth: DEFAULT_DOCKED_WIDTH,
    mode: "kb",
    netboxHostId: null,
    snapshot: { kind: "placeholder", text: PLACEHOLDER_SELECT },
  };
}

export function getSidePanelState(): SidePanelState {
  return state;
}

export function subscribeSidePanel(listener: (state: SidePanelState) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Terminal-scoped panel actions (play a replay command, add one). */
export function onSidePanelAction(listener: (action: SidePanelAction) => void): () => void {
  actionListeners.add(listener);
  return () => actionListeners.delete(listener);
}

function setState(patch: Partial<SidePanelState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener(state);
  if (state.open && state.undocked) deps.publish(state);
}

/**
 * Read the persisted home and docked width. Deliberately leaves `open` false:
 * the panel's visibility is a session decision, never a startup decision.
 *
 * `overrides` supplies the environment this instance runs in — the app passes
 * the cross-window publisher; tests pass fakes. Anything omitted keeps the
 * Tauri IPC defaults.
 */
export async function initSidePanel(overrides: Partial<SidePanelDeps> = {}): Promise<void> {
  deps = { ...deps, ...overrides };
  try {
    const panel = await deps.getConfig();
    persistedHome = panel.undocked;
    setState({ undocked: panel.undocked, dockedWidth: clampWidth(panel.docked_width) });
  } catch {
    // Unreadable config — the defaults stand and the panel stays docked.
  }
}

export function toggleSidePanel(): void {
  if (state.open) closeSidePanel();
  else openSidePanel();
}

/**
 * The shortcut's home cycle: closed opens in the persisted home, a docked panel
 * undocks, an undocked one docks. Hiding stays on the toolbar toggle and Escape
 * in the panel window, so the shortcut can always reach both homes by key.
 */
export function cycleSidePanel(): void {
  if (!state.open) {
    openSidePanel();
    return;
  }
  void setPanelUndocked(!wantedHome());
}

/** The home last asked for, which may be a step ahead of the published one. */
function wantedHome(): boolean {
  return requestedHome ?? state.undocked;
}

/**
 * Bring the native window in line with the current home: exactly one window,
 * open exactly when the panel is open and undocked.
 *
 * Only ever called from inside a lifecycle step, so two home changes cannot
 * overlap. It re-checks after creating the window against the *requested* home,
 * because a dock can land while that call is in flight.
 */
async function syncPanelWindow(): Promise<void> {
  const wanted = state.open && state.undocked;
  if (wanted === windowOpen) return;
  if (!wanted) {
    await deps.closeWindow();
    windowOpen = false;
    return;
  }
  await deps.openWindow();
  windowOpen = true;
  if (!(state.open && wantedHome())) {
    await deps.closeWindow();
    windowOpen = false;
  }
}

function enqueue(step: () => Promise<void>): Promise<void> {
  const next = lifecycle.then(step, step);
  // A failure must not poison the queue: the next request retries.
  lifecycle = next.catch(() => {});
  return next;
}

/**
 * Persist the requested home, then make the native window match it — one
 * serialised step per request.
 *
 * The write and the window effect once ran outside the queue, so an undock write
 * could land after a dock write and leave the saved home wrong for the next
 * launch. The requested home is held apart from the published one, so no other
 * update during the write can announce a home the config does not have; each
 * step reads the request when it runs and publishes only after the write
 * succeeds.
 */
function applyPanelLifecycle(): Promise<void> {
  const seq = ++lifecycleSeq;
  return enqueue(async () => {
    const target = wantedHome();
    if (persistedHome !== target) {
      try {
        await deps.setUndocked(target);
        persistedHome = target;
        // A successful dock destroyed the window inside that same command, so
        // the reconcile below must not ask for a second close.
        if (!target) windowOpen = false;
      } catch (error) {
        // Rust kept the old home, and nothing was published, so there is
        // nothing to roll back — only a failure to report.
        if (seq === lifecycleSeq) {
          requestedHome = null;
          setSidePanelError(
            `Failed to ${target ? "undock" : "dock"} the side panel: ${error}`,
          );
        }
        return;
      }
    }
    // The config now agrees with the request, so the home may be published.
    // Only this step's own request is cleared: a newer one has to survive to be
    // written by its own step.
    if (seq === lifecycleSeq) requestedHome = null;
    if (state.undocked !== target) state = { ...state, undocked: target };
    // Publish the new home / open state only now: the config and the native
    // window are in step with it.
    if (seq === lifecycleSeq) setState({});
    try {
      await syncPanelWindow();
    } catch (error) {
      if (seq !== lifecycleSeq) return;
      // Nothing is showing, so the toggle has to stay usable: leaving `open`
      // true with no window would make every later open return early.
      if (!windowOpen && state.open && state.undocked) {
        state = { ...state, open: false };
        setState({});
      }
      setSidePanelError(`Failed to open the panel window: ${error}`);
    }
  });
}

export function openSidePanel(): void {
  if (state.open) return;
  state = { ...state, open: true };
  // Reopening a panel whose subject is the live NetBox tab reveals a fresh
  // snapshot; nothing is fetched while the panel is closed.
  if (state.mode === "netbox" && state.netboxHostId) void refreshNetbox();
  void applyPanelLifecycle();
}

export function closeSidePanel(): void {
  if (!state.open) return;
  state = { ...state, open: false };
  void applyPanelLifecycle();
}

/**
 * The undocked window was closed at the OS level (native close button or
 * Escape). Rust already destroyed it, so this only records the intent — calling
 * closeWindow again would be a second close of a window that is gone.
 */
export function handlePanelWindowClosed(): void {
  windowOpen = false;
  if (!state.open) return;
  state = { ...state, open: false };
  lifecycleSeq++;
  setState({});
}

/**
 * Move the panel between its two homes. Undocking opens the window at its saved
 * geometry when the panel is showing; docking destroys it and the terminal view
 * restores the docked width. Repeated calls in the same direction are no-ops,
 * which is what keeps a second panel window from ever existing.
 *
 * The home is only announced once the write succeeds; a failed one leaves the
 * panel where it was and reports the failure in the pane.
 */
export function setPanelUndocked(undocked: boolean): Promise<void> {
  if (wantedHome() === undocked) return Promise.resolve();
  requestedHome = undocked;
  return applyPanelLifecycle();
}

export function setSidePanelMode(mode: SidePanelMode): void {
  if (mode === "netbox") {
    if (!state.netboxHostId) return;
    // Selecting the tab again is a new selection and must fetch fresh.
    if (state.mode === "netbox") {
      void refreshNetbox();
      return;
    }
    setState({
      mode,
      snapshot: { kind: "netbox", hostId: state.netboxHostId, phase: "loading" },
    });
    void refreshNetbox();
    return;
  }
  if (state.mode === mode) return;
  // Leaving NetBox invalidates a fetch that has not landed yet.
  if (state.mode === "netbox") netboxSeq++;
  // Switching back to the KB tab shows the idle hint again; the terminal view
  // refills it from the live prompt on the next idle detection.
  const snapshot: SidePanelSnapshot =
    mode === "kb" ? { kind: "placeholder", text: PLACEHOLDER_TYPING } : state.snapshot;
  setState({ mode, snapshot });
}

/** A failed replay load reports in place, in the same pane it would fill. */
export function setSidePanelError(text: string): void {
  setState({ snapshot: { kind: "placeholder", text } });
}

export function setSidePanelSnapshot(snapshot: SidePanelSnapshot): void {
  setState({ snapshot });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Fetch the active NetBox host's summary. Every call replaces the pane with a
 * loading snapshot first, so a failure can never leave the previous device's
 * values on screen, and each selection costs exactly the backend's two GETs.
 * A response for a superseded host, tab or selection is dropped.
 */
async function refreshNetbox(): Promise<void> {
  const hostId = state.netboxHostId;
  if (!hostId) return;
  const seq = ++netboxSeq;
  setSidePanelSnapshot({ kind: "netbox", hostId, phase: "loading" });
  try {
    const summary = await deps.loadNetbox(hostId);
    if (seq !== netboxSeq || state.netboxHostId !== hostId || state.mode !== "netbox") return;
    setSidePanelSnapshot({ kind: "netbox", hostId, phase: "ready", summary });
  } catch (error) {
    if (seq !== netboxSeq || state.netboxHostId !== hostId || state.mode !== "netbox") return;
    setSidePanelSnapshot({
      kind: "netbox",
      hostId,
      phase: "error",
      message: `Failed to load NetBox device details: ${errorMessage(error)}`,
    });
  }
}

/** Retry from the docked home; both homes share this one fetch. */
export function retrySidePanelNetbox(): void {
  void refreshNetbox();
}

/**
 * Publish the active tab's host. A NetBox host makes the tab available in both
 * homes; a user host or no active tab hides it and falls back to KB when it was
 * showing. No fetch happens unless the panel is already open on NetBox.
 */
export function setSidePanelNetboxHost(hostId: string | null): void {
  // Only the `netbox:<id>` form can publish a NetBox tab; a user host id is
  // normalised away even if a caller passes one by mistake.
  const netboxHostId = hostId && isNetboxHostId(hostId) ? hostId : null;
  if (state.netboxHostId === netboxHostId) {
    // The host hand-off clears the id first and the incoming tab publishes
    // after it. If the incoming tab is a user host (or there is none), this is
    // the final word: a NetBox mode with no host must fall back to KB.
    if (netboxHostId === null && state.mode === "netbox") {
      netboxSeq++;
      setState({
        mode: "kb",
        snapshot: { kind: "placeholder", text: PLACEHOLDER_TYPING },
      });
    }
    return;
  }
  // A fetch still in flight belongs to the previous host.
  netboxSeq++;
  if (!netboxHostId) {
    if (state.mode !== "netbox") {
      setState({ netboxHostId: null });
      return;
    }
    setState({
      netboxHostId: null,
      mode: "kb",
      snapshot: { kind: "placeholder", text: PLACEHOLDER_TYPING },
    });
    return;
  }
  const showingNetbox = state.mode === "netbox";
  const patch: Partial<SidePanelState> = { netboxHostId };
  if (showingNetbox) {
    patch.snapshot = { kind: "netbox", hostId: netboxHostId, phase: "loading" };
  }
  setState(patch);
  if (showingNetbox && state.open) void refreshNetbox();
}

/**
 * The tab that just gave up the app-wide panel clears the host only when it is
 * still the published one, so activation order cannot clear the incoming tab's
 * host. The mode is left alone: the incoming tab's `setSidePanelNetboxHost`
 * either restores a NetBox subject (the mode survives a NetBox → NetBox tab
 * switch) or is a user host, which then falls back to KB.
 */
export function clearSidePanelNetboxHost(hostId: string): void {
  if (!hostId || state.netboxHostId !== hostId) return;
  netboxSeq++;
  setState({ netboxHostId: null });
}

/** Width chosen by dragging or with the arrow keys on the docked resizer. */
export function setSidePanelDockedWidth(width: number): void {
  const width_ = clampWidth(width);
  if (width_ === state.dockedWidth) return;
  setState({ dockedWidth: width_ });
  if (widthTimer) clearTimeout(widthTimer);
  widthTimer = setTimeout(() => {
    widthTimer = null;
    void deps.setDockedWidth(width_).catch(() => {});
  }, WIDTH_PERSIST_DEBOUNCE_MS);
}

/** Flush a pending width write — the width is otherwise lost when the app
 *  closes inside the debounce window. Awaited by the main window's close
 *  handler, so the write lands before the process goes away. */
export async function flushSidePanelWidth(): Promise<void> {
  if (!widthTimer) return;
  clearTimeout(widthTimer);
  widthTimer = null;
  try {
    await deps.setDockedWidth(state.dockedWidth);
  } catch {
    // Best effort: a close is not worth failing.
  }
}

/** Route a message from the undocked window (or the shortcut) to its owner. */
export function applySidePanelAction(action: SidePanelAction): void {
  switch (action.type) {
    case "dock":
      void setPanelUndocked(false);
      return;
    case "close":
      closeSidePanel();
      return;
    case "mode":
      setSidePanelMode(action.mode);
      return;
    case "retry-netbox":
      void refreshNetbox();
      return;
    case "play":
    case "add":
    case "run":
      for (const listener of actionListeners) listener(action);
      return;
  }
}

/** Test seam: swap the IPC surface and reset the module-level state. */
export function __configureSidePanel(next: Partial<SidePanelDeps>): void {
  deps = { ...defaultDeps, ...next };
}

export function __resetSidePanel(): void {
  if (widthTimer) clearTimeout(widthTimer);
  widthTimer = null;
  deps = defaultDeps;
  listeners.clear();
  actionListeners.clear();
  lifecycle = Promise.resolve();
  lifecycleSeq = 0;
  windowOpen = false;
  persistedHome = false;
  requestedHome = null;
  netboxSeq = 0;
  state = initialState();
}
