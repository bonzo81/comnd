import { getCurrentWindow } from "@tauri-apps/api/window";
import { HostScreen } from "./components/host-screen";
import { TerminalView } from "./components/terminal-view";
import { KbScreen } from "./components/kb-screen";
import { NavPanel } from "./components/nav-panel";
import { GlobalSearch } from "./components/global-search";
import { SettingsScreen } from "./components/settings-screen";
import { ReplayScreen } from "./components/replay-screen";
import { Host, getLogLevel, getLogStatus } from "./lib/tauri-api";
import { showToast } from "./lib/toast";
import { log, LogLevel, LogTag, setLogLevel } from "./lib/logger";
import { listen } from "@tauri-apps/api/event";
import { importJob } from "./lib/import-status";
import { icons } from "./lib/icons";
import { escHtml } from "./lib/format";
import { confirmDialog } from "./lib/confirm-dialog";
import { openModal, ModalHandle } from "./lib/modal";
import { TabState, activateTab as activateTabState, closeTab as closeTabState } from "./lib/tab-state";
import { getAppTheme, setAppTheme } from "./lib/theme";
import {
  isReadingComfortEnabled, enable as rcEnable, disable as rcDisable,
  update as rcUpdate, resetToPreset as rcReset, getReadingComfortState, RC_PRESET,
} from "./lib/reading-comfort";
import { getTerminalFontSize, setTerminalFontSize, TERMINAL_FONT_MIN, TERMINAL_FONT_MAX, TERMINAL_FONT_DEFAULT } from "./lib/terminal-prefs";
import { setToggleState } from "./lib/a11y";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
import "@fontsource/jetbrains-mono/700.css";
import "./styles/tokens.css";
import "./styles/main.css";

// App state
type AppView = "connections" | "terminal" | "knowledge-base" | "replay" | "settings";

interface SessionTab {
  host: Host;
  view: TerminalView;
  wrapper: HTMLElement;
}

class App {
  private currentView: AppView = "connections";
  private container: HTMLElement;
  private hostScreen: HostScreen;
  private activeHost: Host | null = null;

  // Persistent wrapper elements — never destroyed
  private hostScreenWrapper: HTMLElement;
  private kbScreen: KbScreen;
  private kbScreenWrapper: HTMLElement;
  private settingsWrapper: HTMLElement;
  private settingsScreen: SettingsScreen;
  private settingsItemId = "llm";
  private replayWrapper: HTMLElement | null = null;
  private replayScreen: ReplayScreen | null = null;
  private contentCol: HTMLElement;
  private bodyRow: HTMLElement;
  private navPanel: NavPanel;

  // Session tabs — one per connected host
  private tabs = new Map<string, SessionTab>();
  private activeTabId: string | null = null;
  private sessionTabBar: HTMLElement | null = null;
  private terminalArea: HTMLElement;

  // Track which host IDs have an active SSH session
  activeSessions = new Set<string>();

  // Global shortcuts modal (lives in app tab bar, visible in all views)
  private showShortcuts = false;
  private shortcutsModalHandle: ModalHandle | null = null;
  private globalSearch: GlobalSearch | null = null;

  // Bottom status bar (VS Code style)
  private sbSessions: HTMLElement | null = null;
  private sbView: HTMLElement | null = null;
  private sbReadingComfort: HTMLElement | null = null;
  private rcPopover: HTMLElement | null = null;
  private rcPopoverOn = false; // enabled-state the open popover was built with
  private rcPopoverOutside: ((e: MouseEvent) => void) | null = null;
  private rcPopoverEscape: ((e: KeyboardEvent) => void) | null = null;

