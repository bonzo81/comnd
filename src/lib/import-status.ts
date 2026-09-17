/**
 * Import Job Status — global state for running KB import jobs.
 *
 * The KbImportDialog feeds lifecycle events (start/finish/cancel); backend
 * "import-progress" Tauri events are subscribed here so any view can show
 * progress. The title-bar indicator (main.ts) and its modal consume this
 * singleton.
 *
 * Cancel semantics: the backend has no cancellation token — extraction runs
 * to completion, but the two-stage design guarantees nothing is written to
 * the KB until the user commits the preview, and a cancelled job's preview
 * is discarded. Cancel = safe abandon. The dialog checks and consumes the
 * flag when its extract/commit awaits resolve.
 */

import { listen } from "@tauri-apps/api/event";
import { log, LogTag } from "./logger";

export interface ImportJobLine {
  time: string;
  text: string;
  kind: "stage" | "info" | "error" | "done";
}

/** Summary of a finished job — rendered by the wizard result and the status modal. */
export interface ImportResultSummary {
  ok: boolean;
  commandsImported: number;
  platform: string;
  category: string;
  targetFile: string;
}

/** Canonical stage keys emitted by {@link formatProgress}. */
export type ProgressStage =
  | "idle"
  | "fetching"
  | "extracting"
  | "sending"
  | "validating"
  | "writing"
  | "reloading"
  | "complete"
  | "error";

/** Shape of a raw `import-progress` Tauri event payload. */
export type ImportProgressPayload = { stage: string; detail?: unknown };

/**
 * Normalize a backend ImportProgress event (serde tags are the PascalCase
 * Rust variant names; `detail` is the variant's field object) into a dialog
 * stage key + human label.
 */
export function formatProgress(stage: string, detail: unknown): { key: ProgressStage; label: string; tail?: string } {
  const d = (detail ?? {}) as Record<string, unknown>;
  const s = (v: unknown) => (v === undefined || v === null || v === "" ? "" : String(v));
  switch (stage) {
    case "Fetching":
      return { key: "fetching", label: `Fetching ${s(d.url)}…` };
    case "ExtractingText":
      return { key: "extracting", label: `Extracting content (${s(d.content_length)} chars)…` };
    case "SendingToLlm":
      return { key: "sending", label: "Sending to LLM…" };
    case "LlmOutput":
      return { key: "sending", label: `Receiving LLM output (${s(d.chars)} chars)…`, tail: s(d.tail) };
    case "ExtractingChunk":
      return { key: "extracting", label: `Extracting commands (chunk ${s(d.chunk)}/${s(d.total)})…` };
    case "ExtractingCommands":
      return { key: "extracting", label: "Extracting commands…" };
    case "Validating":
      return { key: "validating", label: `Validating ${s(d.command_count)} command(s)…` };
    case "WritingYaml":
      return { key: "writing", label: `Writing ${s(d.command_count)} command(s) to ${s(d.target_file)}…` };
    case "ReloadingKb":
      return { key: "reloading", label: "Reloading knowledge base…" };
    case "Complete":
      return { key: "complete", label: `Import complete — ${s(d.commands_imported)} command(s) imported` };
    case "Error":
      return { key: "error", label: `Import failed: ${s(d.message)}` };
    default:
      return { key: "idle", label: stage };
  }
}

type Listener = () => void;

export class ImportJobStatus {
  active = false;
  /** Backend stage in a committing phase — cancel disabled. */
  committing = false;
  stageLabel = "";
  /** Canonical kebab stage key (formatProgress output) for the current event. */
  stageKey: ProgressStage = "idle";
  startedAt: Date | null = null;
  lines: ImportJobLine[] = [];
  /** Rolling tail of raw LLM stream output (live view in the job modal). */
  llmTail = "";
  /** Total chars received from the LLM stream (for the summary line). */
  llmChars = 0;
  /** Set by requestCancel(); consumed once by the dialog when its await resolves. */
  cancelRequested = false;
  /**
   * Result of the last completed job (single-job model: one at a time).
   * Owned here — not the dialog — so the summary survives the dialog being
   * unmounted/remounted (tab switches) and both surfaces render the same data.
   */
  result: ImportResultSummary | null = null;

  private listeners = new Set<Listener>();
  private listening = false;
  /** Heartbeat while waiting for the LLM's first output token (TTFT silence). */
  private waitingTimer: ReturnType<typeof setInterval> | null = null;
  private waitingSince: number | null = null;

  /** Subscribe to state changes. Returns an unlisten function. */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  private addLine(text: string, kind: ImportJobLine["kind"]) {
    const t = new Date().toLocaleTimeString([], { hour12: false });
    this.lines.push({ time: t, text, kind });
  }

  private parseChars(label: string): number {
    const m = label.match(/\(([\d,]+) chars\)/);
    return m ? parseInt(m[1].replace(/,/g, ""), 10) : 0;
  }

  /** One summary line for the stream total, instead of one per tick. */
  private flushLlmChars() {
    if (this.llmChars > 0) {
      this.addLine(`Received ${this.llmChars} chars of LLM output`, "info");
      this.llmChars = 0;
    }
  }

