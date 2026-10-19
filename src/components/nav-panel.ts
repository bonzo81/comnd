/**
 * Nav Panel — persistent left navigation (replaces the app tab bar).
 *
 * Three sections: Connections, Knowledge Base, Settings.
 * Each section collapses/expands independently; expanding switches the content view.
 * Connections section: group tree with hosts nested under their group,
 * in-place search filtering, and drag & drop for moving hosts/groups.
 * Roving tabindex + arrow/Enter/Left/Right keyboard navigation.
 */

import {
  Host,
  deleteHost,
  deleteHostGroup,
  getHosts,
  getHostGroups,
  moveHostGroup,
  saveHost,
  saveHostGroup,
  netboxSetDeviceEnabled,
  netboxSync,
} from "../lib/tauri-api";
import { ALL_GROUP_ID, hostMatches, sortByRecent, isNetboxHostId, isNetboxGroup } from "../lib/host-filters";
import { escHtml } from "../lib/format";
import { HostTooltip } from "../lib/host-tooltip";
import { confirmDialog } from "../lib/confirm-dialog";
import { log, LogTag } from "../lib/logger";
import { icons } from "../lib/icons";
import { initContextMenu } from "../lib/a11y";
import { showToast } from "../lib/toast";
import { NetBoxConfigureDialog } from "./netbox-configure-dialog";

export type NavSection = "connections" | "kb" | "replay";

export interface NavCallbacks {
  onSelectHost: (hostId: string) => void;
  onConnectHost: (hostId: string) => void;
  onEditHost: (hostId: string) => void;
  onKbTab: (tab: "browse" | "import") => void;
  onOpenReplay: () => void;
  onNewConnection: () => void;
  onAddHostToGroup: (groupId: string) => void;
  onTreeChanged: () => void;
  /** Live set of host ids with an active SSH session. Used to colour the
   *  host-row dot green in the nav panel, matching the content area. */
  getActiveSessions: () => Set<string>;
}

/** Pointer must dwell on a row this long before the tooltip shows, so
 *  sweeping the pointer across the tree doesn't flash a tooltip on every
 *  row it crosses. Keyboard focus bypasses the delay entirely. */
const TIP_HOVER_DELAY_MS = 700;
/** Grace period before hiding once every trigger is gone, so the pointer
 *  can cross the gap between row and tooltip without a flicker. */
const TIP_HIDE_GRACE_MS = 150;

type DragPayload = { kind: "host" | "group"; id: string };

export class NavPanel {
  private container: HTMLElement;
  private cb: NavCallbacks;
  private openSections = new Set<NavSection>(["connections"]);
  /** Expanded group ids. Persisted to localStorage so a reload preserves the
   *  tree state. Without persistence, a reload collapses every group except
   *  All Hosts, which the user perceives as "expand state is flaky". */
  private expandedGroups = new Set<string>(NavPanel.loadExpanded());
  private groups: { id: string; name: string; icon: string | null; color: string | null; parent_id: string | null; sort_order: number }[] = [];
  private hosts: Host[] = [];
  private selectedHostId: string | null = null;
  private searchQuery = "";
  /**
   * THE active sub-item, app-wide. Exactly one sub-item is highlighted:
   * the active one in the current view. Replaces the former per-section
   * fields (activeKbTab / activeReplayId).
   */
  private activeItem: { section: NavSection; id: string } | null = null;
  /** Current app view, so sub-item highlights match the visible screen. */
  private currentView: NavSection | "terminal" | "settings" | null = null;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;
  private creatingIn: string | null = null;
  private contextMenu: { type: "host" | "group"; id: string; x: number; y: number } | null = null;
  private renaming: { type: "host" | "group"; id: string } | null = null;
  private dragPayload: DragPayload | null = null;
  private dropIndicator: HTMLElement | null = null;
  /** Shared host-row tooltip (issue #14): hostname/IP, port, platform, and
   *  OS version when set — shown on hover AND keyboard focus. */
  private tooltip = new HostTooltip();
  /** Host row under the pointer / holding focus / with the pointer resting
   *  on the tooltip itself. The tooltip stays up while any holds. */
  private tipHoverRow: HTMLElement | null = null;
  private tipFocusRow: HTMLElement | null = null;
  private tipOverTooltip = false;
  /** Pending hover-dwell show / grace-period hide (null = nothing pending). */
  private tipHoverTimer: number | null = null;
  private tipHideTimer: number | null = null;
  /** Document-level tooltip dismissal handlers (Escape outside the nav,
   *  scroll, resize) — installed once in mount(), see
   *  bindDocTooltipDismissals(). */
  private docEscapeHandler: ((e: KeyboardEvent) => void) | null = null;
  private docScrollHandler: ((e: Event) => void) | null = null;
  private docResizeHandler: (() => void) | null = null;

  private static STORAGE_KEY = "comnd.nav.expandedGroups";

