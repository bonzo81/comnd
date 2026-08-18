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

// ─── Main Class ────────────────────────────────────────────────────

export class KbScreen {
  private onBackToConnections: () => void;
  private onPlatformsChanged?: () => void;
  private container: HTMLElement | null = null;
  private platforms: string[] = [];
  private selectedPlatform: string = "";
  private activeTab: "browse" | "import" = "browse";
  private viewerDialog: KbViewerDialog | null = null;
  private importDialog: KbImportDialog | null = null;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor(onBackToConnections: () => void, onPlatformsChanged?: () => void) {
    this.onBackToConnections = onBackToConnections;
    this.onPlatformsChanged = onPlatformsChanged;
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
      // Keep the current selection; only reset if it's gone or never set
      if (!this.selectedPlatform || !this.platforms.includes(this.selectedPlatform)) {
        this.selectedPlatform = this.platforms[0] ?? "";
      }
    } catch (err) {
      console.error("Failed to load KB platforms:", err);
    }
  }

  // ─── Render ──────────────────────────────────────────────────────

  private render() {
    if (!this.container) return;

    this.container.innerHTML = `
      <div class="kb-screen">
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

  /** Select a platform (driven by the nav panel). */
  selectPlatform(platform: string) {
    if (!this.platforms.includes(platform)) return;
    this.selectedPlatform = platform;
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
    this.viewerDialog.mount(panel, this.selectedPlatform || undefined);
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
      // Import may have added platforms — reload list and refresh the nav panel
      void this.loadPlatforms();
      this.onPlatformsChanged?.();
    }, true); // embedMode=true
    this.importDialog.mount(panel);
  }

  // ─── Keyboard Navigation ─────────────────────────────────────────

  private bindKeys() {
    this.keyHandler = (e: KeyboardEvent) => {
      // Ignore keys when focus is outside the KB screen (nav panel, terminal, host list)
      const ae = document.activeElement;
      if (ae instanceof HTMLElement && ae !== document.body && !this.container?.contains(ae)) return;
      // Escape — back to connections
      if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        this.onBackToConnections();
        return;
      }

    };
    document.addEventListener("keydown", this.keyHandler);
  }
}
