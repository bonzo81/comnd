/**
 * Host Screen — "Recent Sessions" content area.
 *
 * Lists recently connected hosts (last_connected desc).
 * The group tree with hosts now lives in the nav panel.
 * Keeps: host form modal, delete confirm, context menu, connect flow.
 */

import {
  Host,
  HostGroup,
  getHosts,
  saveHost,
  deleteHost,
  saveCredential,
  getCredential,
  getHostGroups,
  agentListIdentities,
  listProviders,
  listCredentials,
  type AgentIdentity,
  type CredentialItem,
  type ProviderInfo,
} from "../lib/tauri-api";
import { log, LogTag } from "../lib/logger";
import { PLATFORM_META, platformBadge, platformColorClass } from "../lib/platforms";
import { escAttr, escHtml, relativeTime } from "../lib/format";
import { ALL_GROUP_ID, recentHosts, isNetboxHostId } from "../lib/host-filters";
import { icons } from "../lib/icons";
import { initContextMenu } from "../lib/a11y";
import { showToast } from "../lib/toast";
import { NetBoxConfigureDialog } from "./netbox-configure-dialog";

/** Display names for secret-manager providers (fallback to raw id). */
const PROVIDER_NAMES: Record<string, string> = { proton: "Proton Pass" };

// ─── Main Class ────────────────────────────────────────────────────

export class HostScreen {
  private _onConnect: (host: Host) => void;
  private _getActiveSessions: () => Set<string>;
  private container: HTMLElement | null = null;

  // Data
  private hosts: Host[] = [];
  private groups: HostGroup[] = [];
  private recent: Host[] = [];

  // Selection
  private selectedHostIndex = 0;

  // UI state
  private formOpen = false;
  private editingHost: Host | null = null;
  private editingHasCredential = false;
  private agentIdentities: AgentIdentity[] = [];
  private agentStatus: string | null = null;
  private readyProviders: ProviderInfo[] = [];
  private secretRefLabel: string | null = null;

  // Secret-ref combobox (chunk 15) — in-place DOM, never a full re-render.
  private comboOpen = false;
  private comboItems: CredentialItem[] = [];
  private comboFiltered: CredentialItem[] = [];
  private comboIndex = 0;
  private comboNavigated = false;
  private comboLoading = false;
  private comboError: string | null = null;
  private comboProvider: string | null = null;
  // Item picked from the combobox — input shows its label, we store its id.
  private comboSelection: CredentialItem | null = null;
  private editingGroupId: string | null = null;
  private pendingGroupId: string | null = null;
  private contextMenu: { type: "host" | "group"; id: string; x: number; y: number } | null = null;
  private deleteConfirmId: string | null = null;
  private deleteConfirmType: "host" | "group" = "host";

  // Bound handler refs
  private _keyHandler: ((e: KeyboardEvent) => void) | null = null;
  private _clickOutsideHandler: ((e: MouseEvent) => void) | null = null;

  constructor(
    onConnect: (host: Host) => void,
    getActiveSessions: () => Set<string>,
  ) {
    this._onConnect = onConnect;
    this._getActiveSessions = getActiveSessions;
  }

  async mount(container: HTMLElement) {
    this.container = container;
    await this.loadData();
    this.render();
    this.bindGlobalKeys();
  }

  /** Re-render the recents list (e.g., after returning from a detached session). */
  async refresh() {
    await this.loadData();
    this.render();
    // connectToHost() unmounts key handlers; rebind on return
    this.bindGlobalKeys();
  }

  /** Select a host (driven by the nav panel). */
  selectHost(hostId: string) {
    const idx = this.recent.findIndex((h) => h.id === hostId);
    if (idx >= 0) {
      this.selectedHostIndex = idx;
      this.render();
    }
  }

  /** Open the new-connection form (driven by the nav panel). */
  openNewConnection() {
    void this.openForm();
  }

  /** Open the new-connection form pre-scoped to a group (driven by the nav panel). */
  openAddHost(groupId: string) {
    this.pendingGroupId = groupId === ALL_GROUP_ID ? null : groupId;
    void this.openForm();
  }

