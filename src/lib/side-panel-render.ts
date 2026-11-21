/**
 * Side panel rendering — the one implementation both panel homes use.
 *
 * The docked panel lives inside the terminal view's sidebar and the undocked
 * panel lives in its own window; they render the same `SidePanelSnapshot`
 * through these functions, so the two cannot drift into different panels.
 *
 * Snapshots carry raw command data, never markup, which is why this module
 * escapes with the same helpers as the rest of the UI instead of trusting an
 * HTML string that crossed a window boundary.
 */

import { escHtml } from "./format";
import { renderReplayTemplate } from "./replay";
import { SidebarContent, wireExampleCopy } from "./sidebar-content";
import type { SidePanelSnapshot } from "./side-panel";
import type { ReplayCommand } from "./tauri-api";

export interface SidePanelHandlers {
  /** Insert a saved replay command into the live session. */
  play: (command: ReplayCommand) => void;
  /** Open the save dialog for a new replay command. */
  add: () => void;
  /** Send a command from the detail pane's example list to the remote. */
  runExample: (command: string) => void;
}

const sidebarContent = new SidebarContent();

/**
 * Render `snapshot` into `root`, replacing its content, and wire the
 * interactions it contains. Interactions are wired after insertion because the
 * detail pane's markup is a string produced by SidebarContent.
 */
export function renderSidePanel(
  root: HTMLElement,
  snapshot: SidePanelSnapshot,
  handlers: SidePanelHandlers,
): void {
  if (snapshot.kind === "detail") {
    root.innerHTML = sidebarContent.render(snapshot.command, snapshot.referenceUrl);
    root.querySelectorAll<HTMLElement>(".example-item").forEach((el) => {
      el.addEventListener("click", () => {
        const command = el.dataset.command;
        if (command) handlers.runExample(command);
      });
    });
    wireExampleCopy(root);
    return;
  }

  if (snapshot.kind === "replay") {
    root.innerHTML = replayMarkup(snapshot.items, snapshot.platform);
    root.querySelector(".replay-add")?.addEventListener("click", () => handlers.add());
    root.querySelectorAll<HTMLButtonElement>(".replay-play").forEach((btn) => {
      btn.addEventListener("click", () => {
        const command = snapshot.items.find((c) => c.id === btn.dataset.id);
        if (command) handlers.play(command);
      });
    });
    return;
  }

  root.innerHTML = `<p class="sb-placeholder">${escHtml(snapshot.text)}</p>`;
}

/**
 * The replay list groups by the host's platform, falling back to every saved
 * command when the host has none of its own, so a freshly connected device
 * never shows an empty pane next to a non-empty store.
 */
function replayMarkup(items: ReplayCommand[], platform: string): string {
  const forPlatform = items.filter((c) => c.platform === platform);
  const shown = forPlatform.length > 0 ? forPlatform : items;
  const list = shown
    .map(
      (c) => `
        <div class="replay-item" data-id="${escHtml(c.id)}">
          <code class="replay-cmd">${renderReplayTemplate(c.command)}</code>
          <div class="replay-actions">
            <button class="btn-text replay-play" data-id="${escHtml(c.id)}" title="Play into terminal" aria-label="Play command into terminal">▶ Play</button>
          </div>
        </div>`,
    )
    .join("");

  return `
    <div class="replay-panel">
      <div class="replay-panel-head">
        ${forPlatform.length === 0 && items.length > 0 ? `<p class="sb-placeholder">No commands for this platform — showing all</p>` : ""}
        <button class="btn-text replay-add" title="Add command manually">+ Add command</button>
      </div>
      ${items.length === 0
        ? `<p class="sb-placeholder">No saved commands yet. Select text in the terminal, right-click → <strong>Add to Command Replay</strong>.</p>`
        : `<div class="replay-list">${list}</div>`}
    </div>
  `;
}
