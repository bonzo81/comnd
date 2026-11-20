/**
 * Panel Window — the undocked home of the side panel.
 *
 * The panel is the same panel in both homes: this window renders the snapshot
 * the main window publishes and sends interactions back as messages, so the
 * terminal side of the app keeps owning the session, the replay store and the
 * dialogs. Nothing about the SSH session lives here — no keystrokes, no
 * suggestion path, no PTY (ADR-002, ADR-003).
 *
 * The window carries native decorations, so moving, resizing and closing it are
 * the OS's job. Its own content adds one thing the docked panel does not need: a
 * Dock control, because a window with no way back is a trap.
 */

import { matches } from "../lib/shortcuts";
import { renderSidePanel } from "../lib/side-panel-render";
import type { SidePanelAction, SidePanelState } from "../lib/side-panel";
import type { ReplayCommand } from "../lib/tauri-api";

export interface PanelWindowBridge {
  /** Send an interaction to the main window. */
  send: (action: SidePanelAction) => void;
  /** Ask for the current state — a window that just opened has none yet. */
  requestState: () => void;
  /** Subscribe to state pushes from the main window. */
  onState: (listener: (state: SidePanelState) => void) => () => void;
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
      <header class="pw-head">
        <h1 class="pw-title">Panel</h1>
        <button type="button" class="btn-text pw-dock" id="panel-dock" aria-keyshortcuts="Control+Shift+B">Dock</button>
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
  const onKb = () => bridge.send({ type: "mode", mode: "kb" });
  const onReplay = () => bridge.send({ type: "mode", mode: "replay" });

  root.querySelector(".pw-dock")!.addEventListener("click", onDock);
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

  const unsubscribe = bridge.onState(apply);
  bridge.requestState();

  return () => {
    document.removeEventListener("keydown", onKeyDown);
    unsubscribe();
    root.querySelector(".pw-dock")!.removeEventListener("click", onDock);
    kbTab.removeEventListener("click", onKb);
    replayTab.removeEventListener("click", onReplay);
    delete document.documentElement.dataset.comndWindow;
  };
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
    mountPanelWindow(container, {
      send,
      requestState: () => {
        void emitTo("main", "comnd:panel-ready", null).catch(() => {});
      },
      onState: (listener) => {
        let disposed = false;
        let unlisten: (() => void) | null = null;
        void listen<SidePanelState>("comnd:panel-state", (event) => listener(event.payload)).then((fn) => {
          if (disposed) fn();
          else unlisten = fn;
        });
        return () => {
          disposed = true;
          unlisten?.();
        };
      },
    });
  })();
}

