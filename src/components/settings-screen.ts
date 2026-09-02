/**
 * Settings Screen — dedicated settings view (right of nav panel).
 *
 * Sub-items: Ollama / KB Import (functional), General + Shortcuts (placeholders).
 * The Ollama sub-item owns the LLM connection settings used by KB import.
 */

import {
  getAppConfig, saveOllamaSettings, testOllamaConnection, setLogLevel,
  setLogMaxSize, setLogFilePath, setMaxSessions, exportData, importData,
  setSessionLogging, setSessionLogTimestamps, setSessionLogDir, getSessionLogDir,
  scanMerge, applyMerge, restartApp, MergeConflict,
  AppConfig, listProviders, getProviderState,
  saveProviderConfig, saveProviderSecret, ProviderInfo, ProviderState,
  netboxGetConfig, netboxSaveConfig, netboxSaveToken, netboxTestConnection,
  netboxSync, netboxGetDevices, netboxSetDeviceEnabled, netboxGetStatus,
  netboxGetSites, netboxGetRoles, netboxGetTags,
  NetBoxConfig, NetBoxDeviceEntry, NetBoxChoice,
} from "../lib/tauri-api";
import { save, open } from "@tauri-apps/plugin-dialog";
import { showToast, showToastWithAction } from "../lib/toast";
import { log, LogTag } from "../lib/logger";
import { escHtml } from "../lib/format";
import { relativeTime } from "../lib/format";
import { icons } from "../lib/icons";
import { platformBadge, platformColorClass } from "../lib/platforms";
import {
  getTimestampFormat,
  setTimestampFormat,
  TimestampFormat,
} from "../lib/timestamps";
import { getSearchIncludeTags, setSearchIncludeTags } from "../lib/search-prefs";
import { getAutoCopyEnabled, setAutoCopyEnabled } from "../lib/auto-copy";
import { getOutputHighlightEnabled, setOutputHighlightEnabled } from "../lib/output-highlight";
import { APP_THEMES, getAppTheme, setAppTheme, Theme } from "../lib/theme";

const LABELS: Record<string, string> = {
  general: "General",
  logging: "Logging",
  theme: "Theme",
  ollama: "Ollama / KB Import",
  auth: "Auth Integrations",
  netbox: "NetBox",
  shortcuts: "Shortcuts",
};

/** Planned providers. `available` = config fields render (implementation may
 *  still land in a later chunk — live status comes from list_providers). */
interface ProviderCatalogEntry {
  id: string;
  name: string;
  available: boolean;
  fields: ("pat")[];
}

const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  { id: "proton", name: "Proton Pass", available: true, fields: ["pat"] },
  { id: "passbolt", name: "Passbolt", available: false, fields: [] },
  { id: "onepassword", name: "1Password", available: false, fields: [] },
  { id: "bitwarden", name: "Bitwarden", available: false, fields: [] },
  { id: "vault", name: "HashiCorp Vault", available: false, fields: [] },
];

export class SettingsScreen {
  private container: HTMLElement | null = null;
  private itemId = "ollama";
  private config: AppConfig | null = null;
  private sessionLogDefaultDir = "";
  private availableModels: string[] = [];
  private providerStatuses = new Map<string, ProviderInfo>();
  private providerStates = new Map<string, ProviderState>();
  // ── NetBox state ──
  private netboxConfig: NetBoxConfig | null = null;
  private netboxHasToken = false;
  private netboxDefaultPwSaved = false;
  private netboxLastSynced: string | null = null;
  private netboxDevices: NetBoxDeviceEntry[] = [];
  private netboxDeviceSearch = "";
  private netboxTestLine: { text: string; ok: boolean } | null = null;
  private netboxSites: NetBoxChoice[] = [];
  private netboxRoles: NetBoxChoice[] = [];
  private netboxTags: NetBoxChoice[] = [];
  /** True only after a successful Test using the *current* URL+token field
   *  values — drives the Save Token button highlight. Reset on any input. */
  private netboxTestOk = false;
  /** Called when a NetBox action changes the merged host tree (sync, enable
   *  toggle, device toggle) so the nav panel can re-fetch. */
  onTreeChanged: () => void = () => {};

  setItem(id: string) {
    // Auth re-fetches on every show (refresh-on-mount); other items no-op.
    if (this.itemId === id && id !== "auth" && id !== "netbox") return;
    this.itemId = id;
    if (id === "auth") void this.loadProviders().then(() => this.render());
    else if (id === "netbox") void this.loadNetbox().then(() => this.render());
    else this.render();
  }

  async mount(container: HTMLElement) {
    this.container = container;
    try {
      [this.config, this.sessionLogDefaultDir] = await Promise.all([
        getAppConfig(),
        getSessionLogDir().catch(() => ""),
      ]);
    } catch {
      this.config = null;
    }
    this.render();
  }

  unmount() {
    this.container = null;
  }

  private render() {
    if (!this.container) return;
    // Preserve live NetBox toggle state across re-renders: a pending
    // loadNetbox() completing after the user toggled would otherwise reset
    // the checkbox to the stale saved value, and the next autosave would
    // persist that stale `enabled: false` (bug: "Sync failed: disabled").
    const enabledNow = this.container.querySelector<HTMLInputElement>("#netbox-enabled")?.checked;
    if (enabledNow !== undefined && this.netboxConfig) this.netboxConfig.enabled = enabledNow;
    const label = LABELS[this.itemId] ?? "Settings";
    const body =
      this.itemId === "ollama" ? this.renderOllama()
      : this.itemId === "general" ? this.renderGeneral()
      : this.itemId === "logging" ? this.renderLogging()
      : this.itemId === "theme" ? this.renderTheme()
      : this.itemId === "auth" ? this.renderAuth()
      : this.itemId === "netbox" ? this.renderNetBox()
      : this.renderPlaceholder(label);
    this.container.innerHTML = `
      <div class="settings-screen">
        <div class="settings-page">
          <h2 class="settings-title">${escHtml(label)}</h2>
          ${body}
        </div>
      </div>
    `;
    this.bindEvents();
  }

  private renderOllama(): string {
    const baseUrl = this.config?.ollama_base_url ?? "http://localhost:11434";
    const model = this.config?.ollama_model ?? "llama3.2";
    const apiKey = this.config?.ollama_api_key ?? "";
    const ctxLen = this.config?.ollama_context_length ?? 64000;
    return `
      <form class="settings-form" id="ollama-settings-form">
        <div class="import-field">
          <label for="ollama-url">Base URL</label>
          <input type="url" class="form-input" id="ollama-url" value="${this.escAttr(baseUrl)}" required />
          <span class="import-hint">http://localhost:11434 for local, https://ollama.com/api for cloud</span>
        </div>
        <div class="import-field">
          <label for="ollama-model">Model</label>
          <input type="text" class="form-input" id="ollama-model" value="${this.escAttr(model)}" required />
          <span class="import-hint">e.g., gemma4:26b, llama3.2, mistral</span>
        </div>
        <div class="import-field">
          <label for="ollama-key">API Key (cloud only)</label>
          <input type="password" class="form-input" id="ollama-key" value="${this.escAttr(apiKey)}" placeholder="Leave empty for local Ollama" autocomplete="off" />
        </div>
        <div class="import-field">
          <label for="ollama-ctx">Context Length</label>
          <input type="number" class="form-input" id="ollama-ctx" value="${ctxLen}" min="4096" step="1024" />
          <span class="import-hint">Higher = can process longer pages, but uses more memory</span>
        </div>
        <div class="import-config-row">
          <button type="button" class="btn-secondary btn-small" id="ollama-test-btn">${icons.bot} Test Connection</button>
          <span class="import-model-info" id="ollama-test-status"></span>
        </div>
        ${this.availableModels.length > 0 ? this.renderModelSelect(model) : ""}
        <div class="settings-actions">
          <button type="submit" class="btn-primary">Save Settings</button>
        </div>
      </form>
    `;
  }

  private renderModelSelect(currentModel: string): string {
    return `
      <div class="import-field import-models">
        <label for="ollama-model-select">Available Models</label>
        <select class="form-input form-input-mono" id="ollama-model-select">
          ${this.availableModels.map((m) => `<option value="${this.escAttr(m)}" ${m === currentModel ? "selected" : ""}>${escHtml(m)}</option>`).join("")}
        </select>
        <span class="import-hint">Selecting a model updates the Model field above</span>
      </div>
    `;
  }

