/**
 * NetBox Configure Dialog — per-device overlay editor (plan §9.4).
 *
 * Slim modal for NetBox-sourced hosts: username, port, auth method, notes.
 * Blank fields mean "inherit the source defaults" (Settings → NetBox).
 * Saves via netbox_set_device_overlay; the per-device password goes to the
 * OS keyring under the device's host key, never into the cache file.
 */

import {
  DeviceOverlay,
  NetBoxConfig,
  NetBoxDeviceEntry,
  netboxGetConfig,
  netboxGetDevices,
  netboxSetDeviceOverlay,
  listProviders,
  hasCredential,
} from "../lib/tauri-api";
import { showToast } from "../lib/toast";
import { log, LogTag } from "../lib/logger";
import { escHtml } from "../lib/format";
import { collectCredential, renderCredentialFieldset, updateCredentialVisibility } from "../lib/credential-fieldset";
import { platformBadge, platformColorClass } from "../lib/platforms";
import { openModal, ModalHandle } from "../lib/modal";
import { icons } from "../lib/icons";

export class NetBoxConfigureDialog {
  private modal: ModalHandle | null = null;
  private device: NetBoxDeviceEntry | null = null;
  private hasPassword = false;
  private sourceConfig: NetBoxConfig | null = null;

  constructor(
    private hostId: string,
    private onSaved: () => void,
  ) {}

  async open(): Promise<void> {
    let devices: NetBoxDeviceEntry[] = [];
    try {
      const [devs, cfgState] = await Promise.all([
        netboxGetDevices(),
        netboxGetConfig().catch(() => null),
      ]);
      devices = devs;
      this.sourceConfig = cfgState?.config ?? null;
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
        this.hasPassword = await hasCredential(this.hostId);
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

    const inheritedUsername = this.sourceConfig?.default_username?.trim() || null;
    const inheritedPort = this.sourceConfig?.default_port;
    const usernamePlaceholder = inheritedUsername ?? "Inherit source default";
    const portPlaceholder = inheritedPort != null ? String(inheritedPort) : "Inherit source default";

    const content = `
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
          <span class="netbox-cfg-input-wrap">
            <input type="text" class="form-input" name="username" placeholder="${escHtml(usernamePlaceholder)}"
                   value="${escHtml(o.username ?? "")}" />
            <button type="button" class="netbox-cfg-reset" aria-label="Reset to inherited default" title="Reset to inherited default">${icons.refresh}</button>
          </span>
        </label>
        <label>
          <span>Port</span>
          <span class="netbox-cfg-input-wrap">
            <input type="number" class="form-input" name="port" min="1" max="65535"
                   placeholder="${escHtml(portPlaceholder)}" value="${o.port ?? ""}" />
            <button type="button" class="netbox-cfg-reset" aria-label="Reset to inherited default" title="Reset to inherited default">${icons.refresh}</button>
          </span>
        </label>
        ${renderCredentialFieldset({
          name: "auth_type",
          credential: cred ?? null,
          providers: [],
          idPrefix: "nb-cfg",
          defaultType: "inherit",
          extraRadios: [{ value: "inherit", checked: authType === "inherit", label: "Inherit source default" }],
          passwordBadge: this.hasPassword,
          passwordPlaceholder: this.hasPassword ? "Leave blank to keep saved password" : "Enter password",
        })}
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
    `;

    this.modal = openModal({
      panelClass: "host-form",
      content,
      initialFocus: 'input[name="username"]',
      onDismiss: () => this.close(),
    });
    this.modal.panel.setAttribute("aria-labelledby", "nb-cfg-title");

    const panel = this.modal.panel;
    panel.querySelectorAll<HTMLElement>(".netbox-cfg-input-wrap").forEach((wrap) => {
      const input = wrap.querySelector<HTMLInputElement>("input");
      const btn = wrap.querySelector<HTMLButtonElement>(".netbox-cfg-reset");
      if (!input || !btn) return;
      const update = () => {
        wrap.classList.toggle("has-value", input.value.trim() !== "");
      };
      input.addEventListener("input", update);
      update();
      btn.addEventListener("click", () => {
        input.value = "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.focus();
      });
    });
    panel.querySelector<HTMLButtonElement>("#nb-cfg-cancel")?.addEventListener("click", () => this.close());
    panel.querySelectorAll<HTMLInputElement>('input[name="auth_type"]').forEach((radio) => {
      radio.addEventListener("change", () => this.updateAuthVisibility());
    });
    panel.querySelector<HTMLFormElement>("#nb-cfg-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.save();
    });

    void this.loadProviders(authType);
  }

  private async loadProviders(selectedType: string): Promise<void> {
    const select = this.modal?.panel.querySelector<HTMLSelectElement>('select[name="secret_ref_provider"]');
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
    if (!this.modal) return;
    updateCredentialVisibility(this.modal.panel, "auth_type", "nb-cfg");
  }

  private async save(): Promise<void> {
    if (!this.device || !this.modal) return;
    const form = this.modal.panel.querySelector<HTMLFormElement>("#nb-cfg-form");
    const errEl = this.modal.panel.querySelector<HTMLElement>("#nb-cfg-errors");
    if (!form) return;
    const fd = new FormData(form);
    const username = (fd.get("username") as string)?.trim() || null;
    const portRaw = (fd.get("port") as string)?.trim();
    const port = portRaw ? parseInt(portRaw, 10) : null;
    const { credential, password } = collectCredential("auth_type", (k) => fd.get(k) as string | null);
    const authType = fd.get("auth_type") as string;
    const notes = (fd.get("notes") as string)?.trim() || null;

    if (port !== null && (port < 1 || port > 65535)) {
      if (errEl) errEl.textContent = "Port must be 1-65535.";
      return;
    }
    if (authType === "ssh_key" && !(credential as { key_path?: string } | null)?.key_path) {
      if (errEl) errEl.textContent = "SSH key path is required.";
      return;
    }
    if (authType === "secret_ref" && credential?.type === "secret_ref" && (!credential.provider || !credential.reference)) {
      if (errEl) errEl.textContent = "Select a provider and enter a reference.";
      return;
    }

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
    this.modal?.close();
    this.modal = null;
  }
}
