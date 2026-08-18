/**
 * Host Screen — home screen for browsing, creating, and organising saved hosts.
 *
 * Left panel: hierarchical group tree (folders with nesting).
 * Right panel: host list filtered by selected group.
 * Search bar: searches hosts + tags across all groups.
 */

import {
  Host,
  HostGroup,
  AuthType,
  getHosts,
  saveHost,
  deleteHost,
  saveCredential,
  getCredential,
  getHostGroups,
  saveHostGroup,
  deleteHostGroup,
} from "../lib/tauri-api";
import { log } from "../lib/logger";
import { PLATFORM_META, platformBadge, platformColorClass } from "../lib/platforms";
import { escAttr, escHtml, relativeTime } from "../lib/format";
import { ALL_GROUP_ID, filterHosts } from "../lib/host-filters";

// ─── Main Class ────────────────────────────────────────────────────

export class HostScreen {
  private _onConnect: (host: Host) => void;
  private _getActiveSessions: () => Set<string>;
  private container: HTMLElement | null = null;

  // Data
  private hosts: Host[] = [];
  private groups: HostGroup[] = [];
  private filteredHosts: Host[] = [];
  private filteredGroups: HostGroup[] = [];

  // Selection
  private selectedGroupId: string = ALL_GROUP_ID;
  private selectedHostIndex = 0;
  private searchQuery = "";

  // UI state
  private formOpen = false;
  private editingHost: Host | null = null;
  private editingHasCredential = false;
  private addGroupMode = false;
  private editingGroupId: string | null = null;
  private contextMenu: { type: "host" | "group"; id: string; x: number; y: number } | null = null;
  private deleteConfirmId: string | null = null;
  private deleteConfirmType: "host" | "group" = "host";
  private expandedGroups: Set<string> = new Set([ALL_GROUP_ID]);

  // Bound handler refs
  private _keyHandler: ((e: KeyboardEvent) => void) | null = null;
  private _clickOutsideHandler: ((e: MouseEvent) => void) | null = null;

  constructor(onConnect: (host: Host) => void, getActiveSessions: () => Set<string>) {
    this._onConnect = onConnect;
    this._getActiveSessions = getActiveSessions;
  }

  async mount(container: HTMLElement) {
    this.container = container;
    await this.loadData();
    this.render();
    this.bindGlobalKeys();
  }

  /** Re-render the host list (e.g., after returning from a detached session). */
  async refresh() {
    await this.loadData();
    this.render();
  }

  unmount() {
    if (this._keyHandler) {
      document.removeEventListener("keydown", this._keyHandler);
      this._keyHandler = null;
    }
    if (this._clickOutsideHandler) {
      document.removeEventListener("mousedown", this._clickOutsideHandler);
      this._clickOutsideHandler = null;
    }
  }

  // ─── Data Loading ────────────────────────────────────────────────

  private async loadData() {
    try {
      this.hosts = await getHosts();
    } catch {
      this.hosts = [];
    }
    try {
      this.groups = await getHostGroups();
    } catch {
      this.groups = [];
    }
    // Build tree: ensure groups have parent relationships accounted for
    // Sort groups by sort_order
    this.groups.sort((a, b) => a.sort_order - b.sort_order);
    this.applyFilter();
  }

  private applyFilter() {
    this.filteredHosts = filterHosts(this.hosts, this.groups, this.selectedGroupId, this.searchQuery);

    // Clamp selection
    if (this.selectedHostIndex >= this.filteredHosts.length) {
      this.selectedHostIndex = Math.max(0, this.filteredHosts.length - 1);
    }
  }

  // ─── Render ──────────────────────────────────────────────────────

  private render() {
    if (!this.container) return;

    const hasHosts = this.hosts.length > 0;
    const countText = this.searchQuery
      ? `${this.filteredHosts.length} of ${this.hosts.length} hosts`
      : `${this.hosts.length} host${this.hosts.length !== 1 ? "s" : ""}`;

    this.container.innerHTML = `
      <div class="host-screen">
        <!-- Header -->
        <div class="hs-header">
          <div class="hs-header-actions">
            <button class="btn-primary" id="hs-add-host-btn">+ New Connection</button>
          </div>
        </div>

        <!-- Main area -->
        <div class="hs-main">
          <!-- Left: Group tree -->
          <div class="hs-group-panel">
            <div class="hs-group-header">
              <span class="hs-group-title">Groups</span>
              <button class="hs-add-group-btn" id="hs-add-group-btn" title="New group">+</button>
            </div>
            <div class="hs-group-list" id="hs-group-list">
              ${this.renderGroupTree()}
            </div>
          </div>

          <!-- Right: Host list -->
          <div class="hs-host-panel">
            <div class="hs-search">
              <div class="hs-search-row">
                <input type="text" placeholder="Search hosts, tags… ( / )" id="hs-search" value="${escAttr(this.searchQuery)}" />
                ${this.selectedGroupId !== ALL_GROUP_ID ? `<span class="hs-group-filter-badge">${escHtml(this.getGroupName(this.selectedGroupId))} ✕</span>` : ""}
              </div>
              <span class="hs-host-count">${countText}</span>
            </div>

            <div class="hs-host-list" id="hs-host-list">
              ${hasHosts ? this.renderHostList() : this.renderEmptyState()}
            </div>
          </div>
        </div>
      </div>

      ${this.addGroupMode ? this.renderAddGroupForm() : ""}
      ${this.formOpen ? this.renderForm() : ""}
      ${this.contextMenu ? this.renderContextMenu() : ""}
      ${this.deleteConfirmId ? this.renderDeleteConfirm() : ""}
    `;

    this.bindEvents();
  }

