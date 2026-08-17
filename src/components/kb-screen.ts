/**
 * KB Screen — full Knowledge Base management view.
 *
 * Left sidebar: platform list (navigated via arrow keys).
 * Right panel: tabbed content (Browse KB / Import KB).
 *
 * The KbViewerDialog and KbImportDialog are embedded directly
 * into the tab panels (embedMode=true). No modal overlays.
 */

import { KbViewerDialog } from "./kb-viewer-dialog";
import { KbImportDialog } from "./kb-import-dialog";
import { listKbPlatforms } from "../lib/tauri-api";
import { PLATFORM_META, platformBadge, platformColorClass } from "../lib/platforms";

// ─── Main Class ────────────────────────────────────────────────────

export class KbScreen {
  private onBackToConnections: () => void;
  private container: HTMLElement | null = null;
  private platforms: string[] = [];
  private selectedPlatform: string = "";
  private activeTab: "browse" | "import" = "browse";
  private viewerDialog: KbViewerDialog | null = null;
  private importDialog: KbImportDialog | null = null;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor(onBackToConnections: () => void) {
    this.onBackToConnections = onBackToConnections;
  }

  // ─── Mount / Unmount ─────────────────────────────────────────────

  async mount(container: HTMLElement) {
    this.container = container;
    await this.loadPlatforms();
    this.render();
    this.bindKeys();
    this.switchTab("browse"); // Activate browse tab by default
  }

  unmount() {
    if (this.keyHandler) {
      document.removeEventListener("keydown", this.keyHandler);
      this.keyHandler = null;
    }
    if (this.importDialog) {
      this.importDialog.unmount();
      this.importDialog = null;
    }
    // KbViewerDialog doesn't have unmount — clear panel instead
    if (this.viewerDialog) {
      this.viewerDialog = null;
    }
    this.container = null;
  }

  // ─── Data Loading ────────────────────────────────────────────────

  private async loadPlatforms() {
    try {
      this.platforms = await listKbPlatforms();
      if (this.platforms.length > 0) {
        this.selectedPlatform = this.platforms[0];
      }
    } catch (err) {
      console.error("Failed to load KB platforms:", err);
    }
  }

  // ─── Render ──────────────────────────────────────────────────────

  private render() {
    if (!this.container) return;

    const platformItems = this.platforms.map((p) => {
      const meta = PLATFORM_META[p] ?? { badge: p.slice(0, 4).toUpperCase(), label: p };
      const selectedClass = p === this.selectedPlatform ? " kb-sidebar-selected" : "";
      return `<div class="kb-sidebar-item${selectedClass}" data-platform="${p}">
        <span class="badge ${platformColorClass(p)}">${meta.badge}</span>
        <span>${meta.label}</span>
      </div>`;
    }).join("");

    this.container.innerHTML = `
      <div class="kb-screen">
        <div class="kb-sidebar">
          <div class="kb-sidebar-title">Platforms</div>
          <div class="kb-sidebar-list" id="kb-sidebar-list">
            ${platformItems || '<div class="kb-sidebar-empty">No platforms loaded</div>'}
          </div>
        </div>
        <div class="kb-content">
          <div class="kb-content-tabs">
            <div class="kb-content-tab${this.activeTab === "browse" ? " active" : ""}" data-tab="browse">Browse KB</div>
            <div class="kb-content-tab${this.activeTab === "import" ? " active" : ""}" data-tab="import">Import KB</div>
          </div>
          <div class="kb-content-panel${this.activeTab !== "browse" ? " hidden" : ""}" id="kb-browse-panel"></div>
          <div class="kb-content-panel${this.activeTab !== "import" ? " hidden" : ""}" id="kb-import-panel"></div>
        </div>
      </div>
    `;

    this.bindEvents();
  }

  // ─── Event Binding ───────────────────────────────────────────────

