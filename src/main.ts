import { HostScreen } from "./components/host-screen";
import { TerminalView } from "./components/terminal-view";
import { KbScreen } from "./components/kb-screen";
import { Host } from "./lib/tauri-api";
import { log } from "./lib/logger";
import { TabState, activateTab as activateTabState, closeTab as closeTabState } from "./lib/tab-state";
import { getAppTheme, setAppTheme, Theme } from "./lib/theme";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/jetbrains-mono/600.css";
import "@fontsource/jetbrains-mono/700.css";
import "./styles/tokens.css";
import "./styles/main.css";

// App state
type AppView = "connections" | "terminal" | "knowledge-base";

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

  // Session tabs — one per connected host
  private tabs = new Map<string, SessionTab>();
  private activeTabId: string | null = null;
  private sessionTabBar: HTMLElement | null = null;
  private terminalArea: HTMLElement;

  // Track which host IDs have an active SSH session
  activeSessions = new Set<string>();

  constructor() {
    this.container = document.getElementById("app")!;
    setAppTheme(getAppTheme());

    // Create persistent wrapper divs for views
    this.hostScreenWrapper = document.createElement("div");
    this.hostScreenWrapper.className = "app-view";
    this.hostScreenWrapper.style.display = "";

    this.terminalArea = document.createElement("div");
    this.terminalArea.className = "app-view";
    this.terminalArea.style.display = "none";

    this.container.appendChild(this.hostScreenWrapper);
    this.container.appendChild(this.terminalArea);

    // KB screen wrapper (persistent — import progress events never lost)
    this.kbScreenWrapper = document.createElement("div");
    this.kbScreenWrapper.className = "app-view";
    this.kbScreenWrapper.style.display = "none";
    this.container.appendChild(this.kbScreenWrapper);

    this.kbScreen = new KbScreen(() => this.showView("connections"));
    this.kbScreen.mount(this.kbScreenWrapper);

    // Mount host screen
    this.hostScreen = new HostScreen(
      this.onConnect.bind(this),
      () => this.activeSessions,
    );
    this.hostScreen.mount(this.hostScreenWrapper);

    log.info("app", "Initialized");
    this.registerGlobalShortcuts();
    this.renderTabBar();
  }

  private renderTabBar() {
    const tabBar = document.createElement("div");
    tabBar.className = "app-tab-bar";
    tabBar.id = "app-tab-bar";

    const connectionsTab = document.createElement("div");
    connectionsTab.className = "app-tab active";
    connectionsTab.dataset.view = "connections";
    connectionsTab.textContent = "Connections";

    const kbTab = document.createElement("div");
    kbTab.className = "app-tab";
    kbTab.dataset.view = "knowledge-base";
    kbTab.textContent = "Knowledge Base";

    tabBar.appendChild(connectionsTab);
    tabBar.appendChild(kbTab);

    const themeBtn = document.createElement("button");
    themeBtn.className = "btn-text app-theme-btn";
    themeBtn.addEventListener("click", () => {
      setAppTheme(getAppTheme() === "dark" ? "light" : "dark");
    });
    tabBar.appendChild(themeBtn);

    const syncThemeIcon = () => {
      themeBtn.textContent = getAppTheme() === "dark" ? "☀" : "🌙";
    };
    syncThemeIcon();
    window.addEventListener("netsh:theme", syncThemeIcon);

    tabBar.addEventListener("click", (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.classList.contains("app-tab")) {
        const view = target.dataset.view as AppView;
        if (view) {
          this.showView(view);
        }
      }
    });

    // Insert before the first wrapper
    this.container.insertBefore(tabBar, this.container.firstChild);
  }

  private updateTabBar(view: AppView) {
    const tabs = this.container.querySelectorAll<HTMLElement>(".app-tab");
    tabs.forEach((tab) => {
      const isActive = tab.dataset.view === view;
      tab.classList.toggle("active", isActive);
    });
  }

  private showView(view: AppView) {
    this.currentView = view;
    this.hostScreenWrapper.style.display = view === "connections" ? "" : "none";
    this.terminalArea.style.display = view === "terminal" ? "" : "none";
    this.kbScreenWrapper.style.display = view === "knowledge-base" ? "" : "none";
    this.updateTabBar(view);
    if (view === "terminal") {
      this.renderSessionTabBar();
    }
  }

  private onConnect(host: Host) {
    log.info("app", `Connecting to '${host.display_name}' (${host.hostname}:${host.port})`);
    this.activeSessions.add(host.id);

    // Existing tab → activate
    const existing = this.tabs.get(host.id);
    if (existing) {
      this.activateTab(host.id);
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

      // Escape — from KB view, return to connections
      if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        if (this.currentView === "knowledge-base") {
          e.preventDefault();
          this.showView("connections");
          return;
        }
      }
    });
  }
}

new App();