  private renderGroupTree(): string {
    // "All Hosts" pseudo-group
    const allSelected = this.selectedGroupId === ALL_GROUP_ID;
    const totalHosts = this.hosts.length;
    let html = `<div class="hs-group-item ${allSelected ? "hs-group-selected" : ""}" data-group-id="${ALL_GROUP_ID}">
      <span class="hs-group-icon">📁</span>
      <span class="hs-group-name">All Hosts</span>
      <span class="hs-group-count">${totalHosts}</span>
    </div>`;

    // Root groups (no parent_id)
    const rootGroups = this.groups.filter((g) => !g.parent_id);
    for (const group of rootGroups) {
      html += this.renderGroupNode(group, 0);
    }

    if (rootGroups.length === 0 && this.groups.length === 0) {
      // No groups yet — hint
    }

    return html;
  }

  private renderGroupNode(group: HostGroup, depth: number): string {
    const selected = this.selectedGroupId === group.id;
    const expanded = this.expandedGroups.has(group.id);
    const children = this.groups.filter((g) => g.parent_id === group.id);
    const hostCount = this.hosts.filter((h) => h.group_id === group.id).length;
    const hasChildren = children.length > 0;
    const indent = depth * 16;

    let html = `<div class="hs-group-item ${selected ? "hs-group-selected" : ""}"
                     data-group-id="${group.id}"
                     style="padding-left:${12 + indent}px">
      <span class="hs-group-toggle">${hasChildren ? (expanded ? "▾" : "▸") : "&nbsp;"}</span>
      <span class="hs-group-icon">${group.icon ?? "📁"}</span>
      <span class="hs-group-name">${escHtml(group.name)}</span>
      <span class="hs-group-count">${hostCount}</span>
    </div>`;

    if (hasChildren && expanded) {
      for (const child of children) {
        html += this.renderGroupNode(child, depth + 1);
      }
    }

    return html;
  }

  private renderHostList(): string {
    return this.filteredHosts
      .map((h, i) => this.renderHostItem(h, i))
      .join("");
  }

  private renderHostItem(host: Host, index: number): string {
    const selected = index === this.selectedHostIndex;
    const tags = host.tags ?? [];

    return `
      <div class="hs-host-item ${selected ? "hs-host-selected" : ""}"
           data-host-id="${host.id}" data-index="${index}">
        <div class="hs-host-badge ${platformColorClass(host.platform)}">[${escHtml(platformBadge(host.platform))}]</div>
        <div class="hs-host-info">
          <div class="hs-host-top">
            <span class="hs-host-name">${escHtml(host.display_name)}</span>
            ${tags.length > 0 ? `<span class="hs-host-tags">${tags.slice(0, 3).map((t) => `<span class="hs-tag">${escHtml(t)}</span>`).join("")}${tags.length > 3 ? `<span class="hs-tag-more">+${tags.length - 3}</span>` : ""}</span>` : ""}
          </div>
          <div class="hs-host-meta">
            <span>${escHtml(host.hostname)}${host.port !== 22 ? `:${host.port}` : ""}</span>
            <span class="hs-meta-sep">·</span>
            <span>${escHtml(host.username)}</span>
            ${host.group_id ? `<span class="hs-meta-sep">·</span><span class="hs-meta-group">${escHtml(this.getGroupName(host.group_id))}</span>` : ""}
          </div>
        </div>
        <div class="hs-host-time">${relativeTime(host.last_connected)}</div>
        <div class="cm-host-dot ${this._getActiveSessions().has(host.id) ? "dot-ok" : (host.last_connected ? "dot-never" : "dot-never")}" title="${this._getActiveSessions().has(host.id) ? "Session active" : (host.last_connected ? "Previously connected" : "Never connected")}"></div>
      </div>`;
  }

