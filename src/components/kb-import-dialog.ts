/**
 * KB Import Dialog — modal for importing commands from a URL via Ollama LLM.
 *
 * Steps:
 * 1. Enter URL and select platform/category
 * 2. Import → shows progress → shows results
 *
 * Ollama connection settings live in the Settings view (Ollama / KB Import).
 */

import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { escHtml } from "../lib/format";
import {
  extractKbPreview,
  commitKbImport,
  getAppConfig,
  ImportResult,
  AppConfig,
  ExtractPreview,
} from "../lib/tauri-api";
import { log } from "../lib/logger";
import { icons } from "../lib/icons";
import { showToast } from "../lib/toast";

// ─── Types ──────────────────────────────────────────────────────────

type ImportStage = "idle" | "fetching" | "extracting" | "sending" | "validating" | "writing" | "reloading" | "preview" | "complete" | "error";

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
  private config: AppConfig | null = null;
  private startTime: number | null = null;
  private elapsedInterval: ReturnType<typeof setInterval> | null = null;
  private embedMode: boolean;
  /** Phase 5.6: preview stage state */
  private preview: ExtractPreview | null = null;
  private previewUrl: string = "";
  private previewPlatform: string = "";
  private previewCategory: string = "";
  private committing: boolean = false;

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
      preview: "Review extracted commands",
      complete: "Import complete!",
      error: "Import failed",
    };
    return labels[stage] ?? stage;
  }

  // ─── Render ─────────────────────────────────────────────────────────

  private render() {
    if (!this.container) return;

    const isImporting = !["idle", "complete", "error", "preview"].includes(this.stage);
    const base_url = this.config?.ollama_base_url ?? "http://localhost:11434";
    const model = this.config?.ollama_model ?? "llama3.2";

    const content = `
      ${this.stage === "complete" && this.result ? this.renderResult() : ""}
      ${this.stage === "error" ? this.renderError() : ""}
      ${isImporting ? this.renderProgress() : ""}
      ${this.stage === "preview" && this.preview ? this.renderPreview() : ""}
      ${this.stage === "idle" || (this.stage !== "complete" && this.stage !== "error" && this.stage !== "preview" && !isImporting) ? this.renderForm(base_url, model, isImporting) : ""}
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
          <span class="import-model-info">${icons.bot} ${escHtml(model)} @ ${escHtml(baseUrl)}</span>
        </div>

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
        <div class="import-success-icon">${icons.check}</div>
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
        <div class="import-error-icon">${icons.x}</div>
        <h3>Import Failed</h3>
        <p class="import-error-message">${escHtml(this.errorMessage)}</p>
        <div class="import-actions">
          <button class="btn-primary" id="import-retry-btn">Try Again</button>
        </div>
      </div>
    `;
  }

  /**
   * Phase 5.6: review screen between the form and the result. Shows the
   * extracted commands with name, mode badge, tokenized syntax, and any
   * per-command warnings (e.g. "tokens dropped"). Confirm commits to YAML;
   * Reject discards and returns to the form.
   */
  private renderPreview(): string {
    if (!this.preview) return "";
    const previews = this.preview.previews;
    const warnCount = previews.filter((p) => p.status === "warn").length;
    const rows = previews.map((p, i) => {
      const statusIcon = p.status === "warn"
        ? `<span class="preview-warn" title="${escHtml(p.issues.join("; "))}">${icons.alert}</span>`
        : `<span class="preview-ok">${icons.check}</span>`;
      const modeBadge = `<span class="preview-mode">${escHtml(p.command.mode)}</span>`;
      const syntaxLine = p.command.syntax
        ? `<code class="preview-syntax">${escHtml(p.command.syntax)}</code>`
        : "";
      const issueLine = p.issues.length > 0
        ? `<div class="preview-issues">${p.issues.map((m) => escHtml(m)).join("<br/>")}</div>`
        : "";
      return `
        <div class="preview-row" data-index="${i}">
          <div class="preview-row-head">
            ${statusIcon}
            <span class="preview-name">${escHtml(p.command.name)}</span>
            ${modeBadge}
          </div>
          ${syntaxLine}
          ${issueLine}
        </div>
      `;
    }).join("");

    const errLine = this.preview.errors.length > 0
      ? `<div class="preview-errors">${this.preview.errors.length} command(s) skipped during extraction</div>`
      : "";

    return `
      <div class="import-preview">
        <div class="preview-summary">
          <h3>${previews.length} command${previews.length === 1 ? "" : "s"} extracted</h3>
          ${warnCount > 0 ? `<span class="preview-warn-count">${warnCount} with token warnings (imported as legacy)</span>` : ""}
        </div>
        <div class="preview-list">${rows}</div>
        ${errLine}
        <div class="import-actions">
          <button class="btn-text" id="preview-reject-btn" ${this.committing ? "disabled" : ""}>Reject</button>
          <button class="btn-primary" id="preview-confirm-btn" ${this.committing ? "disabled" : ""}>
            ${this.committing ? "Committing…" : "Confirm all"}
          </button>
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

    // Try URL
    document.getElementById("import-try-url-btn")?.addEventListener("click", () => this.tryUrl());

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

    // Phase 5.6: preview confirm / reject
    document.getElementById("preview-confirm-btn")?.addEventListener("click", () => this.confirmPreview());
    document.getElementById("preview-reject-btn")?.addEventListener("click", () => this.rejectPreview());
  }

  // ─── Actions ────────────────────────────────────────────────────────

  private close() {
    if (this.stage !== "idle" && this.stage !== "complete" && this.stage !== "error") return;
    this.unmount();
    if (this.container) {
      this.container.innerHTML = "";
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
        statusEl.innerHTML = `${icons.check} URL is reachable`;
        statusEl.className = "url-status url-status-ok";
      }
      showToast("URL is reachable", "success");
    } catch {
      if (statusEl) {
        statusEl.innerHTML = `${icons.x} URL could not be reached — check the address or your connection`;
        statusEl.className = "url-status url-status-err";
      }
      showToast("URL could not be reached", "error");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "Try URL"; }
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
    this.preview = null;
    this.startTime = Date.now();
    this.elapsedInterval = setInterval(() => this.render(), 1000);
    this.render();

    try {
      log.info("kb-import", `Extracting preview from ${url} for ${platform}/${category}`);
      // Phase 5.6: Stage 1 — extract + validate without writing.
      const preview = await extractKbPreview(url, platform, category);
      this.preview = preview;
      this.previewUrl = url;
      this.previewPlatform = platform;
      this.previewCategory = category;
      this.stage = "preview";
      log.info("kb-import", `Preview ready: ${preview.previews.length} commands`);
    } catch (e) {
      this.stage = "error";
      this.errorMessage = String(e);
      log.error("kb-import", `Extract failed: ${e}`);
      showToast(`Extract failed: ${e}`, "error", 8000);
    }

    if (this.elapsedInterval) {
      clearInterval(this.elapsedInterval);
      this.elapsedInterval = null;
    }
    this.startTime = null;
    this.render();
  }

  /** Phase 5.6: Stage 2 — commit the user-approved previews to YAML. */
  private async confirmPreview() {
    if (!this.preview || this.committing) return;
    this.committing = true;
    this.stage = "writing";
    this.render();

    try {
      const count = await commitKbImport(
        this.preview.previews,
        this.previewPlatform,
        this.previewCategory,
      );
      this.result = {
        commands_imported: count,
        target_file: `${this.previewPlatform}/commands/${this.previewCategory}.yaml`,
        platform: this.previewPlatform,
        category: this.previewCategory,
        source_url: this.previewUrl,
        errors: this.preview.errors,
      };
      this.stage = "complete";
      log.info("kb-import", `Commit complete: ${count} commands`);
      showToast(`Import complete: ${count} commands imported`, "success");
      if (this.onImportComplete) this.onImportComplete();
    } catch (e) {
      this.stage = "error";
      this.errorMessage = String(e);
      log.error("kb-import", `Commit failed: ${e}`);
      showToast(`Commit failed: ${e}`, "error", 8000);
    } finally {
      this.committing = false;
    }
    this.render();
  }

  /** Phase 5.6: discard the preview and return to the form. */
  private rejectPreview() {
    this.preview = null;
    this.stage = "idle";
    this.render();
  }

  // ─── Helpers ─────────────────────────────────────────────────────────

  private escAttr(text: string): string {
    return text.replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
}