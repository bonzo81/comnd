/**
 * Settings Screen — dedicated settings view (right of nav panel).
 *
 * Left icon nav (SETTINGS_NAV) switches between the 8 pages; page content
 * renders as SettingRow rows (label + description left, control right).
 * The LLM page owns the LLM connection settings used by KB import.
 * The nav panel's Settings section is a flat link here — page state is
 * kept in main.ts via onItemChanged so re-opening shows the last page.
 */

import {
  getAppConfig, saveLlmSettings, testLlmConnection, setLogLevel,
  setLogMaxSize, setLogFilePath, setMaxSessions, setDuplicateSessionPolicy, setShortcutOverrides, exportData, importData,
  setSessionLogging, setSessionLogTimestamps, setSessionLogDir, getSessionLogDir,
  scanMerge, applyMerge, restartApp, MergeConflict,
  AppConfig, listProviders, getProviderState,
  saveProviderConfig, saveProviderSecret, ProviderInfo, ProviderState,
  netboxGetConfig, netboxSaveConfig, netboxSaveToken, netboxTestConnection,
  netboxSync, netboxGetDevices, netboxSetDeviceEnabled, netboxGetStatus,
  netboxGetSites, netboxGetRoles, netboxGetTags,
  NetBoxConfig, NetBoxDeviceEntry, NetBoxChoice,
} from "../lib/tauri-api";
import { getVersion } from "@tauri-apps/api/app";
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
import { checkForUpdatesNow, currentUpdateAction, getUpdateStatus, subscribeUpdates } from "../lib/updater";
import { getSearchIncludeTags, setSearchIncludeTags } from "../lib/search-prefs";
import { normalizeDuplicateSessionPolicy } from "../lib/duplicate-session";
import { ConfigSaveDescriptor, ConfigSaver } from "../lib/config-save";
import { getAutoCopyEnabled, setAutoCopyEnabled } from "../lib/auto-copy";
import { getOutputHighlightEnabled, setOutputHighlightEnabled } from "../lib/output-highlight";
  import { APP_THEMES, getAppTheme, setAppTheme, Theme } from "../lib/theme";
  import { openModal } from "../lib/modal";
import {
  enable as rcEnable, disable as rcDisable, update as rcUpdate,
  resetToPreset as rcReset, getReadingComfortState, isReadingComfortEnabled, RC_PRESET,
} from "../lib/reading-comfort";
import {
  getTerminalFontSize, getTerminalScrollback, setTerminalFontSize, setTerminalScrollback,
  TERMINAL_FONT_MIN, TERMINAL_FONT_MAX, TERMINAL_SCROLLBACK_MIN, TERMINAL_SCROLLBACK_MAX,
} from "../lib/terminal-prefs";
import {
  findMapConflict, formatCombo, getOverrides, parseCombo, reservedComboReason,
  resolvedCombo, setOverrides, SECTION_TITLES, SHORTCUT_DEFS, SHORTCUT_SECTIONS,
  ShortcutAction, ShortcutDef,
} from "../lib/shortcuts";

/** Icon-nav entries — one per settings page, in rail order. The main nav
 *  panel's Settings sub-items (nav-panel.ts SETTINGS_ITEMS) use the same
 *  ids; the two stay in sync via setItem()/onItemChanged. */
const SETTINGS_NAV: { id: string; label: string; icon: keyof typeof icons }[] = [
  { id: "general", label: "General", icon: "sliders" },
  { id: "logging", label: "Logging", icon: "fileText" },
  { id: "theme", label: "Theme", icon: "paintbrush" },
  { id: "terminal", label: "Terminal", icon: "monitor" },
  { id: "reading-comfort", label: "Reading Comfort", icon: "type" },
  { id: "llm", label: "LLM API / KB Import", icon: "bot" },
  { id: "auth", label: "Auth Integrations", icon: "lock" },
  { id: "netbox", label: "NetBox", icon: "netbox" },
  { id: "shortcuts", label: "Shortcuts", icon: "keyboard" },
];

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

/** Class string for a test/save outcome line — shared by the LLM and NetBox
 *  panes so both read the same. Colour comes from the import-test-* rules. */
function inlineStatusClass(kind: "ok" | "err" | "progress" | ""): string {
  return `settings-inline-status${kind ? ` import-test-${kind}` : ""}`;
}

export class SettingsScreen {
  private container: HTMLElement | null = null;
  private itemId = "llm";
  private config: AppConfig | null = null;
  /** One transactional save path for every config field on this screen.
   *  Exposed so page-level tests can assert each control is wired to the
   *  descriptor it should be. */
  readonly saver = new ConfigSaver({
    getConfig: () => this.config,
    setConfig: (config) => { this.config = config; },
    refreshConfig: () => this.refreshConfig(),
  });
  private sessionLogDefaultDir = "";
  /** Running app version from the Tauri app plugin (issue #102); "" hides
   *  the rail footer rather than showing a placeholder. */
  private appVersion = "";
  private availableModels: string[] = [];
  private providerStatuses = new Map<string, ProviderInfo>();
  private providerStates = new Map<string, ProviderState>();
  // ── NetBox state ──
  private netboxConfig: NetBoxConfig | null = null;
  private netboxToggleRequest = 0;
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
  /** Called when the in-screen icon nav switches pages so main.ts can keep
   *  `settingsItemId` and the nav panel's sub-item highlight in step. */
  onItemChanged: (id: string) => void = () => {};
  /** Set just before a nav-driven re-render; render() focuses the active
   *  icon-nav item afterwards so keyboard users keep their place. */
  private pendingNavFocus = false;
  /** Set when setItem() actually changes the page, consumed by the next
   *  render(). Drives the rail's pill settle so it plays on a page switch and
   *  never on the many other renders this screen does (saves, toggles, loads). */
  private navChanged = false;
  /** Called when a NetBox action changes the merged host tree (sync, enable
   *  toggle, device toggle) so the nav panel can re-fetch. */
  onTreeChanged: () => void = () => {};

  setItem(id: string) {
    // Auth re-fetches on every show (refresh-on-mount); other items no-op.
    if (this.itemId === id && id !== "auth" && id !== "netbox") return;
    this.navChanged = this.itemId !== id;
    this.itemId = id;
    // Only the load for the *current* item may re-render. An auth/netbox
    // load resolving after the user switched pages would rebuild the DOM
    // (rail included) mid-interaction — dropping keyboard focus from the
    // rail and clobbering the visible page with a redundant render.
    if (id === "auth") {
      void this.loadProviders().then(() => { if (this.itemId === id) this.render(); });
    } else if (id === "netbox") {
      void this.loadNetbox().then(() => { if (this.itemId === id) this.render(); });
    } else {
      this.render();
    }
  }

