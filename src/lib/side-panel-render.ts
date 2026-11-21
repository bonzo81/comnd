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
import type {
  NetBoxDeviceInterface,
  NetBoxDeviceSummary,
  ReplayCommand,
} from "./tauri-api";

export interface SidePanelHandlers {
  /** Insert a saved replay command into the live session. */
  play: (command: ReplayCommand) => void;
  /** Open the save dialog for a new replay command. */
  add: () => void;
  /** Send a command from the detail pane's example list to the remote. */
  runExample: (command: string) => void;
  /** Fetch the NetBox summary again after a failed load. */
  retryNetbox: () => void;
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

  if (snapshot.kind === "netbox") {
    root.innerHTML = netboxMarkup(snapshot);
    root.querySelector(".nbd-retry")?.addEventListener("click", () => handlers.retryNetbox());
    return;
  }

  root.innerHTML = `<p class="sb-placeholder">${escHtml(snapshot.text)}</p>`;
}

/**
 * The replay list groups by the host's platform, falling back to every saved
 * command when the host has none of its own, so a freshly connected device
 * never shows an empty pane next to a non-empty store.
 */
type NetboxSnapshot = Extract<SidePanelSnapshot, { kind: "netbox" }>;

/**
 * The NetBox tab's pane: identity and status, the facts phase 1 covers, and
 * interface addresses grouped by the interface that owns them. A loading
 * snapshot replaces the values before every fetch, so the error state never
 * sits below stale device facts.
 */
function netboxMarkup(snapshot: NetboxSnapshot): string {
  if (snapshot.phase === "loading") {
    return `
      <div class="nbd nbd-loading" role="status" aria-live="polite">
        <p class="sb-placeholder">Loading NetBox device details…</p>
      </div>
    `;
  }

  if (snapshot.phase === "error") {
    return `
      <div class="nbd nbd-error" role="alert">
        <p class="nbd-error-text">${escHtml(snapshot.message)}</p>
        <button type="button" class="btn-primary btn-small nbd-retry">Retry</button>
      </div>
    `;
  }

  const summary = snapshot.summary;
  const facts: string[] = [];
  if (summary.device_type) facts.push(netboxFact("Device type", summary.device_type));
  if (summary.site) facts.push(netboxFact("Site", summary.site));
  if (summary.location) facts.push(netboxFact("Location", summary.location));
  const rack = rackText(summary);
  if (rack) facts.push(netboxFact("Rack / U", rack));
  if (summary.primary_ip) facts.push(netboxFact("Primary IP", summary.primary_ip));

  const interfaces =
    summary.interfaces.length > 0
      ? summary.interfaces.map(interfaceMarkup).join("")
      : `<p class="sb-placeholder">No interface addresses.</p>`;

  return `
    <div class="nbd">
      <div class="nbd-band">
        <div class="nbd-identity">
          <h3 class="nbd-name">${escHtml(summary.name)}</h3>
          ${summary.status_label
            ? `<span class="nbd-status" data-status="${escHtml(summary.status)}">${escHtml(summary.status_label)}</span>`
            : ""}
        </div>
      </div>
      ${facts.length > 0 ? `<dl class="nbd-facts">${facts.join("")}</dl>` : ""}
      <section class="nbd-section" aria-label="Interfaces">
        <h4 class="nbd-section-label">Interfaces</h4>
        ${interfaces}
      </section>
    </div>
  `;
}

function netboxFact(key: string, value: string): string {
  return `<div class="nbd-fact"><dt>${escHtml(key)}</dt><dd>${escHtml(value)}</dd></div>`;
}

/** "rack-1 · U12 · front"; a missing rack or position simply drops that part. */
function rackText(summary: NetBoxDeviceSummary): string | null {
  const parts: string[] = [];
  if (summary.rack) parts.push(summary.rack);
  if (summary.position != null) {
    const position = Number.isInteger(summary.position)
      ? String(summary.position)
      : summary.position.toFixed(1);
    parts.push(`U${position}`);
  }
  if (summary.face) parts.push(summary.face);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function interfaceMarkup(iface: NetBoxDeviceInterface): string {
  const addresses = iface.addresses
    .map(
      (address) => `
        <li class="nbd-address">${escHtml(address.address)}${address.vrf
          ? `<span class="nbd-vrf">${escHtml(address.vrf)}</span>`
          : ""}</li>`,
    )
    .join("");
  return `
    <div class="nbd-iface" data-interface-id="${iface.id}">
      <div class="nbd-iface-name">${escHtml(iface.name)}</div>
      <ul class="nbd-addresses">${addresses}</ul>
    </div>
  `;
}

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
