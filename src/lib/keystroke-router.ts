/**
 * Pure keystroke-routing decision for the suggestion pipeline.
 *
 * Given a raw xterm `onData` string and the current view state, decide what to
 * do — no DOM, no widgets, no I/O. The caller (TerminalView) resolves any
 * sentinel in `send` through the live ghost/dropdown widgets before forwarding,
 * then applies the shadow-buffer ops and visibility flags.
 *
 * Extracted from TerminalView.onData so the branching (when Tab accepts vs
 * passes through, when Escape closes what, etc.) is unit-testable in isolation.
 */

export interface RouteView {
  connected: boolean;
  dropdownVisible: boolean;
  ghostShowing: boolean;
  sidebarOpen: boolean;
}

export type ShadowOp =
  | { op: "append"; ch: string }
  | { op: "backspace" }
  | { op: "reset" };

// Sentinels the caller resolves through the live widgets before sending. They
// carry state only the widget knows (current ghost remainder, next word, the
// dropdown's selected payload), so they can't be decided here.
export const S_ACCEPT_GHOST = "\x00__accept_ghost__";
export const S_ACCEPT_NEXTWORD = "\x00__accept_nextword__";
export const S_ACCEPT_DROPDOWN = "\x00__accept_dropdown__";

export interface RouteResult {
  /** Strings to forward, in order. May contain sentinels for the caller to resolve. */
  send: string[];
  /** Unconditional shadow-buffer mutations, applied after sending. */
  shadowOps: ShadowOp[];
  /** Line-editing key made the shadow buffer untrustworthy (reset clears it in the controller). */
  markCursorMoved?: boolean;
  hideGhost?: boolean;
  hideDropdown?: boolean;
  dismissSidebar?: boolean;
  toggleSuggestions?: boolean;
  moveDropdown?: "up" | "down";
  /** Re-sync ghost to the (newly moved) dropdown selection. */
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

export function routeKeystroke(data: string, view: RouteView): RouteResult {
  if (!view.connected) return { send: [], shadowOps: [] };

  // TAB — accept dropdown > accept ghost > pass through + reset.
  if (data === "\t") {
    if (view.dropdownVisible) return { send: [S_ACCEPT_DROPDOWN], shadowOps: [] };
    if (view.ghostShowing) return { send: [S_ACCEPT_GHOST], shadowOps: [] };
    return { send: ["\t"], shadowOps: [{ op: "reset" }] };
  }

  // ESCAPE — close dropdown, else close sidebar, else (hide ghost + forward).
  if (data === "\x1b") {
    if (view.dropdownVisible) return { send: [], shadowOps: [], hideDropdown: true };
    if (view.sidebarOpen) return { send: [], shadowOps: [], dismissSidebar: true };
    const r = defaultRoute(data); // forwards bare ESC, no buffer mutation
    if (view.ghostShowing) r.hideGhost = true;
    return r;
  }

  // CTRL+SPACE — toggle suggestions, do not forward.
  if (data === "\x00") return { send: [], shadowOps: [], toggleSuggestions: true };

  // ARROWS while the dropdown is open — navigate, do not forward.
  if (view.dropdownVisible) {
    if (data === "\x1b[A") return { send: [], shadowOps: [], moveDropdown: "up", rebuildGhost: true };
    if (data === "\x1b[B") return { send: [], shadowOps: [], moveDropdown: "down", rebuildGhost: true };
  }

  // ALT+ARROWRIGHT — accept next word from ghost, or forward raw.
  if (ALT_ARROW_RIGHT.includes(data)) return { send: [S_ACCEPT_NEXTWORD], shadowOps: [] };

  return defaultRoute(data);
}

/** The fall-through path: forward the key, then mutate the shadow buffer. */
function defaultRoute(data: string): RouteResult {
  const r: RouteResult = { send: [data], shadowOps: [] };

  if (data === "\r") {
    // Enter — commit line.
    r.shadowOps = [{ op: "reset" }];
    r.hideGhost = true;
    r.hideDropdown = true;
  } else if (data === "\x7f" || data === "\b") {
    // Backspace.
    r.shadowOps = [{ op: "backspace" }];
  } else if (data === "\x03") {
    // Ctrl+C — abort, reset.
    r.shadowOps = [{ op: "reset" }];
    r.hideGhost = true;
    r.hideDropdown = true;
  } else if (data === "\x1b[A" || data === "\x1b[B") {
    // Arrow up/down history — reset shadow, clear ghost. (Dropdown already
    // handled above when visible.)
    r.shadowOps = [{ op: "reset" }];
    r.hideGhost = true;
  } else if (LINE_EDIT.has(data)) {
    // In-line cursor moves / word edits — don't touch buffer content.
    r.markCursorMoved = true;
    r.hideGhost = true;
    r.hideDropdown = true;
  } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
    // Printable single char.
    r.shadowOps = [{ op: "append", ch: data }];
  } else if (data.length > 1 && !data.startsWith("\x1b")) {
    // Paste — append each printable char.
    for (const ch of data) {
      if (ch.charCodeAt(0) >= 32) r.shadowOps.push({ op: "append", ch });
    }
  }
  // else: unrecognized control sequence — forward only, no buffer mutation.

  return r;
}
