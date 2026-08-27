/**
 * Settings Screen — dedicated settings view (right of nav panel).
 *
 * Sub-items: Ollama / KB Import (functional), General + Shortcuts (placeholders).
 * The Ollama sub-item owns the LLM connection settings used by KB import.
 */

import {
  getAppConfig, saveOllamaSettings, testOllamaConnection, setLogLevel,
  setLogMaxSize, setLogFilePath, setMaxSessions, exportData, importData,
  scanMerge, applyMerge, MergeConflict,
  AppConfig, listProviders, getProviderState,
  saveProviderConfig, saveProviderSecret, ProviderInfo, ProviderState,
} from "../lib/tauri-api";
import { save, open } from "@tauri-apps/plugin-dialog";
import { showToast } from "../lib/toast";
import { escHtml } from "../lib/format";
import { icons } from "../lib/icons";
import {
  getTimestampFormat,
  setTimestampFormat,
  TimestampFormat,
} from "../lib/timestamps";
import { getSearchIncludeTags, setSearchIncludeTags } from "../lib/search-prefs";
import { getAutoCopyEnabled, setAutoCopyEnabled } from "../lib/auto-copy";
import { getOutputHighlightEnabled, setOutputHighlightEnabled } from "../lib/output-highlight";
import { getAppTheme, setAppTheme, Theme } from "../lib/theme";

const LABELS: Record<string, string> = {
  general: "General",
  theme: "Theme",
  ollama: "Ollama / KB Import",
  auth: "Auth Integrations",
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
  private availableModels: string[] = [];
  private providerStatuses = new Map<string, ProviderInfo>();
  private providerStates = new Map<string, ProviderState>();

  setItem(id: string) {
    // Auth re-fetches on every show (refresh-on-mount); other items no-op.
    if (this.itemId === id && id !== "auth") return;
    this.itemId = id;
    if (id === "auth") void this.loadProviders().then(() => this.render());
    else this.render();
  }

  async mount(container: HTMLElement) {
    this.container = container;
    try {
      this.config = await getAppConfig();
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
    const label = LABELS[this.itemId] ?? "Settings";
    const body =
      this.itemId === "ollama" ? this.renderOllama()
      : this.itemId === "general" ? this.renderGeneral()
      : this.itemId === "theme" ? this.renderTheme()
      : this.itemId === "auth" ? this.renderAuth()
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
        <h3 class="settings-section-title">Logging</h3>
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
          <label>Backup & Restore</label>
          <div class="log-file-row">
            <button type="button" id="data-export" class="btn-secondary">Export backup...</button>
            <button type="button" id="data-import" class="btn-secondary">Restore from backup...</button>
          </div>
          <span class="import-hint">Export saves hosts, groups, config, known hosts, and knowledge base to a zip file. Restore replaces your current data (a backup of the current state is kept automatically). Restart the app after restoring.</span>
        </div>
      </div>
    `;
  }

  private renderTheme(): string {
    const t = getAppTheme();
    const opt = (value: Theme, label: string) =>
      `<option value="${value}" ${t === value ? "selected" : ""}>${label}</option>`;
    return `
      <div class="settings-form">
        <h3 class="settings-section-title">Appearance</h3>
        <div class="import-field">
          <label for="theme-app">App theme</label>
          <select class="form-input" id="theme-app">
            ${opt("dark", "Dark")}
            ${opt("light", "Light")}
          </select>
          <span class="import-hint">Applies to the net.sh window chrome, nav panel, and settings</span>
        </div>
      </div>
    `;
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
        defaultPath: "netsh.log",
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

  private async exportData(): Promise<void> {
    try {
      const dest = await save({
        defaultPath: "netsh-backup.zip",
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
      <div class="modal-panel" style="max-width: 480px;">
        <h3 style="font-size: var(--font-size-xl); margin-bottom: var(--space-3);">Restore backup</h3>
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

  private async doOverwrite(srcPath: string): Promise<void> {
    try {
      await importData(srcPath);
      showToast("Data overwritten. Restart the app to apply.", "success", 8000);
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
        showToast(msg + ". Restart the app to apply.", "success", 8000);
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
      <div class="modal-panel" style="max-width: 640px; max-height: 80vh; overflow-y: auto;">
        <h3 style="font-size: var(--font-size-xl); margin-bottom: var(--space-2);">Merge conflicts</h3>
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
      showToast(msg + ". Restart the app to apply.", "success", 8000);
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
