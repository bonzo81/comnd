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

const LABELS: Record<string, string> = {
  general: "General",
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
    const body = this.itemId === "ollama" ? this.renderOllama() : this.renderPlaceholder(label);
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

  private renderPlaceholder(label: string): string {
    return `<p class="settings-placeholder">Coming soon — ${escHtml(label)} settings are not implemented yet.</p>`;
  }

  private bindEvents() {
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
