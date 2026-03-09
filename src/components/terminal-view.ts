/**
 * Terminal View — active SSH session
 * Terminal (xterm.js) + inline suggestions + side panel
 * Wires xterm.js to SSH data stream via Tauri events.
 */

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import {
  Host,
  sshConnect,
  sshSend,
  sshDisconnect,
  sshResize,
  getCredential,
  touchHost,
  loadPlatformIndex,
  queryKb,
  PlatformIndex,
  Command as TauriCommand,
} from "../lib/tauri-api";
import { log } from "../lib/logger";
import { PromptDetector } from "../lib/prompt-detector";
import { ShadowBuffer } from "../lib/shadow-buffer";
import { SuggestionEngine, Command as SuggestionCommand } from "../lib/suggestion-engine";
import { GhostText } from "../lib/ghost-text";
import { Dropdown } from "../lib/dropdown";
import { SidebarContent } from "../lib/sidebar-content";

// Platform display name mapping
const PLATFORM_LABELS: Record<string, string> = {
  "cisco-iosxe": "Cisco IOS-XE",
  "cisco-nxos": "Cisco NX-OS",
  "f5-tmos": "F5 TMOS",
  "linux-bash": "Linux Bash",
};

type ConnectionState = "idle" | "connecting" | "connected" | "disconnected" | "error";

interface ConnectProgress {
  stage: string;
  error?: string;
}

export class TerminalView {
  private terminal: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private onDisconnectCb: () => void;
  private sidePanelOpen = false;
  private host: Host | null = null;
  private state: ConnectionState = "idle";
  private progress: ConnectProgress = { stage: "" };
  private cleanDisconnect = false;

  // Prompt detection & shadow buffer (Stage 8)
  private promptDetector: PromptDetector;
  private shadowBuffer: ShadowBuffer;
  private suggestionEngine: SuggestionEngine;
  private ghostText: GhostText | null = null;
  private dropdown: Dropdown | null = null;
  private sidebarContent: SidebarContent | null = null;
  private platformIndex: PlatformIndex | null = null;
  private currentMode = "";
  private currentInput = "";
  private receivingOutput = false;
  private outputTimer: ReturnType<typeof setTimeout> | null = null;
  private suggestionDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private fontSize = 14;