  private renderGeneral(): string {
    const fmt = getTimestampFormat();
    const tagsOn = getSearchIncludeTags();
    const autoCopy = getAutoCopyEnabled();
    const highlight = getOutputHighlightEnabled();
    const logLevel = this.config?.log_level ?? "info";
    const maxSizeMb = this.config?.log_max_size_mb ?? 10;
    const maxSessions = this.config?.max_sessions ?? 30;
    const opt = (value: TimestampFormat, label: string) =>
      `<option value="${value}" ${fmt === value ? "selected" : ""}>${label}</option>`;
    const levelOpt = (value: string, label: string) =>
      `<option value="${value}" ${logLevel === value ? "selected" : ""}>${label}</option>`;
    const sizeOpt = (value: number, label: string) =>
      `<option value="${value}" ${maxSizeMb === value ? "selected" : ""}>${label}</option>`;
    const sessionOpt = (value: number, label: string) =>
      `<option value="${value}" ${maxSessions === value ? "selected" : ""}>${label}</option>`;
    return `
      <div class="settings-form">
        <h3 class="settings-section-title">Terminal</h3>
        <div class="import-field">
          <label for="ts-format">Timestamp format</label>
          <select class="form-input" id="ts-format">
            ${opt("24h", "24-hour — 14:32:05")}
            ${opt("12h", "12-hour — 2:32:05 PM")}
            ${opt("24h-ms", "24-hour with ms — 14:32:05.123")}
          </select>
          <span class="import-hint">Re-renders timestamps in open terminals immediately</span>
        </div>
        <label class="settings-toggle">
          <input type="checkbox" id="auto-copy" ${autoCopy ? "checked" : ""} />
          <span>
            Copy text on selection
            <span class="import-hint">Automatically copies highlighted terminal text to the clipboard as you select it</span>
          </span>
        </label>
        <label class="settings-toggle">
          <input type="checkbox" id="output-highlight" ${highlight ? "checked" : ""} />
          <span>
            Syntax highlighting in terminal output
            <span class="import-hint">Colorizes IPs, interface names, status keywords (up/down/error), and config keywords in command output. Off by default.</span>
          </span>
        </label>
        <div class="import-field">
          <label for="max-sessions">Maximum concurrent sessions</label>
          <select class="form-input" id="max-sessions">
            ${sessionOpt(10, "10")}
            ${sessionOpt(20, "20")}
            ${sessionOpt(30, "30 (default)")}
            ${sessionOpt(50, "50")}
            ${sessionOpt(100, "100")}
            ${sessionOpt(0, "Unlimited")}
          </select>
          <span class="import-hint">Prevents runaway resource usage from too many open SSH connections. Applies immediately.</span>
        </div>
        <h3 class="settings-section-title">Global Search</h3>
        <label class="settings-toggle">
          <input type="checkbox" id="search-tags" ${tagsOn ? "checked" : ""} />
          <span>
            Match command tags in search
            <span class="import-hint">When off, global search and KB search match command name and aliases only</span>
          </span>
        </label>
        <h3 class="settings-section-title">Data Management</h3>
        <div class="import-field">
          <div class="log-file-row">
            <button type="button" id="data-export" class="btn-secondary">Export backup...</button>
            <button type="button" id="data-import" class="btn-secondary">Restore from backup...</button>
          </div>
          <span class="import-hint">Export saves hosts, groups, config, known hosts, and knowledge base to a zip file. Restore replaces your current data (a backup of the current state is kept automatically). Restart the app after restoring.</span>
        </div>
      </div>
    `;
  }

  private renderLogging(): string {
    const logLevel = this.config?.log_level ?? "info";
    const maxSizeMb = this.config?.log_max_size_mb ?? 10;
    const levelOpt = (value: string, label: string) =>
      `<option value="${value}" ${logLevel === value ? "selected" : ""}>${label}</option>`;
    const sizeOpt = (value: number, label: string) =>
      `<option value="${value}" ${maxSizeMb === value ? "selected" : ""}>${label}</option>`;
    const sessionDir = this.config?.session_log_dir ?? "";
    return `
      <div class="settings-form">
        <h3 class="settings-section-title">App Log</h3>
        <div class="import-field">
          <label for="log-level">Log level</label>
          <select class="form-input" id="log-level">
            ${levelOpt("debug", "Debug")}
            ${levelOpt("info", "Info")}
            ${levelOpt("warn", "Warn")}
            ${levelOpt("error", "Error")}
          </select>
          <span class="import-hint">Applies immediately. Debug shows suggestion queries and PTY resize events.</span>
        </div>
        <div class="import-field">
          <label for="log-max-size">Log file size cap</label>
          <select class="form-input" id="log-max-size">
            ${sizeOpt(0, "Off")}
            ${sizeOpt(5, "5 MB")}
            ${sizeOpt(10, "10 MB")}
            ${sizeOpt(50, "50 MB")}
            ${sizeOpt(100, "100 MB")}
          </select>
          <span class="import-hint">File is truncated when the cap is reached. Applies on next app start.</span>
        </div>
        <div class="import-field">
          <label for="log-file-path">Log file location</label>
          <div class="log-file-row">
            <input type="text" class="form-input" id="log-file-path"
              value="${this.escAttr(this.config?.log_file_path ?? "")}"
              placeholder="Default: app data dir"
              spellcheck="false" autocomplete="off" />
            <button type="button" id="log-file-browse" class="btn-secondary">Browse...</button>
            <button type="button" id="log-file-reset" class="btn-link">Reset</button>
          </div>
          <span class="import-hint">Applies on next app start. Leave blank for the default location. Custom locations may have different access permissions — prefer the default for privacy.</span>
        </div>
        <h3 class="settings-section-title">Session Logging</h3>
        <label class="settings-toggle">
          <input type="checkbox" id="session-logging" ${this.config?.session_logging ?? true ? "checked" : ""} />
          <span>
            Log SSH session output to file
            <span class="import-hint">Writes raw terminal I/O for each connection to a per-session log file. Applies to new connections.</span>
          </span>
        </label>
        <label class="settings-toggle">
          <input type="checkbox" id="session-log-timestamps" ${this.config?.session_log_timestamps ?? true ? "checked" : ""} />
          <span>
            Prefix log lines with timestamps
            <span class="import-hint">Adds an [HH:MM:SS] stamp before each chunk of output.</span>
          </span>
        </label>
        <div class="import-field">
          <label for="session-log-dir">Session log directory</label>
          <div class="log-file-row">
            <input type="text" class="form-input" id="session-log-dir"
              value="${this.escAttr(sessionDir)}"
              placeholder="Default: ${this.escAttr(this.sessionLogDefaultDir)}"
              spellcheck="false" autocomplete="off" />
            <button type="button" id="session-log-dir-browse" class="btn-secondary">Browse...</button>
            <button type="button" id="session-log-dir-reset" class="btn-link">Reset</button>
          </div>
          <span class="import-hint">Leave blank for the default location. Applies to new connections.</span>
        </div>
      </div>
    `;
  }

  private renderTheme(): string {
    const t = getAppTheme();
    const opts = APP_THEMES.map(
      (th) => `<option value="${th.id}" ${t === th.id ? "selected" : ""}>${th.label}</option>`
    ).join("");
    return `
      <div class="settings-form">
        <h3 class="settings-section-title">Appearance</h3>
        <div class="import-field">
          <label for="theme-app">App theme</label>
          <select class="form-input" id="theme-app">
            ${opts}
          </select>
          <span class="import-hint">Applies to the netssh window chrome, nav panel, and settings</span>
        </div>
      </div>
    `;
  }

  // ─── NetBox (plan §9.2) ─────────────────────────────────────────

  private async loadNetbox() {
    try {
      const state = await netboxGetConfig();
      this.netboxConfig = state.config;
      this.netboxHasToken = state.has_token;
    } catch {
      this.netboxConfig = null;
      this.netboxHasToken = false;
    }
    try {
      const status = await netboxGetStatus();
      this.netboxHasToken = status.has_token;
      this.netboxDefaultPwSaved = status.has_default_pw;
      this.netboxLastSynced = status.last_synced;
    } catch {
      this.netboxDefaultPwSaved = false;
      this.netboxLastSynced = null;
    }
    try {
      this.netboxDevices = await netboxGetDevices();
    } catch {
      this.netboxDevices = [];
    }
    // Provider list feeds the default-auth secret-ref select
    try {
      const infos = await listProviders();
      this.providerStatuses = new Map(infos.map((p) => [p.id, p]));
    } catch {
      this.providerStatuses = new Map();
    }
    // Fetch filter choices when connection is valid (token + URL present)
    if (this.netboxHasToken && this.netboxConfig?.base_url) {
      const [sites, roles, tags] = await Promise.allSettled([
        netboxGetSites(),
        netboxGetRoles(),
        netboxGetTags(),
      ]);
      this.netboxSites = sites.status === "fulfilled" ? sites.value : [];
      this.netboxRoles = roles.status === "fulfilled" ? roles.value : [];
      this.netboxTags = tags.status === "fulfilled" ? tags.value : [];
    }
  }