  /** Open the edit form for an existing host (driven by the nav panel). */
  openEditHost(hostId: string) {
    this.pendingGroupId = null;
    void this.openForm(hostId);
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
    this.groups.sort((a, b) => a.sort_order - b.sort_order);
    this.recent = recentHosts(this.hosts);
    if (this.selectedHostIndex >= this.recent.length) {
      this.selectedHostIndex = Math.max(0, this.recent.length - 1);
    }
  }

  // ─── Render ──────────────────────────────────────────────────────

  private render() {
    if (!this.container) return;

    const countText = `${this.recent.length} recent session${this.recent.length !== 1 ? "s" : ""}`;

    this.container.innerHTML = `
      <div class="host-screen">
        <div class="hs-host-panel">
          <div class="hs-search">
            <span class="hs-recent-title">Recent Sessions</span>
            <span class="hs-host-count">${countText}</span>
          </div>

          <div class="hs-host-list" id="hs-host-list" role="listbox" aria-label="Recent sessions">
            ${this.recent.length > 0 ? this.renderHostList() : this.renderEmptyState()}
          </div>
        </div>
      </div>

      ${this.formOpen ? this.renderForm() : ""}
      ${this.contextMenu ? this.renderContextMenu() : ""}
      ${this.deleteConfirmId ? this.renderDeleteConfirm() : ""}
    `;

    this.bindEvents();
  }

  private renderHostList(): string {
    return this.recent
      .map((h, i) => this.renderHostItem(h, i))
      .join("");
  }

  private renderHostItem(host: Host, index: number): string {
    const selected = index === this.selectedHostIndex;
    const tags = host.tags ?? [];
    const active = this._getActiveSessions().has(host.id);

    return `
      <div class="hs-host-item ${selected ? "hs-host-selected" : ""}"
           data-host-id="${host.id}" data-index="${index}"
           role="option" tabindex="0" aria-selected="${selected}"
           aria-label="${escAttr(host.display_name)} — ${escAttr(host.username)}@${escAttr(host.hostname)}${host.port !== 22 ? `:${host.port}` : ""}${active ? " (session active)" : ""}">
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
            ${host.credential?.type === "secret_ref" ? `<span class="hs-meta-sep">·</span><span class="hs-meta-secretref">${escHtml(host.credential.label ?? host.credential.reference)} · ${escHtml(this.providerName(host.credential.provider))}</span>` : ""}
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
        <div class="cm-empty-icon">${icons.monitor}</div>
        <h2>No recent sessions</h2>
        <p>Connect to a host to see it here.</p>
      </div>
    `;
  }

  // ─── Host Form ───────────────────────────────────────────────────

