/**
 * SuggestionController â€” owns the suggestion pipeline state and logic.
 *
 * Extracted from TerminalView: the shadow buffer + echo tracker + engine,
 * the debounce â†’ query â†’ ghost/dropdown dispatch, and the output-side
 * suggestion logic (echo re-sync, receivingOutput burst timer). TerminalView
 * keeps rendering and I/O only; widgets arrive as accessors because they are
 * re-created on every reconnect.
 */

import { log, LogTag } from "./logger";
import { ShadowBuffer, MAX_SHADOW_LEN } from "./shadow-buffer";
import type { LineTracker } from "./line-tracker";
import {
  SuggestionEngine,
  ghostPayloadFor,
  type SuggestionResult,
} from "./suggestion-engine";
import { GhostText, GhostPayload, ghostPayloadAcceptText } from "./ghost-text";
import { Dropdown } from "./dropdown";
import type { Command, PlatformIndex } from "./tauri-api";

export interface ControllerUi {
  isSidebarOpen: () => boolean;
  dismissSidebar: () => void;
  toggleSuggestions: () => void;
}

export interface ControllerDeps {
  /** Send bytes to the current SSH session. */
  send: (data: string) => void;
  /** Shared line tracker — view constructs it once per session; it is never
   *  re-created on reconnect (unlike ghost/dropdown), so it's a plain field. */
  tracker: LineTracker;
  /** Live widgets — accessors, not fields; re-created on reconnect. */
  ghost: () => GhostText | null;
  dropdown: () => Dropdown | null;
  /** Show command detail / placeholder in the side panel. */
  sidebar: { detail: (cmd: Command) => void; placeholder: () => void };
  ui: ControllerUi;
}

type ShadowOp =
  | { op: "append"; ch: string }
  | { op: "backspace" }
  | { op: "reset" };

type RouteAction =
  | { kind: "noop" }
  | { kind: "send"; data: string }
  | { kind: "acceptDropdown" }
  | { kind: "acceptGhost" }
  | { kind: "acceptNextWord"; fallback: string };

interface RouteDecision {
  action: RouteAction;
  shadowOps: ShadowOp[];
  markCursorMoved?: boolean;
  hideGhost?: boolean;
  hideDropdown?: boolean;
  dismissSidebar?: boolean;
  toggleSuggestions?: boolean;
  moveDropdown?: "up" | "down";
  rebuildGhost?: boolean;
}

const LINE_EDIT = new Set([
  "\x1b[D", // left
  "\x1b[C", // right
  "\x1b[H", // home
  "\x1b[F", // end
  "\x1b[1~", // delete
  "\x1b[4~", // insert
  "\x15", // Ctrl+U
  "\x17", // Ctrl+W
  "\x04", // Ctrl+D
]);

const ALT_ARROW_RIGHT = ["\x1b[1;3C", "\x1b\x1b[C", "\x1b\x1b[1;3C"];

function routeKeystroke(
  data: string,
  view: { dropdownVisible: boolean; ghostShowing: boolean; sidebarOpen: boolean },
): RouteDecision {
  if (data === "\t") {
    if (view.dropdownVisible) return { action: { kind: "acceptDropdown" }, shadowOps: [] };
    if (view.ghostShowing) return { action: { kind: "acceptGhost" }, shadowOps: [] };
    return { action: { kind: "send", data }, shadowOps: [{ op: "reset" }] };
  }

  if (data === "\x1b") {
    if (view.dropdownVisible) return { action: { kind: "noop" }, shadowOps: [], hideDropdown: true };
    if (view.sidebarOpen) return { action: { kind: "noop" }, shadowOps: [], dismissSidebar: true };
    const r = defaultRoute(data);
    if (view.ghostShowing) r.hideGhost = true;
    return r;
  }

  if (data === "\x00")
    return { action: { kind: "noop" }, shadowOps: [], toggleSuggestions: true };

  if (view.dropdownVisible && data === "\x1b[A")
    return { action: { kind: "noop" }, shadowOps: [], moveDropdown: "up", rebuildGhost: true };
  if (view.dropdownVisible && data === "\x1b[B")
    return { action: { kind: "noop" }, shadowOps: [], moveDropdown: "down", rebuildGhost: true };

  if (ALT_ARROW_RIGHT.includes(data))
    return { action: { kind: "acceptNextWord", fallback: data }, shadowOps: [] };

  return defaultRoute(data);
}

