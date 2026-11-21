/**
 * Panel Window — the undocked home of the side panel.
 *
 * The panel is the same panel in both homes: this window renders the snapshot
 * the main window publishes and sends interactions back as messages, so the
 * terminal side of the app keeps owning the session, the replay store and the
 * dialogs. Nothing about the SSH session lives here — no keystrokes, no
 * suggestion path, no PTY (ADR-002, ADR-003).
 *
 * The window is frameless, matching the main window, so its content supplies
 * the window controls: the header is the drag region and carries Dock, because a
 * window with no way back is a trap, and Close, because Escape is not a hint
 * anyone can see.
 */

import { icons } from "../lib/icons";
import { ariaKeyShortcuts, matches, setOverrides } from "../lib/shortcuts";
import { renderSidePanel } from "../lib/side-panel-render";
import { applyReadingComfortState, type ReadingComfortState } from "../lib/reading-comfort";
import { setAppTheme, type Theme } from "../lib/theme";
import type { SidePanelAction, SidePanelState } from "../lib/side-panel";
import type { ReplayCommand } from "../lib/tauri-api";

export interface PanelWindowBridge {
  /** Send an interaction to the main window. */
  send: (action: SidePanelAction) => void;
  /** Ask for the current state — a window that just opened has none yet. */
  requestState: () => void;
  /** Subscribe to state pushes from the main window. Resolves once the
   *  subscription is live, which is when asking for the first snapshot is safe. */
  onState: (listener: (state: SidePanelState) => void) => Promise<() => void>;
}

/**
 * Mount the undocked panel into `root` and return a teardown. Split from the
 * Tauri wiring so the panel's own behaviour — Dock control, tabs, shortcuts —
 * is testable without a window.
 */
export function mountPanelWindow(root: HTMLElement, bridge: PanelWindowBridge): () => void {
  document.documentElement.dataset.comndWindow = "panel";
  document.title = "Comnd Panel";

  root.innerHTML = `
    <div class="panel-window">
      <header class="pw-head" data-tauri-drag-region="deep">
        <h1 class="pw-title">Panel</h1>
        <button type="button" class="btn-text pw-dock" id="panel-dock" aria-keyshortcuts="${ariaKeyShortcuts("toggle-side-panel")}">${icons.dock}<span>Dock</span></button>
        <button type="button" class="btn-text pw-close" id="panel-close" aria-label="Close panel" title="Close panel" aria-keyshortcuts="Escape">${icons.x}</button>
      </header>
      <div class="sb-toggle" role="tablist" aria-label="Panel content">
        <button class="sb-toggle-btn sb-toggle-kb" role="tab" aria-selected="true">Knowledge Base</button>
        <button class="sb-toggle-btn sb-toggle-replay" role="tab" aria-selected="false">Command Replay</button>
      </div>
      <div class="sb-content"><p class="sb-placeholder">Waiting for the terminal…</p></div>
    </div>
  `;

  const content = root.querySelector<HTMLElement>(".sb-content")!;
  const kbTab = root.querySelector<HTMLElement>(".sb-toggle-kb")!;
  const replayTab = root.querySelector<HTMLElement>(".sb-toggle-replay")!;
  const dock = root.querySelector<HTMLButtonElement>(".pw-dock")!;

  const handlers = {
    play: (command: ReplayCommand) => bridge.send({ type: "play", id: command.id }),
    add: () => bridge.send({ type: "add" }),
    runExample: (command: string) => bridge.send({ type: "run", command }),
  };

  let renderedSnapshot: SidePanelState["snapshot"] | null = null;

  const apply = (state: SidePanelState) => {
    kbTab.classList.toggle("active", state.mode === "kb");
    replayTab.classList.toggle("active", state.mode === "replay");
    kbTab.setAttribute("aria-selected", String(state.mode === "kb"));
    replayTab.setAttribute("aria-selected", String(state.mode === "replay"));
    if (state.snapshot === renderedSnapshot) return;
    renderedSnapshot = state.snapshot;
    renderSidePanel(content, state.snapshot, handlers);
  };

  const onDock = () => bridge.send({ type: "dock" });
  const onClose = () => bridge.send({ type: "close" });
  const onKb = () => bridge.send({ type: "mode", mode: "kb" });
  const onReplay = () => bridge.send({ type: "mode", mode: "replay" });

  // Rebinding the panel shortcut anywhere in the app re-emits this event, so a
  // saved override reaches the Dock control's advertised shortcut too.
  const syncDockShortcut = () => {
    dock.setAttribute("aria-keyshortcuts", ariaKeyShortcuts("toggle-side-panel"));
  };
  window.addEventListener("comnd:shortcuts", syncDockShortcut);

  dock.addEventListener("click", onDock);
  root.querySelector(".pw-close")!.addEventListener("click", onClose);
  kbTab.addEventListener("click", onKb);
  replayTab.addEventListener("click", onReplay);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault();
      bridge.send({ type: "close" });
      return;
    }
    // Undocked, the toggle shortcut means "put the panel back", the same thing
    // it does from the terminal.
    if (matches(e, "terminal") === "toggle-side-panel") {
      e.preventDefault();
      onDock();
    }
  };
  document.addEventListener("keydown", onKeyDown);

  // Subscribe before asking for a snapshot: the reply is an event, and a
  // request that beats the subscription leaves the window on its placeholder
  // until the subject next changes.
  let disposed = false;
  let unsubscribe: (() => void) | null = null;
  void bridge.onState(apply).then((fn) => {
    if (disposed) {
      fn();
      return;
    }
    unsubscribe = fn;
    bridge.requestState();
  });

  return () => {
    disposed = true;
    document.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("comnd:shortcuts", syncDockShortcut);
    unsubscribe?.();
    unsubscribe = null;
    dock.removeEventListener("click", onDock);
    root.querySelector(".pw-close")!.removeEventListener("click", onClose);
    kbTab.removeEventListener("click", onKb);
    replayTab.removeEventListener("click", onReplay);
    delete document.documentElement.dataset.comndWindow;
  };
}