  private renderForm(): string {
    const h = this.editingHost;
    const title = h ? "Edit Host" : "New Connection";
    const platforms = Object.entries(PLATFORM_META);
    const cred = h?.credential;
    const isAgent = !!(cred && cred.type === "agent");
    const agentIdentityValue = cred && cred.type === "agent" ? (cred.identity ?? "") : "";
    const isSecretRef = !!(cred && cred.type === "secret_ref");
    const secretRefProvider = cred && cred.type === "secret_ref" ? cred.provider : "";
    const secretRefReference = cred && cred.type === "secret_ref" ? cred.reference : "";

    return `
      <div class="modal-backdrop" id="hs-form-backdrop">
        <div class="modal-panel host-form" role="dialog" aria-modal="true" aria-labelledby="hs-form-title">
          <h2 id="hs-form-title">${title}</h2>
          <form id="hs-host-form" autocomplete="off">
            <label>
              <span>Display Name <em>*</em></span>
              <input type="text" class="form-input" name="display_name" required placeholder="e.g. Core Router - LON"
                     value="${escAttr(h?.display_name ?? "")}" />
            </label>
            <label>
              <span>Hostname / IP <em>*</em></span>
              <input type="text" class="form-input" name="hostname" required placeholder="e.g. 192.168.1.1 or router.example.com"
                     value="${escAttr(h?.hostname ?? "")}" />
            </label>
            <label>
              <span>Port</span>
              <input type="number" class="form-input" name="port" min="1" max="65535" placeholder="22"
                     value="${h?.port ?? 22}" />
            </label>
            <label>
              <span>Username <em>*</em></span>
              <input type="text" class="form-input" name="username" required placeholder="admin"
                     value="${escAttr(h?.username ?? "")}" />
            </label>

            <!-- Group -->
            <label>
              <span>Group</span>
              <select class="form-input" name="group_id">
                <option value="">— No Group —</option>
                ${this.groups.map((g) => `<option value="${g.id}" ${h?.group_id === g.id ? "selected" : ""}>${escHtml(g.name)}</option>`).join("")}
              </select>
            </label>

            <!-- Tags -->
            <label>
              <span>Tags (comma-separated)</span>
              <input type="text" class="form-input" name="tags" placeholder="e.g. core, london, production"
                     value="${escAttr((h?.tags ?? []).join(", "))}" />
            </label>

            <fieldset class="form-auth-group">
              <legend>Authentication</legend>
              <label class="radio-label">
                <input type="radio" name="auth_type" value="password"
                       ${(!h || !h.credential || h.credential.type === "password") ? "checked" : ""} />
                Password
              </label>
              <label class="radio-label">
                <input type="radio" name="auth_type" value="ssh_key"
                       ${h?.credential?.type === "ssh_key" ? "checked" : ""} />
                SSH Key
              </label>
              <label class="radio-label">
                <input type="radio" name="auth_type" value="agent"
                       ${isAgent ? "checked" : ""} />
                SSH Agent
              </label>
              <label class="radio-label">
                <input type="radio" name="auth_type" value="secret_ref"
                       ${isSecretRef ? "checked" : ""} />
                Secret Manager
              </label>
            </fieldset>
            <div id="hs-auth-password-field" class="auth-conditional ${(!h || !h.credential || h.credential.type === "password") ? "" : "auth-conditional-hidden"}">
              <label>
                <span>Password ${h && this.editingHasCredential ? `<span class="cred-badge">${icons.lock} Password saved</span>` : ""}</span>
                <input type="password" class="form-input" name="password"
                       placeholder="${h && this.editingHasCredential ? "Leave blank to keep saved password" : "Enter password"}" />
              </label>
            </div>
            <div id="hs-auth-key-field" class="auth-conditional ${h?.credential?.type === "ssh_key" ? "" : "auth-conditional-hidden"}">
              <label>
                <span>SSH Key Path</span>
              <input type="text" class="form-input" name="ssh_key_path" placeholder="~/.ssh/id_rsa"
                     value="${escAttr(h?.credential?.type === "ssh_key" ? h.credential.key_path : "")}" />
              </label>
            </div>
            <div id="hs-auth-agent-field" class="auth-conditional ${isAgent ? "" : "auth-conditional-hidden"}">
              <label>
                <span>Identity</span>
                <select class="form-input" name="agent_identity">
                  <option value="" ${agentIdentityValue === "" ? "selected" : ""}>Offer all identities</option>
                  ${this.agentIdentities.map((id) => `<option value="${escAttr(id.fingerprint)}" ${agentIdentityValue === id.fingerprint ? "selected" : ""}>${escHtml(this.agentIdentityLabel(id))}</option>`).join("")}
                </select>
              </label>
              <div class="form-hint">The agent offers only this key at login. "Offer all" sends every loaded key in turn. Devices with login limits can block you after repeated failures.</div>
              ${this.agentStatus ? `<div class="form-hint">${escHtml(this.agentStatus)}</div>` : ""}
            </div>
            <div id="hs-auth-secretref-field" class="auth-conditional auth-conditional-tall ${isSecretRef ? "" : "auth-conditional-hidden"}">
              <label>
                <span>Provider</span>
                <select class="form-input" name="secret_ref_provider">
                  ${this.secretRefProviderOptions(isSecretRef, secretRefProvider)}
                </select>
              </label>
              ${this.readyProviders.length === 0 ? `<div class="form-hint">No secret managers ready — enable one in Settings → Auth Integrations.</div>` : ""}
              <div class="hs-ref-combo" id="hs-ref-combo-wrap">
                <label>
                  <span>Reference</span>
                  <input type="text" class="form-input" name="secret_ref_reference" placeholder="Search or paste item reference"
                         spellcheck="false" autocomplete="off"
                         value="${escAttr(secretRefReference)}" />
                </label>
                <div class="hs-ref-combo-list" id="hs-ref-combo-list"></div>
              </div>
            </div>
            <label>
              <span>Platform <em>*</em></span>
              <select class="form-input" name="platform" required>
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
              <input type="text" class="form-input" name="os_version" placeholder="e.g. 17.6 — Leave blank to show all commands"
                     value="${escAttr(h?.os_version ?? "")}" />
            </label>
            <label>
              <span>Syntax Highlighting</span>
              <select class="form-input" name="highlight_profile">
                <option value="auto" ${(!h?.highlight_profile || h?.highlight_profile === "auto") ? "selected" : ""}>Auto (use platform)</option>
                <option value="cisco-iosxe" ${h?.highlight_profile === "cisco-iosxe" ? "selected" : ""}>Cisco IOS-XE</option>
                <option value="cisco-nxos" ${h?.highlight_profile === "cisco-nxos" ? "selected" : ""}>Cisco NX-OS</option>
                <option value="f5-tmos" ${h?.highlight_profile === "f5-tmos" ? "selected" : ""}>F5 TMOS</option>
                <option value="linux-bash" ${h?.highlight_profile === "linux-bash" ? "selected" : ""}>Linux Bash</option>
                <option value="none" ${h?.highlight_profile === "none" ? "selected" : ""}>Off (no highlighting)</option>
              </select>
            </label>
            <label>
              <span>Notes</span>
              <textarea class="form-input" name="notes" rows="3" placeholder="Optional notes">${escHtml(h?.notes ?? "")}</textarea>
            </label>
            <div class="form-actions">
              <button type="button" class="btn-text" id="hs-form-cancel">Cancel</button>
              <button type="button" class="btn-secondary" id="hs-form-save">Save</button>
              <button type="submit" class="btn-primary" id="hs-form-save-connect">Save & Connect</button>
            </div>
            <div class="form-errors" id="hs-form-errors" role="alert"></div>
          </form>
        </div>
      </div>`;
  }

