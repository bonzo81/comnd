/**
 * Host tooltip — the info popup for host rows in the connection tree
 * (issue #14).
 *
 * Shows an allow-list of connection details only: hostname/IP, port,
 * platform, and OS version when set. NOTE: OS version is included by
 * explicit user request — the tooltip intentionally shows FOUR values,
 * extending issue #14's original three. Do not "fix" it back to three.
 *
 * Site/location, folder/group path, username, and every other Host field
 * are deliberately excluded: hostTooltipRows() only reads the four
 * allowed fields, so no future Host change can leak anything else into
 * the tooltip.
 *
 * The popup appears on hover AND keyboard focus (WCAG 2.1 AA target,
 * docs/specs/accessibility.md). A native title attribute alone can't do
 * the focus half, so this is a single shared element appended to
 * document.body: position: fixed escapes the nav panel's overflow
 * clipping, and Escape dismisses it without moving focus (WCAG 1.4.13).
 */

import type { Host } from "./tauri-api";
import { escHtml } from "./format";
import { getPlatformMeta } from "./platforms";

export interface HostTooltipRow {
  label: string;
  value: string;
}

/** Tooltip element id — also the anchor button's aria-describedby value. */
export const HOST_TOOLTIP_ID = "nav-host-tooltip";

/** Gap between the row's right edge and the tooltip, in px. */
const GAP = 8;

/**
 * The only Host fields the tooltip may ever show, in display order.
 * OS version is optional: the row is omitted entirely when unset —
 * never an empty row, never a literal "null".
 */
export function hostTooltipRows(host: Host): HostTooltipRow[] {
  const rows: HostTooltipRow[] = [
    { label: "Hostname/IP", value: host.hostname },
    { label: "Port", value: String(host.port) },
    { label: "Platform", value: getPlatformMeta(host.platform).label },
  ];
  if (host.os_version != null && host.os_version !== "") {
    rows.push({ label: "OS Version", value: host.os_version });
  }
  return rows;
}

/** Escaped inner-HTML for the tooltip's rows. */
export function renderHostTooltipHtml(host: Host): string {
  return hostTooltipRows(host)
    .map(
      (r) =>
        `<div class="nav-host-tip-row"><span class="nav-host-tip-label">${escHtml(r.label)}</span><span class="nav-host-tip-value">${escHtml(r.value)}</span></div>`,
    )
    .join("");
}

/**
 * The shared tooltip element. One instance per app; NavPanel feeds it the
 * hovered/focused row. Dumb by design — show/hide/position only. The
 * hover-vs-focus trigger state lives in the nav panel, which calls show()
 * whenever either trigger holds.
 */
export class HostTooltip {
  private el: HTMLElement;
  /** Row the tooltip was last shown for (null while hidden). */
  private row: HTMLElement | null = null;
  /** Button whose aria-describedby points here; cleared on hide. */
  private described: HTMLElement | null = null;
  /** Hooks so the caller can keep the tooltip open while the pointer
   *  rests on it (WCAG 1.4.13 "hoverable"). */
  onPointerEnterTooltip: (() => void) | null = null;
  onPointerLeaveTooltip: (() => void) | null = null;

  constructor() {
    this.el = document.createElement("div");
    this.el.id = HOST_TOOLTIP_ID;
    this.el.className = "nav-host-tip";
    this.el.setAttribute("role", "tooltip");
    this.el.hidden = true;
    this.el.addEventListener("pointerenter", () => this.onPointerEnterTooltip?.());
    this.el.addEventListener("pointerleave", () => this.onPointerLeaveTooltip?.());
    document.body.appendChild(this.el);
  }

  get visible(): boolean {
    return !this.el.hidden;
  }

  /** The row this tooltip is anchored to, when visible. */
  get anchorRow(): HTMLElement | null {
    return this.row;
  }

  /** Show `host`'s details beside `row` (the .nav-host-row element). */
  show(host: Host, row: HTMLElement) {
    this.detach();
    this.row = row;
    const btn = row.querySelector<HTMLElement>(".nav-item");
    if (btn) {
      btn.setAttribute("aria-describedby", HOST_TOOLTIP_ID);
      this.described = btn;
    }
    this.el.innerHTML = renderHostTooltipHtml(host);
    this.el.hidden = false;
    this.position(row);
  }

  hide() {
    this.detach();
    this.row = null;
    this.el.hidden = true;
  }

  private detach() {
    this.described?.removeAttribute("aria-describedby");
    this.described = null;
  }

  /** Fixed-position beside the row, clamped into the viewport. */
  private position(row: HTMLElement) {
    const rect = row.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = this.el.offsetWidth;
    const h = this.el.offsetHeight;
    // The nav hugs the window's left edge, so the tooltip opens to the
    // row's right, over the content area — it never covers its own
    // trigger. Clamp to the viewport on all sides.
    const left = Math.min(rect.right + GAP, Math.max(GAP, vw - w - GAP));
    const top = Math.min(rect.top, Math.max(GAP, vh - h - GAP));
    // Dynamic positions are the one sanctioned use of inline styles.
    this.el.style.left = `${left}px`;
    this.el.style.top = `${top}px`;
  }
}