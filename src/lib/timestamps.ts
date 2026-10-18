/**
 * Line timestamps — iTerm-style gutter showing when each terminal line
 * first received output. Rendered as xterm.js decorations anchored to
 * buffer markers, shifted left into a reserved padding gutter so they
 * scroll with the content.
 *
 * Stamps are recorded continuously from connect; the toggle only shows
 * or hides the gutter, so users can reveal timestamps retroactively.
 */

import type { IDecoration, Terminal } from "@xterm/xterm";

const STORAGE_KEY = "comnd-timestamps";
const FORMAT_KEY = "comnd-timestamps-format";

export type TimestampFormat = "24h" | "12h" | "24h-ms";

export function getTimestampsEnabled(): boolean {
  return localStorage.getItem(STORAGE_KEY) === "1";
}

export function setTimestampsEnabled(enabled: boolean): void {
  localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
  window.dispatchEvent(new CustomEvent("comnd:timestamps", { detail: enabled }));
}

export function getTimestampFormat(): TimestampFormat {
  const v = localStorage.getItem(FORMAT_KEY);
  return v === "12h" || v === "24h-ms" ? v : "24h";
}

export function setTimestampFormat(format: TimestampFormat): void {
  localStorage.setItem(FORMAT_KEY, format);
  window.dispatchEvent(new CustomEvent("comnd:timestamps-format", { detail: format }));
}

export function formatTimestamp(time: Date, format: TimestampFormat): string {
  switch (format) {
    case "12h":
      return time.toLocaleTimeString([], { hour12: true });
    case "24h-ms": {
      const ms = String(time.getMilliseconds()).padStart(3, "0");
      return `${time.toLocaleTimeString([], { hour12: false })}.${ms}`;
    }
    default:
      return time.toLocaleTimeString([], { hour12: false });
  }
}

interface Stamp {
  decoration: IDecoration;
  time: Date;
}

export class TimestampGutter {
  private format: TimestampFormat = getTimestampFormat();
  private stamps: Stamp[] = [];
  private currentLine = -1;
  private currentLineStamped = false;

  constructor(private terminal: Terminal) {}

  /** Switch format and re-render existing stamps with it. */
  applyFormat(format: TimestampFormat): void {
    this.format = format;
    for (const s of this.stamps) {
      if (s.decoration.element) s.decoration.element.textContent = formatTimestamp(s.time, format);
    }
  }

  /** Terminal content was cleared — forget stamp bookkeeping. */
  reset(): void {
    this.stamps = [];
    this.currentLine = -1;
    this.currentLineStamped = false;
  }

  clear(): void {
    for (const s of this.stamps) s.decoration.dispose();
    this.reset();
  }

  dispose(): void {
    this.clear();
  }

  /**
   * Stamp lines touched by a write that moved the cursor from `before` to
   * `after` (absolute buffer coordinates). Only lines that first received
   * content are stamped; already-stamped lines keep their original time.
   */
  onWrite(before: number, after: number): void {
    const buf = this.terminal.buffer.active;
    const cursorAbs = buf.baseY + buf.cursorY;
    const time = new Date();
    const text = formatTimestamp(time, this.format);
    const start = before === this.currentLine && this.currentLineStamped ? before + 1 : before;
    for (let line = start; line <= after; line++) {
      const marker = this.terminal.registerMarker(line - cursorAbs);
      const decoration = this.terminal.registerDecoration({ marker, x: 0, width: 1 });
      if (!decoration) continue;
      decoration.onRender((el) => {
        el.classList.add("ts-stamp");
        el.textContent = text;
      });
      this.stamps.push({ decoration, time });
    }
    if (after >= start) {
      this.currentLine = after;
      this.currentLineStamped = true;
    }
    // ponytail: disposed decorations linger until compaction; live count is
    // bounded by scrollback, so filter only when the array gets large
    if (this.stamps.length > 4096) {
      this.stamps = this.stamps.filter((s) => !s.decoration.isDisposed);
    }
  }
}