  /**
   * While the LLM ingests the prompt (time-to-first-token), no events arrive
   * — update the header every 10s so the wait is visibly progressing, and log
   * one line after 20s so the modal explains the silence.
   */
  private startWaiting() {
    this.stopWaiting();
    this.waitingSince = Date.now();
    let logged = false;
    this.waitingTimer = setInterval(() => {
      if (!this.active || this.waitingSince === null) { this.stopWaiting(); return; }
      const secs = Math.round((Date.now() - this.waitingSince) / 1000);
      this.stageLabel = `Sending to LLM — model is processing the page (${secs}s)…`;
      if (!logged && secs >= 20) {
        logged = true;
        this.addLine("Waiting for the model's first output — large pages take a while to process (this can be a minute or more on local models)", "info");
      }
      this.emit();
    }, 1000);
  }

  private stopWaiting() {
    if (this.waitingTimer !== null) {
      clearInterval(this.waitingTimer);
      this.waitingTimer = null;
    }
    this.waitingSince = null;
  }

  /** Begin listening to backend progress events (once, lazily). */
  private async ensureListening() {
    if (this.listening) return;
    this.listening = true;
    try {
      await listen<ImportProgressPayload>("import-progress", (event) => {
        this.handleProgressEvent(event.payload);
      });
    } catch (e) {
      // Tauri not running (browser dev / tests)
      log.warn(LogTag.KbImport, `Import progress listener unavailable: ${e}`);
      this.listening = false;
    }
  }

  /**
   * Handle one backend ImportProgress event. Public so tests can drive the
   * state machine without a live Tauri event bus.
   *
   * Stale-event filter (moved from the import dialog): the backend has no
   * cancellation token — after cancel/finish the Rust pipeline still runs to
   * completion and keeps emitting. Drop any event that arrives while no job is
   * active, so late events can't resurrect progress state on a finished or
   * cancelled job. The dialog's former `stageActive()` disjunct was dropped with
   * it — with a single state owner here, `active` alone is sufficient.
   */
  handleProgressEvent(payload: ImportProgressPayload) {
    if (!this.active) return;
    const { stage, detail } = payload;
    const info = formatProgress(stage, detail);
    this.stageKey = info.key;
    if (stage === "Complete") {
      this.finish(true, info.label);
    } else if (stage === "Error") {
      this.flushLlmChars();
      this.finish(false, info.label);
    } else if (stage === "LlmOutput") {
      // Streaming tick — update header/tooltip/live box only; logging a
      // line per tick spams the stream (one line per 250 chars).
      this.stopWaiting();
      this.committing = false;
      this.stageLabel = info.label;
      this.llmTail = info.tail ?? "";
      this.llmChars = this.parseChars(info.label);
      this.emit();
    } else {
      this.flushLlmChars();
      this.stopWaiting();
      this.committing = stage === "WritingYaml" || stage === "ReloadingKb";
      this.stageLabel = info.label;
      if (info.tail !== undefined) this.llmTail = info.tail;
      this.addLine(info.label, "stage");
      if (stage === "SendingToLlm") this.startWaiting();
      this.emit();
    }
  }

  /** Job started by the dialog. */
  start(url: string, platform: string, category: string) {
    void this.ensureListening();
    this.active = true;
    this.committing = false;
    this.cancelRequested = false;
    this.startedAt = new Date();
    this.lines = [];
    this.llmTail = "";
    this.llmChars = 0;
    this.result = null;
    this.stageKey = "fetching";
    this.stageLabel = "Starting import…";
    this.addLine(`Import started — ${platform}/${category}`, "info");
    this.addLine(`Source: ${url}`, "info");
    this.emit();
  }

  /** Extraction done — user is reviewing the preview. Job stays active. */
  review(count: number) {
    if (!this.active) return;
    this.flushLlmChars();
    this.stageLabel = `Review ready — ${count} command(s) awaiting your decision`;
    this.addLine(`Extraction finished — ${count} command(s) extracted, awaiting review`, "info");
    this.emit();
  }

  /** Set the job's result summary (success or failure). */
  setResult(result: ImportResultSummary | null) {
    this.result = result;
    this.emit();
  }

  finish(ok: boolean, note: string) {
    if (!this.active && this.lines.length === 0) return;
    this.active = false;
    this.committing = false;
    this.stageKey = "idle";
    this.stageLabel = "";
    this.stopWaiting();
    this.flushLlmChars();
    this.addLine(note, ok ? "done" : "error");
    this.emit();
  }

  /** User asked to cancel. Returns false when the job is already committing. */
  requestCancel(): boolean {
    if (!this.active) return true;
    if (this.committing) return false;
    this.cancelRequested = true;
    this.active = false;
    this.stageKey = "idle";
    this.stageLabel = "";
    this.stopWaiting();
    this.addLine("Cancelled by user — nothing was written to the knowledge base", "error");
    this.emit();
    return true;
  }

  /** Dialog: read + clear the cancel flag. */
  consumeCancel(): boolean {
    const c = this.cancelRequested;
    this.cancelRequested = false;
    return c;
  }
}

export const importJob = new ImportJobStatus();