function defaultRoute(data: string): RouteDecision {
  const r: RouteDecision = { action: { kind: "send", data }, shadowOps: [] };

  if (data === "\r") {
    r.shadowOps = [{ op: "reset" }];
    r.hideGhost = true;
    r.hideDropdown = true;
  } else if (data === "\x7f" || data === "\b") {
    r.shadowOps = [{ op: "backspace" }];
  } else if (data === "\x03") {
    r.shadowOps = [{ op: "reset" }];
    r.hideGhost = true;
    r.hideDropdown = true;
  } else if (data === "\x1b[A" || data === "\x1b[B") {
    r.shadowOps = [{ op: "reset" }];
    r.hideGhost = true;
  } else if (LINE_EDIT.has(data)) {
    r.markCursorMoved = true;
    r.hideGhost = true;
    r.hideDropdown = true;
  } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
    r.shadowOps = [{ op: "append", ch: data }];
  } else if (data.length > 1 && !data.startsWith("\x1b")) {
    for (const ch of data) {
      if (ch.charCodeAt(0) >= 32) r.shadowOps.push({ op: "append", ch });
    }
  }

  return r;
}

export class SuggestionController {
  private engine = new SuggestionEngine();
  private shadowBuffer: ShadowBuffer;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private outputTimer: ReturnType<typeof setTimeout> | null = null;
  private receivingOutput = false;
  // True when line-editing keys made the shadow buffer untrustworthy â€”
  // suggestions suppressed until next Enter/Ctrl+C/prompt or echo re-sync.
  private cursorMoved = false;
  private suggestionsEnabled = false;
  private connected = false;
  private readonly deps: ControllerDeps;

  constructor(deps: ControllerDeps) {
    this.deps = deps;
    // Shadow buffer updates are the debounce trigger â€” no currentInput mirror.
    this.shadowBuffer = new ShadowBuffer((text) => this.debounceSuggestionQuery(text));
  }

