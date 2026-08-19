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
  getHosts,
  getHostGroups,
  moveHostGroup,
  saveHost,
  saveHostGroup,
} from "../lib/tauri-api";
import { ALL_GROUP_ID, UNGROUPED_ID, hostMatches, sortByRecent } from "../lib/host-filters";
import { escHtml } from "../lib/format";
import { log } from "../lib/logger";
import { icons } from "../lib/icons";

export type NavSection = "connections" | "kb" | "settings";

export interface NavCallbacks {
  onSelectHost: (hostId: string) => void;
  onConnectHost: (hostId: string) => void;
  onKbTab: (tab: "browse" | "import") => void;
  onNewConnection: () => void;
  onAddHostToGroup: (groupId: string) => void;
  onSelectSettings: (id: string) => void;
  onTreeChanged: () => void;
}

const SETTINGS_ITEMS = [
  { id: "general", label: "General", ready: true },
  { id: "theme", label: "Theme", ready: true },
  { id: "ollama", label: "Ollama / KB Import", ready: true },
  { id: "shortcuts", label: "Shortcuts", ready: false },
];

type DragPayload = { kind: "host" | "group"; id: string };

export class NavPanel {
  private container: HTMLElement;
  private cb: NavCallbacks;
  private openSections = new Set<NavSection>(["connections"]);
  private expandedGroups = new Set<string>([ALL_GROUP_ID]);
  private groups: { id: string; name: string; icon: string | null; parent_id: string | null; sort_order: number }[] = [];
  private hosts: Host[] = [];
  private selectedHostId: string | null = null;
  private searchQuery = "";
  private activeKbTab: "browse" | "import" = "browse";
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;
  private creatingIn: string | null = null;
  private dragPayload: DragPayload | null = null;
  private dropIndicator: HTMLElement | null = null;
  private dragStart: { x: number; y: number; el: HTMLElement } | null = null;
  private dragClone: HTMLElement | null = null;
  private dragCloneOff: { x: number; y: number } = { x: 0, y: 0 };
  private dragMoved = false;
  private dragHoldTimer: number | null = null;

  constructor(container: HTMLElement, callbacks: NavCallbacks) {
    this.container = container;
    this.cb = callbacks;
  }

  async mount() {
    await this.loadData();
    this.render();
    this.bindKeys();
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
    const chevron = header?.querySelector<HTMLElement>(".nav-chevron");
    if (chevron) chevron.textContent = open ? "▾" : "▸";
    this.applyRovingTabindex();
  }

  /** Update the highlighted host (driven by HostScreen). */
  setSelectedHost(hostId: string | null) {
    if (this.selectedHostId === hostId) return;
    this.selectedHostId = hostId;
    this.container.querySelectorAll<HTMLElement>(".nav-host-row[data-host-id]").forEach((el) => {
      el.classList.toggle("nav-selected", el.dataset.hostId === hostId);
    });
  }

