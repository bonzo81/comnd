/**
 * KB Viewer Dialog — browse all commands in the knowledge base
 * Shows commands grouped by category for a selected platform.
 */

import { Command, listKbPlatforms, getAllKbCommands, saveKbCommand, deleteKbCommand, PlatformIndex, loadPlatformIndex } from "../lib/tauri-api";
import { SidebarContent } from "../lib/sidebar-content";
import { getPlatformMeta } from "../lib/platforms";
import { escHtml, formatMode } from "../lib/format";

interface KbCategory {
  name: string;
  commands: Command[];
}

export class KbViewerDialog {
  private container: HTMLElement | null = null;
  private platforms: string[] = [];
  private selectedPlatform: string = "";
  private commands: Command[] = [];
  private categories: KbCategory[] = [];
  private filteredCommands: Command[] = [];
  private selectedIndex = 0;
  private searchQuery = "";
  private selectedCommand: Command | null = null;
  private platformIndex: PlatformIndex | null = null;
  private editing = false;
  private editName = "";
  private editSyntax = "";
  private editDescription = "";
  private editMode = "";
  private editAliases = "";
  private editTags = "";
  private saving = false;
  private deleteConfirmName: string | null = null;
  private embedMode: boolean;

  constructor(embedMode: boolean = false) {
    this.embedMode = embedMode;
  }

  async mount(container: HTMLElement) {
    this.container = container;
    this.renderLoading();

    try {
      this.platforms = await listKbPlatforms();
      if (this.platforms.length > 0) {
        this.selectedPlatform = this.platforms[0];
        await this.loadPlatform();
      }
    } catch (err) {
      this.renderError(`Failed to load platforms: ${err}`);
    }
  }

  private async loadPlatform() {
    if (!this.container) return;
    this.renderLoading();

    try {
      this.platformIndex = await loadPlatformIndex(this.selectedPlatform);
      this.commands = await getAllKbCommands(this.selectedPlatform);
      this.categorizeCommands();
      this.filteredCommands = this.commands;
      this.searchQuery = "";
      this.selectedIndex = 0;
      this.selectedCommand = null;
      this.render();
    } catch (err) {
      this.renderError(`Failed to load commands: ${err}`);
    }
  }

  private categorizeCommands() {
    const categoryMap = new Map<string, Command[]>();
    for (const cmd of this.commands) {
      const cat = cmd.category || "uncategorized";
      if (!categoryMap.has(cat)) {
        categoryMap.set(cat, []);
      }
      categoryMap.get(cat)!.push(cmd);
    }
    this.categories = [];
    categoryMap.forEach((cmds, name) => {
      this.categories.push({ name, commands: cmds });
    });
    this.categories.sort((a, b) => a.name.localeCompare(b.name));
  }

  private applyFilter() {
    const q = this.searchQuery.toLowerCase().trim();
    if (!q) {
      this.filteredCommands = this.commands;
    } else {
      this.filteredCommands = this.commands.filter(
        (cmd) =>
          cmd.name.toLowerCase().includes(q) ||
          cmd.description.toLowerCase().includes(q) ||
          cmd.aliases.some((a) => a.toLowerCase().includes(q)) ||
          cmd.tags.some((t) => t.toLowerCase().includes(q))
      );
    }
    this.selectedIndex = 0;
    this.selectedCommand = null;
  }

  private renderLoading() {
    if (!this.container) return;
    const inner = `
      <div class="import-progress">
        <div class="import-spinner"></div>
        <div class="import-stage">Loading knowledge base…</div>
      </div>
    `;
    this.container.innerHTML = this.embedMode
      ? inner
      : `<div class="import-overlay"><div class="import-dialog">${inner}</div></div>`;
  }

  private renderError(message: string) {
    if (!this.container) return;
    const inner = `
      <div class="import-error">
        <div class="import-error-icon">!</div>
        <h3>Error</h3>
        <p class="import-error-message">${escHtml(message)}</p>
        <button class="btn-secondary" id="kb-viewer-close-error">Close</button>
      </div>
    `;
    this.container.innerHTML = this.embedMode
      ? inner
      : `<div class="import-overlay"><div class="import-dialog">${inner}</div></div>`;
    this.container.querySelector("#kb-viewer-close-error")?.addEventListener("click", () => this.close());
  }