  // ─── Context Menu ────────────────────────────────────────────────

  private renderContextMenu(): string {
    if (!this.contextMenu) return "";
    const host = this.hosts.find((h) => h.id === this.contextMenu!.id);
    if (host && isNetboxHostId(host.id)) {
      return `
        <div class="context-menu" id="hs-context-menu"
             style="left:${this.contextMenu.x}px;top:${this.contextMenu.y}px">
          <div class="ctx-item" data-action="connect">Connect</div>
          <div class="ctx-item" data-action="configure">Configure</div>
        </div>`;
    }
    return `
      <div class="context-menu" id="hs-context-menu"
           style="left:${this.contextMenu.x}px;top:${this.contextMenu.y}px">
        <div class="ctx-item" data-action="connect">Connect</div>
        <div class="ctx-item" data-action="edit">Edit</div>
        <div class="ctx-item" data-action="duplicate">Duplicate</div>
        <div class="ctx-divider"></div>
        <div class="ctx-item ctx-danger" data-action="delete">Delete</div>
      </div>`;
  }

  // ─── Delete Confirm ──────────────────────────────────────────────

  private renderDeleteConfirm(): string {
    const host = this.hosts.find((h) => h.id === this.deleteConfirmId);
    if (!host) return "";
    return `
      <div class="modal-backdrop" id="hs-delete-backdrop">
        <div class="modal-panel delete-confirm" role="dialog" aria-modal="true" aria-labelledby="hs-delete-title">
          <h3 id="hs-delete-title">Delete Host</h3>
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
          case "configure":
            void new NetBoxConfigureDialog(ctx.id, async () => {
              this.hosts = await getHosts();
              this.recent = recentHosts(this.hosts);
              this.render();
            }).open();
            break;
          case "duplicate":
            this.duplicateHost(ctx.id);
            break;
          case "delete":
            this.deleteConfirmId = ctx.id;
            this.deleteConfirmType = "host";
            this.render();
            break;
        }
      });
    });

    // Context menu ARIA + keyboard navigation (arrows/Enter/Escape)
    const ctxMenu = this.container.querySelector("#hs-context-menu");
    if (ctxMenu) {
      initContextMenu(ctxMenu as HTMLElement, () => {
        this.contextMenu = null;
        this.render();
      });
    }

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
        this.doDeleteHost(this.deleteConfirmId);
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
        const agentField = document.getElementById("hs-auth-agent-field");
        const refField = document.getElementById("hs-auth-secretref-field");
        if (pwField) pwField.classList.toggle("auth-conditional-hidden", val !== "password");
        if (keyField) keyField.classList.toggle("auth-conditional-hidden", val !== "ssh_key");
        if (agentField) agentField.classList.toggle("auth-conditional-hidden", val !== "agent");
        if (refField) refField.classList.toggle("auth-conditional-hidden", val !== "secret_ref");
      });
    });

    // Secret manager: reference combobox, invalidate cached label on edit
    (this.container.querySelector('select[name="secret_ref_provider"]') as HTMLSelectElement | null)?.addEventListener("change", () => {
      this.closeCombo();
      this.comboProvider = null; // cached items belong to the old provider
      this.comboSelection = null;
    });
    const refInput = this.container.querySelector('input[name="secret_ref_reference"]') as HTMLInputElement | null;
    if (refInput) {
      refInput.addEventListener("focus", () => this.openCombo(refInput));
      refInput.addEventListener("input", () => {
        this.secretRefLabel = null;
        this.comboSelection = null; // text edited — treat as manual reference
        this.comboNavigated = false;
        this.openCombo(refInput);
      });
      refInput.addEventListener("keydown", (e) => this.handleComboKey(e, refInput));
    }

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

    // Ignore keys when focus is in the nav panel (it handles its own keys)
    const ae = document.activeElement;
    if (ae instanceof HTMLElement && ae !== document.body) {
      if (!this.container?.contains(ae)) return;
    }

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (this.recent.length > 0) {
          this.selectedHostIndex = Math.min(this.selectedHostIndex + 1, this.recent.length - 1);
          this.render();
          this.scrollSelectedIntoView();
          this.focusHostItem();
        }
        break;
      case "ArrowUp":
        e.preventDefault();
        if (this.recent.length > 0) {
          this.selectedHostIndex = Math.max(this.selectedHostIndex - 1, 0);
          this.render();
          this.scrollSelectedIntoView();
          this.focusHostItem();
        }
        break;
      case "Enter":
        if (this.recent[this.selectedHostIndex]) {
          e.preventDefault();
          this.connectToHost(this.recent[this.selectedHostIndex].id);
        }
        break;
      case "Delete":
      case "Backspace":
        if (this.recent[this.selectedHostIndex]) {
          e.preventDefault();
          this.deleteConfirmId = this.recent[this.selectedHostIndex].id;
          this.deleteConfirmType = "host";
          this.render();
        }
        break;
      case "n":
        if (e.ctrlKey) { e.preventDefault(); this.openForm(); }
        break;
      case "F10":
        if (e.shiftKey && this.recent[this.selectedHostIndex]) {
          e.preventDefault();
          const hostEl = this.container?.querySelector(`.hs-host-item[data-index="${this.selectedHostIndex}"]`);
          if (hostEl) {
            const rect = hostEl.getBoundingClientRect();
            this.contextMenu = {
              type: "host",
              id: this.recent[this.selectedHostIndex].id,
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

  /** Keep keyboard focus on the selection after an arrow-key re-render. */
  private focusHostItem() {
    const el = this.container?.querySelector<HTMLElement>(
      `.hs-host-item[data-index="${this.selectedHostIndex}"]`,
    );
    el?.focus({ preventScroll: true });
  }

  // ─── Host Actions ───────────────────────────────────────────────

  private connectToHost(hostId: string) {
    const host = this.hosts.find((h) => h.id === hostId);
    if (!host) return;
    log.info(LogTag.HostScreen, `Connecting to '${host.display_name}' (${host.hostname}:${host.port})`);
    this.unmount();
    this._onConnect(host);
  }

  private async openForm(editId?: string) {
    if (editId && isNetboxHostId(editId)) {
      log.warn(LogTag.Netbox, `Guard: form open blocked on NetBox host ${editId}`);
      showToast("NetBox hosts are managed by the NetBox integration — use Configure", "info");
      return;
    }
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
    await Promise.all([this.loadAgentIdentities(), this.loadReadyProviders()]);
    this.secretRefLabel = null;
    this.formOpen = true;
    this.render();
    setTimeout(() => {
      if (this.pendingGroupId) {
        const sel = this.container?.querySelector('select[name="group_id"]') as HTMLSelectElement | null;
        if (sel) sel.value = this.pendingGroupId;
        this.pendingGroupId = null;
      }
      (this.container?.querySelector('input[name="display_name"]') as HTMLInputElement)?.focus();
    }, 50);
  }

  private async loadAgentIdentities() {
    try {
      this.agentIdentities = await agentListIdentities();
      this.agentStatus = this.agentIdentities.length === 0
        ? "Agent found — no identities loaded. Run ssh-add to add a key."
        : null;
    } catch (err) {
      this.agentIdentities = [];
      log.warn(LogTag.HostScreen, `Agent identity probe failed: ${err}`);
      this.agentStatus = "No SSH agent detected. Start an SSH agent. Add a key with ssh-add.";
    }
  }

  private closeForm() {
    this.formOpen = false;
    this.editingHost = null;
    this.editingHasCredential = false;
    this.agentIdentities = [];
    this.agentStatus = null;
    this.readyProviders = [];
    this.secretRefLabel = null;
    this.closeCombo();
    this.comboItems = [];
    this.comboFiltered = [];
    this.comboIndex = 0;
    this.comboNavigated = false;
    this.comboLoading = false;
    this.comboError = null;
    this.comboProvider = null;
    this.comboSelection = null;
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
    const authType = (fd.get("auth_type") as string) ?? "password";
    const password = (fd.get("password") as string) ?? "";
    const sshKeyPath = (fd.get("ssh_key_path") as string)?.trim() || null;
    const secretRefProvider = (fd.get("secret_ref_provider") as string)?.trim() || "";
    const secretRefInput = (fd.get("secret_ref_reference") as string)?.trim();
    // Combobox shows the item name; store the real reference id for it.
    const secretRefReference = this.comboSelection && secretRefInput === this.comboSelection.label
      ? this.comboSelection.id
      : secretRefInput;
    const platform = (fd.get("platform") as string) ?? "cisco-iosxe";
    const osVersion = (fd.get("os_version") as string)?.trim() || null;
    const highlightProfile = (fd.get("highlight_profile") as string)?.trim() || null;
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
    if (authType === "secret_ref" && !secretRefProvider) errors.push("Select a secret manager provider.");
    if (authType === "secret_ref" && !secretRefReference) errors.push("Secret reference is required.");

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
        platform,
        os_version: osVersion,
        highlight_profile: highlightProfile,
        notes,
        tags,
        group_id: groupId,
        credential:
          authType === "ssh_key"
            ? { type: "ssh_key", key_path: sshKeyPath ?? "" }
            : authType === "agent"
              ? { type: "agent", identity: (fd.get("agent_identity") as string) || null }
              : authType === "secret_ref"
                ? { type: "secret_ref", provider: secretRefProvider, reference: secretRefReference ?? "", label: this.secretRefLabel }
                : { type: "password" },
      };

      if (this.editingHost) {
        hostData.id = this.editingHost.id;
      }

      const saved = await saveHost(hostData);

      if (authType === "password" && password) {
        await saveCredential(saved.id, password);
      }

      this.hosts = await getHosts();
      this.recent = recentHosts(this.hosts);
      this.closeForm();

      if (andConnect) {
        this.connectToHost(saved.id);
      }
    } catch (err) {
      if (errEl) errEl.textContent = `Save failed: ${err}`;
    }
  }

  private async duplicateHost(hostId: string) {
    if (isNetboxHostId(hostId)) {
      log.warn(LogTag.Netbox, `Guard: duplicate blocked on NetBox host ${hostId}`);
      showToast("NetBox hosts are managed by the NetBox integration — use Configure", "info");
      return;
    }
    const original = this.hosts.find((h) => h.id === hostId);
    if (!original) return;

    try {
      await saveHost({
        display_name: `${original.display_name} (copy)`,
        hostname: original.hostname,
        port: original.port,
        username: original.username,
        credential: original.credential,
        platform: original.platform,
        os_version: original.os_version,
        highlight_profile: original.highlight_profile,
        notes: original.notes,
        tags: original.tags,
        group_id: original.group_id,
      });
      this.hosts = await getHosts();
      this.recent = recentHosts(this.hosts);
      this.render();
    } catch (err) {
      log.error(LogTag.HostScreen, `Duplicate failed: ${err}`);
    }
  }

  private async doDeleteHost(hostId: string) {
    if (isNetboxHostId(hostId)) {
      log.warn(LogTag.Netbox, `Guard: delete blocked on NetBox host ${hostId}`);
      showToast("NetBox hosts are managed by the NetBox integration — disable it in Settings → NetBox", "info");
      this.deleteConfirmId = null;
      this.render();
      return;
    }
    try {
      await deleteHost(hostId);
      this.hosts = await getHosts();
      this.deleteConfirmId = null;
      this.recent = recentHosts(this.hosts);
      this.render();
    } catch (err) {
      log.error(LogTag.HostScreen, `Delete failed: ${err}`);
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────

  private getGroupName(groupId: string): string {
    return this.groups.find((g) => g.id === groupId)?.name ?? groupId;
  }

  private agentIdentityLabel(id: AgentIdentity): string {
    const short = id.fingerprint.length > 16 ? `${id.fingerprint.slice(0, 16)}…` : id.fingerprint;
    return `${id.algorithm} · ${short}`;
  }

  private providerName(id: string): string {
    return PROVIDER_NAMES[id] ?? id;
  }

  /** Ready providers, plus the saved one when it is no longer ready (so edits still show). */
  private secretRefProviderOptions(isSecretRef: boolean, savedProvider: string): string {
    const ids = [...new Set([...this.readyProviders.map((p) => p.id), ...(isSecretRef && savedProvider ? [savedProvider] : [])])];
    if (ids.length === 0) return `<option value="" disabled selected>No secret managers ready</option>`;
    return ids
      .map((id) => `<option value="${escAttr(id)}" ${savedProvider === id ? "selected" : ""}>${escHtml(this.providerName(id))}</option>`)
      .join("");
  }

  private async loadReadyProviders() {
    try {
      this.readyProviders = (await listProviders()).filter((p) => p.status.kind === "ready");
    } catch {
      this.readyProviders = [];
    }
  }

  // ─── Secret Ref Combobox (chunk 15) ─────────────────────────────

  private providerCanList(providerId: string): boolean {
    return this.readyProviders.some((p) => p.id === providerId && p.can_list);
  }

  private currentProvider(): string {
    return (this.container?.querySelector('select[name="secret_ref_provider"]') as HTMLSelectElement | null)?.value ?? "";
  }

  /** Open the dropdown under the reference input, loading items lazily. */
  private openCombo(input: HTMLInputElement) {
    const provider = this.currentProvider();
    if (!provider || !this.providerCanList(provider)) return;
    if (!this.comboOpen) {
      this.comboOpen = true;
      document.addEventListener("mousedown", this.comboOutsideClose);
    }
    this.applyComboFilter(input.value);
    this.updateComboList();
    if (this.comboProvider !== provider || this.comboError) void this.loadComboItems(provider);
  }

  private closeCombo() {
    if (!this.comboOpen) return;
    this.comboOpen = false;
    document.removeEventListener("mousedown", this.comboOutsideClose);
    const list = document.getElementById("hs-ref-combo-list");
    if (list) list.innerHTML = "";
  }

  private comboOutsideClose = (e: MouseEvent) => {
    const wrap = document.getElementById("hs-ref-combo-wrap");
    if (wrap && !wrap.contains(e.target as Node)) this.closeCombo();
  };

  /** Arrow/Enter/Escape on the reference input. Enter selects only after the
   * user has navigated, so a plain Enter still submits the form. */
  private handleComboKey(e: KeyboardEvent, input: HTMLInputElement) {
    if (!this.comboOpen) {
      if (e.key === "ArrowDown" && this.providerCanList(this.currentProvider())) {
        e.preventDefault();
        this.openCombo(input);
      }
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        e.stopPropagation();
        this.moveCombo(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        e.stopPropagation();
        this.moveCombo(-1);
        break;
      case "Enter":
        if (this.comboNavigated && this.comboFiltered.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          this.selectComboItem(this.comboIndex);
        }
        break;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        this.closeCombo();
        break;
    }
  }

  private async loadComboItems(provider: string) {
    this.comboProvider = provider;
    this.comboLoading = true;
    this.comboError = null;
    this.updateComboList();
    try {
      this.comboItems = await listCredentials(provider);
    } catch (err) {
      this.comboError = String(err);
    } finally {
      this.comboLoading = false;
      if (!this.comboOpen || this.comboProvider !== provider) return;
      const input = this.container?.querySelector('input[name="secret_ref_reference"]') as HTMLInputElement | null;
      this.applyComboFilter(input?.value ?? "");
      this.updateComboList();
    }
  }

  private applyComboFilter(query: string) {
    const q = query.trim().toLowerCase();
    this.comboFiltered = q
      ? this.comboItems.filter(
          (i) => i.label.toLowerCase().includes(q) || (i.username ?? "").toLowerCase().includes(q),
        )
      : [...this.comboItems];
    this.comboIndex = 0;
  }

  private renderComboListContent(): string {
    if (this.comboLoading) return `<div class="hs-browse-empty">Loading…</div>`;
    if (this.comboError) return `<div class="hs-browse-empty hs-browse-err">${escHtml(this.comboError)}</div>`;
    if (this.comboFiltered.length === 0) return `<div class="hs-browse-empty">No matches.</div>`;
    return this.comboFiltered
      .map(
        (item, i) => `
          <div class="hs-browse-item ${i === this.comboIndex ? "hs-browse-item-active" : ""}" data-index="${i}">
            <span class="hs-browse-label">${escHtml(item.label)}</span>
            ${item.username ? `<span class="hs-browse-user">${escHtml(item.username)}</span>` : ""}
          </div>`,
      )
      .join("");
  }

  private updateComboList() {
    const list = document.getElementById("hs-ref-combo-list");
    if (!list) return;
    list.innerHTML = this.renderComboListContent();
    list.querySelectorAll(".hs-browse-item").forEach((el) => {
      el.addEventListener("mousedown", (e) => {
        e.preventDefault(); // keep focus in the input
        this.selectComboItem(parseInt((el as HTMLElement).dataset.index ?? "0", 10));
      });
    });
    list.querySelector(".hs-browse-item-active")?.scrollIntoView({ block: "nearest" });
  }

  private moveCombo(delta: number) {
    if (this.comboFiltered.length === 0) return;
    this.comboIndex = (this.comboIndex + delta + this.comboFiltered.length) % this.comboFiltered.length;
    this.comboNavigated = true;
    this.updateComboList();
  }

  /** Fill the reference input from a picked item and cache its label. */
  private selectComboItem(index: number) {
    const item = this.comboFiltered[index];
    if (!item) return;
    this.closeCombo();
    const input = this.container?.querySelector('input[name="secret_ref_reference"]') as HTMLInputElement | null;
    if (input) {
      input.value = item.label;
      input.focus();
    }
    this.comboSelection = item;
    this.secretRefLabel = item.label;
  }
}