  constructor() {
    this.container = document.getElementById("app")!;
    setAppTheme(getAppTheme());

    // Suppress native context menus everywhere except host list items
    document.addEventListener(
      "contextmenu",
      (e) => {
        const t = e.target as HTMLElement | null;
        if (!t || !t.closest(".hs-host-item")) e.preventDefault();
      },
      true
    );

    // Keep the status-bar Reading Comfort toggle in sync with pane/terminal toggles;
    // an open quick-adjust popover rebuilds only when the enabled state flips
    // (slider drags dispatch the same event — must not destroy a mid-drag slider)
    window.addEventListener("netssh:reading-comfort", () => {
      this.syncReadingComfort();
      const on = isReadingComfortEnabled();
      if (this.rcPopover && on !== this.rcPopoverOn && this.sbReadingComfort) {
        const cog = this.sbReadingComfort.parentElement?.querySelector<HTMLElement>(".rc-cog");
        if (cog) this.showRcPopover(cog);
      }
    });

    // Content column — holds the three view wrappers, sits right of nav panel
    this.contentCol = document.createElement("div");
    this.contentCol.className = "app-content";

    // Create persistent wrapper divs for views
    this.hostScreenWrapper = document.createElement("div");
    this.hostScreenWrapper.className = "app-view";
    this.hostScreenWrapper.style.display = "";

    this.terminalArea = document.createElement("div");
    this.terminalArea.className = "app-view";
    this.terminalArea.style.display = "none";

    this.contentCol.appendChild(this.hostScreenWrapper);
    this.contentCol.appendChild(this.terminalArea);

    // KB screen wrapper (persistent — import progress events never lost)
    this.kbScreenWrapper = document.createElement("div");
    this.kbScreenWrapper.className = "app-view";
    this.kbScreenWrapper.style.display = "none";
    this.contentCol.appendChild(this.kbScreenWrapper);

    // Settings view wrapper (persistent — settings form state survives view switches)
    this.settingsWrapper = document.createElement("div");
    this.settingsWrapper.className = "app-view";
    this.settingsWrapper.style.display = "none";
    this.contentCol.appendChild(this.settingsWrapper);

    // Command Replay management view wrapper
    this.replayWrapper = document.createElement("div");
    this.replayWrapper.className = "app-view";
    this.replayWrapper.style.display = "none";
    this.contentCol.appendChild(this.replayWrapper);
    this.replayScreen = new ReplayScreen();
    this.replayScreen.onTreeChanged = () => void this.navPanel.refresh();
    void this.replayScreen.mount(this.replayWrapper);

    this.settingsScreen = new SettingsScreen();
    this.settingsScreen.onTreeChanged = () => void this.navPanel.refresh();
    void this.settingsScreen.mount(this.settingsWrapper);

    // Body row — nav panel left, content right
    this.bodyRow = document.createElement("div");
    this.bodyRow.className = "app-body";
    this.container.appendChild(this.bodyRow);
    this.bodyRow.appendChild(this.contentCol);

    this.kbScreen = new KbScreen(
      () => this.showView("connections"),
      () => void this.navPanel.refresh(),
    );
    this.kbScreen.mount(this.kbScreenWrapper);

    // Mount host screen (recent sessions list)
    this.hostScreen = new HostScreen(
      this.onConnect.bind(this),
      () => this.activeSessions,
      () => void this.navPanel.refresh(),
    );
    this.hostScreen.mount(this.hostScreenWrapper);

    // Left nav panel (accordion sections + host tree)
    const navContainer = document.createElement("div");
    navContainer.className = "app-nav";
    this.bodyRow.insertBefore(navContainer, this.contentCol);
    this.navPanel = new NavPanel(navContainer, {
      onSelectHost: (hostId) => {
        this.showView("connections");
        this.hostScreen.selectHost(hostId);
      },
      onConnectHost: (hostId) => {
        const host = this.navPanel.getHost(hostId);
        if (host) this.onConnect(host);
      },
      onEditHost: (hostId) => {
        this.showView("connections");
        this.hostScreen.openEditHost(hostId);
      },
      onKbTab: (tab) => {
        this.kbScreen.setTab(tab);
        this.showView("knowledge-base");
      },
      onOpenReplay: () => {
        this.showView("replay");
      },
      onNewConnection: () => {
        this.showView("connections");
        this.hostScreen.openNewConnection();
      },
      onAddHostToGroup: (groupId) => {
        this.showView("connections");
        this.hostScreen.openAddHost(groupId);
      },
      onSelectSettings: (id) => {
        this.settingsItemId = id;
        this.showView("settings");
      },
      onTreeChanged: () => {
        void this.hostScreen.refresh();
      },
      getActiveSessions: () => this.activeSessions,
    });
    void this.navPanel.mount();

    log.info(LogTag.App, "Initialized");
    this.syncLogLevel();
    this.syncLogStatus();
    this.registerGlobalShortcuts();
    this.renderTitleBar();
    this.renderStatusBar();
  }

  private async syncLogLevel() {
    const level = await getLogLevel().catch(() => null);
    if (level) {
      setLogLevel(level as LogLevel);
    }
    try {
      await listen<string>("log-level-changed", (event) => {
        setLogLevel(event.payload as LogLevel);
      });
    } catch {
      // Tauri not running (unit test) — ignore
    }
  }

  private async syncLogStatus() {
    const status = await getLogStatus().catch(() => null);
    if (status) {
      showToast(status, "error", 8000);
    }
    try {
      await listen<string>("log-location-warning", (event) => {
        showToast(event.payload, "error", 8000);
      });
    } catch {
      // Tauri not running (unit test) — ignore
    }
  }