  /** Re-read the saved config after another surface persisted a change — the
   *  duplicate-session dialog writes `duplicate_session_policy` while this
   *  screen is mounted but hidden, so its cached snapshot would show the old
   *  value on the next visit. */
  async reloadConfig() {
    await this.refreshConfig();
    if (this.itemId === "general") this.render();
  }

  async mount(container: HTMLElement) {
    this.container = container;
    // Runs alongside the config read, but with its own catch: a version
    // failure must not blank the config, and the rail footer simply hides.
    const version = getVersion().catch(() => "");
    try {
      [this.config, this.sessionLogDefaultDir] = await Promise.all([
        getAppConfig(),
        getSessionLogDir().catch(() => ""),
      ]);
    } catch {
      this.config = null;
    }
    this.appVersion = await version;
    this.render();

    // Re-render when the mode is toggled elsewhere (status bar) while open.
    // Slider drags dispatch the same event — only re-render on state flips.
    let rcLastEnabled = isReadingComfortEnabled();
    window.addEventListener("comnd:reading-comfort", () => {
      const now = isReadingComfortEnabled();
      if (now !== rcLastEnabled) {
        rcLastEnabled = now;
        this.render();
      }
    });

    // A shortcut save re-emits "comnd:shortcuts": keep the rows in sync
    // with the registry. Mid-capture the live chip keeps its state —
    // only restore focus.
    window.addEventListener("comnd:shortcuts", () => {
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
    const label = SETTINGS_NAV.find((n) => n.id === this.itemId)?.label ?? "Settings";
    const appVersion = this.appVersion.trim();
    const body =
      this.itemId === "llm" ? this.renderLlm()
      : this.itemId === "general" ? this.renderGeneral()
      : this.itemId === "logging" ? this.renderLogging()
      : this.itemId === "theme" ? this.renderTheme()
      : this.itemId === "terminal" ? this.renderTerminal()
      : this.itemId === "reading-comfort" ? this.renderReadingComfort()
      : this.itemId === "auth" ? this.renderAuth()
      : this.itemId === "netbox" ? this.renderNetBox()
      : this.itemId === "shortcuts" ? this.renderShortcuts()
      : this.renderPlaceholder(label);
    this.container.innerHTML = `
      <div class="settings-screen">
        <nav class="settings-nav${this.navChanged ? " nav-switched" : ""}" aria-label="Settings sections">
          ${SETTINGS_NAV.map((item) => {
            const active = item.id === this.itemId;
            return `
              <button type="button" class="settings-nav-item${active ? " active" : ""}"
                      data-item-id="${item.id}"
                      ${active ? 'aria-current="true" tabindex="0"' : 'tabindex="-1"'}>
                ${icons[item.icon]}
                <span class="settings-nav-label">${escHtml(item.label)}</span>
              </button>`;
          }).join("")}
          ${appVersion
            ? `<span class="settings-nav-version">Version v${escHtml(appVersion)}</span>`
            : ""}
        </nav>
        <div class="settings-page">
          ${body}
        </div>
      </div>
    `;
    // Consumed by the rail markup above for this pass only.
    this.navChanged = false;
    this.bindEvents();
    this.bindNavEvents();
    if (this.pendingNavFocus) {
      this.pendingNavFocus = false;
      this.container.querySelector<HTMLButtonElement>(".settings-nav-item.active")?.focus();
    }
  }

  /** Icon nav: click switches pages; roving tabindex + arrows mirror the
   *  nav panel's keyboard pattern (docs/specs/accessibility.md). */
  private bindNavEvents() {
    const nav = this.container?.querySelector<HTMLElement>(".settings-nav");
    if (!nav) return;
    nav.querySelectorAll<HTMLButtonElement>(".settings-nav-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.itemId ?? "";
        if (!id || id === this.itemId) return;
        this.pendingNavFocus = document.activeElement === btn;
        this.setItem(id);
        this.onItemChanged(id);
      });
    });
    nav.addEventListener("keydown", (e) => {
      const items = Array.from(nav.querySelectorAll<HTMLButtonElement>(".settings-nav-item"));
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      let next = -1;
      if (e.key === "ArrowDown") next = (current + 1) % items.length;
      else if (e.key === "ArrowUp") next = (current - 1 + items.length) % items.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = items.length - 1;
      if (next < 0 || current < 0) return;
      e.preventDefault();
      items.forEach((b, i) => (b.tabIndex = i === next ? 0 : -1));
      items[next].focus();
    });
  }

  // ─── SettingRow helpers ─────────────────────────────────────────

  /** Info button — a small "i" that shows `text` on hover or keyboard focus.
   *  `warn` swaps the icon for an alert triangle in the warning colour, for
   *  detail the user must not miss.
   *  The button's accessible name is the full text, so a screen reader hears
   *  the detail without the tooltip. */
  private infoButton(text: string, warn = false): string {
    const icon = warn ? icons.alert : icons.info;
    const cls = warn ? "settings-info settings-info-warn" : "settings-info";
    return `<button type="button" class="${cls}" aria-label="${escAttr(text)}">${icon}<span class="settings-info-tip" aria-hidden="true">${escHtml(text)}</span></button>`;
  }

  /** SettingRow — label and optional info tooltip left, control right.
   *  `info` is the tooltip text and `value` is a live readout under the label
   *  (slider values, status lines). A row with no label shows `info` as plain
   *  text, because there is no title to attach the tooltip to. `warn` paints
   *  the tooltip icon as a warning. */
  private row(label: string, control: string, info = "", forId = "", value = "", warn = false): string {
    const labelHtml = label
      ? `<span class="settings-row-heading">
           <label class="settings-row-label"${forId ? ` for="${escAttr(forId)}"` : ""}>${label}</label>
           ${info ? this.infoButton(info, warn) : ""}
         </span>`
      : "";
    const detailHtml = label
      ? (value ? `<span class="settings-row-value">${value}</span>` : "")
      : (info ? `<span class="settings-row-desc">${info}</span>` : "");
    return `
      <div class="settings-row">
        <div class="settings-row-text">${labelHtml}${detailHtml}</div>
        <div class="settings-row-control">${control}</div>
      </div>`;
  }

  /** Block variant: label and info tooltip on top, full-width control below —
   *  for wide widgets (path inputs, textarea, multi-select). */
  private rowBlock(label: string, control: string, info = "", forId = "", value = "", warn = false): string {
    const labelHtml = label
      ? `<span class="settings-row-heading">
           <label class="settings-row-label"${forId ? ` for="${escAttr(forId)}"` : ""}>${label}</label>
           ${info ? this.infoButton(info, warn) : ""}
         </span>`
      : "";
    const detailHtml = label
      ? (value ? `<span class="settings-row-value">${value}</span>` : "")
      : (info ? `<span class="settings-row-desc">${info}</span>` : "");
    return `
      <div class="settings-row settings-row-block">
        <div class="settings-row-text">${labelHtml}${detailHtml}</div>
        <div class="settings-row-control">${control}</div>
      </div>`;
  }

  /** Boolean row — native checkbox restyled as a pill switch (`.settings-switch`).
   *  The input element and its bindings are unchanged. */
  private switchRow(
    id: string,
    label: string,
    desc: string,
    checked: boolean,
    extraAttrs = "",
    warn = false,
  ): string {
    return this.row(
      label,
      `<input type="checkbox" id="${escAttr(id)}" class="settings-switch" ${checked ? "checked" : ""} ${extraAttrs} />`,
      desc,
      id,
      "",
      warn,
    );
  }

  /** Small muted group label — whitespace separation only, no divider. */
  private group(label: string, info = ""): string {
    return `<div class="settings-group-label">${escHtml(label)}${info ? this.infoButton(info) : ""}</div>`;
  }

  private renderLlm(): string {
    const apiFormat = this.config?.llm_api_format ?? "openai";
    const baseUrl = this.config?.llm_base_url ?? "http://localhost:11434";
    const model = this.config?.llm_model ?? "";
    const apiKey = this.config?.llm_api_key ?? "";
    const ctxLen = this.config?.llm_context_length ?? 64000;
    return `
      <form class="settings-form" id="llm-settings-form">
        ${this.row("API format", `
          <select class="form-input form-input-sm" id="llm-format">
            <option value="openai" ${apiFormat === "openai" ? "selected" : ""}>OpenAI-compatible</option>
            <option value="anthropic" ${apiFormat === "anthropic" ? "selected" : ""}>Anthropic</option>
          </select>`,
          "OpenAI-compatible covers OpenAI, Gemini, Ollama, LM Studio, Unsloth, Groq, and OpenRouter. Anthropic covers Claude.",
          "llm-format")}
        ${this.row("Provider preset", `
          <select class="form-input form-input-sm" id="llm-provider-preset">
            <option value="">— Choose a provider… —</option>
            ${LLM_PROVIDER_PRESETS.map((p) => `<option value="${escAttr(p.url)}">${escHtml(p.name)}</option>`).join("")}
          </select>`,
          "Fills the base URL. You can edit the URL after you pick a provider.",
          "llm-provider-preset")}
        ${this.row("Base URL", `
          <input type="url" class="form-input" id="llm-url" value="${escAttr(baseUrl)}" required />`,
          "For example http://localhost:11434 (Ollama), https://api.openai.com, or https://api.anthropic.com.",
          "llm-url")}
        ${this.row("Model", this.renderModelSelect(model), "", "llm-model-select")}
        ${this.row("API key", `
          <input type="password" class="form-input" id="llm-key" value="${escAttr(apiKey)}" placeholder="Leave empty for local servers" autocomplete="off" />`,
          "", "llm-key")}
        ${this.row("Reply token limit", `
          <input type="number" class="form-input" id="llm-ctx" value="${ctxLen}" min="4096" step="1024" />`,
          "The largest reply Comnd asks for, sent as max_tokens. Comnd clamps it to between 1,024 and 8,192 tokens.",
          "llm-ctx")}
        <div class="settings-inline-actions">
          <span class="${inlineStatusClass("")}" id="llm-test-status"></span>
          <button type="button" class="btn-secondary btn-small" id="llm-test-btn">${icons.bot} Test connection</button>
        </div>
        <div class="settings-actions">
          <button type="submit" class="btn-primary">Save settings</button>
        </div>
      </form>
    `;
  }

  private renderModelSelect(currentModel: string): string {
    if (this.availableModels.length === 0) {
      return `
        <select class="form-input" id="llm-model-select">
          <option value="${escAttr(currentModel)}" ${currentModel ? "selected" : ""}>${currentModel ? escHtml(currentModel) : "Run Test connection to load models"}</option>
        </select>
      `;
    }
    // Keep the saved model selectable even if the server no longer lists it.
    const options = this.availableModels.includes(currentModel)
      ? this.availableModels
      : [currentModel, ...this.availableModels].filter(Boolean);
    return `
      <select class="form-input" id="llm-model-select">
        ${options.map((m) => `<option value="${escAttr(m)}" ${m === currentModel ? "selected" : ""}>${escHtml(m)}</option>`).join("")}
      </select>
    `;
  }

  private renderGeneral(): string {
    const fmt = getTimestampFormat();
    const tagsOn = getSearchIncludeTags();
    const autoCopy = getAutoCopyEnabled();
    const highlight = getOutputHighlightEnabled();
    const maxSessions = this.config?.max_sessions ?? 30;
    const dupPolicy = normalizeDuplicateSessionPolicy(this.config?.duplicate_session_policy);
    const opt = (value: TimestampFormat, label: string) =>
      `<option value="${value}" ${fmt === value ? "selected" : ""}>${label}</option>`;
    const sessionOpt = (value: number, label: string) =>
      `<option value="${value}" ${maxSessions === value ? "selected" : ""}>${label}</option>`;
    const dupOpt = (value: string, label: string) =>
      `<option value="${value}" ${dupPolicy === value ? "selected" : ""}>${label}</option>`;
    return `
      <div class="settings-form">
        ${this.row("Timestamp format", `
          <select class="form-input form-input-sm" id="ts-format">
            ${opt("24h", "24-hour — 14:32:05")}
            ${opt("12h", "12-hour — 2:32:05 PM")}
            ${opt("24h-ms", "24-hour with ms — 14:32:05.123")}
          </select>`,
          "Open terminals update immediately.", "ts-format")}
        ${this.switchRow("auto-copy", "Copy text on selection",
          "Copies highlighted terminal text to the clipboard as you select it.", autoCopy)}
        ${this.switchRow("output-highlight", "Highlight terminal output",
          "Colors IP addresses, interface names, status words (up, down, error), and command keywords.", highlight)}
        ${this.row("Maximum sessions", `
          <select class="form-input form-input-sm" id="max-sessions">
            ${sessionOpt(10, "10")}
            ${sessionOpt(20, "20")}
            ${sessionOpt(30, "30 (default)")}
            ${sessionOpt(50, "50")}
            ${sessionOpt(100, "100")}
            ${sessionOpt(0, "Unlimited")}
          </select>`,
          "Limits open SSH connections so the app does not use too much memory. Applies immediately.", "max-sessions")}
        ${this.row("Duplicate session", `
          <select class="form-input form-input-sm" id="duplicate-session-policy">
            ${dupOpt("ask", "Ask each time (default)")}
            ${dupOpt("allow", "Open another session")}
            ${dupOpt("focus", "Switch to the existing session")}
          </select>`,
          "Sets what Comnd does when you connect to a host that is already connected.", "duplicate-session-policy")}
        ${this.group("Search")}
        ${this.switchRow("search-tags", "Search command tags",
          "When off, search matches command names and aliases only.", tagsOn)}
        ${this.group("Data")}
        ${this.row("", `
          <button type="button" id="data-export" class="btn-secondary btn-small">Export backup...</button>
          <button type="button" id="data-import" class="btn-secondary btn-small">Restore from backup...</button>`,
          "Export saves hosts, groups, configuration, known hosts, and the knowledge base to a zip file. Restore replaces your current data and keeps a backup of it. Restart the app after a restore.")}
        ${this.group("Updates")}
        ${this.row("", `
          <button type="button" id="check-updates" class="btn-secondary btn-small">Check for updates</button>`,
          `<span id="update-status">Checks for updates when the app starts.</span>`)}
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
        ${this.group("App log")}
        ${this.row("Log level", `
          <select class="form-input form-input-sm" id="log-level">
            ${levelOpt("debug", "Debug")}
            ${levelOpt("info", "Info")}
            ${levelOpt("warn", "Warn")}
            ${levelOpt("error", "Error")}
          </select>`,
          "Debug shows suggestion queries and terminal resize events. Applies immediately.", "log-level")}
        ${this.row("Log size limit", `
          <select class="form-input form-input-sm" id="log-max-size">
            ${sizeOpt(0, "Off")}
            ${sizeOpt(5, "5 MB")}
            ${sizeOpt(10, "10 MB")}
            ${sizeOpt(50, "50 MB")}
            ${sizeOpt(100, "100 MB")}
          </select>`,
          "The app truncates the file when it reaches the limit. Applies at next start.", "log-max-size")}
        ${this.rowBlock("Log file path", `
          <input type="text" class="form-input" id="log-file-path"
            value="${escAttr(this.config?.log_file_path ?? "")}"
            placeholder="Default: app data dir"
            spellcheck="false" autocomplete="off" />
          <button type="button" id="log-file-browse" class="btn-secondary btn-small">Browse...</button>
          <button type="button" id="log-file-reset" class="btn-link">Reset</button>`,
          "Leave empty for the default location. Applies at next start. A custom folder can have different access permissions, so the default location is safer.",
          "log-file-path")}
        ${this.group("Session logs")}
        ${this.switchRow("session-logging", "Log session output",
          "Saves terminal output to one file per connection, including the sign-in prompts Comnd writes itself. Typed input is never logged, but a password the device echoes on screen is. Keep the log folder private. Applies to new connections.",
          this.config?.session_logging ?? true,
          "",
          true)}
        ${this.switchRow("session-log-timestamps", "Add timestamps",
          "Adds an [HH:MM:SS] stamp before each chunk of output.",
          this.config?.session_log_timestamps ?? true)}
        ${this.rowBlock("Session log folder", `
          <input type="text" class="form-input" id="session-log-dir"
            value="${escAttr(sessionDir)}"
            placeholder="Default: ${escAttr(this.sessionLogDefaultDir)}"
            spellcheck="false" autocomplete="off" />
          <button type="button" id="session-log-dir-browse" class="btn-secondary btn-small">Browse...</button>
          <button type="button" id="session-log-dir-reset" class="btn-link">Reset</button>`,
          "Leave empty for the default location. Applies to new connections.",
          "session-log-dir")}
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
        ${this.row("App theme", `
          <select class="form-input form-input-sm" id="theme-app">
            ${opts}
          </select>`,
          "Changes the colors of every screen.", "theme-app")}
      </div>
    `;
  }

  private renderTerminal(): string {
    const scrollback = getTerminalScrollback();
    return `
      <div class="settings-form">
        ${this.group("History")}
        ${this.row("Scrollback", `
          <input type="range" class="form-input" id="terminal-scrollback" min="${TERMINAL_SCROLLBACK_MIN}" max="${TERMINAL_SCROLLBACK_MAX}" step="1000" value="${scrollback}" />`,
          "Lines kept above the visible screen. A larger history holds more device output but uses more memory. Open terminals update immediately.",
          "terminal-scrollback", `${scrollback} lines`)}
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
        ${this.switchRow("rc-enabled", "Enable Reading Comfort",
          "Sets readable defaults for dyslexic readers. Every value below stays adjustable. Turning it off restores your previous font size and keeps your theme.",
          on)}
        ${on ? `
        ${this.row("", `<button type="button" id="rc-reset" class="btn-text">Reset to preset</button>`)}
        ${this.group("Adjustments")}
        ${this.row("Terminal font size", `
          <input type="range" class="form-input" id="rc-font-size" min="${TERMINAL_FONT_MIN}" max="${TERMINAL_FONT_MAX}" step="1" value="${fontSize}" />`,
          "The terminal zoom shortcuts (Ctrl+= and Ctrl+-) change this value too.", "rc-font-size", `${fontSize}px`)}
        ${this.row("UI text scale", `
          <input type="range" class="form-input" id="rc-ui-scale" min="1.0" max="1.5" step="0.05" value="${uiScale}" />`,
          "Scales interface text, not terminal output.", "rc-ui-scale", `${uiScale.toFixed(2)}×`)}
        ${this.row("Terminal line height", `
          <input type="range" class="form-input" id="rc-line-height" min="1.0" max="1.8" step="0.05" value="${lineHeight}" />`,
          "Sets the vertical space between terminal lines.", "rc-line-height", `${lineHeight.toFixed(2)}`)}
        ${this.row("Terminal letter spacing", `
          <input type="range" class="form-input" id="rc-letter-spacing" min="0" max="6" step="0.5" value="${letterSpacing}" />`,
          "Sets the horizontal space between characters.", "rc-letter-spacing", `${letterSpacing}px`)}
        ` : `<p class="settings-row-desc">Turn on Reading Comfort to show the sliders.</p>`}
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
        ${this.switchRow("netbox-enabled", "Enable NetBox",
          "Puts NetBox devices in the host list, in their own NetBox folder. Nothing syncs until you click Refresh. Changes here save automatically.",
          enabled)}

        <div class="netbox-body${enabled ? "" : " netbox-body-disabled"}">
          ${this.group("Connection")}
          ${this.row("NetBox URL", `
            <input type="url" class="form-input" id="netbox-url"
                   placeholder="https://netbox.example.com" spellcheck="false" autocomplete="off"
                   value="${escAttr(cfg?.base_url ?? "")}" />`,
            "", "netbox-url")}
          ${this.row("API token", `
            <input type="password" class="form-input" id="netbox-token"
                   placeholder="${this.netboxHasToken ? "Saved — enter a new token to replace" : "Paste a NetBox API token"}"
                   autocomplete="off" spellcheck="false" />`,
            "Create a token in NetBox under your profile, then API Tokens. Read access to DCIM is enough. Comnd stores the token in the OS keychain. Test the URL and token, then click Save connection.",
            "netbox-token")}
          <div class="settings-inline-actions">
            <span class="${inlineStatusClass(testLine ? (testLine.ok ? "ok" : "err") : "")}" id="netbox-test-status">${escHtml(testLine?.text ?? "")}</span>
            <button type="button" class="btn-secondary btn-small" id="netbox-test-btn">${icons.bot} Test connection</button>
          </div>
          ${this.switchRow("netbox-invalid-certs", "Allow self-signed certificates",
            "Skips TLS checks for the NetBox URL. This is for home labs with a self-signed or internal certificate authority. Off by default, because it lets an attacker read the API token. Trust the certificate authority in the OS certificate store instead.",
            !!cfg?.allow_invalid_certs)}
          <div class="settings-actions">
            <button type="button" class="btn-primary" id="netbox-token-save" ${this.netboxTestOk ? "" : "disabled"}>Save connection</button>
          </div>

          ${this.group("Filters")}
          ${this.row("Device status", `
            <input type="text" class="form-input" id="netbox-filter-status" placeholder="active"
                   value="${escAttr(cfg ? (filters.status ?? "") : "active")}" />`,
            "Sets the NetBox status slug. Leave empty to sync devices in any status.", "netbox-filter-status")}
          ${this.renderFilterMultiSelect("netbox-filter-sites", "Sites", "Search sites…", this.netboxSites, filters.sites)}
          ${this.renderFilterMultiSelect("netbox-filter-roles", "Roles", "Search roles…", this.netboxRoles, filters.roles)}
          ${this.renderFilterMultiSelect("netbox-filter-tags", "Tags", "Search tags…", this.netboxTags, filters.tags)}

          ${this.group("Platforms")}
          ${this.row("Unknown platforms", `
            <select class="form-input form-input-sm" id="netbox-platform-policy">
              <option value="skip" ${cfg?.platform_policy !== "fallback" ? "selected" : ""}>Skip the device</option>
              <option value="fallback" ${cfg?.platform_policy === "fallback" ? "selected" : ""}>Use the fallback platform</option>
            </select>`,
            "Known NetBox platform slugs (cisco-ios, nx-os, f5-tmos, ubuntu) map automatically. This rule also covers devices with no platform.",
            "netbox-platform-policy")}
          <div class="settings-row" id="netbox-fallback-field"${cfg?.platform_policy === "fallback" ? "" : " hidden"}>
            <div class="settings-row-text">
              <label class="settings-row-label" for="netbox-platform-fallback">Fallback platform</label>
            </div>
            <div class="settings-row-control">
              <select class="form-input form-input-sm" id="netbox-platform-fallback">
                ${platformOpt("cisco-iosxe", "Cisco IOS-XE")}
                ${platformOpt("cisco-nxos", "Cisco NX-OS")}
                ${platformOpt("f5-tmos", "F5 TMOS")}
                ${platformOpt("linux-bash", "Linux Bash")}
              </select>
            </div>
          </div>
          ${this.rowBlock("Platform overrides", `
            <textarea class="form-input" id="netbox-platform-overrides" rows="3"
                      placeholder="juniper-junos=linux-bash">${escHtml(overridesText)}</textarea>`,
            "One per line: netbox-slug=platform. This wins over the built-in table.",
            "netbox-platform-overrides")}

          ${this.group("Default authentication",
            "Fills each field a device leaves unset in Configure. Every field falls back on its own, so a device can keep its own username and still inherit this port.")}
          ${this.row("Username", `
            <input type="text" class="form-input" id="netbox-default-username" placeholder="e.g. netadmin"
                   autocomplete="off" value="${escAttr(cfg?.default_username ?? "")}" />`,
            "", "netbox-default-username")}
          ${this.row("Port", `
            <input type="number" class="form-input" id="netbox-default-port" min="1" max="65535"
                   value="${cfg?.default_port ?? 22}" />`,
            "", "netbox-default-port")}
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
            noProvidersHint: "Turn on a secret manager in Settings → Auth Integrations first.",
          })}

          ${this.group("Devices")}
          ${this.switchRow("netbox-show-empty-folders", "Show empty folders",
            "Show all cached regions, sites, and locations, including folders with no enabled hosts.",
            !!cfg?.show_empty_folders)}
          <span class="settings-row-desc settings-block-intro" id="netbox-status-line">${this.netboxStatusLine()}</span>
          <div class="settings-toolbar">
            <input type="text" class="form-input" id="netbox-device-search" placeholder="Search devices…"
                   value="${escAttr(this.netboxDeviceSearch)}" />
            <button type="button" class="btn-secondary" id="netbox-sync-btn">${icons.refresh} Refresh now</button>
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
    if (!this.netboxConfig?.enabled) return "Off. Turn on NetBox above, then click Refresh now to sync devices.";
    if (devices.length === 0) return "No cached devices. Click Refresh now to sync from NetBox.";
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
            <span class="hs-host-badge ${platformColorClass(d.platform)}">${escHtml(platformBadge(d.platform))}</span>
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
            <input type="checkbox" data-provider-toggle="${p.id}" class="settings-switch" ${state.enabled ? "checked" : ""} ${disabled ? "disabled" : ""} />
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
            <span class="import-hint">Create a Personal Access Token in Proton Pass, then paste it here. If you log in with pass-cli, leave this field empty.</span>
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
    return `<p class="settings-placeholder">Coming soon. The ${escHtml(label)} settings are not available yet.</p>`;
  }

  // ─── Shortcuts pane (docs/specs/11 §Settings UI) ──────────────────

  private renderShortcuts(): string {
    const hasOverrides = Object.keys(getOverrides()).length > 0;
    const sections = SHORTCUT_SECTIONS.map((section) => {
      const rows = SHORTCUT_DEFS.filter((d) => d.section === section)
        .map((d) => this.renderShortcutRow(d))
        .join("");
      return `<div class="settings-group-label">${escHtml(SECTION_TITLES[section])}</div>${rows}`;
    }).join("");
    return `
      <div class="settings-form">
        <div class="sc-toolbar">
          <span class="import-hint">Click Change, press the new keys, then press Enter. Esc cancels. The new keys work immediately and after a restart.</span>
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
      const why = "Comnd always uses Ctrl here. The remote shell reads the Ctrl+Space byte, and Cmd+Space opens Spotlight on macOS.";
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
   *  comnd:shortcuts event re-render this pane and any open help modal —
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
        const verb = currentUpdateAction() === "open-release-page" ? "open the latest release" : "install";
        el.textContent = `Update ${s.version ?? ""} available — click the icon in the title bar to ${verb}.`;
        break;
      }
      case "downloading":
        el.textContent = "Downloading update…";
        break;
      case "installed":
        el.textContent = "Update installed — Comnd is restarting.";
        break;
      case "error":
        el.textContent = `Update check failed: ${s.error ?? "unknown error"}`;
        break;
      default:
        // idle — keep the default hint text.
        break;
    }
  }

  // ── Config save descriptors (issue #148) ────────────────────────────────
  // One descriptor per persisted field: the write, the control to restore on
  // failure, and how the stored config renders back into that control.
  //
  // `control` is a getter: render() rebuilds the page, so a save still in
  // flight must restore whatever is mounted now. Restoring the element the
  // descriptor was built with would update a detached node and leave the
  // visible setting on the rejected value.

  private logLevelDescriptor(level: string): ConfigSaveDescriptor<HTMLSelectElement> {
    const resolve = () => this.container?.querySelector<HTMLSelectElement>("#log-level") ?? null;
    return {
      field: { key: "log_level", failure: "Failed to save log level" },
      get control() { return resolve(); },
      write: () => setLogLevel(level),
      apply: (config, select) => { select.value = config?.log_level ?? "info"; },
    };
  }

  private logMaxSizeDescriptor(maxMb: number): ConfigSaveDescriptor<HTMLSelectElement> {
    const resolve = () => this.container?.querySelector<HTMLSelectElement>("#log-max-size") ?? null;
    return {
      field: { key: "log_max_size_mb", failure: "Failed to save log file size" },
      get control() { return resolve(); },
      write: () => setLogMaxSize(maxMb),
      apply: (config, select) => { select.value = String(config?.log_max_size_mb ?? 10); },
    };
  }

  private maxSessionsDescriptor(max: number): ConfigSaveDescriptor<HTMLSelectElement> {
    const resolve = () => this.container?.querySelector<HTMLSelectElement>("#max-sessions") ?? null;
    return {
      field: { key: "max_sessions", failure: "Failed to save session limit" },
      get control() { return resolve(); },
      write: () => setMaxSessions(max),
      apply: (config, select) => { select.value = String(config?.max_sessions ?? 30); },
    };
  }

  private duplicatePolicyDescriptor(policy: string): ConfigSaveDescriptor<HTMLSelectElement> {
    const resolve =
      () => this.container?.querySelector<HTMLSelectElement>("#duplicate-session-policy") ?? null;
    return {
      field: { key: "duplicate_session_policy", failure: "Failed to save duplicate session policy" },
      get control() { return resolve(); },
      write: () => setDuplicateSessionPolicy(policy),
      apply: (config, select) => {
        select.value = normalizeDuplicateSessionPolicy(config?.duplicate_session_policy);
      },
    };
  }

  private sessionLoggingDescriptor(enabled: boolean): ConfigSaveDescriptor<HTMLInputElement> {
    const resolve = () => this.container?.querySelector<HTMLInputElement>("#session-logging") ?? null;
    return {
      field: { key: "session_logging", failure: "Failed to save session logging" },
      get control() { return resolve(); },
      write: () => setSessionLogging(enabled),
      apply: (config, input) => { input.checked = config?.session_logging ?? true; },
    };
  }

  private sessionLogTimestampsDescriptor(enabled: boolean): ConfigSaveDescriptor<HTMLInputElement> {
    const resolve =
      () => this.container?.querySelector<HTMLInputElement>("#session-log-timestamps") ?? null;
    return {
      field: { key: "session_log_timestamps", failure: "Failed to save session log timestamps" },
      get control() { return resolve(); },
      write: () => setSessionLogTimestamps(enabled),
      apply: (config, input) => { input.checked = config?.session_log_timestamps ?? true; },
    };
  }

  private sessionLogDirDescriptor(
    dir: string | null,
    failure = "Failed to save session log directory",
  ): ConfigSaveDescriptor<HTMLInputElement> {
    const resolve = () => this.container?.querySelector<HTMLInputElement>("#session-log-dir") ?? null;
    return {
      field: { key: "session_log_dir", failure },
      get control() { return resolve(); },
      write: () => setSessionLogDir(dir),
      apply: (config, input) => { input.value = config?.session_log_dir ?? ""; },
    };
  }

  private logFilePathDescriptor(
    path: string | null,
    failure = "Failed to save log file path",
  ): ConfigSaveDescriptor<HTMLInputElement> {
    const resolve = () => this.container?.querySelector<HTMLInputElement>("#log-file-path") ?? null;
    return {
      field: { key: "log_file_path", failure },
      get control() { return resolve(); },
      write: () => setLogFilePath(path),
      apply: (config, input) => { input.value = config?.log_file_path ?? ""; },
    };
  }

  /** Rewrites the readout under a slider's label with the value actually
   *  applied. The range input accepts values the library clamps, so the raw
   *  `input.value` can disagree with what took effect. */
  private setRowReadout(selector: string, text: string): void {
    const row = this.container?.querySelector<HTMLElement>(selector)?.closest(".settings-row");
    const value = row?.querySelector<HTMLElement>(".settings-row-value");
    if (value) value.textContent = text;
  }

  /** Info tooltips — open state, hover delay, and Escape dismissal.
   *
   *  A CSS `:hover` reveal cannot satisfy WCAG 1.4.13: Escape would hide the
   *  bubble and `:hover` would put it back, and a hover-only tip with focus
   *  elsewhere sent Escape on to `main.ts`, which leaves Settings. Open state
   *  is therefore a `data-tip-open` attribute. The bubble hangs below the row
   *  rather than against the 16px icon, so a close waits out a grace period
   *  long enough to carry the pointer across that gap onto the bubble, which
   *  is itself hoverable. Escape hides the bubble without moving focus and
   *  stops there; with no tip open the key falls through as before. */
  private bindInfoTooltips(): void {
    const page = this.container?.querySelector<HTMLElement>(".settings-page");
    if (!page) return;
    const HOVER_DELAY_MS = 350;
    const CLOSE_GRACE_MS = 250;
    let openTimer: number | undefined;
    let closeTimer: number | undefined;

    const buttons = () => page.querySelectorAll<HTMLElement>(".settings-info");
    const closeAll = () => {
      window.clearTimeout(openTimer);
      window.clearTimeout(closeTimer);
      buttons().forEach((btn) => btn.removeAttribute("data-tip-open"));
    };
    const buttonFor = (target: EventTarget | null) =>
      target instanceof Element ? target.closest<HTMLElement>(".settings-info") : null;
    const leavesButton = (btn: HTMLElement, next: EventTarget | null) =>
      !(next instanceof Node && btn.contains(next));

    page.addEventListener("pointerover", (e) => {
      const btn = buttonFor(e.target);
      if (!btn) return;
      window.clearTimeout(closeTimer);
      buttons().forEach((other) => {
        if (other !== btn) other.removeAttribute("data-tip-open");
      });
      if (btn.hasAttribute("data-tip-open")) return;
      window.clearTimeout(openTimer);
      openTimer = window.setTimeout(() => btn.setAttribute("data-tip-open", ""), HOVER_DELAY_MS);
    });

    page.addEventListener("pointerout", (e) => {
      const btn = buttonFor(e.target);
      if (!btn || !leavesButton(btn, (e as PointerEvent).relatedTarget)) return;
      window.clearTimeout(openTimer);
      closeTimer = window.setTimeout(() => btn.removeAttribute("data-tip-open"), CLOSE_GRACE_MS);
    });

    page.addEventListener("focusin", (e) => {
      const btn = buttonFor(e.target);
      if (btn) btn.setAttribute("data-tip-open", "");
    });

    page.addEventListener("focusout", (e) => {
      const btn = buttonFor(e.target);
      if (btn && leavesButton(btn, (e as FocusEvent).relatedTarget)) {
        btn.removeAttribute("data-tip-open");
      }
    });

    page.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !page.querySelector(".settings-info[data-tip-open]")) return;
      e.preventDefault();
      e.stopPropagation();
      closeAll();
    });
  }

  private bindEvents() {
    this.bindInfoTooltips();

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
      const level = (e.target as HTMLSelectElement).value;
      void this.saver.save(this.logLevelDescriptor(level), level);
    });

    this.container?.querySelector<HTMLSelectElement>("#log-max-size")?.addEventListener("change", (e) => {
      const maxMb = parseInt((e.target as HTMLSelectElement).value, 10);
      void this.saver.save(this.logMaxSizeDescriptor(maxMb), maxMb);
    });

    this.container?.querySelector<HTMLSelectElement>("#max-sessions")?.addEventListener("change", (e) => {
      const max = parseInt((e.target as HTMLSelectElement).value, 10);
      void this.saver.save(this.maxSessionsDescriptor(max), max);
    });

    this.container?.querySelector<HTMLSelectElement>("#duplicate-session-policy")?.addEventListener("change", (e) => {
      const value = (e.target as HTMLSelectElement).value;
      void this.saver.save(this.duplicatePolicyDescriptor(value), value);
    });

    this.container?.querySelector<HTMLInputElement>("#session-logging")?.addEventListener("change", (e) => {
      const enabled = (e.target as HTMLInputElement).checked;
      void this.saver.save(this.sessionLoggingDescriptor(enabled), enabled);
    });

    this.container?.querySelector<HTMLInputElement>("#session-log-timestamps")?.addEventListener("change", (e) => {
      const enabled = (e.target as HTMLInputElement).checked;
      void this.saver.save(this.sessionLogTimestampsDescriptor(enabled), enabled);
    });

    this.container?.querySelector<HTMLInputElement>("#session-log-dir")?.addEventListener("change", (e) => {
      const v = (e.target as HTMLInputElement).value.trim();
      void this.saver.save(this.sessionLogDirDescriptor(v || null), v || null);
    });

    this.container?.querySelector<HTMLInputElement>("#session-log-dir")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void this.browseSessionLogDir();
    });

    this.container?.querySelector<HTMLButtonElement>("#session-log-dir-reset")?.addEventListener("click", () => {
      const input = this.container?.querySelector<HTMLInputElement>("#session-log-dir");
      if (input) input.value = "";
      void this.saver.save(
        this.sessionLogDirDescriptor(null, "Failed to reset session log directory"),
        null,
      );
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
      void this.saver.save(this.logFilePathDescriptor(v || null), v || null);
    });

    this.container?.querySelector<HTMLInputElement>("#log-file-path")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void this.browseLogFile();
    });

    this.container?.querySelector<HTMLButtonElement>("#log-file-reset")?.addEventListener("click", () => {
      const input = this.container?.querySelector<HTMLInputElement>("#log-file-path");
      if (input) input.value = "";
      void this.saver.save(
        this.logFilePathDescriptor(null, "Failed to reset log file path"),
        null,
      );
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
      this.setRowReadout("#rc-font-size", `${getTerminalFontSize()}px`);
    });

    this.container?.querySelector<HTMLInputElement>("#terminal-scrollback")?.addEventListener("input", (e) => {
      setTerminalScrollback(parseInt((e.target as HTMLInputElement).value, 10));
      this.setRowReadout("#terminal-scrollback", `${getTerminalScrollback()} lines`);
    });

    this.container?.querySelector<HTMLInputElement>("#rc-ui-scale")?.addEventListener("input", (e) => {
      rcUpdate({ uiScale: parseFloat((e.target as HTMLInputElement).value) });
      this.setRowReadout("#rc-ui-scale", `${(getReadingComfortState()?.uiScale ?? RC_PRESET.uiScale).toFixed(2)}×`);
    });

    this.container?.querySelector<HTMLInputElement>("#rc-line-height")?.addEventListener("input", (e) => {
      rcUpdate({ lineHeight: parseFloat((e.target as HTMLInputElement).value) });
      this.setRowReadout("#rc-line-height", `${(getReadingComfortState()?.lineHeight ?? RC_PRESET.lineHeight).toFixed(2)}`);
    });

    this.container?.querySelector<HTMLInputElement>("#rc-letter-spacing")?.addEventListener("input", (e) => {
      rcUpdate({ letterSpacing: parseFloat((e.target as HTMLInputElement).value) });
      this.setRowReadout("#rc-letter-spacing", `${getReadingComfortState()?.letterSpacing ?? RC_PRESET.letterSpacing}px`);
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
      "#netbox-show-empty-folders",
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
    // It saves ONLY the toggle merged onto the saved config, so the persisted
    // `enabled` always equals the visible toggle (issue #11).
    this.container?.querySelector<HTMLInputElement>("#netbox-enabled")?.addEventListener("change", async (e) => {
      const el = e.target as HTMLInputElement;
      const on = el.checked;
      const request = ++this.netboxToggleRequest;
      const body = this.container?.querySelector<HTMLElement>(".netbox-body");
      body?.classList.toggle("netbox-body-disabled", !on);
      let saveAttempted = false;
      try {
        const saved = this.netboxConfig ?? (await netboxGetConfig()).config;
        if (request !== this.netboxToggleRequest) return;
        saveAttempted = true;
        const config = await netboxSaveConfig({ ...saved, enabled: on }, null);
        if (request !== this.netboxToggleRequest) return;
        this.netboxConfig = config;
        log.debug(LogTag.Netbox, "enable toggle saved", { enabled: on });
        this.onTreeChanged();
      } catch (err) {
        log.error(LogTag.Netbox, "enable toggle save failed", err);
        if (request !== this.netboxToggleRequest) return;
        try {
          // A save can commit before keyring cleanup fails; read back its
          // actual state instead of assuming rejection means no write.
          const config = saveAttempted ? (await netboxGetConfig()).config : this.netboxConfig;
          if (request !== this.netboxToggleRequest) return;
          this.netboxConfig = config;
          const persisted = config?.enabled ?? false;
          el.checked = persisted;
          body?.classList.toggle("netbox-body-disabled", !persisted);
          if (saveAttempted) this.onTreeChanged();
        } catch (readErr) {
          log.error(LogTag.Netbox, "enable toggle reconciliation failed", readErr);
        }
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
    const q = (id: string) => this.container?.querySelector<HTMLInputElement>(`#${id}`);
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
      show_empty_folders: !!q("netbox-show-empty-folders")?.checked,
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
    const foldersChanged = config.show_empty_folders !== this.netboxConfig?.show_empty_folders;
    log.debug(LogTag.Netbox, "autosave fired", { enabled: config.enabled, base_url: config.base_url });
    try {
      this.netboxConfig = await netboxSaveConfig(config, password);
      log.debug(LogTag.Netbox, "autosave saved ok", { enabled: this.netboxConfig.enabled });
      if (config.default_credential?.type !== "password") this.netboxDefaultPwSaved = false;
      if (foldersChanged) this.onTreeChanged();
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
        show_empty_folders: false,
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
      status.className = inlineStatusClass(this.netboxTestLine.ok ? "ok" : "err");
    } else if (status) {
      status.textContent = "";
      status.className = inlineStatusClass("");
    }
    const saveBtn = this.container?.querySelector<HTMLButtonElement>("#netbox-token-save");
    if (saveBtn) saveBtn.disabled = !this.netboxTestOk;
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
      status.className = inlineStatusClass("progress");
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
      btn.innerHTML = `${icons.refresh} Syncing…`;
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
        btn.innerHTML = `${icons.refresh} Refresh now`;
      }
    }
  }

  /** Newest read wins: a read started earlier must not commit a snapshot that
   *  a later refresh (or a save's optimistic patch) already superseded. */
  private refreshSeq = 0;

  private async refreshConfig() {
    const seq = ++this.refreshSeq;
    try {
      const config = await getAppConfig();
      if (seq === this.refreshSeq) this.config = config;
    } catch {
      // keep existing config
    }
  }

  private async browseLogFile(): Promise<void> {
    try {
      const selected = await save({
        defaultPath: "comnd.log",
        filters: [{ name: "Log files", extensions: ["log"] }],
      });
      if (selected) {
        const input = this.container?.querySelector<HTMLInputElement>("#log-file-path");
        if (input) input.value = selected;
        await this.saver.save(this.logFilePathDescriptor(selected), selected);
      }
    } catch {
      // User cancelled — no-op. A rejected write is reported by ConfigSaver.
    }
  }

  private async browseSessionLogDir(): Promise<void> {
    try {
      const selected = await open({ directory: true });
      if (selected) {
        const input = this.container?.querySelector<HTMLInputElement>("#session-log-dir");
        if (input) input.value = selected;
        await this.saver.save(this.sessionLogDirDescriptor(selected), selected);
      }
    } catch {
      // User cancelled — no-op. A rejected write is reported by ConfigSaver.
    }
  }

  private async exportData(): Promise<void> {
    try {
      const dest = await save({
        defaultPath: "comnd-backup.zip",
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
        <button class="modal-choice" id="import-overwrite">
          <span>Overwrite everything</span>
          <span class="import-hint">Replaces all current data with the backup. Comnd deletes files that are not in the backup.</span>
        </button>
        <button class="modal-choice" id="import-merge">
          <span>Merge</span>
          <span class="import-hint">Combines current and backup data. You review each conflict before Comnd changes anything.</span>
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
      status.className = inlineStatusClass("progress");
    }
    try {
      const models = await testLlmConnection();
      this.availableModels = models;
      if (status) {
        status.textContent = `Connected — ${models.length} model${models.length !== 1 ? "s" : ""} available`;
        status.className = inlineStatusClass("ok");
      }
      showToast(`Connected! ${models.length} model${models.length !== 1 ? "s" : ""} available`, "success");
      this.render();
    } catch (e) {
      this.availableModels = [];
      if (status) {
        status.textContent = `Connection failed: ${e}`;
        status.className = inlineStatusClass("err");
      }
      showToast(`Connection failed: ${e}`, "error");
    } finally {
      if (btn) {
        btn.disabled = false;
      }
    }
  }
}