  private render() {
    if (!this.container) return;

    const platformLabel = this.platforms.map((p) => {
      const meta = getPlatformMeta(p);
      return `<option value="${p}" ${p === this.selectedPlatform ? "selected" : ""}>${meta.label}</option>`;
    }).join("");

    if (this.embedMode) {
      this.container.innerHTML = `
        <div class="kb-viewer-toolbar">
          <select id="kb-platform-select" class="kb-platform-select">
            ${platformLabel}
          </select>
          <input type="text" id="kb-search" class="kb-search" placeholder="Search commands…" value="${this.escAttr(this.searchQuery)}" />
          <span class="kb-count">${this.filteredCommands.length} commands</span>
        </div>
        <div class="kb-viewer-body">
          <div class="kb-command-list">
            ${this.categories.map((cat) => this.renderCategory(cat)).join("")}
          </div>
          <div class="kb-command-detail" id="kb-command-detail">
            ${this.renderDetailPanel()}
          </div>
        </div>
        ${this.deleteConfirmName ? this.renderDeleteOverlay() : ""}
      `;
    } else {
      this.container.innerHTML = `
        <div class="import-overlay" id="kb-viewer-overlay">
          <div class="import-dialog kb-viewer">
            <div class="import-header">
              <h2>Knowledge Base</h2>
              <button class="import-close-btn" id="kb-viewer-close">&times;</button>
            </div>
            <div class="kb-viewer-toolbar">
              <select id="kb-platform-select" class="kb-platform-select">
                ${platformLabel}
              </select>
              <input type="text" id="kb-search" class="kb-search" placeholder="Search commands…" value="${this.escAttr(this.searchQuery)}" />
              <span class="kb-count">${this.filteredCommands.length} commands</span>
            </div>
            <div class="kb-viewer-body">
              <div class="kb-command-list">
                ${this.categories.map((cat) => this.renderCategory(cat)).join("")}
              </div>
              <div class="kb-command-detail" id="kb-command-detail">
                ${this.renderDetailPanel()}
              </div>
            </div>
          </div>
        </div>
        ${this.deleteConfirmName ? this.renderDeleteOverlay() : ""}
      `;
    }

    this.bindEvents();
  }

  private renderDetailPanel(): string {
    if (this.editing && this.selectedCommand) {
      return this.renderEditForm();
    }
    if (!this.selectedCommand) {
      return '<div class="sb-placeholder">Select a command to view details</div>';
    }
    const sidebar = new SidebarContent();
    const cmd = this.selectedCommand;
    return `
      <div class="kb-detail-wrapper">
        <div class="kb-detail-actions">
          <button class="btn-small kb-btn-edit" id="kb-cmd-edit-btn">✏️ Edit</button>
          <button class="btn-small kb-btn-delete" id="kb-cmd-delete-btn">🗑 Delete</button>
        </div>
        <div class="kb-detail-sidebar">
          ${sidebar.render(cmd, this.platformIndex?.reference_url ?? null)}
        </div>
      </div>
    `;
  }

  private renderEditForm(): string {
    const cmd = this.selectedCommand;
    if (!cmd) return "";
    return `
      <div class="kb-edit-form">
        <h3 style="margin-bottom:12px">Edit Command</h3>
        <label class="kb-edit-field">
          <span>Name</span>
          <input type="text" id="kb-edit-name" value="${this.escAttr(this.editName)}" />
        </label>
        <label class="kb-edit-field">
          <span>Syntax</span>
          <input type="text" id="kb-edit-syntax" value="${this.escAttr(this.editSyntax)}" />
        </label>
        <label class="kb-edit-field">
          <span>Description</span>
          <textarea id="kb-edit-desc" rows="3">${escHtml(this.editDescription)}</textarea>
        </label>
        <label class="kb-edit-field">
          <span>Mode</span>
          <input type="text" id="kb-edit-mode" value="${this.escAttr(this.editMode)}" />
        </label>
        <label class="kb-edit-field">
          <span>Aliases (comma-separated)</span>
          <input type="text" id="kb-edit-aliases" value="${this.escAttr(this.editAliases)}" />
        </label>
        <label class="kb-edit-field">
          <span>Tags (comma-separated)</span>
          <input type="text" id="kb-edit-tags" value="${this.escAttr(this.editTags)}" />
        </label>
        <div class="kb-edit-actions">
          <button class="btn-text" id="kb-edit-cancel-btn">Cancel</button>
          <button class="btn-primary" id="kb-edit-save-btn" ${this.saving ? 'disabled' : ''}>
            ${this.saving ? "Saving…" : "Save Changes"}
          </button>
        </div>
        <div class="kb-edit-errors" id="kb-edit-errors"></div>
      </div>
    `;
  }

