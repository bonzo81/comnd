/**
 * Settings Screen — dedicated settings view (right of nav panel).
 *
 * Sub-items: Ollama / KB Import (functional), General + Shortcuts (placeholders).
 * The Ollama sub-item owns the LLM connection settings used by KB import.
 */

import { getAppConfig, saveOllamaSettings, testOllamaConnection, AppConfig } from "../lib/tauri-api";
import { showToast } from "../lib/toast";
import { escHtml } from "../lib/format";
import { icons } from "../lib/icons";
import {
  getTimestampsEnabled,
  setTimestampsEnabled,
  getTimestampFormat,
  setTimestampFormat,
  TimestampFormat,
} from "../lib/timestamps";
import { getSearchIncludeTags, setSearchIncludeTags } from "../lib/search-prefs";
import { getAppTheme, setAppTheme, Theme } from "../lib/theme";

const LABELS: Record<string, string> = {
  general: "General",
  theme: "Theme",
  ollama: "Ollama / KB Import",
  shortcuts: "Shortcuts",
};

export class SettingsScreen {
  private container: HTMLElement | null = null;
  private itemId = "ollama";
  private config: AppConfig | null = null;
  private availableModels: string[] = [];

  setItem(id: string) {
    if (this.itemId !== id) {
      this.itemId = id;
      this.render();
    }
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
          <input type="url" id="ollama-url" value="${this.escAttr(baseUrl)}" required />
          <span class="import-hint">http://localhost:11434 for local, https://ollama.com/api for cloud</span>
        </div>
        <div class="import-field">
          <label for="ollama-model">Model</label>
          <input type="text" id="ollama-model" value="${this.escAttr(model)}" required />
          <span class="import-hint">e.g., gemma4:26b, llama3.2, mistral</span>
        </div>
        <div class="import-field">
          <label for="ollama-key">API Key (cloud only)</label>
          <input type="password" id="ollama-key" value="${this.escAttr(apiKey)}" placeholder="Leave empty for local Ollama" autocomplete="off" />
        </div>
        <div class="import-field">
          <label for="ollama-ctx">Context Length</label>
          <input type="number" id="ollama-ctx" value="${ctxLen}" min="4096" step="1024" />
          <span class="import-hint">Higher = can process longer pages, but uses more memory</span>
        </div>
        <div class="import-config-row">
          <button type="button" class="btn-small" id="ollama-test-btn">${icons.bot} Test Connection</button>
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
        <select id="ollama-model-select">
          ${this.availableModels.map((m) => `<option value="${this.escAttr(m)}" ${m === currentModel ? "selected" : ""}>${escHtml(m)}</option>`).join("")}
        </select>
        <span class="import-hint">Selecting a model updates the Model field above</span>
      </div>
    `;
  }

  private renderGeneral(): string {
    const tsOn = getTimestampsEnabled();
    const fmt = getTimestampFormat();
    const tagsOn = getSearchIncludeTags();
    const opt = (value: TimestampFormat, label: string) =>
      `<option value="${value}" ${fmt === value ? "selected" : ""}>${label}</option>`;
    return `
      <div class="settings-form">
        <h3 class="settings-section-title">Terminal</h3>
        <label class="settings-toggle">
          <input type="checkbox" id="ts-enabled" ${tsOn ? "checked" : ""} />
          <span>
            Show line timestamps
            <span class="import-hint">            Timestamps are recorded continuously; toggle to show them in the terminal gutter</span>
          </span>
        </label>
        <div class="import-field">
          <label for="ts-format">Timestamp format</label>
          <select id="ts-format" ${tsOn ? "" : "disabled"}>
            ${opt("24h", "24-hour — 14:32:05")}
            ${opt("12h", "12-hour — 2:32:05 PM")}
            ${opt("24h-ms", "24-hour with ms — 14:32:05.123")}
          </select>
          <span class="import-hint">Re-renders timestamps in open terminals immediately</span>
        </div>
        <h3 class="settings-section-title">Global Search</h3>
        <label class="settings-toggle">
          <input type="checkbox" id="search-tags" ${tagsOn ? "checked" : ""} />
          <span>
            Match command tags in search
            <span class="import-hint">When off, global search and KB search match command name and aliases only</span>
          </span>
        </label>
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
          <select id="theme-app">
            ${opt("dark", "Dark")}
            ${opt("light", "Light")}
          </select>
          <span class="import-hint">Applies to the net.sh window chrome, nav panel, and settings</span>
        </div>
      </div>
    `;
  }

  private renderPlaceholder(label: string): string {
    return `<p class="settings-placeholder">Coming soon — ${escHtml(label)} settings are not implemented yet.</p>`;
  }

  private bindEvents() {
    this.container?.querySelector<HTMLInputElement>("#ts-enabled")?.addEventListener("change", (e) => {
      const on = (e.target as HTMLInputElement).checked;
      setTimestampsEnabled(on);
      const select = this.container?.querySelector<HTMLSelectElement>("#ts-format");
      if (select) select.disabled = !on;
    });

    this.container?.querySelector<HTMLInputElement>("#search-tags")?.addEventListener("change", (e) => {
      setSearchIncludeTags((e.target as HTMLInputElement).checked);
    });

    this.container?.querySelector<HTMLSelectElement>("#ts-format")?.addEventListener("change", (e) => {
      setTimestampFormat((e.target as HTMLSelectElement).value as TimestampFormat);
    });

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
