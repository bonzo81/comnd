import { ConnectionManager } from "./components/connection-manager";
import { TerminalView } from "./components/terminal-view";
import { Host } from "./lib/tauri-api";
import { log } from "./lib/logger";
import "./styles/main.css";

// App state
type AppView = "connections" | "terminal";

class App {
  private currentView: AppView = "connections";
  private container: HTMLElement;
  private connectionManager: ConnectionManager;
  private terminalView: TerminalView;
  private activeHost: Host | null = null;

  constructor() {
    this.container = document.getElementById("app")!;
    this.connectionManager = new ConnectionManager(this.onConnect.bind(this));
    this.terminalView = new TerminalView(this.onDisconnect.bind(this));
    log.info("app", "Initialized");
    this.render();
    this.registerGlobalShortcuts();
  }

  private onConnect(host: Host) {
    log.info("app", `Connecting to '${host.display_name}' (${host.hostname}:${host.port})`);
    this.activeHost = host;
    this.currentView = "terminal";
    this.render();
    this.terminalView.connect(host).catch((err) => {
      console.error("Connect failed:", err);
    });
  }

  private onDisconnect() {
    log.info("app", "Disconnected, returning to connection manager");
    this.activeHost = null;
    this.currentView = "connections";
    this.render();
  }

  private render() {
    this.container.innerHTML = "";
    if (this.currentView === "connections") {
      this.connectionManager.mount(this.container);
    } else {
      this.terminalView.mount(this.container);
    }
  }

  private registerGlobalShortcuts() {
    window.addEventListener("keydown", (e: KeyboardEvent) => {
      // Ctrl+W — MUST pass through to remote. Prevent browser/app close.
      if (e.ctrlKey && !e.shiftKey && e.key === "w") {
        if (this.currentView === "terminal") {
          e.preventDefault();
        }
        return;
      }

      // Ctrl+Shift+W — disconnect from terminal
      if (e.ctrlKey && e.shiftKey && e.key === "W") {
        if (this.currentView === "terminal") {
          e.preventDefault();
          this.onDisconnect();
        }
        return;
      }

      // Ctrl+= or Ctrl++ — zoom in
      if (e.ctrlKey && (e.key === "=" || e.key === "+")) {
        if (this.currentView === "terminal") {
          e.preventDefault();
          this.terminalView.zoomIn();
        }
        return;
      }

      // Ctrl+- — zoom out
      if (e.ctrlKey && e.key === "-") {
        if (this.currentView === "terminal") {
          e.preventDefault();
          this.terminalView.zoomOut();
        }
        return;
      }

      // Ctrl+0 — zoom reset
      if (e.ctrlKey && e.key === "0") {
        if (this.currentView === "terminal") {
          e.preventDefault();
          this.terminalView.zoomReset();
        }
        return;
      }
    });
  }
}

new App();
