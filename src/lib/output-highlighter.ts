/**
 * Output Highlighter — line-buffered transform that injects ANSI color codes
 * into streamed command output for network/Unix contexts.
 *
 * Pipeline: SSH output text → [transform] → string with injected ANSI → xterm
 *
 * Gating is enforced by the CALLER (terminal-view.ts):
 *   - Only active when receivingOutput === true (command output, not echo)
 *   - Only active when tracker.isPassthrough === false (not vi/more/top)
 *   - Only active when feature flag is on
 *   - Only active when outputHighlighter !== null
 *
 * This module is purely the transform. It does NOT decide WHEN to run.
 *
 * See docs/plan-terminal-output-highlighting.md.
 */

import { HIGHLIGHT_RULES, HighlightRule } from "./highlight-rules";
import { ANSI_CODES, ANSI_RESET, AnsiColor } from "./highlight-palette";

const ANSI_DETECT = /\x1b\[/;
const BURST_LINE_THRESHOLD = 500;
const BURST_WINDOW_MS = 1000;
const BURST_COOLDOWN_MS = 500;

interface Injection {
  start: number;
  end: number;
  color: AnsiColor;
}

export class OutputHighlighter {
  private rules: HighlightRule[] = [];
  private lineBuffer = "";
  private burstMode = false;
  private lineCount = 0;
  private windowStart = 0;
  private lastBurstLine = 0;

  constructor(platform: string) {
    this.setPlatform(platform);
  }

  /** Update platform rules (e.g. on reconnect to a different host type). */
  setPlatform(platform: string): void {
    this.rules = HIGHLIGHT_RULES[platform] ?? [];
    this.lineBuffer = "";
  }

  /**
   * Transform a chunk of output text. Splits on newlines and applies rules
   * to each line (including the trailing partial line). Returns a string
   * (possibly with injected ANSI) to write to xterm.
   */
  transform(text: string): string {
    if (this.rules.length === 0) return text;

    this.lineBuffer += text;
    const lines = this.lineBuffer.split("\n");
    this.lineBuffer = "";

    let out = "";
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) out += "\n";
      if (lines[i]) out += this.transformLine(lines[i]);
    }
    return out;
  }

  private transformLine(line: string): string {
    // Skip lines with existing ANSI — device already colored it
    if (ANSI_DETECT.test(line)) return line;

    // Burst-rate fallback — pass through during large dumps
    const now = Date.now();
    if (now - this.windowStart > BURST_WINDOW_MS) {
      this.windowStart = now;
      this.lineCount = 0;
      if (this.burstMode && now - this.lastBurstLine > BURST_COOLDOWN_MS) {
        this.burstMode = false;
      }
    }
    this.lineCount++;
    if (this.lineCount > BURST_LINE_THRESHOLD) {
      this.burstMode = true;
      this.lastBurstLine = now;
    }
    if (this.burstMode) return line;

    // Apply rules, tracking claimed spans to avoid overlap (first rule wins)
    const claimed: Array<[number, number]> = [];
    const injections: Injection[] = [];
    const sorted = [...this.rules].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));

    for (const rule of sorted) {
      const flags = rule.pattern.flags.includes("g") ? rule.pattern.flags : rule.pattern.flags + "g";
      const re = new RegExp(rule.pattern.source, flags);
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        const s = m.index;
        const e = s + m[0].length;
        // Check overlap with already-claimed spans
        if (claimed.some(([cs, ce]) => s < ce && e > cs)) continue;
        claimed.push([s, e]);
        injections.push({ start: s, end: e, color: rule.color });
        if (m[0].length === 0) re.lastIndex++; // avoid zero-length loop
      }
    }

    if (injections.length === 0) return line;

    // Build output by splicing ANSI codes around matched spans
    injections.sort((a, b) => a.start - b.start);
    let result = "";
    let pos = 0;
    for (const inj of injections) {
      result += line.substring(pos, inj.start);
      result += `\x1b[${ANSI_CODES[inj.color]}m`;
      result += line.substring(inj.start, inj.end);
      result += ANSI_RESET;
      pos = inj.end;
    }
    result += line.substring(pos);
    return result;
  }
}