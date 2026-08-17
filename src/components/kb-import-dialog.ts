/**
 * KB Import Dialog — modal for importing commands from a URL via Ollama LLM.
 *
 * Steps:
 * 1. Enter URL and select platform/category
 * 2. Optionally configure Ollama settings
 * 3. Import → shows progress → shows results
 */

import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { escHtml } from "../lib/format";
import {
  importKbUrl,
  testOllamaConnection,
  getAppConfig,
  saveOllamaSettings,
  ImportResult,
  AppConfig,
} from "../lib/tauri-api";
import { log } from "../lib/logger";

// ─── Toast Notifications ──────────────────────────────────────────

let toastContainer: HTMLElement | null = null;

function getToastContainer(): HTMLElement {
  if (!toastContainer || !document.body.contains(toastContainer)) {
    const existing = document.getElementById("toast-container");
    if (existing) {
      toastContainer = existing;
      return toastContainer;
    }
    const container = document.createElement("div");
    container.id = "toast-container";
    container.className = "toast-container";
    document.body.appendChild(container);
    toastContainer = container;
  }
  return toastContainer;
}

function showToast(message: string, type: "success" | "error" | "info" = "info", duration = 4000) {
  const container = getToastContainer();
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  const icons: Record<string, string> = { success: "✓", error: "✗", info: "ℹ" };
  toast.innerHTML = `
    <span class="toast-icon">${icons[type] ?? "ℹ"}</span>
    <span class="toast-message">${escHtml(message)}</span>
    <button class="toast-close">&times;</button>
  `;
  toast.querySelector(".toast-close")?.addEventListener("click", () => toast.remove());
  container.appendChild(toast);
  const remove = () => {
    if (!document.body.contains(toast)) return;
    toast.style.opacity = "0";
    toast.style.transition = "opacity 0.3s ease";
    setTimeout(() => { if (document.body.contains(toast)) toast.remove(); }, 300);
  };
  setTimeout(remove, duration);
}

// ─── Types ──────────────────────────────────────────────────────────

type ImportStage = "idle" | "fetching" | "extracting" | "sending" | "validating" | "writing" | "reloading" | "complete" | "error";

interface ImportProgressEvent {
  stage: ImportStage;
  detail?: string | number;
}

const PLATFORM_OPTIONS = [
  { value: "cisco-iosxe", label: "Cisco IOS-XE" },
  { value: "cisco-nxos", label: "Cisco NX-OS" },
  { value: "f5-tmos", label: "F5 TMOS" },
  { value: "linux-bash", label: "Linux Bash" },
];

const CATEGORY_OPTIONS = [
  { value: "networking", label: "Networking" },
  { value: "routing", label: "Routing" },
  { value: "switching", label: "Switching" },
  { value: "security", label: "Security" },
  { value: "system", label: "System" },
  { value: "monitoring", label: "Monitoring" },
  { value: "process", label: "Process" },
  { value: "filesystem", label: "Filesystem" },
  { value: "text-processing", label: "Text Processing" },
  { value: "package", label: "Package Management" },
  { value: "general", label: "General" },
];

// ─── Main Class ─────────────────────────────────────────────────────

export class KbImportDialog {
  private container: HTMLElement | null = null;
  private overlay: HTMLElement | null = null;
  private onImportComplete: (() => void) | null = null;
  private unlistenProgress: UnlistenFn | null = null;
  private stage: ImportStage = "idle";
  private progressDetail: string = "";
  private result: ImportResult | null = null;
  private errorMessage: string = "";
  private settingsOpen = false;
  private config: AppConfig | null = null;
  private availableModels: string[] = [];
  private startTime: number | null = null;
  private elapsedInterval: ReturnType<typeof setInterval> | null = null;
  private embedMode: boolean;

  constructor(onImportComplete?: () => void, embedMode: boolean = false) {
    this.onImportComplete = onImportComplete ?? null;
    this.embedMode = embedMode;
  }

