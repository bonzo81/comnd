/**
 * NetBox Configure Dialog — per-device overlay editor (plan §9.4).
 *
 * Slim modal for NetBox-sourced hosts: username, port, auth method, notes.
 * Blank fields mean "inherit the source defaults" (Settings → NetBox).
 * Saves via netbox_set_device_overlay; the per-device password goes to the
 * OS keyring under the device's host key, never into the cache file.
 */

import {
  CredentialSource,
  DeviceOverlay,
  NetBoxDeviceEntry,
  netboxGetDevices,
  netboxSetDeviceOverlay,
  listProviders,
  getCredential,
} from "../lib/tauri-api";
import { showToast } from "../lib/toast";
import { log, LogTag } from "../lib/logger";
import { escHtml } from "../lib/format";
import { platformBadge, platformColorClass } from "../lib/platforms";
import { icons } from "../lib/icons";

export class NetBoxConfigureDialog {
  private overlay: HTMLDivElement | null = null;
  private device: NetBoxDeviceEntry | null = null;
  private hasPassword = false;

  constructor(
    private hostId: string,
    private onSaved: () => void,
  ) {}

  async open(): Promise<void> {
    let devices: NetBoxDeviceEntry[] = [];
    try {
      devices = await netboxGetDevices();
    } catch (e) {
      showToast(`Failed to load device data: ${e}`, "error");
      return;
    }
    this.device = devices.find((d) => `netbox:${d.netbox_id}` === this.hostId) ?? null;
    if (!this.device) {
      showToast("Device not found in the NetBox cache — run a sync first", "error");
      return;
    }
    if (this.device.overlay.credential?.type === "password") {
      try {
        const pw = await getCredential(this.hostId);
        this.hasPassword = pw != null && pw.length > 0;
      } catch {
        this.hasPassword = false;
      }
    }
    this.render();
  }

