/**
 * Connection Manager — home screen
 * Lists saved hosts. Add / edit / delete.
 * Keyboard-first: ↑/↓ navigate, Enter connects, / focuses search, Ctrl+N new host.
 */

import {
  Host,
  AuthType,
  getHosts,
  saveHost,
  deleteHost,
  saveCredential,
  getCredential,
} from "../lib/tauri-api";
import { log } from "../lib/logger";

// ─── Platform display helpers ──────────────────────────────────────

const PLATFORM_META: Record<string, { badge: string; label: string }> = {
  "cisco-iosxe": { badge: "IOS", label: "Cisco IOS-XE — routers, Cat switches, ASR, ISR" },
  "cisco-nxos": { badge: "NXOS", label: "Cisco NX-OS — Nexus data-centre switches" },
  "f5-tmos": { badge: "F5", label: "F5 TMOS — BIG-IP load balancers" },
  "linux-bash": { badge: "BASH", label: "Linux Bash — general-purpose Linux/Unix" },
};

function platformBadge(platform: string): string {
  return PLATFORM_META[platform]?.badge ?? platform.toUpperCase().slice(0, 4);
}

function relativeTime(iso: string | null): string {
  if (!iso) return "Never";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

// ─── Main class ─────────────────────────────────────────────────────

export class ConnectionManager {
  private _onConnect: (host: Host) => void;
  private container: HTMLElement | null = null;
  private hosts: Host[] = [];
  private filteredHosts: Host[] = [];
  private selectedIndex = 0;
  private searchQuery = "";
  private formOpen = false;
  private editingHost: Host | null = null;
  private editingHasCredential = false;
  private contextMenu: { hostId: string; x: number; y: number } | null = null;
  private deleteConfirmId: string | null = null;

  // Bound handler refs for cleanup
  private _keyHandler: ((e: KeyboardEvent) => void) | null = null;
  private _clickOutsideHandler: ((e: MouseEvent) => void) | null = null;

  constructor(onConnect: (host: Host) => void) {
    this._onConnect = onConnect;
  }

  async mount(container: HTMLElement) {
    this.container = container;
    this.hosts = [];
    this.filteredHosts = [];
    this.selectedIndex = 0;

    try {
      this.hosts = await getHosts();
    } catch {
      // Backend not available (dev mode without Tauri) — continue with empty list
    }

    this.applyFilter();
    this.render();
    this.bindGlobalKeys();
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

  // ─── Filtering ──────────────────────────────────────────────────

  private applyFilter() {
    const q = this.searchQuery.toLowerCase().trim();
    if (!q) {
      this.filteredHosts = [...this.hosts].sort((a, b) => a.sort_order - b.sort_order);
    } else {
      this.filteredHosts = this.hosts
        .filter(
          (h) =>
            h.display_name.toLowerCase().includes(q) ||
            h.hostname.toLowerCase().includes(q) ||
            h.username.toLowerCase().includes(q) ||
            h.platform.toLowerCase().includes(q) ||
            (h.notes ?? "").toLowerCase().includes(q),
        )
        .sort((a, b) => a.sort_order - b.sort_order);
    }
    // Clamp selection
    if (this.selectedIndex >= this.filteredHosts.length) {
      this.selectedIndex = Math.max(0, this.filteredHosts.length - 1);
    }
  }

  // ─── Render ─────────────────────────────────────────────────────

  private render() {
    if (!this.container) return;

    const hasHosts = this.hosts.length > 0;
    const countText = this.searchQuery
      ? `${this.filteredHosts.length} of ${this.hosts.length} hosts`
      : `${this.hosts.length} host${this.hosts.length !== 1 ? "s" : ""}`;

    this.container.innerHTML = `
      <div class="connection-manager">
        <div class="cm-header">
          <h1>net.sh</h1>
          <button class="btn-primary" id="new-host-btn">+ New Connection</button>
        </div>
        ${
          hasHosts
            ? `
          <div class="cm-search">
            <input type="text" placeholder="Search hosts… ( / )" id="host-search" value="${this.escAttr(this.searchQuery)}" />
            <span class="cm-host-count">${countText}</span>
          </div>
          <div class="cm-host-list" id="host-list">
            ${this.filteredHosts.map((h, i) => this.renderHostItem(h, i)).join("")}
            ${this.filteredHosts.length === 0 ? '<div class="cm-no-results">No hosts match your search.</div>' : ""}
          </div>`
            : `
          <div class="cm-host-list" id="host-list">
            <div class="cm-empty-state">
              <div class="cm-empty-icon">🖥</div>
              <h2>Welcome to net.sh</h2>
              <p>A smarter SSH client for network engineers.<br/>
              Connect to your devices with context-aware command suggestions built in.</p>
              <button class="btn-primary" id="empty-add-btn">+ Add your first host</button>
              <p class="cm-platforms">Supports: Cisco IOS-XE · NX-OS · F5 TMOS · Linux</p>
              <p class="cm-tip">💡 After connecting, start typing a command and net.sh will suggest completions inline. Press Tab to accept, Ctrl+Space to browse.</p>
            </div>
          </div>`
        }
      </div>
      ${this.formOpen ? this.renderForm() : ""}
      ${this.contextMenu ? this.renderContextMenu() : ""}
      ${this.deleteConfirmId ? this.renderDeleteConfirm() : ""}
    `;

    this.bindEvents();
  }

  private renderHostItem(host: Host, index: number): string {
    const selected = index === this.selectedIndex;
    return `
      <div class="cm-host-item ${selected ? "cm-host-selected" : ""}"
           data-host-id="${host.id}" data-index="${index}">
        <div class="cm-host-badge">[${this.escHtml(platformBadge(host.platform))}]</div>
        <div class="cm-host-info">
          <div class="cm-host-name">${this.escHtml(host.display_name)}</div>
          <div class="cm-host-meta">${this.escHtml(host.hostname)}${host.port !== 22 ? `:${host.port}` : ""} · ${this.escHtml(host.username)}</div>
        </div>
        <div class="cm-host-time">${relativeTime(host.last_connected)}</div>
        <div class="cm-host-dot ${host.last_connected ? "dot-ok" : "dot-never"}" title="${host.last_connected ? "Previously connected" : "Never connected"}"></div>
      </div>`;
  }

  // ─── Form ───────────────────────────────────────────────────────

  private renderForm(): string {
    const h = this.editingHost;
    const title = h ? "Edit Host" : "New Connection";
    const platforms = Object.entries(PLATFORM_META);

    return `
      <div class="modal-backdrop" id="form-backdrop">
        <div class="modal-panel host-form">
          <h2>${title}</h2>
          <form id="host-form" autocomplete="off">
            <label>
              <span>Display Name <em>*</em></span>
              <input type="text" name="display_name" required placeholder="e.g. Core Router - LON"
                     value="${this.escAttr(h?.display_name ?? "")}" />
            </label>
            <label>
              <span>Hostname / IP <em>*</em></span>
              <input type="text" name="hostname" required placeholder="e.g. 192.168.1.1 or router.example.com"
                     value="${this.escAttr(h?.hostname ?? "")}" />
            </label>
            <label>
              <span>Port</span>
              <input type="number" name="port" min="1" max="65535" placeholder="22"
                     value="${h?.port ?? 22}" />
            </label>
            <label>
              <span>Username <em>*</em></span>
              <input type="text" name="username" required placeholder="admin"
                     value="${this.escAttr(h?.username ?? "")}" />
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
            <div id="auth-password-field" class="auth-conditional"
                 style="display:${(!h || h.auth_type === "password") ? "block" : "none"}">
              <label>
                <span>Password</span>
                <input type="password" name="password"
                       placeholder="${h && this.editingHasCredential ? "Password saved — leave blank to keep" : "Enter password"}" />
              </label>${h && this.editingHasCredential ? `
              <div class="form-hint">A password is stored for this host.</div>` : ""}
            </div>
            <div id="auth-key-field" class="auth-conditional"
                 style="display:${h?.auth_type === "ssh_key" ? "block" : "none"}">
              <label>
                <span>SSH Key Path</span>
                <input type="text" name="ssh_key_path" placeholder="~/.ssh/id_rsa"
                       value="${this.escAttr(h?.ssh_key_path ?? "")}" />
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
                     value="${this.escAttr(h?.os_version ?? "")}" />
            </label>
            <label>
              <span>Notes</span>
              <textarea name="notes" rows="3" placeholder="Optional notes">${this.escHtml(h?.notes ?? "")}</textarea>
            </label>
            <div class="form-actions">
              <button type="button" class="btn-text" id="form-cancel">Cancel</button>
              <button type="button" class="btn-secondary" id="form-save">Save</button>
              <button type="submit" class="btn-primary" id="form-save-connect">Save & Connect</button>
            </div>
            <div class="form-errors" id="form-errors"></div>
          </form>
        </div>
      </div>`;
  }

  // ─── Context menu ───────────────────────────────────────────────

  private renderContextMenu(): string {
    if (!this.contextMenu) return "";
    return `
      <div class="context-menu" id="context-menu"
           style="left:${this.contextMenu.x}px;top:${this.contextMenu.y}px">
        <div class="ctx-item" data-action="connect">Connect</div>
        <div class="ctx-item" data-action="edit">Edit</div>
        <div class="ctx-item" data-action="duplicate">Duplicate</div>
        <div class="ctx-divider"></div>
        <div class="ctx-item ctx-danger" data-action="delete">Delete</div>
      </div>`;
  }

  // ─── Delete confirm ─────────────────────────────────────────────

  private renderDeleteConfirm(): string {
    const host = this.hosts.find((h) => h.id === this.deleteConfirmId);
    if (!host) return "";
    return `
      <div class="modal-backdrop" id="delete-backdrop">
        <div class="modal-panel delete-confirm">
          <h3>Delete Host</h3>
          <p>Delete <strong>${this.escHtml(host.display_name)}</strong>? This cannot be undone.</p>
          <div class="form-actions">
            <button class="btn-text" id="delete-cancel">Cancel</button>
            <button class="btn-danger" id="delete-confirm">Delete</button>
          </div>
        </div>
      </div>`;
  }

  // ─── Event binding ──────────────────────────────────────────────

  private bindEvents() {
    if (!this.container) return;

    // New host buttons
    this.container.querySelector("#new-host-btn")?.addEventListener("click", () => this.openForm());
    this.container.querySelector("#empty-add-btn")?.addEventListener("click", () => this.openForm());

    // Search
    const searchInput = this.container.querySelector("#host-search") as HTMLInputElement | null;
    if (searchInput) {
      searchInput.addEventListener("input", () => {
        this.searchQuery = searchInput.value;
        this.applyFilter();
        this.render();
        // Re-focus search after render
        (this.container?.querySelector("#host-search") as HTMLInputElement)?.focus();
      });
    }

    // Host items — click, double-click, right-click
    this.container.querySelectorAll(".cm-host-item").forEach((el) => {
      el.addEventListener("click", () => {
        this.selectedIndex = parseInt((el as HTMLElement).dataset.index ?? "0", 10);
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
        this.selectedIndex = parseInt((el as HTMLElement).dataset.index ?? "0", 10);
        this.contextMenu = { hostId: id, x: me.clientX, y: me.clientY };
        this.render();
      });
    });

    // Context menu actions
    this.container.querySelectorAll(".ctx-item").forEach((el) => {
      el.addEventListener("click", () => {
        const action = (el as HTMLElement).dataset.action;
        const hostId = this.contextMenu?.hostId;
        this.contextMenu = null;
        if (!hostId) return;
        switch (action) {
          case "connect":
            this.connectToHost(hostId);
            break;
          case "edit":
            this.openForm(hostId);
            break;
          case "duplicate":
            this.duplicateHost(hostId);
            break;
          case "delete":
            this.deleteConfirmId = hostId;
            this.render();
            break;
        }
      });
    });

    // Click outside context menu dismisses it
    if (this._clickOutsideHandler) {
      document.removeEventListener("mousedown", this._clickOutsideHandler);
    }
    this._clickOutsideHandler = (e: MouseEvent) => {
      if (this.contextMenu) {
        const menuEl = this.container?.querySelector("#context-menu");
        if (menuEl && !menuEl.contains(e.target as Node)) {
          this.contextMenu = null;
          this.render();
        }
      }
    };
    document.addEventListener("mousedown", this._clickOutsideHandler);

    // Form events
    this.bindFormEvents();

    // Delete confirm events
    this.container.querySelector("#delete-cancel")?.addEventListener("click", () => {
      this.deleteConfirmId = null;
      this.render();
    });
    this.container.querySelector("#delete-confirm")?.addEventListener("click", () => {
      if (this.deleteConfirmId) this.doDelete(this.deleteConfirmId);
    });
    this.container.querySelector("#delete-backdrop")?.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).id === "delete-backdrop") {
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
        const pwField = this.container?.querySelector("#auth-password-field") as HTMLElement | null;
        const keyField = this.container?.querySelector("#auth-key-field") as HTMLElement | null;
        if (pwField) pwField.style.display = val === "password" ? "block" : "none";
        if (keyField) keyField.style.display = val === "ssh_key" ? "block" : "none";
      });
    });

    // Cancel
    this.container.querySelector("#form-cancel")?.addEventListener("click", () => this.closeForm());
    this.container.querySelector("#form-backdrop")?.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).id === "form-backdrop") this.closeForm();
    });

    // Save
    this.container.querySelector("#form-save")?.addEventListener("click", () => this.submitForm(false));
    // Save & Connect
    this.container.querySelector("#host-form")?.addEventListener("submit", (e) => {
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
    // If a form/modal is open, let form handle keys
    if (this.formOpen) {
      if (e.key === "Escape") {
        e.preventDefault();
        this.closeForm();
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

    const isSearchFocused = document.activeElement?.id === "host-search";

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (this.filteredHosts.length > 0) {
          this.selectedIndex = Math.min(this.selectedIndex + 1, this.filteredHosts.length - 1);
          this.render();
          if (isSearchFocused) {
            (this.container?.querySelector("#host-search") as HTMLInputElement)?.focus();
          }
          this.scrollSelectedIntoView();
        }
        break;
      case "ArrowUp":
        e.preventDefault();
        if (this.filteredHosts.length > 0) {
          this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
          this.render();
          if (isSearchFocused) {
            (this.container?.querySelector("#host-search") as HTMLInputElement)?.focus();
          }
          this.scrollSelectedIntoView();
        }
        break;
      case "Enter":
        if (!isSearchFocused && this.filteredHosts[this.selectedIndex]) {
          e.preventDefault();
          this.connectToHost(this.filteredHosts[this.selectedIndex].id);
        }
        break;
      case "/":
        if (!isSearchFocused) {
          e.preventDefault();
          (this.container?.querySelector("#host-search") as HTMLInputElement)?.focus();
        }
        break;
      case "Escape":
        if (isSearchFocused) {
          e.preventDefault();
          if (this.searchQuery) {
            this.searchQuery = "";
            this.applyFilter();
            this.render();
            (this.container?.querySelector("#host-search") as HTMLInputElement)?.focus();
          } else {
            (this.container?.querySelector("#host-search") as HTMLInputElement)?.blur();
          }
        }
        break;
      case "Delete":
      case "Backspace":
        if (!isSearchFocused && this.filteredHosts[this.selectedIndex]) {
          e.preventDefault();
          this.deleteConfirmId = this.filteredHosts[this.selectedIndex].id;
          this.render();
        }
        break;
      case "n":
        if (e.ctrlKey) {
          e.preventDefault();
          this.openForm();
        }
        break;
      case "F10":
        if (e.shiftKey && this.filteredHosts[this.selectedIndex]) {
          e.preventDefault();
          // Position context menu near the selected item
          const hostEl = this.container?.querySelector(`.cm-host-item[data-index="${this.selectedIndex}"]`);
          if (hostEl) {
            const rect = hostEl.getBoundingClientRect();
            this.contextMenu = {
              hostId: this.filteredHosts[this.selectedIndex].id,
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
    const el = this.container?.querySelector(".cm-host-selected");
    el?.scrollIntoView({ block: "nearest" });
  }

  // ─── Actions ────────────────────────────────────────────────────

  private connectToHost(hostId: string) {
    const host = this.hosts.find((h) => h.id === hostId);
    if (!host) return;
    log.info("connmgr", `Connecting to '${host.display_name}' (${host.hostname}:${host.port})`);
    this.unmount();
    this._onConnect(host);
  }

  private async openForm(editId?: string) {
    if (editId) {
      this.editingHost = this.hosts.find((h) => h.id === editId) ?? null;
      // Check if a credential is already stored for this host
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
    // Focus first field
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
    const form = this.container?.querySelector("#host-form") as HTMLFormElement | null;
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

    // Validation
    const errors: string[] = [];
    if (!displayName) errors.push("Display name is required.");
    if (!hostname) errors.push("Hostname is required.");
    if (!username) errors.push("Username is required.");
    if (port < 1 || port > 65535) errors.push("Port must be 1-65535.");

    const errEl = this.container?.querySelector("#form-errors") as HTMLElement | null;
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
      };

      if (this.editingHost) {
        hostData.id = this.editingHost.id;
      }

      const saved = await saveHost(hostData);

      // Save credential if password auth
      if (authType === "password" && password) {
        await saveCredential(saved.id, password);
      }

      // Refresh host list
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
      });
      this.hosts = await getHosts();
      this.applyFilter();
      this.render();
    } catch (err) {
      log.error("connmgr", `Duplicate failed: ${err}`);
    }
  }

  private async doDelete(hostId: string) {
    try {
      await deleteHost(hostId);
      this.hosts = await getHosts();
      this.deleteConfirmId = null;
      this.applyFilter();
      this.render();
    } catch (err) {
      log.error("connmgr", `Delete failed: ${err}`);
    }
  }

  // ─── Util ───────────────────────────────────────────────────────

  private escHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  private escAttr(s: string): string {
    return this.escHtml(s).replace(/'/g, "&#39;");
  }
}
