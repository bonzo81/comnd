/**
 * AuthInputCollector — assembles keyboard-interactive answers during an
 * SSH connect (issue #12).
 *
 * A password-auth host with no stored password must be answered in the
 * terminal while the SSH handshake is parked on a keyboard-interactive
 * round. There is no PTY yet, so the remote never echoes what the user
 * types — this collector mirrors that: characters accumulate locally,
 * each Enter answers one prompt, and nothing is ever rendered, logged, or
 * fed to the shadow buffer.
 *
 * Pure by design: no DOM, no IPC. The view feeds it keystrokes (`feed`) and
 * submits the returned responses via `sshAuthRespond`. Unit tests live
 * next door.
 */

/** One prompt of a keyboard-interactive round, as sent by the backend. */
export interface AuthPrompt {
  prompt: string;
  echo: boolean;
}

/** Result of feeding keystrokes to the current round. */
export type AuthInputResult =
  /** Nothing to do — still accumulating, or stale input after submit. */
  | { kind: "none" }
  /** All prompts answered — submit these responses to the backend. */
  | { kind: "submit"; responses: string[] }
  /** Ctrl+C — the user wants to abort the connect. */
  | { kind: "cancel" };

// Key bytes handled by the collector; everything else printable appends.
const ESC = "\x1b";
const CTRL_C = "\x03";
const CTRL_H = "\x08";
const CR = "\r";
const LF = "\n";
const DEL = "\x7f";

export class AuthInputCollector {
  private prompts: AuthPrompt[] = [];
  private answers: string[] = [];
  private line = "";
  private submitted = false;
  /** Escape-sequence state: 0 none, 1 saw ESC, 2 inside CSI/SS3 params. */
  private esc = 0;

  /** Start a round: the prompts to answer, in order. */
  setRound(prompts: AuthPrompt[]): void {
    this.prompts = prompts;
    this.answers = [];
    this.line = "";
    this.submitted = false;
    this.esc = 0;
  }

  /**
   * Feed one keystroke chunk (a paste may carry several characters).
   * Printable characters extend the current line, backspace edits it,
   * Enter answers the next prompt (submitting once all are answered), and
   * Ctrl+C cancels. Escape sequences (arrows etc.) are consumed silently —
   * there is nothing to edit; other control keys are dropped.
   */
  feed(data: string): AuthInputResult {
    for (const ch of data) {
      // A submitted round is done: stale keystrokes (typing ahead, a
      // double Enter) must not queue phantom answers for a later round.
      if (this.submitted) return { kind: "none" };

      // Escape sequences span chunks — the state survives feed() calls.
      // CSI/SS3: ESC [ or ESC O, then parameter bytes up to a final byte
      // (0x40..=0x7E). Bare ESC followed by anything else: drop just the
      // ESC and handle that character normally.
      if (this.esc === 2) {
        const code = ch.charCodeAt(0);
        if (code >= 0x40 && code <= 0x7e) this.esc = 0;
        continue;
      }
      if (this.esc === 1) {
        if (ch === "[" || ch === "O") {
          this.esc = 2;
          continue;
        }
        this.esc = 0; // bare ESC — fall through, handle this char normally
      } else if (ch === ESC) {
        this.esc = 1;
        continue;
      }

      if (ch === CTRL_C) return { kind: "cancel" };
      if (ch === CR || ch === LF) {
        if (this.prompts.length === 0) {
          this.submitted = true;
          return { kind: "submit", responses: [] };
        }
        this.answers.push(this.line);
        this.line = "";
        if (this.answers.length >= this.prompts.length) {
          this.submitted = true;
          return { kind: "submit", responses: this.answers };
        }
      } else if (ch === DEL || ch === CTRL_H) {
        this.line = this.line.slice(0, -1);
      } else {
        const code = ch.charCodeAt(0);
        if (code >= 0x20 && code !== 0x7f) this.line += ch;
      }
    }
    return { kind: "none" };
  }
}