/**
 * Nav Panel — persistent left navigation (replaces the app tab bar).
 *
 * Three accordion sections: Connections, Knowledge Base, Settings.
 * One section expanded at a time; expanding switches the content view.
 * Connections section: group tree with hosts nested under their group,
 * in-place search filtering, and drag & drop for moving hosts/groups.
 * Roving tabindex + arrow/Enter/Left/Right keyboard navigation.
 */

import {
  Host,
  getHosts,
  getHostGroups,
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
  { id: "general", label: "General", ready: false },
  { id: "ollama", label: "Ollama / KB Import", ready: true },
  { id: "shortcuts", label: "Shortcuts", ready: false },
];

type DragPayload = { kind: "host" | "group"; id: string };

export class NavPanel {
  private container: HTMLElement;
  private cb: NavCallbacks;
  private activeSection: NavSection | null = "connections";
  private expandedGroups = new Set<string>([ALL_GROUP_ID]);
  private groups: { id: string; name: string; icon: string | null; parent_id: string | null; sort_order: number }[] = [];
  private hosts: Host[] = [];
  private selectedHostId: string | null = null;
  private searchQuery = "";
  private activeKbTab: "browse" | "import" = "browse";
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;
  private creatingIn: string | null = null;
  private dragPayload: DragPayload | null = null;

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

