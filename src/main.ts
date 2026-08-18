import { getCurrentWindow } from "@tauri-apps/api/window";
import { HostScreen } from "./components/host-screen";
import { TerminalView } from "./components/terminal-view";
import { KbScreen } from "./components/kb-screen";
import { NavPanel } from "./components/nav-panel";
import { GlobalSearch } from "./components/global-search";
import { SettingsScreen } from "./components/settings-screen";
import { Host } from "./lib/tauri-api";
import { log } from "./lib/logger";
import { TabState, activateTab as activateTabState, closeTab as closeTabState } from "./lib/tab-state";
import { getAppTheme, setAppTheme, Theme } from "./lib/theme";
import { icons } from "./lib/icons";
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
type AppView = "connections" | "terminal" | "knowledge-base" | "settings";

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
  private settingsItemId = "ollama";
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
  private globalSearch: GlobalSearch | null = null;

  constructor() {
    this.container = document.getElementById("app")!;
    setAppTheme(getAppTheme());

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

    this.settingsScreen = new SettingsScreen();
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
      onKbTab: (tab) => {
        this.showView("knowledge-base");
        this.kbScreen.setTab(tab);
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
    });
    void this.navPanel.mount();

    log.info("app", "Initialized");
    this.registerGlobalShortcuts();
    this.renderTitleBar();
  }

  private renderTitleBar() {
    const bar = document.createElement("div");
    bar.className = "title-bar";
    bar.id = "title-bar";

    const title = document.createElement("span");
    title.className = "title-bar-title";
    title.textContent = "net.sh";

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
          console.error("title-bar action failed:", err);
        }
      });
      controls.appendChild(b);
      return b;
    };
    makeBtn("?", () => {
      this.showShortcuts = !this.showShortcuts;
      this.renderShortcutsModal();
    }, "Keyboard shortcuts");
    const themeBtn = makeBtn("", () => {
      setAppTheme(getAppTheme() === "dark" ? "light" : "dark");
    });
    makeBtn("–", () => void getCurrentWindow().minimize(), "Minimize");
    makeBtn("□", () => void getCurrentWindow().toggleMaximize(), "Maximize");
    makeBtn("×", () => void getCurrentWindow().close(), "Close");

    const syncThemeIcon = () => {
      const dark = getAppTheme() === "dark";
      themeBtn.innerHTML = dark ? icons.sun : icons.moon;
      themeBtn.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
    };
    syncThemeIcon();
    window.addEventListener("netsh:theme", syncThemeIcon);

    bar.appendChild(title);

    // Global search — between title and window controls
    const searchWrap = document.createElement("div");
    searchWrap.className = "title-bar-search-wrap";
    this.globalSearch = new GlobalSearch(
      searchWrap,
      (h) => this.onConnect(h),
      (p, c) => {
        this.showView("knowledge-base");
        this.kbScreen.openCommand(p, c);
      },
    );
    bar.appendChild(searchWrap);

    bar.appendChild(controls);
    this.container.insertBefore(bar, this.container.firstChild);
  }

  private showView(view: AppView) {
    this.currentView = view;
    this.hostScreenWrapper.style.display = view === "connections" ? "" : "none";
    this.terminalArea.style.display = view === "terminal" ? "" : "none";
    this.kbScreenWrapper.style.display = view === "knowledge-base" ? "" : "none";
    this.settingsWrapper.style.display = view === "settings" ? "" : "none";
    // Nav panel keeps its current section state in the terminal view
    if (view === "connections") {
      this.navPanel.setSection("connections");
    } else if (view === "knowledge-base") {
      this.navPanel.setSection("kb");
      this.navPanel.setActiveKbTab(this.kbScreen.getActiveTab());
    } else {
      this.navPanel.setSection("settings");
    }
    if (view === "settings") {
      this.settingsScreen.setItem(this.settingsItemId);
    }
    if (view === "terminal") {
      this.renderSessionTabBar();
    }
  }

  private onConnect(host: Host) {
    log.info("app", `Connecting to '${host.display_name}' (${host.hostname}:${host.port})`);
    this.activeSessions.add(host.id);

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
      console.error("Connect failed:", err);
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
    log.info("app", `Detached from terminal for host ${hostId} (session stays active)`);
    this.showView("connections");
    this.hostScreen.refresh();
  }

  /**
   * Session actually ended. Remove tab, return to host list.
   */
  private onFullDisconnect(hostId: string) {
    log.info("app", `Session ended for host ${hostId}`);
    const tab = this.tabs.get(hostId);
    if (tab) {
      this.tabs.delete(hostId);
      tab.wrapper.remove();
    }
    this.activeSessions.delete(hostId);
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
    this.hostScreen.refresh();
  }

  /**
   * Session died silently. Remove tab, refresh dots.
   */
  private onSessionDied(hostId: string) {
    log.info("app", `Session silently ended for host ${hostId}`);
    const tab = this.tabs.get(hostId);
    if (tab) {
      this.tabs.delete(hostId);
      tab.wrapper.remove();
    }
    this.activeSessions.delete(hostId);
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
      this.terminalArea.insertBefore(this.sessionTabBar, this.terminalArea.firstChild);
    }

    this.sessionTabBar.innerHTML = "";
    for (const [hostId, tab] of this.tabs) {
      const el = document.createElement("div");
      el.className = "session-tab" + (hostId === this.activeTabId ? " active" : "");
      el.dataset.hostId = hostId;

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
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `
      <div class="modal-panel delete-confirm">
        <h3>Close Session</h3>
        <p>Close session to <strong>${esc(hostName)}</strong>?<br/>Your SSH session will be terminated.</p>
        <div class="form-actions">
          <button class="btn-text close-confirm-cancel">Cancel</button>
          <button class="btn-danger close-confirm-ok">Close Session</button>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);

    const cleanup = () => {
      backdrop.remove();
      window.removeEventListener("keydown", onKey, true);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation(); // keep Escape away from xterm cascade
        cleanup();
      }
    };
    window.addEventListener("keydown", onKey, true);

    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) cleanup();
    });
    backdrop.querySelector(".close-confirm-cancel")!.addEventListener("click", cleanup);
    backdrop.querySelector(".close-confirm-ok")!.addEventListener("click", () => {
      cleanup();
      onConfirm();
    });
  }

  private renderShortcutsModal() {
    document.getElementById("app-shortcuts-backdrop")?.remove();
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
    const esc = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const items = shortcuts
      .map((s) => {
        if ("section" in s) {
          return `<div class="shortcuts-section">${esc((s as { section: string }).section)}</div>`;
        }
        return `
          <span class="shortcut-key">${esc(s.key)}</span>
          <span class="shortcut-action">${esc(s.action)}</span>`;
      })
      .join("");

    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.id = "app-shortcuts-backdrop";
    backdrop.innerHTML = `
      <div class="shortcuts-modal">
        <h2>Keyboard Shortcuts</h2>
        <div class="shortcuts-grid">${items}</div>
        <div class="form-actions" style="margin-top:calc(var(--spacing) * 5)">
          <button class="btn-primary" id="app-shortcuts-close-btn">Got it</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);

    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) this.closeShortcutsModal();
    });
    backdrop.querySelector("#app-shortcuts-close-btn")!.addEventListener("click", () =>
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
          this.navPanel.setSection("kb");
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
          this.tabs.get(this.activeTabId)?.view.zoomIn();
        }
        return;
      }

      // Ctrl+- — zoom out
      if (e.ctrlKey && e.key === "-") {
        if (this.currentView === "terminal" && this.activeTabId) {
          e.preventDefault();
          this.tabs.get(this.activeTabId)?.view.zoomOut();
        }
        return;
      }

      // Ctrl+0 — zoom reset
      if (e.ctrlKey && e.key === "0") {
        if (this.currentView === "terminal" && this.activeTabId) {
          e.preventDefault();
          this.tabs.get(this.activeTabId)?.view.zoomReset();
        }
        return;
      }

      // Escape — from KB / settings view, return to connections
      if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        if (this.currentView === "knowledge-base" || this.currentView === "settings") {
          e.preventDefault();
          this.showView("connections");
          return;
        }
        if (this.showShortcuts) {
          e.preventDefault();
          this.closeShortcutsModal();
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