  async mount(container: HTMLElement) {
    this.container = container;
    try {
      this.config = await getAppConfig();
    } catch {
      this.config = null;
    }
    this.listenForProgress();
    this.render();
  }

  unmount() {
    if (this.unlistenProgress) {
      this.unlistenProgress();
      this.unlistenProgress = null;
    }
    if (this.elapsedInterval) {
      clearInterval(this.elapsedInterval);
      this.elapsedInterval = null;
    }
    this.startTime = null;
  }

  // ─── Progress Listening ──────────────────────────────────────────────

  private async listenForProgress() {
    try {
      this.unlistenProgress = await listen<ImportProgressEvent>("import-progress", (event) => {
        const { stage, detail } = event.payload;
        this.stage = this.mapStage(stage);
        this.progressDetail = detail ? String(detail) : "";
        this.render();
      });
    } catch (e) {
      log.warn("Import progress listener unavailable (Tauri not running):", String(e));
    }
  }

  private mapStage(stage: string): ImportStage {
    const mapping: Record<string, ImportStage> = {
      fetching: "fetching",
      extracting_text: "extracting",
      sending_to_llm: "sending",
      extracting_commands: "extracting",
      validating: "validating",
      writing_yaml: "writing",
      reloading_kb: "reloading",
      complete: "complete",
      error: "error",
    };
    return mapping[stage] ?? "idle";
  }

  private stageLabel(stage: ImportStage): string {
    const labels: Record<ImportStage, string> = {
      idle: "Ready",
      fetching: "Fetching URL…",
      extracting: "Extracting content…",
      sending: "Sending to LLM…",
      validating: "Validating commands…",
      writing: "Writing to knowledge base…",
      reloading: "Reloading knowledge base…",
      complete: "Import complete!",
      error: "Import failed",
    };
    return labels[stage] ?? stage;
  }

  // ─── Render ─────────────────────────────────────────────────────────

  private render() {
    if (!this.container) return;

    const isImporting = !["idle", "complete", "error"].includes(this.stage);
    const base_url = this.config?.ollama_base_url ?? "http://localhost:11434";
    const model = this.config?.ollama_model ?? "llama3.2";

    const content = `
      ${this.stage === "complete" && this.result ? this.renderResult() : ""}
      ${this.stage === "error" ? this.renderError() : ""}
      ${isImporting ? this.renderProgress() : ""}
      ${this.stage === "idle" || (this.stage !== "complete" && this.stage !== "error" && !isImporting) ? this.renderForm(base_url, model, isImporting) : ""}

      ${this.settingsOpen ? this.renderSettings(base_url, model) : ""}
    `;

    if (this.embedMode) {
      this.container.innerHTML = content;
    } else {
      this.container.innerHTML = `
        <div class="import-overlay" id="import-overlay">
          <div class="import-dialog">
            <div class="import-header">
              <h2>Import Commands from URL</h2>
              <button class="import-close-btn" id="import-close-btn" ${isImporting ? 'disabled' : ''}>&times;</button>
            </div>
            ${content}
          </div>
        </div>
      `;
    }

    this.bindEvents();
  }