  /** Update the highlighted KB tab (driven by KbScreen). */
  setActiveKbTab(tab: "browse" | "import") {
    if (this.activeKbTab === tab) return;
    this.activeKbTab = tab;
    this.container.querySelectorAll<HTMLElement>(".nav-item[data-kb-tab]").forEach((el) => {
      el.classList.toggle("nav-selected", el.dataset.kbTab === tab);
    });
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
      this.groups = gs.map((g) => ({ id: g.id, name: g.name, icon: g.icon, parent_id: g.parent_id, sort_order: g.sort_order }));
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
    // Preserve focused element across the innerHTML rebuild
    const ae = document.activeElement;
    const prevFocus = ae instanceof HTMLElement && this.container.contains(ae)
      ? this.focusables().indexOf(ae)
      : -1;
    // Preserve caret position in the search input (rendered on every keystroke)
    const search = this.container.querySelector<HTMLInputElement>("#nav-host-search");
    const prevSearchSel = search && search === ae ? search.selectionStart : null;
    this.container.innerHTML = `
      <div class="nav-panel">
        ${this.renderSection("connections", "Connections", this.renderConnectionsItems())}
        ${this.renderSection("kb", "Knowledge Base", this.renderKbItems())}
        ${this.renderSection("settings", "Settings", this.renderSettingsItems())}
      </div>
    `;
    this.bindEvents();
    this.applyRovingTabindex();
    if (prevFocus >= 0) {
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

  private renderSection(section: NavSection, label: string, itemsHtml: string): string {
    const open = this.openSections.has(section);
    return `
      <div class="nav-section" data-section="${section}">
        <button class="nav-section-header" data-section="${section}" aria-expanded="${open}">
          <span class="nav-chevron">${open ? "▾" : "▸"}</span>
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
        <input type="text" class="nav-search-input" id="nav-host-search" placeholder="Search hosts…" value="${escHtml(this.searchQuery)}" />
      </div>
      <div class="nav-group-row nav-root-zone${this.searchQuery ? " hidden" : ""}" data-drop-root>
        <button class="nav-item nav-sub">
          <span class="nav-toggle"></span>
          <span class="nav-sub-icon">${icons.folder}</span>
          <span class="nav-item-label">All Hosts</span>
        </button>
      </div>
    `;
    if (this.creatingIn === ALL_GROUP_ID) {
      html += this.renderCreateRow(0);
    }
    const keep = this.visibleGroupIds();
    const roots = this.groups.filter((g) => !g.parent_id);
    for (const g of roots) {
      if (keep && !keep.has(g.id)) continue;
      html += this.renderGroupNode(g, 0);
    }
    // Pseudo "Ungrouped" node for hosts with group_id === null
    const ungrouped = sortByRecent(this.hosts.filter((h) => !h.group_id && this.hostVisible(h)));
    if (ungrouped.length > 0 || keep === null) {
      const expanded = this.expandedGroups.has(UNGROUPED_ID) || keep !== null;
      html += `
        <div class="nav-group-row" data-group-id="${UNGROUPED_ID}">
          <button class="nav-item nav-sub" data-group-id="${UNGROUPED_ID}">
            <span class="nav-toggle">${ungrouped.length > 0 ? (expanded ? "▾" : "▸") : ""}</span>
            <span class="nav-sub-icon">${icons.folder}</span>
            <span class="nav-item-label">Ungrouped</span>
          </button>
        </div>
      `;
      if (expanded) {
        for (const h of ungrouped) {
          html += this.renderHostRow(h, 1);
        }
      }
    }
    return html;
  }

  private renderGroupNode(group: { id: string; name: string; icon: string | null; parent_id: string | null }, depth: number): string {
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

    let html = `
      <div class="nav-group-row" data-group-id="${group.id}">
        <button class="nav-item nav-sub" data-group-id="${group.id}" draggable="true" style="padding-left:${indent}px">
          <span class="nav-toggle">${hasChildren ? (expanded ? "▾" : "▸") : ""}</span>
          <span class="nav-sub-icon">${group.icon ? escHtml(group.icon) : icons.folder}</span>
          <span class="nav-item-label">${escHtml(group.name)}</span>
        </button>
        <span class="nav-row-actions">
          <button class="nav-row-btn" data-action="add-host" data-parent="${group.id}" title="Add host here" aria-label="Add host">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
          </button>
          <button class="nav-row-btn" data-action="add-subgroup" data-parent="${group.id}" title="New group here" aria-label="New group">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7a2 2 0 0 1 2-2h3.2a1 1 0 0 1 .7.3l1 1a1 1 0 0 0 .7.3H18a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7z"/><path d="M12 11v4M10 13h4"/></svg>
          </button>
        </span>
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
    const selected = this.selectedHostId === host.id;
    return `
      <div class="nav-host-row ${selected ? "nav-selected" : ""}" data-host-id="${host.id}">
        <button class="nav-item nav-sub" data-host-id="${host.id}" draggable="true" style="padding-left:${indent}px">
          <span class="nav-toggle"></span>
          <span class="nav-sub-icon nav-host-dot"></span>
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

  /** Animate-collapse the group's child rows, then re-render. */
  private collapseGroupRows(row: HTMLElement) {
    const rows = this.groupChildRows(row);
    if (rows.length === 0) {
      this.render();
      return;
    }
    rows.forEach((r) => r.classList.add("nav-collapsing"));
    const done = () => {
      rows.forEach((r) => r.classList.remove("nav-collapsing"));
      this.render();
    };
    rows[0].addEventListener("transitionend", (e) => {
      if (e.propertyName === "margin-bottom") done();
    });
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
    row.after(frag);
    this.bindEvents();
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
      this.expandedGroups.add(created.id);
      await this.refresh();
      this.cb.onTreeChanged();
    } catch (err) {
      log.error("nav-panel", `Failed to create group: ${err}`);
    }
  }

  private renderKbItems(): string {
    return `
      <div class="nav-group-row">
        <button class="nav-item nav-sub ${this.activeKbTab === "browse" ? "nav-selected" : ""}" data-kb-tab="browse">
          <span class="nav-item-label">Browse KB</span>
        </button>
      </div>
      <div class="nav-group-row">
        <button class="nav-item nav-sub ${this.activeKbTab === "import" ? "nav-selected" : ""}" data-kb-tab="import">
          <span class="nav-item-label">Import KB</span>
        </button>
      </div>
    `;
  }

  private renderSettingsItems(): string {
    return SETTINGS_ITEMS.map(
      (s) => `
        <button class="nav-item nav-sub${s.ready ? "" : " nav-disabled"}" data-settings-id="${s.id}">
          <span class="nav-item-label">${s.label}</span>
          ${s.ready ? "" : '<span class="nav-soon">soon</span>'}
        </button>
      `,
    ).join("");
  }

  // ─── Events ──────────────────────────────────────────────────────

  private bindEvents() {
    // Section headers — toggle in place (no re-render) so the collapse/expand animates
    this.container.querySelectorAll<HTMLElement>(".nav-section-header").forEach((el) => {
      el.addEventListener("click", () => {
        const section = el.dataset.section as NavSection;
        const items = el.parentElement?.querySelector<HTMLElement>(".nav-section-items");
        this.setSectionOpen(section, !items?.classList.contains("open"));
      });
    });

    // Group items — click = expand/collapse only
    this.container.querySelectorAll<HTMLElement>(".nav-item.nav-sub[data-group-id]").forEach((el) => {
      el.addEventListener("click", () => {
        const groupId = el.dataset.groupId ?? "";
        const row = el.closest<HTMLElement>(".nav-group-row");
        if (!row) return;
        const expanded = this.expandedGroups.has(groupId);
        if (expanded) {
          this.expandedGroups.delete(groupId);
          this.collapseGroupRows(row);
        } else {
          this.expandedGroups.add(groupId);
          const rows = this.mountGroupChildren(groupId, row);
          rows.forEach((r) => {
            r.classList.add("nav-expanding");
            r.addEventListener("animationend", () => r.classList.remove("nav-expanding"), { once: true });
          });
        }
        this.setGroupToggle(row, !expanded);
      });
    });

    // Host items — click = select, double-click = connect
    this.container.querySelectorAll<HTMLElement>(".nav-host-row").forEach((el) => {
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
    });

    // Pointer-based drag sources (HTML5 DnD is unreliable in WebView2).
    this.container.querySelectorAll<HTMLElement>(".nav-group-row > .nav-item[data-group-id], .nav-host-row > .nav-item[data-host-id]").forEach((el) => {
      el.addEventListener("pointerdown", (e) => this.onDragStart(e, el));
    });

    // Per-row hover actions: add host / add subgroup (inline)
    this.container.querySelectorAll<HTMLElement>(".nav-row-btn").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        const action = el.dataset.action;
        const parent = el.dataset.parent ?? ALL_GROUP_ID;
        if (action === "add-host") {
          this.cb.onAddHostToGroup(parent);
        } else if (action === "add-subgroup") {
          this.creatingIn = parent;
          this.expandedGroups.add(parent);
          this.render();
          this.focusCreateInput();
        }
      });
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

    // KB tab items (Browse KB / Import KB)
    this.container.querySelectorAll<HTMLElement>(".nav-item[data-kb-tab]").forEach((el) => {
      el.addEventListener("click", () => {
        const tab = el.dataset.kbTab as "browse" | "import";
        if (!tab) return;
        this.activeKbTab = tab;
        this.cb.onKbTab(tab);
        this.render();
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

    // Settings placeholders — fire callback, no state change
    this.container.querySelectorAll<HTMLElement>(".nav-item[data-settings-id]").forEach((el) => {
      el.addEventListener("click", () => {
        this.cb.onSelectSettings(el.dataset.settingsId ?? "");
      });
    });
  }

  // ─── Drag & drop (pointer-based; HTML5 DnD is unreliable in WebView2) ─

  private onDragStart(e: PointerEvent, el: HTMLElement) {
    if (e.button !== 0) return;
    e.preventDefault();
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
      if (dx * dx + dy * dy < 25) return; // 5px threshold — cancels pending hold
      if (this.dragHoldTimer !== null) {
        window.clearTimeout(this.dragHoldTimer);
        this.dragHoldTimer = null;
      }
      return;
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
    if (gid) return { kind: "group", id: gid };
    const hid = el.dataset.hostId;
    if (hid) return { kind: "host", id: hid };
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
        this.markDropTarget(row, true);
        this.dropTarget = { groupId, pos: "below" };
      }
      return;
    }
    // no row hit — check root zone (only for group reordering to root)
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
    if (targetParent) this.expandedGroups.add(targetParent);
    try {
      await moveHostGroup(dragged, targetParent, order);
      await this.refresh();
      this.cb.onTreeChanged();
    } catch (err) {
      log.error("nav-panel", `Failed to move group: ${err}`);
    }
  }

  private async moveHost(hostId: string, groupId: string) {
    const host = this.hosts.find((h) => h.id === hostId);
    if (!host) return;
    const newGroup = groupId === ALL_GROUP_ID ? null : groupId;
    if (host.group_id === newGroup) return;
    try {
      await saveHost({ ...host, group_id: newGroup });
      this.expandedGroups.add(newGroup ?? UNGROUPED_ID);
      await this.refresh();
      this.cb.onTreeChanged();
    } catch (err) {
      log.error("nav-panel", `Failed to move host: ${err}`);
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
                this.groups.some((g) => g.parent_id === groupId) ||
                this.hosts.some((h) => h.group_id === groupId) ||
                (groupId === UNGROUPED_ID && this.hosts.some((h) => !h.group_id));
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
