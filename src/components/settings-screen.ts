/**
 * Settings Screen — dedicated settings view (right of nav panel).
 *
 * Sub-items: LLM API / KB Import (functional), General + Shortcuts (placeholders).
 * The LLM sub-item owns the LLM connection settings used by KB import.
 */

import {
  getAppConfig, saveLlmSettings, testLlmConnection, setLogLevel,
  setLogMaxSize, setLogFilePath, setMaxSessions, setShortcutOverrides, exportData, importData,
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
import { escAttr, escHtml } from "../lib/format";
import { collectCredential, renderCredentialFieldset, updateCredentialVisibility } from "../lib/credential-fieldset";
import { relativeTime } from "../lib/format";
import { icons } from "../lib/icons";
import { platformBadge, platformColorClass } from "../lib/platforms";
import {
  getTimestampFormat,
  setTimestampFormat,
  TimestampFormat,
} from "../lib/timestamps";
import { checkForUpdatesNow, getUpdateStatus, subscribeUpdates, updateAction } from "../lib/updater";
import { getSearchIncludeTags, setSearchIncludeTags } from "../lib/search-prefs";
import { getAutoCopyEnabled, setAutoCopyEnabled } from "../lib/auto-copy";
import { getOutputHighlightEnabled, setOutputHighlightEnabled } from "../lib/output-highlight";
  import { APP_THEMES, getAppTheme, setAppTheme, Theme } from "../lib/theme";
  import { openModal } from "../lib/modal";
import {
  enable as rcEnable, disable as rcDisable, update as rcUpdate,
  resetToPreset as rcReset, getReadingComfortState, isReadingComfortEnabled, RC_PRESET,
} from "../lib/reading-comfort";
import { getTerminalFontSize, setTerminalFontSize, TERMINAL_FONT_MIN, TERMINAL_FONT_MAX } from "../lib/terminal-prefs";
import {
  findMapConflict, formatCombo, getOverrides, parseCombo, reservedComboReason,
  resolvedCombo, setOverrides, SECTION_TITLES, SHORTCUT_DEFS, SHORTCUT_SECTIONS,
  ShortcutAction, ShortcutDef,
} from "../lib/shortcuts";

const LABELS: Record<string, string> = {
  general: "General",
  logging: "Logging",
  theme: "Theme",
  "reading-comfort": "Reading Comfort",
  llm: "LLM API / KB Import",
  auth: "Auth Integrations",
  netbox: "NetBox",
  shortcuts: "Shortcuts",
};

/** Quick-setup presets for the Base URL. Not exhaustive — the URL field stays
 *  editable after selection. All are OpenAI-compatible (Anthropic is entered
 *  manually via the API Format dropdown). */
const LLM_PROVIDER_PRESETS: { name: string; url: string }[] = [
  { name: "Ollama (local)", url: "http://localhost:11434/v1" },
  { name: "LM Studio (local)", url: "http://localhost:1234/v1" },
  { name: "Unsloth (local)", url: "http://localhost:8888/v1" },
  { name: "OpenAI", url: "https://api.openai.com/v1" },
  { name: "Groq", url: "https://api.groq.com/openai/v1" },
  { name: "Mistral AI", url: "https://api.mistral.ai/v1" },
  { name: "DeepSeek", url: "https://api.deepseek.com/v1" },
  { name: "xAI (Grok)", url: "https://api.x.ai/v1" },
  { name: "Together AI", url: "https://api.together.xyz/v1" },
  { name: "OpenRouter", url: "https://openrouter.ai/api/v1" },
];

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
  private itemId = "llm";
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
  // ── Shortcuts pane state (docs/specs/11 §Settings UI) ──
  /** Row currently capturing a new combo, or null. */
  private scCapturing: ShortcutAction | null = null;
  /** Live candidate for the capturing row — parseCombo output, exactly
   *  what matches() will resolve once saved. */
  private scCandidate: string | null = null;
  /** Validation message for the aria-live region (reserved-key rejection
   *  or conflict explanation). */
  private scNotice: string | null = null;
  /** Conflict pair painted in warning colour on both rows, if any. */
  private scConflict: { a: ShortcutAction; b: ShortcutAction; combo: string } | null = null;
  /** Document capture-phase keydown listener, active only mid-capture. */
  private scKeyHandler: ((e: KeyboardEvent) => void) | null = null;
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

    // Re-render when the mode is toggled elsewhere (status bar) while open.
    // Slider drags dispatch the same event — only re-render on state flips.
    let rcLastEnabled = isReadingComfortEnabled();
    window.addEventListener("netssh:reading-comfort", () => {
      const now = isReadingComfortEnabled();
      if (now !== rcLastEnabled) {
        rcLastEnabled = now;
        this.render();
      }
    });

    // A shortcut save re-emits "netssh:shortcuts": keep the rows in sync
    // with the registry. Mid-capture the live chip keeps its state —
    // only restore focus.
    window.addEventListener("netssh:shortcuts", () => {
      if (!this.container || this.itemId !== "shortcuts") return;
      if (this.scCapturing) {
        this.focusCaptureChip();
        return;
      }
      this.render();
    });
  }

  unmount() {
    this.container = null;
    this.clearCaptureState();
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
      this.itemId === "llm" ? this.renderLlm()
      : this.itemId === "general" ? this.renderGeneral()
      : this.itemId === "logging" ? this.renderLogging()
      : this.itemId === "theme" ? this.renderTheme()
      : this.itemId === "reading-comfort" ? this.renderReadingComfort()
      : this.itemId === "auth" ? this.renderAuth()
      : this.itemId === "netbox" ? this.renderNetBox()
      : this.itemId === "shortcuts" ? this.renderShortcuts()
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

  private renderLlm(): string {
    const apiFormat = this.config?.llm_api_format ?? "openai";
    const baseUrl = this.config?.llm_base_url ?? "http://localhost:11434";
    const model = this.config?.llm_model ?? "";
    const apiKey = this.config?.llm_api_key ?? "";
    const ctxLen = this.config?.llm_context_length ?? 64000;
    return `
      <form class="settings-form" id="llm-settings-form">
        <div class="import-field">
          <label for="llm-format">API Format</label>
          <select class="form-input" id="llm-format">
            <option value="openai" ${apiFormat === "openai" ? "selected" : ""}>OpenAI-compatible</option>
            <option value="anthropic" ${apiFormat === "anthropic" ? "selected" : ""}>Anthropic</option>
          </select>
          <span class="import-hint">Covers OpenAI, Gemini, Ollama, llama.cpp, vLLM, LM Studio, Unsloth, Groq, OpenRouter, … (OpenAI-compatible) and Claude (Anthropic)</span>
        </div>
        <div class="import-field">
          <label for="llm-provider-preset">Quick Setup</label>
          <select class="form-input" id="llm-provider-preset">
            <option value="">— Choose a provider… —</option>
            ${LLM_PROVIDER_PRESETS.map((p) => `<option value="${escAttr(p.url)}">${escHtml(p.name)}</option>`).join("")}
          </select>
          <span class="import-hint">Fills the Base URL below — edit it freely afterwards. Pick a local provider for Ollama/LM Studio.</span>
        </div>
        <div class="import-field">
          <label for="llm-url">Base URL</label>
          <input type="url" class="form-input" id="llm-url" value="${escAttr(baseUrl)}" required />
          <span class="import-hint">e.g., http://localhost:11434 (Ollama), https://api.openai.com, https://api.anthropic.com</span>
        </div>
        <div class="import-field">
          <label for="llm-model-select">Model</label>
          ${this.renderModelSelect(model)}
        </div>
        <div class="import-field">
          <label for="llm-key">API Key (cloud only)</label>
          <input type="password" class="form-input" id="llm-key" value="${escAttr(apiKey)}" placeholder="Leave empty for local servers" autocomplete="off" />
        </div>
        <div class="import-field">
          <label for="llm-ctx">Context Length</label>
          <input type="number" class="form-input" id="llm-ctx" value="${ctxLen}" min="4096" step="1024" />
          <span class="import-hint">Output budget per LLM request — also passed to OpenAI-compatible servers as max_tokens. Does not change what the server accepts per call.</span>
        </div>
        <div class="import-config-row">
          <button type="button" class="btn-secondary btn-small" id="llm-test-btn">${icons.bot} Test Connection</button>
          <span class="import-model-info" id="llm-test-status"></span>
        </div>
        <div class="settings-actions">
          <button type="submit" class="btn-primary">Save Settings</button>
        </div>
      </form>
    `;
  }

  private renderModelSelect(currentModel: string): string {
    if (this.availableModels.length === 0) {
      return `
        <select class="form-input form-input-mono" id="llm-model-select">
          <option value="${escAttr(currentModel)}" ${currentModel ? "selected" : ""}>${currentModel ? escHtml(currentModel) : "— Run Test Connection to load models —"}</option>
        </select>
      `;
    }
    // Keep the saved model selectable even if the server no longer lists it.
    const options = this.availableModels.includes(currentModel)
      ? this.availableModels
      : [currentModel, ...this.availableModels].filter(Boolean);
    return `
      <select class="form-input form-input-mono" id="llm-model-select">
        ${options.map((m) => `<option value="${escAttr(m)}" ${m === currentModel ? "selected" : ""}>${escHtml(m)}</option>`).join("")}
      </select>
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
        <h3 class="settings-section-title">Updates</h3>
        <div class="import-field">
          <div class="log-file-row">
            <button type="button" id="check-updates" class="btn-secondary">Check for updates</button>
          </div>
          <span class="import-hint" id="update-status">netssh checks for updates on startup. When an update is available, an icon appears in the title bar — click it to install (or to open the latest release on macOS).</span>
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
              value="${escAttr(this.config?.log_file_path ?? "")}"
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
            <span class="import-hint">Warning: logs capture everything on screen and everything you type, including passwords (enable, sudo). Keep the log directory private.</span>
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
              value="${escAttr(sessionDir)}"
              placeholder="Default: ${escAttr(this.sessionLogDefaultDir)}"
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

  private renderReadingComfort(): string {
    const on = isReadingComfortEnabled();
    const s = getReadingComfortState();
    const fontSize = getTerminalFontSize();
    const uiScale = s?.uiScale ?? RC_PRESET.uiScale;
    const lineHeight = s?.lineHeight ?? RC_PRESET.lineHeight;
    const letterSpacing = s?.letterSpacing ?? RC_PRESET.letterSpacing;
    return `
      <div class="settings-form">
        <h3 class="settings-section-title">Reading Comfort</h3>
        <label class="settings-toggle">
          <input type="checkbox" id="rc-enabled" ${on ? "checked" : ""} />
          <span>
            Enable Reading Comfort
            <span class="import-hint">Recommended settings for dyslexic readers and anyone who finds text hard to read. Applies readability defaults as a starting point; every value below stays adjustable via its slider. Turning off restores your previous font size; your theme choice is kept.</span>
          </span>
        </label>
        ${on ? `
        <div class="log-file-row">
          <button type="button" id="rc-reset" class="btn-text">Reset to preset</button>
        </div>
        <h3 class="settings-section-title">Adjustments</h3>
        <div class="import-field">
          <label for="rc-font-size">Terminal font size</label>
          <input type="range" class="form-input" id="rc-font-size" min="${TERMINAL_FONT_MIN}" max="${TERMINAL_FONT_MAX}" step="1" value="${fontSize}" />
          <span class="import-hint">${fontSize}px — shared with the terminal zoom shortcuts (Ctrl+= / Ctrl+-)</span>
        </div>
        <div class="import-field">
          <label for="rc-ui-scale">UI text scale</label>
          <input type="range" class="form-input" id="rc-ui-scale" min="1.0" max="1.5" step="0.05" value="${uiScale}" />
          <span class="import-hint">${uiScale.toFixed(2)}× — scales all interface text (not terminal output)</span>
        </div>
        <div class="import-field">
          <label for="rc-line-height">Terminal line height</label>
          <input type="range" class="form-input" id="rc-line-height" min="1.0" max="1.8" step="0.05" value="${lineHeight}" />
          <span class="import-hint">${lineHeight.toFixed(2)} — vertical spacing between terminal lines</span>
        </div>
        <div class="import-field">
          <label for="rc-letter-spacing">Terminal letter spacing</label>
          <input type="range" class="form-input" id="rc-letter-spacing" min="0" max="6" step="0.5" value="${letterSpacing}" />
          <span class="import-hint">${letterSpacing}px — horizontal gap between characters</span>
        </div>
        ` : `<p class="import-hint">Enable Reading Comfort to reveal the adjustment sliders.</p>`}
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
          <input type="text" class="form-input" id="${id}" value="${escAttr(selected.join(", "))}" placeholder="Connect NetBox to enable selection" disabled />
          <input type="hidden" data-ms-hidden="${id}" value="${escAttr(selected.join(","))}" />
        </div>`;
    }
    const chips = selected.map((slug) => {
      const opt = options.find((o) => o.slug === slug);
      const display = opt ? opt.name : slug;
      return `<span class="ms-chip" data-ms-slug="${escAttr(slug)}">${escHtml(display)}<button type="button" class="ms-chip-x" aria-label="Remove">&times;</button></span>`;
    }).join("");
    const listItems = options.map((o) => {
      const sel = selected.includes(o.slug) ? " ms-item-selected" : "";
      return `<li class="ms-item${sel}" data-ms-slug="${escAttr(o.slug)}">${escHtml(o.name)}</li>`;
    }).join("");
    return `
      <div class="import-field">
        <label for="${id}-search">${label}</label>
        <div class="ms-wrap" data-ms-field="${id}">
          <div class="ms-chips">${chips || '<span class="ms-placeholder">' + escHtml(placeholder) + '</span>'}</div>
          <input type="text" class="form-input ms-search" id="${id}-search" placeholder="Search..." autocomplete="off" />
          <ul class="ms-dropdown" data-ms-list="${id}">${listItems}</ul>
        </div>
        <input type="hidden" id="${id}" value="${escAttr(selected.join(","))}" />
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
      return `<span class="ms-chip" data-ms-slug="${escAttr(slug)}">${escHtml(display)}<button type="button" class="ms-chip-x" aria-label="Remove">&times;</button></span>`;
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
                   value="${escAttr(cfg?.base_url ?? "")}" />
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
                   value="${escAttr(filters.status ?? "active")}" />
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
                   autocomplete="off" value="${escAttr(cfg?.default_username ?? "")}" />
          </div>
          <div class="import-field">
            <label for="netbox-default-port">Port</label>
            <input type="number" class="form-input" id="netbox-default-port" min="1" max="65535"
                   value="${cfg?.default_port ?? 22}" />
          </div>
          ${renderCredentialFieldset({
            name: "netbox_auth_type",
            credential: cred ?? null,
            providers: readyProviders.map((p) => ({ id: p.id, label: p.id })),
            idPrefix: "netbox-auth",
            defaultType: "none",
            extraRadios: [{ value: "none", checked: authType === "none", label: "None" }],
            passwordBadge: this.netboxHasDefaultPw(),
            passwordBadgeLabel: "Saved",
            passwordPlaceholder: this.netboxHasDefaultPw() ? "Leave blank to keep saved password" : "Enter default password",
            noProvidersHint: "Enable a secret manager in Settings → Auth Integrations first.",
          })}

          <div class="settings-actions">
            <button type="button" class="btn-secondary" id="netbox-sync-btn">${icons.folder} Refresh Now</button>
          </div>

          <h3 class="settings-section-title">Devices</h3>
          <div class="import-field">
            <input type="text" class="form-input" id="netbox-device-search" placeholder="Search devices…"
                   value="${escAttr(this.netboxDeviceSearch)}" />
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

  // ─── Shortcuts pane (docs/specs/11 §Settings UI) ──────────────────

  private renderShortcuts(): string {
    const hasOverrides = Object.keys(getOverrides()).length > 0;
    const sections = SHORTCUT_SECTIONS.map((section) => {
      const rows = SHORTCUT_DEFS.filter((d) => d.section === section)
        .map((d) => this.renderShortcutRow(d))
        .join("");
      return `<h3 class="settings-section-title">${escHtml(SECTION_TITLES[section])}</h3>${rows}`;
    }).join("");
    return `
      <div class="settings-form">
        <div class="sc-toolbar">
          <span class="import-hint">Click Change, press the new keys, then press Enter — Esc cancels. Rebindings apply immediately and survive a restart.</span>
          <button type="button" class="btn-text" id="sc-restore" ${hasOverrides ? "" : "disabled"}>Restore all defaults</button>
        </div>
        <p class="sc-live" id="sc-live" aria-live="polite">${this.scNotice ? escHtml(this.scNotice) : ""}</p>
        ${sections}
      </div>
    `;
  }

  private renderShortcutRow(def: ShortcutDef): string {
    const warned = this.scWarnIds().has(def.id);
    const describedBy = warned ? ` aria-describedby="sc-live"` : "";
    if (def.modLocked) {
      // Ctrl+Space: pinned to literal Ctrl on every platform — the remote
      // shell understands the byte, and Cmd+Space collides with Spotlight.
      // Locked: non-editable with an explanatory tooltip (spec §macOS).
      const why = "Pinned to Ctrl on every platform: the remote shell understands the Ctrl+Space byte, and Cmd+Space collides with macOS Spotlight.";
      return `
        <div class="shortcut-row"${describedBy}>
          <div class="shortcut-row-main">
            <span class="shortcut-row-label">${escHtml(def.label)}
              <span class="sc-lock" role="img" aria-label="${escAttr(why)}" title="${escAttr(why)}">${icons.lock}</span>
            </span>
            <span class="kbd-chip">${escHtml(formatCombo(resolvedCombo(def.id)))}</span>
          </div>
          <div class="shortcut-row-actions">
            <button type="button" class="btn-text" disabled title="${escAttr(why)}">Change</button>
          </div>
        </div>`;
    }
    if (this.scCapturing === def.id) {
      const candidate = this.scCandidate ? formatCombo(this.scCandidate) : "Press keys…";
      return `
        <div class="shortcut-row shortcut-row-capturing${warned ? " shortcut-row-warning" : ""}"${describedBy}>
          <div class="shortcut-row-main">
            <span class="shortcut-row-label">${escHtml(def.label)}</span>
            <span class="kbd-chip shortcut-capture" id="sc-capture" tabindex="-1">${escHtml(candidate)}</span>
          </div>
          <div class="shortcut-row-actions">
            <span class="sc-capture-hint">Enter saves · Esc cancels</span>
          </div>
        </div>`;
    }
    const override = getOverrides()[def.id];
    return `
      <div class="shortcut-row${warned ? " shortcut-row-warning" : ""}"${describedBy}>
        <div class="shortcut-row-main">
          <span class="shortcut-row-label">${escHtml(def.label)}</span>
          <span class="kbd-chip">${escHtml(formatCombo(resolvedCombo(def.id)))}</span>
        </div>
        <div class="shortcut-row-actions">
          <button type="button" class="btn-text" data-sc-change="${def.id}">Change</button>
          ${override ? `<button type="button" class="btn-text" data-sc-reset="${def.id}">Reset</button>` : ""}
        </div>
      </div>`;
  }

  /** Rows to paint in warning colour: both sides of the current conflict,
   *  or the capturing row when its candidate is reserved. */
  private scWarnIds(): Set<ShortcutAction> {
    const warn = new Set<ShortcutAction>();
    if (this.scConflict) {
      warn.add(this.scConflict.a);
      warn.add(this.scConflict.b);
    } else if (this.scNotice && this.scCapturing) {
      warn.add(this.scCapturing);
    }
    return warn;
  }

  /** Enter capture mode for one row. The document capture-phase listener
   *  owns every key while it runs — nothing reaches the app global
   *  handler, xterm, or any widget (spec §Capture flow). */
  private startCapture(id: ShortcutAction) {
    this.clearCaptureState();
    this.scCapturing = id;
    this.attachCaptureKeys();
    this.render();
    this.focusCaptureChip();
  }

  private endCapture() {
    this.clearCaptureState();
    this.render();
  }

  /** Detach the capture listener and drop all capture/validation state. */
  private clearCaptureState() {
    this.scCapturing = null;
    this.scCandidate = null;
    this.scNotice = null;
    this.scConflict = null;
    this.detachCaptureKeys();
  }

  private attachCaptureKeys() {
    this.detachCaptureKeys();
    this.scKeyHandler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        this.endCapture();
        return;
      }
      if (e.key === "Enter") {
        this.confirmCapture();
        return;
      }
      const combo = parseCombo(e);
      if (!combo) return; // modifier-only press — keep waiting
      this.scCandidate = combo;
      const reserved = reservedComboReason(combo);
      if (reserved) {
        this.scNotice = reserved;
        this.scConflict = null;
      } else {
        const c = findMapConflict({ ...getOverrides(), [this.scCapturing!]: combo });
        this.scConflict = c;
        this.scNotice = c ? this.scConflictText(c) : null;
      }
      this.render();
      this.focusCaptureChip();
    };
    document.addEventListener("keydown", this.scKeyHandler, true);
  }

  private detachCaptureKeys() {
    if (this.scKeyHandler) {
      document.removeEventListener("keydown", this.scKeyHandler, true);
      this.scKeyHandler = null;
    }
  }

  private focusCaptureChip() {
    this.container?.querySelector<HTMLElement>("#sc-capture")?.focus();
  }

  private confirmCapture() {
    const id = this.scCapturing;
    const combo = this.scCandidate;
    if (!id || !combo) return; // nothing captured yet — keep listening
    const reserved = reservedComboReason(combo);
    if (reserved) {
      this.scNotice = reserved;
      this.scConflict = null;
      this.render();
      this.focusCaptureChip();
      return; // stay in capture — pick different keys
    }
    const map = { ...getOverrides(), [id]: combo };
    const c = findMapConflict(map);
    if (c) {
      // Save is blocked while a conflict stands (spec §Settings UI).
      this.scNotice = this.scConflictText(c);
      this.scConflict = c;
      this.render();
      this.focusCaptureChip();
      return;
    }
    this.saveShortcutOverrides(map);
  }

  private scConflictText(c: { a: ShortcutAction; b: ShortcutAction; combo: string }): string {
    const label = (id: ShortcutAction) => SHORTCUT_DEFS.find((d) => d.id === id)?.label ?? id;
    return `“${label(c.a)}” and “${label(c.b)}” would both use ${formatCombo(c.combo)} — pick a different combination.`;
  }

  /** Reset one row to its default. Blocked when the resulting map would
   *  leave a conflict standing (e.g. another action was rebound onto this
   *  row's default); the message names the two actions that clash. */
  private resetShortcut(id: ShortcutAction) {
    this.clearCaptureState();
    const map = { ...getOverrides() };
    if (!(id in map)) {
      this.render();
      return;
    }
    delete map[id];
    const c = findMapConflict(map);
    if (c) {
      this.scNotice = this.scConflictText(c);
      this.scConflict = c;
      this.render();
      return;
    }
    this.saveShortcutOverrides(map);
  }

  /** Restore all defaults: an empty override map. Defaults are pairwise
   *  unique, so this can never leave a conflict standing. */
  private restoreShortcuts() {
    this.clearCaptureState();
    this.saveShortcutOverrides({});
  }

  /** Persist `map`, re-read it into the registry, and let the
   *  netssh:shortcuts event re-render this pane and any open help modal —
   *  bindings apply immediately, no restart (spec §Settings UI). */
  private saveShortcutOverrides(map: Record<string, string>) {
    this.clearCaptureState();
    void setShortcutOverrides(map)
      .then(() => setOverrides(map))
      .catch((e) => {
        showToast(`Failed to save shortcuts: ${e}`, "error");
        this.render();
      });
  }

  /** Reflects the updater state in the "Check for updates" status line. */
  private refreshUpdateStatus() {
    const el = this.container?.querySelector<HTMLElement>("#update-status");
    if (!el) return;
    const s = getUpdateStatus();
    switch (s.state) {
      case "checking":
        el.textContent = "Checking for updates…";
        break;
      case "no-update":
        el.textContent = "You're up to date.";
        break;
      case "update-available": {
        const verb = updateAction(s.platform) === "open-release-page" ? "open the latest release" : "install";
        el.textContent = `Update ${s.version ?? ""} available — click the icon in the title bar to ${verb}.`;
        break;
      }
      case "downloading":
        el.textContent = "Downloading update…";
        break;
      case "installed":
        el.textContent = "Update installed — netssh is restarting.";
        break;
      case "error":
        el.textContent = `Update check failed: ${s.error ?? "unknown error"}`;
        break;
      default:
        // idle — keep the default hint text.
        break;
    }
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

    // P1.4 — update check (Settings → General). SettingsScreen is persistent
    // (never destroyed), so the subscription needs no cleanup.
    this.container?.querySelector<HTMLButtonElement>("#check-updates")?.addEventListener("click", async () => {
      await checkForUpdatesNow();
      this.refreshUpdateStatus();
    });
    subscribeUpdates(() => this.refreshUpdateStatus());

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

    const form = this.container?.querySelector<HTMLElement>("#llm-settings-form");
    if (form) {
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        void this.saveSettings();
      });
    }

    this.container?.querySelector<HTMLElement>("#llm-test-btn")?.addEventListener("click", () => void this.testConnection());

    // Provider preset → fill the editable Base URL, then reset the dropdown
    // so it doesn't look like a saved selection.
    this.container?.querySelector<HTMLSelectElement>("#llm-provider-preset")?.addEventListener("change", (e) => {
      const sel = e.target as HTMLSelectElement;
      const url = sel.value;
      if (!url) return;
      const urlInput = this.container?.querySelector<HTMLInputElement>("#llm-url");
      if (urlInput) urlInput.value = url;
      sel.value = "";
    });

    this.container?.querySelector<HTMLSelectElement>("#theme-app")?.addEventListener("change", (e) => {
      setAppTheme((e.target as HTMLSelectElement).value as Theme);
    });

    this.container?.querySelector<HTMLInputElement>("#rc-enabled")?.addEventListener("change", (e) => {
      if ((e.target as HTMLInputElement).checked) rcEnable();
      else rcDisable();
      this.render();
    });

    this.container?.querySelector<HTMLInputElement>("#rc-font-size")?.addEventListener("input", (e) => {
      setTerminalFontSize(parseInt((e.target as HTMLInputElement).value, 10));
    });

    this.container?.querySelector<HTMLInputElement>("#rc-ui-scale")?.addEventListener("input", (e) => {
      rcUpdate({ uiScale: parseFloat((e.target as HTMLInputElement).value) });
    });

    this.container?.querySelector<HTMLInputElement>("#rc-line-height")?.addEventListener("input", (e) => {
      rcUpdate({ lineHeight: parseFloat((e.target as HTMLInputElement).value) });
    });

    this.container?.querySelector<HTMLInputElement>("#rc-letter-spacing")?.addEventListener("input", (e) => {
      rcUpdate({ letterSpacing: parseFloat((e.target as HTMLInputElement).value) });
    });

    this.container?.querySelector<HTMLButtonElement>("#rc-reset")?.addEventListener("click", () => {
      rcReset();
      this.render();
    });

    // ─── Shortcuts pane (docs/specs/11 §Settings UI) ────────────────
    this.container?.querySelectorAll<HTMLButtonElement>("[data-sc-change]").forEach((btn) => {
      btn.addEventListener("click", () => this.startCapture(btn.dataset.scChange as ShortcutAction));
    });

    this.container?.querySelectorAll<HTMLButtonElement>("[data-sc-reset]").forEach((btn) => {
      btn.addEventListener("click", () => this.resetShortcut(btn.dataset.scReset as ShortcutAction));
    });

    this.container?.querySelector<HTMLButtonElement>("#sc-restore")?.addEventListener("click", () => this.restoreShortcuts());

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
      "#netbox-default-username", "#netbox-default-port",
      'input[name="ssh_key_path"]', 'input[name="agent_identity"]',
      'select[name="secret_ref_provider"]', 'input[name="secret_ref_reference"]',
      'input[name="password"]',
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
    if (!this.container) return;
    updateCredentialVisibility(this.container, "netbox_auth_type", "netbox-auth");
  }

  /** Read the NetBox form into a config for auto-save. The URL always comes
   *  from the saved config — it only changes via Save Connection. */
  private collectNetboxConfig(): { config: NetBoxConfig; password: string | null } {
    const q = (id: string) => this.container?.querySelector<HTMLInputElement>(id);
    const val = (id: string) => (q(id)?.value ?? "").trim();
    const nameVal = (name: string) =>
      (this.container?.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`)?.value ?? "").trim();
    const listVal = (id: string) =>
      val(id)
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s);
    const { credential } = collectCredential("netbox_auth_type", (k) =>
      k === "netbox_auth_type"
        ? this.container?.querySelector<HTMLInputElement>('input[name="netbox_auth_type"]:checked')?.value ?? "none"
        : nameVal(k));

    const overrides: Record<string, string> = {};
    for (const line of (this.container?.querySelector<HTMLTextAreaElement>("#netbox-platform-overrides")?.value ?? "").split("\n")) {
      const idx = line.indexOf("=");
      if (idx <= 0) continue;
      const slug = line.slice(0, idx).trim();
      const platform = line.slice(idx + 1).trim();
      if (slug && platform) overrides[slug] = platform;
    }

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
    const password = (this.container?.querySelector<HTMLInputElement>('input[name="password"]')?.value ?? "") || null;
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
      const password = (this.container?.querySelector<HTMLInputElement>('input[name="password"]')?.value ?? "").trim() || null;
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
    const content = `
      <h3 id="restore-mode-title">Restore backup</h3>
      <p class="modal-intro">
        Choose how to restore from <strong>${escHtml(srcPath.split(/[\\/]/).pop() ?? srcPath)}</strong>:
      </p>
      <div class="modal-choice-list">
        <button class="btn-primary modal-choice" id="import-overwrite">
          <span>Overwrite everything</span>
          <span class="import-hint">Replaces all current data with the backup. Files not in the backup are deleted.</span>
        </button>
        <button class="btn-secondary modal-choice" id="import-merge">
          <span>Merge</span>
          <span class="import-hint">Combines current and backup data. You'll review any conflicts before anything is changed.</span>
        </button>
        <button class="btn-text" id="import-cancel">Cancel</button>
      </div>
    `;
    const modal = openModal({
      panelClass: "modal-panel-sm",
      content,
      onDismiss: () => modal.close(),
    });
    modal.panel.setAttribute("aria-labelledby", "restore-mode-title");

    const close = () => modal.close();
    modal.panel.querySelector<HTMLButtonElement>("#import-cancel")?.addEventListener("click", close);
    modal.panel.querySelector<HTMLButtonElement>("#import-overwrite")?.addEventListener("click", () => {
      close();
      void this.doOverwrite(srcPath);
    });
    modal.panel.querySelector<HTMLButtonElement>("#import-merge")?.addEventListener("click", () => {
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

    const content = `
      <h3 id="merge-conflicts-title">Merge conflicts</h3>
      <p class="modal-intro">
        ${newCount} new entries will be added. ${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"} need resolution:
      </p>
      <div class="modal-actions modal-actions-header">
        <button class="btn-text btn-xs" id="conflict-all-keep">Keep all current</button>
        <button class="btn-text btn-xs" id="conflict-all-backup">Use all backup</button>
      </div>
      <div class="conflict-list">
        ${conflictRows}
      </div>
      <div class="modal-actions">
        <button class="btn-text" id="conflict-cancel">Cancel</button>
        <button class="btn-primary" id="conflict-apply">Apply merge</button>
      </div>
    `;
    const modal = openModal({
      panelClass: "modal-panel-wide",
      content,
      onDismiss: () => modal.close(),
    });
    modal.panel.setAttribute("aria-labelledby", "merge-conflicts-title");

    const close = () => modal.close();

    modal.panel.querySelector<HTMLButtonElement>("#conflict-cancel")?.addEventListener("click", close);

    // "Apply to all" buttons
    modal.panel.querySelector<HTMLButtonElement>("#conflict-all-keep")?.addEventListener("click", () => {
      modal.panel.querySelectorAll<HTMLInputElement>('input[type="radio"][value="keep_current"]').forEach(r => r.checked = true);
    });
    modal.panel.querySelector<HTMLButtonElement>("#conflict-all-backup")?.addEventListener("click", () => {
      modal.panel.querySelectorAll<HTMLInputElement>('input[type="radio"][value="use_backup"]').forEach(r => r.checked = true);
    });

    // Apply button — collect resolutions and call applyMerge
    modal.panel.querySelector<HTMLButtonElement>("#conflict-apply")?.addEventListener("click", () => {
      const resolutions: Record<string, "keep_current" | "use_backup"> = {};
      conflicts.forEach((c, i) => {
        const selected = modal.panel.querySelector<HTMLInputElement>(`input[name="conflict-${i}"]:checked`);
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

  private async saveSettings() {
    const formatInput = this.container?.querySelector<HTMLSelectElement>("#llm-format");
    const urlInput = this.container?.querySelector<HTMLInputElement>("#llm-url");
    const modelInput = this.container?.querySelector<HTMLSelectElement>("#llm-model-select");
    const keyInput = this.container?.querySelector<HTMLInputElement>("#llm-key");
    const ctxInput = this.container?.querySelector<HTMLInputElement>("#llm-ctx");
    if (!urlInput || !modelInput) return;

    try {
      await saveLlmSettings(
        formatInput?.value ?? "openai",
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
    const btn = this.container?.querySelector<HTMLButtonElement>("#llm-test-btn");
    const status = this.container?.querySelector<HTMLElement>("#llm-test-status");
    if (btn) {
      btn.disabled = true;
    }
    if (status) {
      status.textContent = "Testing…";
      status.className = "import-model-info import-test-progress";
    }
    try {
      const models = await testLlmConnection();
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