  private renderForm(baseUrl: string, model: string, isImporting: boolean): string {
    return `
      <div class="import-form">
        <div class="import-field">
          <label for="import-url">Documentation URL</label>
          <div class="import-url-row">
            <input type="url" id="import-url" placeholder="https://www.cisco.com/c/en/us/td/docs/ios-xml/..." 
                   ${isImporting ? 'disabled' : ''} />
            <button class="btn-try-url" id="import-try-url-btn" ${isImporting ? 'disabled' : ''}>Try URL</button>
          </div>
          <span class="import-hint">Paste a link to a command reference page</span>
          <div class="url-status" id="import-url-status"></div>
        </div>

        <div class="import-row">
          <div class="import-field">
            <label for="import-platform">Platform</label>
            <select id="import-platform" ${isImporting ? 'disabled' : ''}>
              ${PLATFORM_OPTIONS.map(p => `<option value="${p.value}">${p.label}</option>`).join("")}
            </select>
          </div>

          <div class="import-field">
            <label for="import-category">Category</label>
            <select id="import-category" ${isImporting ? 'disabled' : ''}>
              ${CATEGORY_OPTIONS.map(c => `<option value="${c.value}">${c.label}</option>`).join("")}
            </select>
          </div>
        </div>

        <div class="import-config-row">
          <span class="import-model-info">🤖 ${model} @ ${baseUrl}</span>
          <button class="btn-small" id="import-settings-btn" ${isImporting ? 'disabled' : ''}>⚙ Settings</button>
          <button class="btn-small" id="import-test-btn" ${isImporting ? 'disabled' : ''}>Test Connection</button>
        </div>

        ${this.availableModels.length > 0 ? this.renderModelSelect() : ""}

        <button class="btn-primary import-submit" id="import-submit-btn" ${isImporting ? 'disabled' : ''}>
          ${isImporting ? "Importing…" : "Import Commands"}
        </button>
      </div>
    `;
  }

  private renderProgress(): string {
    const elapsed = this.startTime ? Math.floor((Date.now() - this.startTime) / 1000) : 0;
    return `
      <div class="import-progress">
        <div class="import-spinner"></div>
        <div class="import-stage">${escHtml(this.stageLabel(this.stage))}</div>
        ${this.progressDetail ? `<div class="import-progress-detail">${escHtml(this.progressDetail)}</div>` : ""}
        ${this.startTime ? `<div class="import-elapsed" id="import-elapsed">${elapsed}s elapsed</div>` : ""}
      </div>
    `;
  }

  private renderResult(): string {
    if (!this.result) return "";
    return `
      <div class="import-result">
        <div class="import-success-icon">✓</div>
        <h3>Import Complete</h3>
        <div class="import-result-details">
          <div class="import-result-row">
            <span class="import-result-label">Commands imported:</span>
            <span class="import-result-value">${this.result.commands_imported}</span>
          </div>
          <div class="import-result-row">
            <span class="import-result-label">Platform:</span>
            <span class="import-result-value">${escHtml(this.result.platform)}</span>
          </div>
          <div class="import-result-row">
            <span class="import-result-label">Category:</span>
            <span class="import-result-value">${escHtml(this.result.category)}</span>
          </div>
          <div class="import-result-row">
            <span class="import-result-label">Target file:</span>
            <span class="import-result-value import-result-path">${escHtml(this.result.target_file)}</span>
          </div>
          ${this.result.errors.length > 0 ? `
            <div class="import-result-row">
              <span class="import-result-label">Warnings:</span>
              <span class="import-result-value">${this.result.errors.length} commands skipped</span>
            </div>
          ` : ""}
        </div>
        <div class="import-actions">
          <button class="btn-primary" id="import-done-btn">Done</button>
          <button class="btn-secondary" id="import-another-btn">Import Another</button>
        </div>
      </div>
    `;
  }

  private renderError(): string {
    return `
      <div class="import-error">
        <div class="import-error-icon">✗</div>
        <h3>Import Failed</h3>
        <p class="import-error-message">${escHtml(this.errorMessage)}</p>
        <div class="import-actions">
          <button class="btn-primary" id="import-retry-btn">Try Again</button>
        </div>
      </div>
    `;
  }

  private renderModelSelect(): string {
    const currentModel = this.config?.ollama_model ?? "";
    return `
      <div class="import-models">
        <label for="import-model-select">Switch Model</label>
        <select id="import-model-select">
          ${this.availableModels.map(m => `<option value="${this.escAttr(m)}" ${m === currentModel ? "selected" : ""}>${escHtml(m)}</option>`).join("")}
        </select>
      </div>
    `;
  }