  private renderEmptyState(): string {
    return `
      <div class="cm-empty-state">
        <div class="cm-empty-icon">🖥</div>
        <h2>Welcome to net.sh</h2>
        <p>A smarter SSH client for network engineers.<br/>
        Connect to your devices with context-aware command suggestions built in.</p>
        <button class="btn-primary" id="hs-empty-add-btn">+ Add your first host</button>
        <p class="cm-platforms">Supports: Cisco IOS-XE · NX-OS · F5 TMOS · Linux</p>
      </div>
    `;
  }

  // ─── Add Group Form ──────────────────────────────────────────────

  private renderAddGroupForm(): string {
    return `
      <div class="modal-backdrop" id="hs-group-backdrop">
        <div class="modal-panel" style="width:380px">
          <h3>${this.editingGroupId ? "Rename Group" : "New Group"}</h3>
          <div class="hs-add-group-form">
            <label style="display:block;margin-bottom:12px">
              <span style="display:block;font-size:12px;color:var(--color-text-secondary);margin-bottom:4px">Group Name</span>
              <input type="text" id="hs-group-name-input" placeholder="e.g. DC Switches" style="width:100%;padding:8px 12px;background:var(--color-surface-primary);border:1px solid var(--color-border);border-radius:6px;color:var(--color-text-primary);font-size:13px;outline:none" />
            </label>
            <label style="display:block;margin-bottom:12px">
              <span style="display:block;font-size:12px;color:var(--color-text-secondary);margin-bottom:4px">Parent Group (optional)</span>
              <select id="hs-group-parent-select" style="width:100%;padding:8px 12px;background:var(--color-surface-primary);border:1px solid var(--color-border);border-radius:6px;color:var(--color-text-primary);font-size:13px;outline:none;appearance:none">
                <option value="">— Top Level —</option>
                ${this.groups.filter((g) => g.id !== this.editingGroupId).map((g) => `<option value="${g.id}">${escHtml(g.name)}</option>`).join("")}
              </select>
            </label>
            <div class="form-actions">
              <button class="btn-text" id="hs-group-cancel-btn">Cancel</button>
              <button class="btn-primary" id="hs-group-save-btn">${this.editingGroupId ? "Rename" : "Create"}</button>
            </div>
          </div>
        </div>
      </div>`;
  }

  // ─── Host Form ───────────────────────────────────────────────────

  private renderForm(): string {
    const h = this.editingHost;
    const title = h ? "Edit Host" : "New Connection";
    const platforms = Object.entries(PLATFORM_META);

    return `
      <div class="modal-backdrop" id="hs-form-backdrop">
        <div class="modal-panel host-form">
          <h2>${title}</h2>
          <form id="hs-host-form" autocomplete="off">
            <label>
              <span>Display Name <em>*</em></span>
              <input type="text" name="display_name" required placeholder="e.g. Core Router - LON"
                     value="${escAttr(h?.display_name ?? "")}" />
            </label>
            <label>
              <span>Hostname / IP <em>*</em></span>
              <input type="text" name="hostname" required placeholder="e.g. 192.168.1.1 or router.example.com"
                     value="${escAttr(h?.hostname ?? "")}" />
            </label>
            <label>
              <span>Port</span>
              <input type="number" name="port" min="1" max="65535" placeholder="22"
                     value="${h?.port ?? 22}" />
            </label>
            <label>
              <span>Username <em>*</em></span>
              <input type="text" name="username" required placeholder="admin"
                     value="${escAttr(h?.username ?? "")}" />
            </label>

            <!-- Group -->
            <label>
              <span>Group</span>
              <select name="group_id" style="width:100%;padding:8px 12px;background:var(--color-surface-primary);border:1px solid var(--color-border);border-radius:6px;color:var(--color-text-primary);font-size:13px;outline:none;appearance:none">
                <option value="">— No Group —</option>
                ${this.groups.map((g) => `<option value="${g.id}" ${h?.group_id === g.id ? "selected" : ""}>${escHtml(g.name)}</option>`).join("")}
              </select>
            </label>

            <!-- Tags -->
            <label>
              <span>Tags (comma-separated)</span>
              <input type="text" name="tags" placeholder="e.g. core, london, production"
                     value="${escAttr((h?.tags ?? []).join(", "))}" />
            </label>

            <fieldset class="form-auth-group">
              <legend>Authentication</legend>
              <label class="radio-label">
                <input type="radio" name="auth_type" value="password"
                       ${(!h || h.auth_type === "password") ? "checked" : ""} />
                Password
              </label>
              <label class="radio-label">
                <input type="radio" name="auth_type" value="ssh_key"
                       ${h?.auth_type === "ssh_key" ? "checked" : ""} />
                SSH Key
              </label>
            </fieldset>
            <div id="hs-auth-password-field" class="auth-conditional ${(!h || h.auth_type === "password") ? "" : "auth-conditional-hidden"}">
              <label>
                <span>Password ${h && this.editingHasCredential ? '<span class="cred-badge">🔒 Password saved</span>' : ""}</span>
                <input type="password" name="password"
                       placeholder="${h && this.editingHasCredential ? "Leave blank to keep saved password" : "Enter password"}" />
              </label>
            </div>
            <div id="hs-auth-key-field" class="auth-conditional ${h?.auth_type === "ssh_key" ? "" : "auth-conditional-hidden"}">
              <label>
                <span>SSH Key Path</span>
                <input type="text" name="ssh_key_path" placeholder="~/.ssh/id_rsa"
                       value="${escAttr(h?.ssh_key_path ?? "")}" />
              </label>
            </div>
            <label>
              <span>Platform <em>*</em></span>
              <select name="platform" required>
                ${platforms
                  .map(
                    ([id, meta]) =>
                      `<option value="${id}" ${h?.platform === id ? "selected" : ""}>${meta.badge} — ${meta.label}</option>`,
                  )
                  .join("")}
              </select>
            </label>
            <label>
              <span>OS Version</span>
              <input type="text" name="os_version" placeholder="e.g. 17.6 — Leave blank to show all commands"
                     value="${escAttr(h?.os_version ?? "")}" />
            </label>
            <label>
              <span>Notes</span>
              <textarea name="notes" rows="3" placeholder="Optional notes">${escHtml(h?.notes ?? "")}</textarea>
            </label>
            <div class="form-actions">
              <button type="button" class="btn-text" id="hs-form-cancel">Cancel</button>
              <button type="button" class="btn-secondary" id="hs-form-save">Save</button>
              <button type="submit" class="btn-primary" id="hs-form-save-connect">Save & Connect</button>
            </div>
            <div class="form-errors" id="hs-form-errors"></div>
          </form>
        </div>
      </div>`;
  }

