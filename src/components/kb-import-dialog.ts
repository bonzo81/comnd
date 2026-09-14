/**
 * KB Import Dialog — embedded wizard for importing commands from a URL via the configured LLM.
 *
 * Steps:
 * 1. Enter URL and select platform/category
 * 2. Import → shows progress → shows results
 *
 * LLM connection settings live in the Settings view (LLM API / KB Import).
 */

import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { escAttr, escHtml } from "../lib/format";
import {
  extractKbPreview,
  extractKbPreviewFromText,
  commitKbImport,
  getAppConfig,
  listKbPlatforms,
  AppConfig,
  ExtractPreview,
  Command,
} from "../lib/tauri-api";
import { log, LogTag } from "../lib/logger";
import { icons } from "../lib/icons";
import { showToast } from "../lib/toast";
import { importJob, formatProgress } from "../lib/import-status";

// ─── Types ──────────────────────────────────────────────────────────

type ImportStage = "idle" | "fetching" | "extracting" | "sending" | "validating" | "writing" | "reloading" | "preview" | "complete" | "error";

interface ImportProgressEvent {
  stage: ImportStage;
  detail?: string | number;
}

const NEW_PLATFORM = "__new__";
const OTHER_CATEGORY = "__other__";

/** First sentence of a description — the one-line "why" in the preview row. */
function firstSentence(text: string): string {
  const t = text.trim();
  if (!t) return "";
  const m = t.match(/^(.+?[.!?])(\s|$)/);
  return (m ? m[1] : t.split("\n")[0]).trim();
}