  private renderSettings(baseUrl: string, model: string): string {
    const apiKey = this.config?.ollama_api_key ?? "";
    const ctxLen = this.config?.ollama_context_length ?? 64000;
    return `
      <div class="import-settings">
        <h4>Ollama Settings</h4>
        <div class="import-field">
          <label for="ollama-url">Base URL</label>
          <input type="url" id="ollama-url" value="${this.escAttr(baseUrl)}" />
          <span class="import-hint">http://localhost:11434 for local, https://ollama.com/api for cloud</span>
        </div>
        <div class="import-field">
          <label for="ollama-model">Model</label>
          <input type="text" id="ollama-model" value="${this.escAttr(model)}" />
          <span class="import-hint">e.g., gemma4:26b, llama3.2, mistral</span>
        </div>
        <div class="import-field">
          <label for="ollama-key">API Key (cloud only)</label>
          <input type="password" id="ollama-key" value="${this.escAttr(apiKey)}" placeholder="Leave empty for local Ollama" />
        </div>
        <div class="import-field">
          <label for="ollama-ctx">Context Length</label>
          <input type="number" id="ollama-ctx" value="${ctxLen}" min="4096" step="1024" />
          <span class="import-hint">Higher = can process longer pages, but uses more memory</span>
        </div>
        <div class="import-settings-actions">
          <button class="btn-primary" id="settings-save-btn">Save Settings</button>
          <button class="btn-secondary" id="settings-cancel-btn">Cancel</button>
        </div>
      </div>
    `;
  }

  // ─── Event Binding ──────────────────────────────────────────────────

