/**
 * Nav Panel — persistent left navigation (replaces the app tab bar).
 *
 * Three accordion sections: Connections, Knowledge Base, Settings.
 * One section expanded at a time; expanding switches the content view.
 * Roving tabindex + arrow/Enter/Left/Right keyboard navigation.
 */

import { getHostGroups, listKbPlatforms } from "../lib/tauri-api";
import { ALL_GROUP_ID } from "../lib/host-filters";
import { PLATFORM_META, platformColorClass } from "../lib/platforms";
import { escHtml } from "../lib/format";

export type NavSection = "connections" | "kb" | "settings";

export interface NavCallbacks {
  onSelectGroup: (groupId: string) => void;
  onSelectPlatform: (platform: string) => void;
  onNewConnection: () => void;
  onAddGroup: () => void;
  onSelectSettings: (id: string) => void;
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
  private groups: { id: string; name: string; icon: string | null; parent_id: string | null }[] = [];
  private platforms: string[] = [];
  private selectedGroupId = ALL_GROUP_ID;
  private selectedPlatform = "";
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;

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

  /** Expand a section and collapse the others (accordion). */
  setSection(section: NavSection) {
    if (this.activeSection === section) return;
    this.activeSection = section;
    this.render();
  }

  /** No section expanded (terminal view). */
  clearActiveSection() {
    if (this.activeSection === null) return;
    this.activeSection = null as unknown as NavSection;
    this.render();
  }

  /** Update the highlighted group (driven by HostScreen). */
  setSelectedGroup(groupId: string) {
    if (this.selectedGroupId === groupId) return;
    this.selectedGroupId = groupId;
    this.container.querySelectorAll<HTMLElement>(".nav-item[data-group-id]").forEach((el) => {
      el.classList.toggle("nav-selected", el.dataset.groupId === groupId);
    });
  }

  /** Update the highlighted platform (driven by KbScreen). */
  setSelectedPlatform(platform: string) {
    if (this.selectedPlatform === platform) return;
    this.selectedPlatform = platform;
    this.container.querySelectorAll<HTMLElement>(".nav-item[data-platform]").forEach((el) => {
      el.classList.toggle("nav-selected", el.dataset.platform === platform);
    });
  }

  private async loadData() {
    try {
      const gs = await getHostGroups();
      this.groups = gs.map((g) => ({ id: g.id, name: g.name, icon: g.icon, parent_id: g.parent_id }));
      this.groups.sort((a, b) => a.id.localeCompare(b.id));
    } catch {
      this.groups = [];
    }
    try {
      this.platforms = await listKbPlatforms();
    } catch {
      this.platforms = [];
    }
  }

  private render() {
    this.container.innerHTML = `
      <div class="nav-panel">
        ${this.renderSection("connections", "Connections", this.renderConnectionsItems())}
        ${this.renderSection("kb", "Knowledge Base", this.renderKbItems())}
        ${this.renderSection("settings", "Settings", this.renderSettingsItems())}
      </div>
    `;
    this.bindEvents();
    this.applyRovingTabindex();
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
      <button class="nav-item nav-action" data-action="new-connection">
        <span class="nav-action-icon">+</span>
        <span class="nav-item-label">New Connection</span>
      </button>
      <button class="nav-item nav-action" data-action="add-group">
        <span class="nav-action-icon">⊞</span>
        <span class="nav-item-label">New Group</span>
      </button>
      <button class="nav-item nav-sub ${this.selectedGroupId === ALL_GROUP_ID ? "nav-selected" : ""}" data-group-id="${ALL_GROUP_ID}">
        <span class="nav-sub-icon">📁</span>
        <span class="nav-item-label">All Hosts</span>
      </button>
    `;
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

    let html = `
      <button class="nav-item nav-sub ${selected ? "nav-selected" : ""}" data-group-id="${group.id}" style="padding-left:${indent}px">
        <span class="nav-toggle">${hasChildren ? (expanded ? "▾" : "▸") : ""}</span>
        <span class="nav-sub-icon">${group.icon ?? "📁"}</span>
        <span class="nav-item-label">${escHtml(group.name)}</span>
      </button>
    `;
    if (hasChildren && expanded) {
      for (const child of children) {
        html += this.renderGroupNode(child, depth + 1);
      }
    }
    return html;
  }

  private renderKbItems(): string {
    if (this.platforms.length === 0) {
      return `<div class="nav-item nav-disabled"><span class="nav-item-label">No platforms</span></div>`;
    }
    return this.platforms
      .map((p) => {
        const meta = PLATFORM_META[p] ?? { badge: p.slice(0, 4).toUpperCase(), label: p };
        const selected = this.selectedPlatform === p;
        return `
          <button class="nav-item nav-sub ${selected ? "nav-selected" : ""}" data-platform="${p}">
            <span class="nav-badge ${platformColorClass(p)}">${meta.badge}</span>
            <span class="nav-item-label">${escHtml(meta.label)}</span>
          </button>
        `;
      })
      .join("");
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
          this.activeSection = null as unknown as NavSection;
        } else {
          this.activeSection = section;
        }
        this.render();
      });
    });

    // Group items
    this.container.querySelectorAll<HTMLElement>(".nav-item[data-group-id]").forEach((el) => {
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

    // Platform items
    this.container.querySelectorAll<HTMLElement>(".nav-item[data-platform]").forEach((el) => {
      el.addEventListener("click", () => {
        const platform = el.dataset.platform ?? "";
        if (!platform) return;
        this.selectedPlatform = platform;
        this.cb.onSelectPlatform(platform);
        this.render();
      });
    });

    // Action items
    this.container.querySelector<HTMLElement>('[data-action="new-connection"]')?.addEventListener("click", () => {
      this.cb.onNewConnection();
    });
    this.container.querySelector<HTMLElement>('[data-action="add-group"]')?.addEventListener("click", () => {
      this.cb.onAddGroup();
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
            // Move to first item of this section
            const section = ae.closest<HTMLElement>(".nav-section");
            const first = section?.querySelector<HTMLElement>(".nav-item:not(.nav-disabled)");
            if (first) this.focusEl(first);
          } else if (!this.activeSection) {
            // Collapsed state: expand section below the focused header
            const headers = Array.from(this.container.querySelectorAll<HTMLElement>(".nav-section-header"));
            const idx = headers.findIndex((h) => h === ae);
            const next = headers[(idx + 1) % headers.length];
            if (next) {
              this.activeSection = next.dataset.section as NavSection;
              this.render();
              const first = this.container.querySelector<HTMLElement>(".nav-item:not(.nav-disabled)");
              if (first) first.focus();
            }
          }
          break;
        }
        case "ArrowLeft": {
          e.preventDefault();
          const ae = document.activeElement as HTMLElement | null;
          if (ae?.classList.contains("nav-section-header")) {
            // Collapse current section, focus header above
            if (this.activeSection) {
              this.activeSection = null as unknown as NavSection;
              this.render();
            }
            const headers = Array.from(this.container.querySelectorAll<HTMLElement>(".nav-section-header"));
            const idx = headers.findIndex((h) => h === ae);
            const prev = headers[(idx - 1 + headers.length) % headers.length];
            if (prev) this.focusEl(prev);
          } else if (this.activeSection) {
            // From an item: collapse section, focus its header
            this.activeSection = null as unknown as NavSection;
            this.render();
            const header = this.container.querySelector<HTMLElement>(".nav-section-header");
            if (header) header.focus();
          }
          break;
        }
      }
    };
    this.container.addEventListener("keydown", this.keyHandler);
  }
}
