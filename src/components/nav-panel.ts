/**
 * Nav Panel — persistent left navigation (replaces the app tab bar).
 *
 * Three accordion sections: Connections, Knowledge Base, Settings.
 * One section expanded at a time; expanding switches the content view.
 * Roving tabindex + arrow/Enter/Left/Right keyboard navigation.
 */

import { getHostGroups, saveHostGroup } from "../lib/tauri-api";
import { ALL_GROUP_ID } from "../lib/host-filters";
import { escHtml } from "../lib/format";
import { log } from "../lib/logger";
import { icons } from "../lib/icons";

export type NavSection = "connections" | "kb" | "settings";

export interface NavCallbacks {
  onSelectGroup: (groupId: string) => void;
  onKbTab: (tab: "browse" | "import") => void;
  onNewConnection: () => void;
  onAddHostToGroup: (groupId: string) => void;
  onSelectSettings: (id: string) => void;
  onSearchInput: (query: string) => void;
  getSearchQuery: () => string;
}

const SETTINGS_ITEMS = [
  { id: "general", label: "General" },
  { id: "ollama", label: "Ollama / KB Import" },
  { id: "shortcuts", label: "Shortcuts" },
];

export class NavPanel {
  private container: HTMLElement;
  private cb: NavCallbacks;
  private activeSection: NavSection | null = "connections";
  private expandedGroups = new Set<string>([ALL_GROUP_ID]);
  private groups: { id: string; name: string; icon: string | null; parent_id: string | null; sort_order: number }[] = [];
  private selectedGroupId = ALL_GROUP_ID;
  private activeKbTab: "browse" | "import" = "browse";
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;
  private creatingIn: string | null = null;

  constructor(container: HTMLElement, callbacks: NavCallbacks) {
    this.container = container;
    this.cb = callbacks;
  }

  async mount() {
    await this.loadData();
    this.render();
    this.bindKeys();
  }

  /** Re-render (e.g., after groups change). */
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

  /** No section expanded (terminal view). */
  clearActiveSection() {
    if (this.activeSection === null) return;
    this.activeSection = null;
    this.render();
  }

  /** Update the highlighted group (driven by HostScreen). */
  setSelectedGroup(groupId: string) {
    if (this.selectedGroupId === groupId) return;
    this.selectedGroupId = groupId;
    this.container.querySelectorAll<HTMLElement>(".nav-group-row[data-group-id]").forEach((el) => {
      el.classList.toggle("nav-selected", el.dataset.groupId === groupId);
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

  private async loadData() {
    try {
      const gs = await getHostGroups();
      this.groups = gs.map((g) => ({ id: g.id, name: g.name, icon: g.icon, parent_id: g.parent_id, sort_order: g.sort_order }));
      this.groups.sort((a, b) => a.sort_order - b.sort_order);
      // Selected group deleted elsewhere → fall back to All Hosts
      if (this.selectedGroupId !== ALL_GROUP_ID && !this.groups.some((g) => g.id === this.selectedGroupId)) {
        this.selectedGroupId = ALL_GROUP_ID;
      }
    } catch {
      this.groups = [];
    }
  }

  private render() {
    // Preserve focused element across the innerHTML rebuild
    const ae = document.activeElement;
    const prevFocus = ae instanceof HTMLElement && this.container.contains(ae)
      ? this.focusables().indexOf(ae)
      : -1;
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
        <input type="text" class="nav-search-input" id="nav-host-search" placeholder="Search hosts… ( / )" value="${escHtml(this.cb.getSearchQuery())}" />
      </div>
      <div class="nav-group-row ${this.selectedGroupId === ALL_GROUP_ID ? "nav-selected" : ""}" data-group-id="${ALL_GROUP_ID}">
        <button class="nav-item nav-sub" data-group-id="${ALL_GROUP_ID}">
          <span class="nav-toggle"></span>
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
    if (this.creatingIn === ALL_GROUP_ID) {
      html += this.renderCreateRow(0);
    }
    const roots = this.groups.filter((g) => !g.parent_id);
    for (const g of roots) {
      html += this.renderGroupNode(g, 0);
    }
    return html;
  }

  private renderGroupNode(group: { id: string; name: string; icon: string | null; parent_id: string | null }, depth: number): string {
    const children = this.groups.filter((g) => g.parent_id === group.id);
    const hasChildren = children.length > 0;
    const expanded = this.expandedGroups.has(group.id);
    const selected = this.selectedGroupId === group.id;
    const indent = 12 + depth * 14;

    // Inline "new group" row appears directly under the group being created in
    const creatingHere = this.creatingIn === group.id;

    let html = `
      <div class="nav-group-row ${selected ? "nav-selected" : ""}" data-group-id="${group.id}">
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
    if (hasChildren && expanded) {
      for (const child of children) {
        html += this.renderGroupNode(child, depth + 1);
      }
    }
    return html;
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
      this.selectedGroupId = created.id;
      await this.refresh();
      this.cb.onSelectGroup(created.id);
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
        <div class="nav-item nav-disabled" data-settings-id="${s.id}">
          <span class="nav-item-label">${s.label}</span>
          <span class="nav-soon">soon</span>
        </div>
      `,
    ).join("");
  }

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

    // Group items (the label button inside each row)
    this.container.querySelectorAll<HTMLElement>(".nav-item.nav-sub[data-group-id]").forEach((el) => {
      el.addEventListener("click", () => {
        const groupId = el.dataset.groupId ?? ALL_GROUP_ID;
        const toggle = el.querySelector(".nav-toggle");
        if (toggle && toggle.textContent?.trim() === "▾") {
          this.expandedGroups.delete(groupId);
        } else if (toggle && toggle.textContent?.trim() === "▸") {
          this.expandedGroups.add(groupId);
        }
        this.selectedGroupId = groupId;
        this.cb.onSelectGroup(groupId);
        this.render();
      });
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

    // Search input (filters the host list in the content panel)
    const searchInput = this.container.querySelector<HTMLInputElement>("#nav-host-search");
    if (searchInput) {
      searchInput.addEventListener("input", () => {
        this.cb.onSearchInput(searchInput.value);
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
    if (el && (el.classList.contains("nav-item") || el.classList.contains("nav-section-header"))) {
      el.click();
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
            if (groupId && !this.expandedGroups.has(groupId) && this.groups.some((g) => g.parent_id === groupId)) {
              this.expandedGroups.add(groupId);
              this.render();
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