  private bindEvents() {
    // Close button
    document.getElementById("import-close-btn")?.addEventListener("click", () => this.close());
    document.getElementById("import-overlay")?.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).id === "import-overlay") this.close();
    });

    // Settings toggle
    document.getElementById("import-settings-btn")?.addEventListener("click", () => {
      this.settingsOpen = !this.settingsOpen;
      this.render();
    });

    // Test connection
    document.getElementById("import-test-btn")?.addEventListener("click", () => this.testConnection());

    // Settings save/cancel
    document.getElementById("settings-save-btn")?.addEventListener("click", () => this.saveSettings());
    document.getElementById("settings-cancel-btn")?.addEventListener("click", () => {
      this.settingsOpen = false;
      this.render();
    });

    // Try URL
    document.getElementById("import-try-url-btn")?.addEventListener("click", () => this.tryUrl());

    // Model select
    document.getElementById("import-model-select")?.addEventListener("change", (e) => {
      const model = (e.target as HTMLSelectElement).value;
      if (this.config) {
        this.config.ollama_model = model;
        saveOllamaSettings(this.config.ollama_base_url, model, this.config.ollama_api_key, this.config.ollama_context_length)
          .then(() => { showToast(`Switched to ${model}`, "info"); })
          .catch(() => {});
      }
    });

    // Submit
    document.getElementById("import-submit-btn")?.addEventListener("click", () => this.startImport());

    // Result buttons
    document.getElementById("import-done-btn")?.addEventListener("click", () => this.close());
    document.getElementById("import-another-btn")?.addEventListener("click", () => {
      this.stage = "idle";
      this.result = null;
      this.errorMessage = "";
      this.render();
    });

    // Error retry
    document.getElementById("import-retry-btn")?.addEventListener("click", () => {
      this.stage = "idle";
      this.errorMessage = "";
      this.render();
    });
  }

  // ─── Actions ────────────────────────────────────────────────────────

  private close() {
    if (this.stage !== "idle" && this.stage !== "complete" && this.stage !== "error") return;
    this.unmount();
    if (this.container) {
      this.container.innerHTML = "";
    }
  }

  private async testConnection() {
    const btn = document.getElementById("import-test-btn") as HTMLButtonElement;
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Testing…";
    }
    try {
      const models = await testOllamaConnection();
      this.availableModels = models;
      showToast(`✓ Connected! ${models.length} model${models.length !== 1 ? "s" : ""} available`, "success");
      this.render();
    } catch (e) {
      this.availableModels = [];
      showToast(`✗ Connection failed: ${e}`, "error");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Test Connection";
      }
    }
  }

  private async tryUrl() {
    const urlInput = document.getElementById("import-url") as HTMLInputElement;
    const statusEl = document.getElementById("import-url-status");
    const btn = document.getElementById("import-try-url-btn") as HTMLButtonElement;
    const url = urlInput?.value.trim();
    if (!url) {
      showToast("Enter a URL first", "error");
      return;
    }
    if (btn) { btn.disabled = true; btn.textContent = "Checking…"; }
    if (statusEl) {
      statusEl.textContent = "Checking URL…";
      statusEl.className = "url-status url-status-progress";
    }
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      // Use no-cors: browser can't read the response cross-origin, but we
      // can still detect network-level reachability (DNS, TCP, TLS).
      await fetch(url, { method: "GET", mode: "no-cors", signal: controller.signal });
      clearTimeout(timeout);
      if (statusEl) {
        statusEl.textContent = "✓ URL is reachable";
        statusEl.className = "url-status url-status-ok";
      }
      showToast("URL is reachable", "success");
    } catch {
      if (statusEl) {
        statusEl.textContent = "✗ URL could not be reached — check the address or your connection";
        statusEl.className = "url-status url-status-err";
      }
      showToast("URL could not be reached", "error");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "Try URL"; }
    }
  }

  private async saveSettings() {
    const urlInput = document.getElementById("ollama-url") as HTMLInputElement;
    const modelInput = document.getElementById("ollama-model") as HTMLInputElement;
    const keyInput = document.getElementById("ollama-key") as HTMLInputElement;
    const ctxInput = document.getElementById("ollama-ctx") as HTMLInputElement;

    if (!urlInput || !modelInput) return;

    try {
      await saveOllamaSettings(
        urlInput.value.trim(),
        modelInput.value.trim(),
        keyInput.value.trim() || null,
        parseInt(ctxInput?.value ?? "64000") || 64000,
      );
      this.config = await getAppConfig();
      this.settingsOpen = false;
      this.render();
      showToast("Settings saved", "success");
    } catch (e) {
      showToast(`Failed to save settings: ${e}`, "error");
    }
  }

  private async startImport() {
    const urlInput = document.getElementById("import-url") as HTMLInputElement;
    const platformSelect = document.getElementById("import-platform") as HTMLSelectElement;
    const categorySelect = document.getElementById("import-category") as HTMLSelectElement;

    if (!urlInput?.value.trim()) {
      showToast("Please enter a URL", "error");
      return;
    }

    const url = urlInput.value.trim();
    const platform = platformSelect?.value ?? "cisco-iosxe";
    const category = categorySelect?.value ?? "networking";

    this.stage = "fetching";
    this.errorMessage = "";
    this.result = null;
    this.startTime = Date.now();
    this.elapsedInterval = setInterval(() => this.render(), 1000);
    this.render();

    try {
      log.info("kb-import", `Starting import from ${url} for ${platform}/${category}`);
      this.result = await importKbUrl(url, platform, category);
      this.stage = "complete";
      log.info("kb-import", `Import complete: ${this.result.commands_imported} commands`);
      showToast(`Import complete: ${this.result.commands_imported} commands imported`, "success");
    } catch (e) {
      this.stage = "error";
      this.errorMessage = String(e);
      log.error("kb-import", `Import failed: ${e}`);
      showToast(`Import failed: ${e}`, "error", 8000);
    }

    if (this.elapsedInterval) {
      clearInterval(this.elapsedInterval);
      this.elapsedInterval = null;
    }
    this.startTime = null;
    this.render();

    if (this.stage === "complete" && this.onImportComplete) {
      this.onImportComplete();
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────

  private escAttr(text: string): string {
    return text.replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
}