  private static loadExpanded(): string[] {
    try {
      const raw = localStorage.getItem(NavPanel.STORAGE_KEY);
      if (!raw) return [ALL_GROUP_ID];
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.every((x) => typeof x === "string")) {
        return arr.length > 0 ? arr : [ALL_GROUP_ID];
      }
    } catch {
      // fall through to default
    }
    return [ALL_GROUP_ID];
  }

  private persistExpanded() {
    try {
      localStorage.setItem(NavPanel.STORAGE_KEY, JSON.stringify(Array.from(this.expandedGroups)));
    } catch {
      // localStorage unavailable / quota — state stays in-memory only
    }
  }

  /** Expand a group and persist. */
  private expandGroup(id: string) {
    this.expandedGroups.add(id);
    this.persistExpanded();
  }

  /** Collapse a group and persist. */
  private collapseGroup(id: string) {
    this.expandedGroups.delete(id);
    this.persistExpanded();
  }
  private dragStart: { x: number; y: number; el: HTMLElement } | null = null;
  private dragClone: HTMLElement | null = null;
  private dragCloneOff: { x: number; y: number } = { x: 0, y: 0 };
  private dragMoved = false;
  private dragHoldTimer: number | null = null;

  constructor(container: HTMLElement, callbacks: NavCallbacks) {
    this.container = container;
    this.cb = callbacks;
    // WCAG 1.4.13 "hoverable": the pointer can move from a row onto the
    // tooltip without dismissing it.
    this.tooltip.onPointerEnterTooltip = () => {
      this.tipOverTooltip = true;
    };
    this.tooltip.onPointerLeaveTooltip = () => {
      this.tipOverTooltip = false;
      this.syncTooltip();
    };
  }

  async mount() {
    await this.loadData();
    this.render();
    this.bindKeys();
    this.bindDocTooltipDismissals();
  }

  /** Update the host-row dots to reflect the current active-session set,
   *  without a full re-render. Called by the App when a session connects or
   *  disconnects so the nav panel reflects the same green dot the content
   *  area shows. */
  refreshSessionDots() {
    const active = this.cb.getActiveSessions();
    this.container.querySelectorAll<HTMLElement>(".nav-host-row[data-host-id]").forEach((row) => {
      const id = row.dataset.hostId ?? "";
      const dot = row.querySelector<HTMLElement>(".nav-host-dot");
      if (!dot) return;
      const isActive = active.has(id);
      dot.classList.toggle("dot-ok", isActive);
      dot.title = isActive ? "Session active" : "Previously connected";
    });
  }

  // ─── Host-row tooltip (issue #14) ─────────────────────────────────

  /**
   * Resolve hover/focus into tooltip visibility. Two trigger policies:
   *
   * - Focus shows immediately — a keyboard user lands on a row and
   *   expects the info now.
   * - Hover shows only after a dwell delay (TIP_HOVER_DELAY_MS), so
   *   sweeping the pointer across the tree doesn't flash a tooltip on
   *   every row it crosses.
   *
   * "Pointer resting on the tooltip" keeps it up (WCAG 1.4.13 hoverable),
   * and losing every trigger hides after a short grace (TIP_HIDE_GRACE_MS)
   * so the pointer can cross the gap between row and tooltip — or move
   * straight to a neighbouring row — without a flicker.
   */
  private syncTooltip() {
    // Never show while a context menu is open or a drag is in progress;
    // the next hover/focus re-syncs once it ends.
    if (this.contextMenu || this.dragStart || this.dragPayload) {
      this.hideTooltip();
      return;
    }
    // Pointer resting on the tooltip itself: keep whatever is showing.
    if (this.tipOverTooltip && this.tooltip.visible) {
      this.cancelTipTimers();
      return;
    }
    if (this.tipFocusRow) {
      this.cancelTipTimers();
      this.showTooltipFor(this.tipFocusRow);
      return;
    }
    if (this.tipHoverRow) {
      // Hover on the row the tooltip already describes: nothing to do.
      if (this.tooltip.visible && this.tooltip.anchorRow === this.tipHoverRow) {
        this.cancelTipTimers();
        return;
      }
      this.cancelTipHide();
      this.armTipShow(this.tipHoverRow);
      return;
    }
    this.armTipHide();
  }

  /** Show the tooltip for `row` now — committed triggers only. */
  private showTooltipFor(row: HTMLElement) {
    const host = this.hosts.find((h) => h.id === row.dataset.hostId);
    if (host) {
      this.tooltip.show(host, row);
    } else {
      this.tooltip.hide();
    }
  }

  /** Arm (or re-arm) the delayed hover show for `row`. */
  private armTipShow(row: HTMLElement) {
    this.cancelTipShow();
    this.tipHoverTimer = window.setTimeout(() => {
      this.tipHoverTimer = null;
      // The dwell only counts if the pointer never left the row.
      if (this.tipHoverRow === row) this.showTooltipFor(row);
    }, TIP_HOVER_DELAY_MS);
  }

  /** Arm the grace hide; any new trigger cancels it via syncTooltip. */
  private armTipHide() {
    this.cancelTipShow();
    if (!this.tooltip.visible) return;
    if (this.tipHideTimer !== null) return;
    this.tipHideTimer = window.setTimeout(() => {
      this.tipHideTimer = null;
      if (!this.tipHoverRow && !this.tipFocusRow && !this.tipOverTooltip) {
        this.tooltip.hide();
      }
    }, TIP_HIDE_GRACE_MS);
  }

  private cancelTipShow() {
    if (this.tipHoverTimer !== null) {
      window.clearTimeout(this.tipHoverTimer);
      this.tipHoverTimer = null;
    }
  }

  private cancelTipHide() {
    if (this.tipHideTimer !== null) {
      window.clearTimeout(this.tipHideTimer);
      this.tipHideTimer = null;
    }
  }

  private cancelTipTimers() {
    this.cancelTipShow();
    this.cancelTipHide();
  }

  /** Clear every tooltip trigger and pending timer, and hide it
   *  (re-render, drag, Escape). */
  private hideTooltip() {
    this.tipHoverRow = null;
    this.tipFocusRow = null;
    this.tipOverTooltip = false;
    this.cancelTipTimers();
    this.tooltip.hide();
  }

  /**
   * Document-level dismissal paths the nav-scoped keyHandler can't reach
   * (WCAG 1.4.13):
   *
   * - Escape while keyboard focus is outside the nav panel (e.g. in the
   *   terminal) must still dismiss a hover-triggered tooltip. Passive by
   *   design: when focus is in the terminal, the Escape byte belongs to
   *   the remote device (shadow-buffer rule, ADR-002) — never
   *   preventDefault or stopPropagation here.
   * - The tooltip is fixed to the viewport: any scroll that moves its
   *   anchor row, or a window resize, leaves it misplaced. Wheel
   *   scrolling never fires pointerenter/leave, so nothing else would
   *   re-anchor or dismiss it.
   */
  private bindDocTooltipDismissals() {
    if (this.docEscapeHandler) {
      document.removeEventListener("keydown", this.docEscapeHandler, true);
    }
    this.docEscapeHandler = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !this.tooltip.visible) return;
      if (this.contextMenu) return; // closing the menu owns this press
      // Focus inside the nav: the container keyHandler owns the press
      // (first Escape dismisses only the tooltip there).
      if (this.container.contains(document.activeElement)) return;
      this.hideTooltip();
    };
    document.addEventListener("keydown", this.docEscapeHandler, true);

    // Scroll doesn't bubble — listen on capture to see every scroller.
    if (this.docScrollHandler) {
      document.removeEventListener("scroll", this.docScrollHandler, true);
    }
    this.docScrollHandler = (e: Event) => {
      if (!this.tooltip.visible) return;
      const anchor = this.tooltip.anchorRow;
      if (!anchor) return;
      const t = e.target;
      // Only scrolls that actually move the anchor row invalidate it
      // (terminal scrollback, modal content, etc. don't).
      if (t instanceof Element ? t.contains(anchor) : t === document) {
        this.hideTooltip();
      }
    };
    document.addEventListener("scroll", this.docScrollHandler, true);

    if (this.docResizeHandler) {
      window.removeEventListener("resize", this.docResizeHandler);
    }
    this.docResizeHandler = () => {
      if (this.tooltip.visible) this.hideTooltip();
    };
    window.addEventListener("resize", this.docResizeHandler);
  }

  /** Re-render (e.g., after groups/hosts change). */
  async refresh() {
    await this.loadData();
    this.render();
  }

  /** Expand a section (others stay as-is). No view switch. */
  setSection(section: NavSection) {
    this.setSectionOpen(section, true);
  }

  /** Open or close one section without touching the others. */
  private setSectionOpen(section: NavSection, open: boolean) {
    if (open) this.openSections.add(section);
    else this.openSections.delete(section);
    const sec = this.container.querySelector<HTMLElement>(`.nav-section[data-section="${section}"]`);
    if (!sec) return;
    sec.querySelector<HTMLElement>(".nav-section-items")?.classList.toggle("open", open);
    const header = sec.querySelector<HTMLElement>(".nav-section-header");
    if (header) header.setAttribute("aria-expanded", String(open));
    this.applyRovingTabindex();
  }

  /**
   * Single source of truth for sub-item highlighting. Exactly one sub-item
   * across ALL sections is highlighted at a time — the active one in the
   * current view. Host rows are excluded (their selection is independent
   * of view switching).
   */
  private applyActiveItem() {
    const view = this.currentView;
    const active = this.activeItem;
    // Host rows highlight independently of the current view.
    this.container.querySelectorAll<HTMLElement>(".nav-host-row[data-host-id]").forEach((el) => {
      el.classList.toggle("nav-selected", el.dataset.hostId === this.selectedHostId);
    });
    this.container.querySelectorAll<HTMLElement>(".nav-item[data-section]").forEach((el) => {
      const isActive = active !== null
        && el.dataset.section === active.section
        && el.dataset.subId === active.id
        && view === active.section;
      el.classList.toggle("nav-selected", isActive);
    });
  }

  /** Set the current view so sub-item highlights match the visible screen.
   *  "settings" highlights nothing — its pages live in the settings
   *  screen's own icon rail. */
  setView(view: "connections" | "terminal" | "knowledge-base" | "replay" | "settings") {
    const section: NavSection | "terminal" | "settings" =
      view === "knowledge-base" ? "kb" : view;
    if (this.currentView === section) return;
    this.currentView = section;
    this.applyActiveItem();
  }

  /**
   * Sync the active sub-item from the current view's truth-holder
   * (kbScreen tab, replay's single item). Called from showView() so
   * deep-links and keyboard shortcuts highlight correctly even when no
   * nav item was clicked.
   */
  syncActiveItem(item: { section: NavSection; id: string } | null) {
    this.activeItem = item;
    this.applyActiveItem();
  }

  /** Look up a host by id (for the connect flow). */
  getHost(hostId: string): Host | undefined {
    return this.hosts.find((h) => h.id === hostId);
  }

  /** Clear the search box (global Escape). */
  clearSearch() {
    const input = this.container.querySelector<HTMLInputElement>("#nav-host-search");
    if (input) input.value = "";
    this.applySearch("");
  }

  private async loadData() {
    try {
      const gs = await getHostGroups();
      this.groups = gs.map((g) => ({ id: g.id, name: g.name, icon: g.icon, color: g.color, parent_id: g.parent_id, sort_order: g.sort_order }));
      this.groups.sort((a, b) => a.sort_order - b.sort_order);
    } catch {
      this.groups = [];
    }
    try {
      this.hosts = await getHosts();
    } catch {
      this.hosts = [];
    }
    if (this.selectedHostId && !this.hosts.some((h) => h.id === this.selectedHostId)) {
      this.selectedHostId = null;
    }
  }

  // ─── Search / tree visibility ────────────────────────────────────

  private applySearch(query: string) {
    this.searchQuery = query;
    this.render();
  }

  /** Group ids that should stay visible for the current search (empty query → all). */
  private visibleGroupIds(): Set<string> | null {
    const q = this.searchQuery.toLowerCase().trim();
    if (!q) return null;
    const keep = new Set<string>();
    const byParent = new Map<string | null, Host[]>();
    for (const h of this.hosts) {
      const key = h.group_id ?? null;
      const arr = byParent.get(key) ?? [];
      arr.push(h);
      byParent.set(key, arr);
    }
    for (const [gid, hs] of byParent) {
      if (!hs.some((h) => hostMatches(h, q))) continue;
      if (gid === null) continue; // ungrouped: no group ancestor to show
      const g = this.groups.find((x) => x.id === gid);
      if (!g) continue;
      let cur: { id: string; parent_id: string | null } | undefined = g;
      while (cur) {
        if (!keep.has(cur.id)) {
          keep.add(cur.id);
          cur = this.groups.find((x) => x.id === cur!.parent_id);
        } else {
          break;
        }
      }
    }
    return keep;
  }

  private hostVisible(host: Host): boolean {
    if (!this.searchQuery) return true;
    return hostMatches(host, this.searchQuery);
  }

  // ─── Render ──────────────────────────────────────────────────────

  private render() {
    // Tooltip anchor rows die with the innerHTML rebuild below — drop the
    // state first. Focus is restored at the end of render(), which
    // re-shows the tooltip when the focused host row survives the rebuild.
    this.hideTooltip();
    // Preserve focused element across the innerHTML rebuild
    const ae = document.activeElement;
    const prevFocus = ae instanceof HTMLElement && this.container.contains(ae)
      ? this.focusables().indexOf(ae)
      : -1;
    // Preserve caret position in the search input (rendered on every keystroke)
    const search = this.container.querySelector<HTMLInputElement>("#nav-host-search");
    const prevSearchSel = search && search === ae ? search.selectionStart : null;
    this.container.innerHTML = `
      <div class="nav-panel" role="navigation" aria-label="App navigation">
      ${this.renderSection("connections", icons.monitor, "Connections", this.renderConnectionsItems())}
      ${this.renderSection("kb", icons.book, "Knowledge Base", this.renderKbItems())}
      ${this.renderSection("replay", icons.clock, "Command Replay", this.renderReplayItems())}
      </div>
      ${this.contextMenu ? this.renderContextMenu() : ""}
    `;
    this.bindEvents();
    this.applyRovingTabindex();
    // Context menu ARIA + keyboard navigation (arrows/Enter/Escape)
    const ctxMenu = this.container.querySelector("#nav-context-menu");
    if (ctxMenu) {
      initContextMenu(ctxMenu as HTMLElement, () => {
        this.contextMenu = null;
        this.render();
      });
    }
    if (prevFocus >= 0 && !this.renaming) {
      const els = this.focusables();
      const el = els[Math.min(prevFocus, els.length - 1)];
      if (el) this.focusEl(el);
    }
    if (search === ae) {
      const next = this.container.querySelector<HTMLInputElement>("#nav-host-search");
      if (next) {
        next.focus();
        if (prevSearchSel != null) next.setSelectionRange(prevSearchSel, prevSearchSel);
      }
    }
  }

  private renderSection(section: NavSection, icon: string, label: string, itemsHtml: string): string {
    const open = this.openSections.has(section);
    return `
      <div class="nav-section" data-section="${section}">
        <button class="nav-section-header" data-section="${section}" aria-expanded="${open}">
          <span class="nav-section-icon">${icon}</span>
          <span class="nav-section-label">${label}</span>
        </button>
        <div class="nav-section-items${open ? " open" : ""}">
          ${itemsHtml}
        </div>
      </div>
    `;
  }

  private renderConnectionsItems(): string {
    let html = `
      <div class="nav-action-wrap">
        <button class="nav-item nav-action" data-action="new-connection">
          <span class="nav-action-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
          </span>
          <span class="nav-item-label">New Connection</span>
        </button>
      </div>
      <div class="nav-search-wrap">
        <input type="text" class="form-input form-input-sm nav-search-input" id="nav-host-search" placeholder="Search hosts…" aria-label="Search hosts" value="${escHtml(this.searchQuery)}" />
      </div>
      <div class="nav-group-row nav-root-zone${this.searchQuery ? " hidden" : ""}" data-drop-root data-group-id="${ALL_GROUP_ID}">
        <button class="nav-item nav-sub" data-group-id="${ALL_GROUP_ID}">
          <span class="nav-toggle">${this.allHostsHasChildren() ? (this.expandedGroups.has(ALL_GROUP_ID) ? "▾" : "▸") : ""}</span>
          <span class="nav-sub-icon">${icons.folder}</span>
          <span class="nav-item-label">All Hosts</span>
        </button>
        <span class="nav-row-actions">
          <button class="nav-row-btn" data-action="add-host" data-parent="${ALL_GROUP_ID}" title="Add host here" aria-label="Add host">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
          </button>
          <button class="nav-row-btn" data-action="add-subgroup" data-parent="${ALL_GROUP_ID}" title="New group here" aria-label="New group">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7a2 2 0 0 1 2-2h3.2a1 1 0 0 1 .7.3l1 1a1 1 0 0 0 .7.3H18a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7z"/><path d="M12 11v4M10 13h4"/></svg>
          </button>
        </span>
      </div>
    `;
    const keep = this.visibleGroupIds();
    const allHostsExpanded = this.expandedGroups.has(ALL_GROUP_ID) || keep !== null;
    // Ungrouped hosts render directly under the "All Hosts" row, before any
    // named root groups — so they visually nest under All Hosts, not at the
    // bottom of the tree. All Hosts acts as the base/default group; there's
    // no separate "Ungrouped" pseudo-folder.
    if (allHostsExpanded) {
      if (this.creatingIn === ALL_GROUP_ID) {
        html += this.renderCreateRow(1);
      }
      const ungrouped = sortByRecent(this.hosts.filter((h) => !h.group_id && this.hostVisible(h)));
      for (const h of ungrouped) {
        html += this.renderHostRow(h, 1);
      }
    }
    // Named root groups render after the ungrouped hosts, nested one level
    // under All Hosts (the catch-all). The NetBox synthetic root stays at
    // top level (depth 0), left-aligned with All Hosts. Each group carries
    // its own expand/collapse subtree.
    const roots = this.groups.filter((g) => !g.parent_id);
    for (const g of roots) {
      if (keep && !keep.has(g.id)) continue;
      html += this.renderGroupNode(g, isNetboxGroup(g.id) ? 0 : 1);
    }
    return html;
  }

  /** Whether the "All Hosts" root has anything to show (ungrouped hosts or root groups). */
  private allHostsHasChildren(): boolean {
    return this.groups.some((g) => !g.parent_id)
      || this.hosts.some((h) => !h.group_id);
  }

  private renderGroupNode(group: { id: string; name: string; icon: string | null; color: string | null; parent_id: string | null }, depth: number): string {
    const keep = this.visibleGroupIds();
    if (keep && !keep.has(group.id)) return "";
    const children = this.groups.filter((g) => g.parent_id === group.id && (!keep || keep.has(g.id)));
    const groupHosts = sortByRecent(
      this.hosts.filter((h) => h.group_id === group.id && this.hostVisible(h)),
    );
    const hasChildren = children.length > 0 || groupHosts.length > 0;
    const expanded = this.expandedGroups.has(group.id) || keep !== null;
    const indent = 12 + depth * 14;

    // Inline "new group" row appears directly under the group being created in
    const creatingHere = this.creatingIn === group.id;
    const renamingHere = this.renaming?.type === "group" && this.renaming.id === group.id;

    let html = renamingHere
      ? `
      <div class="nav-group-row nav-renaming">
        <input type="text" class="nav-rename-input" value="${escHtml(group.name)}" style="margin-left:${indent}px" />
      </div>
    `
      : `
      <div class="nav-group-row" data-group-id="${group.id}">
        <button class="nav-item nav-sub" data-group-id="${group.id}" draggable="true" style="padding-left:${indent}px">
          <span class="nav-toggle">${hasChildren ? (expanded ? "▾" : "▸") : ""}</span>
          <span class="nav-sub-icon">${group.icon === "netbox" ? icons.netbox : icons.folder}</span>
          <span class="nav-item-label">${escHtml(group.name)}</span>
        </button>
        ${isNetboxGroup(group.id) ? "" : `
        <span class="nav-row-actions">
          <button class="nav-row-btn" data-action="add-host" data-parent="${group.id}" title="Add host here" aria-label="Add host">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
          </button>
          <button class="nav-row-btn" data-action="add-subgroup" data-parent="${group.id}" title="New group here" aria-label="New group">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7a2 2 0 0 1 2-2h3.2a1 1 0 0 1 .7.3l1 1a1 1 0 0 0 .7.3H18a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7z"/><path d="M12 11v4M10 13h4"/></svg>
          </button>
        </span>
        `}
      </div>
    `;
    if (creatingHere) {
      html += this.renderCreateRow(depth + 1);
    }
    if (expanded) {
      for (const child of children) {
        html += this.renderGroupNode(child, depth + 1);
      }
      for (const h of groupHosts) {
        html += this.renderHostRow(h, depth + 1);
      }
    }
    return html;
  }

  private renderHostRow(host: Host, depth: number): string {
    const indent = 12 + depth * 14;
    if (this.renaming?.type === "host" && this.renaming.id === host.id) {
      return `
      <div class="nav-host-row nav-renaming">
        <input type="text" class="nav-rename-input" value="${escHtml(host.display_name)}" style="margin-left:${indent}px" />
      </div>
    `;
    }
    const selected = this.selectedHostId === host.id;
    const active = this.cb.getActiveSessions().has(host.id);
    // Reuse the content-area dot classes so the nav and the content panel
    // show the same green state for an active session.
    const dotClass = active ? "nav-host-dot dot-ok" : "nav-host-dot";
    const dotTitle = active ? "Session active" : (host.last_connected ? "Previously connected" : "Never connected");
    return `
      <div class="nav-host-row ${selected ? "nav-selected" : ""}" data-host-id="${host.id}">
        <button class="nav-item nav-sub" data-host-id="${host.id}" draggable="true" style="padding-left:${indent}px">
          <span class="nav-toggle"></span>
          <span class="${dotClass}" title="${escHtml(dotTitle)}"></span>
          <span class="nav-item-label">${escHtml(host.display_name)}</span>
        </button>
      </div>
    `;
  }

  private renderCreateRow(depth: number): string {
    const indent = 12 + depth * 14;
    return `
      <div class="nav-group-row nav-creating" data-creating>
        <input type="text" class="nav-create-input" placeholder="New group" style="margin-left:${indent}px" />
      </div>
    `;
  }

  private focusCreateInput() {
    const input = this.container.querySelector<HTMLInputElement>(".nav-create-input");
    if (input) {
      input.focus();
      input.select();
    }
  }

  /** Rows that are the direct children of a group row (before the next group row). */
  private groupChildRows(row: HTMLElement): HTMLElement[] {
    const out: HTMLElement[] = [];
    for (let n = row.nextElementSibling as HTMLElement | null; n; n = n.nextElementSibling as HTMLElement | null) {
      if (n.classList.contains("nav-group-row")) break;
      out.push(n);
    }
    return out;
  }

  private setGroupToggle(row: HTMLElement, expanded: boolean) {
    const btn = row.querySelector<HTMLElement>(".nav-item.nav-sub");
    const toggle = btn?.querySelector<HTMLElement>(".nav-toggle");
    if (toggle) toggle.textContent = expanded ? "▾" : "▸";
  }

  /** Animate-collapse the group's child rows, then re-render once. */
  private collapseGroupRows(row: HTMLElement) {
    const rows = this.groupChildRows(row);
    if (rows.length === 0) {
      this.render();
      return;
    }
    rows.forEach((r) => r.classList.add("nav-collapsing"));
    // Guard against the duplicate-render race: both transitionend and the
    // 220ms fallback could fire `done()`, and a spurious second render
    // clobbers an incremental expand that happened in between. The first
    // caller wins; the other is a no-op.
    let fired = false;
    const done = () => {
      if (fired) return;
      fired = true;
      rows.forEach((r) => r.classList.remove("nav-collapsing"));
      this.render();
    };
    // `transitionend` only fires for `rows[0]`'s margin-bottom; remove the
    // listener after first fire so a bubbling event from a later transition
    // can't re-trigger.
    const onEnd = (e: TransitionEvent) => {
      if (e.propertyName !== "margin-bottom") return;
      rows[0].removeEventListener("transitionend", onEnd);
      done();
    };
    rows[0].addEventListener("transitionend", onEnd);
    setTimeout(done, 220);
  }

  /** Build and insert a group's child rows (subgroups + hosts) after the group row. */
  private mountGroupChildren(groupId: string, row: HTMLElement): HTMLElement[] {
    const keep = this.visibleGroupIds();
    const depth = (parseInt(row.querySelector<HTMLElement>(".nav-item")?.style.paddingLeft ?? "12", 10) - 12) / 14;
    const children = this.groups.filter((g) => g.parent_id === groupId && (!keep || keep.has(g.id)));
    const groupHosts = sortByRecent(
      this.hosts.filter((h) => h.group_id === groupId && this.hostVisible(h)),
    );
    const frag = document.createDocumentFragment();
    for (const child of children) {
      const tmp = document.createElement("div");
      tmp.innerHTML = this.renderGroupNode(child, depth + 1).trim();
      while (tmp.firstElementChild) frag.appendChild(tmp.firstElementChild);
    }
    for (const h of groupHosts) {
      const tmp = document.createElement("div");
      tmp.innerHTML = this.renderHostRow(h, depth + 1).trim();
      while (tmp.firstElementChild) frag.appendChild(tmp.firstElementChild);
    }
    // Remember where the inserted block ends BEFORE `after(frag)` empties it.
    const lastInserted = frag.lastElementChild;
    row.after(frag);
    // Bind handlers ONLY on the freshly-inserted rows. The group row itself
    // already has its handler from the last `render()`; calling `bindEvents()`
    // here would stack a second handler on every existing row in the panel,
    // and a single click would toggle the group N times (the "4th click does
    // nothing" bug — collapse + re-expand cancel out, or vice-versa).
    const inserted: HTMLElement[] = [];
    for (let n = row.nextElementSibling as HTMLElement | null; n; n = n.nextElementSibling as HTMLElement | null) {
      inserted.push(n);
      if (n === lastInserted) break;
    }
    inserted.forEach((r) => {
      // querySelectorAll matches descendants only — the inserted row
      // itself never matches ".nav-host-row", so click, dblclick, and the
      // tooltip listeners were silently missing on hosts revealed by an
      // in-place expand (a pre-existing click gap the tooltip inherited).
      // Bind the row root first, then its descendants (the button drag
      // source and per-row action buttons).
      if (r.matches(".nav-host-row")) this.bindRowEvents(r);
      r.querySelectorAll<HTMLElement>(".nav-item.nav-sub[data-group-id], .nav-host-row, .nav-group-row > .nav-item[data-group-id], .nav-host-row > .nav-item[data-host-id], .nav-row-btn").forEach((el) => {
        this.bindRowEvents(el);
      });
    });
    return this.groupChildRows(row);
  }

  private async commitCreate(rawName: string) {
    const parentId = this.creatingIn;
    this.creatingIn = null;
    const name = rawName.trim();
    if (!parentId) return;
    if (!name) {
      this.render();
      return;
    }
    const resolvedParent = parentId === ALL_GROUP_ID ? null : parentId;
    try {
      const created = await saveHostGroup(null, name, resolvedParent, null, null);
      this.expandGroup(created.id);
      await this.refresh();
      this.cb.onTreeChanged();
    } catch (err) {
      log.error(LogTag.NavPanel, `Failed to create group: ${err}`);
    }
  }

  private async commitRename(rawName: string) {
    const r = this.renaming;
    this.renaming = null;
    if (!r) return;
    const name = rawName.trim();
    try {
      if (r.type === "group") {
        const g = this.groups.find((x) => x.id === r.id);
        if (!g || !name || name === g.name) {
          this.render();
          return;
        }
        await saveHostGroup(g.id, name, g.parent_id, g.color, g.icon);
      } else {
        const h = this.hosts.find((x) => x.id === r.id);
        if (!h || !name || name === h.display_name) {
          this.render();
          return;
        }
        await saveHost({ ...h, display_name: name });
      }
      await this.refresh();
      this.cb.onTreeChanged();
    } catch (err) {
      log.error(LogTag.NavPanel, `Failed to rename: ${err}`);
      this.render();
    }
  }

  /**
   * One sub-item primitive for every section. Same DOM shape everywhere:
   * a full-width row-wrapped button tagged with data-section + data-sub-id,
   * so selection, styling, and click handling are uniform by construction.
   */
  private renderSubItem(section: NavSection, id: string, label: string, opts?: { disabled?: boolean; badge?: string }): string {
    const active = this.activeItem;
    const selected = active !== null && active.section === section && active.id === id && this.currentView === section;
    return `
      <div class="nav-group-row">
        <button class="nav-item nav-sub${opts?.disabled ? " nav-disabled" : ""}${selected ? " nav-selected" : ""}"
                data-section="${section}" data-sub-id="${id}"${opts?.disabled ? " disabled" : ""}>
          <span class="nav-item-label">${escHtml(label)}</span>
          ${opts?.badge ? `<span class="nav-soon">${opts.badge}</span>` : ""}
        </button>
      </div>
    `;
  }

  private renderKbItems(): string {
    return this.renderSubItem("kb", "browse", "Browse KB")
      + this.renderSubItem("kb", "import", "Import KB");
  }

  private renderReplayItems(): string {
    return this.renderSubItem("replay", "manage", "Manage Commands");
  }

  // ─── Context Menu ────────────────────────────────────────────────

  private renderContextMenu(): string {
    if (!this.contextMenu) return "";
    const cm = this.contextMenu;
    let items: string;

    if (cm.type === "group") {
      if (isNetboxGroup(cm.id)) {
        items = `
          <div class="ctx-item" data-action="netbox-refresh">${icons.netbox} Refresh from NetBox</div>`;
      } else {
        const group = this.groups.find((g) => g.id === cm.id);
        items = `
          <div class="ctx-item" data-action="add-subgroup">New Group Here</div>
          <div class="ctx-item" data-action="add-host">Add Host Here</div>
          <div class="ctx-divider"></div>
          <div class="ctx-item" data-action="rename">Rename</div>
          <div class="ctx-item ctx-danger" data-action="delete">Delete ${escHtml(group?.name ?? "Group")}</div>`;
      }
    } else if (isNetboxHostId(cm.id)) {
      const host = this.hosts.find((h) => h.id === cm.id);
      items = `
        <div class="ctx-item" data-action="connect">Connect</div>
        <div class="ctx-item" data-action="configure">Configure</div>
        <div class="ctx-divider"></div>
        <div class="ctx-item ctx-danger" data-action="disable">Disable ${escHtml(host?.display_name ?? "device")}</div>`;
    } else {
      const host = this.hosts.find((h) => h.id === cm.id);
      items = `
        <div class="ctx-item" data-action="connect">Connect</div>
        <div class="ctx-item" data-action="edit">Edit</div>
        <div class="ctx-item" data-action="duplicate">Duplicate</div>
        <div class="ctx-divider"></div>
        <div class="ctx-item" data-action="rename">Rename</div>
        <div class="ctx-item ctx-danger" data-action="delete">Delete ${escHtml(host?.display_name ?? "Host")}</div>`;
    }

    return `
      <div class="context-menu" id="nav-context-menu"
           style="left:${cm.x}px;top:${cm.y}px">
        ${items}
      </div>`;
  }

  // ─── Events ──────────────────────────────────────────────────────

  /**
   * Bind event handlers for the whole panel. Called after `render()` (which
   * rebuilds innerHTML, so all elements are fresh and have zero listeners).
   * NOT called from `mountGroupChildren` — that path inserts rows into the
   * live DOM and would stack duplicate listeners on existing rows. New rows
   * inserted by `mountGroupChildren` are bound via `bindRowEvents`.
   */
  private bindEvents() {
    // Section headers — toggle in place (no re-render) so the collapse/expand animates
    this.container.querySelectorAll<HTMLElement>(".nav-section-header").forEach((el) => {
      el.addEventListener("click", () => {
        const section = el.dataset.section as NavSection;
        const items = el.parentElement?.querySelector<HTMLElement>(".nav-section-items");
        this.setSectionOpen(section, !items?.classList.contains("open"));
      });
    });

    this.container.querySelectorAll<HTMLElement>(".nav-item.nav-sub[data-group-id], .nav-host-row, .nav-group-row > .nav-item[data-group-id], .nav-host-row > .nav-item[data-host-id], .nav-row-btn").forEach((el) => {
      this.bindRowEvents(el);
    });

    // Inline "new group" input
    const createInput = this.container.querySelector<HTMLInputElement>(".nav-create-input");
    if (createInput) {
      createInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void this.commitCreate(createInput.value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          this.creatingIn = null;
          this.render();
        }
      });
      createInput.addEventListener("blur", () => {
        if (this.creatingIn !== null) {
          void this.commitCreate(createInput.value);
        }
      });
    }

    // Inline rename input
    const renameInput = this.container.querySelector<HTMLInputElement>(".nav-rename-input");
    if (renameInput) {
      renameInput.focus();
      renameInput.select();
      renameInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void this.commitRename(renameInput.value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          this.renaming = null;
          this.render();
        }
      });
      renameInput.addEventListener("blur", () => {
        if (this.renaming !== null) {
          void this.commitRename(renameInput.value);
        }
      });
    }

    // Sub-items (KB tabs / Replay / Settings) — one delegated handler for
    // every section. Clicks only fire the callback; the highlight sync
    // happens in showView() via syncActiveItem, keyed off the uniform
    // data-section/data-sub-id attrs.
    this.container.querySelectorAll<HTMLElement>(".nav-item[data-section][data-sub-id]").forEach((el) => {
      el.addEventListener("click", () => {
        const section = el.dataset.section as NavSection;
        const id = el.dataset.subId ?? "";
        if (!section || !id) return;
        if (section === "kb") this.cb.onKbTab(id as "browse" | "import");
        else if (section === "replay") this.cb.onOpenReplay();
      });
    });

    // Search input (filters the tree in place)
    const searchInput = this.container.querySelector<HTMLInputElement>("#nav-host-search");
    if (searchInput) {
      searchInput.addEventListener("input", () => {
        this.applySearch(searchInput.value);
      });
    }

    // Action items
    this.container.querySelector<HTMLElement>('[data-action="new-connection"]')?.addEventListener("click", () => {
      this.cb.onNewConnection();
    });

    // Context menu on group rows (right-click)
    this.container.querySelectorAll<HTMLElement>(".nav-group-row[data-group-id] > .nav-item[data-group-id]").forEach((el) => {
      const gid = el.dataset.groupId;
      if (!gid || gid === ALL_GROUP_ID) return;
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.contextMenu = { type: "group", id: gid, x: e.clientX, y: e.clientY };
        this.render();
      });
    });

    // Context menu on host rows (right-click)
    this.container.querySelectorAll<HTMLElement>(".nav-host-row[data-host-id] > .nav-item[data-host-id]").forEach((el) => {
      const hid = el.dataset.hostId;
      if (!hid) return;
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.contextMenu = { type: "host", id: hid, x: e.clientX, y: e.clientY };
        this.render();
      });
    });

    // Context menu actions
    this.container.querySelectorAll<HTMLElement>(".ctx-item").forEach((el) => {
      el.addEventListener("click", () => {
        const action = el.dataset.action;
        const ctx = this.contextMenu;
        this.contextMenu = null;
        if (!ctx) return;

        switch (action) {
          case "add-subgroup":
            this.creatingIn = ctx.id;
            this.expandGroup(ctx.id);
            this.render();
            this.focusCreateInput();
            break;
          case "add-host":
            this.cb.onAddHostToGroup(ctx.id);
            this.render();
            break;
          case "connect":
            this.cb.onConnectHost(ctx.id);
            this.render();
            break;
          case "edit":
            this.cb.onEditHost(ctx.id);
            this.render();
            break;
          case "duplicate":
            void this.doDuplicateHost(ctx.id);
            break;
          case "rename":
            if (
              (ctx.type === "host" && isNetboxHostId(ctx.id)) ||
              (ctx.type === "group" && isNetboxGroup(ctx.id))
            ) {
              log.warn(LogTag.Netbox, `Guard: rename blocked on NetBox entry ${ctx.id}`);
              showToast("NetBox entries are managed by the NetBox integration — use Configure", "info");
              this.render();
              break;
            }
            this.renaming = { type: ctx.type, id: ctx.id };
            this.render();
            break;
          case "delete": {
            const isGroup = ctx.type === "group";
            const group = isGroup ? this.groups.find((g) => g.id === ctx.id) : null;
            const host = isGroup ? null : this.hosts.find((h) => h.id === ctx.id);
            if (isGroup && !group) break;
            if (!isGroup && !host) break;
            confirmDialog({
              title: isGroup ? "Delete Group" : "Delete Host",
              message: isGroup
                ? `Delete <strong>${escHtml(group!.name)}</strong>? Hosts in this group will be moved to All Hosts. This cannot be undone.`
                : `Delete <strong>${escHtml(host!.display_name)}</strong>? This cannot be undone.`,
              confirmLabel: "Delete",
              destructive: true,
              onConfirm: () => {
                if (isGroup) {
                  void this.doDeleteGroup(ctx.id);
                } else {
                  void this.doDeleteHost(ctx.id);
                }
              },
            });
            break;
          }
          case "configure":
            void new NetBoxConfigureDialog(ctx.id, () => {
              void this.refresh().then(() => this.cb.onTreeChanged());
            }).open();
            this.render();
            break;
          case "disable":
            void this.disableNetboxHost(ctx.id);
            break;
          case "netbox-refresh":
            void this.refreshNetbox();
            break;
        }
      });
    });

    // Click outside context menu. Listens on pointerdown, not mousedown:
    // row drag-start calls preventDefault() on pointerdown, which suppresses
    // the compat mousedown — a mousedown listener never fires when the user
    // clicks another row and the menu stays open.
    if (this._clickOutsideHandler) {
      document.removeEventListener("pointerdown", this._clickOutsideHandler);
    }
    this._clickOutsideHandler = (e: MouseEvent) => {
      if (this.contextMenu) {
        const menuEl = this.container?.querySelector("#nav-context-menu");
        if (menuEl && !menuEl.contains(e.target as Node)) {
          this.contextMenu = null;
          this.render();
        }
      }
    };
    document.addEventListener("pointerdown", this._clickOutsideHandler);
  }

  private _clickOutsideHandler: ((e: MouseEvent) => void) | null = null;

  private async doDeleteGroup(groupId: string) {
    if (isNetboxGroup(groupId)) {
      log.warn(LogTag.Netbox, `Guard: delete blocked on NetBox group ${groupId}`);
      showToast("NetBox groups are managed by the NetBox integration", "info");
      return;
    }
    try {
      await deleteHostGroup(groupId);
      this.contextMenu = null;
      await this.refresh();
      this.cb.onTreeChanged();
    } catch (err) {
      log.error(LogTag.NavPanel, `Failed to delete group: ${err}`);
    }
  }

  private async doDeleteHost(hostId: string) {
    if (isNetboxHostId(hostId)) {
      log.warn(LogTag.Netbox, `Guard: delete blocked on NetBox host ${hostId}`);
      showToast("NetBox hosts are managed by the NetBox integration — disable it via the context menu or Settings → NetBox", "info");
      return;
    }
    try {
      await deleteHost(hostId);
      this.contextMenu = null;
      await this.refresh();
      this.cb.onTreeChanged();
    } catch (err) {
      log.error(LogTag.NavPanel, `Failed to delete host: ${err}`);
    }
  }

  private async doDuplicateHost(hostId: string) {
    if (isNetboxHostId(hostId)) {
      log.warn(LogTag.Netbox, `Guard: duplicate blocked on NetBox host ${hostId}`);
      showToast("NetBox hosts are managed by the NetBox integration — use Configure", "info");
      return;
    }
    const host = this.hosts.find((h) => h.id === hostId);
    if (!host) return;
    try {
      const copy: Host = {
        ...host,
        id: crypto.randomUUID(),
        display_name: `${host.display_name} (copy)`,
        last_connected: null,
      };
      await saveHost(copy);
      await this.refresh();
      this.cb.onTreeChanged();
    } catch (err) {
      log.error(LogTag.NavPanel, `Failed to duplicate host: ${err}`);
    }
  }

  /** Disable a NetBox device (removes it from the host list until re-enabled). */
  private async disableNetboxHost(hostId: string) {
    const id = parseInt(hostId.replace("netbox:", ""), 10);
    if (Number.isNaN(id)) return;
    try {
      await netboxSetDeviceEnabled(id, false);
      showToast("Device disabled — re-enable it in Settings → NetBox", "info");
      await this.refresh();
      this.cb.onTreeChanged();
    } catch (err) {
      log.error(LogTag.Netbox, `Disable device ${id} failed`, err);
      showToast(`Failed to disable device: ${err}`, "error");
    }
  }

  /** Convenience sync from the NetBox folder context menu. */
  private async refreshNetbox() {
    try {
      const report = await netboxSync();
      log.info(LogTag.Netbox, "Sync complete (nav refresh)", { fetched: report.fetched });
      showToast(`Synced ${report.fetched} device${report.fetched !== 1 ? "s" : ""} from NetBox`, "success");
      await this.refresh();
      this.cb.onTreeChanged();
    } catch (err) {
      log.error(LogTag.Netbox, "Sync failed (nav refresh)", err);
      showToast(`NetBox sync failed: ${err}`, "error", 8000);
    }
  }

  /**
   * Bind handlers to a single row element (group row, host row, or row
   * action button). Idempotent-safe: each element gets exactly one listener
   * per event, because callers only pass freshly-created elements (either
   * from a full innerHTML rebuild in `render`, or from a freshly-inserted
   * fragment in `mountGroupChildren`).
   */
  private bindRowEvents(el: HTMLElement) {
    // Group items — click = expand/collapse only
    if (el.matches(".nav-item.nav-sub[data-group-id]")) {
      el.addEventListener("click", () => {
        const groupId = el.dataset.groupId ?? "";
        const row = el.closest<HTMLElement>(".nav-group-row");
        if (!row) return;
        // All Hosts is a pseudo-root: it renders both ungrouped hosts and root
        // groups in `renderConnectionsItems`, so toggling it needs a full
        // re-render rather than the incremental `mountGroupChildren` path
        // (which only knows about real groups in `this.groups`).
        if (groupId === ALL_GROUP_ID) {
          const expanded = this.expandedGroups.has(groupId);
          if (expanded) {
            this.collapseGroup(groupId);
          } else {
            this.expandGroup(groupId);
          }
          this.render();
          return;
        }
        const expanded = this.expandedGroups.has(groupId);
        if (expanded) {
          this.collapseGroup(groupId);
          this.collapseGroupRows(row);
        } else {
          this.expandGroup(groupId);
          const rows = this.mountGroupChildren(groupId, row);
          rows.forEach((r) => {
            r.classList.add("nav-expanding");
            r.addEventListener("animationend", () => r.classList.remove("nav-expanding"), { once: true });
          });
        }
        this.setGroupToggle(row, !expanded);
      });
      return;
    }

    // Host items — click = select, double-click = connect
    if (el.matches(".nav-host-row")) {
      const id = el.dataset.hostId ?? "";
      el.addEventListener("click", () => {
        if (this.dragMoved) return;
        this.selectedHostId = id;
        this.cb.onSelectHost(id);
        this.render();
      });
      el.addEventListener("dblclick", () => {
        if (this.dragMoved) return;
        this.cb.onConnectHost(id);
      });
      // Detail tooltip (issue #14). Two independent triggers — hover and
      // focus — so the tooltip stays up while either holds (e.g. pointer
      // rests on the row while focus is elsewhere, or the row keeps focus
      // and the pointer moves away).
      el.addEventListener("pointerenter", () => {
        this.tipHoverRow = el;
        this.syncTooltip();
      });
      el.addEventListener("pointerleave", () => {
        if (this.tipHoverRow === el) this.tipHoverRow = null;
        this.syncTooltip();
      });
      el.addEventListener("focusin", () => {
        this.tipFocusRow = el;
        this.syncTooltip();
      });
      el.addEventListener("focusout", () => {
        if (this.tipFocusRow === el) this.tipFocusRow = null;
        this.syncTooltip();
      });
      return;
    }

    // Pointer-based drag sources (HTML5 DnD is unreliable in WebView2).
    // Skip the All Hosts pseudo-group — it has no real HostGroup record and
    // can't be moved or reparented.
    if (el.matches(".nav-group-row > .nav-item[data-group-id], .nav-host-row > .nav-item[data-host-id]")) {
      const gid = el.dataset.groupId;
      if (gid === ALL_GROUP_ID) return;
      el.addEventListener("pointerdown", (e) => this.onDragStart(e, el));
      return;
    }

    // Per-row hover actions: add host / add subgroup (inline)
    if (el.matches(".nav-row-btn")) {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        const action = el.dataset.action;
        const parent = el.dataset.parent ?? ALL_GROUP_ID;
        if (action === "add-host") {
          this.cb.onAddHostToGroup(parent);
        } else if (action === "add-subgroup") {
          this.creatingIn = parent;
          this.expandGroup(parent);
          this.render();
          this.focusCreateInput();
        }
      });
      return;
    }
  }

  // ─── Drag & drop (pointer-based; HTML5 DnD is unreliable in WebView2) ─

  private onDragStart(e: PointerEvent, el: HTMLElement) {
    if (e.button !== 0) return;
    e.preventDefault();
    // A drag gesture may be starting — clear the tooltip so it can't
    // linger over drop targets mid-drag (and the row clone below stays
    // free of a stale aria-describedby).
    this.hideTooltip();
    this.dragStart = { x: e.clientX, y: e.clientY, el };
    this.dragPayload = null;
    this.dragMoved = false;
    // Arm the drag after a short hold — only then does the ghost and
    // drop-target logic activate.
    this.dragHoldTimer = window.setTimeout(() => {
      this.dragHoldTimer = null;
      const start = this.dragStart;
      if (!start) return;
      const payload = this.payloadFromEl(start.el);
      if (!payload) return;
      this.dragPayload = payload;
      this.liftSource(start.el);
      this.createClone(start.el, e.clientX, e.clientY);
    }, 250);
    window.addEventListener("pointermove", this.onDragMove);
    window.addEventListener("pointerup", this.onDragUp);
  }

  private onDragMove = (e: PointerEvent) => {
    const start = this.dragStart;
    if (!start) return;
    if (!this.dragPayload) {
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (dx * dx + dy * dy < 25) return; // 5px threshold — still within "maybe a click"
      // Moved past the threshold — arm the drag now (cancel any pending
      // hold timer). Without this, a quick drag attempt that moves before
      // the 250ms hold fires leaves dragPayload null and the drag never
      // starts, so the user has to try again.
      if (this.dragHoldTimer !== null) {
        window.clearTimeout(this.dragHoldTimer);
        this.dragHoldTimer = null;
      }
      const payload = this.payloadFromEl(start.el);
      if (!payload) return;
      this.dragPayload = payload;
      this.liftSource(start.el);
      this.createClone(start.el, e.clientX, e.clientY);
    }
    this.dragMoved = true;
    this.moveClone(e.clientX, e.clientY);
    this.updateDropTarget(e.clientY);
  };

  private onDragUp = (e: PointerEvent) => {
    window.removeEventListener("pointermove", this.onDragMove);
    window.removeEventListener("pointerup", this.onDragUp);
    if (this.dragHoldTimer !== null) {
      window.clearTimeout(this.dragHoldTimer);
      this.dragHoldTimer = null;
    }
    const wasDragging = !!this.dragPayload;
    this.dragStart = null;
    this.unliftSource();
    this.removeClone();
    this.removeIndicator();
    this.clearDropMarks();
    if (wasDragging) {
      const target = this.dropTarget;
      this.dropTarget = null;
      if (target) void this.handleDrop(target.groupId, target.pos);
    }
    this.dragPayload = null;
    // keep dragMoved true briefly so the synthetic click from this
    // pointer gesture doesn't also select/connect the row
    setTimeout(() => {
      this.dragMoved = false;
    }, 50);
  };

  private payloadFromEl(el: HTMLElement): DragPayload | null {
    const gid = el.dataset.groupId;
    if (gid) {
      // NetBox groups are synthetic — not user-movable.
      if (isNetboxGroup(gid) || gid === ALL_GROUP_ID) return null;
      return { kind: "group", id: gid };
    }
    const hid = el.dataset.hostId;
    if (hid) {
      // NetBox hosts live where the sync put them.
      if (isNetboxHostId(hid)) return null;
      return { kind: "host", id: hid };
    }
    return null;
  }

  private liftSource(el: HTMLElement) {
    const row = el.closest<HTMLElement>(".nav-group-row, .nav-host-row");
    if (row) row.classList.add("nav-drag-lift");
  }

  private unliftSource() {
    this.container.querySelectorAll<HTMLElement>(".nav-drag-lift").forEach((el) => {
      el.classList.remove("nav-drag-lift");
    });
  }

  private createClone(src: HTMLElement, x: number, y: number) {
    const row = src.closest<HTMLElement>(".nav-group-row, .nav-host-row");
    if (!row) return;
    const item = row.querySelector<HTMLElement>(".nav-item");
    if (!item) return;
    // Clone just the visible item (not the hover action buttons) so the
    // drag image looks exactly like the row at rest.
    const c = item.cloneNode(true) as HTMLElement;
    c.classList.add("nav-drag-clone");
    const r = item.getBoundingClientRect();
    c.style.width = `${r.width}px`;
    c.style.height = `${r.height}px`;
    c.style.left = `${r.left}px`;
    c.style.top = `${r.top}px`;
    this.dragCloneOff = { x: x - r.left, y: y - r.top };
    document.body.appendChild(c);
    this.dragClone = c;
  }

  private moveClone(x: number, y: number) {
    if (this.dragClone) {
      this.dragClone.style.left = `${x - this.dragCloneOff.x}px`;
      this.dragClone.style.top = `${y - this.dragCloneOff.y}px`;
    }
  }

  private removeClone() {
    this.dragClone?.remove();
    this.dragClone = null;
  }

  private dropTarget: { groupId: string; pos: "above" | "below" } | null = null;

  private updateDropTarget(clientY: number) {
    this.clearDropMarks();
    this.removeIndicator();
    this.dropTarget = null;
    if (!this.dragPayload) return;
    const p = this.dragPayload;
    const rootZone = this.container.querySelector<HTMLElement>("[data-drop-root]");
    const rows = Array.from(this.container.querySelectorAll<HTMLElement>(".nav-group-row"));
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      if (clientY < rect.top || clientY > rect.bottom) continue;
      const groupId = row.dataset.groupId ?? "";
      // NetBox groups are not drop targets — user content can't move in,
      // and NetBox entries can't be dragged out (payloadFromEl filters).
      if (isNetboxGroup(groupId)) {
        this.markDropTarget(row, false);
        continue;
      }
      if (p.kind === "group") {
        if (groupId === p.id || this.isDescendant(groupId, p.id)) {
          this.markDropTarget(row, false);
          continue;
        }
        const pos: "above" | "below" = clientY < rect.top + rect.height / 2 ? "above" : "below";
        this.showIndicator(row, pos);
        this.markDropTarget(row, true);
        this.dropTarget = { groupId, pos };
      } else {
        // Host drop. All Hosts is a valid target (sets group_id = null);
        // any real group sets group_id to that group. Both go through
        // moveHost which maps ALL_GROUP_ID → null.
        this.markDropTarget(row, true);
        this.dropTarget = { groupId, pos: "below" };
      }
      return;
    }
    // no row hit — root zone still handles group reordering to root level
    if (p.kind === "group" && rootZone) {
      const rrect = rootZone.getBoundingClientRect();
      if (clientY >= rrect.top && clientY <= rrect.bottom) {
        this.showIndicator(rootZone, "below");
        this.markDropTarget(rootZone, true);
        this.dropTarget = { groupId: ALL_GROUP_ID, pos: "below" };
      }
    }
  }

  private isDescendant(candidateId: string, ancestorId: string): boolean {
    let cur = this.groups.find((g) => g.id === candidateId);
    while (cur) {
      if (cur.id === ancestorId) return true;
      cur = cur.parent_id ? this.groups.find((g) => g.id === cur!.parent_id) : undefined;
    }
    return false;
  }

  private markDropTarget(el: HTMLElement, valid: boolean) {
    el.classList.remove("nav-drop-ok", "nav-drop-bad");
    if (valid) el.classList.add("nav-drop-ok");
    else el.classList.add("nav-drop-bad");
  }

  private clearDropMarks() {
    this.container.querySelectorAll<HTMLElement>(".nav-drop-ok, .nav-drop-bad").forEach((el) => {
      el.classList.remove("nav-drop-ok", "nav-drop-bad");
    });
  }

  private removeIndicator() {
    this.dropIndicator?.remove();
    this.dropIndicator = null;
  }

  private showIndicator(row: HTMLElement, pos: "above" | "below") {
    this.removeIndicator();
    const line = document.createElement("div");
    line.className = "nav-drop-line";
    line.style.display = "block";
    if (pos === "above") row.before(line);
    else row.after(line);
    this.dropIndicator = line;
  }

  /** Sibling ids of group `groupId` (null = root level) in display order, excluding `excludeId`. */
  private siblingsExcept(groupId: string | null, excludeId: string): string[] {
    return this.groups
      .filter((g) => g.parent_id === groupId && g.id !== excludeId)
      .map((g) => g.id);
  }

  private async handleDrop(groupId: string, pos: "above" | "below") {
    if (!this.dragPayload) return;
    const p = this.dragPayload;
    this.dragPayload = null;
    if (p.kind === "host") {
      await this.moveHost(p.id, groupId);
      return;
    }
    const dragged = p.id;
    const targetParent = groupId === ALL_GROUP_ID ? null : groupId;
    const cur = this.groups.find((g) => g.id === dragged);
    if (!cur) return;
    let siblings = this.siblingsExcept(targetParent, dragged);
    let order = siblings.length;
    if (groupId !== ALL_GROUP_ID) {
      const idx = siblings.indexOf(groupId);
      if (idx >= 0) order = pos === "above" ? idx : idx + 1;
    }
    siblings.splice(order, 0, dragged);
    const curSiblings = this.siblingsExcept(cur.parent_id, dragged);
    if (cur.parent_id === targetParent && curSiblings.join(",") === siblings.join(",")) {
      return; // no-op: same parent, same position
    }
    if (targetParent) this.expandGroup(targetParent);
    try {
      await moveHostGroup(dragged, targetParent, order);
      await this.refresh();
      this.cb.onTreeChanged();
    } catch (err) {
      log.error(LogTag.NavPanel, `Failed to move group: ${err}`);
    }
  }

  private async moveHost(hostId: string, groupId: string) {
    if (isNetboxHostId(hostId) || isNetboxGroup(groupId)) {
      log.warn(LogTag.Netbox, `Guard: group-move blocked on NetBox host ${hostId}`);
      showToast("NetBox hosts are managed by the NetBox integration — use Configure", "info");
      return;
    }
    const host = this.hosts.find((h) => h.id === hostId);
    if (!host) return;
    const newGroup = groupId === ALL_GROUP_ID ? null : groupId;
    if (host.group_id === newGroup) return;
    try {
      await saveHost({ ...host, group_id: newGroup });
      this.expandGroup(newGroup ?? ALL_GROUP_ID);
      await this.refresh();
      this.cb.onTreeChanged();
    } catch (err) {
      log.error(LogTag.NavPanel, `Failed to move host: ${err}`);
    }
  }

  // ─── Keyboard: roving tabindex, arrows/Enter/Left/Right ──────────

  /** All focusable nav elements in visual order: headers + visible items of open section. */
  private focusables(): HTMLElement[] {
    const out: HTMLElement[] = [];
    const root = this.container.querySelector<HTMLElement>(".nav-panel");
    if (!root) return out;
    for (const section of Array.from(root.children) as HTMLElement[]) {
      const header = section.querySelector<HTMLElement>(".nav-section-header");
      if (header) out.push(header);
      const body = section.querySelector<HTMLElement>(".nav-section-items");
      if (body?.classList.contains("open")) {
        for (const item of Array.from(body.querySelectorAll<HTMLElement>(".nav-item"))) {
          if (!item.classList.contains("nav-disabled")) out.push(item);
        }
      }
    }
    return out;
  }

  private applyRovingTabindex() {
    const els = this.focusables();
    if (els.length === 0) return;
    const ae = document.activeElement;
    const start = ae instanceof HTMLElement && els.includes(ae) ? els.indexOf(ae) : 0;
    els.forEach((el, i) => {
      el.tabIndex = i === start ? 0 : -1;
    });
  }

  private focusEl(el: HTMLElement) {
    this.container.querySelectorAll<HTMLElement>(".nav-section-header, .nav-item").forEach((i) => (i.tabIndex = -1));
    el.tabIndex = 0;
    el.focus();
  }

  private moveFocus(delta: number) {
    const els = this.focusables();
    if (els.length === 0) return;
    const current = els.indexOf(document.activeElement as HTMLElement);
    const next = current < 0 ? 0 : Math.max(0, Math.min(els.length - 1, current + delta));
    this.focusEl(els[next]);
  }

  private activateFocused() {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return;
    if (el.classList.contains("nav-section-header")) {
      el.click();
      return;
    }
    if (el.classList.contains("nav-item")) {
      const hostId = el.dataset.hostId;
      if (hostId) {
        // Enter on a host row = connect
        this.cb.onConnectHost(hostId);
        return;
      }
      const groupId = el.dataset.groupId;
      if (groupId) {
        // Enter on a group row = expand/collapse
        el.click();
      }
    }
  }

  private bindKeys() {
    if (this.keyHandler) {
      this.container.removeEventListener("keydown", this.keyHandler);
    }
    this.keyHandler = (e: KeyboardEvent) => {
      const focusInPanel = this.container.contains(document.activeElement);
      if (!focusInPanel) return;
      // Typing in the inline rename input must not trigger tree navigation
      if (this.renaming && (document.activeElement as HTMLElement | null)?.classList.contains("nav-rename-input")) return;
      // Context menu takes priority over navigation keys
      if (this.contextMenu) {
        if (e.key === "Escape") {
          e.preventDefault();
          this.contextMenu = null;
          this.render();
        }
        return;
      }
      // Escape dismisses a visible host tooltip without moving focus
      // (WCAG 1.4.13); the next press falls through to global handling.
      if (e.key === "Escape" && this.tooltip.visible) {
        e.preventDefault();
        e.stopPropagation();
        this.hideTooltip();
        return;
      }
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          this.moveFocus(1);
          break;
        case "ArrowUp":
          e.preventDefault();
          this.moveFocus(-1);
          break;
        case "Enter":
          e.preventDefault();
          this.activateFocused();
          break;
        case "ArrowRight": {
          e.preventDefault();
          const ae = document.activeElement as HTMLElement | null;
          if (ae?.classList.contains("nav-section-header")) {
            // Closed section: expand it, then enter it
            const section = ae.dataset.section as NavSection;
            const items = ae.parentElement?.querySelector<HTMLElement>(".nav-section-items");
            if (!items?.classList.contains("open")) {
              this.setSectionOpen(section, true);
            }
            const first = this.container.querySelector<HTMLElement>(
              `.nav-section[data-section="${section}"] .nav-item:not(.nav-disabled)`,
            );
            if (first) this.focusEl(first);
          } else if (ae?.classList.contains("nav-item")) {
            // Closed group with children: expand it
            const groupId = ae.dataset.groupId;
            if (groupId && !this.expandedGroups.has(groupId)) {
              const hasKids =
                groupId === ALL_GROUP_ID
                  ? this.allHostsHasChildren()
                  : this.groups.some((g) => g.parent_id === groupId) ||
                    this.hosts.some((h) => h.group_id === groupId);
              if (hasKids) {
                (ae as HTMLElement).click();
              }
            }
          }
          break;
        }
        case "ArrowLeft": {
          e.preventDefault();
          const ae = document.activeElement as HTMLElement | null;
          if (ae?.classList.contains("nav-section-header")) {
            // Move to previous header (no wrap)
            const headers = Array.from(this.container.querySelectorAll<HTMLElement>(".nav-section-header"));
            const idx = headers.findIndex((h) => h === ae);
            const prev = headers[Math.max(0, idx - 1)];
            if (prev) this.focusEl(prev);
          } else {
            // From an item: collapse its section, focus its header
            const section = ae?.closest<HTMLElement>(".nav-section")?.dataset.section as NavSection | undefined;
            if (section) {
              this.setSectionOpen(section, false);
              const header = this.container.querySelector<HTMLElement>(
                `.nav-section[data-section="${section}"] .nav-section-header`,
              );
              if (header) this.focusEl(header);
            }
          }
          break;
        }
      }
    };
    this.container.addEventListener("keydown", this.keyHandler);
  }
}