  // Event listener cleanup
  private unlistenOutput: UnlistenFn | null = null;
  private unlistenConnected: UnlistenFn | null = null;
  private unlistenDisconnected: UnlistenFn | null = null;
  private unlistenError: UnlistenFn | null = null;
  private resizeHandler: (() => void) | null = null;
  private ctrlWHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor(onDisconnect: () => void) {
    this.onDisconnectCb = onDisconnect;
    this.suggestionEngine = new SuggestionEngine();
    this.promptDetector = new PromptDetector(
      (mode) => {
        this.currentMode = mode;
        this.suggestionEngine.setMode(mode);
        this.updateModeDisplay(mode);
        log.info("prompt", `Mode changed: ${mode}`);
      },
      () => {
        // Prompt detected — reset shadow buffer, suppress output flag
        this.shadowBuffer.reset();
        this.receivingOutput = false;
      },
    );
    this.shadowBuffer = new ShadowBuffer((text) => {
      this.currentInput = text;
      this.debounceSuggestionQuery(text);
    });
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
          <div class="tv-terminal-wrap">
            <div class="tv-terminal" id="terminal-container"></div>
            <div class="tv-overlay hidden" id="connect-overlay">
              <div class="tv-overlay-content">
                <div class="tv-overlay-title" id="overlay-title">Connecting...</div>
                <div class="tv-overlay-progress">
                  <div class="tv-progress-bar"><div class="tv-progress-fill" id="progress-fill"></div></div>
                </div>
                <div class="tv-overlay-stage" id="overlay-stage"></div>
                <div class="tv-overlay-error hidden" id="overlay-error"></div>
                <div class="tv-overlay-actions" id="overlay-actions">
                  <button class="btn-text" id="overlay-cancel">Cancel</button>
                </div>
              </div>
            </div>
            <div class="tv-banner hidden" id="disconnect-banner">
              <span id="banner-msg">Connection lost</span>
              <div class="tv-banner-actions">
                <button class="btn-primary btn-sm" id="banner-reconnect">Reconnect</button>
                <button class="btn-text" id="banner-back">Back to hosts</button>
              </div>
            </div>
          </div>
          <div class="tv-sidebar hidden" id="sidebar">
            <div class="sb-content">
              <p class="sb-placeholder">Select a suggestion to see command details</p>
            </div>
          </div>
        </div>
        <div class="tv-statusbar" id="statusbar">
          <span class="sb-indicator sb-connecting" id="sb-dot">●</span>
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

    // Back button
    document.getElementById("back-btn")!.addEventListener("click", () => {
      this.backToHosts();
    });

    // Panel toggle
    document.getElementById("panel-btn")!.addEventListener("click", () => {
      this.toggleSidebar();
    });

    // Overlay cancel
    document.getElementById("overlay-cancel")!.addEventListener("click", () => {
      this.cancelConnect();
    });

    // Disconnect banner actions
    document.getElementById("banner-reconnect")!.addEventListener("click", () => {
      this.reconnect();
    });
    document.getElementById("banner-back")!.addEventListener("click", () => {
      this.backToHosts();
    });

    // Window resize → fit terminal → resize PTY
    this.resizeHandler = () => {
      this.fitAddon?.fit();
    };
    window.addEventListener("resize", this.resizeHandler);

    // xterm.js resize event → send PTY resize to remote
    this.terminal.onResize(({ cols, rows }) => {
      if (this.state === "connected") {
        sshResize(cols, rows).catch(() => {});
      }
    });

    // Ctrl+C copy / Ctrl+V paste — intercept before xterm processes them
    this.terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      // Ctrl+C with selection → copy to clipboard
      if (e.ctrlKey && e.key === "c" && e.type === "keydown") {
        const selection = this.terminal?.getSelection();
        if (selection) {
          navigator.clipboard.writeText(selection);
          this.terminal?.clearSelection();
          return false; // prevent xterm from sending \x03
        }
        // No selection — let xterm send \x03 (interrupt)
        return true;
      }

      // Ctrl+V → read clipboard and send to SSH manually
      if (e.ctrlKey && e.key === "v" && e.type === "keydown") {
        e.preventDefault(); // block browser paste event to avoid double-paste
        navigator.clipboard.readText().then((text) => {
          if (text && this.state === "connected") {
            sshSend(text).catch(() => {});
            // Feed pasted text to shadow buffer
            for (const ch of text) {
              if (ch.charCodeAt(0) >= 32) {
                this.shadowBuffer.append(ch);
              }
            }
          }
        });
        return false; // block xterm from also processing this key
      }

      return true; // let all other keys through
    });

    // Block xterm's internal paste handler — we handle paste manually above
    const termEl = document.getElementById("terminal-container")!;
    termEl.addEventListener("paste", (e) => {
      e.preventDefault();
      e.stopPropagation();
    }, true);

    // Wire keystroke input → SSH + shadow buffer (shadow buffer model: no local echo)
    this.terminal.onData((data) => {
      if (this.state === "connected") {
        // Check for Tab — context-sensitive
        if (data === "\t") {
          if (this.dropdown?.isVisible()) {
            // Accept dropdown selection
            const selected = this.dropdown.getSelected();
            if (selected) {
              const remainder = this.getCommandRemainder(selected.command.name, this.currentInput);
              if (remainder) {
                sshSend(remainder).catch(() => {});
                this.shadowBuffer.reset();
              }
            }
            this.dropdown.hide();
            this.ghostText?.hide();
            return;
          } else if (this.ghostText?.isShowing()) {
            // Accept ghost text suggestion
            const remainder = this.ghostText.getCurrentRemainder();
            if (remainder) {
              sshSend(remainder).catch(() => {});
              this.shadowBuffer.reset();
            }
            this.ghostText.hide();
            return;
          }
          // No suggestion visible — pass Tab through to remote
          sshSend(data).catch(() => {});
          this.shadowBuffer.reset();
          return;
        }

        // Check for Escape — cascade dismiss
        if (data === "\x1b") {
          if (this.dropdown?.isVisible()) {
            this.dropdown.hide();
            return;
          }
          if (this.sidePanelOpen) {
            this.toggleSidebar();
            return;
          }
          if (this.ghostText?.isShowing()) {
            this.ghostText.hide();
            return;
          }
          // Final escape: back to hosts
          this.backToHosts();
          return;
        }

        // Check for Ctrl+Space — toggle dropdown
        if (data === "\x00") {
          this.toggleDropdown();
          return;
        }

        // Arrow keys in dropdown
        if (this.dropdown?.isVisible()) {
          if (data === "\x1b[A") { this.dropdown.moveUp(); this.syncDropdownToGhostText(); return; }
          if (data === "\x1b[B") { this.dropdown.moveDown(); this.syncDropdownToGhostText(); return; }
          if (data === "\r") {
            const selected = this.dropdown.getSelected();
            if (selected) {
              const remainder = this.getCommandRemainder(selected.command.name, this.currentInput);
              if (remainder) {
                sshSend(remainder).catch(() => {});
                this.shadowBuffer.reset();
              }
            }
            this.dropdown.hide();
            this.ghostText?.hide();
            return;
          }
        }

        // Send to SSH
        sshSend(data).catch(() => {});

        // Update shadow buffer based on input
        if (data === "\r") {
          // Enter — reset
          this.shadowBuffer.reset();
          this.ghostText?.hide();
          this.dropdown?.hide();
        } else if (data === "\x7f" || data === "\b") {
          // Backspace
          this.shadowBuffer.backspace();
        } else if (data === "\x03") {
          // Ctrl+C — reset
          this.shadowBuffer.reset();
          this.ghostText?.hide();
          this.dropdown?.hide();
        } else if (data === "\x1b[A" || data === "\x1b[B") {
          // Arrow up/down — history navigation, reset
          this.shadowBuffer.reset();
          this.ghostText?.hide();
        } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
          // Printable character
          this.shadowBuffer.append(data);
        } else if (data.length > 1 && !data.startsWith("\x1b")) {
          // Paste — multi-character input
          for (const ch of data) {
            if (ch.charCodeAt(0) >= 32) {
              this.shadowBuffer.append(ch);
            }
          }
        }
      }
    });

    // Prevent Ctrl+W from closing browser tab — must pass through to remote
    this.ctrlWHandler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "w" && this.state === "connected") {
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", this.ctrlWHandler);
  }

  async connect(host: Host) {
    this.host = host;
    this.cleanDisconnect = false;
    log.info("terminal", `Connect flow starting for '${host.display_name}' (${host.hostname}:${host.port})`);

    // Update top bar
    this.updateHostInfo();

    // Show connecting overlay
    this.setState("connecting");
    this.updateStatusBar("connecting");
    this.setProgress("Initializing...", 5);

    try {
      // Load platform index for prompt patterns + KB
      this.setProgress("Loading knowledge base...", 8);
      try {
        this.platformIndex = await loadPlatformIndex(host.platform);
        this.promptDetector.loadPatterns(this.platformIndex.prompt_patterns, this.platformIndex.default_mode);
        this.currentMode = this.platformIndex.default_mode;
        this.suggestionEngine.setMode(this.currentMode);
        log.info("terminal", `Platform index loaded: ${this.platformIndex.name}, default mode: ${this.platformIndex.default_mode}`);
      } catch (e) {
        log.warn("terminal", `Failed to load platform index: ${e}`);
      }

      // Clean up any existing SSH listeners before registering new ones
      this.unregisterSshListeners();
      await this.registerSshListeners();

      // Retrieve credential if password auth
      let password: string | undefined;
      if (host.auth_type === "password") {
        this.setProgress("Retrieving credentials...", 10);
        try {
          const cred = await getCredential(host.id);
          password = cred ?? undefined;
        } catch {
          // Continue without password — server may prompt
        }
      }

      // Determine terminal dimensions
      const cols = this.terminal?.cols ?? 80;
      const rows = this.terminal?.rows ?? 24;

      // Initiate SSH connection
      this.setProgress(`Connecting to ${host.hostname}:${host.port}...`, 25);

      await sshConnect({
        hostname: host.hostname,
        port: host.port,
        username: host.username,
        password,
        keyPath: host.auth_type === "ssh_key" ? (host.ssh_key_path ?? undefined) : undefined,
        cols,
        rows,
      });

      log.info("terminal", "sshConnect resolved successfully");
    } catch (err) {
      log.error("terminal", `Connection failed: ${err}`);
      this.showError(String(err));
    }
  }

  private async registerSshListeners() {
    // SSH output → xterm.js + prompt detector
    this.unlistenOutput = await listen<{ data: string }>("ssh-output", (event) => {
      const bytes = this.base64ToUint8Array(event.payload.data);
      this.terminal?.write(bytes);
      // Feed to prompt detector
      const text = new TextDecoder().decode(bytes);
      this.promptDetector.feed(text);

      // Only suppress ghost text for substantial output (command results),
      // not for single-character echoes from the remote device.
      // Echoed keystrokes are typically 1-3 bytes; real output is longer.
      if (text.length > 3 || text.includes("\n") || text.includes("\r\n")) {
        this.receivingOutput = true;
        this.ghostText?.hide();
        this.dropdown?.hide();
        if (this.outputTimer) clearTimeout(this.outputTimer);
        this.outputTimer = setTimeout(() => {
          this.receivingOutput = false;
          // Re-trigger suggestions if shadow buffer has content (e.g. after paste echo)
          if (this.currentInput) {
            this.showSuggestions(this.currentInput);
          }
        }, 300);
      }
    });

    // SSH connected
    this.unlistenConnected = await listen<{ reason: string }>("ssh-connected", () => {
      log.info("terminal", "SSH connected event received");
      this.setState("connected");
      // Update last_connected timestamp
      if (this.host) {
        touchHost(this.host.id).catch(() => {});
      }
      this.hideOverlay();
      this.terminal?.focus();
      this.updateStatusBar("connected");
      this.updateModeDisplay(this.currentMode);

      // Initialize ghost text overlay and dropdown
      const termContainer = document.getElementById("terminal-container")!;
      if (this.terminal) {
        this.ghostText = new GhostText(this.terminal, termContainer);
        this.dropdown = new Dropdown(termContainer, (cmd) => {
          // On dropdown accept
          const remainder = this.getCommandRemainder(cmd.name, this.currentInput);
          if (remainder) {
            sshSend(remainder).catch(() => {});
            this.shadowBuffer.reset();
          }
          this.ghostText?.hide();
        });
        this.sidebarContent = new SidebarContent();
      }

      // Load KB commands into frontend suggestion engine
      if (this.host) {
        this.loadKbCommands(this.host.platform, this.host.os_version ?? null);
      }
    });

    // SSH disconnected
    this.unlistenDisconnected = await listen<{ reason: string }>("ssh-disconnected", (event) => {
      log.info("terminal", `SSH disconnected event: ${event.payload.reason}`);
      if (this.cleanDisconnect) return; // User initiated — handled elsewhere
      this.setState("disconnected");
      this.showDisconnectBanner(event.payload.reason);
      this.updateStatusBar("disconnected");
    });

    // SSH error
    this.unlistenError = await listen<{ reason: string }>("ssh-error", (event) => {
      log.error("terminal", `SSH error event: ${event.payload.reason}`);
      this.showError(event.payload.reason);
    });
  }

  private unregisterSshListeners() {
    this.unlistenOutput?.();
    this.unlistenConnected?.();
    this.unlistenDisconnected?.();
    this.unlistenError?.();
    this.unlistenOutput = null;
    this.unlistenConnected = null;
    this.unlistenDisconnected = null;
    this.unlistenError = null;
  }

  // ─── Overlay / Banner UI ─────────────────────────────────────────

  private setState(state: ConnectionState) {
    this.state = state;
  }

  private setProgress(stage: string, percent: number) {
    this.progress.stage = stage;
    const overlay = document.getElementById("connect-overlay");
    const stageEl = document.getElementById("overlay-stage");
    const fillEl = document.getElementById("progress-fill");
    const errorEl = document.getElementById("overlay-error");
    const actionsEl = document.getElementById("overlay-actions");
    const titleEl = document.getElementById("overlay-title");

    overlay?.classList.remove("hidden");
    if (stageEl) stageEl.textContent = stage;
    if (fillEl) fillEl.style.width = `${percent}%`;
    if (titleEl) titleEl.textContent = `Connecting to ${this.host?.display_name ?? "host"}`;
    errorEl?.classList.add("hidden");
    if (actionsEl) {
      actionsEl.innerHTML = `<button class="btn-text" id="overlay-cancel">Cancel</button>`;
      document.getElementById("overlay-cancel")?.addEventListener("click", () => this.cancelConnect());
    }
  }

  private showError(message: string) {
    this.setState("error");
    const overlay = document.getElementById("connect-overlay");
    const stageEl = document.getElementById("overlay-stage");
    const fillEl = document.getElementById("progress-fill");
    const errorEl = document.getElementById("overlay-error");
    const actionsEl = document.getElementById("overlay-actions");
    const titleEl = document.getElementById("overlay-title");

    overlay?.classList.remove("hidden");
    if (titleEl) titleEl.textContent = "Connection Failed";
    if (stageEl) stageEl.textContent = "";
    if (fillEl) fillEl.style.width = "0%";
    if (errorEl) {
      errorEl.textContent = message;
      errorEl.classList.remove("hidden");
    }
    if (actionsEl) {
      actionsEl.innerHTML = `
        <button class="btn-primary btn-sm" id="overlay-retry">Retry</button>
        <button class="btn-text" id="overlay-back">Back to hosts</button>
      `;
      document.getElementById("overlay-retry")?.addEventListener("click", () => this.reconnect());
      document.getElementById("overlay-back")?.addEventListener("click", () => this.backToHosts());
    }
    this.updateStatusBar("error");
  }

  private hideOverlay() {
    document.getElementById("connect-overlay")?.classList.add("hidden");
  }

  private showDisconnectBanner(reason: string) {
    const banner = document.getElementById("disconnect-banner");
    const msgEl = document.getElementById("banner-msg");
    banner?.classList.remove("hidden");
    if (msgEl) {
      const reasonText = reason === "channel_closed" ? "Session ended"
        : reason === "channel_eof" ? "Remote closed connection"
        : "Connection lost";
      msgEl.textContent = reasonText;
    }
  }

  private hideDisconnectBanner() {
    document.getElementById("disconnect-banner")?.classList.add("hidden");
  }

  // ─── Status bar ──────────────────────────────────────────────────

  private updateHostInfo() {
    const infoEl = document.getElementById("host-info");
    if (infoEl && this.host) {
      const platformLabel = PLATFORM_LABELS[this.host.platform] ?? this.host.platform;
      const version = this.host.os_version ? ` ${this.host.os_version}` : "";
      infoEl.textContent = `${this.host.display_name} (${platformLabel}${version})`;
    }
  }

  private updateStatusBar(status: "connecting" | "connected" | "disconnected" | "error") {
    const dot = document.getElementById("sb-dot");
    const hostEl = document.getElementById("sb-host");
    const platformEl = document.getElementById("sb-platform");

    if (dot) {
      dot.className = "sb-indicator";
      switch (status) {
        case "connecting": dot.classList.add("sb-connecting"); break;
        case "connected": dot.classList.add("sb-connected"); break;
        case "disconnected":
        case "error": dot.classList.add("sb-disconnected"); break;
      }
    }

    if (hostEl && this.host) {
      hostEl.textContent = this.host.hostname;
    }
    if (platformEl && this.host) {
      const label = PLATFORM_LABELS[this.host.platform] ?? this.host.platform;
      const version = this.host.os_version ? ` ${this.host.os_version}` : "";
      platformEl.textContent = `${label}${version}`;
    }
  }

  // ─── Navigation / lifecycle ──────────────────────────────────────

  private async backToHosts() {
    log.info("terminal", "Back to hosts requested");
    this.cleanDisconnect = true;
    try {
      await sshDisconnect();
    } catch {
      // Already disconnected or no session
    }
    this.cleanup();
    this.onDisconnectCb();
  }

  private async cancelConnect() {
    this.cleanDisconnect = true;
    try {
      await sshDisconnect();
    } catch {
      // Ignore
    }
    this.cleanup();
    this.onDisconnectCb();
  }

  private async reconnect() {
    if (!this.host) return;
    this.hideOverlay();
    this.hideDisconnectBanner();
    this.unregisterSshListeners();
    this.terminal?.clear();
    await this.connect(this.host);
  }

  private toggleSidebar() {
    this.sidePanelOpen = !this.sidePanelOpen;
    const sidebar = document.getElementById("sidebar")!;
    sidebar.classList.toggle("hidden", !this.sidePanelOpen);
    // Refit terminal after sidebar transition
    setTimeout(() => {
      this.fitAddon?.fit();
      this.ghostText?.reposition();
    }, 250);
  }

  // ─── Mode display ────────────────────────────────────────────────

  private updateModeDisplay(mode: string) {
    const modeEl = document.getElementById("sb-mode");
    if (modeEl) {
      modeEl.textContent = this.formatModeName(mode);
    }
  }

  private formatModeName(mode: string): string {
    if (!mode) return "—";
    return mode.split(/[-_]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  }

  // ─── KB loading ──────────────────────────────────────────────────

  private async loadKbCommands(platform: string, version: string | null) {
    try {
      log.info("kb", `Loading commands for platform=${platform}, version=${version}`);
      const commands = await queryKb("", platform, null, version);
      log.info("kb", `queryKb returned ${commands.length} commands`);
      // Convert TauriCommand[] to SuggestionCommand[]
      const mapped: SuggestionCommand[] = commands.map((c: TauriCommand) => ({
        name: c.name,
        syntax: c.syntax,
        description: c.description,
        category: c.category,
        mode: c.mode,
        aliases: c.aliases,
        examples: c.examples,
        versions: {
          introduced: c.versions.introduced ?? "",
          deprecated: c.versions.deprecated ?? null,
          notes: c.versions.notes ?? null,
        },
        tags: c.tags,
      }));
      this.suggestionEngine.loadCommands(mapped, platform);
      log.info("terminal", `Loaded ${mapped.length} commands for ${platform}`);
    } catch (e) {
      log.warn("terminal", `Failed to load KB commands: ${e}`);
    }
  }

  // ─── Suggestion pipeline ─────────────────────────────────────────

  private debounceSuggestionQuery(text: string) {
    if (this.suggestionDebounceTimer) clearTimeout(this.suggestionDebounceTimer);
    if (!text || this.receivingOutput || this.state !== "connected") {
      this.ghostText?.hide();
      if (this.dropdown?.isVisible()) {
        this.dropdown.updateResults([]);
      }
      this.updateSidebarPlaceholder();
      return;
    }
    this.suggestionDebounceTimer = setTimeout(() => {
      this.showSuggestions(text);
    }, 40);
  }

  private showSuggestions(text: string) {
    const results = this.suggestionEngine.query(text);
    log.debug("suggest", `query('${text}') mode='${this.currentMode}' → ${results.length} results`);

    if (results.length === 0) {
      this.ghostText?.hide();
      if (this.dropdown?.isVisible()) {
        this.dropdown.updateResults([]);
      }
      this.updateSidebarPlaceholder();
      return;
    }

    // Show ghost text for top match
    const top = results[0];
    const remainder = this.getCommandRemainder(top.command.name, text);
    if (remainder && this.terminal) {
      this.ghostText?.show(remainder, results.length - 1);
    } else {
      this.ghostText?.hide();
    }

    // Update dropdown if open
    if (this.dropdown?.isVisible()) {
      this.dropdown.updateResults(results);
    }

    // Update sidebar with top match detail
    this.updateSidebarDetail(top.command);
  }

  private getCommandRemainder(commandName: string, input: string): string | null {
    if (!input) return commandName;
    const lowerInput = input.toLowerCase();
    const lowerCmd = commandName.toLowerCase();
    if (lowerCmd.startsWith(lowerInput)) {
      const remainder = commandName.substring(input.length);
      return remainder || null;
    }
    return null;
  }

  private syncDropdownToGhostText() {
    const selected = this.dropdown?.getSelected();
    if (selected) {
      const remainder = this.getCommandRemainder(selected.command.name, this.currentInput);
      if (remainder) {
        this.ghostText?.show(remainder, 0);
      } else {
        this.ghostText?.hide();
      }
      this.updateSidebarDetail(selected.command);
    }
  }

  private toggleDropdown() {
    if (this.dropdown?.isVisible()) {
      this.dropdown.hide();
      return;
    }
    // Get results — if input empty, show all for current mode
    const results = this.suggestionEngine.query(this.currentInput || "");
    if (results.length === 0) return;
    if (!this.dropdown && this.terminal) {
      const termContainer = document.getElementById("terminal-container")!;
      this.dropdown = new Dropdown(termContainer, (cmd) => {
        const remainder = this.getCommandRemainder(cmd.name, this.currentInput);
        if (remainder) {
          sshSend(remainder).catch(() => {});
          this.shadowBuffer.reset();
        }
        this.ghostText?.hide();
      });
    }
    this.dropdown?.show(results, this.currentInput);
    this.syncDropdownToGhostText();
  }

  // ─── Sidebar content ─────────────────────────────────────────────

  private updateSidebarDetail(command: SuggestionCommand) {
    const content = document.querySelector(".sb-content");
    if (!content || !this.sidePanelOpen) return;
    if (!this.sidebarContent) this.sidebarContent = new SidebarContent();
    content.innerHTML = this.sidebarContent.render(command, this.platformIndex?.reference_url ?? null);
    // Wire clickable examples
    content.querySelectorAll(".example-item").forEach((el) => {
      el.addEventListener("click", () => {
        const cmd = (el as HTMLElement).dataset.command;
        if (cmd && this.state === "connected") {
          sshSend(cmd + "\r").catch(() => {});
          this.terminal?.focus();
        }
      });
    });
  }

  private updateSidebarPlaceholder() {
    const content = document.querySelector(".sb-content");
    if (!content || !this.sidePanelOpen) return;
    content.innerHTML = `<p class="sb-placeholder">Start typing to see suggestions</p>`;
  }

  // ─── Zoom ────────────────────────────────────────────────────────

  zoomIn() {
    if (!this.terminal) return;
    this.fontSize = Math.min(this.fontSize + 2, 32);
    this.terminal.options.fontSize = this.fontSize;
    this.fitAddon?.fit();
  }

  zoomOut() {
    if (!this.terminal) return;
    this.fontSize = Math.max(this.fontSize - 2, 8);
    this.terminal.options.fontSize = this.fontSize;
    this.fitAddon?.fit();
  }

  zoomReset() {
    if (!this.terminal) return;
    this.fontSize = 14;
    this.terminal.options.fontSize = this.fontSize;
    this.fitAddon?.fit();
  }

  // ─── Cleanup ─────────────────────────────────────────────────────

  private cleanup() {
    this.unregisterSshListeners();

    if (this.resizeHandler) {
      window.removeEventListener("resize", this.resizeHandler);
      this.resizeHandler = null;
    }
    if (this.ctrlWHandler) {
      window.removeEventListener("keydown", this.ctrlWHandler);
      this.ctrlWHandler = null;
    }

    this.ghostText?.destroy();
    this.ghostText = null;
    this.dropdown?.destroy();
    this.dropdown = null;
    this.sidebarContent = null;
    this.platformIndex = null;
    if (this.suggestionDebounceTimer) clearTimeout(this.suggestionDebounceTimer);
    if (this.outputTimer) clearTimeout(this.outputTimer);

    this.terminal?.dispose();
    this.terminal = null;
    this.fitAddon = null;
    this.host = null;
    this.state = "idle";
  }

  // ─── Util ────────────────────────────────────────────────────────

  private base64ToUint8Array(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
}
