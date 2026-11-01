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
import {
  applyAvailableUpdate, checkForUpdatesNow, getUpdateStatus, subscribeUpdates, updateAction,
} from "./lib/updater";
import { escHtml } from "./lib/format";
import { confirmDialog } from "./lib/confirm-dialog";
import { openModal, ModalHandle } from "./lib/modal";
import { TabState, activateTab as activateTabState, closeTab as closeTabState } from "./lib/tab-state";
import { mintSessionId } from "./lib/session-id";
import {
  countLiveSessions, isAtSessionLimit, isLiveSession, normalizeDuplicateSessionPolicy,
  resolveDuplicateSessionAction, type DuplicateSessionPolicy,
} from "./lib/duplicate-session";
import { openDuplicateSessionDialog, policyForRememberedChoice } from "./lib/duplicate-session-dialog";
import { getAppConfig, setDuplicateSessionPolicy } from "./lib/tauri-api";
import { getAppTheme, setAppTheme } from "./lib/theme";
import {
  isReadingComfortEnabled, enable as rcEnable, disable as rcDisable,
  update as rcUpdate, resetToPreset as rcReset, getReadingComfortState, RC_PRESET,
} from "./lib/reading-comfort";
import { getTerminalFontSize, setTerminalFontSize, TERMINAL_FONT_MIN, TERMINAL_FONT_MAX, TERMINAL_FONT_DEFAULT } from "./lib/terminal-prefs";
import {
  formatCombo, initShortcuts, matches, resolvedCombo,
  SECTION_TITLES, SHORTCUT_DEFS, SHORTCUT_SECTIONS,
} from "./lib/shortcuts";
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

// Kick off the JetBrains Mono download at startup. xterm measures char size
// synchronously when a terminal opens; if JBM isn't loaded yet, rows are sized
// to fallback metrics and clip glyphs (see the document.fonts.ready gate in
// terminal-view.ts). Queuing the load here guarantees that gate waits for it.
// No-op where the FontFaceSet API is absent (e.g. jsdom test environment).
document.fonts?.load("14px 'JetBrains Mono'", "W")?.catch(() => {});

// App state
type AppView = "connections" | "terminal" | "knowledge-base" | "replay" | "settings";

interface SessionTab {
  /** Tab key — the SSH session id, not the host id. Two live sessions to the
   *  same host are independent tabs with their own id. */
  sessionId: number;
  host: Host;
  view: TerminalView;
  wrapper: HTMLElement;
}

class App {
  private currentView: AppView = "connections";
  private container: HTMLElement;
  private hostScreen: HostScreen;

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

  // Session tabs — one per live SSH session, keyed by session id. A host may
  // appear in more than one tab (issue #67).
  private tabs = new Map<number, SessionTab>();
  private activeTabId: number | null = null;
  /** Host ids with a duplicate-session prompt on screen, so a repeated connect
   *  cannot stack a second dialog. */
  private pendingDuplicatePrompt = new Set<string>();
  private sessionTabBar: HTMLElement | null = null;
  private terminalArea: HTMLElement;

  /** Host ids that currently have at least one live session. Derived from
   *  `tabs` so duplicate sessions collapse to one connected host. */
  get activeSessions(): Set<string> {
    return new Set([...this.tabs.values()].map((t) => t.host.id));
  }

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
    window.addEventListener("comnd:reading-comfort", () => {
      this.syncReadingComfort();
      const on = isReadingComfortEnabled();
      if (this.rcPopover && on !== this.rcPopoverOn && this.sbReadingComfort) {
        const cog = this.sbReadingComfort.parentElement?.querySelector<HTMLElement>(".rc-cog");
        if (cog) this.showRcPopover(cog);
      }
    });

    // A rebinding (Settings pane) re-emits "comnd:shortcuts"; an open
    // help modal re-renders so the grid never shows stale combos.
    window.addEventListener("comnd:shortcuts", () => {
      if (this.showShortcuts) this.renderShortcutsModal();
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
    // Icon-nav clicks inside the settings screen update the view's
    // truth-holder so re-opening Settings shows the last page. The nav
    // panel has no Settings sub-items to highlight anymore.
    this.settingsScreen.onItemChanged = (id) => {
      this.settingsItemId = id;
    };
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
      (host) => void this.onConnect(host),
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
        if (host) void this.onConnect(host);
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
      onTreeChanged: () => {
        void this.hostScreen.refresh();
      },
      getActiveSessions: () => this.activeSessions,
    });
    void this.navPanel.mount();

