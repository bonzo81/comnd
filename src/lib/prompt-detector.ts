/**
 * Prompt Detector — state machine for detecting CLI prompts
 * Powers mode awareness and shadow buffer reset.
 * 
 * Pipeline: SSH output → ANSI strip → idle detection → regex match → mode update
 */

import { stripAnsi } from "../lib/ansi";

export interface PromptPatterns {
  [mode: string]: string; // mode name → regex pattern
}

export class PromptDetector {
  private patterns: Map<string, RegExp> = new Map();
  private currentMode: string = "";
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingText: string = "";
  private onModeChange: (mode: string) => void;
  private onPromptDetected: () => void;

  // Interactive-app passthrough: set when no prompt has matched for >2s while
  // data keeps arriving (vi/more/top). Suppresses output highlighting.
  private passthrough = false;
  private noMatchTimer: ReturnType<typeof setTimeout> | null = null;

  private static readonly IDLE_MS = 200;
  private static readonly PASSTHROUGH_MS = 2000;

  constructor(
    onModeChange: (mode: string) => void,
    onPromptDetected: () => void,
  ) {
    this.onModeChange = onModeChange;
    this.onPromptDetected = onPromptDetected;
  }

  /** Load prompt patterns from platform index.yaml */
  loadPatterns(patterns: PromptPatterns, defaultMode: string) {
    this.patterns.clear();
    for (const [mode, pattern] of Object.entries(patterns)) {
      // A prompt must match the ENTIRE trailing text. Without the end anchor,
      // prompt + typed input (e.g. "Router#sh") re-triggers detection mid-command,
      // resetting the shadow buffer and killing ghost text while the user types.
      this.patterns.set(mode, new RegExp(`^(?:${pattern})$`));
    }
    this.currentMode = defaultMode;
    // No patterns → can't detect prompts → passthrough is meaningless. Leave
    // it off so highlighting is never suppressed by a stuck passthrough flag.
    this.passthrough = false;
    if (this.noMatchTimer) {
      clearTimeout(this.noMatchTimer);
      this.noMatchTimer = null;
    }
  }

  /** Feed SSH output data through the detector */
  feed(data: string) {
    // Strip ANSI escape sequences
    const clean = stripAnsi(data);

    // Accumulate trailing text (after last newline)
    const lastNewline = clean.lastIndexOf("\n");
    if (lastNewline >= 0) {
      this.pendingText = clean.substring(lastNewline + 1);
    } else {
      this.pendingText += clean;
    }

    // Reset idle timer
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.checkPrompt(), PromptDetector.IDLE_MS);

    // Passthrough timer — only arm on real output (contains newline) AND only
    // when prompt patterns exist. Without patterns (e.g. linux-bash has {}),
    // checkPrompt() can never match, so passthrough would flip true and never
    // reset — suppressing all highlighting. Skip the timer entirely in that case.
    if (this.patterns.size > 0 && clean.includes("\n")) {
      if (this.noMatchTimer) clearTimeout(this.noMatchTimer);
      this.noMatchTimer = setTimeout(() => {
        this.passthrough = true;
      }, PromptDetector.PASSTHROUGH_MS);
    }
  }

  /** Check if pending text matches a prompt pattern */
  private checkPrompt() {
    const text = this.pendingText.trim();
    if (!text) return;

    for (const [mode, regex] of this.patterns) {
      if (regex.test(text)) {
        if (mode !== this.currentMode) {
          this.currentMode = mode;
          this.onModeChange(mode);
        }
        // Successful prompt match — clear passthrough (interactive app exited)
        this.passthrough = false;
        if (this.noMatchTimer) {
          clearTimeout(this.noMatchTimer);
          this.noMatchTimer = null;
        }
        this.onPromptDetected();
        return;
      }
    }
  }

  get mode(): string {
    return this.currentMode;
  }

  /** True when no prompt matched for >2s while output kept arriving (vi/more/top). */
  get isPassthrough(): boolean {
    return this.passthrough;
  }
}
