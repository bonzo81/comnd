/**
 * LineTracker — single owner of the reconstructed remote input line.
 *
 * Merges PromptDetector (prompt regex, mode, passthrough) and EchoLineTracker
 * (char-walk line reconstruction, prompt learning) into one char walk and one
 * stripAnsi call per chunk. See docs/plans/plan-line-tracker.md.
 */

import { stripAnsi } from "./ansi";
import type { PlatformIndex } from "./tauri-api";

/** mode name → regex pattern (from the platform's index.yaml). */
export type PromptPatterns = PlatformIndex["prompt_patterns"];

export class LineTracker {
  private patterns = new Map<string, RegExp>();
  private secretPatterns: RegExp[] = [];
  private currentMode = "";
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private noMatchTimer: ReturnType<typeof setTimeout> | null = null;
  // Interactive-app passthrough: set when no prompt has matched for >2s while
  // data keeps arriving (vi/more/top). Suppresses output highlighting.
  private passthrough = false;
  private secretPromptActive = false;
  /** Text of the last matched prompt (trimmed) — used for echo re-sync. */
  private lastPromptText = "";

  // Reconstructed line (char walk)
  private line = "";
  // Line content before the last \r/\n — the prompt line when the prompt is
  // echoed with a trailing CRLF (typed echo then lands on a fresh line)
  private lastLineValue = "";
  // Prompt prefix learned from trusted EOL states (line = prompt + buffer).
  // Used when the platform has no prompt patterns (linux-bash ships {}).
  private learnedPrompt = "";

  private onModeChange: (mode: string) => void;
  private onPromptDetected: () => void;
  private onSecretPromptDetected: () => void;

  private static readonly IDLE_MS = 200;
  private static readonly PASSTHROUGH_MS = 2000;

  constructor(
    onModeChange: (mode: string) => void,
    onPromptDetected: () => void,
    onSecretPromptDetected: () => void,
  ) {
    this.onModeChange = onModeChange;
    this.onPromptDetected = onPromptDetected;
    this.onSecretPromptDetected = onSecretPromptDetected;
  }

  /** Load prompt patterns from platform index.yaml */
  loadPatterns(patterns: PromptPatterns, defaultMode: string, secretPromptPatterns: string[] = []) {
    this.patterns.clear();
    for (const [mode, pattern] of Object.entries(patterns)) {
      // A prompt must match the ENTIRE trailing text. Without the end anchor,
      // prompt + typed input (e.g. "Router#sh") re-triggers detection mid-command,
      // resetting the shadow buffer and killing ghost text while the user types.
      this.patterns.set(mode, new RegExp(`^(?:${pattern})$`));
    }
    this.secretPatterns = secretPromptPatterns.map((pattern) => new RegExp(`^(?:${pattern})$`));
    this.currentMode = defaultMode;
    this.secretPromptActive = false;
    // No patterns → can't detect prompts → passthrough is meaningless. Leave
    // it off so highlighting is never suppressed by a stuck passthrough flag.
    this.passthrough = false;
    if (this.noMatchTimer) {
      clearTimeout(this.noMatchTimer);
      this.noMatchTimer = null;
    }
    // New session context — drop the previous session's line state.
    this.reset();
  }

  /** Feed SSH output data: one char walk drives both line and prompt state. */
  feed(data: string) {
    const clean = stripAnsi(data);
    for (const ch of clean) {
      if (ch === "\n" || ch === "\r") {
        if (this.line) this.lastLineValue = this.line;
        this.line = "";
      } else if (ch === "\b") {
        // Backspace echo deletes a char; the space in the standard `\b \b`
        // triple is the visual overwrite and re-appends below, so the run
        // nets out to one erase per triple.
        this.line = this.line.slice(0, -1);
      } else if (ch >= " ") {
        this.line += ch;
      }
      // Other control bytes (BEL, etc.) ignored
    }

    // Reset idle timer
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.checkPrompt(), LineTracker.IDLE_MS);

