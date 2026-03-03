import { ConnectionManager } from "./components/connection-manager";
import { TerminalView } from "./components/terminal-view";
import "./styles/main.css";

// App state
type AppView = "connections" | "terminal";

class App {
  private currentView: AppView = "connections";
  private container: HTMLElement;
  private connectionManager: ConnectionManager;
  private terminalView: TerminalView;

  constructor() {
    this.container = document.getElementById("app")!;
    this.connectionManager = new ConnectionManager(this.onConnect.bind(this));
    this.terminalView = new TerminalView(this.onDisconnect.bind(this));
    this.render();
  }

  private onConnect(hostId: string) {
    this.currentView = "terminal";
    this.render();
    this.terminalView.connect(hostId);
  }

  private onDisconnect() {
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
}

new App();
