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

import type { Command, PanelConfig, ReplayCommand } from "./tauri-api";
import {
  panelClose,
  panelGetState,
  panelOpen,
  panelSetDockedWidth,
  panelSetUndocked,
} from "./tauri-api";

export type SidePanelMode = "kb" | "replay";

/** What the panel is currently about. Raw command data, never markup, so both
 *  homes run the same renderer over the same value and cannot drift. */
export type SidePanelSnapshot =
  | { kind: "detail"; command: Command; referenceUrl: string | null }
  | { kind: "placeholder"; text: string }
  | { kind: "replay"; items: ReplayCommand[]; platform: string };

export interface SidePanelState {
  open: boolean;
  undocked: boolean;
  dockedWidth: number;
  mode: SidePanelMode;
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
/** Serialises the native window effects; see `syncPanelWindow`. */
let lifecycle: Promise<void> = Promise.resolve();
/** Best-effort mirror of the window Rust owns. Rust's open/close are
 *  idempotent, so a wrong guess costs one no-op call, never a second window. */
let windowOpen = false;

function initialState(): SidePanelState {
  return {
    open: false,
    undocked: false,
    dockedWidth: DEFAULT_DOCKED_WIDTH,
    mode: "kb",
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
  void setPanelUndocked(!state.undocked);
}

/**
 * Bring the native window in line with the current home: exactly one window,
 * open exactly when the panel is open and undocked.
 *
 * Serialised, because two home changes can overlap — a pending undock that
 * resumes after a dock must not reopen the window it was told to close. Each
 * run reads the state when it runs rather than when it was queued, and re-checks
 * after creating the window in case a dock landed while that call was in flight.
 */
function syncPanelWindow(): Promise<void> {
  const step = async (): Promise<void> => {
    const wanted = state.open && state.undocked;
    if (wanted === windowOpen) return;
    if (!wanted) {
      await deps.closeWindow();
      windowOpen = false;
      return;
    }
    await deps.openWindow();
    windowOpen = true;
    if (!(state.open && state.undocked)) {
      await deps.closeWindow();
      windowOpen = false;
    }
  };
  const next = lifecycle.then(step, step);
  // A failure must not poison the queue: the next state change retries.
  lifecycle = next.catch(() => {});
  return next;
}

export function openSidePanel(): void {
  if (state.open) return;
  setState({ open: true });
  void syncPanelWindow().catch((error) => {
    // Nothing is showing, so the toggle has to stay usable: leaving `open` true
    // with no window would make every later open return early.
    if (!windowOpen && state.open && state.undocked) setState({ open: false });
    setSidePanelError(`Failed to open the panel window: ${error}`);
  });
}

export function closeSidePanel(): void {
  if (!state.open) return;
  setState({ open: false });
  void syncPanelWindow().catch(() => {});
}

/**
 * The undocked window was closed at the OS level (native close button or
 * Escape). Rust already destroyed it, so this only records the intent — calling
 * closeWindow again would be a second close of a window that is gone.
 */
export function handlePanelWindowClosed(): void {
  windowOpen = false;
  if (!state.open) return;
  setState({ open: false });
}

/**
 * Move the panel between its two homes. Undocking opens the window at its saved
 * geometry when the panel is showing; docking destroys it and the terminal view
 * restores the docked width. Repeated calls in the same direction are no-ops,
 * which is what keeps a second panel window from ever existing.
 *
 * A failed preference write rolls the home back: Rust keeps the old one and only
 * destroys the window after a successful dock write, so the optimistic value
 * would otherwise claim a home the app does not actually have.
 */
export async function setPanelUndocked(undocked: boolean): Promise<void> {
  if (state.undocked === undocked) return;
  const previous = state.undocked;
  setState({ undocked });
  try {
    await deps.setUndocked(undocked);
  } catch (error) {
    setState({ undocked: previous });
    setSidePanelError(`Failed to ${undocked ? "undock" : "dock"} the side panel: ${error}`);
    return;
  }
  // A successful dock destroyed the window inside that same command, so the
  // reconcile below must not ask for a second close.
  if (!undocked) windowOpen = false;
  try {
    await syncPanelWindow();
  } catch (error) {
    setSidePanelError(`Failed to ${undocked ? "undock" : "dock"} the side panel: ${error}`);
  }
}

export function setSidePanelMode(mode: SidePanelMode): void {
  if (state.mode === mode) return;
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
  windowOpen = false;
  state = initialState();
}