    log.info(LogTag.App, "Initialized");
    this.syncLogLevel();
    this.syncLogStatus();
    // Registry overrides load async from config; matches() runs on
    // defaults until then — no race (docs/plans/058 phase 1).
    void initShortcuts();
    this.registerGlobalShortcuts();
    this.renderTitleBar();
    this.renderStatusBar();
    // P1.4 — check for updates on startup (silent; indicator shows only if one exists).
    void checkForUpdatesNow();
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
    title.textContent = "Comnd";

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
    makeBtn("–", () => void getCurrentWindow().minimize(), "Minimize");
    makeBtn("□", () => void getCurrentWindow().toggleMaximize(), "Maximize");
    makeBtn("×", () => void getCurrentWindow().close(), "Close");

    // Settings cog — permanently left of the minimize window button (first
    // child of the controls group). The conditional update indicator is
    // inserted left of the controls group (see initUpdateIndicator), so the
    // final right-edge order is: import · update · cog · minimize/max/close.
    const settingsBtn = document.createElement("button");
    settingsBtn.className = "title-bar-btn";
    settingsBtn.id = "title-bar-settings";
    settingsBtn.style.setProperty("-webkit-app-region", "no-drag");
    settingsBtn.innerHTML = icons.settings;
    settingsBtn.title = "Settings";
    settingsBtn.setAttribute("aria-label", "Settings");
    settingsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.showView("settings");
    });
    controls.insertBefore(settingsBtn, controls.firstChild);

    bar.appendChild(title);

    // Global search — centered in the title bar (absolute, relative to the bar)
    const searchWrap = document.createElement("div");
    searchWrap.className = "title-bar-search-wrap";
    this.globalSearch = new GlobalSearch(
      searchWrap,
      (h) => void this.onConnect(h),
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
    this.initUpdateIndicator(bar);
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

  // ─── Update indicator (title bar, P1.4) ────────────────────────────

  private updateIndicator: HTMLElement | null = null;
  private unsubUpdates: (() => void) | null = null;

  private initUpdateIndicator(bar: HTMLElement) {
    const indicator = document.createElement("button");
    indicator.className = "title-update-indicator";
    indicator.id = "title-update-indicator";
    indicator.hidden = true;
    indicator.innerHTML = icons.download;
    indicator.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.installUpdateFromIndicator();
    });

    // Insert left of the window controls (right of the import indicator).
    bar.insertBefore(indicator, bar.querySelector(".title-bar-controls"));
    this.updateIndicator = indicator;

    this.unsubUpdates = subscribeUpdates(() => this.refreshUpdateIndicator());
    this.refreshUpdateIndicator();
  }

  private refreshUpdateIndicator() {
    if (!this.updateIndicator) return;
    const s = getUpdateStatus();
    const show = s.state === "update-available";
    this.updateIndicator.hidden = !show;
    if (!show) return;
    const verb = updateAction(s.platform) === "open-release-page" ? "open the latest release" : "install";
    const label = `Update ${s.version ?? ""} available — click to ${verb}`;
    this.updateIndicator.setAttribute("aria-label", label);
    this.updateIndicator.title = label;
  }

  private async installUpdateFromIndicator() {
    try {
      const result = await applyAvailableUpdate();
      if (result === "opened-release-page") {
        showToast("Opened the latest release page — download and install from there", "info");
      } else {
        showToast("Installing update — Comnd is restarting…", "info");
      }
    } catch (err) {
      log.error(LogTag.App, "Update install failed:", err);
      showToast(err instanceof Error ? err.message : String(err), "error");
    }
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
      if (this.tabs.size > 0) this.showView("terminal");
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

    // Keyboard shortcuts viewer — the mouse-first affordance for the "?"
    // help modal (docs/specs/11 §Status Bar). Glyph-only, styled like the
    // Reading Comfort cog.
    const shortcutsBtn = document.createElement("button");
    shortcutsBtn.className = "statusbar-btn sb-shortcuts";
    shortcutsBtn.title = "Keyboard shortcuts (?)";
    shortcutsBtn.setAttribute("aria-label", "Keyboard shortcuts (?)");
    shortcutsBtn.innerHTML = icons.keyboard;
    shortcutsBtn.addEventListener("click", () => {
      this.showShortcuts = !this.showShortcuts;
      this.renderShortcutsModal();
    });

    bar.appendChild(sessions);
    bar.appendChild(view);
    bar.appendChild(spacer);
    bar.appendChild(readingComfort);
    bar.appendChild(shortcutsBtn);
    this.container.appendChild(bar);

    this.sbSessions = sessions;
    this.sbView = view;
    this.sbReadingComfort = rcToggle;
    this.refreshStatusBar();
  }

  private refreshStatusBar() {
    if (!this.sbSessions || !this.sbView) return;
    const n = this.liveSessionCount;
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
    }
    // One call: sub-item highlight matches the visible view everywhere.
    this.navPanel.setView(view);
    // Sync the active sub-item from the view's truth-holder so deep-links
    // and keyboard shortcuts highlight correctly without a nav click.
    // Settings has no nav sub-items — setView() alone clears kb/replay
    // highlights when it becomes the current view.
    if (view === "knowledge-base") {
      this.navPanel.syncActiveItem({ section: "kb", id: this.kbScreen.getActiveTab() });
    } else if (view === "replay") {
      this.navPanel.syncActiveItem({ section: "replay", id: "manage" });
    }
    if (view === "settings") {
      this.settingsScreen.setItem(this.settingsItemId);
    }
    if (view === "terminal") {
      this.renderSessionTabBar();
    }
    this.refreshStatusBar();
  }

  /**
   * Connect entry point. Resolves the duplicate-session policy first: a host
   * that already has a live session may open a second one, focus the existing
   * one, or prompt (issue #67).
   */
  private async onConnect(host: Host) {
    // Only live sessions count as "already connected": a failed attempt keeps
    // its tab open for Retry but holds no SSH session, so it must neither
    // trigger the prompt nor be focused instead of connecting.
    const openForHost = [...this.tabs.values()].filter(
      (t) => t.host.id === host.id && isLiveSession(t.view.connectionStatus),
    );

    if (openForHost.length > 0) {
      // One prompt per host at a time — a second connect while the dialog is
      // up would stack a second dialog and leave a request hanging.
      if (this.pendingDuplicatePrompt.has(host.id)) return;
      this.pendingDuplicatePrompt.add(host.id);
      try {
        let policy: DuplicateSessionPolicy = "ask";
        let maxSessions = 0;
        try {
          const config = await getAppConfig();
          policy = normalizeDuplicateSessionPolicy(config.duplicate_session_policy);
          maxSessions = config.max_sessions ?? 0;
        } catch (err) {
          log.warn(LogTag.App, "Could not read app config, using defaults:", err);
        }

        const atLimit = isAtSessionLimit(this.liveSessionCount, maxSessions);
        const action = resolveDuplicateSessionAction({ policy, atLimit });

        if (action === "focus") {
          this.focusExistingSession(host.id);
          return;
        }

        if (action !== "new") {
          const result = await openDuplicateSessionDialog({
            deviceName: host.display_name,
            atLimit,
            maxSessions,
          });

          // "Remember my choice" — persist real choices, including "go to the
          // existing session", before branching so neither is lost. Awaited
          // while the prompt guard is still held: a connect racing this save
          // would otherwise read the stale policy and prompt again.
          const remembered = policyForRememberedChoice(result.choice, result.remember);
          if (remembered) {
            try {
              await setDuplicateSessionPolicy(remembered);
              await this.settingsScreen.reloadConfig();
            } catch (err) {
              log.warn(LogTag.App, "Could not save duplicate session policy:", err);
            }
          }

          if (result.choice === "cancel") {
            // connectToHost() unbinds the host-list keys before connecting, so
            // a cancelled connect must give them back.
            this.restoreConnectionsKeyboard();
            return;
          }
          if (result.choice === "focus") {
            this.focusExistingSession(host.id);
            return;
          }
        }
      } finally {
        this.pendingDuplicatePrompt.delete(host.id);
      }
    }

    this.openSession(host);
  }

  /**
   * Sessions occupying a backend slot. A failed attempt keeps its tab open for
   * Retry but holds no SSH session, so it must not count against the limit.
   */
  private get liveSessionCount(): number {
    return countLiveSessions(
      [...this.tabs.values()].map((t) => t.view.connectionStatus),
    );
  }

  /** Rebind the host-list keys after a connect that stayed on Connections. */
  private restoreConnectionsKeyboard() {
    if (this.currentView === "connections") this.hostScreen.rebindGlobalKeys();
  }

  /** Activate the oldest live session for a host. */
  private focusExistingSession(hostId: string) {
    const candidates = [...this.tabs.values()].filter((t) => t.host.id === hostId);
    // Prefer a live session; fall back to any tab so the choice is never a
    // no-op if the session died while the prompt was open.
    const existing =
      candidates.find((t) => isLiveSession(t.view.connectionStatus)) ?? candidates[0];
    if (!existing) return;
    this.activateTab(existing.sessionId);
    this.showView("terminal");
  }

  /** Create an independent session and its own tab. */
  private openSession(host: Host) {
    // The tab is keyed by the session id, so it must exist before the view.
    // The id is minted here and handed to the SSH channel; a reconnect inside
    // TerminalView mints a fresh transport id while the tab keeps this key.
    const sessionId = mintSessionId();

    const wrapper = document.createElement("div");
    wrapper.className = "app-view session-tab-wrapper";
    wrapper.style.display = "";
    this.terminalArea.appendChild(wrapper);

    const view = new TerminalView(
      () => this.onDetach(sessionId),
      () => this.onFullDisconnect(sessionId),
      () => this.onSessionDied(sessionId),
      () => this.closeTab(sessionId),
    );
    // Failed attempts keep their tab open for Retry but hold no SSH session,
    // so the status bar must follow each transition, not just tab add/remove.
    view.onStatusChange = () => this.refreshStatusBar();
    view.mount(wrapper);

    this.tabs.set(sessionId, { sessionId, host, view, wrapper });
    this.activateTab(sessionId);
    this.showView("terminal");
    this.navPanel.refreshSessionDots();

    view.connect(host, sessionId).catch((err) => {
      // Safety net: TerminalView.connect logs its primary failure path
      // (terminal-view.ts "Connection failed: …"). This fires only if it
      // throws before that — LogTag.Ssh marks the connection lifecycle.
      log.error(LogTag.Ssh, "Connect failed:", err);
    });
  }

  private activateTab(sessionId: number) {
    const tab = this.tabs.get(sessionId);
    if (!tab) return;
    this.activeTabId = sessionId;

    // Pure transition — exactly one tab active (see tab-state.ts)
    const order = activateTabState(this.tabStates(), sessionId);
    for (const t of order) {
      const entry = this.tabs.get(t.id);
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

  private closeTab(sessionId: number) {
    const tab = this.tabs.get(sessionId);
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
  private onDetach(sessionId: number) {
    log.info(LogTag.App, `Detached from terminal for session ${sessionId} (session stays active)`);
    this.showView("connections");
    this.hostScreen.refresh();
  }

  /**
   * Session actually ended. Remove tab, return to host list.
   */
  private onFullDisconnect(sessionId: number) {
    log.info(LogTag.App, `Session ${sessionId} ended`);
    this.removeSessionTab(sessionId);
  }

  /**
   * Session died silently. Remove tab, refresh dots.
   */
  private onSessionDied(sessionId: number) {
    log.info(LogTag.App, `Session ${sessionId} silently ended`);
    this.removeSessionTab(sessionId);
  }

  /**
   * Drop a tab. Other tabs — including other sessions to the same host — are
   * left untouched.
   */
  private removeSessionTab(sessionId: number) {
    const tab = this.tabs.get(sessionId);
    if (tab) {
      this.tabs.delete(sessionId);
      tab.wrapper.remove();
    }
    this.navPanel.refreshSessionDots();

    if (this.activeTabId === sessionId) {
      this.activeTabId = null;
      // Pure transition — activate last remaining tab (see tab-state.ts)
      const next = closeTabState(this.tabStates(), sessionId);
      if (next.length > 0) {
        this.activateTab(next[next.length - 1].id);
      } else if (this.currentView === "terminal") {
        this.showView("connections");
      }
    }
    this.renderSessionTabBar();
    this.refreshStatusBar();
    this.hostScreen.refresh();
  }

  // ─── Session Tab Bar ─────────────────────────────────────────────

  private tabStates(): TabState<number>[] {
    return [...this.tabs.keys()].map((sessionId) => ({
      id: sessionId,
      active: sessionId === this.activeTabId,
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

    // Duplicate sessions to one host share a visible label by design, so the
    // accessible name carries the position instead — it still contains the
    // visible text, keeping WCAG 2.5.3 "label in name" intact.
    const perHost = new Map<string, number>();
    for (const tab of this.tabs.values()) {
      perHost.set(tab.host.id, (perHost.get(tab.host.id) ?? 0) + 1);
    }
    const hostIndex = new Map<string, number>();

    for (const [sessionId, tab] of this.tabs) {
      const hostTotal = perHost.get(tab.host.id) ?? 1;
      const index = (hostIndex.get(tab.host.id) ?? 0) + 1;
      hostIndex.set(tab.host.id, index);
      const sessionSuffix = hostTotal > 1 ? `, session ${index} of ${hostTotal}` : "";

      const el = document.createElement("div");
      el.className = "session-tab" + (sessionId === this.activeTabId ? " active" : "");
      el.dataset.sessionId = String(sessionId);
      el.dataset.hostId = tab.host.id;
      el.setAttribute("role", "tab");
      if (sessionSuffix) {
        el.setAttribute("aria-label", `${tab.host.display_name}${sessionSuffix}`);
      }
      el.setAttribute("aria-selected", String(sessionId === this.activeTabId));
      el.tabIndex = 0;
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          this.activateTab(sessionId);
        }
      });

      const label = document.createElement("span");
      label.className = "session-tab-label";
      // Duplicate sessions to one host share the same label — the tab bar
      // does not disambiguate them.
      label.textContent = tab.host.display_name;

      const close = document.createElement("button");
      close.className = "session-tab-close";
      close.textContent = "×";
      close.setAttribute("aria-label", `Close session ${tab.host.display_name}${sessionSuffix}`);
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        this.closeTab(sessionId);
      });

      el.appendChild(label);
      el.appendChild(close);
      el.addEventListener("click", () => this.activateTab(sessionId));
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

    // Registry-driven grid (docs/specs/11): the modal reads the same
    // SHORTCUT_DEFS table the handlers use, so documentation cannot drift
    // from behaviour. Fixed-semantics keys (Tab, arrows, Ctrl+W) are
    // deliberately absent — they are interaction semantics, not actions.
    const items = SHORTCUT_SECTIONS.map((section) => {
      const rows = SHORTCUT_DEFS.filter((d) => d.section === section)
        .map(
          (d) => `
          <span class="shortcut-key">${escHtml(formatCombo(resolvedCombo(d.id)))}</span>
          <span class="shortcut-action">${escHtml(d.label)}</span>`,
        )
        .join("");
      return `<div class="shortcuts-section">${escHtml(SECTION_TITLES[section])}</div>${rows}`;
    }).join("");

    const handle = openModal({
      panelClass: "shortcuts-modal",
      content: `
        <h2 id="app-shortcuts-title">Keyboard Shortcuts</h2>
        <div class="shortcuts-grid">${items}</div>
        <div class="form-actions" style="margin-top:calc(var(--spacing) * 5)">
          <button class="btn-text" id="app-shortcuts-customize-btn">Customize…</button>
          <button class="btn-primary" id="app-shortcuts-close-btn">Got it</button>
        </div>`,
      onDismiss: () => this.closeShortcutsModal(),
    });
    handle.panel.setAttribute("aria-labelledby", "app-shortcuts-title");
    this.shortcutsModalHandle = handle;
    handle.panel.querySelector("#app-shortcuts-close-btn")!.addEventListener("click", () =>
      this.closeShortcutsModal(),
    );
    handle.panel.querySelector("#app-shortcuts-customize-btn")!.addEventListener("click", () => {
      // Settings → Shortcuts owns rebinding (docs/specs/11 §Status Bar);
      // close the modal first so focus lands in the pane.
      this.closeShortcutsModal();
      this.settingsItemId = "shortcuts";
      this.showView("settings");
    });
  }

  private closeShortcutsModal() {
    this.showShortcuts = false;
    this.renderShortcutsModal();
  }

  private registerGlobalShortcuts() {
    window.addEventListener("keydown", (e: KeyboardEvent) => {
      // Ctrl+W — MUST pass through to remote. Prevent browser/app close.
      // Never a registry action (AGENTS.md rule 6; spec 11 Fixed table) —
      // the guard stays hardcoded and first so no override can ever
      // swallow the delete-word byte.
      if (e.ctrlKey && !e.shiftKey && e.key === "w") {
        if (this.currentView === "terminal") {
          e.preventDefault();
        }
        return;
      }

      // Registry-driven actions (docs/specs/11). The cases call the exact
      // code paths the old per-combo if-chains had, preventDefault at the
      // same points included.
      switch (matches(e, "global")) {
        case "toggle-kb": {
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

        // Ctrl+N — new connection, the same seam as the nav panel's
        // New Connection button (spec 11 "Also decided").
        case "new-connection":
          e.preventDefault();
          this.showView("connections");
          this.hostScreen.openNewConnection();
          return;

        // Ctrl+, — open Settings
        case "open-settings":
          e.preventDefault();
          this.showView("settings");
          return;

        // Ctrl+Shift+W / Ctrl+Shift+Q — close active tab with confirm.
        // Two registry ids, one behaviour: both were promised by the old
        // help modal and stay separately mappable (spec 11 "Also decided").
        case "close-session-tab":
        case "disconnect":
          if (this.currentView === "terminal" && this.activeTabId) {
            e.preventDefault();
            this.closeTab(this.activeTabId);
          }
          return;

        // Ctrl+= / Ctrl++ — zoom in
        case "font-zoom-in":
          if (this.currentView === "terminal" && this.activeTabId) {
            e.preventDefault();
            setTerminalFontSize(getTerminalFontSize() + 2);
          }
          return;

        // Ctrl+- — zoom out
        case "font-zoom-out":
          if (this.currentView === "terminal" && this.activeTabId) {
            e.preventDefault();
            setTerminalFontSize(getTerminalFontSize() - 2);
          }
          return;

        // Ctrl+0 — zoom reset
        case "font-zoom-reset":
          if (this.currentView === "terminal" && this.activeTabId) {
            e.preventDefault();
            setTerminalFontSize(TERMINAL_FONT_DEFAULT);
          }
          return;

        // / — focus global search (bareKeyOnly gate lives in the matcher)
        case "focus-search":
          e.preventDefault();
          this.globalSearch?.focus();
          return;

        // ? — toggle shortcuts modal (bareKeyOnly gate lives in the matcher)
        case "shortcuts-modal":
          e.preventDefault();
          this.showShortcuts = !this.showShortcuts;
          this.renderShortcutsModal();
          return;
      }

      // Escape — from KB / settings view, return to connections.
      // Open modals handle Escape themselves (modal shell, capture phase).
      // Not a registry action: fixed cascade semantics (spec 11 Fixed table).
      if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        if (this.currentView === "knowledge-base" || this.currentView === "settings") {
          e.preventDefault();
          this.showView("connections");
          return;
        }
      }
    });
  }
}

if (import.meta.env.MODE === "smoke") {
  void import("./lib/smoke-mutation")
    .then((m) => m.applySmokeMutation())
    .catch(() => {})
    .finally(() => new App());
} else {
  new App();
}