  private renderFilterMultiSelect(id: string, label: string, placeholder: string, options: NetBoxChoice[], selected: string[]): string {
    const hasConnection = this.netboxHasToken && !!this.netboxConfig?.base_url;
    if (!hasConnection) {
      return `
        <div class="import-field">
          <label for="${id}">${label}</label>
          <input type="text" class="form-input" id="${id}" value="${this.escAttr(selected.join(", "))}" placeholder="Connect NetBox to enable selection" disabled />
          <input type="hidden" data-ms-hidden="${id}" value="${this.escAttr(selected.join(","))}" />
        </div>`;
    }
    const chips = selected.map((slug) => {
      const opt = options.find((o) => o.slug === slug);
      const display = opt ? opt.name : slug;
      return `<span class="ms-chip" data-ms-slug="${this.escAttr(slug)}">${escHtml(display)}<button type="button" class="ms-chip-x" aria-label="Remove">&times;</button></span>`;
    }).join("");
    const listItems = options.map((o) => {
      const sel = selected.includes(o.slug) ? " ms-item-selected" : "";
      return `<li class="ms-item${sel}" data-ms-slug="${this.escAttr(o.slug)}">${escHtml(o.name)}</li>`;
    }).join("");
    return `
      <div class="import-field">
        <label for="${id}-search">${label}</label>
        <div class="ms-wrap" data-ms-field="${id}">
          <div class="ms-chips">${chips || '<span class="ms-placeholder">' + escHtml(placeholder) + '</span>'}</div>
          <input type="text" class="form-input ms-search" id="${id}-search" placeholder="Search..." autocomplete="off" />
          <ul class="ms-dropdown" data-ms-list="${id}">${listItems}</ul>
        </div>
        <input type="hidden" id="${id}" value="${this.escAttr(selected.join(","))}" />
      </div>`;
  }

  private updateMsChips(chipsEl: HTMLElement, listEl: HTMLUListElement, selected: string[]) {
    const options = Array.from(listEl.querySelectorAll<HTMLLIElement>(".ms-item"));
    const placeholder = chipsEl.querySelector(".ms-placeholder")?.textContent ?? "Search…";
    if (selected.length === 0) {
      chipsEl.innerHTML = `<span class="ms-placeholder">${escHtml(placeholder)}</span>`;
      return;
    }
    chipsEl.innerHTML = selected.map((slug) => {
      const opt = options.find((o) => o.dataset.msSlug === slug);
      const display = opt ? opt.textContent ?? slug : slug;
      return `<span class="ms-chip" data-ms-slug="${this.escAttr(slug)}">${escHtml(display)}<button type="button" class="ms-chip-x" aria-label="Remove">&times;</button></span>`;
    }).join("");
  }

  private filterMsList(listEl: HTMLUListElement, query: string) {
    const q = query.toLowerCase().trim();
    listEl.querySelectorAll<HTMLLIElement>(".ms-item").forEach((li) => {
      const text = (li.textContent ?? "").toLowerCase();
      li.hidden = q !== "" && !text.includes(q);
    });
  }

  private renderNetBox(): string {
    const cfg = this.netboxConfig;
    const enabled = cfg?.enabled ?? false;
    const cred = cfg?.default_credential ?? null;
    const authType = cred?.type ?? "none";
    const filters = cfg?.filters ?? { status: null, sites: [], roles: [], tags: [] };
    const overridesText = Object.entries(cfg?.platform_overrides ?? {})
      .map(([slug, platform]) => `${slug}=${platform}`)
      .join("\n");
    const platformOpt = (value: string, label: string) =>
      `<option value="${value}" ${cfg?.platform_fallback === value ? "selected" : ""}>${label}</option>`;
    const readyProviders = [...this.providerStatuses.values()].filter(
      (p) => p.status.kind === "ready",
    );
    const providerOpt = (p: ProviderInfo) =>
      `<option value="${p.id}" ${cred?.type === "secret_ref" && cred.provider === p.id ? "selected" : ""}>${escHtml(p.id)}</option>`;
    const testLine = this.netboxTestLine;

    return `
      <div class="settings-form" id="netbox-settings">
        <label class="settings-toggle">
          <input type="checkbox" id="netbox-enabled" ${enabled ? "checked" : ""} />
          <span>
            Enable NetBox host source
            <span class="import-hint">Pulls devices from a NetBox instance into the host list under their own NetBox folder. Nothing syncs until you click Refresh. Changes here save automatically.</span>
          </span>
        </label>

        <div class="netbox-body${enabled ? "" : " netbox-body-disabled"}">
          <h3 class="settings-section-title">Instance</h3>
          <div class="import-field">
            <label for="netbox-url">NetBox URL</label>
            <input type="url" class="form-input" id="netbox-url"
                   placeholder="https://netbox.example.com" spellcheck="false" autocomplete="off"
                   value="${this.escAttr(cfg?.base_url ?? "")}" />
          </div>
          <div class="import-field">
            <label for="netbox-token">API Token</label>
            <input type="password" class="form-input" id="netbox-token"
                   placeholder="${this.netboxHasToken ? "Saved — enter a new token to replace" : "Paste a NetBox API token"}"
                   autocomplete="off" spellcheck="false" />
            <span class="import-hint">Create a token in NetBox under your profile → API Tokens (read access to DCIM is enough). Stored in the OS keychain. Test the URL + token, then click Save Connection to commit both.</span>
          </div>
          <div class="import-config-row">
            <button type="button" class="btn-secondary btn-small" id="netbox-test-btn">${icons.bot} Test Connection</button>
            <button type="button" class="btn-secondary btn-small${this.netboxTestOk ? " netbox-save-token-ready" : ""}" id="netbox-token-save" ${this.netboxTestOk ? "" : "disabled"}>${icons.lock} Save Connection</button>
            <span class="import-model-info${testLine ? (testLine.ok ? " import-test-ok" : " import-test-err") : ""}" id="netbox-test-status">${escHtml(testLine?.text ?? "")}</span>
          </div>
          <label class="settings-toggle">
            <input type="checkbox" id="netbox-invalid-certs" ${cfg?.allow_invalid_certs ? "checked" : ""} />
            <span>
              Allow self-signed certificates
              <span class="import-hint">Skip TLS verification for the NetBox URL (home labs with a self-signed or internal CA). Off by default — it makes the API token MITM-able. Prefer trusting your CA in the OS cert store.</span>
            </span>
          </label>

          <h3 class="settings-section-title">Sync Filters</h3>
          <div class="import-field">
            <label for="netbox-filter-status">Device status</label>
            <input type="text" class="form-input" id="netbox-filter-status" placeholder="active"
                   value="${this.escAttr(filters.status ?? "active")}" />
            <span class="import-hint">NetBox status slug. Leave blank to sync devices in any status.</span>
          </div>
          ${this.renderFilterMultiSelect("netbox-filter-sites", "Sites", "Search sites…", this.netboxSites, filters.sites)}
          ${this.renderFilterMultiSelect("netbox-filter-roles", "Roles", "Search roles…", this.netboxRoles, filters.roles)}
          ${this.renderFilterMultiSelect("netbox-filter-tags", "Tags", "Search tags…", this.netboxTags, filters.tags)}

          <h3 class="settings-section-title">Platform Mapping</h3>
          <div class="import-field">
            <label for="netbox-platform-policy">Unknown platform slugs</label>
            <select class="form-input" id="netbox-platform-policy">
              <option value="skip" ${cfg?.platform_policy !== "fallback" ? "selected" : ""}>Skip device (report in sync summary)</option>
              <option value="fallback" ${cfg?.platform_policy === "fallback" ? "selected" : ""}>Treat as fallback platform</option>
            </select>
            <span class="import-hint">Known NetBox platform slugs (cisco-ios, nx-os, f5-tmos, ubuntu, …) map automatically. Devices with no platform use this policy too.</span>
          </div>
          <div class="import-field" id="netbox-fallback-field"${cfg?.platform_policy === "fallback" ? "" : " hidden"}>
            <label for="netbox-platform-fallback">Fallback platform</label>
            <select class="form-input" id="netbox-platform-fallback">
              ${platformOpt("cisco-iosxe", "Cisco IOS-XE")}
              ${platformOpt("cisco-nxos", "Cisco NX-OS")}
              ${platformOpt("f5-tmos", "F5 TMOS")}
              ${platformOpt("linux-bash", "Linux Bash")}
            </select>
          </div>
          <div class="import-field">
            <label for="netbox-platform-overrides">Platform overrides</label>
            <textarea class="form-input" id="netbox-platform-overrides" rows="3"
                      placeholder="juniper-junos=linux-bash">${escHtml(overridesText)}</textarea>
            <span class="import-hint">One per line: netbox-slug=platform. Wins over the built-in table.</span>
          </div>

          <h3 class="settings-section-title">Default Authentication</h3>
          <span class="import-hint">Applied to every synced device unless a device has its own overlay (Configure). Username and port are always inherited per-device.</span>
          <div class="import-field">
            <label for="netbox-default-username">Username</label>
            <input type="text" class="form-input" id="netbox-default-username" placeholder="e.g. netadmin"
                   autocomplete="off" value="${this.escAttr(cfg?.default_username ?? "")}" />
          </div>
          <div class="import-field">
            <label for="netbox-default-port">Port</label>
            <input type="number" class="form-input" id="netbox-default-port" min="1" max="65535"
                   value="${cfg?.default_port ?? 22}" />
          </div>
          <fieldset class="form-auth-group">
            <legend>Authentication</legend>
            <label class="radio-label">
              <input type="radio" name="netbox_auth_type" value="none" ${authType === "none" ? "checked" : ""} />
              None
            </label>
            <label class="radio-label">
              <input type="radio" name="netbox_auth_type" value="password" ${authType === "password" ? "checked" : ""} />
              Password
            </label>
            <label class="radio-label">
              <input type="radio" name="netbox_auth_type" value="ssh_key" ${authType === "ssh_key" ? "checked" : ""} />
              SSH Key
            </label>
            <label class="radio-label">
              <input type="radio" name="netbox_auth_type" value="agent" ${authType === "agent" ? "checked" : ""} />
              SSH Agent
            </label>
            <label class="radio-label">
              <input type="radio" name="netbox_auth_type" value="secret_ref" ${authType === "secret_ref" ? "checked" : ""} />
              Secret Manager
            </label>
          </fieldset>
          <div id="netbox-auth-password-field" class="auth-conditional ${authType === "password" ? "" : "auth-conditional-hidden"}">
            <label>
              <span>Password ${this.netboxHasDefaultPw() ? `<span class="cred-badge">${icons.lock} Saved</span>` : ""}</span>
              <input type="password" class="form-input" id="netbox-default-password"
                     placeholder="${this.netboxHasDefaultPw() ? "Leave blank to keep saved password" : "Enter default password"}"
                     autocomplete="off" />
            </label>
          </div>
          <div id="netbox-auth-key-field" class="auth-conditional ${authType === "ssh_key" ? "" : "auth-conditional-hidden"}">
            <label>
              <span>SSH Key Path</span>
              <input type="text" class="form-input" id="netbox-default-key" placeholder="~/.ssh/id_rsa"
                     value="${this.escAttr(cred?.type === "ssh_key" ? cred.key_path : "")}" />
            </label>
          </div>
          <div id="netbox-auth-agent-field" class="auth-conditional ${authType === "agent" ? "" : "auth-conditional-hidden"}">
            <label>
              <span>Identity fingerprint</span>
              <input type="text" class="form-input" id="netbox-default-agent" placeholder="Blank = offer all identities"
                     spellcheck="false" autocomplete="off"
                     value="${this.escAttr(cred?.type === "agent" ? (cred.identity ?? "") : "")}" />
            </label>
          </div>
          <div id="netbox-auth-secretref-field" class="auth-conditional auth-conditional-tall ${authType === "secret_ref" ? "" : "auth-conditional-hidden"}">
            <label>
              <span>Provider</span>
              <select class="form-input" id="netbox-default-ref-provider">
                ${readyProviders.length > 0
                  ? readyProviders.map(providerOpt).join("")
                  : `<option value="">No secret managers ready</option>`}
              </select>
            </label>
            <label>
              <span>Reference</span>
              <input type="text" class="form-input" id="netbox-default-ref-reference" placeholder="Item reference"
                     spellcheck="false" autocomplete="off"
                     value="${this.escAttr(cred?.type === "secret_ref" ? cred.reference : "")}" />
            </label>
            ${readyProviders.length === 0 ? `<div class="import-hint">Enable a secret manager in Settings → Auth Integrations first.</div>` : ""}
          </div>

          <div class="settings-actions">
            <button type="button" class="btn-secondary" id="netbox-sync-btn">${icons.folder} Refresh Now</button>
          </div>

          <h3 class="settings-section-title">Devices</h3>
          <div class="import-field">
            <input type="text" class="form-input" id="netbox-device-search" placeholder="Search devices…"
                   value="${this.escAttr(this.netboxDeviceSearch)}" />
            <span class="import-hint" id="netbox-status-line">${this.netboxStatusLine()}</span>
          </div>
          <div class="netbox-device-list" id="netbox-device-list">${this.renderNetBoxDeviceList()}</div>
        </div>
      </div>
    `;
  }

