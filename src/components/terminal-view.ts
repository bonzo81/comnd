/**
 * Terminal View — active SSH session
 * Terminal (xterm.js) + inline suggestions + side panel
 * Wires xterm.js to SSH data stream via Tauri events.
 */

import { Terminal } from "@xterm/xterm";
import { TERMINAL_THEMES, getTerminalTheme, setTerminalTheme, TerminalTheme } from "../lib/theme";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import {
  Host,
  sshConnect,
  sshSend,
  sshDisconnect,
  sshResize,
  touchHost,
  loadPlatformIndex,
  queryKb,
  openUrl,
  PlatformIndex,
  Command,
} from "../lib/tauri-api";
import { log, LogTag } from "../lib/logger";
import { PromptDetector } from "../lib/prompt-detector";
import { ShadowBuffer } from "../lib/shadow-buffer";
import { SuggestionEngine, ghostPayloadFor, SuggestionResult } from "../lib/suggestion-engine";
import { GhostText, GhostPayload, ghostPayloadAcceptText } from "../lib/ghost-text";
import { Dropdown } from "../lib/dropdown";
import { SidebarContent } from "../lib/sidebar-content";
import { refreshValidation } from "../lib/validation-cache";
import { stripAnsi } from "../lib/ansi";
import { formatMode } from "../lib/format";
import { mintSessionId } from "../lib/session-id";
import { shouldAcceptEvent } from "../lib/session-filter";
import { icons } from "../lib/icons";
import {
  getTimestampsEnabled,
  setTimestampsEnabled,
  getTimestampFormat,
  TimestampGutter,
} from "../lib/timestamps";
import { getAutoCopyEnabled, setAutoCopyEnabled } from "../lib/auto-copy";
import { OutputHighlighter } from "../lib/output-highlighter";
import { getOutputHighlightEnabled, setOutputHighlightEnabled } from "../lib/output-highlight";
import { initContextMenu, setToggleState } from "../lib/a11y";

// Platform display name mapping
const PLATFORM_LABELS: Record<string, string> = {
  "cisco-iosxe": "Cisco IOS-XE",
  "cisco-nxos": "Cisco NX-OS",
  "f5-tmos": "F5 TMOS",
  "linux-bash": "Linux Bash",
};

// Secret provider display names (connect progress, chunk 10)
const PROVIDER_NAMES: Record<string, string> = { proton: "Proton Pass" };

// Ambient chrome tint per platform mode
const MODE_TINTS: Record<string, string> = {
  "cisco-iosxe": "var(--tint-iosxe)",
  "cisco-nxos": "var(--tint-nxos)",
  "f5-tmos": "var(--tint-tmos)",
  "linux-bash": "var(--tint-bash)",
  "config": "var(--tint-iosxe)",
  "exec": "var(--tint-iosxe)",
  "enable": "var(--tint-iosxe)",
  "configure": "var(--tint-nxos)",
  "bash": "var(--tint-bash)",
  "tmsh": "var(--tint-tmos)",
};

// Auto-suggestion toggle — persisted, synced across tabs via window event
const SUGGESTIONS_KEY = "netssh-suggestions";

function getSuggestionsEnabled(): boolean {
  return localStorage.getItem(SUGGESTIONS_KEY) === "1";
}

function setSuggestionsEnabled(enabled: boolean): void {
  localStorage.setItem(SUGGESTIONS_KEY, enabled ? "1" : "0");
  window.dispatchEvent(new CustomEvent("netssh:suggestions", { detail: enabled }));
}

type ConnectionState = "idle" | "connecting" | "connected" | "disconnected" | "error";

interface ConnectProgress {
  stage: string;
  error?: string;
}

export class TerminalView {
  private root: HTMLElement | null = null;
  private terminal: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private onDetachCb: () => void;
  private onDisconnectCb: (hostId: string) => void;
  private onSessionDiedCb: (hostId: string) => void;
  private onRequestCloseCb: (hostId: string) => void;
  private sidePanelOpen = false;
  private host: Host | null = null;
  private state: ConnectionState = "idle";
  private progress: ConnectProgress = { stage: "" };
  private cleanDisconnect = false;

  // Set by the ssh-connected listener once the backend confirms the session;
  // ssh-disconnected events for a session that never reached "connected"
  // (e.g. channel EOF right after shell open) must not bounce the view.
  private connectedAtLeastOnce = false;

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
  private outputBuffer: string[] = [];
  private fontSize = 14;

  // Session ID for event correlation — stale events from old connections are ignored
  private sessionId = 0;

  // Event listener cleanup
  private unlistenOutput: UnlistenFn | null = null;
  private unlistenConnected: UnlistenFn | null = null;
  private unlistenDisconnected: UnlistenFn | null = null;
  private unlistenError: UnlistenFn | null = null;
  private unlistenTofu: UnlistenFn | null = null;
  private unlistenAuthUrl: UnlistenFn | null = null;
  private resizeHandler: (() => void) | null = null;
  private ctrlWHandler: ((e: KeyboardEvent) => void) | null = null;
  private themeChangeHandler: (() => void) | null = null;
  private timestampsChangeHandler: (() => void) | null = null;
  private timestampsFormatHandler: (() => void) | null = null;
  private timestampGutter: TimestampGutter | null = null;
  private suggestionsEnabled = false;
  private suggestionsChangeHandler: (() => void) | null = null;
  private autoCopyChangeHandler: (() => void) | null = null;
  private outputHighlighter: OutputHighlighter | null = null;
  private highlightChangeHandler: (() => void) | null = null;

