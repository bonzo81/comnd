/**
 * KB Viewer Dialog — browse all commands in the knowledge base
 * Shows commands grouped by category for a selected platform.
 */

import { Command, listKbPlatforms, getAllKbCommands, saveKbCommand, deleteKbCommand, disableKbCommand, enableKbCommand, getDisabledCommands, PlatformIndex, loadPlatformIndex, KbValidationIssue } from "../lib/tauri-api";
import { SidebarContent } from "../lib/sidebar-content";
import { refreshValidation } from "../lib/validation-cache";
import { escAttr, escHtml, formatMode } from "../lib/format";
import { confirmDialog } from "../lib/confirm-dialog";
import { moveListItem } from "../lib/listbox-nav";
import { icons } from "../lib/icons";
import { getSearchIncludeTags } from "../lib/search-prefs";

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
  // Phase 5.8: minimal token editor — raw JSON in a textarea. The KB viewer
  // renders the parsed result so the user sees what they wrote.
  private editTokensJson = "";
  private editOrder = "";
  private editNegatable = false;
  private saving = false;
  private disabledCommands: string[] = [];
  private embedMode: boolean;

  constructor(embedMode: boolean = false) {
    this.embedMode = embedMode;
  }

  async mount(container: HTMLElement, platform?: string) {
    this.container = container;
    this.renderLoading();

    try {
      this.platforms = await listKbPlatforms();
      if (platform && this.platforms.includes(platform)) {
        this.selectedPlatform = platform;
      } else if (!this.selectedPlatform && this.platforms.length > 0) {
        this.selectedPlatform = this.platforms[0];
      }
      if (this.platforms.length > 0) {
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
      [this.commands, this.disabledCommands] = await Promise.all([
        getAllKbCommands(this.selectedPlatform),
        getDisabledCommands(this.selectedPlatform),
      ]);
      void refreshValidation(this.selectedPlatform);
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
      this.filteredCommands = this.commands.filter((cmd) => {
        if (cmd.name.toLowerCase().includes(q)) return true;
        if (cmd.aliases.some((a) => a.toLowerCase().includes(q))) return true;
        if (getSearchIncludeTags() && cmd.tags.some((t) => t.toLowerCase().includes(q))) return true;
        return false;
      });
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
      : `<div class="modal-backdrop"><div class="import-dialog">${inner}</div></div>`;
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
      : `<div class="modal-backdrop"><div class="import-dialog">${inner}</div></div>`;
    this.container.querySelector("#kb-viewer-close-error")?.addEventListener("click", () => this.close());
  }

  private render() {
    if (!this.container) return;

    if (this.embedMode) {
      this.container.innerHTML = `
        <div class="kb-viewer-toolbar">
          <input type="text" id="kb-search" class="form-input form-input-sm kb-search" placeholder="Search commands…" aria-label="Search commands" value="${escAttr(this.searchQuery)}" />
          <span class="kb-count">${this.filteredCommands.length} commands</span>
        </div>
        <div class="kb-viewer-body">
          <div class="kb-command-list" role="listbox" aria-label="Knowledge base commands">
            ${this.categories.map((cat) => this.renderCategory(cat)).join("")}
            ${this.renderIgnoredSection()}
          </div>
          <div class="kb-command-detail" id="kb-command-detail">
            ${this.renderDetailPanel()}
          </div>
        </div>
      `;
    } else {
      this.container.innerHTML = `
        <div class="modal-backdrop" id="kb-viewer-overlay" role="dialog" aria-modal="true" aria-labelledby="kb-viewer-title">
          <div class="import-dialog kb-viewer">
            <div class="import-header">
              <h2 id="kb-viewer-title">Knowledge Base</h2>
              <button class="import-close-btn" id="kb-viewer-close" aria-label="Close knowledge base">&times;</button>
            </div>
            <div class="kb-viewer-toolbar">
              <input type="text" id="kb-search" class="form-input form-input-sm kb-search" placeholder="Search commands…" aria-label="Search commands" value="${escAttr(this.searchQuery)}" />
              <span class="kb-count">${this.filteredCommands.length} commands</span>
            </div>
            <div class="kb-viewer-body">
              <div class="kb-command-list" role="listbox" aria-label="Knowledge base commands">
                ${this.categories.map((cat) => this.renderCategory(cat)).join("")}
                ${this.renderIgnoredSection()}
              </div>
              <div class="kb-command-detail" id="kb-command-detail">
                ${this.renderDetailPanel()}
              </div>
            </div>
          </div>
        </div>
      `;
    }

    this.bindEvents();
  }

  /** Deep-link: select a command by name so the detail panel shows it. */
  selectCommandByName(name: string): boolean {
    const idx = this.commands.findIndex((c) => c.name === name);
    if (idx < 0) return false;
    this.searchQuery = "";
    this.filteredCommands = this.commands;
    this.selectedIndex = idx;
    this.selectedCommand = this.commands[idx];
    this.editing = false;
    this.render();
    return true;
  }

  /** Switch the displayed platform (driven by the nav panel). */
  setPlatform(platform: string) {
    if (!this.platforms.includes(platform) || platform === this.selectedPlatform) return;
    this.selectedPlatform = platform;
    this.editing = false;
    this.loadPlatform();
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
    const isOverride = !!cmd.overrides;
    return `
      <div class="kb-detail-wrapper">
        <div class="kb-detail-actions">
          <button class="btn-secondary btn-small kb-btn-edit" id="kb-cmd-edit-btn">${icons.pencil} Edit</button>
          <button class="btn-secondary btn-small kb-btn-ignore" id="kb-cmd-ignore-btn">Ignore</button>
          <button class="btn-secondary btn-small kb-btn-delete" id="kb-cmd-delete-btn">${icons.trash} ${isOverride ? "Restore built-in version" : "Delete"}</button>
        </div>
        <div class="kb-detail-sidebar">
          ${isOverride ? `<div class="kb-override-note">This is your custom version — it overrides the built-in KB entry with the same name. Deleting it restores the built-in version.</div>` : ""}
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
          <input type="text" class="form-input" id="kb-edit-name" value="${escAttr(this.editName)}" />
        </label>
        <label class="kb-edit-field">
          <span>Syntax</span>
          <input type="text" class="form-input" id="kb-edit-syntax" value="${escAttr(this.editSyntax)}" />
        </label>
        <label class="kb-edit-field">
          <span>Description</span>
          <textarea class="form-input" id="kb-edit-desc" rows="3">${escHtml(this.editDescription)}</textarea>
        </label>
        <label class="kb-edit-field">
          <span>Mode</span>
          <input type="text" class="form-input" id="kb-edit-mode" value="${escAttr(this.editMode)}" />
        </label>
        <label class="kb-edit-field">
          <span>Aliases (comma-separated)</span>
          <input type="text" class="form-input" id="kb-edit-aliases" value="${escAttr(this.editAliases)}" />
        </label>
        <label class="kb-edit-field">
          <span>Tags (comma-separated)</span>
          <input type="text" class="form-input" id="kb-edit-tags" value="${escAttr(this.editTags)}" />
        </label>
        <label class="kb-edit-field">
          <span>Tokens (JSON array — empty for legacy)</span>
          <textarea class="form-input" id="kb-edit-tokens" rows="4" placeholder='[{"lit":"show ip interface"},{"choice":["brief"],"optional":true}]'>${escHtml(this.editTokensJson)}</textarea>
        </label>
        <label class="kb-edit-field kb-edit-row">
          <span>Order</span>
          <select class="form-input" id="kb-edit-order">
            <option value="fixed"${this.editOrder === "fixed" ? " selected" : ""}>fixed</option>
            <option value="flags-anywhere"${this.editOrder === "flags-anywhere" ? " selected" : ""}>flags-anywhere</option>
            <option value="free"${this.editOrder === "free" ? " selected" : ""}>free</option>
          </select>
        </label>
        <label class="kb-edit-field kb-edit-row">
          <span>Negatable</span>
          <input type="checkbox" id="kb-edit-negatable" ${this.editNegatable ? "checked" : ""} />
        </label>
        <div class="kb-edit-actions">
          <button class="btn-text" id="kb-edit-cancel-btn">Cancel</button>
          <button class="btn-primary" id="kb-edit-save-btn" ${this.saving ? 'disabled' : ''}>
            ${this.saving ? "Saving…" : "Save Changes"}
          </button>
        </div>
        <div class="kb-edit-errors" id="kb-edit-errors" role="alert"></div>
      </div>
    `;
  }

  private renderCategory(category: KbCategory): string {
    const filteredCatCommands = this.searchQuery
      ? category.commands.filter((cmd) => {
          const q = this.searchQuery.toLowerCase();
          if (cmd.name.toLowerCase().includes(q)) return true;
          if (cmd.aliases.some((a) => a.toLowerCase().includes(q))) return true;
          if (getSearchIncludeTags() && cmd.tags.some((t) => t.toLowerCase().includes(q))) return true;
          return false;
        })
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
          <div class="kb-command-item ${selected ? "kb-command-selected" : ""}" data-index="${globalIndex}"
               role="option" tabindex="0" aria-selected="${selected}">
            <span class="kb-command-name">${escHtml(cmd.name)}</span>
            <span class="kb-command-mode">${escHtml(formatMode(cmd.mode))}</span>
          </div>
        `;
          })
          .join("")}
      </div>
    `;
  }

  private renderIgnoredSection(): string {
    if (this.disabledCommands.length === 0) return "";
    return `
      <div class="kb-category">
        <div class="kb-category-header">Ignored (${this.disabledCommands.length})</div>
        ${this.disabledCommands
          .map((name) => `
            <div class="kb-command-item kb-command-ignored" data-ignore-name="${escAttr(name)}" role="option" tabindex="0">
              <span class="kb-command-name">${escHtml(name)}</span>
              <button class="btn-text btn-small kb-btn-enable" data-enable-name="${escAttr(name)}">Enable</button>
            </div>
          `)
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
      el.addEventListener("keydown", (e) => {
        if ((e as KeyboardEvent).key === "Enter" || (e as KeyboardEvent).key === " ") {
          e.preventDefault();
          (el as HTMLElement).click();
        }
      });
    });

    // Edit button
    document.getElementById("kb-cmd-edit-btn")?.addEventListener("click", () => this.startEdit());

    // Delete button
    document.getElementById("kb-cmd-delete-btn")?.addEventListener("click", () => this.promptDelete());

    // Ignore button (non-destructive — no confirm)
    document.getElementById("kb-cmd-ignore-btn")?.addEventListener("click", () => this.ignoreCommand());

    // Enable buttons in the Ignored section
    this.container.querySelectorAll(".kb-btn-enable").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        const name = (el as HTMLElement).dataset.enableName ?? "";
        if (name) void this.enableIgnored(name);
      });
    });

    // Edit form: save
    document.getElementById("kb-edit-save-btn")?.addEventListener("click", () => this.saveEdit());

    // Edit form: cancel
    document.getElementById("kb-edit-cancel-btn")?.addEventListener("click", () => {
      this.editing = false;
      this.render();
    });

    // Keyboard navigation
    this._keyHandler = (e: KeyboardEvent) => this.handleKey(e);
    document.addEventListener("keydown", this._keyHandler);
  }

  private _keyHandler: ((e: KeyboardEvent) => void) | null = null;

  private handleKey(e: KeyboardEvent) {
    // Ignore when the KB view is hidden or focus is outside this dialog
    // (e.g. global search in the title bar). Without this, arrow keys in
    // global search also trigger a full re-render here → progressive freeze.
    if (!this.container || this.container.offsetParent === null) return;
    const ae = document.activeElement;
    if (ae instanceof HTMLElement && ae !== document.body && !this.container.contains(ae)) return;
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
      case "ArrowUp":
        e.preventDefault();
        moveListItem(this.filteredCommands.length, this.selectedIndex, (i) => {
          this.selectedIndex = i;
          this.selectedCommand = this.filteredCommands[i];
          this.render();
          this.scrollSelectedIntoView();
        }, e.key === "ArrowDown" ? 1 : -1, false);
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
    // Phase 5.8: prefill token fields from the existing command.
    this.editTokensJson = cmd.tokens && cmd.tokens.length > 0
      ? JSON.stringify(cmd.tokens, null, 2)
      : "";
    this.editOrder = cmd.order ?? "fixed";
    this.editNegatable = !!cmd.negatable;
    this.editing = true;
    this.saving = false;
    this.render();
  }

  private promptDelete() {
    const cmd = this.selectedCommand;
    if (!cmd) return;
    const isOverride = !!cmd.overrides;
    const name = cmd.name;
    confirmDialog({
      title: isOverride ? "Restore Built-in Version" : "Delete Command",
      message: isOverride
        ? `Delete your custom version of <strong>${escHtml(name)}</strong>? The built-in KB entry will be shown again.`
        : `Delete <strong>${escHtml(name)}</strong>?<br/>This cannot be undone.`,
      confirmLabel: isOverride ? "Restore Built-in" : "Delete",
      destructive: true,
      onConfirm: () => void this.confirmDelete(name),
    });
  }

  private async ignoreCommand() {
    const name = this.selectedCommand?.name;
    if (!name) return;
    try {
      await disableKbCommand(this.selectedPlatform, name);
      this.selectedCommand = null;
      await this.loadPlatform();
    } catch (e) {
      const detailEl = this.container?.querySelector("#kb-command-detail");
      if (detailEl) {
        detailEl.innerHTML = `<div class="kb-edit-errors">Ignore failed: ${escHtml(String(e))}</div>`;
      }
    }
  }

  private async enableIgnored(name: string) {
    try {
      await enableKbCommand(this.selectedPlatform, name);
      await this.loadPlatform();
    } catch (e) {
      const detailEl = this.container?.querySelector("#kb-command-detail");
      if (detailEl) {
        detailEl.innerHTML = `<div class="kb-edit-errors">Enable failed: ${escHtml(String(e))}</div>`;
      }
    }
  }

  private async saveEdit() {
    const nameInput = document.getElementById("kb-edit-name") as HTMLInputElement;
    const syntaxInput = document.getElementById("kb-edit-syntax") as HTMLInputElement;
    const descInput = document.getElementById("kb-edit-desc") as HTMLTextAreaElement;
    const modeInput = document.getElementById("kb-edit-mode") as HTMLInputElement;
    const aliasesInput = document.getElementById("kb-edit-aliases") as HTMLInputElement;
    const tagsInput = document.getElementById("kb-edit-tags") as HTMLInputElement;
    const tokensInput = document.getElementById("kb-edit-tokens") as HTMLTextAreaElement;
    const orderSelect = document.getElementById("kb-edit-order") as HTMLSelectElement;
    const negatableInput = document.getElementById("kb-edit-negatable") as HTMLInputElement;
    const errEl = document.getElementById("kb-edit-errors");

    if (!nameInput || !syntaxInput || !descInput || !modeInput) return;

    const name = nameInput.value.trim();
    if (!name) {
      if (errEl) errEl.textContent = "Name is required";
      return;
    }

    // Phase 5.8: validate tokens JSON before save (cheap client-side check).
    const tokensJson = tokensInput?.value.trim() ?? "";
    if (tokensJson) {
      try {
        JSON.parse(tokensJson);
      } catch (e) {
        if (errEl) errEl.textContent = `Tokens JSON invalid: ${e}`;
        return;
      }
    }

    this.saving = true;
    this.render();

    const aliases = aliasesInput?.value.split(",").map(a => a.trim()).filter(a => a) ?? [];
    const tags = tagsInput?.value.split(",").map(t => t.trim()).filter(t => t) ?? [];
    const category = this.selectedCommand?.category ?? "general";
    const order = (orderSelect?.value ?? "fixed") as "fixed" | "flags-anywhere" | "free";

    let issues: KbValidationIssue[] | null = null;
    let failure: string | null = null;
    try {
      issues = await saveKbCommand(
        this.selectedPlatform,
        category,
        name,
        syntaxInput.value.trim(),
        descInput.value.trim(),
        modeInput.value.trim(),
        aliases,
        tags,
        tokensJson || undefined,
        order,
        !!negatableInput?.checked,
      );
      if (issues && issues.length > 0) {
        // Validator refused the save — keep the form open and show each issue.
        this.saving = false;
        this.render();
      } else {
        this.editing = false;
        // Reload the platform with updated data
        await this.loadPlatform();
      }
    } catch (e) {
      failure = `Save failed: ${e}`;
      this.saving = false;
      this.render();
    }
    const el = document.getElementById("kb-edit-errors");
    if (!el) return;
    if (issues && issues.length > 0) el.innerHTML = issues.map(i => `<div>${escHtml(i.message)}</div>`).join("");
    else if (failure !== null) el.textContent = failure;
    else el.textContent = "";
  }

  private async confirmDelete(cmdName: string) {
    const category = this.selectedCommand?.category || "general";
    const overrides = !!this.selectedCommand?.overrides;

    try {
      await deleteKbCommand(this.selectedPlatform, category, cmdName, overrides);
      this.selectedCommand = null;
      // Reload the platform
      await this.loadPlatform();
    } catch (e) {
      this.render();
      // Render error inline
      const detailEl = this.container?.querySelector("#kb-command-detail");
      if (detailEl) {
        detailEl.innerHTML = `<div class="kb-edit-errors">Delete failed: ${escHtml(String(e))}</div>`;
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

}