  private netboxHasDefaultPw(): boolean {
    return this.netboxConfig?.default_credential?.type === "password" && this.netboxDefaultPwSaved;
  }

  private netboxStatusLine(): string {
    const devices = this.netboxDevices;
    if (!this.netboxConfig?.enabled) return "Disabled — enable above, then Refresh to sync devices.";
    if (devices.length === 0) return "No devices cached — click Refresh Now to sync from NetBox.";
    const enabledCount = devices.filter((d) => d.enabled).length;
    const lastSynced = this.netboxLastSynced ? relativeTime(this.netboxLastSynced) : "never";
    return `${devices.length} device${devices.length !== 1 ? "s" : ""} cached (${enabledCount} enabled) · last synced ${lastSynced}`;
  }

  private renderNetBoxDeviceList(): string {
    const q = this.netboxDeviceSearch.toLowerCase().trim();
    const devices = this.netboxDevices.filter((d) => {
      if (!q) return true;
      return (
        d.name.toLowerCase().includes(q) ||
        d.address.toLowerCase().includes(q) ||
        (d.site ?? "").toLowerCase().includes(q) ||
        (d.location ?? "").toLowerCase().includes(q) ||
        d.platform.toLowerCase().includes(q) ||
        d.tags.some((t) => t.toLowerCase().includes(q))
      );
    });
    if (devices.length === 0) {
      return `<p class="settings-placeholder">No cached devices${q ? " match the search" : ""}.</p>`;
    }
    return devices
      .map((d) => {
        const meta = [
          d.address,
          [d.site, d.location].filter(Boolean).join(" / "),
          d.status,
        ]
          .filter((s) => s)
          .join(" · ");
        return `
          <div class="netbox-device-row${d.enabled ? "" : " netbox-device-disabled"}">
            <input type="checkbox" data-netbox-device="${d.netbox_id}" ${d.enabled ? "checked" : ""}
                   aria-label="Enable ${escHtml(d.name)}" />
            <span class="hs-host-badge ${platformColorClass(d.platform)}">[${escHtml(platformBadge(d.platform))}]</span>
            <div class="netbox-device-info">
              <span class="netbox-device-name">${escHtml(d.name)}</span>
              <span class="netbox-device-meta">${escHtml(meta)}</span>
            </div>
          </div>`;
      })
      .join("");
  }

  private async loadProviders() {
    try {
      const infos = await listProviders();
      this.providerStatuses = new Map(infos.map((p) => [p.id, p]));
    } catch {
      this.providerStatuses = new Map();
    }
    const states = await Promise.all(
      PROVIDER_CATALOG.filter((p) => p.available).map(async (p) => {
        try {
          return [p.id, await getProviderState(p.id)] as const;
        } catch {
          return [p.id, { enabled: false, has_secret: false }] as const;
        }
      }),
    );
    this.providerStates = new Map(states);
  }

  private renderAuth(): string {
    return `
      <div class="settings-form">
        <div class="provider-refresh-row">
          <button type="button" class="btn-link" id="providers-refresh">Refresh status</button>
        </div>
        ${PROVIDER_CATALOG.map((p) => this.renderProviderCard(p)).join("")}
      </div>
    `;
  }

  private renderProviderCard(p: ProviderCatalogEntry): string {
    const state = this.providerStates.get(p.id) ?? { enabled: false, has_secret: false };
    const disabled = !p.available;
    return `
      <div class="provider-card${disabled ? " provider-card-disabled" : ""}">
        <div class="provider-card-head">
          <span class="provider-name">${icons.lock}${escHtml(p.name)}</span>
          <label class="provider-toggle">
            <input type="checkbox" data-provider-toggle="${p.id}" ${state.enabled ? "checked" : ""} ${disabled ? "disabled" : ""} />
            Enable
          </label>
        </div>
        <div class="provider-status-row">${this.providerStatusLine(p)}</div>
        ${!disabled && p.fields.includes("pat") ? `
          <div class="import-field provider-pat-field">
            <label for="pat-${p.id}">Personal Access Token</label>
            <div class="log-file-row">
              <input type="password" class="form-input" id="pat-${p.id}"
                placeholder="${state.has_secret ? "Saved — enter a new token to replace" : "pt_..."}"
                autocomplete="off" spellcheck="false" />
              <button type="button" class="btn-secondary" data-provider-save-pat="${p.id}">Save</button>
            </div>
            <span class="import-hint">Create a Personal Access Token in Proton Pass. Paste it here. If you use an interactive pass-cli login session, leave this field empty.</span>
          </div>
        ` : ""}
      </div>
    `;
  }

