/**
 * Terminal View — active SSH session
 * Terminal (xterm.js) + inline suggestions + side panel
 * Wires xterm.js to SSH data stream via Tauri events.
 */

import { Terminal } from "@xterm/xterm";
import { TERMINAL_THEMES, getTerminalTheme, setTerminalTheme, TerminalTheme } from "../lib/theme";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon, ISearchDecorationOptions } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import {
  Host,
  sshSend,
  sshResize,
  touchHost,
  loadPlatformIndex,
  queryKb,
  openUrl,
  PlatformIndex,
  Command,
  ReplayCommand,
  replayList,
} from "../lib/tauri-api";
import { ReplaySaveDialog } from "./replay-save-dialog";
import { substitute, renderReplayTemplate } from "../lib/replay";
import { escHtml } from "../lib/format";
import { log, LogTag } from "../lib/logger";
import { PromptDetector } from "../lib/prompt-detector";
import { SuggestionController } from "../lib/suggestion-controller";
import { Dropdown } from "../lib/dropdown";
import {
  routeKeystroke,
  S_ACCEPT_GHOST,
  S_ACCEPT_NEXTWORD,
  S_ACCEPT_DROPDOWN,
  type RouteResult,
} from "../lib/keystroke-router";
import { GhostText } from "../lib/ghost-text";
import { SidebarContent } from "../lib/sidebar-content";
import { refreshValidation } from "../lib/validation-cache";
import { stripAnsi } from "../lib/ansi";
import { formatMode } from "../lib/format";
import { SessionChannel, TauriTransport, type SessionEvent } from "../lib/session-channel";
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
import { getPlatformMeta } from "../lib/platforms";

// Secret provider display names (connect progress, chunk 10)
const PROVIDER_NAMES: Record<string, string> = { proton: "Proton Pass" };