  // Right-click context menu (terminal area)
  private ctxMenuEl: HTMLDivElement | null = null;
  private ctxOutsideHandler: ((e: MouseEvent) => void) | null = null;
  private ctxEscapeHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor(
    onDetach: () => void,
    onDisconnect: (hostId: string) => void,
    onSessionDied: (hostId: string) => void,
    onRequestClose: (hostId: string) => void,
  ) {
    this.onDetachCb = onDetach;
    this.onDisconnectCb = onDisconnect;
    this.onSessionDiedCb = onSessionDied;
    this.onRequestCloseCb = onRequestClose;
    this.suggestionEngine = new SuggestionEngine();
    this.promptDetector = new PromptDetector(
      (mode) => {
        this.currentMode = mode;
        this.suggestionEngine.setMode(mode);
        this.updateModeDisplay(mode);
        log.info(LogTag.Prompt, `Mode changed: ${mode}`);
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

  private $<T extends HTMLElement = HTMLElement>(sel: string): T | null {
    return this.root?.querySelector(sel) as T | null;
  }

  private initTerminal() {
    if (this.terminal) return;
    this.terminal = new Terminal({
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: this.fontSize,
      theme: TERMINAL_THEMES[getTerminalTheme()],
      cursorBlink: true,
      allowProposedApi: true, // required for registerDecoration (line timestamps)
    });

    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.loadAddon(new WebLinksAddon((_event, uri) => {
      openUrl(uri).catch(() => {});
    }));

    const termContainer = this.$(".tv-terminal")!;
    this.terminal.open(termContainer);
    this.timestampGutter = new TimestampGutter(this.terminal);
    this.syncTerminalChrome();
    this.syncTimestamps();
    this.syncSuggestions();
    this.fitAddon.fit();

    // xterm.js resize event → send PTY resize to remote
    this.terminal.onResize(({ cols, rows }) => {
      if (this.state === "connected" && this.sessionId) {
        sshResize(this.sessionId, cols, rows).catch(() => {});
      }
    });

    // Auto-copy on selection — scoped to this terminal instance only; fires as
    // the in-terminal selection changes. Native DOM selection elsewhere is a
    // separate state and never reaches here.
    this.terminal.onSelectionChange(() => {
      if (!getAutoCopyEnabled()) return;
      const selection = this.terminal?.getSelection();
      if (selection) navigator.clipboard.writeText(selection).catch(() => {});
    });

    // Ctrl+C copy / Ctrl+V paste — intercept before xterm processes them
    this.terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      // Ctrl+C with selection → copy to clipboard
      if (e.ctrlKey && e.key === "c" && e.type === "keydown") {
        if (this.terminal?.getSelection()) {
          this.copySelection();
          return false; // prevent xterm from sending \x03
        }
        // No selection — let xterm send \x03 (interrupt)
        return true;
      }

      // Ctrl+V → read clipboard and send to SSH manually
      if (e.ctrlKey && e.key === "v" && e.type === "keydown") {
        e.preventDefault(); // block browser paste event to avoid double-paste
        this.pasteClipboard();
        return false; // block xterm from also processing this key
      }

      return true; // let all other keys through
    });

    // Wire keystroke input → SSH + shadow buffer (shadow buffer model: no local echo)
    this.terminal.onData((data) => {
      if (this.state === "connected") {
        // Check for Tab — context-sensitive
        if (data === "\t") {
          if (this.dropdown?.isVisible()) {
            // Accept dropdown selection (token-aware — dropdown builds payload)
            this.acceptDropdownSelection();
            return;
          } else if (this.ghostText?.isShowing()) {
            // Accept ghost text suggestion (returns null for variable placeholders)
            const remainder = this.ghostText.getCurrentRemainder();
            if (remainder) {
              this.sendData(remainder);
              this.shadowBuffer.reset();
            }
            this.ghostText.hide();
            return;
          }
          // No suggestion visible — pass Tab through to remote
          this.sendData(data);
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
          }
        }

        // Check for Ctrl+Space — toggle auto-suggestions
        if (data === "\x00") {
          setSuggestionsEnabled(!getSuggestionsEnabled());
          return;
        }

        // Arrow keys in dropdown. Enter always submits to remote — it falls
        // through to sendData below and the reset block hides the dropdown.
        if (this.dropdown?.isVisible()) {
          if (data === "\x1b[A") { this.dropdown.moveUp(); this.syncDropdownToGhostText(); return; }
          if (data === "\x1b[B") { this.dropdown.moveDown(); this.syncDropdownToGhostText(); return; }
        }

        // Send to SSH
        this.sendData(data);

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
  }

  /** Send data to the current session (no-op when not connected). */
  private sendData(data: string) {
    if (this.state === "connected" && this.sessionId) {
      sshSend(this.sessionId, data).catch(() => {});
    }
  }

  // ─── Clipboard ───────────────────────────────────────────────────

  /** Copy terminal selection to clipboard (no-op without a selection). */
  private copySelection() {
    const selection = this.terminal?.getSelection();
    if (!selection) return;
    navigator.clipboard.writeText(selection);
    this.terminal?.clearSelection();
  }

  /** Read clipboard and send it to the remote session + shadow buffer. */
  private pasteClipboard() {
    navigator.clipboard.readText().then((text) => {
      if (text && this.state === "connected" && this.sessionId) {
        sshSend(this.sessionId, text).catch(() => {});
        for (const ch of text) {
          if (ch.charCodeAt(0) >= 32) {
            this.shadowBuffer.append(ch);
          }
        }
      }
    });
  }

  // ─── Context menu ────────────────────────────────────────────────

  private showContextMenu(x: number, y: number) {
    this.hideContextMenu();
    const items = [
      { label: "Copy", enabled: !!this.terminal?.getSelection(), action: () => this.copySelection() },
      { label: "Paste", enabled: this.state === "connected", action: () => this.pasteClipboard() },
    ];

    const menu = document.createElement("div");
    menu.className = "context-menu";
    for (const item of items) {
      const el = document.createElement("div");
      el.className = item.enabled ? "ctx-item" : "ctx-item ctx-disabled";
      el.textContent = item.label;
      if (item.enabled) {
        el.addEventListener("click", () => {
          this.hideContextMenu();
          item.action();
          this.terminal?.focus();
        });
      }
      menu.appendChild(el);
    }
    document.body.appendChild(menu);
    initContextMenu(menu, () => this.hideContextMenu());

    // Keep the menu on screen
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 4)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 4)}px`;
    this.ctxMenuEl = menu;

    this.ctxOutsideHandler = (e: MouseEvent) => {
      if (!this.ctxMenuEl?.contains(e.target as Node)) this.hideContextMenu();
    };
    document.addEventListener("mousedown", this.ctxOutsideHandler);
    // Capture phase so Escape closes the menu before xterm sees it
    this.ctxEscapeHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        this.hideContextMenu();
      }
    };
    document.addEventListener("keydown", this.ctxEscapeHandler, true);
  }

  private hideContextMenu() {
    this.ctxMenuEl?.remove();
    this.ctxMenuEl = null;
    if (this.ctxOutsideHandler) {
      document.removeEventListener("mousedown", this.ctxOutsideHandler);
      this.ctxOutsideHandler = null;
    }
    if (this.ctxEscapeHandler) {
      document.removeEventListener("keydown", this.ctxEscapeHandler, true);
      this.ctxEscapeHandler = null;
    }
    // Menu had focus (ARIA pattern) — return it to the terminal
    this.terminal?.focus();
  }

  mount(container: HTMLElement) {
    container.innerHTML = `
      <div class="terminal-view">
        <div class="tv-topbar" role="toolbar" aria-label="Terminal toolbar">
          <span class="tv-host-info">Connecting...</span>
          <button class="btn-text tv-timestamps-btn" aria-label="Toggle line timestamps" aria-pressed="false"></button>
          <button class="btn-text tv-suggestions-btn" aria-label="Toggle command suggestions" aria-pressed="false"></button>
          <button class="btn-text tv-autocopy-btn" aria-label="Toggle auto-copy on selection" aria-pressed="false"></button>
          <button class="btn-text tv-highlight-btn" aria-label="Toggle output highlighting" aria-pressed="false"></button>
          <button class="btn-text tv-theme-btn" aria-label="Toggle terminal theme" aria-pressed="false"></button>
          <button class="btn-text tv-panel-btn" title="Toggle side panel" aria-expanded="false" aria-controls="tv-sidebar">≡ Panel</button>
        </div>
        <div class="tv-main">
          <div class="tv-terminal-wrap">
            <div class="tv-terminal" role="region" aria-label="SSH terminal output"></div>
            <div class="tv-overlay hidden" role="dialog" aria-modal="true" aria-labelledby="tv-overlay-title">
              <div class="tv-overlay-content">
                <div class="tv-overlay-title" id="tv-overlay-title">Connecting...</div>
                <div class="tv-overlay-progress">
                  <div class="tv-progress-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-label="Connection progress"><div class="tv-progress-fill"></div></div>
                </div>
                <div class="tv-overlay-stage" aria-live="polite"></div>
                <div class="tv-overlay-error hidden" role="alert"></div>
                <div class="tv-overlay-output hidden"><pre class="tv-output-text"></pre></div>
                <div class="tv-overlay-actions">
                  <button class="btn-text tv-overlay-cancel">Cancel</button>
                </div>
              </div>
            </div>
            <div class="tv-banner hidden" role="alert">
              <span class="tv-banner-msg">Connection lost</span>
              <div class="tv-banner-actions">
                <button class="btn-primary btn-small tv-banner-reconnect">Reconnect</button>
                <button class="btn-text tv-banner-back">Back to hosts</button>
              </div>
            </div>
          </div>
          <div class="tv-sidebar hidden" id="tv-sidebar">
            <div class="sb-content">
              <p class="sb-placeholder">Select a suggestion to see command details</p>
            </div>
          </div>
        </div>
        <div class="tv-statusbar" role="status" aria-label="Connection status">
          <span class="sb-indicator sb-connecting tv-sb-dot">●</span>
          <span class="tv-sb-host">—</span>
          <span class="tv-sb-platform">—</span>
          <span class="tv-sb-mode">—</span>
        </div>
      </div>
    `;
    this.root = container.firstElementChild as HTMLElement;

    this.initTerminal();

    // Toolbar buttons are state toggles, not text entry — keep keyboard
    // focus in the terminal instead of moving it to the clicked button
    const topbar = this.$(".tv-topbar")!;
    topbar.addEventListener("mousedown", (e) => e.preventDefault());
    topbar.addEventListener("click", () => this.terminal?.focus());

    // Right-click context menu on the terminal area
    this.$(".tv-terminal-wrap")!.addEventListener("contextmenu", (e: MouseEvent) => {
      e.preventDefault();
      this.showContextMenu(e.clientX, e.clientY);
    });

    // Terminal theme toggle
    const themeBtn = this.$(".tv-theme-btn")!;
    const syncThemeIcon = () => {
      const dark = getTerminalTheme() === "dark";
      themeBtn.innerHTML = dark ? icons.sun : icons.moon;
      setToggleState(themeBtn, !dark, dark ? "Switch terminal to light theme" : "Switch terminal to dark theme");
    };
    themeBtn.addEventListener("click", () => {
      setTerminalTheme(getTerminalTheme() === "dark" ? "light" : "dark");
    });
    // Event applies theme to THIS terminal — keeps every session tab in sync
    this.themeChangeHandler = () => {
      this.applyTerminalTheme(getTerminalTheme());
      syncThemeIcon();
    };
    window.addEventListener("netssh:terminal-theme", this.themeChangeHandler);
    syncThemeIcon();

    // Line timestamps toggle
    this.$(".tv-timestamps-btn")!.addEventListener("click", () => {
      setTimestampsEnabled(!getTimestampsEnabled());
    });
    // Events apply to THIS terminal — keeps every session tab in sync
    this.timestampsChangeHandler = () => this.syncTimestamps();
    this.timestampsFormatHandler = () => this.syncTimestamps();
    window.addEventListener("netssh:timestamps", this.timestampsChangeHandler);
    window.addEventListener("netssh:timestamps-format", this.timestampsFormatHandler);

    // Command suggestions toggle (auto-show dropdown while typing)
    this.$(".tv-suggestions-btn")!.addEventListener("click", () => {
      setSuggestionsEnabled(!getSuggestionsEnabled());
    });
    this.suggestionsChangeHandler = () => this.syncSuggestions();
    window.addEventListener("netssh:suggestions", this.suggestionsChangeHandler);

    // Auto-copy on selection toggle
    this.$(".tv-autocopy-btn")!.addEventListener("click", () => {
      setAutoCopyEnabled(!getAutoCopyEnabled());
    });
    this.autoCopyChangeHandler = () => this.syncAutoCopy();
    window.addEventListener("netssh:auto-copy", this.autoCopyChangeHandler);
    this.syncAutoCopy();

    // Output highlighting toggle
    this.$(".tv-highlight-btn")!.addEventListener("click", () => {
      setOutputHighlightEnabled(!getOutputHighlightEnabled());
    });
    this.highlightChangeHandler = () => this.syncHighlight();
    window.addEventListener("netssh:output-highlight", this.highlightChangeHandler);
    this.syncHighlight();

    // Panel toggle
    this.$(".tv-panel-btn")!.addEventListener("click", () => {
      this.toggleSidebar();
    });

    // Overlay cancel
    this.$(".tv-overlay-cancel")!.addEventListener("click", () => {
      this.cancelConnect();
    });

    // Disconnect banner actions
    this.$(".tv-banner-reconnect")!.addEventListener("click", () => {
      this.reconnect();
    });
    this.$(".tv-banner-back")!.addEventListener("click", () => {
      this.onRequestCloseCb(this.host?.id ?? "");
    });

    // Window resize → fit terminal → resize PTY
    this.resizeHandler = () => {
      this.fitAddon?.fit();
    };
    window.addEventListener("resize", this.resizeHandler);

    // Prevent Ctrl+W from closing browser tab — must pass through to remote
    this.ctrlWHandler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "w" && this.state === "connected") {
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", this.ctrlWHandler);
  }

  async connect(host: Host) {
    // If we're already connected to this host, just reattach — no reconnect needed
    if (this.state === "connected" && this.host?.id === host.id) {
      log.info(LogTag.Terminal, `Reattaching to existing session for '${host.display_name}'`);
      this.hideOverlay();
      this.hideDisconnectBanner();
      this.updateHostInfo();
      this.updateStatusBar("connected");
      this.terminal?.focus();
      return;
    }

    this.host = host;
    log.info(LogTag.Terminal, `Connect flow starting for '${host.display_name}' (${host.hostname}:${host.port})`);

    // Update top bar
    this.updateHostInfo();

    // Clear stale output from previous connection attempt
    this.clearOutputBuffer();

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
        log.info(LogTag.Terminal, `Platform index loaded: ${this.platformIndex.name}, default mode: ${this.platformIndex.default_mode}`);
      } catch (e) {
        log.warn(LogTag.Terminal, `Failed to load platform index: ${e}`);
      }

      // Clean up any existing SSH listeners before registering new ones
      this.unregisterSshListeners();
      await this.registerSshListeners();

      // Determine terminal dimensions
      const cols = this.terminal?.cols ?? 80;
      const rows = this.terminal?.rows ?? 24;

      // Initiate SSH connection. Secret-ref hosts resolve credentials in the
      // backend during this await — show that stage (chunk 10).
      if (host.credential?.type === "secret_ref") {
        const name = PROVIDER_NAMES[host.credential.provider] ?? host.credential.provider;
        this.setProgress(`Resolving credentials via ${name}...`, 25);
      } else {
        this.setProgress(`Connecting to ${host.hostname}:${host.port}...`, 25);
      }

      // Generate unique session_id BEFORE sshConnect so all events are correlated correctly
      this.sessionId = mintSessionId();

      await sshConnect({
        hostId: host.id,
        cols,
        rows,
        sessionId: this.sessionId,
      });

      log.info(LogTag.Terminal, `sshConnect resolved successfully (session_id=${this.sessionId})`);
    } catch (err) {
      log.error(LogTag.Terminal, `Connection failed: ${err}`);
      this.showError(String(err));
    }
  }

  private async registerSshListeners() {
    // SSH output → xterm.js + prompt detector
    this.unlistenOutput = await listen<{ data: string; session_id: number }>("ssh-output", (event) => {
      // Ignore stale output from old connections
      if (!shouldAcceptEvent(event.payload.session_id, this.sessionId)) return;

      const bytes = this.base64ToUint8Array(event.payload.data);
      const text = new TextDecoder().decode(bytes);

      if (this.state === "connected") {
        const buf = this.terminal!.buffer.active;
        const lineBefore = buf.baseY + buf.cursorY;

        // Output highlighting — gate on "this chunk is real output". The
        // receivingOutput flag is set AFTER the write below, so the first
        // output chunk (which flips the flag) would otherwise pass through
        // raw. Use text.includes("\n") as the same output signal that sets
        // the flag, so the first chunk is highlighted too.
        const highlightOn = getOutputHighlightEnabled()
          && (this.receivingOutput || text.includes("\n"))
          && !this.promptDetector.isPassthrough
          && this.outputHighlighter !== null;

        if (highlightOn) {
          const transformed = this.outputHighlighter!.transform(text);
          this.terminal?.write(transformed, () => {
            const b = this.terminal?.buffer.active;
            if (b) this.timestampGutter?.onWrite(lineBefore, b.baseY + b.cursorY);
          });
        } else {
          this.terminal?.write(bytes, () => {
            const b = this.terminal?.buffer.active;
            if (b) this.timestampGutter?.onWrite(lineBefore, b.baseY + b.cursorY);
          });
        }
        // Prompt detector ALWAYS receives original (untransformed) text —
        // injected ANSI would corrupt prompt regex matching.
        this.promptDetector.feed(text);
      } else {
        // Connection phase — capture output for the output pane
        const cleanText = stripAnsi(text);
        this.outputBuffer.push(cleanText);
        this.renderOutputPane();
      }

      // Only suppress ghost text for real output (command results), not for
      // keystroke echoes. Newline is the reliable signal: echoes never contain
      // one, command output virtually always does. A byte-count heuristic
      // flickered on devices that echo with ANSI cursor codes.
      if (this.state === "connected" && text.includes("\n")) {
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
    this.unlistenConnected = await listen<{ reason: string; session_id: number }>("ssh-connected", (event) => {
      // Ignore connected events for other tabs' sessions — see session-filter.ts
      if (!shouldAcceptEvent(event.payload.session_id, this.sessionId)) {
        log.debug(LogTag.Terminal, `Ignoring foreign ssh-connected (session_id=${event.payload.session_id}, expected=${this.sessionId})`);
        return;
      }
      this.cleanDisconnect = false; // Reset — stale disconnects before this are ignored
      this.connectedAtLeastOnce = true;
      log.info(LogTag.Terminal, `SSH connected event received (session_id=${this.sessionId})`);
      this.setState("connected");
      // Update last_connected timestamp
      if (this.host) {
        touchHost(this.host.id).catch(() => {});
      }
      this.hideOverlay();
      this.terminal?.focus();
      this.updateStatusBar("connected");
      this.updateModeDisplay(this.currentMode);

      // Initialize ghost text overlay, dropdown, and sidebar content
      const termContainer = this.$(".tv-terminal")!;
      if (this.terminal) {
        this.ghostText?.destroy();
        this.dropdown?.destroy();
        this.ghostText = new GhostText(this.terminal, termContainer);
        this.dropdown = new Dropdown(termContainer, (cmd, payload) => {
          // On dropdown accept: send the ghost remainder (current token
          // completion), not the full command name. Phase 3 token-aware.
          const text = payload
            ? ghostPayloadAcceptText(payload)
            : this.getCommandRemainder(cmd.name, this.currentInput);
          if (text) {
            this.sendData(text);
            this.shadowBuffer.reset();
          }
          this.ghostText?.hide();
        });
        this.sidebarContent = new SidebarContent();
        // Output highlighter — per-host profile ("auto" → use platform)
        const hlProfile = this.host?.highlight_profile;
        const hlPlatform = hlProfile && hlProfile !== "auto"
          ? hlProfile
          : this.host?.platform ?? "linux-bash";
        if (hlPlatform === "none") {
          this.outputHighlighter = null;
        } else {
          this.outputHighlighter = new OutputHighlighter(hlPlatform);
        }
        // Update toolbar button state (disabled when profile is "none")
        this.syncHighlight();
      }

      // Load KB commands into frontend suggestion engine
      if (this.host) {
        this.loadKbCommands(this.host.platform, this.host.os_version ?? null, this.platformIndex?.negation_prefix ?? null);
      }
    });

    // SSH disconnected — session ended (user typed exit, server closed, timeout, etc.)
    this.unlistenDisconnected = await listen<{ reason: string; session_id: number }>("ssh-disconnected", (event) => {
      // Ignore stale disconnect events from old connections
      if (!shouldAcceptEvent(event.payload.session_id, this.sessionId)) {
        log.debug(LogTag.Terminal, `Ignoring stale ssh-disconnected (session_id=${event.payload.session_id}, expected=${this.sessionId})`);
        return;
      }

      this.clearOutputBuffer();
      log.info(LogTag.Terminal, `SSH disconnected event: ${event.payload.reason}`);
      if (this.cleanDisconnect) return; // User initiated — handled elsewhere
      if (!this.connectedAtLeastOnce) {
        // Session died before (or just as) it reached "connected" — treat as a
        // failed connect, not a dropped session. Bouncing to the host list here
        // is what made the first connect flash "connecting" then vanish.
        log.warn(LogTag.Terminal, `Ignoring ssh-disconnected before ever connected: ${event.payload.reason}`);
        this.showError(`Connection dropped during setup (${event.payload.reason})`);
        return;
      }

      const wasConnected = this.state === "connected";
      this.setState("disconnected");

      // "connection_lost" = TCP dropped / keepalive failed (network blip,
      // VPN flap, server reboot). Show the reconnect banner so the user can
      // get back in without navigating to the host list.
      //
      // "channel_closed" / "channel_eof" = the remote end closed the channel
      // (user typed `exit`, server shutdown, admin reset). Treat as a clean
      // session end — bounce to host list or clean up the green dot.
      const reason = event.payload.reason;
      const isConnectionLost = reason === "connection_lost";

      if (wasConnected && this.host && isConnectionLost) {
        // Unexpected network drop — show reconnect banner in the terminal
        this.showDisconnectBanner(reason);
        this.updateStatusBar("disconnected");
        // Notify the app that the session died (green dot) but DON'T close
        // the terminal — the user stays on this tab and can reconnect.
        this.onSessionDiedCb(this.host.id);
      } else if (wasConnected && this.host) {
        // Clean session end (exit / channel closed / EOF)
        const wrapper = this.terminal?.element?.closest(".app-view") as HTMLElement | null;
        const terminalVisible = wrapper && wrapper.style.display !== "none";

        if (terminalVisible) {
          // User was looking at the terminal — close it and return to host list
          this.onDisconnectCb(this.host.id);
        } else {
          // User was in host list — silently clean up green dot
          this.onSessionDiedCb(this.host.id);
        }
      }
    });

    // SSH error
    this.unlistenError = await listen<{ reason: string; session_id: number }>("ssh-error", (event) => {
      // Ignore stale error events from old connections
      if (!shouldAcceptEvent(event.payload.session_id, this.sessionId)) return;
      log.error(LogTag.Terminal, `SSH error event: ${event.payload.reason}`);
      this.showError(event.payload.reason);
    });

    // TOFU: new host key accepted (visibility only, no dialog)
    this.unlistenTofu = await listen<{ reason: string; session_id: number }>("ssh-tofu", (event) => {
      if (!shouldAcceptEvent(event.payload.session_id, this.sessionId)) return;
      log.info(LogTag.Terminal, event.payload.reason);
    });

    // Auth URL: browser-auth gateway detected — browser already opened in backend
    this.unlistenAuthUrl = await listen<{ url: string; session_id: number }>("ssh-auth-url", (event) => {
      if (!shouldAcceptEvent(event.payload.session_id, this.sessionId)) return;
      const url = event.payload.url;
      log.info(LogTag.Terminal, `Auth URL opened in browser: ${url}`);
      // Update overlay stage text
      const stageEl = this.$(".tv-overlay-stage");
      if (stageEl) {
        stageEl.textContent = `Authentication required — opened ${url} in browser`;
      }
      // Add "Open again" button next to Cancel
      const actionsEl = this.$(".tv-overlay-actions");
      if (actionsEl) {
        const openBtn = document.createElement("button");
        openBtn.className = "btn-text";
        openBtn.textContent = "Open again";
        openBtn.addEventListener("click", () => openUrl(url));
        actionsEl.insertBefore(openBtn, actionsEl.firstChild);
      }
    });
  }

  private unregisterSshListeners() {
    this.unlistenOutput?.();
    this.unlistenConnected?.();
    this.unlistenDisconnected?.();
    this.unlistenError?.();
    this.unlistenTofu?.();
    this.unlistenAuthUrl?.();
    this.unlistenOutput = null;
    this.unlistenConnected = null;
    this.unlistenDisconnected = null;
    this.unlistenError = null;
    this.unlistenTofu = null;
    this.unlistenAuthUrl = null;
  }

  // ─── Overlay / Banner UI ─────────────────────────────────────────

  private setState(state: ConnectionState) {
    this.state = state;
  }

  private setProgress(stage: string, percent: number) {
    this.progress.stage = stage;
    const overlay = this.$(".tv-overlay");
    const stageEl = this.$(".tv-overlay-stage");
    const fillEl = this.$(".tv-progress-fill");
    const errorEl = this.$(".tv-overlay-error");
    const actionsEl = this.$(".tv-overlay-actions");
    const titleEl = this.$(".tv-overlay-title");

    overlay?.classList.remove("hidden");
    if (stageEl) stageEl.textContent = stage;
    if (fillEl) fillEl.style.width = `${percent}%`;
    this.$(".tv-progress-bar")?.setAttribute("aria-valuenow", String(percent));
    if (titleEl) titleEl.textContent = `Connecting to ${this.host?.display_name ?? "host"}`;
    errorEl?.classList.add("hidden");
    // Replaces action buttons; does NOT affect sibling elements like .tv-overlay-output
    if (actionsEl) {
      actionsEl.innerHTML = `<button class="btn-text tv-overlay-cancel">Cancel</button>`;
      this.$(".tv-overlay-cancel")?.addEventListener("click", () => this.cancelConnect());
    }
  }

  private showError(message: string) {
    this.setState("error");
    const overlay = this.$(".tv-overlay");
    const stageEl = this.$(".tv-overlay-stage");
    const fillEl = this.$(".tv-progress-fill");
    const errorEl = this.$(".tv-overlay-error");
    const actionsEl = this.$(".tv-overlay-actions");
    const titleEl = this.$(".tv-overlay-title");

    overlay?.classList.remove("hidden");
    if (titleEl) titleEl.textContent = "Connection Failed";
    if (stageEl) stageEl.textContent = "";
    if (fillEl) fillEl.style.width = "0%";
    if (errorEl) {
      errorEl.textContent = message;
      errorEl.classList.remove("hidden");
    }
    // Show output pane if buffer has content (preserve for debugging),
    // hide it otherwise so stale data doesn't persist on next connect.
    const outputPane = this.$(".tv-overlay-output");
    if (outputPane) {
      if (this.outputBuffer.length > 0) {
        outputPane.classList.remove("hidden");
      } else {
        outputPane.classList.add("hidden");
      }
    }
    if (actionsEl) {
      actionsEl.innerHTML = `
        <button class="btn-primary btn-small tv-overlay-retry">Retry</button>
        <button class="btn-text tv-overlay-back">Back to hosts</button>
      `;
      this.$(".tv-overlay-retry")?.addEventListener("click", () => this.reconnect());
      this.$(".tv-overlay-back")?.addEventListener("click", () => this.disconnect());
    }
    this.updateStatusBar("error");
  }

  private hideOverlay() {
    this.$(".tv-overlay")?.classList.add("hidden");
  }

  private showDisconnectBanner(reason: string) {
    const banner = this.$(".tv-banner");
    const msgEl = this.$(".tv-banner-msg");
    banner?.classList.remove("hidden");
    if (msgEl) {
      const reasonText = reason === "connection_lost"
        ? "Connection lost — network dropped or server unreachable"
        : reason === "channel_closed" ? "Session ended"
        : reason === "channel_eof" ? "Remote closed connection"
        : "Connection lost";
      msgEl.textContent = reasonText;
    }
    this.updateStatusBar("disconnected");
  }

  private hideDisconnectBanner() {
    this.$(".tv-banner")?.classList.add("hidden");
  }

  // ─── Status bar ──────────────────────────────────────────────────

  private updateHostInfo() {
    const infoEl = this.$(".tv-host-info");
    if (infoEl && this.host) {
      const platformLabel = PLATFORM_LABELS[this.host.platform] ?? this.host.platform;
      const version = this.host.os_version ? ` ${this.host.os_version}` : "";
      infoEl.textContent = `${this.host.display_name} (${platformLabel}${version})`;
    }
  }

  private updateStatusBar(status: "connecting" | "connected" | "disconnected" | "error") {
    const dot = this.$(".tv-sb-dot");
    const hostEl = this.$(".tv-sb-host");
    const platformEl = this.$(".tv-sb-platform");

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

  /**
   * Full disconnect — terminate SSH session and clean up.
   * Called on Ctrl+Shift+W or programmatic disconnect.
   */
  async disconnect() {
    log.info(LogTag.Terminal, "Full disconnect requested");
    this.cleanDisconnect = true;
    const hostId = this.host?.id ?? "";
    if (this.sessionId) {
      try {
        await sshDisconnect(this.sessionId);
      } catch {
        // Already disconnected or no session
      }
    }
    this.cleanup();
    this.onDisconnectCb(hostId);
  }

  private async cancelConnect() {
    this.clearOutputBuffer();
    this.cleanDisconnect = true;
    const hostId = this.host?.id ?? "";
    if (this.sessionId) {
      try {
        await sshDisconnect(this.sessionId);
      } catch {
        // Ignore
      }
    }
    this.cleanup();
    this.onDisconnectCb(hostId);
  }

  private async reconnect() {
    this.clearOutputBuffer();
    if (!this.host) return;
    this.hideOverlay();
    this.hideDisconnectBanner();
    this.unregisterSshListeners();
    this.terminal?.clear();
    this.timestampGutter?.reset();
    // Show "reconnecting" state in the status bar while the new connection
    // is being established. The ssh-connected listener will flip it back
    // to "connected" on success; ssh-error will show the error overlay.
    this.updateStatusBar("connecting");
    await this.connect(this.host);
  }

  private toggleSidebar() {
    this.sidePanelOpen = !this.sidePanelOpen;
    const sidebar = this.$(".tv-sidebar")!;
    sidebar.classList.toggle("hidden", !this.sidePanelOpen);
    this.$(".tv-panel-btn")?.setAttribute("aria-expanded", String(this.sidePanelOpen));
    // Refit terminal after sidebar transition
    setTimeout(() => {
      this.fitAddon?.fit();
      this.ghostText?.reposition();
    }, 250);
  }

  // ─── Mode display ────────────────────────────────────────────────

  private updateModeDisplay(mode: string) {
    const modeEl = this.$(".tv-sb-mode");
    if (modeEl) {
      modeEl.textContent = mode ? formatMode(mode) : "—";
    }

    // Apply ambient chrome tint based on platform/mode
    this.applyChromeTint();
  }

  /** Re-assert this view's chrome tint (called by App on tab activation). */
  applyChromeTint() {
    const tint = MODE_TINTS[this.currentMode] ?? MODE_TINTS[this.host?.platform ?? ""] ?? "transparent";
    document.documentElement.style.setProperty("--chrome-tint", tint);
  }

  // ─── KB loading ──────────────────────────────────────────────────

  private async loadKbCommands(platform: string, version: string | null, negationPrefix?: string | null) {
    try {
      log.info(LogTag.Kb, `Loading commands for platform=${platform}, version=${version}`);
      const commands = await queryKb("", platform, null, version);
      log.info(LogTag.Kb, `queryKb returned ${commands.length} commands`);
      this.suggestionEngine.loadCommands(commands, platform, negationPrefix);
      log.info(LogTag.Terminal, `Loaded ${commands.length} commands for ${platform}`);
    } catch (e) {
      log.warn(LogTag.Terminal, `Failed to load KB commands: ${e}`);
    }
    void refreshValidation(platform);
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
    log.debug(LogTag.Suggest, `query('${text}') mode='${this.currentMode}' → ${results.length} results`);

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
    this.applyTopMatch(top, text, results.length - 1);

    // Auto-show dropdown when enabled; keep in sync while open
    if (this.suggestionsEnabled) {
      if (this.dropdown?.isVisible()) {
        this.dropdown.updateResults(results);
      } else {
        this.openDropdown(results);
      }
    } else if (this.dropdown?.isVisible()) {
      this.dropdown.hide();
    }

    // Update sidebar with top match detail
    this.updateSidebarDetail(top.command);
  }

  /**
   * Build ghost text for the top result. Token-aware commands render the
   * next expected token (Phase 3); legacy commands and name-prefix matches
   * render the name remainder.
   */
  private applyTopMatch(top: SuggestionResult, input: string, extraMatchCount: number) {
    const payload = this.ghostPayloadForTop(top, input);
    if (payload && this.terminal) {
      this.ghostText?.showPayload(payload, extraMatchCount);
    } else {
      this.ghostText?.hide();
    }
  }

  /**
   * Build a ghost payload for the top result. Token match → token payload;
   * name/alias match → text remainder (legacy).
   */
  private ghostPayloadForTop(
    top: SuggestionResult,
    input: string,
  ): GhostPayload | null {
    if (top.matchType === "token" && top.tokenMatch) {
      const payload = ghostPayloadFor(top.tokenMatch, top.command);
      if (payload) return payload;
      // Token match with no renderable payload (e.g. past all tokens) — fall
      // back to name remainder so something is still shown.
    }
    const remainder = this.getCommandRemainder(top.command.name, input);
    return remainder ? { kind: "text", text: remainder } : null;
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
      this.applyTopMatch(selected, this.currentInput, 0);
    }
  }

  /**
   * Accept the dropdown's current selection. Token-aware: the dropdown
   * provides the ghost payload to send; for legacy matches we send the name
   * remainder.
   */
  private acceptDropdownSelection() {
    const selected = this.dropdown?.getSelected();
    if (!selected) return;
    const payload = this.dropdown?.getSelectedPayload() ?? this.ghostPayloadForTop(selected, this.currentInput);
    const text = payload ? ghostPayloadAcceptText(payload) : this.getCommandRemainder(selected.command.name, this.currentInput);
    if (text) {
      this.sendData(text);
      this.shadowBuffer.reset();
    }
    this.dropdown?.hide();
    this.ghostText?.hide();
  }

  private openDropdown(results: SuggestionResult[]) {
    if (!this.dropdown && this.terminal) {
      const termContainer = this.$(".tv-terminal")!;
      this.dropdown = new Dropdown(termContainer, (cmd, payload) => {
        const text = payload
          ? ghostPayloadAcceptText(payload)
          : this.getCommandRemainder(cmd.name, this.currentInput);
        if (text) {
          this.sendData(text);
          this.shadowBuffer.reset();
        }
        this.ghostText?.hide();
      });
    }
    this.dropdown?.show(results, this.currentInput);
    this.syncDropdownToGhostText();
  }

  // ─── Sidebar content ─────────────────────────────────────────────

  private updateSidebarDetail(command: Command) {
    const content = this.$(".sb-content");
    if (!content || !this.sidePanelOpen) return;
    if (!this.sidebarContent) this.sidebarContent = new SidebarContent();
    content.innerHTML = this.sidebarContent.render(command, this.platformIndex?.reference_url ?? null);
    // Wire clickable examples
    content.querySelectorAll(".example-item").forEach((el) => {
      el.addEventListener("click", () => {
        const cmd = (el as HTMLElement).dataset.command;
        if (cmd && this.state === "connected") {
          this.sendData(cmd + "\r");
          this.terminal?.focus();
        }
      });
    });
  }

  private updateSidebarPlaceholder() {
    const content = this.$(".sb-content");
    if (!content || !this.sidePanelOpen) return;
    content.innerHTML = `<p class="sb-placeholder">Start typing to see suggestions</p>`;
  }

  // ─── Line timestamps ─────────────────────────────────────────────

  /**
   * Container font-size drives the ch-based gutter width; background keeps
   * the gutter seamless when terminal theme differs from app theme.
   */
  private syncTerminalChrome() {
    const container = this.$(".tv-terminal");
    if (!container) return;
    container.style.fontSize = `${this.fontSize}px`;
    const bg = TERMINAL_THEMES[getTerminalTheme()].background;
    if (bg) container.style.backgroundColor = bg;
  }

  private syncTimestamps() {
    const on = getTimestampsEnabled();
    const format = getTimestampFormat();
    const container = this.$(".tv-terminal");
    container?.classList.toggle("timestamps-on", on);
    if (container) container.dataset.tsFormat = format;
    this.timestampGutter?.applyFormat(format);
    const btn = this.$(".tv-timestamps-btn");
    if (btn) {
      btn.innerHTML = icons.clock;
      btn.classList.toggle("active", on);
      setToggleState(btn, on, on ? "Hide line timestamps" : "Show line timestamps");
    }
    this.fitAddon?.fit();
  }

  private syncSuggestions() {
    this.suggestionsEnabled = getSuggestionsEnabled();
    const btn = this.$(".tv-suggestions-btn");
    if (btn) {
      btn.innerHTML = icons.lightbulb;
      btn.classList.toggle("active", this.suggestionsEnabled);
      setToggleState(btn, this.suggestionsEnabled, this.suggestionsEnabled ? "Disable command suggestions" : "Enable command suggestions");
    }
    if (!this.suggestionsEnabled) {
      this.dropdown?.hide();
      return;
    }
    if (this.currentInput && !this.receivingOutput && this.state === "connected") {
      const results = this.suggestionEngine.query(this.currentInput);
      if (results.length > 0) this.openDropdown(results);
    }
  }

  private syncAutoCopy() {
    const on = getAutoCopyEnabled();
    const btn = this.$(".tv-autocopy-btn");
    if (btn) {
      btn.innerHTML = icons.copy;
      btn.classList.toggle("active", on);
      setToggleState(btn, on, on ? "Disable auto-copy on selection" : "Enable auto-copy on selection");
    }
  }

  private syncHighlight() {
    const on = getOutputHighlightEnabled();
    const btn = this.$<HTMLButtonElement>(".tv-highlight-btn");
    if (btn) {
      btn.innerHTML = icons.paintbrush;
      // Disable when no highlighter is active (host profile = "none" or
      // highlighter not yet initialized). Prevents toggling a no-op.
      const disabled = this.outputHighlighter === null;
      btn.disabled = disabled;
      btn.classList.toggle("btn-disabled", disabled);
      btn.classList.toggle("active", on && !disabled);
      if (disabled) {
        setToggleState(btn, false, "Output highlighting disabled for this host");
      } else {
        setToggleState(btn, on, on ? "Disable output highlighting" : "Enable output highlighting");
      }
    }
  }

  // ─── Zoom ────────────────────────────────────────────────────────

  applyTerminalTheme(t: TerminalTheme) {
    if (this.terminal) this.terminal.options.theme = TERMINAL_THEMES[t];
    this.syncTerminalChrome();
  }

  fit() {
    this.fitAddon?.fit();
  }

  focus() {
    this.terminal?.focus();
  }

  zoomIn() {
    if (!this.terminal) return;
    this.fontSize = Math.min(this.fontSize + 2, 32);
    this.terminal.options.fontSize = this.fontSize;
    this.syncTerminalChrome();
    this.fitAddon?.fit();
  }

  zoomOut() {
    if (!this.terminal) return;
    this.fontSize = Math.max(this.fontSize - 2, 8);
    this.terminal.options.fontSize = this.fontSize;
    this.syncTerminalChrome();
    this.fitAddon?.fit();
  }

  zoomReset() {
    if (!this.terminal) return;
    this.fontSize = 14;
    this.terminal.options.fontSize = this.fontSize;
    this.syncTerminalChrome();
    this.fitAddon?.fit();
  }

  // ─── Cleanup ─────────────────────────────────────────────────────

  private cleanup() {
    this.hideContextMenu();
    this.unregisterSshListeners();

    if (this.resizeHandler) {
      window.removeEventListener("resize", this.resizeHandler);
      this.resizeHandler = null;
    }
    if (this.ctrlWHandler) {
      window.removeEventListener("keydown", this.ctrlWHandler);
      this.ctrlWHandler = null;
    }
    if (this.themeChangeHandler) {
      window.removeEventListener("netssh:terminal-theme", this.themeChangeHandler);
      this.themeChangeHandler = null;
    }
    if (this.timestampsChangeHandler) {
      window.removeEventListener("netssh:timestamps", this.timestampsChangeHandler);
      this.timestampsChangeHandler = null;
    }
    if (this.timestampsFormatHandler) {
      window.removeEventListener("netssh:timestamps-format", this.timestampsFormatHandler);
      this.timestampsFormatHandler = null;
    }
    if (this.suggestionsChangeHandler) {
      window.removeEventListener("netssh:suggestions", this.suggestionsChangeHandler);
      this.suggestionsChangeHandler = null;
    }
    if (this.autoCopyChangeHandler) {
      window.removeEventListener("netssh:auto-copy", this.autoCopyChangeHandler);
      this.autoCopyChangeHandler = null;
    }
    if (this.highlightChangeHandler) {
      window.removeEventListener("netssh:output-highlight", this.highlightChangeHandler);
      this.highlightChangeHandler = null;
    }

    this.timestampGutter?.dispose();
    this.timestampGutter = null;
    this.ghostText?.destroy();
    this.ghostText = null;
    this.dropdown?.destroy();
    this.dropdown = null;
    this.outputHighlighter = null;
    this.sidebarContent = null;
    this.platformIndex = null;
    if (this.suggestionDebounceTimer) clearTimeout(this.suggestionDebounceTimer);
    if (this.outputTimer) clearTimeout(this.outputTimer);

    this.terminal?.dispose();
    this.terminal = null;
    this.fitAddon = null;
    this.host = null;
    this.state = "idle";
    this.connectedAtLeastOnce = false;
  }

  // ─── Output pane ─────────────────────────────────────────────────

  private renderOutputPane(): void {
    const outputEl = this.$(".tv-overlay-output");
    const textEl = this.$(".tv-output-text");
    if (!outputEl || !textEl) return;
    outputEl.classList.remove("hidden");
    textEl.textContent = this.outputBuffer.join("");
    outputEl.scrollTop = outputEl.scrollHeight;
  }

  /** Empties the output buffer and hides the output pane overlay. */
  clearOutputBuffer(): void {
    this.outputBuffer = [];
    const outputEl = this.$(".tv-overlay-output");
    if (outputEl) {
      outputEl.classList.add("hidden");
    }
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