  private renderDeleteOverlay(): string {
    return `
      <div class="modal-backdrop" id="kb-delete-backdrop">
        <div class="modal-panel delete-confirm" style="width:400px">
          <h3>Delete Command</h3>
          <p>Delete <strong>${escHtml(this.deleteConfirmName ?? "")}</strong>?<br/>This cannot be undone.</p>
          <div class="form-actions">
            <button class="btn-text" id="kb-delete-cancel-btn">Cancel</button>
            <button class="btn-danger" id="kb-delete-confirm-btn">Delete</button>
          </div>
        </div>
      </div>`;
  }

  private renderCategory(category: KbCategory): string {
    const filteredCatCommands = this.searchQuery
      ? category.commands.filter(
          (cmd) =>
            cmd.name.toLowerCase().includes(this.searchQuery.toLowerCase()) ||
            cmd.description.toLowerCase().includes(this.searchQuery.toLowerCase()) ||
            cmd.aliases.some((a) => a.toLowerCase().includes(this.searchQuery.toLowerCase()))
        )
      : category.commands;

    if (filteredCatCommands.length === 0) return "";

    return `
      <div class="kb-category">
        <div class="kb-category-header">${escHtml(category.name)} (${filteredCatCommands.length})</div>
        ${filteredCatCommands
          .map((cmd, i) => {
            const globalIndex = this.filteredCommands.indexOf(cmd);
            const selected = globalIndex === this.selectedIndex;
            return `
          <div class="kb-command-item ${selected ? "kb-command-selected" : ""}" data-index="${globalIndex}">
            <span class="kb-command-name">${escHtml(cmd.name)}</span>
            <span class="kb-command-mode">${escHtml(formatMode(cmd.mode))}</span>
          </div>
        `;
          })
          .join("")}
      </div>
    `;
  }