  // ─── Context Menu ────────────────────────────────────────────────

  private renderContextMenu(): string {
    if (!this.contextMenu) return "";
    const isGroup = this.contextMenu.type === "group";
    return `
      <div class="context-menu" id="hs-context-menu"
           style="left:${this.contextMenu.x}px;top:${this.contextMenu.y}px">
        ${isGroup ? `
          <div class="ctx-item" data-action="rename-group">Rename</div>
          <div class="ctx-item" data-action="add-subgroup">Add Subgroup</div>
          <div class="ctx-divider"></div>
          <div class="ctx-item ctx-danger" data-action="delete-group">Delete Group</div>
        ` : `
          <div class="ctx-item" data-action="connect">Connect</div>
          <div class="ctx-item" data-action="edit">Edit</div>
          <div class="ctx-item" data-action="duplicate">Duplicate</div>
          <div class="ctx-item" data-action="move-to-group">Move to Group…</div>
          <div class="ctx-divider"></div>
          <div class="ctx-item ctx-danger" data-action="delete">Delete</div>
        `}
      </div>`;
  }

  // ─── Delete Confirm ──────────────────────────────────────────────

  private renderDeleteConfirm(): string {
    const isGroup = this.deleteConfirmType === "group";
    if (isGroup) {
      const group = this.groups.find((g) => g.id === this.deleteConfirmId);
      if (!group) return "";
      return `
        <div class="modal-backdrop" id="hs-delete-backdrop">
          <div class="modal-panel delete-confirm">
            <h3>Delete Group</h3>
            <p>Delete group <strong>${escHtml(group.name)}</strong>?<br/>
            Hosts in this group will be moved to "No Group". Sub-groups will also be deleted.</p>
            <div class="form-actions">
              <button class="btn-text" id="hs-delete-cancel">Cancel</button>
              <button class="btn-danger" id="hs-delete-confirm">Delete</button>
            </div>
          </div>
        </div>`;
    }
    const host = this.hosts.find((h) => h.id === this.deleteConfirmId);
    if (!host) return "";
    return `
      <div class="modal-backdrop" id="hs-delete-backdrop">
        <div class="modal-panel delete-confirm">
          <h3>Delete Host</h3>
          <p>Delete <strong>${escHtml(host.display_name)}</strong>? This cannot be undone.</p>
          <div class="form-actions">
            <button class="btn-text" id="hs-delete-cancel">Cancel</button>
            <button class="btn-danger" id="hs-delete-confirm">Delete</button>
          </div>
        </div>
      </div>`;
  }

  // ─── Event Binding ──────────────────────────────────────────────