/**
 * Preferences the main window owns and this window must mirror: the app theme
 * and Reading Comfort scale are applied per document, so a change made while
 * the panel is open would otherwise leave it at the old scale until reopened.
 */
export interface PanelPreferences {
  theme: Theme;
  readingComfort: ReadingComfortState | null;
}

export function applyPanelPreferences(prefs: PanelPreferences): void {
  setAppTheme(prefs.theme);
  applyReadingComfortState(prefs.readingComfort);
}

/**
 * Real-window wiring: state arrives as a Tauri event from the main window and
 * interactions go back the same way. `comnd:panel-ready` tells the main window
 * to push the current state — the push that accompanied window creation races
 * this document's first paint.
 */
export function mountPanelWindowInAppRoot(container: HTMLElement): void {
  void (async () => {
    const { listen, emitTo } = await import("@tauri-apps/api/event");
    const send = (action: SidePanelAction) => {
      void emitTo("main", "comnd:panel-action", action).catch(() => {});
    };
    // Register these before the panel asks for its first snapshot, so the prefs
    // and shortcut replies cannot arrive before anything is listening.
    await listen<PanelPreferences>("comnd:panel-prefs", (event) => {
      applyPanelPreferences(event.payload);
    });
    // The main window owns the override map; a saved rebinding has to reach
    // this window's own registry or a moved Dock shortcut stops working here.
    await listen<Record<string, string>>("comnd:shortcuts", (event) => {
      setOverrides(event.payload ?? {});
    });
    mountPanelWindow(container, {
      send,
      requestState: () => {
        void emitTo("main", "comnd:panel-ready", null).catch(() => {});
      },
      onState: (listener) =>
        listen<SidePanelState>("comnd:panel-state", (event) => listener(event.payload)),
    });
  })();
}

