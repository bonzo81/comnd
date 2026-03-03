/**
 * Terminal View — active SSH session
 * Terminal (xterm.js) + inline suggestions + side panel
 */

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

export class TerminalView {
  private terminal: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private onDisconnect: () => void;
  private sidePanelOpen = false;

  constructor(onDisconnect: () => void) {
    this.onDisconnect = onDisconnect;
  }

  mount(container: HTMLElement) {
    container.innerHTML = `
      <div class="terminal-view">
        <div class="tv-topbar">
          <button class="btn-text" id="back-btn">← Back</button>
          <span class="tv-host-info" id="host-info">Connecting...</span>
          <button class="btn-text" id="panel-btn">≡ Panel</button>
        </div>
        <div class="tv-main">
          <div class="tv-terminal" id="terminal-container"></div>
          <div class="tv-sidebar hidden" id="sidebar">
            <div class="sb-content">
              <p class="sb-placeholder">Select a suggestion to see command details</p>
            </div>
          </div>
        </div>
        <div class="tv-statusbar" id="statusbar">
          <span class="sb-indicator sb-connecting">🟡</span>
          <span id="sb-host">—</span>
          <span class="sb-divider">│</span>
          <span id="sb-platform">—</span>
          <span class="sb-divider">│</span>
          <span id="sb-mode">—</span>
        </div>
      </div>
    `;

    // Init xterm.js
    this.terminal = new Terminal({
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 14,
      theme: {
        background: "#1e1e2e",
        foreground: "#cdd6f4",
        cursor: "#f5e0dc",
        selectionBackground: "#585b70",
      },
      cursorBlink: true,
    });

    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);

    const termContainer = document.getElementById("terminal-container")!;
    this.terminal.open(termContainer);
    this.fitAddon.fit();

    // Event listeners
    document.getElementById("back-btn")!.addEventListener("click", () => {
      this.disconnect();
    });

    document.getElementById("panel-btn")!.addEventListener("click", () => {
      this.toggleSidebar();
    });

    window.addEventListener("resize", () => {
      this.fitAddon?.fit();
    });

    this.terminal.writeln("net.sh v0.1.0");
    this.terminal.writeln("Terminal ready. SSH connection not yet implemented.");
    this.terminal.writeln("");
  }

  connect(_hostId: string) {
    // TODO: Invoke Tauri command to establish SSH connection
    this.terminal?.writeln("SSH connection will be implemented via Tauri + russh backend.");
  }

  disconnect() {
    this.terminal?.dispose();
    this.terminal = null;
    this.onDisconnect();
  }

  private toggleSidebar() {
    this.sidePanelOpen = !this.sidePanelOpen;
    const sidebar = document.getElementById("sidebar")!;
    sidebar.classList.toggle("hidden", !this.sidePanelOpen);
    this.fitAddon?.fit();
  }
}