  private bindEvents() {
    if (!this.container) return;

    // Header buttons
    this.container.querySelector("#hs-add-host-btn")?.addEventListener("click", () => this.openForm());
    this.container.querySelector("#hs-empty-add-btn")?.addEventListener("click", () => this.openForm());

    // Group list items
    const groupList = this.container.querySelector("#hs-group-list");
    if (groupList) {
      groupList.querySelectorAll(".hs-group-item").forEach((el) => {
        // Select group
        el.addEventListener("click", () => {
          const groupId = (el as HTMLElement).dataset.groupId ?? ALL_GROUP_ID;
          if (groupId === this.selectedGroupId) return;

          // Toggle expand for groups with children
          const toggle = el.querySelector(".hs-group-toggle");
          if (toggle && toggle.textContent?.trim() === "▾") {
            this.expandedGroups.delete(groupId);
          } else if (toggle && toggle.textContent?.trim() === "▸") {
            this.expandedGroups.add(groupId);
          }

          this.selectedGroupId = groupId;
          this.selectedHostIndex = 0;
          this.applyFilter();
          this.render();
        });

        // Context menu on groups
        el.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          const groupId = (el as HTMLElement).dataset.groupId ?? "";
          if (groupId === ALL_GROUP_ID) return;
          this.contextMenu = {
            type: "group",
            id: groupId,
            x: (e as MouseEvent).clientX,
            y: (e as MouseEvent).clientY,
          };
          this.render();
        });
      });
    }

    // Add group button
    this.container.querySelector("#hs-add-group-btn")?.addEventListener("click", () => {
      this.addGroupMode = true;
      this.editingGroupId = null;
      this.render();
    });

    // Group form
    document.getElementById("hs-group-save-btn")?.addEventListener("click", () => this.saveGroup());
    document.getElementById("hs-group-cancel-btn")?.addEventListener("click", () => {
      this.addGroupMode = false;
      this.editingGroupId = null;
      this.render();
    });
    document.getElementById("hs-group-backdrop")?.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).id === "hs-group-backdrop") {
        this.addGroupMode = false;
        this.editingGroupId = null;
        this.render();
      }
    });
    // Enter key in group name input
    document.getElementById("hs-group-name-input")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.saveGroup();
      }
    });

    // Search
    const searchInput = this.container.querySelector("#hs-search") as HTMLInputElement | null;
    if (searchInput) {
      searchInput.addEventListener("input", () => {
        this.searchQuery = searchInput.value;
        this.applyFilter();
        this.render();
        // Re-focus search after render and set cursor to end
        const input = this.container?.querySelector("#hs-search") as HTMLInputElement;
        if (input) {
          input.focus();
          input.setSelectionRange(input.value.length, input.value.length);
        }
      });
    }

    // Group filter badge click (deselect group)
    this.container.querySelector(".hs-group-filter-badge")?.addEventListener("click", () => {
      this.selectedGroupId = ALL_GROUP_ID;
      this.applyFilter();
      this.render();
    });

    // Host items
    this.container.querySelectorAll(".hs-host-item").forEach((el) => {
      el.addEventListener("click", () => {
        this.selectedHostIndex = parseInt((el as HTMLElement).dataset.index ?? "0", 10);
        this.contextMenu = null;
        this.render();
      });
      el.addEventListener("dblclick", () => {
        const id = (el as HTMLElement).dataset.hostId ?? "";
        this.connectToHost(id);
      });
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        const me = e as MouseEvent;
        const id = (el as HTMLElement).dataset.hostId ?? "";
        this.selectedHostIndex = parseInt((el as HTMLElement).dataset.index ?? "0", 10);
        this.contextMenu = { type: "host", id, x: me.clientX, y: me.clientY };
        this.render();
      });
    });

    // Context menu actions
    this.container.querySelectorAll(".ctx-item").forEach((el) => {
      el.addEventListener("click", () => {
        const action = (el as HTMLElement).dataset.action;
        const ctx = this.contextMenu;
        this.contextMenu = null;
        if (!ctx) return;

        switch (action) {
          case "connect":
            this.connectToHost(ctx.id);
            break;
          case "edit":
            this.openForm(ctx.id);
            break;
          case "duplicate":
            this.duplicateHost(ctx.id);
            break;
          case "delete":
            this.deleteConfirmId = ctx.id;
            this.deleteConfirmType = ctx.type;
            this.render();
            break;
          case "rename-group":
            this.editingGroupId = ctx.id;
            this.addGroupMode = true;
            this.render();
            break;
          case "add-subgroup":
            this.addGroupMode = true;
            this.editingGroupId = null;
            this.render();
            // Set parent in the form after render
            setTimeout(() => {
              const parentSelect = document.getElementById("hs-group-parent-select") as HTMLSelectElement;
              if (parentSelect) parentSelect.value = ctx.id;
            }, 50);
            break;
          case "delete-group":
            this.deleteConfirmId = ctx.id;
            this.deleteConfirmType = "group";
            this.render();
            break;
          case "move-to-group":
            this.showMoveToGroup(ctx.id);
            break;
        }
      });
    });

    // Click outside context menu
    if (this._clickOutsideHandler) {
      document.removeEventListener("mousedown", this._clickOutsideHandler);
    }
    this._clickOutsideHandler = (e: MouseEvent) => {
      if (this.contextMenu) {
        const menuEl = this.container?.querySelector("#hs-context-menu");
        if (menuEl && !menuEl.contains(e.target as Node)) {
          this.contextMenu = null;
          this.render();
        }
      }
    };
    document.addEventListener("mousedown", this._clickOutsideHandler);

    // Form events
    this.bindFormEvents();

    // Delete confirm
    document.getElementById("hs-delete-cancel")?.addEventListener("click", () => {
      this.deleteConfirmId = null;
      this.render();
    });
    document.getElementById("hs-delete-confirm")?.addEventListener("click", () => {
      if (this.deleteConfirmId) {
        if (this.deleteConfirmType === "group") {
          this.doDeleteGroup(this.deleteConfirmId);
        } else {
          this.doDeleteHost(this.deleteConfirmId);
        }
      }
    });
    document.getElementById("hs-delete-backdrop")?.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).id === "hs-delete-backdrop") {
        this.deleteConfirmId = null;
        this.render();
      }
    });
  }

  private bindFormEvents() {
    if (!this.container) return;

    // Auth type toggle
    this.container.querySelectorAll('input[name="auth_type"]').forEach((radio) => {
      radio.addEventListener("change", () => {
        const val = (radio as HTMLInputElement).value;
        const pwField = document.getElementById("hs-auth-password-field");
        const keyField = document.getElementById("hs-auth-key-field");
        if (pwField) pwField.classList.toggle("auth-conditional-hidden", val !== "password");
        if (keyField) keyField.classList.toggle("auth-conditional-hidden", val !== "ssh_key");
      });
    });

    // Cancel
    document.getElementById("hs-form-cancel")?.addEventListener("click", () => this.closeForm());
    document.getElementById("hs-form-backdrop")?.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).id === "hs-form-backdrop") this.closeForm();
    });

    // Save
    document.getElementById("hs-form-save")?.addEventListener("click", () => this.submitForm(false));
    document.getElementById("hs-host-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      this.submitForm(true);
    });
  }

  private bindGlobalKeys() {
    if (this._keyHandler) {
      document.removeEventListener("keydown", this._keyHandler);
    }
    this._keyHandler = (e: KeyboardEvent) => this.handleKey(e);
    document.addEventListener("keydown", this._keyHandler);
  }

  // ─── Keyboard ───────────────────────────────────────────────────

  private handleKey(e: KeyboardEvent) {
    // Modals have priority
    if (this.addGroupMode || this.formOpen) {
      if (e.key === "Escape") {
        e.preventDefault();
        if (this.addGroupMode) {
          this.addGroupMode = false;
          this.editingGroupId = null;
          this.render();
        } else if (this.formOpen) {
          this.closeForm();
        }
      }
      return;
    }

    if (this.deleteConfirmId) {
      if (e.key === "Escape") {
        e.preventDefault();
        this.deleteConfirmId = null;
        this.render();
      }
      return;
    }

    if (this.contextMenu) {
      if (e.key === "Escape") {
        e.preventDefault();
        this.contextMenu = null;
        this.render();
      }
      return;
    }

    const isSearchFocused = document.activeElement?.id === "hs-search";

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (this.filteredHosts.length > 0) {
          this.selectedHostIndex = Math.min(this.selectedHostIndex + 1, this.filteredHosts.length - 1);
          this.render();
          if (isSearchFocused) {
            (this.container?.querySelector("#hs-search") as HTMLInputElement)?.focus();
          }
          this.scrollSelectedIntoView();
        }
        break;
      case "ArrowUp":
        e.preventDefault();
        if (this.filteredHosts.length > 0) {
          this.selectedHostIndex = Math.max(this.selectedHostIndex - 1, 0);
          this.render();
          if (isSearchFocused) {
            (this.container?.querySelector("#hs-search") as HTMLInputElement)?.focus();
          }
          this.scrollSelectedIntoView();
        }
        break;
      case "Enter":
        if (!isSearchFocused && this.filteredHosts[this.selectedHostIndex]) {
          e.preventDefault();
          this.connectToHost(this.filteredHosts[this.selectedHostIndex].id);
        }
        break;
      case "/":
        if (!isSearchFocused) {
          e.preventDefault();
          (this.container?.querySelector("#hs-search") as HTMLInputElement)?.focus();
        }
        break;
      case "Escape":
        if (isSearchFocused) {
          e.preventDefault();
          if (this.searchQuery) {
            this.searchQuery = "";
            this.applyFilter();
            this.render();
            (this.container?.querySelector("#hs-search") as HTMLInputElement)?.focus();
          } else {
            (this.container?.querySelector("#hs-search") as HTMLInputElement)?.blur();
          }
        }
        break;
      case "Delete":
      case "Backspace":
        if (!isSearchFocused && this.filteredHosts[this.selectedHostIndex]) {
          e.preventDefault();
          this.deleteConfirmId = this.filteredHosts[this.selectedHostIndex].id;
          this.deleteConfirmType = "host";
          this.render();
        }
        break;
      case "n":
        if (e.ctrlKey) { e.preventDefault(); this.openForm(); }
        break;
      case "g":
        if (e.ctrlKey) { e.preventDefault(); this.openAddGroup(); }
        break;
      case "ArrowLeft":
        if (e.altKey) { e.preventDefault(); this.selectAdjacentGroup(-1); }
        break;
      case "ArrowRight":
        if (e.altKey) { e.preventDefault(); this.selectAdjacentGroup(1); }
        break;
      case "F10":
        if (e.shiftKey && this.filteredHosts[this.selectedHostIndex]) {
          e.preventDefault();
          const hostEl = this.container?.querySelector(`.hs-host-item[data-index="${this.selectedHostIndex}"]`);
          if (hostEl) {
            const rect = hostEl.getBoundingClientRect();
            this.contextMenu = {
              type: "host",
              id: this.filteredHosts[this.selectedHostIndex].id,
              x: rect.right - 120,
              y: rect.bottom,
            };
            this.render();
          }
        }
        break;
    }
  }

  private scrollSelectedIntoView() {
    const el = this.container?.querySelector(".hs-host-selected");
    el?.scrollIntoView({ block: "nearest" });
  }

  private selectAdjacentGroup(direction: number) {
    const allGroupIds = [ALL_GROUP_ID, ...this.groups.map((g) => g.id)];
    const currentIdx = allGroupIds.indexOf(this.selectedGroupId);
    const nextIdx = Math.max(0, Math.min(allGroupIds.length - 1, currentIdx + direction));
    if (nextIdx !== currentIdx) {
      this.selectedGroupId = allGroupIds[nextIdx];
      this.selectedHostIndex = 0;
      this.applyFilter();
      this.render();
    }
  }

  // ─── Group Actions ──────────────────────────────────────────────

  private openAddGroup() {
    this.addGroupMode = true;
    this.editingGroupId = null;
    this.render();
  }

  private async saveGroup() {
    const nameInput = document.getElementById("hs-group-name-input") as HTMLInputElement;
    const parentSelect = document.getElementById("hs-group-parent-select") as HTMLSelectElement;
    if (!nameInput) return;

    const name = nameInput.value.trim();
    if (!name) return;

    const parentId = parentSelect?.value || null;

    // If editing, get the existing group data
    let existingColor: string | null = null;
    let existingIcon: string | null = null;
    if (this.editingGroupId) {
      const existing = this.groups.find((g) => g.id === this.editingGroupId);
      if (existing) {
        existingColor = existing.color;
        existingIcon = existing.icon;
      }
    }

    try {
      await saveHostGroup(
        this.editingGroupId, // null = create, string = update
        name,
        parentId,
        existingColor,
        existingIcon,
      );
      this.addGroupMode = false;
      this.editingGroupId = null;
      await this.loadData();
      this.render();
    } catch (e) {
      log.error("host-screen", `Failed to save group: ${e}`);
    }
  }

  private async doDeleteGroup(id: string) {
    try {
      await deleteHostGroup(id);
      this.deleteConfirmId = null;
      if (this.selectedGroupId === id) {
        this.selectedGroupId = ALL_GROUP_ID;
      }
      // Remove from expanded set
      this.expandedGroups.delete(id);
      await this.loadData();
      this.render();
    } catch (e) {
      log.error("host-screen", `Failed to delete group: ${e}`);
    }
  }

  // ─── Move to Group ──────────────────────────────────────────────

  private showMoveToGroup(hostId: string) {
    const host = this.hosts.find((h) => h.id === hostId);
    if (!host) return;

    // Create a quick group picker overlay
    const groups = this.groups;
    const options = groups.map(
      (g) =>
        `<div class="ctx-item" data-group-id="${g.id}">${escHtml(g.name)}</div>`,
    ).join("");

    // Use the context menu position
    const overlay = document.createElement("div");
    overlay.className = "context-menu";
    overlay.id = "hs-move-menu";
    overlay.style.position = "fixed";
    overlay.style.left = `${this.contextMenu?.x ?? 200}px`;
    overlay.style.top = `${this.contextMenu?.y ?? 200}px`;
    overlay.innerHTML = `
      <div class="ctx-item" data-group-id="">— No Group —</div>
      ${options}
    `;
    overlay.querySelectorAll(".ctx-item").forEach((el) => {
      el.addEventListener("click", async () => {
        const gid = (el as HTMLElement).dataset.groupId ?? "";
        const updated = { ...host, group_id: gid || null };
        try {
          await saveHost(updated);
          await this.loadData();
          this.render();
        } catch (e) {
          log.error("host-screen", `Failed to move host: ${e}`);
        }
        overlay.remove();
      });
    });
    document.body.appendChild(overlay);

    // Remove on click outside
    const removeMenu = (e: MouseEvent) => {
      if (!overlay.contains(e.target as Node)) {
        overlay.remove();
        document.removeEventListener("mousedown", removeMenu);
      }
    };
    setTimeout(() => document.addEventListener("mousedown", removeMenu), 10);
  }

  // ─── Host Actions ───────────────────────────────────────────────

  private connectToHost(hostId: string) {
    const host = this.hosts.find((h) => h.id === hostId);
    if (!host) return;
    log.info("host-screen", `Connecting to '${host.display_name}' (${host.hostname}:${host.port})`);
    this.unmount();
    this._onConnect(host);
  }

  private async openForm(editId?: string) {
    if (editId) {
      this.editingHost = this.hosts.find((h) => h.id === editId) ?? null;
      if (this.editingHost) {
        try {
          const cred = await getCredential(this.editingHost.id);
          this.editingHasCredential = cred != null && cred.length > 0;
        } catch {
          this.editingHasCredential = false;
        }
      }
    } else {
      this.editingHost = null;
      this.editingHasCredential = false;
    }
    this.formOpen = true;
    this.render();
    setTimeout(() => {
      (this.container?.querySelector('input[name="display_name"]') as HTMLInputElement)?.focus();
    }, 50);
  }

  private closeForm() {
    this.formOpen = false;
    this.editingHost = null;
    this.editingHasCredential = false;
    this.render();
  }

  private async submitForm(andConnect: boolean) {
    const form = this.container?.querySelector("#hs-host-form") as HTMLFormElement | null;
    if (!form) return;

    const fd = new FormData(form);
    const displayName = (fd.get("display_name") as string)?.trim();
    const hostname = (fd.get("hostname") as string)?.trim();
    const port = parseInt(fd.get("port") as string, 10) || 22;
    const username = (fd.get("username") as string)?.trim();
    const authType = (fd.get("auth_type") as AuthType) ?? "password";
    const password = (fd.get("password") as string) ?? "";
    const sshKeyPath = (fd.get("ssh_key_path") as string)?.trim() || null;
    const platform = (fd.get("platform") as string) ?? "cisco-iosxe";
    const osVersion = (fd.get("os_version") as string)?.trim() || null;
    const notes = (fd.get("notes") as string)?.trim() || null;
    const groupId = (fd.get("group_id") as string)?.trim() || null;
    const tagsRaw = (fd.get("tags") as string) ?? "";
    const tags = tagsRaw.split(",").map((t) => t.trim()).filter((t) => t);

    // Validation
    const errors: string[] = [];
    if (!displayName) errors.push("Display name is required.");
    if (!hostname) errors.push("Hostname is required.");
    if (!username) errors.push("Username is required.");
    if (port < 1 || port > 65535) errors.push("Port must be 1-65535.");

    const errEl = document.getElementById("hs-form-errors");
    if (errors.length) {
      if (errEl) errEl.textContent = errors.join(" ");
      return;
    }

    try {
      const hostData: Partial<Host> = {
        display_name: displayName,
        hostname,
        port,
        username,
        auth_type: authType,
        ssh_key_path: authType === "ssh_key" ? sshKeyPath : null,
        platform,
        os_version: osVersion,
        notes,
        tags,
        group_id: groupId,
      };

      if (this.editingHost) {
        hostData.id = this.editingHost.id;
      }

      const saved = await saveHost(hostData);

      if (authType === "password" && password) {
        await saveCredential(saved.id, password);
      }

      this.hosts = await getHosts();
      this.applyFilter();
      this.closeForm();

      if (andConnect) {
        this.connectToHost(saved.id);
      }
    } catch (err) {
      if (errEl) errEl.textContent = `Save failed: ${err}`;
    }
  }

  private async duplicateHost(hostId: string) {
    const original = this.hosts.find((h) => h.id === hostId);
    if (!original) return;

    try {
      await saveHost({
        display_name: `${original.display_name} (copy)`,
        hostname: original.hostname,
        port: original.port,
        username: original.username,
        auth_type: original.auth_type,
        ssh_key_path: original.ssh_key_path,
        platform: original.platform,
        os_version: original.os_version,
        notes: original.notes,
        tags: original.tags,
        group_id: original.group_id,
      });
      this.hosts = await getHosts();
      this.applyFilter();
      this.render();
    } catch (err) {
      log.error("host-screen", `Duplicate failed: ${err}`);
    }
  }

  private async doDeleteHost(hostId: string) {
    try {
      await deleteHost(hostId);
      this.hosts = await getHosts();
      this.deleteConfirmId = null;
      this.applyFilter();
      this.render();
    } catch (err) {
      log.error("host-screen", `Delete failed: ${err}`);
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────

  private getGroupName(groupId: string): string {
    if (groupId === ALL_GROUP_ID) return "All Hosts";
    return this.groups.find((g) => g.id === groupId)?.name ?? groupId;
  }
}