  private render(): void {
    if (!this.device) return;
    const d = this.device;
    const o = d.overlay;
    const cred = o.credential;
    const authType = cred?.type ?? "inherit";
    const summaryMeta = [d.address, [d.site, d.location].filter(Boolean).join(" / "), d.status]
      .filter((s) => s)
      .join(" · ");

    const overlay = document.createElement("div");
    overlay.className = "modal-backdrop";
    overlay.innerHTML = `
      <div class="modal-panel host-form" role="dialog" aria-modal="true" aria-labelledby="nb-cfg-title">
        <h2 id="nb-cfg-title">Configure NetBox Device</h2>
        <div class="netbox-cfg-summary">
          <span class="hs-host-badge ${platformColorClass(d.platform)}">[${escHtml(platformBadge(d.platform))}]</span>
          <div>
            <div class="netbox-cfg-name">${escHtml(d.name)}</div>
            <div class="netbox-cfg-meta">${escHtml(summaryMeta)}</div>
          </div>
        </div>
        <form id="nb-cfg-form" autocomplete="off">
          <label>
            <span>Username</span>
            <input type="text" class="form-input" name="username" placeholder="Inherit source default"
                   value="${escHtml(o.username ?? "")}" />
          </label>
          <label>
            <span>Port</span>
            <input type="number" class="form-input" name="port" min="1" max="65535"
                   placeholder="Inherit source default" value="${o.port ?? ""}" />
          </label>
          <fieldset class="form-auth-group">
            <legend>Authentication</legend>
            <label class="radio-label">
              <input type="radio" name="auth_type" value="inherit" ${authType === "inherit" ? "checked" : ""} />
              Inherit source default
            </label>
            <label class="radio-label">
              <input type="radio" name="auth_type" value="password" ${authType === "password" ? "checked" : ""} />
              Password
            </label>
            <label class="radio-label">
              <input type="radio" name="auth_type" value="ssh_key" ${authType === "ssh_key" ? "checked" : ""} />
              SSH Key
            </label>
            <label class="radio-label">
              <input type="radio" name="auth_type" value="agent" ${authType === "agent" ? "checked" : ""} />
              SSH Agent
            </label>
            <label class="radio-label">
              <input type="radio" name="auth_type" value="secret_ref" ${authType === "secret_ref" ? "checked" : ""} />
              Secret Manager
            </label>
          </fieldset>
          <div id="nb-cfg-password" class="auth-conditional ${authType === "password" ? "" : "auth-conditional-hidden"}">
            <label>
              <span>Password ${this.hasPassword ? `<span class="cred-badge">${icons.lock} Password saved</span>` : ""}</span>
              <input type="password" class="form-input" name="password"
                     placeholder="${this.hasPassword ? "Leave blank to keep saved password" : "Enter password"}" />
            </label>
          </div>
          <div id="nb-cfg-key" class="auth-conditional ${authType === "ssh_key" ? "" : "auth-conditional-hidden"}">
            <label>
              <span>SSH Key Path</span>
              <input type="text" class="form-input" name="ssh_key_path" placeholder="~/.ssh/id_rsa"
                     value="${escHtml(cred?.type === "ssh_key" ? cred.key_path : "")}" />
            </label>
          </div>
          <div id="nb-cfg-agent" class="auth-conditional ${authType === "agent" ? "" : "auth-conditional-hidden"}">
            <label>
              <span>Identity fingerprint</span>
              <input type="text" class="form-input" name="agent_identity" placeholder="Blank = offer all identities"
                     spellcheck="false" autocomplete="off"
                     value="${escHtml(cred?.type === "agent" ? (cred.identity ?? "") : "")}" />
            </label>
          </div>
          <div id="nb-cfg-secretref" class="auth-conditional ${authType === "secret_ref" ? "" : "auth-conditional-hidden"}">
            <label>
              <span>Provider</span>
              <select class="form-input" name="secret_ref_provider" id="nb-cfg-ref-provider"></select>
            </label>
            <label>
              <span>Reference</span>
              <input type="text" class="form-input" name="secret_ref_reference" placeholder="Item reference"
                     spellcheck="false" autocomplete="off"
                     value="${escHtml(cred?.type === "secret_ref" ? cred.reference : "")}" />
            </label>
          </div>
          <label>
            <span>Notes</span>
            <textarea class="form-input" name="notes" rows="3" placeholder="Optional notes">${escHtml(o.notes ?? "")}</textarea>
          </label>
          <div class="form-actions">
            <button type="button" class="btn-text" id="nb-cfg-cancel">Cancel</button>
            <button type="submit" class="btn-primary">Save</button>
          </div>
          <div class="form-errors" id="nb-cfg-errors" role="alert"></div>
        </form>
      </div>
    `;
    document.body.appendChild(overlay);
    this.overlay = overlay;

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) this.close();
    });
    overlay.querySelector<HTMLButtonElement>("#nb-cfg-cancel")?.addEventListener("click", () => this.close());
    overlay.querySelectorAll<HTMLInputElement>('input[name="auth_type"]').forEach((radio) => {
      radio.addEventListener("change", () => this.updateAuthVisibility());
    });
    overlay.querySelector<HTMLFormElement>("#nb-cfg-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.save();
    });

    void this.loadProviders(authType);
    setTimeout(() => {
      overlay.querySelector<HTMLInputElement>('input[name="username"]')?.focus();
    }, 50);
  }

  private async loadProviders(selectedType: string): Promise<void> {
    const select = this.overlay?.querySelector<HTMLSelectElement>("#nb-cfg-ref-provider");
    if (!select) return;
    let providers: { id: string }[] = [];
    try {
      const infos = await listProviders();
      providers = infos.filter((p) => p.status.kind === "ready");
    } catch {
      providers = [];
    }
    const current = this.device?.overlay.credential;
    const currentProvider = current?.type === "secret_ref" ? current.provider : "";
    select.innerHTML =
      (providers.length === 0
        ? `<option value="">No secret managers ready</option>`
        : providers
            .map(
              (p) =>
                `<option value="${escHtml(p.id)}" ${p.id === currentProvider ? "selected" : ""}>${escHtml(p.id)}</option>`,
            )
            .join("")) +
      (selectedType === "secret_ref" && !providers.some((p) => p.id === currentProvider) && currentProvider
        ? `<option value="${escHtml(currentProvider)}" selected>${escHtml(currentProvider)}</option>`
        : "");
  }

  private updateAuthVisibility(): void {
    const type =
      this.overlay?.querySelector<HTMLInputElement>('input[name="auth_type"]:checked')?.value ?? "inherit";
    const show = (id: string, on: boolean) =>
      this.overlay?.querySelector<HTMLElement>(id)?.classList.toggle("auth-conditional-hidden", !on);
    show("#nb-cfg-password", type === "password");
    show("#nb-cfg-key", type === "ssh_key");
    show("#nb-cfg-agent", type === "agent");
    show("#nb-cfg-secretref", type === "secret_ref");
  }

  private async save(): Promise<void> {
    if (!this.device || !this.overlay) return;
    const form = this.overlay.querySelector<HTMLFormElement>("#nb-cfg-form");
    const errEl = this.overlay.querySelector<HTMLElement>("#nb-cfg-errors");
    if (!form) return;
    const fd = new FormData(form);
    const username = (fd.get("username") as string)?.trim() || null;
    const portRaw = (fd.get("port") as string)?.trim();
    const port = portRaw ? parseInt(portRaw, 10) : null;
    const authType = (fd.get("auth_type") as string) ?? "inherit";
    const password = (fd.get("password") as string) ?? "";
    const keyPath = (fd.get("ssh_key_path") as string)?.trim() ?? "";
    const agentIdentity = (fd.get("agent_identity") as string)?.trim() ?? "";
    const refProvider = (fd.get("secret_ref_provider") as string)?.trim() ?? "";
    const refReference = (fd.get("secret_ref_reference") as string)?.trim() ?? "";
    const notes = (fd.get("notes") as string)?.trim() || null;

    if (port !== null && (port < 1 || port > 65535)) {
      if (errEl) errEl.textContent = "Port must be 1-65535.";
      return;
    }
    if (authType === "ssh_key" && !keyPath) {
      if (errEl) errEl.textContent = "SSH key path is required.";
      return;
    }
    if (authType === "secret_ref" && (!refProvider || !refReference)) {
      if (errEl) errEl.textContent = "Select a provider and enter a reference.";
      return;
    }

    const credential: CredentialSource | null =
      authType === "password"
        ? { type: "password" }
        : authType === "ssh_key"
          ? { type: "ssh_key", key_path: keyPath }
          : authType === "agent"
            ? { type: "agent", identity: agentIdentity || null }
            : authType === "secret_ref"
              ? { type: "secret_ref", provider: refProvider, reference: refReference, label: null }
              : null;

    const overlay: DeviceOverlay = {
      username,
      port,
      credential,
      last_connected: this.device.overlay.last_connected,
      notes,
    };

    try {
      await netboxSetDeviceOverlay(this.device.netbox_id, overlay, password || null);
      log.info(LogTag.Netbox, `Overlay saved for device ${this.device.netbox_id}`);
      showToast("Device settings saved", "success");
      this.close();
      this.onSaved();
    } catch (e) {
      log.error(LogTag.Netbox, `Overlay save failed for device ${this.device.netbox_id}`, e);
      if (errEl) errEl.textContent = `Save failed: ${e}`;
    }
  }

  close(): void {
    this.overlay?.remove();
    this.overlay = null;
  }
}