// Scrollback search highlight colors — xterm requires opaque #RRGGBB.
function accentWithAlpha(color: string, alpha: number): string {
  const c = color.trim() || "#22C55E";
  let r = 0, g = 0, b = 0;
  if (c.startsWith("#")) {
    let h = c.slice(1);
    if (h.length === 3) h = h.split("").map((x) => x + x).join("");
    r = parseInt(h.slice(0, 2), 16);
    g = parseInt(h.slice(2, 4), 16);
    b = parseInt(h.slice(4, 6), 16);
  } else {
    const m = c.match(/\d+/g);
    if (m && m.length >= 3) { r = +m[0]; g = +m[1]; b = +m[2]; }
  }
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Tinted from the active theme's --color-accent so highlights echo the theme.
function getSearchDecorations(): ISearchDecorationOptions {
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--color-accent");
  return {
    matchBackground: accentWithAlpha(accent, 0.3),
    activeMatchBackground: accentWithAlpha(accent, 0.6),
    matchOverviewRuler: accentWithAlpha(accent, 0.7),
    activeMatchColorOverviewRuler: accentWithAlpha(accent, 1),
  };
}

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

interface ConnectProgress {
  stage: string;
  error?: string;
}

export class TerminalView {
  private root: HTMLElement | null = null;
  private terminal: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private searchAddon: SearchAddon | null = null;
  private searchBarOpen = false;
  private lastSearchDir = 1;
  private onDetachCb: () => void;
  private onDisconnectCb: (hostId: string) => void;
  private onSessionDiedCb: (hostId: string) => void;
  private onRequestCloseCb: (hostId: string) => void;
  private sidePanelOpen = false;
  private sidePanelMode: "kb" | "replay" = "kb";
  private replayItems: ReplayCommand[] = [];
  private sidebarResizing = false;
  private sidebarResizeRaf = 0;
  private host: Host | null = null;
  private channel: SessionChannel;
  private progress: ConnectProgress = { stage: "" };

  // Prompt detection & suggestion pipeline (controller owns buffer/engine)
  private promptDetector: PromptDetector;
  private controller: SuggestionController;
  private ghostText: GhostText | null = null;
  private dropdown: Dropdown | null = null;
  private sidebarContent: SidebarContent | null = null;
  private platformIndex: PlatformIndex | null = null;
  private currentMode = "";
  private outputBuffer: string[] = [];
  private fontSize = 14;

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
    this.channel = new SessionChannel(new TauriTransport());
    this.channel.on((e) => this.handleSessionEvent(e));
    this.controller = new SuggestionController({
      send: (data) => this.sendData(data),
      ghost: () => this.ghostText,
      dropdown: () => this.dropdown,
      sidebar: {
        detail: (cmd) => this.updateSidebarDetail(cmd),
        placeholder: () => this.updateSidebarPlaceholder(),
      },
    });
    this.promptDetector = new PromptDetector(
      (mode) => {
        this.currentMode = mode;
        this.controller.setMode(mode);
        this.updateModeDisplay(mode);
        log.info(LogTag.Prompt, `Mode changed: ${mode}`);
      },
      () => {
        this.controller.onPromptDetected();
      },
    );
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

    // Scrollback search — per-terminal instance, highlights matches + reports count
    this.searchAddon = new SearchAddon();
    this.terminal.loadAddon(this.searchAddon);
    this.searchAddon.onDidChangeResults(({ resultCount }) => {
      const el = this.$(".tv-search-count");
      if (el) el.textContent = String(resultCount);
    });

    const termContainer = this.$(".tv-terminal")!;
    this.terminal.open(termContainer);
    this.timestampGutter = new TimestampGutter(this.terminal);
    this.syncTerminalChrome();
    this.syncTimestamps();
    this.syncSuggestions();
    this.fitAddon.fit();

    // Ghost text is anchored to the cursor — reposition on buffer scroll.
    // Dropdown is transient: hide it on scroll (PSReadLine ListView model).
    this.terminal.onScroll(() => this.ghostText?.reposition());
    const viewport = termContainer.querySelector(".xterm-viewport");
    viewport?.addEventListener("scroll", () => {
      this.ghostText?.reposition();
      this.dropdown?.hide();
    });

    // xterm.js resize event → send PTY resize to remote
    this.terminal.onResize(({ cols, rows }) => {
      if (this.sidebarResizing) return;
      if (this.channel.state === "connected" && this.channel.sessionId) {
        sshResize(this.channel.sessionId, cols, rows).catch(() => {});
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

      // Ctrl+Shift+F → open scrollback search (local UI shortcut, never remote)
      if (e.ctrlKey && e.shiftKey && e.key.toUpperCase() === "F" && e.type === "keydown") {
        e.preventDefault();
        this.openSearch();
        return false;
      }

      return true; // let all other keys through
    });

    // Wire keystroke input → SSH + shadow buffer (shadow buffer model: no local echo)
    this.terminal.onData((data) => {
      // Pure routing decision (keystroke-router.ts), then resolve + apply here.
      const r = routeKeystroke(data, {
        connected: this.channel.state === "connected",
        dropdownVisible: this.dropdown?.isVisible() ?? false,
        ghostShowing: this.ghostText?.isShowing() ?? false,
        sidebarOpen: this.sidePanelOpen,
      });
      this.applyRoute(data, r);
    });
  }

  /** Send data to the current session (no-op when not connected). */
  private sendData(data: string) {
    if (this.channel.state === "connected" && this.channel.sessionId) {
      sshSend(this.channel.sessionId, data).catch(() => {});
    }
  }

  /**
   * Resolve a RouteResult against the live widgets and forward/apply it.
   * Sentinels in `send` carry state only the widget knows (ghost remainder,
   * next word, dropdown payload), so they're resolved here, not in the router.
   */
  private applyRoute(data: string, r: RouteResult) {
    for (const s of r.send) {
      if (s === S_ACCEPT_DROPDOWN) {
        this.controller.acceptDropdownSelection();
      } else if (s === S_ACCEPT_GHOST) {
        const rem = this.ghostText?.getCurrentRemainder();
        if (rem) {
          this.sendData(rem);
          this.controller.reset();
        }
        this.ghostText?.hide();
      } else if (s === S_ACCEPT_NEXTWORD) {
        const word = this.ghostText?.isShowing() ? this.ghostText.acceptNextWord() : null;
        if (word) {
          this.sendData(word);
          for (const ch of word) this.controller.buffer.append(ch);
        } else {
          this.sendData(data);
        }
      } else {
        this.sendData(s);
      }
    }

    for (const op of r.shadowOps) {
      if (op.op === "append") this.controller.buffer.append(op.ch);
      else if (op.op === "backspace") this.controller.buffer.backspace();
      else if (op.op === "reset") this.controller.reset();
    }

    if (r.markCursorMoved) this.controller.markCursorMoved();
    if (r.hideGhost) this.ghostText?.hide();
    if (r.hideDropdown) this.dropdown?.hide();
    if (r.dismissSidebar) this.toggleSidebar();
    if (r.toggleSuggestions) setSuggestionsEnabled(!getSuggestionsEnabled());
    if (r.moveDropdown === "up") this.dropdown?.moveUp();
    else if (r.moveDropdown === "down") this.dropdown?.moveDown();
    if (r.rebuildGhost) this.controller.syncDropdownToGhostText();
  }

  // ─── Clipboard ───────────────────────────────────────────────────

  /** Copy terminal selection to clipboard (no-op without a selection). */
  private copySelection() {
    const selection = this.terminal?.getSelection();
    if (!selection) return;
    navigator.clipboard.writeText(selection);
    this.terminal?.clearSelection();
  }

  /** Open the save dialog with the current terminal selection. */
  private addSelectionToReplay() {
    const selection = this.terminal?.getSelection();
    if (!selection) return;
    this.terminal?.clearSelection();
    new ReplaySaveDialog(selection, this.host?.platform ?? "linux-bash", () => {
      if (this.sidePanelMode === "replay" && this.sidePanelOpen) void this.showReplayPanel();
    }).open();
  }

  /** Read clipboard and send it to the remote session + shadow buffer. */
  private pasteClipboard() {
    navigator.clipboard.readText().then((text) => {
      if (text && this.channel.state === "connected" && this.channel.sessionId) {
        sshSend(this.channel.sessionId, text).catch(() => {});
        this.controller.buffer.appendAll(text);
      }
    });
  }

  // ─── Context menu ────────────────────────────────────────────────

  private showContextMenu(x: number, y: number) {
    this.hideContextMenu();
    const items = [
      { label: "Copy", enabled: !!this.terminal?.getSelection(), action: () => this.copySelection() },
      { label: "Paste", enabled: this.channel.state === "connected", action: () => this.pasteClipboard() },
      {
        label: "Add to Command Replay",
        enabled: !!this.terminal?.getSelection(),
        action: () => this.addSelectionToReplay(),
      },
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

  private openSearch() {
    const bar = this.$(".tv-search-bar");
    if (!bar) return;
    bar.classList.remove("hidden");
    this.searchBarOpen = true;
    const btn = this.$(".tv-search-btn")!;
    btn.setAttribute("aria-expanded", "true");
    setToggleState(btn, true, "Close scrollback search");
    const input = this.$(".tv-search-input") as HTMLInputElement;
    input.focus();
    input.select();
  }

  private closeSearch() {
    const bar = this.$(".tv-search-bar");
    if (!bar) return;
    bar.classList.add("hidden");
    this.searchBarOpen = false;
    const btn = this.$(".tv-search-btn")!;
    btn.setAttribute("aria-expanded", "false");
    setToggleState(btn, false, "Search scrollback");
    this.searchAddon?.clearDecorations();
    const input = this.$(".tv-search-input") as HTMLInputElement;
    input.value = "";
    const c = this.$(".tv-search-count"); if (c) c.textContent = "0";
    this.terminal?.focus();
  }

  private doSearch(direction: number) {
    const input = this.$(".tv-search-input") as HTMLInputElement | null;
    if (!input || !this.searchAddon) return;
    const term = input.value;
    if (!term) return;
    this.lastSearchDir = direction;
    const opts = { ...getSearchDecorations(), incremental: true };
    if (direction < 0) this.searchAddon.findPrevious(term, opts);
    else this.searchAddon.findNext(term, opts);
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
          <button class="btn-text tv-search-btn" aria-label="Search scrollback" aria-expanded="false" aria-controls="tv-search-bar"></button>
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
            <div class="tv-search-bar hidden" id="tv-search-bar" role="search">
              <input type="text" class="tv-search-input" placeholder="Search scrollback…" aria-label="Search scrollback" autocomplete="off" spellcheck="false" />
              <span class="tv-search-count" aria-live="polite">0</span>
              <button class="btn-text tv-search-prev" aria-label="Previous match"></button>
              <button class="btn-text tv-search-next" aria-label="Next match"></button>
              <button class="btn-text tv-search-close" aria-label="Close search"></button>
            </div>
          </div>
          <div
            class="tv-resizer hidden"
            id="tv-sidebar-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-controls="tv-sidebar"
            aria-label="Resize side panel"
            tabindex="0"
            title="Drag to resize side panel"
          ></div>
          <div class="tv-sidebar hidden" id="tv-sidebar">
            <div class="sb-toggle" role="tablist" aria-label="Panel content">
              <button class="sb-toggle-btn sb-toggle-kb active" role="tab" aria-selected="true">Knowledge Base</button>
              <button class="sb-toggle-btn sb-toggle-replay" role="tab" aria-selected="false">Command Replay</button>
            </div>
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
      if ((e.target as HTMLElement).closest?.(".tv-search-bar")) return; // native menu in search input
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
    this.initSidebarResize();
    this.initSidebarToggle();

    // Scrollback search (toolbar button + Ctrl+Shift+F)
    const searchBtn = this.$(".tv-search-btn")!;
    searchBtn.innerHTML = icons.search;
    searchBtn.addEventListener("mousedown", (e) => e.stopPropagation());
    searchBtn.addEventListener("click", (e) => {
      e.stopPropagation(); // don't let topbar click → terminal.focus() steal input focus
      this.searchBarOpen ? this.closeSearch() : this.openSearch();
    });
    const searchInput = this.$(".tv-search-input") as HTMLInputElement;
    searchInput.addEventListener("input", () => {
      if (!searchInput.value) {
        this.searchAddon?.clearDecorations();
        const c = this.$(".tv-search-count"); if (c) c.textContent = "0";
        return;
      }
      this.doSearch(this.lastSearchDir);
    });
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.doSearch(e.shiftKey ? -1 : 1);
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.closeSearch();
      }
    });
    this.$(".tv-search-next")!.innerHTML = "↓";
    this.$(".tv-search-prev")!.innerHTML = "↑";
    this.$(".tv-search-close")!.innerHTML = icons.x;
    this.$(".tv-search-next")!.addEventListener("click", () => this.doSearch(1));
    this.$(".tv-search-prev")!.addEventListener("click", () => this.doSearch(-1));
    this.$(".tv-search-close")!.addEventListener("click", () => this.closeSearch());

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
      if (e.ctrlKey && e.key === "w" && this.channel.state === "connected") {
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", this.ctrlWHandler);
  }

  async connect(host: Host) {
    // If we're already connected to this host, just reattach — no reconnect needed
    if (this.channel.state === "connected" && this.host?.id === host.id) {
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
    this.updateStatusBar("connecting");
    this.setProgress("Initializing...", 5);

    try {
      // Load platform index for prompt patterns + KB
      this.setProgress("Loading knowledge base...", 8);
      try {
        this.platformIndex = await loadPlatformIndex(host.platform);
        this.promptDetector.loadPatterns(this.platformIndex.prompt_patterns, this.platformIndex.default_mode);
        this.currentMode = this.platformIndex.default_mode;
        this.controller.setPlatformIndex(this.platformIndex);
        this.controller.setMode(this.currentMode);
        log.info(LogTag.Terminal, `Platform index loaded: ${this.platformIndex.name}, default mode: ${this.platformIndex.default_mode}`);
      } catch (e) {
        log.warn(LogTag.Terminal, `Failed to load platform index: ${e}`);
      }

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

      // Mint session ID, register listeners, open the SSH connection.
      await this.channel.connect(host.id, { cols, rows });

      log.info(LogTag.Terminal, `sshConnect resolved successfully (session_id=${this.channel.sessionId})`);
    } catch (err) {
      log.error(LogTag.Terminal, `Connection failed: ${err}`);
      this.showError(String(err));
    }
  }

  private handleSessionEvent(e: SessionEvent) {
    switch (e.type) {
      case "output": {
        const bytes = e.data;
        const text = new TextDecoder().decode(bytes);

        if (e.phase === "connected") {
          const buf = this.terminal!.buffer.active;
          const lineBefore = buf.baseY + buf.cursorY;

          // Output highlighting — gate on "this chunk is real output". The
          // receivingOutput flag is set AFTER the write below, so the first
          // output chunk (which flips the flag) would otherwise pass through
          // raw. Use text.includes("\n") as the same output signal that sets
          // the flag, so the first chunk is highlighted too.
          const receivingOutput = this.controller.isReceivingOutput;
          const highlightOn = getOutputHighlightEnabled()
            && (receivingOutput || text.includes("\n"))
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

          // Cursor-escape desync guard: remote showed the cursor while ghost
          // had hidden it — sync bookkeeping so a later hide() doesn't strand
          // the cursor invisible.
          if (text.includes("\x1b[?25h") && this.ghostText?.isShowing()) {
            this.ghostText.notifyCursorShown();
          }

          // Echo re-sync + receivingOutput burst timer live in the controller.
          this.controller.onOutput(text, {
            isPassthrough: this.promptDetector.isPassthrough,
            lastPrompt: this.promptDetector.lastPrompt,
          });
        } else {
          // Connection phase — capture output for the output pane
          const cleanText = stripAnsi(text);
          this.outputBuffer.push(cleanText);
          this.renderOutputPane();
        }

        break;
      }

      case "connected": {
        log.info(LogTag.Terminal, `SSH connected event received (session_id=${this.channel.sessionId})`);
        // Update last_connected timestamp
        if (this.host) {
          touchHost(this.host.id).catch(() => {});
        }
        this.hideOverlay();
        this.terminal?.focus();
        this.updateStatusBar("connected");
        this.updateModeDisplay(this.currentMode);
        this.controller.setConnected(true);

        // Initialize ghost text overlay, dropdown, and sidebar content
        const termContainer = this.$(".tv-terminal")!;
        if (this.terminal) {
          this.ghostText?.destroy();
          this.dropdown?.destroy();
          this.ghostText = new GhostText(this.terminal, termContainer);
          this.dropdown = new Dropdown(termContainer, (cmd, payload) => {
            this.controller.acceptFromDropdown(cmd, payload);
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

        // Load KB commands into the frontend suggestion engine
        if (this.host) {
          this.loadKbCommands(
            this.host.platform,
            this.host.os_version ?? null,
            this.platformIndex?.negation_prefix ?? null,
          );
        }
        break;
      }

      case "disconnected": {
        this.clearOutputBuffer();
        this.controller.setConnected(false);
        log.info(LogTag.Terminal, `SSH disconnected event: ${e.reason}`);
        const wasConnected = e.wasConnected;

        // "connection_lost" = TCP dropped / keepalive failed (network blip,
        // VPN flap, server reboot). Show the reconnect banner so the user can
        // get back in without navigating to the host list.
        //
        // "channel_closed" / "channel_eof" = the remote end closed the channel
        // (user typed `exit`, server shutdown, admin reset). Treat as a clean
        // session end — bounce to host list or clean up the green dot.
        const reason = e.reason;
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
        break;
      }

      case "connect-failed": {
        log.error(LogTag.Terminal, `SSH connect failed: ${e.reason}`);
        this.showError(`Connection dropped during setup (${e.reason})`);
        break;
      }

      case "error": {
        log.error(LogTag.Terminal, `SSH error event: ${e.reason}`);
        this.showError(e.reason);
        break;
      }

      case "tofu": {
        log.info(LogTag.Terminal, e.reason);
        break;
      }

      case "auth-url": {
        const url = e.url;
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
        break;
      }
    }
  }

  // ─── Overlay / Banner UI ─────────────────────────────────────────

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
      const platformLabel = getPlatformMeta(this.host.platform).label;
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
      const label = getPlatformMeta(this.host.platform).label;
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
    const hostId = this.host?.id ?? "";
    await this.channel.disconnect();
    this.cleanup();
    this.onDisconnectCb(hostId);
  }

  private async cancelConnect() {
    this.clearOutputBuffer();
    const hostId = this.host?.id ?? "";
    await this.channel.disconnect();
    this.cleanup();
    this.onDisconnectCb(hostId);
  }

  private async reconnect() {
    this.clearOutputBuffer();
    if (!this.host) return;
    this.hideOverlay();
    this.hideDisconnectBanner();
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
    this.$(".tv-resizer")?.classList.toggle("hidden", !this.sidePanelOpen);
    this.$(".tv-panel-btn")?.setAttribute("aria-expanded", String(this.sidePanelOpen));
    // Refit terminal after sidebar transition
    if (this.sidePanelOpen && this.sidePanelMode === "replay") void this.showReplayPanel();
    setTimeout(() => {
      this.fitAddon?.fit();
      this.ghostText?.reposition();
    }, 250);
  }

  private initSidebarResize() {
    const resizer = this.$(".tv-resizer");
    const sidebar = this.$(".tv-sidebar");
    if (!resizer || !sidebar) return;

    const clampWidth = (width: number) => {
      const main = this.$(".tv-main");
      const max = Math.max(240, Math.floor((main?.clientWidth ?? width) * 0.6));
      return Math.min(max, Math.max(240, width));
    };

    const applyWidth = (width: number) => {
      sidebar.style.width = `${Math.round(clampWidth(width))}px`;
    };

    resizer.addEventListener("pointerdown", (e: PointerEvent) => {
      if (sidebar.classList.contains("hidden")) return;
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = sidebar.getBoundingClientRect().width;
      resizer.setPointerCapture(e.pointerId);
      resizer.classList.add("active");
      sidebar.classList.add("resizing");
      document.body.classList.add("tv-resizing");
      this.sidebarResizing = true;

      const onMove = (ev: PointerEvent) => {
        applyWidth(startWidth - (ev.clientX - startX));
        if (!this.sidebarResizeRaf) {
          this.sidebarResizeRaf = requestAnimationFrame(() => {
            this.sidebarResizeRaf = 0;
            this.fitAddon?.fit();
            this.ghostText?.reposition();
          });
        }
      };

      const stop = (ev: PointerEvent) => {
        if (resizer.hasPointerCapture(ev.pointerId)) resizer.releasePointerCapture(ev.pointerId);
        resizer.classList.remove("active");
        sidebar.classList.remove("resizing");
        document.body.classList.remove("tv-resizing");
        resizer.removeEventListener("pointermove", onMove);
        resizer.removeEventListener("pointerup", stop);
        resizer.removeEventListener("pointercancel", stop);
        if (this.sidebarResizeRaf) {
          cancelAnimationFrame(this.sidebarResizeRaf);
          this.sidebarResizeRaf = 0;
        }
        this.sidebarResizing = false;
        this.fitAddon?.fit();
        this.ghostText?.reposition();
      };

      resizer.addEventListener("pointermove", onMove);
      resizer.addEventListener("pointerup", stop);
      resizer.addEventListener("pointercancel", stop);
    });

    resizer.addEventListener("keydown", (e: KeyboardEvent) => {
      if (sidebar.classList.contains("hidden")) return;
      const step = e.shiftKey ? 48 : 16;
      let delta = 0;
      if (e.key === "ArrowLeft") delta = step;
      else if (e.key === "ArrowRight") delta = -step;
      else if (e.key === "Home") {
        e.preventDefault();
        applyWidth(240);
        this.fitAddon?.fit();
        this.ghostText?.reposition();
        return;
      } else if (e.key === "End") {
        e.preventDefault();
        applyWidth(Number.MAX_SAFE_INTEGER);
        this.fitAddon?.fit();
        this.ghostText?.reposition();
        return;
      } else {
        return;
      }
      e.preventDefault();
      applyWidth(sidebar.getBoundingClientRect().width + delta);
      this.fitAddon?.fit();
      this.ghostText?.reposition();
    });
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

  private async loadKbCommands(
    platform: string,
    version: string | null,
    negationPrefix?: string | null,
  ) {
    try {
      log.info(LogTag.Kb, `Loading commands for platform=${platform}, version=${version}`);
      const commands = await queryKb("", platform, null, version);
      log.info(LogTag.Kb, `queryKb returned ${commands.length} commands`);
      this.controller.loadCommands(commands, platform, negationPrefix ?? null);
      log.info(LogTag.Terminal, `Loaded ${commands.length} commands for ${platform}`);
    } catch (e) {
      log.warn(LogTag.Terminal, `Failed to load KB commands: ${e}`);
    }
    void refreshValidation(platform);
  }

  // ─── Suggestion pipeline ─────────────────────────────────────────
  // Query/ghost/dropdown logic lives in SuggestionController.

  // ─── Sidebar content ─────────────────────────────────────────────

  private updateSidebarDetail(command: Command) {
    const content = this.$(".sb-content");
    if (!content || !this.sidePanelOpen) return;
    if (this.sidePanelMode === "replay") return; // replay panel owns the content
    if (!this.sidebarContent) this.sidebarContent = new SidebarContent();
    content.innerHTML = this.sidebarContent.render(command, this.platformIndex?.reference_url ?? null);
    // Wire clickable examples
    content.querySelectorAll(".example-item").forEach((el) => {
      el.addEventListener("click", () => {
        const cmd = (el as HTMLElement).dataset.command;
        if (cmd && this.channel.state === "connected") {
          this.sendData(cmd + "\r");
          this.terminal?.focus();
        }
      });
    });
  }

  private updateSidebarPlaceholder() {
    const content = this.$(".sb-content");
    if (!content || !this.sidePanelOpen) return;
    if (this.sidePanelMode === "replay") return;
    content.innerHTML = `<p class="sb-placeholder">Start typing to see suggestions</p>`;
  }

  // ─── Command Replay panel (docs/09-command-replay.md) ────────────

  private initSidebarToggle() {
    const kbBtn = this.$(".sb-toggle-kb");
    const replayBtn = this.$(".sb-toggle-replay");
    kbBtn?.addEventListener("click", () => this.setSidePanelMode("kb"));
    replayBtn?.addEventListener("click", () => this.setSidePanelMode("replay"));
  }

  private setSidePanelMode(mode: "kb" | "replay") {
    this.sidePanelMode = mode;
    this.$(".sb-toggle-kb")?.classList.toggle("active", mode === "kb");
    this.$(".sb-toggle-replay")?.classList.toggle("active", mode === "replay");
    this.$(".sb-toggle-kb")?.setAttribute("aria-selected", String(mode === "kb"));
    this.$(".sb-toggle-replay")?.setAttribute("aria-selected", String(mode === "replay"));
    const content = this.$(".sb-content");
    if (!content) return;
    if (mode === "kb") {
      content.innerHTML = `<p class="sb-placeholder">Start typing to see suggestions</p>`;
    } else {
      void this.showReplayPanel();
    }
  }

  private async showReplayPanel() {
    const content = this.$(".sb-content");
    if (!content || !this.sidePanelOpen) return;
    try {
      this.replayItems = await replayList();
    } catch (e) {
      content.innerHTML = `<p class="sb-placeholder">Failed to load Command Replay: ${e}</p>`;
      return;
    }
    this.renderReplayPanel();
  }

  private renderReplayPanel() {
    const content = this.$(".sb-content");
    if (!content) return;
    const platform = this.host?.platform ?? "";
    const items = this.replayItems.filter((c) => c.platform === platform);
    const shown = items.length > 0 ? items : this.replayItems;
    const list = shown
      .map(
        (c) => `
        <div class="replay-item" data-id="${c.id}">
          <code class="replay-cmd">${this.renderReplayTemplate(c.command)}</code>
          <div class="replay-actions">
            <button class="btn-text replay-play" data-id="${c.id}" title="Play into terminal" aria-label="Play command into terminal">▶ Play</button>
          </div>
        </div>`,
      )
      .join("");
    content.innerHTML = `
      <div class="replay-panel">
        <div class="replay-panel-head">
          ${items.length === 0 && this.replayItems.length > 0 ? `<p class="sb-placeholder">No commands for this platform — showing all</p>` : ""}
          <button class="btn-text replay-add" title="Add command manually">+ Add command</button>
        </div>
        ${this.replayItems.length === 0
          ? `<p class="sb-placeholder">No saved commands yet. Select text in the terminal, right-click → <strong>Add to Command Replay</strong>.</p>`
          : `<div class="replay-list">${list}</div>`}
      </div>
    `;
    content.querySelector(".replay-add")?.addEventListener("click", () => {
      new ReplaySaveDialog("", platform, () => void this.showReplayPanel()).open();
    });
    content.querySelectorAll<HTMLButtonElement>(".replay-play").forEach((btn) => {
      btn.addEventListener("click", () => {
        const cmd = this.replayItems.find((c) => c.id === btn.dataset.id);
        if (cmd) this.playReplay(cmd);
      });
    });
  }

  /** Render a template, highlighting {{variables}} as chips. */
  private renderReplayTemplate(command: string): string {
    return renderReplayTemplate(command);
  }

  private esc(s: string): string {
    return escHtml(s);
  }

  /** Play a replay command: prompt for variables if needed, then insert. */
  private playReplay(cmd: ReplayCommand) {
    if (this.channel.state !== "connected") return;
    if (cmd.variables.length === 0) {
      this.insertReplayCommand(cmd.command);
      return;
    }
    this.promptReplayVariables(cmd);
  }

  private promptReplayVariables(cmd: ReplayCommand) {
    const overlay = document.createElement("div");
    overlay.className = "modal-backdrop";
    overlay.innerHTML = `
      <div class="modal-panel replay-dialog" role="dialog" aria-modal="true" aria-labelledby="rpv-title">
        <h2 id="rpv-title">Command Variables</h2>
        <p class="replay-dialog-hint"><code>${this.esc(cmd.command)}</code></p>
        ${cmd.variables
          .map(
            (v, i) => `
          <label>
            <span>${this.esc(v.name)}</span>
            <input type="text" class="form-input rpv-input" data-name="${this.esc(v.name)}"
                   ${i === 0 ? "autofocus" : ""} spellcheck="false" autocomplete="off" />
          </label>`,
          )
          .join("")}
        <div class="form-errors rpv-errors" role="alert"></div>
        <div class="form-actions">
          <button type="button" class="btn-text rpv-cancel">Cancel</button>
          <button type="button" class="btn-primary rpv-play">Play</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove();
    });
    const close = () => overlay.remove();
    const firstInput = overlay.querySelector<HTMLInputElement>(".rpv-input");
    if (firstInput) setTimeout(() => firstInput.focus(), 50);
    overlay.querySelector(".rpv-cancel")?.addEventListener("click", close);
    const play = () => {
      const values: Record<string, string> = {};
      overlay.querySelectorAll<HTMLInputElement>(".rpv-input").forEach((inp) => {
        values[inp.dataset.name ?? ""] = inp.value;
      });
      let filled: string;
      try {
        filled = substitute(cmd.command, cmd.variables, values);
      } catch (e) {
        const errEl = overlay.querySelector<HTMLElement>(".rpv-errors");
        if (errEl) errEl.textContent = `Missing value: ${(e as Error).message}`;
        return;
      }
      close();
      this.insertReplayCommand(filled);
    };
    overlay.querySelector(".rpv-play")?.addEventListener("click", play);
    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        play();
      } else if (e.key === "Escape") {
        close();
      }
    });
  }

  /** Insert a command at the terminal prompt without executing it. */
  private insertReplayCommand(text: string) {
    if (this.channel.state !== "connected" || !this.channel.sessionId) return;
    this.sendData(text);
    this.terminal?.focus();
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
    this.controller.setSuggestionsEnabled(this.suggestionsEnabled);
    const btn = this.$(".tv-suggestions-btn");
    if (btn) {
      btn.innerHTML = icons.lightbulb;
      btn.classList.toggle("active", this.suggestionsEnabled);
      setToggleState(btn, this.suggestionsEnabled, this.suggestionsEnabled ? "Disable command suggestions" : "Enable command suggestions");
    }
    if (!this.suggestionsEnabled) return;
    this.controller.refresh();
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
    this.channel.dispose();

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
    this.controller.dispose();
    this.ghostText?.destroy();
    this.ghostText = null;
    this.dropdown?.destroy();
    this.dropdown = null;
    this.outputHighlighter = null;
    this.sidebarContent = null;
    this.platformIndex = null;
    if (this.sidebarResizeRaf) {
      cancelAnimationFrame(this.sidebarResizeRaf);
      this.sidebarResizeRaf = 0;
    }
    document.body.classList.remove("tv-resizing");

    this.terminal?.dispose();
    this.terminal = null;
    this.fitAddon = null;
    this.host = null;
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

}