  private renderTitleBar() {
    const bar = document.createElement("div");
    bar.className = "title-bar";
    bar.id = "title-bar";

    const title = document.createElement("span");
    title.className = "title-bar-title";
    title.textContent = "netssh";

    const controls = document.createElement("div");
    controls.className = "title-bar-controls";

    const makeBtn = (label: string, action: () => void, ariaLabel?: string): HTMLButtonElement => {
      const b = document.createElement("button");
      b.className = "title-bar-btn";
      b.style.setProperty("-webkit-app-region", "no-drag");
      b.textContent = label;
      if (ariaLabel) b.setAttribute("aria-label", ariaLabel);
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        try {
          action();
        } catch (err) {
          log.error(LogTag.App, "title-bar action failed:", err);
        }
      });
      controls.appendChild(b);
      return b;
    };
    makeBtn("?", () => {
      this.showShortcuts = !this.showShortcuts;
      this.renderShortcutsModal();
    }, "Keyboard shortcuts");
    makeBtn("–", () => void getCurrentWindow().minimize(), "Minimize");
    makeBtn("□", () => void getCurrentWindow().toggleMaximize(), "Maximize");
    makeBtn("×", () => void getCurrentWindow().close(), "Close");

    bar.appendChild(title);

    // Global search — centered in the title bar (absolute, relative to the bar)
    const searchWrap = document.createElement("div");
    searchWrap.className = "title-bar-search-wrap";
    this.globalSearch = new GlobalSearch(
      searchWrap,
      (h) => this.onConnect(h),
      (p, c) => {
        this.showView("knowledge-base");
        this.kbScreen.openCommand(p, c);
        // openCommand switches to the browse tab — re-sync the nav highlight.
        this.navPanel.syncActiveItem({ section: "kb", id: this.kbScreen.getActiveTab() });
      },
    );
    bar.appendChild(searchWrap);

    bar.appendChild(controls);
    this.container.insertBefore(bar, this.container.firstChild);
    this.initImportIndicator(bar);
  }

  // ─── Import job indicator + modal (title bar) ──────────────────────

  private importIndicator: HTMLElement | null = null;
  private importModalHandle: ModalHandle | null = null;
  private unlistenImportJob: (() => void) | null = null;
  /** Last modal stage label — full modal rebuild only when it changes. */
  private modalStageKey: string = "";

  private initImportIndicator(bar: HTMLElement) {
    const indicator = document.createElement("button");
    indicator.className = "title-import-indicator";
    indicator.id = "title-import-indicator";
    indicator.hidden = true;
    indicator.setAttribute("aria-label", "Import job — click for details");
    // Spinner while running; tick (styled by main.css) once done — the
    // indicator stays visible until the user opens + closes the modal, so
    // the completion summary is reachable after wandering off.
    indicator.innerHTML = `<span class="tii-spinner"></span><span class="tii-done hidden">${icons.check}</span>`;
    indicator.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleImportModal();
    });

    // Insert left of the window controls
    bar.insertBefore(indicator, bar.querySelector(".title-bar-controls"));
    this.importIndicator = indicator;

    this.unlistenImportJob = importJob.subscribe(() => this.refreshImportIndicator());
  }

  private refreshImportIndicator() {
    if (!this.importIndicator) return;
    // Visible while running AND after completion (result summary pending) —
    // cleared when the status modal is closed.
    const showDone = !importJob.active && (importJob.result !== null || importJob.lines.length > 0);
    this.importIndicator.hidden = !(importJob.active || showDone);
    this.importIndicator.title = importJob.active
      ? (importJob.stageLabel || "Import running — click for details")
      : "Import job finished — click for details";
    const spinner = this.importIndicator.querySelector<HTMLElement>(".tii-spinner");
    const done = this.importIndicator.querySelector<HTMLElement>(".tii-done");
    if (spinner) spinner.classList.toggle("hidden", !importJob.active);
    if (done) done.classList.toggle("hidden", importJob.active);
    if (this.importModalHandle) {
      // Same-stage emits: update text in place. Rebuilding the modal HTML
      // recreates the h3 spinner element and resets its CSS animation
      // (stuttering); rebuild only on stage transitions.
      if (this.updateImportModalInPlace()) return;
      this.renderImportModalContent();
    }
  }

  /** Text-only modal update while the backend stage is unchanged. */
  private updateImportModalInPlace(): boolean {
    const modal = this.importModalHandle?.panel ?? null;
    if (!modal || !importJob.active) return false;
    const prevStage = this.modalStageKey;
    const head = modal.querySelector<HTMLElement>(".import-status-head");
    if (head && importJob.stageLabel) head.textContent = importJob.stageLabel;
    const indicator = document.getElementById("title-import-indicator");
    const key = importJob.stageLabel || "running";
    this.modalStageKey = key;
    return key === prevStage && !!indicator;
  }

  private toggleImportModal() {
    if (this.importModalHandle) {
      this.closeImportModal();
      return;
    }
    const handle = openModal({
      panelClass: "import-status-modal",
      content: "",
      onDismiss: () => this.closeImportModal(),
    });
    handle.panel.setAttribute("aria-labelledby", "import-status-title");
    this.importModalHandle = handle;
    this.renderImportModalContent();
  }

  private closeImportModal() {
    this.importModalHandle?.close();
    this.importModalHandle = null;
    // Job fully acknowledged — retire the indicator tick.
    importJob.setResult(null);
    if (this.importIndicator) this.importIndicator.hidden = true;
  }

  private renderImportModalContent() {
    const panel = this.importModalHandle?.panel;
    if (!panel) return;
    this.modalStageKey = importJob.active ? (importJob.stageLabel || "running") : "done";
    // Preserve the collapsible LLM output state across live re-renders.
    const detailsOpen = panel.querySelector<HTMLDetailsElement>("details.import-llm-details")?.open ?? false;
    const done = !importJob.active;
    const last = importJob.lines[importJob.lines.length - 1];
    const headText = done
      ? (last?.text ?? "No import job")
      : (importJob.stageLabel || "Import running…");
    const lines = importJob.lines.map((l) =>
      `<div class="import-status-line import-status-${l.kind}"><span class="import-status-time">${escHtml(l.time)}</span>${escHtml(l.text)}</div>`
    ).join("");
    const r = importJob.result;
    const summary = done && r?.ok ? `
          <div class="import-result-details">
            <div class="import-result-row">
              <span class="import-result-label">Commands imported:</span>
              <span class="import-result-value">${r.commandsImported}</span>
            </div>
            <div class="import-result-row">
              <span class="import-result-label">Target file:</span>
              <span class="import-result-value import-result-path">${escHtml(r.targetFile)}</span>
            </div>
          </div>` : "";
    panel.innerHTML = `
      <h3 id="import-status-title">${done ? icons.check : ""} Import Job ${done ? "" : '<span class="tii-spinner tii-spinner-inline"></span>'}</h3>
      <div class="import-status-head">${escHtml(headText)}</div>
      ${summary}
      <div class="import-status-log" id="import-status-log">${lines}</div>
      ${importJob.llmTail ? `
      <details class="import-llm-details"${detailsOpen ? " open" : ""}>
        <summary>LLM output (live)</summary>
        <pre id="import-status-llm-tail">${escHtml(importJob.llmTail)}</pre>
      </details>` : ""}
      <div class="form-actions">
        ${!done && !importJob.committing ? `<button class="btn-danger" id="import-status-cancel-btn">Cancel</button>` : ""}
        <button class="btn-text" id="import-status-close-btn">Close</button>
      </div>`;
    const log2 = panel.querySelector("#import-status-log");
    if (log2) log2.scrollTop = log2.scrollHeight;
    const tail = panel.querySelector("#import-status-llm-tail");
    if (tail && detailsOpen) tail.scrollTop = tail.scrollHeight;
    panel.querySelector("#import-status-close-btn")?.addEventListener("click", () => this.closeImportModal());
    panel.querySelector("#import-status-cancel-btn")?.addEventListener("click", () => {
      const ok = importJob.requestCancel();
      if (!ok) showToast("Import is committing — too late to cancel", "error");
      else showToast("Import cancelled — nothing was imported", "info");
    });
  }

  private renderStatusBar() {
    const bar = document.createElement("div");
    bar.className = "statusbar";
    bar.id = "statusbar";
    bar.setAttribute("role", "contentinfo");
    bar.setAttribute("aria-label", "Application status");

    const sessions = document.createElement("button");
    sessions.className = "statusbar-item sb-sessions";
    sessions.title = "Show terminal";
    sessions.setAttribute("aria-label", "Show terminal");
    sessions.addEventListener("click", () => {
      if (this.activeSessions.size > 0) this.showView("terminal");
    });

    const view = document.createElement("span");
    view.className = "statusbar-item sb-view";

    const spacer = document.createElement("span");
    spacer.className = "statusbar-spacer";

    const readingComfort = document.createElement("div");
    readingComfort.className = "statusbar-item sb-rc-wrap";

    const rcToggle = document.createElement("button");
    rcToggle.className = "statusbar-item sb-rc sb-rc-toggle";
    rcToggle.innerHTML = `${icons.book}<span>Reading Comfort</span>`;
    rcToggle.addEventListener("click", () => {
      if (isReadingComfortEnabled()) rcDisable();
      else rcEnable();
    });

    const rcCog = document.createElement("button");
    rcCog.className = "statusbar-btn rc-cog";
    rcCog.title = "Reading Comfort settings";
    rcCog.setAttribute("aria-label", "Reading Comfort settings");
    rcCog.innerHTML = icons.sliders;
    rcCog.addEventListener("click", () => {
      if (this.rcPopover) this.hideRcPopover();
      else this.showRcPopover(rcCog);
    });

    readingComfort.appendChild(rcToggle);
    readingComfort.appendChild(rcCog);

    bar.appendChild(sessions);
    bar.appendChild(view);
    bar.appendChild(spacer);
    bar.appendChild(readingComfort);
    this.container.appendChild(bar);

    this.sbSessions = sessions;
    this.sbView = view;
    this.sbReadingComfort = rcToggle;
    this.refreshStatusBar();
  }

  private refreshStatusBar() {
    if (!this.sbSessions || !this.sbView) return;
    const n = this.activeSessions.size;
    this.sbSessions.innerHTML = `<span class="sb-dot${n > 0 ? " on" : ""}">●</span>${n} session${n === 1 ? "" : "s"}`;
    const labels: Record<AppView, string> = {
      connections: "Connections",
      terminal: "Terminal",
      "knowledge-base": "Knowledge Base",
      replay: "Command Replay",
      settings: "Settings",
    };
    this.sbView.textContent = labels[this.currentView];
    this.syncReadingComfort();
  }

  private syncReadingComfort() {
    if (!this.sbReadingComfort) return;
    const on = isReadingComfortEnabled();
    setToggleState(this.sbReadingComfort, on, on ? "Disable Reading Comfort" : "Enable Reading Comfort");
  }

  /**
   * Reading Comfort quick-adjust dropup — sliders mirror the settings pane
   * (live apply via rcUpdate/setTerminalFontSize events), available from
   * every screen. IDs are prefixed `rcp-` so both can coexist.
   */
  private showRcPopover(anchor: HTMLElement) {
    this.hideRcPopover();
    const s = getReadingComfortState();
    const on = !!s;
    const fontSize = getTerminalFontSize();
    const uiScale = s?.uiScale ?? RC_PRESET.uiScale;
    const lineHeight = s?.lineHeight ?? RC_PRESET.lineHeight;
    const letterSpacing = s?.letterSpacing ?? RC_PRESET.letterSpacing;
    const disabled = on ? "" : "disabled";

    const pop = document.createElement("div");
    pop.className = "rc-popover";
    pop.setAttribute("role", "group");
    pop.setAttribute("aria-label", "Reading Comfort adjustments");
    pop.innerHTML = `
      ${on ? "" : `<p class="rc-popover-off">Reading Comfort is off — enable it to apply adjustments.</p>`}
      <div class="import-field">
        <label for="rcp-font-size">Terminal font size</label>
        <input type="range" class="form-input" id="rcp-font-size" min="${TERMINAL_FONT_MIN}" max="${TERMINAL_FONT_MAX}" step="1" value="${fontSize}" ${disabled} />
        <span class="import-hint">${fontSize}px — shared with zoom shortcuts (Ctrl+= / Ctrl+-)</span>
      </div>
      <div class="import-field">
        <label for="rcp-ui-scale">UI text scale</label>
        <input type="range" class="form-input" id="rcp-ui-scale" min="1.0" max="1.5" step="0.05" value="${uiScale}" ${disabled} />
        <span class="import-hint">${uiScale.toFixed(2)}×</span>
      </div>
      <div class="import-field">
        <label for="rcp-line-height">Terminal line height</label>
        <input type="range" class="form-input" id="rcp-line-height" min="1.0" max="1.8" step="0.05" value="${lineHeight}" ${disabled} />
        <span class="import-hint">${lineHeight.toFixed(2)}</span>
      </div>
      <div class="import-field">
        <label for="rcp-letter-spacing">Terminal letter spacing</label>
        <input type="range" class="form-input" id="rcp-letter-spacing" min="0" max="6" step="0.5" value="${letterSpacing}" ${disabled} />
        <span class="import-hint">${letterSpacing}px</span>
      </div>
      <button type="button" class="btn-text" id="rcp-reset" ${disabled}>Reset to preset</button>
    `;

    const q = <T extends HTMLElement>(sel: string) => pop.querySelector<T>(sel)!;
    const bindRange = (id: string, apply: (v: number) => void, hint: (v: number) => string) => {
      const input = q<HTMLInputElement>(`#${id}`);
      const hintEl = input.closest(".import-field")!.querySelector<HTMLElement>(".import-hint")!;
      input.addEventListener("input", () => {
        const v = parseFloat(input.value);
        apply(v);
        hintEl.textContent = hint(v);
      });
    };
    bindRange("rcp-font-size", (v) => setTerminalFontSize(v), (v) => `${v}px — shared with zoom shortcuts (Ctrl+= / Ctrl+-)`);
    bindRange("rcp-ui-scale", (v) => rcUpdate({ uiScale: v }), (v) => `${v.toFixed(2)}×`);
    bindRange("rcp-line-height", (v) => rcUpdate({ lineHeight: v }), (v) => `${v.toFixed(2)}`);
    bindRange("rcp-letter-spacing", (v) => rcUpdate({ letterSpacing: v }), (v) => `${v}px`);
    q<HTMLButtonElement>("#rcp-reset").addEventListener("click", () => {
      rcReset();
      this.hideRcPopover();
    });

    document.body.appendChild(pop);
    // Anchor: right-aligned above the cog (dropup — status bar is at the bottom)
    const r = anchor.getBoundingClientRect();
    pop.style.left = `${Math.max(4, Math.min(r.right - pop.offsetWidth, window.innerWidth - pop.offsetWidth - 4))}px`;
    pop.style.top = `${Math.max(4, r.top - pop.offsetHeight - 6)}px`;

    // Outside click closes
    this.rcPopoverOutside = (e: MouseEvent) => {
      if (!pop.contains(e.target as Node) && !anchor.contains(e.target as Node)) this.hideRcPopover();
    };
    document.addEventListener("mousedown", this.rcPopoverOutside);
    // Escape closes — capture so xterm doesn't get it first
    this.rcPopoverEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.hideRcPopover();
      }
    };
    document.addEventListener("keydown", this.rcPopoverEscape, true);

    this.rcPopover = pop;
    this.rcPopoverOn = on;
    q<HTMLInputElement>("#rcp-font-size").focus();
  }

  private hideRcPopover() {
    if (!this.rcPopover) return;
    this.rcPopover.remove();
    this.rcPopover = null;
    this.rcPopoverOn = false;
    if (this.rcPopoverOutside) {
      document.removeEventListener("mousedown", this.rcPopoverOutside);
      this.rcPopoverOutside = null;
    }
    if (this.rcPopoverEscape) {
      document.removeEventListener("keydown", this.rcPopoverEscape, true);
      this.rcPopoverEscape = null;
    }
  }

  private showView(view: AppView) {
    this.currentView = view;
    this.hostScreenWrapper.style.display = view === "connections" ? "" : "none";
    this.terminalArea.style.display = view === "terminal" ? "" : "none";
    this.kbScreenWrapper.style.display = view === "knowledge-base" ? "" : "none";
    if (this.replayWrapper) this.replayWrapper.style.display = view === "replay" ? "" : "none";
    this.settingsWrapper.style.display = view === "settings" ? "" : "none";
    // Nav panel keeps its current section state in the terminal view
    if (view === "connections") {
      this.navPanel.setSection("connections");
    } else if (view === "knowledge-base") {
      this.navPanel.setSection("kb");
    } else if (view === "replay") {
      this.navPanel.setSection("replay");
      void this.replayScreen?.refresh();
    } else if (view === "settings") {
      this.navPanel.setSection("settings");
    }
    // One call: sub-item highlight matches the visible view everywhere.
    this.navPanel.setView(view);
    // Sync the active sub-item from the view's truth-holder so deep-links
    // and keyboard shortcuts highlight correctly without a nav click.
    if (view === "knowledge-base") {
      this.navPanel.syncActiveItem({ section: "kb", id: this.kbScreen.getActiveTab() });
    } else if (view === "replay") {
      this.navPanel.syncActiveItem({ section: "replay", id: "manage" });
    } else if (view === "settings") {
      this.navPanel.syncActiveItem({ section: "settings", id: this.settingsItemId });
    }
    if (view === "settings") {
      this.settingsScreen.setItem(this.settingsItemId);
    }
    if (view === "terminal") {
      this.renderSessionTabBar();
    }
    this.refreshStatusBar();
  }

  private onConnect(host: Host) {
    this.activeSessions.add(host.id);
    this.navPanel.refreshSessionDots();

    // Existing tab → activate and switch to terminal view
    const existing = this.tabs.get(host.id);
    if (existing) {
      this.activateTab(host.id);
      this.showView("terminal");
      return;
    }

    // Create new tab
    const wrapper = document.createElement("div");
    wrapper.className = "app-view session-tab-wrapper";
    wrapper.style.display = "";
    this.terminalArea.appendChild(wrapper);

    const view = new TerminalView(
      () => this.onDetach(host.id),
      (hostId) => this.onFullDisconnect(hostId),
      (hostId) => this.onSessionDied(hostId),
      (hostId) => this.closeTab(hostId),
    );
    view.mount(wrapper);

    this.tabs.set(host.id, { host, view, wrapper });
    this.activateTab(host.id);
    this.showView("terminal");

    view.connect(host).catch((err) => {
      // Safety net: TerminalView.connect logs its primary failure path
      // (terminal-view.ts "Connection failed: …"). This fires only if it
      // throws before that — LogTag.Ssh marks the connection lifecycle.
      log.error(LogTag.Ssh, "Connect failed:", err);
    });
  }

  private activateTab(hostId: string) {
    const tab = this.tabs.get(hostId);
    if (!tab) return;
    this.activeTabId = hostId;
    this.activeHost = tab.host;

    // Pure transition — exactly one tab active (see tab-state.ts)
    const order = activateTabState(this.tabStates(), hostId);
    for (const t of order) {
      const entry = this.tabs.get(t.hostId);
      if (entry) entry.wrapper.style.display = t.active ? "" : "none";
    }

    // Fit terminal after showing
    requestAnimationFrame(() => {
      tab.view.fit();
      tab.view.applyChromeTint();
      tab.view.focus();
    });

    this.renderSessionTabBar();
  }

  private closeTab(hostId: string) {
    const tab = this.tabs.get(hostId);
    if (!tab) return;

    const doClose = () => {
      // disconnect() triggers onFullDisconnect, which removes the tab,
      // activates a neighbor (or returns to connections), and refreshes dots.
      tab.view.disconnect();
    };

    this.showCloseConfirm(tab.host.display_name, doClose);
  }

  /**
   * Back button — keep SSH session alive, just switch view.
   */
  private onDetach(hostId: string) {
    log.info(LogTag.App, `Detached from terminal for host ${hostId} (session stays active)`);
    this.showView("connections");
    this.hostScreen.refresh();
  }

  /**
   * Session actually ended. Remove tab, return to host list.
   */
  private onFullDisconnect(hostId: string) {
    log.info(LogTag.App, `Session ended for host ${hostId}`);
    const tab = this.tabs.get(hostId);
    if (tab) {
      this.tabs.delete(hostId);
      tab.wrapper.remove();
    }
    this.activeSessions.delete(hostId);
    this.navPanel.refreshSessionDots();
    if (this.activeHost?.id === hostId) {
      this.activeHost = null;
    }
    if (this.activeTabId === hostId) {
      this.activeTabId = null;
      // Pure transition — activate last remaining tab (see tab-state.ts)
      const next = closeTabState(this.tabStates(), hostId);
      if (next.length > 0) {
        this.activateTab(next[next.length - 1].hostId);
      } else {
        this.showView("connections");
      }
    }
    this.renderSessionTabBar();
    this.refreshStatusBar();
    this.hostScreen.refresh();
  }

  /**
   * Session died silently. Remove tab, refresh dots.
   */
  private onSessionDied(hostId: string) {
    log.info(LogTag.App, `Session silently ended for host ${hostId}`);
    const tab = this.tabs.get(hostId);
    if (tab) {
      this.tabs.delete(hostId);
      tab.wrapper.remove();
    }
    this.activeSessions.delete(hostId);
    this.navPanel.refreshSessionDots();
    if (this.activeTabId === hostId) {
      this.activeTabId = null;
      const next = closeTabState(this.tabStates(), hostId);
      if (next.length > 0) {
        this.activateTab(next[next.length - 1].hostId);
      } else if (this.currentView === "terminal") {
        this.showView("connections");
      }
    }
    this.renderSessionTabBar();
    this.refreshStatusBar();
    this.hostScreen.refresh();
  }

  // ─── Session Tab Bar ─────────────────────────────────────────────

  private tabStates(): TabState[] {
    return [...this.tabs.keys()].map((hostId) => ({
      hostId,
      active: hostId === this.activeTabId,
    }));
  }

  private renderSessionTabBar() {
    if (!this.sessionTabBar) {
      this.sessionTabBar = document.createElement("div");
      this.sessionTabBar.className = "session-tab-bar";
      this.sessionTabBar.setAttribute("role", "tablist");
      this.sessionTabBar.setAttribute("aria-label", "SSH sessions");
      this.terminalArea.insertBefore(this.sessionTabBar, this.terminalArea.firstChild);
    }

    this.sessionTabBar.innerHTML = "";
    for (const [hostId, tab] of this.tabs) {
      const el = document.createElement("div");
      el.className = "session-tab" + (hostId === this.activeTabId ? " active" : "");
      el.dataset.hostId = hostId;
      el.setAttribute("role", "tab");
      el.setAttribute("aria-selected", String(hostId === this.activeTabId));
      el.tabIndex = 0;
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          this.activateTab(hostId);
        }
      });

      const label = document.createElement("span");
      label.className = "session-tab-label";
      label.textContent = tab.host.display_name;

      const close = document.createElement("button");
      close.className = "session-tab-close";
      close.textContent = "×";
      close.setAttribute("aria-label", `Close session ${tab.host.display_name}`);
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        this.closeTab(hostId);
      });

      el.appendChild(label);
      el.appendChild(close);
      el.addEventListener("click", () => this.activateTab(hostId));
      this.sessionTabBar.appendChild(el);
    }
  }

  // ─── Close Confirm Modal ─────────────────────────────────────────

  private showCloseConfirm(hostName: string, onConfirm: () => void) {
    confirmDialog({
      title: "Close Session",
      message: `Close session to <strong>${escHtml(hostName)}</strong>?<br/>Your SSH session will be terminated.`,
      confirmLabel: "Close Session",
      destructive: true,
      onConfirm,
    });
  }

  private renderShortcutsModal() {
    this.shortcutsModalHandle?.close();
    this.shortcutsModalHandle = null;
    if (!this.showShortcuts) return;

    const shortcuts = [
      { section: "Navigation" },
      { key: "↑ / ↓", action: "Navigate host list" },
      { key: "Enter", action: "Connect to selected host" },
      { key: "/", action: "Focus global search" },
      { key: "Escape", action: "Clear search / close modals" },
      { section: "Actions" },
      { key: "Ctrl+N", action: "New connection" },
      { key: "Shift+F10", action: "Open context menu" },
      { key: "Delete", action: "Delete selected host" },
      { key: "?", action: "Toggle shortcuts" },
      { section: "Terminal" },
      { key: "Tab", action: "Accept ghost suggestion / pass through" },
      { key: "Ctrl+Space", action: "Open suggestion dropdown" },
      { key: "Ctrl+Shift+S", action: "Toggle sidebar" },
      { key: "Ctrl+Shift+Q", action: "Disconnect" },
    ];
    const items = shortcuts
      .map((s) => {
        if ("section" in s) {
          return `<div class="shortcuts-section">${escHtml((s as { section: string }).section)}</div>`;
        }
        return `
          <span class="shortcut-key">${escHtml(s.key)}</span>
          <span class="shortcut-action">${escHtml(s.action)}</span>`;
      })
      .join("");

    const handle = openModal({
      panelClass: "shortcuts-modal",
      content: `
        <h2 id="app-shortcuts-title">Keyboard Shortcuts</h2>
        <div class="shortcuts-grid">${items}</div>
        <div class="form-actions" style="margin-top:calc(var(--spacing) * 5)">
          <button class="btn-primary" id="app-shortcuts-close-btn">Got it</button>
        </div>`,
      onDismiss: () => this.closeShortcutsModal(),
    });
    handle.panel.setAttribute("aria-labelledby", "app-shortcuts-title");
    this.shortcutsModalHandle = handle;
    handle.panel.querySelector("#app-shortcuts-close-btn")!.addEventListener("click", () =>
      this.closeShortcutsModal(),
    );
  }

  private closeShortcutsModal() {
    this.showShortcuts = false;
    this.renderShortcutsModal();
  }

  private registerGlobalShortcuts() {
    window.addEventListener("keydown", (e: KeyboardEvent) => {
      // Ctrl+Shift+K — toggle Knowledge Base view
      if (e.ctrlKey && e.shiftKey && e.key === "K") {
        e.preventDefault();
        if (this.currentView === "knowledge-base") {
          this.showView("connections");
        } else {
          // Detach terminal if needed (keep session alive)
          if (this.currentView === "terminal" && this.activeTabId) {
            this.onDetach(this.activeTabId);
          }
          this.showView("knowledge-base");
        }
        return;
      }

      // Ctrl+, — open Settings (placeholder)
      if (e.ctrlKey && !e.shiftKey && e.key === ",") {
        e.preventDefault();
        this.showView("settings");
        return;
      }

      // Ctrl+W — MUST pass through to remote. Prevent browser/app close.
      if (e.ctrlKey && !e.shiftKey && e.key === "w") {
        if (this.currentView === "terminal") {
          e.preventDefault();
        }
        return;
      }

      // Ctrl+Shift+W — close active tab with confirm
      if (e.ctrlKey && e.shiftKey && e.key === "W") {
        if (this.currentView === "terminal" && this.activeTabId) {
          e.preventDefault();
          this.closeTab(this.activeTabId);
        }
        return;
      }

      // Ctrl+= or Ctrl++ — zoom in
      if (e.ctrlKey && (e.key === "=" || e.key === "+")) {
        if (this.currentView === "terminal" && this.activeTabId) {
          e.preventDefault();
          setTerminalFontSize(getTerminalFontSize() + 2);
        }
        return;
      }

      // Ctrl+- — zoom out
      if (e.ctrlKey && e.key === "-") {
        if (this.currentView === "terminal" && this.activeTabId) {
          e.preventDefault();
          setTerminalFontSize(getTerminalFontSize() - 2);
        }
        return;
      }

      // Ctrl+0 — zoom reset
      if (e.ctrlKey && e.key === "0") {
        if (this.currentView === "terminal" && this.activeTabId) {
          e.preventDefault();
          setTerminalFontSize(TERMINAL_FONT_DEFAULT);
        }
        return;
      }

      // Escape — from KB / settings view, return to connections.
      // Open modals handle Escape themselves (modal shell, capture phase).
      if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        if (this.currentView === "knowledge-base" || this.currentView === "settings") {
          e.preventDefault();
          this.showView("connections");
          return;
        }
      }

      // ? — toggle shortcuts modal (not while typing in an input)
      if (e.key === "?" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        const t = document.activeElement;
        if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
        e.preventDefault();
        this.showShortcuts = !this.showShortcuts;
        this.renderShortcutsModal();
        return;
      }

      // / — focus global search (not while typing in another input)
      if (e.key === "/" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        const t = document.activeElement;
        if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
        e.preventDefault();
        this.globalSearch?.focus();
      }
    });
  }
}

new App();