/** Platform ID slug: lowercase, [a-z0-9-], collapsed dashes. */
function slugify(text: string): string {
  return text.toLowerCase().trim()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

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
  private onImportComplete: (() => void) | null = null;
  private unlistenProgress: UnlistenFn | null = null;
  private stage: ImportStage = "idle";
  private progressDetail: string = "";
  private errorMessage: string = "";
  /** Fetch failed with a bot-block (403/429) — offer the paste-text path. */
  private fetchBlocked: boolean = false;
  private config: AppConfig | null = null;
  /** Phase 5.6: preview stage state */
  private preview: ExtractPreview | null = null;
  private previewUrl: string = "";
  private previewPlatform: string = "";
  /** Display name when importing into a brand-new platform (docs/10 § Part 5). */
  private previewPlatformName: string | null = null;
  private previewCategory: string = "";
  /** Per-row accept state: checked by default for "ok", unchecked for "warn". */
  private selectedRows: boolean[] = [];
  private rejectedByUser: number = 0;
  private committing: boolean = false;
  /** Platform list from the backend (bundled + user KBs). */
  private platformOptions: { value: string; label: string }[] = [];
  /** Load state for the platform dropdown: loading → ready | error. */
  private platformStatus: "loading" | "ready" | "error" = "loading";
  /** Last ID auto-generated from the platform name (so manual edits win). */
  private lastAutoSlug: string = "";
  /** Source mode: "url" fetches server-side, "text" imports pasted page text. */
  private sourceMode: "url" | "text" = "url";

  constructor(onImportComplete?: () => void) {
    this.onImportComplete = onImportComplete ?? null;
  }

  async mount(container: HTMLElement) {
    this.container = container;
    try {
      this.config = await getAppConfig();
    } catch {
      this.config = null;
    }
    await this.loadPlatforms();
    // Rehydrate: a fresh instance mid-job shows the running-job banner, not
    // a bare form (the job singleton outlives the dialog).
    if (importJob.active) {
      this.stage = "extracting";
      this.progressDetail = importJob.stageLabel;
    }
    this.listenForProgress();
    this.render();
  }

  /** Load the platform list from the backend. Sets platformStatus; caller re-renders. */
  private async loadPlatforms(): Promise<void> {
    this.platformStatus = "loading";
    try {
      const ids = await listKbPlatforms();
      this.platformOptions = ids.map((id) => ({ value: id, label: id }));
      this.platformStatus = "ready";
    } catch {
      this.platformOptions = [];
      this.platformStatus = "error";
    }
  }

  unmount() {
    if (this.unlistenProgress) {
      this.unlistenProgress();
      this.unlistenProgress = null;
    }
  }

  // ─── Progress Listening ──────────────────────────────────────────────

  private async listenForProgress() {
    try {
      this.unlistenProgress = await listen<{ stage: string; detail?: unknown }>("import-progress", (event) => {
        // The backend has no cancellation token — after the user cancels, the
        // Rust pipeline still runs to completion and keeps emitting events.
        // Ignore everything until a new job starts, or late events resurrect
        // the progress banner on the "idle" form.
        if (!importJob.active && !this.stageActive()) return;
        // Rust ImportProgress tags are PascalCase variant names; formatProgress
        // normalizes them to dialog stage keys + human labels.
        const info = formatProgress(event.payload.stage, event.payload.detail);
        const prevStage = this.stage;
        this.stage = info.key as ImportStage;
        this.progressDetail = info.label;
        if (info.key === "error" && !this.errorMessage) this.errorMessage = info.label;
        if (this.stage === prevStage) return; // same-stage tick — no render churn
        this.render();
      });
    } catch (e) {
      log.warn(LogTag.KbImport, `Import progress listener unavailable (Tauri not running): ${e}`);
    }
  }

  /** Is the dialog itself driving a live job? (stage in flight, not cancelled) */
  private stageActive(): boolean {
    return this.stage !== "idle" && this.stage !== "complete" && this.stage !== "error" && this.stage !== "preview";
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
    const base_url = this.config?.llm_base_url ?? "http://localhost:11434";
    const model = this.config?.llm_model ?? "";

    const content = `
      ${this.stage === "complete" && importJob.result ? this.renderResult() : ""}
      ${this.stage === "error" ? this.renderError() : ""}
      ${this.stage === "preview" && this.preview ? this.renderPreview() : ""}
      ${isImporting ? this.renderProgressBanner() : ""}
      ${this.stage === "idle" || isImporting ? this.renderForm(base_url, model, isImporting) : ""}
    `;

    this.container.innerHTML = content;

    this.bindEvents();
  }

  private renderForm(baseUrl: string, model: string, isImporting: boolean): string {
    const isText = this.sourceMode === "text";
    return `
      <div class="import-form">
        <div class="import-field">
          <div class="import-mode-toggle" role="radiogroup" aria-label="Source type">
            <button type="button" class="import-mode-btn${!isText ? " active" : ""}" id="import-mode-url" aria-pressed="${!isText}" ${isImporting ? 'disabled' : ''}>From URL</button>
            <button type="button" class="import-mode-btn${isText ? " active" : ""}" id="import-mode-text" aria-pressed="${isText}" ${isImporting ? 'disabled' : ''}>Paste Text</button>
            <span class="import-mode-slider" aria-hidden="true"></span>
          </div>
        </div>

        <div class="import-field" id="import-url-field" ${isText ? 'style="display:none"' : ''}>
          <label for="import-url">Documentation URL</label>
          <div class="import-url-row">
            <input type="url" class="form-input" id="import-url" placeholder="https://www.cisco.com/c/en/us/td/docs/ios-xml/..."
                   ${isImporting ? 'disabled' : ''} />
            <button class="btn-secondary btn-small import-try-url" id="import-try-url-btn" ${isImporting ? 'disabled' : ''}>Try URL</button>
          </div>
          <span class="import-hint">Paste a link to a command reference page</span>
          <div class="url-status" id="import-url-status" role="status"></div>
        </div>

        <div class="import-field" id="import-text-field" ${!isText ? 'style="display:none"' : ''}>
          <label for="import-paste-text">Page text</label>
          <textarea class="form-input import-paste-text" id="import-paste-text" rows="10"
                    placeholder="Open the docs page in your browser, select all (Ctrl+A), copy (Ctrl+C), and paste here…"
                    ${isImporting ? 'disabled' : ''}></textarea>
          <span class="import-hint">Use this when a site blocks the app's fetch — your browser can load pages the app cannot. Optional: paste the page URL below so imported commands keep a source link.</span>
          <input type="url" class="form-input" id="import-paste-url" placeholder="Source URL (optional)"
                 ${isImporting ? 'disabled' : ''} />
        </div>

        <div class="import-row">
          <div class="import-field">
            <label for="import-platform">Platform</label>
            <select class="form-input" id="import-platform" ${isImporting || this.platformStatus === "loading" ? 'disabled' : ''}>
              ${this.platformStatus === "ready"
                ? this.platformOptions.map(p => `<option value="${escAttr(p.value)}">${escHtml(p.label)}</option>`).join("")
                : this.platformStatus === "loading" ? `<option>Loading platforms…</option>` : ""}
              <optgroup label="Custom">
                <option value="${NEW_PLATFORM}">New platform…</option>
              </optgroup>
            </select>
            ${this.platformStatus === "error" ? `<span class="import-hint">Could not load the platform list — you can still import into a new platform, or <button type="button" class="btn-secondary" id="import-platforms-retry-btn">Retry</button>.</span>` : ''}
          </div>

          <div class="import-field">
            <label for="import-category">Category</label>
            <select class="form-input" id="import-category" ${isImporting ? 'disabled' : ''}>
              ${CATEGORY_OPTIONS.map(c => `<option value="${c.value}">${c.label}</option>`).join("")}
              <option value="${OTHER_CATEGORY}">Other…</option>
            </select>
          </div>
        </div>
        <div id="import-new-platform-fields" style="display:none">
          <div class="import-row">
            <div class="import-field">
              <label for="import-platform-name">Platform name</label>
              <input type="text" class="form-input" id="import-platform-name" placeholder="Acme RouterOS" ${isImporting ? 'disabled' : ''} />
            </div>
            <div class="import-field">
              <label for="import-platform-id">Platform ID</label>
              <input type="text" class="form-input" id="import-platform-id" placeholder="acme-routeros (a-z, 0-9, -)" ${isImporting ? 'disabled' : ''} />
            </div>
          </div>
          <span class="import-hint">New platforms are single-mode. To define modes, hand-edit <code>index.yaml</code> for the platform in your app data knowledge-base folder (prompt_patterns + default_mode).</span>
        </div>

        <div class="import-field" id="import-category-custom-field" style="display:none">
          <label for="import-category-custom">Custom category name</label>
          <input type="text" class="form-input" id="import-category-custom" placeholder="e.g. voice" ${isImporting ? 'disabled' : ''} />
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

  /**
   * Compact running-job banner shown above the (disabled) form while an
   * import is in flight — the form stays visible but every control is off.
   */
  private renderProgressBanner(): string {
    return `
      <div class="import-progress-banner" role="status" aria-live="polite">
        <div class="import-spinner" aria-hidden="true"></div>
        <div class="import-banner-text">
          <div class="import-stage">${escHtml(this.progressDetail || this.stageLabel(this.stage))}</div>
          <div class="import-elapsed">Import running — live progress in the title-bar indicator</div>
        </div>
      </div>
    `;
  }

  private renderResult(): string {
    const r = importJob.result;
    if (!r) return "";
    return `
      <div class="import-result" role="status">
        <div class="import-success-icon">${icons.check}</div>
        <h3>Import Complete</h3>
        <div class="import-result-details">
          <div class="import-result-row">
            <span class="import-result-label">Commands imported:</span>
            <span class="import-result-value">${r.commandsImported}</span>
          </div>
          <div class="import-result-row">
            <span class="import-result-label">Platform:</span>
            <span class="import-result-value">${escHtml(r.platform)}</span>
          </div>
          <div class="import-result-row">
            <span class="import-result-label">Category:</span>
            <span class="import-result-value">${escHtml(r.category)}</span>
          </div>
          <div class="import-result-row">
            <span class="import-result-label">Target file:</span>
            <span class="import-result-value import-result-path">${escHtml(r.targetFile)}</span>
          </div>
          ${this.rejectedByUser > 0 ? `
            <div class="import-result-row">
              <span class="import-result-label">Rejected at review:</span>
              <span class="import-result-value">${this.rejectedByUser}</span>
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
    const pasteOffer = this.fetchBlocked ? `
      <p class="import-error-hint">Your browser can open pages the app's fetcher cannot. Switch to <strong>Paste Text</strong> mode: open the page in your browser, select all (Ctrl+A), copy, and paste it into the import dialog.</p>
    ` : "";
    const pasteBtn = this.fetchBlocked ? `<button class="btn-secondary" id="import-paste-mode-btn">Paste Text Instead</button>` : "";
    return `
      <div class="import-error" role="alert">
        <div class="import-error-icon">${icons.x}</div>
        <h3>Import Failed</h3>
        <p class="import-error-message">${escHtml(this.errorMessage)}</p>
        ${pasteOffer}
        <div class="import-actions">
          <button class="btn-primary" id="import-retry-btn">Try Again</button>
          ${pasteBtn}
        </div>
      </div>
    `;
  }

  /**
   * docs/10 § Part 4: per-command accept/reject screen. Each row carries a
   * checkbox (checked for "ok", unchecked for "warn"), name, mode badge,
   * tokenized syntax, a one-line "why", a New/Overrides label, and any
   * validation issues verbatim. Import commits only the checked rows.
   */
  private renderPreview(): string {
    if (!this.preview) return "";
    const previews = this.preview.previews;
    // Initialize per-row selection: ok → checked, warn → unchecked.
    if (this.selectedRows.length !== previews.length) {
      this.selectedRows = previews.map((p) => p.status === "ok");
    }
    const rows = previews.map((p, i) => {
      const statusIcon = p.status === "warn"
        ? `<span class="preview-warn" title="${escHtml(p.issues.join("; "))}">${icons.alert}</span>`
        : `<span class="preview-ok">${icons.check}</span>`;
      const modeBadge = `<span class="preview-mode">${escHtml(p.command.mode)}</span>`;
      // Per-command category editor: change before final import. The commit
      // groups commands by this field, so edits land in the right YAML file.
      const catSelect = `
        <select class="preview-cat-select" data-index="${i}" aria-label="Category for ${escHtml(p.command.name)}" title="Category — edit before import">
          ${CATEGORY_OPTIONS.map((c) =>
            `<option value="${c.value}"${p.command.category === c.value ? " selected" : ""}>${escHtml(c.label)}</option>`
          ).join("")}
          ${CATEGORY_OPTIONS.some((c) => c.value === p.command.category) ? "" :
            `<option value="${escAttr(p.command.category)}" selected>${escHtml(p.command.category)}</option>`}
        </select>`;
      const provenance = p.in_bundled
        ? `<span class="preview-provenance">Overrides built-in entry</span>`
        : `<span class="preview-provenance preview-provenance-new">New command</span>`;
      const compareBtn = p.bundled
        ? `<button type="button" class="btn-text btn-small preview-compare-btn" data-index="${i}">Compare</button>`
        : "";
      const compareSection = p.bundled
        ? `<div class="preview-compare" data-compare="${i}" style="display:none">
             ${this.compareColumns(p.bundled, p.command)}
           </div>`
        : "";
      const why = firstSentence(p.command.description);
      const whyLine = why ? `<div class="preview-why">${escHtml(why)}</div>` : "";
      const syntaxLine = p.command.syntax
        ? `<code class="preview-syntax">${escHtml(p.command.syntax)}</code>`
        : "";
      const issueLine = p.issues.length > 0
        ? `<div class="preview-issues">${p.issues.map((m) => escHtml(m)).join("<br/>")}</div>`
        : "";
      return `
        <div class="preview-row${p.issues.length > 0 ? " preview-row-invalid" : ""}" data-index="${i}">
          <div class="preview-row-head">
            <input type="checkbox" class="preview-check" data-index="${i}" ${this.selectedRows[i] ? "checked" : ""} aria-label="Import ${escHtml(p.command.name)}" />
            ${statusIcon}
            <span class="preview-name">${escHtml(p.command.name)}</span>
            ${modeBadge}
            ${catSelect}
            ${provenance}
            ${compareBtn}
          </div>
          ${whyLine}
          ${syntaxLine}
          ${issueLine}
          ${compareSection}
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
          <span class="preview-counts" id="preview-counts">${this.summaryCounts()}</span>
        </div>
        <div class="preview-list">${rows}</div>
        ${errLine}
        <div class="import-actions">
          <button class="btn-text" id="preview-reject-btn" ${this.committing ? "disabled" : ""}>Reject</button>
          <button class="btn-primary" id="preview-confirm-btn" ${this.committing || this.selectedCount() === 0 ? "disabled" : ""}>
            ${this.committing ? "Committing…" : `Import selected (${this.selectedCount()})`}
          </button>
        </div>
      </div>
    `;
  }

  /** Side-by-side built-in vs imported comparison (docs/10 § Part 4). */
  private compareColumns(bundled: Command, imported: Command): string {
    const col = (label: string, cls: string, c: Command) => `
      <div class="preview-compare-col">
        <div class="preview-compare-label ${cls}">${label}</div>
        <code class="preview-compare-syntax">${escHtml(c.syntax || c.name)}</code>
        <div class="preview-compare-desc">${escHtml(firstSentence(c.description) || "— no description —")}</div>
        <div class="preview-compare-mode">mode: ${escHtml(c.mode)}${c.tokens?.length ? ` · ${c.tokens.length} tokens` : " · legacy (no tokens)"}</div>
      </div>`;
    return col("Built-in", "preview-compare-builtin", bundled) +
           col("Your import", "preview-compare-imported", imported);
  }

  private selectedCount(): number {
    return this.selectedRows.filter(Boolean).length;
  }

  /** "N of M selected · K new · J override built-in · W with warnings" */
  private summaryCounts(): string {
    if (!this.preview) return "";
    const previews = this.preview.previews;
    const selected = this.selectedCount();
    const newCount = previews.filter((p) => !p.in_bundled).length;
    const overrideCount = previews.length - newCount;
    const warnCount = previews.filter((p) => p.status === "warn").length;
    return `${selected} of ${previews.length} selected · ${newCount} new · ${overrideCount} override built-in · ${warnCount} with warnings`;
  }

  // ─── Event Binding ──────────────────────────────────────────────────

  private bindEvents() {
    // Try URL
    document.getElementById("import-try-url-btn")?.addEventListener("click", () => this.tryUrl());

    // Source-mode slider: swap URL field / paste textarea in place (no full
    // re-render, so typed text survives toggling).
    document.getElementById("import-mode-url")?.addEventListener("click", () => this.setSourceMode("url"));
    document.getElementById("import-mode-text")?.addEventListener("click", () => this.setSourceMode("text"));

    // Submit
    document.getElementById("import-submit-btn")?.addEventListener("click", () => this.startImport());

    // New-platform / custom-category reveal
    document.getElementById("import-platform")?.addEventListener("change", (e) => {
      const isNew = (e.target as HTMLSelectElement).value === NEW_PLATFORM;
      const fields = document.getElementById("import-new-platform-fields");
      if (fields) fields.style.display = isNew ? "" : "none";
    });

    // New-platform helpers: auto-slug the ID from the name; sanitize typing.
    const nameInput = document.getElementById("import-platform-name") as HTMLInputElement | null;
    const idInput = document.getElementById("import-platform-id") as HTMLInputElement | null;
    nameInput?.addEventListener("input", () => {
      if (!idInput) return;
      const slug = slugify(nameInput.value);
      if (idInput.value === "" || idInput.value === this.lastAutoSlug) {
        idInput.value = slug;
        this.lastAutoSlug = slug;
      }
    });
    idInput?.addEventListener("input", () => {
      const cleaned = slugify(idInput.value);
      if (cleaned !== idInput.value) idInput.value = cleaned;
    });

    document.getElementById("import-category")?.addEventListener("change", (e) => {
      const isOther = (e.target as HTMLSelectElement).value === OTHER_CATEGORY;
      const field = document.getElementById("import-category-custom-field");
      if (field) field.style.display = isOther ? "" : "none";
    });

    // Result buttons
    document.getElementById("import-done-btn")?.addEventListener("click", () => this.close());
    document.getElementById("import-another-btn")?.addEventListener("click", () => {
      this.stage = "idle";
      this.errorMessage = "";
      this.render();
    });

    // Error retry
    document.getElementById("import-retry-btn")?.addEventListener("click", () => {
      this.stage = "idle";
      this.errorMessage = "";
      this.render();
    });

    // Platform list load failed → retry the fetch
    document.getElementById("import-platforms-retry-btn")?.addEventListener("click", async () => {
      await this.loadPlatforms();
      this.render();
    });

    // Bot-blocked fetch → jump to paste-text mode
    document.getElementById("import-paste-mode-btn")?.addEventListener("click", () => {
      this.stage = "idle";
      this.errorMessage = "";
      this.fetchBlocked = false;
      this.render();
      this.setSourceMode("text");
    });

    // Phase 5.6: preview confirm / reject
    document.getElementById("preview-confirm-btn")?.addEventListener("click", () => this.confirmPreview());
    document.getElementById("preview-reject-btn")?.addEventListener("click", () => this.rejectPreview());

    // docs/10 § Part 4: per-row checkboxes — update selection state and the
    // summary/confirm button in place (no full re-render, preserves scroll).
    this.container?.querySelectorAll<HTMLInputElement>(".preview-check").forEach((cb) => {
      cb.addEventListener("change", () => {
        const idx = parseInt(cb.dataset.index ?? "0", 10);
        this.selectedRows[idx] = cb.checked;
        const counts = document.getElementById("preview-counts");
        if (counts) counts.textContent = this.summaryCounts();
        const btn = document.getElementById("preview-confirm-btn") as HTMLButtonElement | null;
        if (btn) {
          btn.disabled = this.selectedCount() === 0;
          btn.textContent = `Import selected (${this.selectedCount()})`;
        }
      });
    });

    // Per-command category editor — mutate the preview in place; the commit
    // groups by each command's category, so no re-render is needed.
    this.container?.querySelectorAll<HTMLSelectElement>(".preview-cat-select").forEach((sel) => {
      sel.addEventListener("change", () => {
        const idx = parseInt(sel.dataset.index ?? "0", 10);
        const cmd = this.preview?.previews[idx]?.command;
        if (cmd) cmd.category = sel.value;
      });
    });

    // Compare toggle: show/hide the built-in vs import columns in place.
    this.container?.querySelectorAll<HTMLButtonElement>(".preview-compare-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.index ?? "0", 10);
        const section = this.container?.querySelector<HTMLElement>(`[data-compare="${idx}"]`);
        if (!section) return;
        const open = section.style.display !== "none";
        section.style.display = open ? "none" : "";
        btn.textContent = open ? "Compare" : "Hide compare";
      });
    });
  }

  // ─── Actions ────────────────────────────────────────────────────────

  /** Swap URL/paste fields without a full re-render (preserves typed input). */
  private setSourceMode(mode: "url" | "text") {
    if (this.sourceMode === mode) return;
    this.sourceMode = mode;
    const isText = mode === "text";
    const urlBtn = document.getElementById("import-mode-url");
    const textBtn = document.getElementById("import-mode-text");
    urlBtn?.classList.toggle("active", !isText);
    textBtn?.classList.toggle("active", isText);
    urlBtn?.setAttribute("aria-pressed", String(!isText));
    textBtn?.setAttribute("aria-pressed", String(isText));
    const urlField = document.getElementById("import-url-field");
    const textField = document.getElementById("import-text-field");
    if (urlField) urlField.style.display = isText ? "none" : "";
    if (textField) textField.style.display = isText ? "" : "none";
  }

  /** Bot-block fetch errors → suggest the paste-text path. */
  private static isFetchBlocked(msg: string): boolean {
    return /403 Forbidden|blocked this request|429 Too Many Requests/i.test(msg);
  }

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
    const platformSelect = document.getElementById("import-platform") as HTMLSelectElement;
    const categorySelect = document.getElementById("import-category") as HTMLSelectElement;

    const isText = this.sourceMode === "text";
    const urlInput = document.getElementById("import-url") as HTMLInputElement;
    const pasteText = document.getElementById("import-paste-text") as HTMLTextAreaElement;
    const pasteUrl = document.getElementById("import-paste-url") as HTMLInputElement;

    if (isText) {
      if (!pasteText?.value.trim()) {
        showToast("Paste the page text first", "error");
        return;
      }
    } else if (!urlInput?.value.trim()) {
      showToast("Please enter a URL", "error");
      return;
    }

    const url = isText ? (pasteUrl?.value.trim() ?? "") : urlInput.value.trim();
    let platform = platformSelect?.value ?? this.platformOptions[0]?.value ?? "cisco-iosxe";
    let platformName: string | null = null;
    if (platform === NEW_PLATFORM) {
      const nameInput = document.getElementById("import-platform-name") as HTMLInputElement;
      const idInput = document.getElementById("import-platform-id") as HTMLInputElement;
      platformName = nameInput?.value.trim() ?? "";
      platform = slugify(idInput?.value ?? "") || slugify(platformName);
      if (!platformName) {
        showToast("Enter a platform name", "error");
        return;
      }
      if (!platform) {
        showToast("Platform ID must be lowercase letters, digits, and dashes", "error");
        return;
      }
    }
    let category = categorySelect?.value ?? "networking";
    if (category === OTHER_CATEGORY) {
      category = slugify((document.getElementById("import-category-custom") as HTMLInputElement)?.value ?? "");
      if (!category) {
        showToast("Enter a category name", "error");
        return;
      }
    }

    if (importJob.active) {
      showToast("An import job is already running — see the indicator in the title bar", "error");
      return;
    }

    this.stage = "fetching";
    this.errorMessage = "";
    this.preview = null;
    this.selectedRows = [];
    importJob.start(url, platform, category);
    showToast("Import started — extracting commands…", "info", 4000);
    this.render();

    try {
      let preview: ExtractPreview;
      if (isText) {
        log.info(LogTag.KbImport, `Extracting preview from pasted text (${pasteText!.value.trim().length} chars) for ${platform}/${category}`);
        preview = await extractKbPreviewFromText(pasteText!.value.trim(), url, platform, category, platformName ?? undefined);
      } else {
        log.info(LogTag.KbImport, `Extracting preview from ${url} for ${platform}/${category}`);
        // Phase 5.6: Stage 1 — extract + validate without writing.
        preview = await extractKbPreview(url, platform, category, platformName ?? undefined);
      }
      // Cancelled while extracting — discard the result.
      if (importJob.consumeCancel()) {
        this.stage = "idle";
        showToast("Import cancelled — nothing was imported", "info");
        this.render();
        return;
      }
      this.preview = preview;
      this.previewUrl = url;
      this.previewPlatform = platform;
      this.previewPlatformName = platformName;
      this.previewCategory = category;
      this.selectedRows = preview.previews.map((p) => p.status === "ok");
      this.stage = "preview";
      importJob.review(preview.previews.length);
      log.info(LogTag.KbImport, `Preview ready: ${preview.previews.length} commands`);
    } catch (e) {
      this.stage = "error";
      this.errorMessage = String(e);
      this.fetchBlocked = KbImportDialog.isFetchBlocked(this.errorMessage) && !isText;
      if (!importJob.active) {
        // Cancelled — the cancel line is already logged; just stop.
      } else {
        importJob.finish(false, `Import failed: ${e}`);
      }
      log.error(LogTag.KbImport, `Extract failed: ${e}`);
      showToast(`Extract failed: ${e}`, "error", 8000);
    }

    this.render();
  }

  /** docs/10 § Part 4: Stage 2 — commit only the accepted previews to YAML. */
  private async confirmPreview() {
    if (!this.preview || this.committing) return;
    const accepted = this.preview.previews.filter((_, i) => this.selectedRows[i]);
    if (accepted.length === 0) {
      showToast("No commands selected", "error");
      return;
    }
    this.committing = true;
    this.stage = "writing";
    this.render();

    try {
      const count = await commitKbImport(
        accepted,
        this.previewPlatform,
        this.previewCategory,
        this.previewPlatformName ?? undefined,
      );
      this.rejectedByUser = this.preview.previews.length - accepted.length;
      importJob.setResult({
        ok: true,
        commandsImported: count,
        targetFile: `${this.previewPlatform}/commands/${this.previewCategory}.yaml`,
        platform: this.previewPlatform,
        category: this.previewCategory,
      });
      this.stage = "complete";
      log.info(LogTag.KbImport, `Commit complete: ${count} commands`);
      showToast(`Import complete: ${count} commands imported`, "success");
      if (this.onImportComplete) this.onImportComplete();
    } catch (e) {
      this.stage = "error";
      this.errorMessage = String(e);
      importJob.finish(false, `Commit failed: ${e}`);
      log.error(LogTag.KbImport, `Commit failed: ${e}`);
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
    this.selectedRows = [];
    if (importJob.active) {
      importJob.finish(true, "Review discarded — nothing was imported");
    }
    this.render();
  }

}