  private bindEvents() {
    if (!this.container) return;

    // Close button
    this.container.querySelector("#kb-viewer-close")?.addEventListener("click", () => this.close());

    // Click outside to close
    this.container.querySelector("#kb-viewer-overlay")?.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).id === "kb-viewer-overlay") {
        this.close();
      }
    });

    // Platform select
    this.container.querySelector("#kb-platform-select")?.addEventListener("change", (e) => {
      this.selectedPlatform = (e.target as HTMLSelectElement).value;
      this.editing = false;
      this.deleteConfirmName = null;
      this.loadPlatform();
    });

    // Search
    this.container.querySelector("#kb-search")?.addEventListener("input", (e) => {
      this.searchQuery = (e.target as HTMLInputElement).value;
      this.applyFilter();
      this.render();
      const searchInput = this.container?.querySelector("#kb-search") as HTMLInputElement;
      if (searchInput) {
        searchInput.focus();
        const len = searchInput.value.length;
        searchInput.setSelectionRange(len, len);
      }
    });

    // Command items
    this.container.querySelectorAll(".kb-command-item").forEach((el) => {
      el.addEventListener("click", () => {
        const index = parseInt((el as HTMLElement).dataset.index ?? "0", 10);
        this.selectedIndex = index;
        this.selectedCommand = this.filteredCommands[index] ?? null;
        this.editing = false;
        this.render();
      });
    });

    // Edit button
    document.getElementById("kb-cmd-edit-btn")?.addEventListener("click", () => this.startEdit());

    // Delete button
    document.getElementById("kb-cmd-delete-btn")?.addEventListener("click", () => this.promptDelete());

    // Edit form: save
    document.getElementById("kb-edit-save-btn")?.addEventListener("click", () => this.saveEdit());

    // Edit form: cancel
    document.getElementById("kb-edit-cancel-btn")?.addEventListener("click", () => {
      this.editing = false;
      this.render();
    });

    // Delete confirm
    document.getElementById("kb-delete-confirm-btn")?.addEventListener("click", () => this.confirmDelete());
    document.getElementById("kb-delete-cancel-btn")?.addEventListener("click", () => {
      this.deleteConfirmName = null;
      this.render();
    });
    document.getElementById("kb-delete-backdrop")?.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).id === "kb-delete-backdrop") {
        this.deleteConfirmName = null;
        this.render();
      }
    });

    // Keyboard navigation
    this._keyHandler = (e: KeyboardEvent) => this.handleKey(e);
    document.addEventListener("keydown", this._keyHandler);
  }

  private _keyHandler: ((e: KeyboardEvent) => void) | null = null;

  private handleKey(e: KeyboardEvent) {
    if (this.deleteConfirmName) {
      if (e.key === "Escape") {
        e.preventDefault();
        this.deleteConfirmName = null;
        this.render();
      }
      return;
    }
    if (this.editing) {
      if (e.key === "Escape") {
        e.preventDefault();
        this.editing = false;
        this.render();
      }
      return;
    }
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        this.close();
        break;
      case "ArrowDown":
        e.preventDefault();
        if (this.filteredCommands.length > 0) {
          this.selectedIndex = Math.min(this.selectedIndex + 1, this.filteredCommands.length - 1);
          this.selectedCommand = this.filteredCommands[this.selectedIndex];
          this.render();
          this.scrollSelectedIntoView();
        }
        break;
      case "ArrowUp":
        e.preventDefault();
        if (this.filteredCommands.length > 0) {
          this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
          this.selectedCommand = this.filteredCommands[this.selectedIndex];
          this.render();
          this.scrollSelectedIntoView();
        }
        break;
      case "Enter":
        if (this.selectedCommand) {
          // Could copy to clipboard or run command
        }
        break;
    }
  }

  private scrollSelectedIntoView() {
    const el = this.container?.querySelector(".kb-command-selected");
    el?.scrollIntoView({ block: "nearest" });
  }

  private startEdit() {
    const cmd = this.selectedCommand;
    if (!cmd) return;
    this.editName = cmd.name;
    this.editSyntax = cmd.syntax;
    this.editDescription = cmd.description;
    this.editMode = cmd.mode;
    this.editAliases = cmd.aliases.join(", ");
    this.editTags = cmd.tags.join(", ");
    this.editing = true;
    this.saving = false;
    this.render();
  }

  private promptDelete() {
    this.deleteConfirmName = this.selectedCommand?.name ?? null;
    this.render();
  }

  private async saveEdit() {
    const nameInput = document.getElementById("kb-edit-name") as HTMLInputElement;
    const syntaxInput = document.getElementById("kb-edit-syntax") as HTMLInputElement;
    const descInput = document.getElementById("kb-edit-desc") as HTMLTextAreaElement;
    const modeInput = document.getElementById("kb-edit-mode") as HTMLInputElement;
    const aliasesInput = document.getElementById("kb-edit-aliases") as HTMLInputElement;
    const tagsInput = document.getElementById("kb-edit-tags") as HTMLInputElement;
    const errEl = document.getElementById("kb-edit-errors");

    if (!nameInput || !syntaxInput || !descInput || !modeInput) return;

    const name = nameInput.value.trim();
    if (!name) {
      if (errEl) errEl.textContent = "Name is required";
      return;
    }

    this.saving = true;
    this.render();

    const aliases = aliasesInput?.value.split(",").map(a => a.trim()).filter(a => a) ?? [];
    const tags = tagsInput?.value.split(",").map(t => t.trim()).filter(t => t) ?? [];
    const category = this.selectedCommand?.category ?? "general";

    try {
      await saveKbCommand(
        this.selectedPlatform,
        category,
        name,
        syntaxInput.value.trim(),
        descInput.value.trim(),
        modeInput.value.trim(),
        aliases,
        tags,
      );
      this.editing = false;
      // Reload the platform with updated data
      await this.loadPlatform();
    } catch (e) {
      if (errEl) errEl.textContent = `Save failed: ${e}`;
      this.saving = false;
      this.render();
    }
  }

  private async confirmDelete() {
    const cmdName = this.deleteConfirmName;
    if (!cmdName) return;
    const category = this.selectedCommand?.category || "general";

    try {
      await deleteKbCommand(this.selectedPlatform, category, cmdName);
      this.deleteConfirmName = null;
      this.selectedCommand = null;
      // Reload the platform
      await this.loadPlatform();
    } catch (e) {
      this.deleteConfirmName = null;
      this.render();
      // Render error inline
      const detailEl = this.container?.querySelector("#kb-command-detail");
      if (detailEl) {
        detailEl.innerHTML = `<div class="kb-edit-errors" style="padding:16px;color:var(--color-error)">Delete failed: ${escHtml(String(e))}</div>`;
      }
    }
  }

  private close() {
    if (this._keyHandler) {
      document.removeEventListener("keydown", this._keyHandler);
      this._keyHandler = null;
    }
    if (this.container) {
      this.container.innerHTML = "";
    }
  }

  private escAttr(s: string): string {
    return escHtml(s).replace(/'/g, "&#39;");
  }
}
