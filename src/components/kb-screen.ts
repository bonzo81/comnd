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
  import { Command, listKbPlatforms } from "../lib/tauri-api";
  import { escAttr, escHtml } from "../lib/format";

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
  private pendingCommand: { platform: string; cmd: Command } | null = null;

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
          <div class="kb-platform-filter${this.activeTab !== "browse" ? " hidden" : ""}" id="kb-platform-filter">
            <span class="kb-platform-filter-label">Platform:</span>
            <select id="kb-platform-filter-select" class="form-input form-input-sm kb-platform-select"></select>
          </div>
          <div class="kb-content-panel${this.activeTab !== "browse" ? " hidden" : ""}" id="kb-browse-panel"></div>
          <div class="kb-content-panel${this.activeTab !== "import" ? " hidden" : ""}" id="kb-import-panel"></div>
        </div>
      </div>
    `;

    this.bindPlatformFilter();
  }

  private bindPlatformFilter() {
    const select = this.container?.querySelector<HTMLSelectElement>("#kb-platform-filter-select");
    if (!select) return;
    select.innerHTML = this.platforms
      .map((p) => `<option value="${escAttr(p)}" ${p === this.selectedPlatform ? "selected" : ""}>${escHtml(p)}</option>`)
      .join("");
    select.addEventListener("change", () => {
      this.selectPlatform(select.value);
    });
  }

  /** Switch the active tab (driven by the nav panel). */
  setTab(tab: "browse" | "import") {
    if (this.activeTab === tab) return;
    this.switchTab(tab);
  }

  /** Current active tab (for nav panel highlighting). */
  getActiveTab(): "browse" | "import" {
    return this.activeTab;
  }

  /** Deep-link: switch to browse tab, select platform, show command detail. */
  openCommand(platform: string, cmd: Command) {
    if (!this.platforms.includes(platform)) {
      void this.loadPlatforms().then(() => {
        if (this.platforms.includes(platform)) this.openCommand(platform, cmd);
      });
      return;
    }
    if (this.activeTab !== "browse") {
      this.switchTab("browse");
    }
    if (this.selectedPlatform !== platform) {
      this.selectedPlatform = platform;
      const select = this.container?.querySelector<HTMLSelectElement>("#kb-platform-filter-select");
      if (select) select.value = platform;
      this.pendingCommand = { platform, cmd };
      this.loadBrowseTab();
      return;
    }
    if (this.viewerDialog) {
      this.viewerDialog.selectCommandByName(cmd.name);
    } else {
      this.pendingCommand = { platform, cmd };
      this.loadBrowseTab();
    }
  }

  // ─── Platform Selection ──────────────────────────────────────────

  /** Select a platform (driven by the nav panel or the top filter). */
  selectPlatform(platform: string) {
    if (!this.platforms.includes(platform)) return;
    this.selectedPlatform = platform;
    // Keep the top filter select in sync
    const select = this.container?.querySelector<HTMLSelectElement>("#kb-platform-filter-select");
    if (select) select.value = platform;
    // If browse tab is active, reload the viewer for the new platform
    if (this.activeTab === "browse") {
      this.loadBrowseTab();
    }
  }

  // ─── Tab Switching ───────────────────────────────────────────────

  private switchTab(tab: "browse" | "import") {
    this.activeTab = tab;

    // Toggle panel + filter visibility
    const filter = document.getElementById("kb-platform-filter");
    const browsePanel = document.getElementById("kb-browse-panel");
    const importPanel = document.getElementById("kb-import-panel");
    if (filter) filter.classList.toggle("hidden", tab !== "browse");
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

    this.viewerDialog = new KbViewerDialog();
    this.viewerDialog.mount(panel, this.selectedPlatform || undefined).then(() => {
      const pending = this.pendingCommand;
      this.pendingCommand = null;
      if (pending && pending.platform === this.selectedPlatform) {
        this.viewerDialog?.selectCommandByName(pending.cmd.name);
      }
    });
  }

  private loadImportTab() {
    const panel = document.getElementById("kb-import-panel");
    if (!panel) return;

    // Reuse the mounted instance — the wizard's stage (preview, result)
    // survives tab switches; remounting reset it mid-job.
    if (this.importDialog) return;

    this.importDialog = new KbImportDialog(() => {
      // Import may have added platforms — reload list and refresh the nav panel
      void this.loadPlatforms();
      this.onPlatformsChanged?.();
    });
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