  /** Expand a section and collapse the others (accordion). No view switch. */
  setSection(section: NavSection) {
    if (this.activeSection === section) return;
    this.activeSection = section;
    this.render();
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

  /** Focus the search box (global "/" shortcut). */
  focusSearch() {
    const input = this.container.querySelector<HTMLInputElement>("#nav-host-search");
    if (input) {
      input.focus();
      input.select();
    }
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
    const open = this.activeSection === section;
    return `
      <div class="nav-section" data-section="${section}">
        <button class="nav-section-header" data-section="${section}" aria-expanded="${open}">
          <span class="nav-chevron">${open ? "▾" : "▸"}</span>
          <span class="nav-section-label">${label}</span>
        </button>
        <div class="nav-section-items${open ? "" : " hidden"}">
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
        <input type="text" class="nav-search-input" id="nav-host-search" placeholder="Search hosts… ( / )" value="${escHtml(this.searchQuery)}" />
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
      <div class="nav-group-row" data-group-id="${group.id}" draggable="true">
        <button class="nav-item nav-sub" data-group-id="${group.id}" style="padding-left:${indent}px">
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
      <div class="nav-host-row ${selected ? "nav-selected" : ""}" data-host-id="${host.id}" draggable="true">
        <button class="nav-item nav-sub" data-host-id="${host.id}" style="padding-left:${indent}px">
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
      <button class="nav-item nav-sub ${this.activeKbTab === "browse" ? "nav-selected" : ""}" data-kb-tab="browse">
        <span class="nav-item-label">Browse KB</span>
      </button>
      <button class="nav-item nav-sub ${this.activeKbTab === "import" ? "nav-selected" : ""}" data-kb-tab="import">
        <span class="nav-item-label">Import KB</span>
      </button>
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
    // Section headers
    this.container.querySelectorAll<HTMLElement>(".nav-section-header").forEach((el) => {
      el.addEventListener("click", () => {
        const section = el.dataset.section as NavSection;
        if (this.activeSection === section) {
          // Clicking the open section toggles it closed
          this.activeSection = null;
        } else {
          this.activeSection = section;
        }
        this.render();
      });
    });

    // Group items — click = expand/collapse only
    this.container.querySelectorAll<HTMLElement>(".nav-item.nav-sub[data-group-id]").forEach((el) => {
      el.addEventListener("click", () => {
        const groupId = el.dataset.groupId ?? "";
        if (this.expandedGroups.has(groupId)) {
          this.expandedGroups.delete(groupId);
        } else {
          this.expandedGroups.add(groupId);
        }
        this.render();
      });
    });

    // Host items — click = select, double-click = connect
    this.container.querySelectorAll<HTMLElement>(".nav-host-row").forEach((el) => {
      const id = el.dataset.hostId ?? "";
      el.addEventListener("click", () => {
        this.selectedHostId = id;
        this.cb.onSelectHost(id);
        this.render();
      });
      el.addEventListener("dblclick", () => {
        this.cb.onConnectHost(id);
      });
      // Drag & drop
      el.addEventListener("dragstart", (e) => {
        this.dragPayload = { kind: "host", id };
        e.dataTransfer?.setData("text/plain", id);
        e.dataTransfer!.effectAllowed = "move";
      });
      el.addEventListener("dragend", () => {
        this.dragPayload = null;
        this.clearDropMarks();
      });
    });

    // Group rows — drag & drop (reparent / ungroup)
    this.container.querySelectorAll<HTMLElement>(".nav-group-row[draggable]").forEach((el) => {
      const groupId = el.dataset.groupId ?? "";
      el.addEventListener("dragstart", (e) => {
        this.dragPayload = { kind: "group", id: groupId };
        e.dataTransfer?.setData("text/plain", groupId);
        e.dataTransfer!.effectAllowed = "move";
      });
      el.addEventListener("dragend", () => {
        this.dragPayload = null;
        this.clearDropMarks();
      });
      // Drop target for host moves and group reparents
      el.addEventListener("dragover", (e) => {
        if (!this.dragPayload) return;
        e.preventDefault();
        e.dataTransfer!.dropEffect = "move";
        this.markDropTarget(el, this.validGroupDrop(groupId));
      });
      el.addEventListener("dragleave", () => this.markDropTarget(el, false));
      el.addEventListener("drop", (e) => {
        e.preventDefault();
        this.markDropTarget(el, false);
        this.handleDrop(groupId);
      });
    });

    // Root drop zone — ungroup a group
    const rootZone = this.container.querySelector<HTMLElement>("[data-drop-root]");
    if (rootZone) {
      rootZone.addEventListener("dragover", (e) => {
        if (!this.dragPayload || this.dragPayload.kind !== "group") return;
        e.preventDefault();
        e.dataTransfer!.dropEffect = "move";
        this.markDropTarget(rootZone, true);
      });
      rootZone.addEventListener("dragleave", () => this.markDropTarget(rootZone, false));
      rootZone.addEventListener("drop", (e) => {
        e.preventDefault();
        this.markDropTarget(rootZone, false);
        if (this.dragPayload?.kind === "group") {
          void this.moveGroup(this.dragPayload.id, null);
        }
      });
    }

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

  // ─── Drag & drop ─────────────────────────────────────────────────

  private isDescendant(candidateId: string, ancestorId: string): boolean {
    let cur = this.groups.find((g) => g.id === candidateId);
    while (cur) {
      if (cur.id === ancestorId) return true;
      cur = cur.parent_id ? this.groups.find((g) => g.id === cur!.parent_id) : undefined;
    }
    return false;
  }

  /** Can the current drag payload be dropped onto group `groupId`? */
  private validGroupDrop(groupId: string): boolean {
    const p = this.dragPayload;
    if (!p) return false;
    if (p.kind === "host") return true;
    // group reparent: not onto self, not onto own descendant
    return p.id !== groupId && !this.isDescendant(groupId, p.id);
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

  private async handleDrop(groupId: string) {
    const p = this.dragPayload;
    this.dragPayload = null;
    this.clearDropMarks();
    if (!p) return;
    if (p.kind === "host") {
      await this.moveHost(p.id, groupId);
    } else {
      await this.moveGroup(p.id, groupId === ALL_GROUP_ID ? null : groupId);
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

  private async moveGroup(groupId: string, newParent: string | null) {
    const group = this.groups.find((g) => g.id === groupId);
    if (!group) return;
    if (group.parent_id === newParent) return;
    try {
      await saveHostGroup(groupId, group.name, newParent, null, group.icon);
      await this.refresh();
      this.cb.onTreeChanged();
    } catch (err) {
      log.error("nav-panel", `Failed to move group: ${err}`);
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
      const items = section.querySelector<HTMLElement>(".nav-section-items");
      if (items && !items.classList.contains("hidden")) {
        for (const item of Array.from(items.querySelectorAll<HTMLElement>(".nav-item"))) {
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
        if (this.expandedGroups.has(groupId)) {
          this.expandedGroups.delete(groupId);
        } else {
          this.expandedGroups.add(groupId);
        }
        this.render();
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
            if (this.activeSection !== section) {
              this.activeSection = section;
              this.render();
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
                this.expandedGroups.add(groupId);
                this.render();
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
          } else if (this.activeSection) {
            // From an item: collapse section, focus its header
            const section = this.activeSection;
            this.activeSection = null;
            this.render();
            const header = this.container.querySelector<HTMLElement>(
              `.nav-section[data-section="${section}"] .nav-section-header`,
            );
            if (header) this.focusEl(header);
          }
          break;
        }
      }
    };
    this.container.addEventListener("keydown", this.keyHandler);
  }
}