  private providerStatusLine(p: ProviderCatalogEntry): string {
    if (!p.available) return '<span class="provider-status provider-status-soon">Coming soon</span>';
    const info = this.providerStatuses.get(p.id);
    if (info) {
      switch (info.status.kind) {
        case "ready":
          return '<span class="provider-status provider-status-ok">Ready</span>';
        case "not_installed":
          return `<span class="provider-status provider-status-err">${escHtml(info.status.message)}</span>`;
        case "auth_expired":
          return `<span class="provider-status provider-status-warn">${escHtml(info.status.action)}</span>`;
        case "error":
          return `<span class="provider-status provider-status-err">${escHtml(info.status.message)}</span>`;
      }
    }
    const state = this.providerStates.get(p.id);
    return state?.enabled
      ? '<span class="provider-status">Enabled</span>'
      : '<span class="provider-status">Off</span>';
  }

  private renderPlaceholder(label: string): string {
    return `<p class="settings-placeholder">Coming soon — ${escHtml(label)} settings are not implemented yet.</p>`;
  }

  private bindEvents() {
    this.container?.querySelector<HTMLInputElement>("#search-tags")?.addEventListener("change", (e) => {
      setSearchIncludeTags((e.target as HTMLInputElement).checked);
    });

    this.container?.querySelector<HTMLInputElement>("#auto-copy")?.addEventListener("change", (e) => {
      setAutoCopyEnabled((e.target as HTMLInputElement).checked);
    });

    this.container?.querySelector<HTMLInputElement>("#output-highlight")?.addEventListener("change", (e) => {
      setOutputHighlightEnabled((e.target as HTMLInputElement).checked);
    });

    this.container?.querySelector<HTMLSelectElement>("#ts-format")?.addEventListener("change", (e) => {
      setTimestampFormat((e.target as HTMLSelectElement).value as TimestampFormat);
    });

    this.container?.querySelector<HTMLSelectElement>("#log-level")?.addEventListener("change", (e) => {
      void setLogLevel((e.target as HTMLSelectElement).value);
    });

    this.container?.querySelector<HTMLSelectElement>("#log-max-size")?.addEventListener("change", (e) => {
      void setLogMaxSize(parseInt((e.target as HTMLSelectElement).value, 10));
    });

    this.container?.querySelector<HTMLSelectElement>("#max-sessions")?.addEventListener("change", (e) => {
      void setMaxSessions(parseInt((e.target as HTMLSelectElement).value, 10));
    });

    this.container?.querySelector<HTMLInputElement>("#session-logging")?.addEventListener("change", (e) => {
      void setSessionLogging((e.target as HTMLInputElement).checked);
    });

    this.container?.querySelector<HTMLInputElement>("#session-log-timestamps")?.addEventListener("change", (e) => {
      void setSessionLogTimestamps((e.target as HTMLInputElement).checked);
    });

    this.container?.querySelector<HTMLInputElement>("#session-log-dir")?.addEventListener("change", (e) => {
      const v = (e.target as HTMLInputElement).value.trim();
      void setSessionLogDir(v || null).then(() => this.refreshConfig()).catch(() => {
        showToast("Failed to save session log directory", "error");
      });
    });

    this.container?.querySelector<HTMLInputElement>("#session-log-dir")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void this.browseSessionLogDir();
    });

    this.container?.querySelector<HTMLButtonElement>("#session-log-dir-reset")?.addEventListener("click", () => {
      const input = this.container?.querySelector<HTMLInputElement>("#session-log-dir");
      if (input) input.value = "";
      void setSessionLogDir(null).then(() => this.refreshConfig()).catch(() => {
        showToast("Failed to reset session log directory", "error");
      });
    });

    this.container?.querySelector<HTMLButtonElement>("#session-log-dir-browse")?.addEventListener("click", () => void this.browseSessionLogDir());

    this.container?.querySelector<HTMLButtonElement>("#data-export")?.addEventListener("click", () => void this.exportData());
    this.container?.querySelector<HTMLButtonElement>("#data-import")?.addEventListener("click", () => void this.importData());

    this.container?.querySelector<HTMLInputElement>("#log-file-path")?.addEventListener("change", (e) => {
      const v = (e.target as HTMLInputElement).value.trim();
      void setLogFilePath(v || null).then(() => this.refreshConfig()).catch(() => {
        showToast("Failed to save log file path", "error");
      });
    });

    this.container?.querySelector<HTMLInputElement>("#log-file-path")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void this.browseLogFile();
    });

    this.container?.querySelector<HTMLButtonElement>("#log-file-reset")?.addEventListener("click", () => {
      const input = this.container?.querySelector<HTMLInputElement>("#log-file-path");
      if (input) input.value = "";
      void setLogFilePath(null).then(() => this.refreshConfig()).catch(() => {
        showToast("Failed to reset log file path", "error");
      });
    });

    this.container?.querySelector<HTMLButtonElement>("#log-file-browse")?.addEventListener("click", () => void this.browseLogFile());

    const form = this.container?.querySelector<HTMLElement>("#ollama-settings-form");
    if (form) {
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        void this.saveSettings();
      });
    }

    this.container?.querySelector<HTMLElement>("#ollama-test-btn")?.addEventListener("click", () => void this.testConnection());

    this.container?.querySelector<HTMLSelectElement>("#ollama-model-select")?.addEventListener("change", (e) => {
      const model = (e.target as HTMLSelectElement).value;
      const modelInput = this.container?.querySelector<HTMLInputElement>("#ollama-model");
      if (modelInput) modelInput.value = model;
    });

    this.container?.querySelector<HTMLSelectElement>("#theme-app")?.addEventListener("change", (e) => {
      setAppTheme((e.target as HTMLSelectElement).value as Theme);
    });

    this.container?.querySelector<HTMLElement>("#providers-refresh")?.addEventListener("click", () => {
      void this.loadProviders().then(() => this.render());
    });

    this.container?.querySelectorAll<HTMLInputElement>("[data-provider-toggle]").forEach((el) => {
      el.addEventListener("change", () => {
        const id = el.dataset.providerToggle!;
        // ponytail: config saved as { enabled } only — replaces any other keys for this provider; merge when chunk 8+ adds per-provider fields
        void saveProviderConfig(id, { enabled: el.checked })
          .then(() => showToast(`${id} ${el.checked ? "enabled" : "disabled"}`, "success"))
          .catch((e) => showToast(`Failed to update ${id}: ${e}`, "error"));
      });
    });

    this.container?.querySelectorAll<HTMLButtonElement>("[data-provider-save-pat]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.providerSavePat!;
        const input = this.container?.querySelector<HTMLInputElement>(`#pat-${id}`);
        const value = (input?.value ?? "").trim();
        void saveProviderSecret(id, value || null)
          .then(async () => {
            showToast(value ? "Token saved" : "Token cleared", "success");
            await this.loadProviders();
            this.render();
          })
          .catch((e) => showToast(`Failed to save token: ${e}`, "error"));
      });
    });

    // ─── NetBox bindings (plan §9.2) ──────────────────────────────

    // Enable toggle + every non-URL/non-token field auto-saves on change/blur.
    // The URL and token are committed via the Save Connection button only.
    // NOTE: #netbox-enabled is NOT here — it has its own handler below that
    // saves only the toggle, merged onto the saved config.
    const autosaveFields = [
      "#netbox-invalid-certs",
      "#netbox-filter-status", "#netbox-filter-sites", "#netbox-filter-roles", "#netbox-filter-tags",
      "#netbox-platform-policy", "#netbox-platform-fallback", "#netbox-platform-overrides",
      "#netbox-default-username", "#netbox-default-port", "#netbox-default-key",
      "#netbox-default-agent", "#netbox-default-ref-provider", "#netbox-default-ref-reference",
      "#netbox-default-password",
    ];
    autosaveFields.forEach((sel) => {
      const el = this.container?.querySelector<HTMLElement>(sel);
      if (!el) return;
      const ev = el.tagName === "TEXTAREA" || el.tagName === "INPUT" ? "change" : "change";
      el.addEventListener(ev, () => void this.autosaveNetboxConfig());
    });

    // Multi-select filter wiring (sites / roles / tags)
    this.container?.querySelectorAll<HTMLElement>(".ms-wrap").forEach((wrap) => {
      const fieldId = wrap.dataset.msField!;
      const searchInput = wrap.querySelector<HTMLInputElement>(".ms-search");
      const chipsEl = wrap.querySelector<HTMLElement>(".ms-chips");
      const listEl = wrap.querySelector<HTMLUListElement>(".ms-dropdown");
      if (!searchInput || !chipsEl || !listEl) return;

      const getHidden = () => this.container?.querySelector<HTMLInputElement>(`#${fieldId}`);
      const getSelected = (): string[] => {
        const v = getHidden()?.value ?? "";
        return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];
      };
      const setSelected = (slugs: string[]) => {
        const hidden = getHidden();
        if (hidden) hidden.value = slugs.join(",");
        this.updateMsChips(chipsEl, listEl, slugs);
        hidden?.dispatchEvent(new Event("change"));
      };

      searchInput.addEventListener("focus", () => {
        listEl.classList.add("ms-dropdown-open");
        this.filterMsList(listEl, "");
      });
      searchInput.addEventListener("input", () => {
        listEl.classList.add("ms-dropdown-open");
        this.filterMsList(listEl, searchInput.value);
      });
      searchInput.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          listEl.classList.remove("ms-dropdown-open");
          searchInput.blur();
        }
      });

      listEl.addEventListener("click", (e) => {
        const li = (e.target as HTMLElement).closest<HTMLLIElement>(".ms-item");
        if (!li) return;
        const slug = li.dataset.msSlug!;
        const sel = getSelected();
        const idx = sel.indexOf(slug);
        if (idx >= 0) {
          sel.splice(idx, 1);
          li.classList.remove("ms-item-selected");
        } else {
          sel.push(slug);
          li.classList.add("ms-item-selected");
        }
        setSelected(sel);
      });

      chipsEl.addEventListener("click", (e) => {
        const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".ms-chip-x");
        if (!btn) return;
        const chip = btn.closest<HTMLElement>(".ms-chip");
        const slug = chip?.dataset.msSlug;
        if (!slug) return;
        const sel = getSelected().filter((s) => s !== slug);
        const li = listEl.querySelector<HTMLLIElement>(`[data-ms-slug="${CSS.escape(slug)}"]`);
        li?.classList.remove("ms-item-selected");
        setSelected(sel);
      });

      // Close dropdown on outside click
      document.addEventListener("click", (e) => {
        if (!wrap.contains(e.target as Node)) {
          listEl.classList.remove("ms-dropdown-open");
          searchInput.value = "";
          this.filterMsList(listEl, "");
        }
      });
    });
    // Fallback platform select is only meaningful when policy = fallback.
    this.container?.querySelector<HTMLSelectElement>("#netbox-platform-policy")?.addEventListener("change", (e) => {
      const on = (e.target as HTMLSelectElement).value === "fallback";
      const field = this.container?.querySelector<HTMLElement>("#netbox-fallback-field");
      if (field) field.hidden = !on;
    });

    // Enable toggle also flips the live disabled styling — autosave never
    // re-renders, so without this the form stays greyed out until reload.
    // It saves ONLY the toggle merged onto the saved config: never collect
    // the whole form here, a stale read would persist enabled=false.
    this.container?.querySelector<HTMLInputElement>("#netbox-enabled")?.addEventListener("change", async (e) => {
      const on = (e.target as HTMLInputElement).checked;
      this.container?.querySelector<HTMLElement>(".netbox-body")?.classList.toggle("netbox-body-disabled", !on);
      const saved = this.netboxConfig;
      if (!saved) return;
      try {
        this.netboxConfig = await netboxSaveConfig({ ...saved, enabled: on }, null);
        log.debug(LogTag.Netbox, "enable toggle saved", { enabled: on });
        this.onTreeChanged();
      } catch (err) {
        log.error(LogTag.Netbox, "enable toggle save failed", err);
        showToast(`Failed to save NetBox settings: ${err}`, "error", 8000);
      }
    });
    // Auth radios
    this.container?.querySelectorAll<HTMLInputElement>('input[name="netbox_auth_type"]').forEach((radio) => {
      radio.addEventListener("change", () => {
        this.updateNetboxAuthVisibility();
        void this.autosaveNetboxConfig();
      });
    });

    this.container?.querySelector<HTMLButtonElement>("#netbox-test-btn")?.addEventListener("click", () => {
      void this.testNetboxConnection();
    });

    // Reset the stale "test ok" state whenever the URL, token, or TLS toggle
    // changes — the previous test result no longer applies.
    const resetTest = () => {
      if (this.netboxTestOk || this.netboxTestLine) {
        this.netboxTestOk = false;
        this.netboxTestLine = null;
        this.updateNetboxTestUi();
      }
    };
    this.container?.querySelector<HTMLInputElement>("#netbox-url")?.addEventListener("input", resetTest);
    this.container?.querySelector<HTMLInputElement>("#netbox-token")?.addEventListener("input", resetTest);

    this.container?.querySelector<HTMLButtonElement>("#netbox-token-save")?.addEventListener("click", () => {
      void this.saveConnection();
    });

    this.container?.querySelector<HTMLButtonElement>("#netbox-sync-btn")?.addEventListener("click", () => {
      void this.syncNetbox();
    });

    this.container?.querySelector<HTMLInputElement>("#netbox-device-search")?.addEventListener("input", (e) => {
      this.netboxDeviceSearch = (e.target as HTMLInputElement).value;
      const list = this.container?.querySelector<HTMLElement>("#netbox-device-list");
      if (list) list.innerHTML = this.renderNetBoxDeviceList();
      this.bindNetboxDeviceToggles();
    });

    this.bindNetboxDeviceToggles();
  }

  private bindNetboxDeviceToggles() {
    this.container?.querySelectorAll<HTMLInputElement>("[data-netbox-device]").forEach((el) => {
      el.addEventListener("change", () => {
        const id = parseInt(el.dataset.netboxDevice!, 10);
        const enabled = el.checked;
        el.closest(".netbox-device-row")?.classList.toggle("netbox-device-disabled", !enabled);
        void netboxSetDeviceEnabled(id, enabled)
          .then(() => {
            const d = this.netboxDevices.find((x) => x.netbox_id === id);
            if (d) d.enabled = enabled;
            const line = this.container?.querySelector<HTMLElement>("#netbox-status-line");
            if (line) line.textContent = this.netboxStatusLine();
            this.onTreeChanged();
          })
          .catch((e) => showToast(`Failed to update device: ${e}`, "error"));
      });
    });
  }

  private updateNetboxAuthVisibility() {
    const selected = this.container?.querySelector<HTMLInputElement>('input[name="netbox_auth_type"]:checked');
    const type = selected?.value ?? "none";
    const show = (id: string, on: boolean) => {
      const el = this.container?.querySelector<HTMLElement>(id);
      el?.classList.toggle("auth-conditional-hidden", !on);
    };
    show("#netbox-auth-password-field", type === "password");
    show("#netbox-auth-key-field", type === "ssh_key");
    show("#netbox-auth-agent-field", type === "agent");
    show("#netbox-auth-secretref-field", type === "secret_ref");
  }

  /** Read the NetBox form into a config for auto-save. The URL always comes
   *  from the saved config — it only changes via Save Connection. */
  private collectNetboxConfig(): { config: NetBoxConfig; password: string | null } {
    const q = (id: string) => this.container?.querySelector<HTMLInputElement>(id);
    const val = (id: string) => (q(id)?.value ?? "").trim();
    const listVal = (id: string) =>
      val(id)
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s);
    const authType =
      this.container?.querySelector<HTMLInputElement>('input[name="netbox_auth_type"]:checked')?.value ?? "none";
    const keyPath = val("netbox-default-key");
    const agentIdentity = val("netbox-default-agent");
    const refProvider = this.container?.querySelector<HTMLSelectElement>("#netbox-default-ref-provider")?.value ?? "";
    const refReference = val("netbox-default-ref-reference");

    const overrides: Record<string, string> = {};
    for (const line of (this.container?.querySelector<HTMLTextAreaElement>("#netbox-platform-overrides")?.value ?? "").split("\n")) {
      const idx = line.indexOf("=");
      if (idx <= 0) continue;
      const slug = line.slice(0, idx).trim();
      const platform = line.slice(idx + 1).trim();
      if (slug && platform) overrides[slug] = platform;
    }

    const credential =
      authType === "password"
        ? { type: "password" as const }
        : authType === "ssh_key"
          ? { type: "ssh_key" as const, key_path: keyPath }
          : authType === "agent"
            ? { type: "agent" as const, identity: agentIdentity || null }
            : authType === "secret_ref"
              ? { type: "secret_ref" as const, provider: refProvider, reference: refReference, label: null }
              : null;

    const status = val("netbox-filter-status");
    const config: NetBoxConfig = {
      enabled: !!q("netbox-enabled")?.checked,
      // URL: from the field on explicit Save Connection, from saved config on
      // auto-save (so an unsaved/half-typed URL never sneaks into config.json).
      base_url: this.netboxConfig?.base_url ?? "",
      filters: {
        status: status || null,
        sites: listVal("netbox-filter-sites"),
        roles: listVal("netbox-filter-roles"),
        tags: listVal("netbox-filter-tags"),
      },
      platform_policy:
        this.container?.querySelector<HTMLSelectElement>("#netbox-platform-policy")?.value ?? "skip",
      platform_fallback:
        this.container?.querySelector<HTMLSelectElement>("#netbox-platform-fallback")?.value || null,
      platform_overrides: overrides,
      default_username: val("netbox-default-username") || null,
      default_port: parseInt(val("netbox-default-port"), 10) || 22,
      default_credential: credential,
      allow_invalid_certs: !!q("netbox-invalid-certs")?.checked,
    };
    const password = val("netbox-default-password") || null;
    return { config, password };
  }

  /** Silent config write for the auto-save fields (enable, filters, platform,
   *  default auth, certs). The URL is taken from the saved config, not the
   *  field — it only changes via Save Connection. No toast, no re-render. */
  private async autosaveNetboxConfig(): Promise<void> {
    if (!this.container?.querySelector("#netbox-enabled")) return;
    const { config, password } = this.collectNetboxConfig();
    log.debug(LogTag.Netbox, "autosave fired", { enabled: config.enabled, base_url: config.base_url });
    try {
      this.netboxConfig = await netboxSaveConfig(config, password);
      log.debug(LogTag.Netbox, "autosave saved ok", { enabled: this.netboxConfig.enabled });
      if (config.default_credential?.type !== "password") this.netboxDefaultPwSaved = false;
    } catch (e) {
      log.error(LogTag.Netbox, "autosave failed", e);
      showToast(`Failed to save NetBox settings: ${e}`, "error", 8000);
    }
  }

  /** Save Connection — commits the URL (to config.json) and, if a new token was
   *  entered, the token (to the keyring). Only enabled after a successful Test. */
  private async saveConnection(): Promise<void> {
    const tokenInput = this.container?.querySelector<HTMLInputElement>("#netbox-token");
    const newToken = (tokenInput?.value ?? "").trim();
    try {
      // Commit ONLY the field URL onto the saved config. Never collect the
      // whole form here — a stale DOM read would persist enabled=false /
      // empty fields (bug: "Sync failed: NetBox integration is disabled").
      const fieldUrl = (this.container?.querySelector<HTMLInputElement>("#netbox-url")?.value ?? "").trim();
      const saved = this.netboxConfig ?? {
        enabled: false,
        base_url: "",
        filters: { status: null, sites: [], roles: [], tags: [] },
        platform_policy: "skip",
        platform_fallback: null,
        platform_overrides: {},
        default_username: null,
        default_port: 22,
        default_credential: null,
        allow_invalid_certs: false,
      };
      const config: NetBoxConfig = { ...saved, base_url: fieldUrl.trim() };
      const password = (this.container?.querySelector<HTMLInputElement>("#netbox-default-password")?.value ?? "").trim() || null;
      this.netboxConfig = await netboxSaveConfig(config, password);
      if (config.default_credential?.type !== "password") this.netboxDefaultPwSaved = false;
      // Token: only write when a new one was entered (blank = keep stored).
      if (newToken) {
        await netboxSaveToken(newToken);
        this.netboxHasToken = true;
      }
      log.info(LogTag.Netbox, "Connection saved", { base_url: this.netboxConfig?.base_url, token_updated: !!newToken });
      showToast("Connection saved", "success");
      if (tokenInput) {
        tokenInput.value = "";
        tokenInput.placeholder = "Saved — enter a new token to replace";
      }
      // Connection committed — the validated test result is now stale.
      this.netboxTestOk = false;
      this.netboxTestLine = null;
      this.updateNetboxTestUi();
    } catch (e) {
      log.error(LogTag.Netbox, "Save connection failed", e);
      showToast(`Failed to save connection: ${e}`, "error", 8000);
    }
  }

  private updateNetboxTestUi(): void {
    const status = this.container?.querySelector<HTMLElement>("#netbox-test-status");
    if (status && this.netboxTestLine) {
      status.textContent = this.netboxTestLine.text;
      status.className = `import-model-info ${this.netboxTestLine.ok ? "import-test-ok" : "import-test-err"}`;
    } else if (status) {
      status.textContent = "";
      status.className = "import-model-info";
    }
    const saveBtn = this.container?.querySelector<HTMLButtonElement>("#netbox-token-save");
    if (saveBtn) {
      saveBtn.disabled = !this.netboxTestOk;
      saveBtn.classList.toggle("netbox-save-token-ready", this.netboxTestOk);
    }
  }

  private async testNetboxConnection() {
    const btn = this.container?.querySelector<HTMLButtonElement>("#netbox-test-btn");
    const status = this.container?.querySelector<HTMLElement>("#netbox-test-status");
    const baseUrl = (this.container?.querySelector<HTMLInputElement>("#netbox-url")?.value ?? "").trim();
    const tokenField = this.container?.querySelector<HTMLInputElement>("#netbox-token");
    const tokenRaw = (tokenField?.value ?? "").trim();
    const token = tokenRaw || null;
    const allowInvalidCerts = !!this.container?.querySelector<HTMLInputElement>("#netbox-invalid-certs")?.checked;
    if (!baseUrl) {
      this.netboxTestLine = { text: "Enter a NetBox URL first", ok: false };
      this.netboxTestOk = false;
      this.updateNetboxTestUi();
      return;
    }
    if (btn) btn.disabled = true;
    if (status) {
      status.textContent = "Testing…";
      status.className = "import-model-info import-test-progress";
    }
    try {
      const result = await netboxTestConnection(baseUrl, token, allowInvalidCerts);
      log.info(LogTag.Netbox, "Test connection ok", { base_url: baseUrl, version: result.version, device_count: result.device_count });
      this.netboxTestLine = {
        text: `Connected — NetBox API ${result.version}, ${result.device_count} devices`,
        ok: true,
      };
      // Enable Save Connection — the user may have changed the URL and/or
      // entered a new token. Both deserve an explicit commit.
      this.netboxTestOk = true;
    } catch (e) {
      log.error(LogTag.Netbox, "Test connection failed", { base_url: baseUrl, error: String(e) });
      this.netboxTestLine = { text: `Connection failed: ${e}`, ok: false };
      this.netboxTestOk = false;
    } finally {
      if (btn) btn.disabled = false;
      this.updateNetboxTestUi();
    }
  }

  private async syncNetbox() {
    const btn = this.container?.querySelector<HTMLButtonElement>("#netbox-sync-btn");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Syncing…";
    }
    try {
      const report = await netboxSync();
      log.info(LogTag.Netbox, "Sync complete", { fetched: report.fetched, no_primary_ip: report.no_primary_ip, skipped_platform: report.skipped_platform });
      const parts = [`Synced ${report.fetched} device${report.fetched !== 1 ? "s" : ""}`];
      if (report.no_primary_ip > 0) parts.push(`${report.no_primary_ip} without primary IP`);
      if (report.skipped_platform > 0) {
        const slugs = report.unmatched_platforms.join(", ");
        parts.push(`${report.skipped_platform} skipped (unknown platform${slugs ? ` ${slugs}` : ""})`);
      }
      showToast(parts.join(" · "), "success", 8000);
      await this.loadNetbox();
      this.render();
      this.onTreeChanged();
    } catch (e) {
      log.error(LogTag.Netbox, "Sync failed", e);
      showToast(`Sync failed: ${e}`, "error", 8000);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = `${icons.folder} Refresh Now`;
      }
    }
  }

  private async refreshConfig() {
    try {
      this.config = await getAppConfig();
    } catch {
      // keep existing config
    }
  }

  private async browseLogFile(): Promise<void> {
    try {
      const selected = await save({
        defaultPath: "netssh.log",
        filters: [{ name: "Log files", extensions: ["log"] }],
      });
      if (selected) {
        const input = this.container?.querySelector<HTMLInputElement>("#log-file-path");
        if (input) input.value = selected;
        await setLogFilePath(selected);
        await this.refreshConfig();
      }
    } catch {
      // User cancelled — no-op.
    }
  }

  private async browseSessionLogDir(): Promise<void> {
    try {
      const selected = await open({ directory: true });
      if (selected) {
        const input = this.container?.querySelector<HTMLInputElement>("#session-log-dir");
        if (input) input.value = selected;
        await setSessionLogDir(selected);
        await this.refreshConfig();
      }
    } catch {
      // User cancelled — no-op.
    }
  }

  private async exportData(): Promise<void> {
    try {
      const dest = await save({
        defaultPath: "netssh-backup.zip",
        filters: [{ name: "Backup files", extensions: ["zip"] }],
      });
      if (!dest) return;
      await exportData(dest);
      showToast("Backup exported successfully", "success");
    } catch (e) {
      showToast(`Export failed: ${e}`, "error", 8000);
    }
  }

  private async importData(): Promise<void> {
    try {
      const src = await open({
        filters: [{ name: "Backup files", extensions: ["zip"] }],
        multiple: false,
      });
      if (!src || typeof src !== "string") return;
      this.showImportModeDialog(src);
    } catch (e) {
      showToast(`Restore failed: ${e}`, "error", 8000);
    }
  }

  private showImportModeDialog(srcPath: string): void {
    const overlay = document.createElement("div");
    overlay.className = "modal-backdrop";
    overlay.innerHTML = `
      <div class="modal-panel" role="dialog" aria-modal="true" aria-labelledby="restore-mode-title" style="max-width: 480px;">
        <h3 id="restore-mode-title" style="font-size: var(--font-size-xl); margin-bottom: var(--space-3);">Restore backup</h3>
        <p style="color: var(--color-text-secondary); margin-bottom: var(--space-4); line-height: 1.5;">
          Choose how to restore from <strong style="color: var(--color-text-primary);">${escHtml(srcPath.split(/[\\/]/).pop() ?? srcPath)}</strong>:
        </p>
        <div style="display: flex; flex-direction: column; gap: var(--space-3);">
          <button class="btn-primary" id="import-overwrite" style="display: flex; flex-direction: column; gap: var(--space-1); padding: var(--space-3) var(--space-4); text-align: left;">
            <span>Overwrite everything</span>
            <span class="import-hint">Replaces all current data with the backup. Files not in the backup are deleted.</span>
          </button>
          <button class="btn-secondary" id="import-merge" style="display: flex; flex-direction: column; gap: var(--space-1); padding: var(--space-3) var(--space-4); text-align: left;">
            <span>Merge</span>
            <span class="import-hint">Combines current and backup data. You'll review any conflicts before anything is changed.</span>
          </button>
          <button class="btn-text" id="import-cancel" style="align-self: center;">Cancel</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector<HTMLButtonElement>("#import-cancel")?.addEventListener("click", close);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    overlay.querySelector<HTMLButtonElement>("#import-overwrite")?.addEventListener("click", () => {
      close();
      void this.doOverwrite(srcPath);
    });
    overlay.querySelector<HTMLButtonElement>("#import-merge")?.addEventListener("click", () => {
      close();
      void this.doMerge(srcPath);
    });
  }

  /**
   * Success toast after a restore. Release builds get a working "Restart now"
   * button; dev builds can't self-restart (the Vite dev server dies with the
   * original process, leaving the new webview at a dead devUrl) — so dev
   * shows instructions instead of a button.
   */
  private restoreSuccessToast(msg: string): void {
    if (import.meta.env.DEV) {
      showToast(`${msg}. Restart manually: quit the app and re-run \`npm run tauri dev\`.`, "success", 12000);
    } else {
      showToastWithAction(`${msg}.`, "Restart now", () => void restartApp(), "success", 30000);
    }
  }

  private async doOverwrite(srcPath: string): Promise<void> {
    try {
      await importData(srcPath);
      this.restoreSuccessToast("Data overwritten");
    } catch (e) {
      showToast(`Restore failed: ${e}`, "error", 8000);
    }
  }

  private async doMerge(srcPath: string): Promise<void> {
    let scan;
    try {
      scan = await scanMerge(srcPath);
    } catch (e) {
      showToast(`Merge scan failed: ${e}`, "error", 8000);
      return;
    }

    if (scan.conflicts.length === 0) {
      // No conflicts — apply directly
      try {
        const msg = await applyMerge(scan.temp_dir, {});
        this.restoreSuccessToast(msg);
      } catch (e) {
        showToast(`Merge failed: ${e}`, "error", 8000);
      }
      return;
    }

    // Show conflict resolution dialog
    this.showConflictDialog(scan.temp_dir, scan.new_count, scan.conflicts);
  }

  private showConflictDialog(tempDir: string, newCount: number, conflicts: MergeConflict[]): void {
    const overlay = document.createElement("div");
    overlay.className = "modal-backdrop";

    // Group conflicts by file for readability
    const byFile = new Map<string, MergeConflict[]>();
    for (const c of conflicts) {
      if (!byFile.has(c.file)) byFile.set(c.file, []);
      byFile.get(c.file)!.push(c);
    }

    const conflictRows = conflicts.map((c, i) => `
      <div class="conflict-row" data-index="${i}" data-key="${escHtml(c.key)}">
        <div class="conflict-info">
          <span class="conflict-file">${escHtml(c.file)}</span>
          <div class="conflict-labels">
            <label class="conflict-option">
              <input type="radio" name="conflict-${i}" value="keep_current" checked />
              <span>Keep current: ${escHtml(c.current_label)}</span>
            </label>
            <label class="conflict-option">
              <input type="radio" name="conflict-${i}" value="use_backup" />
              <span>Use backup: ${escHtml(c.backup_label)}</span>
            </label>
          </div>
        </div>
      </div>
    `).join("");

    overlay.innerHTML = `
      <div class="modal-panel" role="dialog" aria-modal="true" aria-labelledby="merge-conflicts-title" style="max-width: 640px; max-height: 80vh; overflow-y: auto;">
        <h3 id="merge-conflicts-title" style="font-size: var(--font-size-xl); margin-bottom: var(--space-2);">Merge conflicts</h3>
        <p style="color: var(--color-text-secondary); margin-bottom: var(--space-3); line-height: 1.5;">
          ${newCount} new entries will be added. ${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"} need resolution:
        </p>
        <div style="display: flex; gap: var(--space-2); margin-bottom: var(--space-3);">
          <button class="btn-text" id="conflict-all-keep" style="font-size: var(--font-size-xs);">Keep all current</button>
          <button class="btn-text" id="conflict-all-backup" style="font-size: var(--font-size-xs);">Use all backup</button>
        </div>
        <div class="conflict-list" style="display: flex; flex-direction: column; gap: var(--space-3); margin-bottom: var(--space-4);">
          ${conflictRows}
        </div>
        <div style="display: flex; gap: var(--space-3); justify-content: flex-end;">
          <button class="btn-text" id="conflict-cancel">Cancel</button>
          <button class="btn-primary" id="conflict-apply">Apply merge</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();

    overlay.querySelector<HTMLButtonElement>("#conflict-cancel")?.addEventListener("click", close);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

    // "Apply to all" buttons
    overlay.querySelector<HTMLButtonElement>("#conflict-all-keep")?.addEventListener("click", () => {
      overlay.querySelectorAll<HTMLInputElement>('input[type="radio"][value="keep_current"]').forEach(r => r.checked = true);
    });
    overlay.querySelector<HTMLButtonElement>("#conflict-all-backup")?.addEventListener("click", () => {
      overlay.querySelectorAll<HTMLInputElement>('input[type="radio"][value="use_backup"]').forEach(r => r.checked = true);
    });

    // Apply button — collect resolutions and call applyMerge
    overlay.querySelector<HTMLButtonElement>("#conflict-apply")?.addEventListener("click", () => {
      const resolutions: Record<string, "keep_current" | "use_backup"> = {};
      conflicts.forEach((c, i) => {
        const selected = overlay.querySelector<HTMLInputElement>(`input[name="conflict-${i}"]:checked`);
        if (selected) {
          resolutions[c.key] = selected.value as "keep_current" | "use_backup";
        }
      });
      close();
      void this.applyMergeWithResolutions(tempDir, resolutions);
    });
  }

  private async applyMergeWithResolutions(
    tempDir: string,
    resolutions: Record<string, "keep_current" | "use_backup">,
  ): Promise<void> {
    try {
      const msg = await applyMerge(tempDir, resolutions);
      this.restoreSuccessToast(msg);
    } catch (e) {
      showToast(`Merge failed: ${e}`, "error", 8000);
    }
  }

  private escAttr(text: string): string {
    return text.replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  private async saveSettings() {
    const urlInput = this.container?.querySelector<HTMLInputElement>("#ollama-url");
    const modelInput = this.container?.querySelector<HTMLInputElement>("#ollama-model");
    const keyInput = this.container?.querySelector<HTMLInputElement>("#ollama-key");
    const ctxInput = this.container?.querySelector<HTMLInputElement>("#ollama-ctx");
    if (!urlInput || !modelInput) return;

    try {
      await saveOllamaSettings(
        urlInput.value.trim(),
        modelInput.value.trim(),
        keyInput?.value.trim() || null,
        parseInt(ctxInput?.value ?? "64000") || 64000,
      );
      this.config = await getAppConfig();
      this.render();
      showToast("Settings saved", "success");
    } catch (e) {
      showToast(`Failed to save settings: ${e}`, "error");
    }
  }

  private async testConnection() {
    const btn = this.container?.querySelector<HTMLButtonElement>("#ollama-test-btn");
    const status = this.container?.querySelector<HTMLElement>("#ollama-test-status");
    if (btn) {
      btn.disabled = true;
    }
    if (status) {
      status.textContent = "Testing…";
      status.className = "import-model-info import-test-progress";
    }
    try {
      const models = await testOllamaConnection();
      this.availableModels = models;
      if (status) {
        status.textContent = `Connected — ${models.length} model${models.length !== 1 ? "s" : ""} available`;
        status.className = "import-model-info import-test-ok";
      }
      showToast(`Connected! ${models.length} model${models.length !== 1 ? "s" : ""} available`, "success");
      this.render();
    } catch (e) {
      this.availableModels = [];
      if (status) {
        status.textContent = `Connection failed: ${e}`;
        status.className = "import-model-info import-test-err";
      }
      showToast(`Connection failed: ${e}`, "error");
    } finally {
      if (btn) {
        btn.disabled = false;
      }
    }
  }
}