  private bindEvents() {
    if (!this.container) return;

    // Platform sidebar clicks
    this.container.querySelectorAll(".kb-sidebar-item").forEach((item) => {
      item.addEventListener("click", () => {
        const platform = (item as HTMLElement).dataset.platform;
        if (platform) {
          this.selectPlatform(platform);
        }
      });
    });

    // Tab clicks
    this.container.querySelectorAll(".kb-content-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        const tabName = (tab as HTMLElement).dataset.tab as "browse" | "import";
        if (tabName) {
          this.switchTab(tabName);
        }
      });
    });
  }

  // ─── Platform Selection ──────────────────────────────────────────

  private selectPlatform(platform: string) {
    this.selectedPlatform = platform;
    // Update sidebar highlight
    this.container?.querySelectorAll(".kb-sidebar-item").forEach((item) => {
      const isSelected = (item as HTMLElement).dataset.platform === platform;
      item.classList.toggle("kb-sidebar-selected", isSelected);
    });
    // If browse tab is active, reload the viewer for the new platform
    if (this.activeTab === "browse") {
      this.loadBrowseTab();
    }
  }

  // ─── Tab Switching ───────────────────────────────────────────────

  private switchTab(tab: "browse" | "import") {
    this.activeTab = tab;

    // Update tab header active states
    this.container?.querySelectorAll(".kb-content-tab").forEach((t) => {
      const isActive = (t as HTMLElement).dataset.tab === tab;
      t.classList.toggle("active", isActive);
    });

    // Toggle panel visibility
    const browsePanel = document.getElementById("kb-browse-panel");
    const importPanel = document.getElementById("kb-import-panel");
    if (browsePanel) browsePanel.classList.toggle("hidden", tab !== "browse");
    if (importPanel) importPanel.classList.toggle("hidden", tab !== "import");

    // Lazy-init the active tab's dialog
    if (tab === "browse") {
      this.loadBrowseTab();
    } else {
      this.loadImportTab();
    }
  }

  private loadBrowseTab() {
    const panel = document.getElementById("kb-browse-panel");
    if (!panel) return;

    // Unmount previous instance if exists
    if (this.viewerDialog) {
      // KbViewerDialog doesn't have unmount, so just clear the panel
      panel.innerHTML = "";
    }

    this.viewerDialog = new KbViewerDialog(true); // embedMode=true
    this.viewerDialog.mount(panel);
  }

  private loadImportTab() {
    const panel = document.getElementById("kb-import-panel");
    if (!panel) return;

    if (this.importDialog) {
      // Unmount previous instance
      this.importDialog.unmount();
      panel.innerHTML = "";
    }

    this.importDialog = new KbImportDialog(() => {
      // on complete callback — no-op for now (toast handles feedback)
    }, true); // embedMode=true
    this.importDialog.mount(panel);
  }

  // ─── Keyboard Navigation ─────────────────────────────────────────

  private bindKeys() {
    this.keyHandler = (e: KeyboardEvent) => {
      // Escape — back to connections
      if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        this.onBackToConnections();
        return;
      }

      // Arrow keys — navigate platform sidebar
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        if (document.activeElement?.closest("input, select, textarea")) return;
        e.preventDefault();
        const items = this.container?.querySelectorAll(".kb-sidebar-item");
        if (!items || items.length === 0) return;

        const currentIndex = Array.from(items).findIndex((item) =>
          item.classList.contains("kb-sidebar-selected")
        );
        const nextIndex = e.key === "ArrowDown"
          ? Math.min(currentIndex + 1, items.length - 1)
          : Math.max(currentIndex - 1, 0);

        if (nextIndex !== currentIndex && nextIndex >= 0 && nextIndex < items.length) {
          const platform = (items[nextIndex] as HTMLElement).dataset.platform;
          if (platform) {
            this.selectPlatform(platform);
          }
        }
        return;
      }

      // Enter — confirm platform selection (already handled by click, but keyboard parity)
      if (e.key === "Enter") {
        if (document.activeElement?.closest("input, select, textarea")) return;
        const selected = this.container?.querySelector(".kb-sidebar-item.kb-sidebar-selected");
        if (selected) {
          const platform = (selected as HTMLElement).dataset.platform;
          if (platform && this.activeTab === "browse") {
            e.preventDefault();
            this.loadBrowseTab();
          }
        }
      }
    };
    document.addEventListener("keydown", this.keyHandler);
  }
}