    // Passthrough timer — only arm on real output (contains newline) AND only
    // when prompt patterns exist. Without patterns (e.g. linux-bash has {}),
    // checkPrompt() can never match, so passthrough would flip true and never
    // reset — suppressing all highlighting. Skip the timer entirely in that case.
    if (this.patterns.size > 0 && clean.includes("\n")) {
      if (this.noMatchTimer) clearTimeout(this.noMatchTimer);
      this.noMatchTimer = setTimeout(() => {
        this.passthrough = true;
      }, LineTracker.PASSTHROUGH_MS);
    }
  }

  /** Check if the current line matches a prompt pattern */
  private checkPrompt() {
    const text = this.line.trim();
    if (!text) return;

    for (const regex of this.secretPatterns) {
      if (regex.test(text)) {
        this.secretPromptActive = true;
        this.onSecretPromptDetected();
        return;
      }
    }

    for (const [mode, regex] of this.patterns) {
      if (regex.test(text)) {
        this.detectNormalPrompt(text, mode);
        return;
      }
    }

    // Bash has no reliable configured prompt pattern. While recovering from a
    // secret prompt, prefer the previously learned exact prefix; if none was
    // learned, accept only a standalone, conventional `user@host:path$` /
    // `host#`-style shell prompt. This heuristic is scoped to secret recovery.
    if (this.secretPromptActive && this.patterns.size === 0) {
      const learned = this.learnedPrompt.trim();
      if (learned && text === learned) {
        this.detectNormalPrompt(text, this.currentMode);
      } else if (/^[\w.-]+(?:@[\w.-]+)?(?::[^\s#$]*)?[#$]$/.test(text)) {
        this.detectNormalPrompt(text, this.currentMode);
      }
    }
  }

  private detectNormalPrompt(text: string, mode: string) {
    this.secretPromptActive = false;
    if (mode !== this.currentMode) {
      this.currentMode = mode;
      this.onModeChange(mode);
    }
    // Successful prompt match — clear passthrough (interactive app exited)
    this.passthrough = false;
    this.lastPromptText = text;
    if (this.noMatchTimer) {
      clearTimeout(this.noMatchTimer);
      this.noMatchTimer = null;
    }
    this.onPromptDetected();
  }

  /** True when no prompt matched for >2s while output kept arriving (vi/more/top). */
  get isPassthrough(): boolean {
    return this.passthrough;
  }

  /** Last matched prompt text (trimmed), "" before the first match. */
  get lastPrompt(): string {
    return this.lastPromptText;
  }

  /** Reconstructed current input line (prompt + typed content). */
  get currentLine(): string {
    return this.line;
  }

  /**
   * Learn the prompt prefix from a trusted state: cursor at EOL, simulated
   * buffer reliable, so the echoed line is exactly prompt + buffer. Only
   * learns when both parts are non-empty (an empty buffer can't separate
   * prompt from junk). Call on echo chunks while cursorMoved is false.
   */
  learnPrompt(expected: string) {
    if (!expected || !this.line) return;
    if (this.line.endsWith(expected) && this.line.length > expected.length) {
      this.learnedPrompt = this.line.substring(0, this.line.length - expected.length);
    }
  }

  /**
   * Current echoed command content, or null when the line can't be
   * reconciled (trust nothing).
   *
   * Prompt priority: detected prompt (Cisco/F5) → learned prompt (bash) →
   * consistency fallback (echo ends with the simulated buffer; also covers
   * backspacing past the prompt start where the prefix can't be stripped).
   */
  contentAfter(prompt: string, expected: string): string | null {
    const p = prompt || this.learnedPrompt;
    if (p) {
      if (this.line.startsWith(p)) {
        // Detected prompts are trimmed — leading whitespace is the prompt
        // separator, never part of the command.
        return this.line.substring(p.length).replace(/^\s+/, "");
      }
      // Prompt echoed with trailing CRLF: the prompt sat on its own line and
      // the typed echo accumulates on a fresh line without the prefix.
      if (this.lastLineValue.startsWith(p)) {
        return this.line.replace(/^\s+/, "");
      }
    }
    if (!expected) return "";
    return this.line.endsWith(expected) ? expected : null;
  }

  /** Drop reconstructed line state (prompt detection state survives). */
  reset() {
    this.line = "";
    this.lastLineValue = "";
    this.learnedPrompt = "";
  }
}
