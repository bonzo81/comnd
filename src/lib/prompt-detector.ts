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

  private static readonly IDLE_MS = 200;

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
      this.patterns.set(mode, new RegExp(pattern));
    }
    this.currentMode = defaultMode;
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
        this.onPromptDetected();
        return;
      }
    }
  }

  get mode(): string {
    return this.currentMode;
  }
}