  // â”€â”€â”€ Configuration â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  loadCommands(
    commands: Command[],
    platform: string,
    negationPrefix: string | null,
    hostVersion?: string | null,
  ): void {
    this.engine.loadCommands(commands, platform, negationPrefix, hostVersion);
  }

  setPlatformIndex(idx: PlatformIndex | null): void {
    // Single source for prefixCommands (plan Â§2): derive from the index.
    this.engine.setPrefixCommands(idx?.prefix_commands ?? {});
  }

  setMode(mode: string): void {
    this.engine.setMode(mode);
  }

  setConnected(connected: boolean): void {
    this.connected = connected;
  }

  setSuggestionsEnabled(enabled: boolean): void {
    this.suggestionsEnabled = enabled;
    if (!enabled) this.deps.dropdown()?.hide();
  }

  get input(): string {
    return this.shadowBuffer.content;
  }

  get isReceivingOutput(): boolean {
    return this.receivingOutput;
  }

  get buffer(): ShadowBuffer {
    return this.shadowBuffer;
  }

  // â”€â”€â”€ Keystrokes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  keyIn(data: string): void {
    if (!this.connected) return;

    const ghost = this.deps.ghost();
    const dropdown = this.deps.dropdown();
    const r = routeKeystroke(data, {
      dropdownVisible: dropdown?.isVisible() ?? false,
      ghostShowing: ghost?.isShowing() ?? false,
      sidebarOpen: this.deps.ui.isSidebarOpen(),
    });

    switch (r.action.kind) {
      case "noop":
        break;
      case "send":
        this.deps.send(r.action.data);
        break;
      case "acceptDropdown":
        this.acceptDropdownSelection();
        break;
      case "acceptGhost": {
        const rem = ghost?.getCurrentRemainder();
        if (rem) {
          this.deps.send(rem);
          this.reset();
        }
        ghost?.hide();
        break;
      }
      case "acceptNextWord": {
        const word = ghost?.isShowing() ? ghost.acceptNextWord() : null;
        if (word) {
          this.deps.send(word);
          this.shadowBuffer.appendAll(word);
        } else {
          this.deps.send(r.action.fallback);
        }
        break;
      }
    }

    for (const op of r.shadowOps) {
      if (op.op === "append") this.shadowBuffer.append(op.ch);
      else if (op.op === "backspace") this.shadowBuffer.backspace();
      else if (op.op === "reset") this.reset();
    }

    if (r.markCursorMoved) this.markCursorMoved();
    if (r.moveDropdown === "up") dropdown?.moveUp();
    else if (r.moveDropdown === "down") dropdown?.moveDown();
    if (r.rebuildGhost) this.syncDropdownToGhostText();
    if (r.hideGhost) ghost?.hide();
    if (r.hideDropdown) dropdown?.hide();
    if (r.dismissSidebar) this.deps.ui.dismissSidebar();
    if (r.toggleSuggestions) this.deps.ui.toggleSuggestions();
  }

  /** Clipboard paste: forward the text and mirror it into the shadow buffer. */
  paste(text: string): void {
    this.deps.send(text);
    this.shadowBuffer.appendAll(text);
  }

  /** Line-editing keys (arrows etc.) made the buffer untrustworthy. */
  markCursorMoved(): void {
    this.cursorMoved = true;
  }

  /** Reset the shadow buffer and trust state (Enter/Ctrl+C/prompt/accept). */
  private reset(): void {
    this.shadowBuffer.reset();
    this.cursorMoved = false;
  }

  // â”€â”€â”€ Output handling â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /**
   * Output-phase suggestion logic: echo re-sync when the shadow buffer is
   * untrustworthy, prompt learning on trusted EOL state, and the
   * receivingOutput burst timer with its 300ms re-trigger.
   */
  onOutput(text: string): void {
    const tracker = this.deps.tracker;
    tracker.feed(text);

    if (!this.receivingOutput && !tracker.isPassthrough) {
      if (this.cursorMoved) {
        const echoed = tracker.contentAfter(tracker.lastPrompt, this.shadowBuffer.content);
        if (echoed !== null) {
          // Flag clears on any successful reconcile â€” even when the echoed
          // content matches the buffer (arrow key edited nothing), otherwise
          // the guard never lifts and suggestions stay dead.
          const changed = echoed !== this.shadowBuffer.content;
          this.shadowBuffer.setContent(echoed);
          this.cursorMoved = false;
          if (!changed && echoed) this.debounceSuggestionQuery(echoed);
        }
      } else {
        // Trusted EOL state (buffer reliable) â€” learn the prompt prefix
        // from line = prompt + buffer for platforms without prompt
        // patterns (bash).
        tracker.learnPrompt(this.shadowBuffer.content);
      }
    }

    // Only suppress ghost text for real output (command results), not for
    // keystroke echoes. Newline is the reliable signal: echoes never contain
    // one, command output virtually always does. A byte-count heuristic
    // flickered on devices that echo with ANSI cursor codes.
    if (text.includes("\n")) {
      this.receivingOutput = true;
      this.deps.ghost()?.hide();
      this.deps.dropdown()?.hide();
      if (this.outputTimer) clearTimeout(this.outputTimer);
      this.outputTimer = setTimeout(() => {
        this.receivingOutput = false;
        // Re-trigger suggestions if shadow buffer has content (e.g. after
        // paste echo). The debounce timer re-checks staleness against the
        // live buffer.
        if (this.shadowBuffer.content) {
          this.debounceSuggestionQuery(this.shadowBuffer.content);
        }
      }, 300);
    }
  }

  /** Prompt detected â€” reset shadow buffer, suppress output flag. */
  onPromptDetected(): void {
    this.reset();
    this.receivingOutput = false;
    this.deps.tracker.reset();
    // A fresh prompt always wants a visible cursor (DECTCEM desync guard)
    this.deps.ghost()?.hide();
  }

  // â”€â”€â”€ Query pipeline â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /** Toolbar toggle re-query. */
  refresh(): void {
    if (!this.suggestionsEnabled) return;
    if (this.shadowBuffer.content && !this.receivingOutput && this.connected) {
      const results = this.engine.query(this.shadowBuffer.content);
      if (results.length > 0) this.openDropdown(results);
    }
  }

  private debounceSuggestionQuery(text: string) {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (!text || this.receivingOutput || this.cursorMoved || !this.connected
      || text.length > MAX_SHADOW_LEN) {
      this.deps.ghost()?.hide();
      if (this.deps.dropdown()?.isVisible()) {
        this.deps.dropdown()?.updateResults([]);
      }
      this.deps.sidebar.placeholder();
      return;
    }
    this.debounceTimer = setTimeout(() => {
      // Staleness check: if the buffer changed since scheduling, re-debounce
      // with the current content instead of rendering a stale result.
      const current = this.shadowBuffer.content;
      if (current !== text) {
        log.debug(LogTag.Suggest, `stale query dropped ('${text}' != '${current}')`);
        this.debounceSuggestionQuery(current);
        return;
      }
      this.showSuggestions(text);
    }, 40);
  }

  private showSuggestions(text: string) {
    const results = this.engine.query(text);

    if (results.length === 0) {
      this.deps.ghost()?.hide();
      if (this.deps.dropdown()?.isVisible()) {
        this.deps.dropdown()?.updateResults([]);
      }
      this.deps.sidebar.placeholder();
      return;
    }

    // Show ghost text for top match
    const top = results[0];
    this.applyTopMatch(top, text, results.length - 1);

    // Auto-show dropdown when enabled; keep in sync while open
    if (this.suggestionsEnabled) {
      const dd = this.deps.dropdown();
      if (dd?.isVisible()) {
        dd.updateResults(results);
      } else {
        this.openDropdown(results);
      }
    } else if (this.deps.dropdown()?.isVisible()) {
      this.deps.dropdown()?.hide();
    }

    // Update sidebar with top match detail
    this.deps.sidebar.detail(top.command);
  }

  /**
   * Build ghost text for the top result. Token-aware commands render the
   * next expected token (Phase 3); legacy commands and name-prefix matches
   * render the name remainder.
   */
  private applyTopMatch(top: SuggestionResult, input: string, extraMatchCount: number) {
    const payload = this.ghostPayloadForTop(top, input);
    if (payload) {
      this.deps.ghost()?.showPayload(payload, extraMatchCount);
    } else {
      this.deps.ghost()?.hide();
    }
  }

  /**
   * Build a ghost payload for the top result. Token match â†’ token payload;
   * name/alias match â†’ text remainder (legacy).
   */
  private ghostPayloadForTop(top: SuggestionResult, input: string): GhostPayload | null {
    if (top.matchType === "token" && top.tokenMatch) {
      const payload = ghostPayloadFor(top.tokenMatch, top.command);
      if (payload) return payload;
      // Token match with no renderable payload (e.g. past all tokens) â€” fall
      // back to name remainder so something is still shown.
    }
    // Prefix results matched the stripped remainder, not the full input â€”
    // derive the remainder against the input minus the prefix word.
    const effInput = top.prefix && input.toLowerCase().startsWith(top.prefix + " ")
      ? this.engine.effectiveInputAfterPrefix(input, top.prefix)
      : input;
    const remainder = this.remainderFor(top.command.name, effInput);
    return remainder ? { kind: "text", text: remainder } : null;
  }

  /** Name remainder: what's left of the command name after the typed input. */
  remainderFor(commandName: string, input: string): string | null {
    if (!input) return commandName;
    const lowerInput = input.toLowerCase();
    const lowerCmd = commandName.toLowerCase();
    if (lowerCmd.startsWith(lowerInput)) {
      const remainder = commandName.substring(input.length);
      return remainder || null;
    }
    return null;
  }

  /** Re-render ghost from the current dropdown selection. */
  syncDropdownToGhostText(): void {
    const selected = this.deps.dropdown()?.getSelected();
    if (selected) {
      this.applyTopMatch(selected, this.shadowBuffer.content, 0);
    }
  }

  /**
   * Accept the dropdown's current selection. Token-aware: the dropdown
   * provides the ghost payload to send; for legacy matches we send the name
   * remainder.
   */
  acceptDropdownSelection(): void {
    const dd = this.deps.dropdown();
    const selected = dd?.getSelected();
    if (!selected) return;
    const payload = dd?.getSelectedPayload() ?? this.ghostPayloadForTop(selected, this.shadowBuffer.content);
    this.acceptFromDropdown(selected.command, payload);
    dd?.hide();
  }

  /**
   * Dropdown accept-callback body (shared by all dropdown instances):
   * send the ghost remainder (current token completion), not the full
   * command name. Phase 3 token-aware.
   */
  acceptFromDropdown(cmd: Command, payload: GhostPayload | null): void {
    const text = payload
      ? ghostPayloadAcceptText(payload)
      : this.remainderFor(cmd.name, this.shadowBuffer.content);
    if (text) {
      this.deps.send(text);
      this.reset();
    }
    this.deps.ghost()?.hide();
  }

  private openDropdown(results: SuggestionResult[]) {
    this.deps.dropdown()?.show(results, this.shadowBuffer.content);
    this.syncDropdownToGhostText();
  }

  dispose(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.outputTimer) clearTimeout(this.outputTimer);
  }
}