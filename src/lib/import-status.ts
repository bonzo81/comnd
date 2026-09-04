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

/**
 * Normalize a backend ImportProgress event (serde tags are the PascalCase
 * Rust variant names; `detail` is the variant's field object) into a dialog
 * stage key + human label.
 */
export function formatProgress(stage: string, detail: unknown): { key: string; label: string; tail?: string } {
  const d = (detail ?? {}) as Record<string, unknown>;
  const s = (v: unknown) => (v === undefined || v === null || v === "" ? "" : String(v));
  switch (stage) {
    case "Fetching":
      return { key: "fetching", label: `Fetching ${s(d.url)}…` };
    case "ExtractingText":
      return { key: "extracting", label: `Extracting content (${s(d.content_length)} chars)…` };
    case "SendingToLlm":
      return { key: "sending", label: `Sending to LLM (~${s(d.command_count_estimate)} commands expected)…` };
    case "LlmOutput":
      return { key: "sending", label: `Receiving LLM output (${s(d.chars)} chars)…`, tail: s(d.tail) };
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

class ImportJobStatus {
  active = false;
  /** Backend stage in a committing phase — cancel disabled. */
  committing = false;
  stageLabel = "";
  startedAt: number | null = null;
  lines: ImportJobLine[] = [];
  /** Rolling tail of raw LLM stream output (live view in the job modal). */
  llmTail = "";
  /** Set by requestCancel(); consumed once by the dialog when its await resolves. */
  cancelRequested = false;

  private listeners = new Set<Listener>();
  private listening = false;

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

  /** Begin listening to backend progress events (once, lazily). */
  private async ensureListening() {
    if (this.listening) return;
    this.listening = true;
    try {
      await listen<{ stage: string; detail?: unknown }>("import-progress", (event) => {
        const { stage, detail } = event.payload;
        const info = formatProgress(stage, detail);
        if (stage === "Complete") {
          this.finish(true, info.label);
        } else if (stage === "Error") {
          this.finish(false, info.label);
        } else {
          this.committing = stage === "WritingYaml" || stage === "ReloadingKb";
          this.stageLabel = info.label;
          if (info.tail !== undefined) this.llmTail = info.tail;
          this.addLine(info.label, "stage");
          this.emit();
        }
      });
    } catch (e) {
      // Tauri not running (browser dev / tests)
      log.warn(LogTag.KbImport, `Import progress listener unavailable: ${e}`);
      this.listening = false;
    }
  }

  /** Job started by the dialog. */
  start(url: string, platform: string, category: string) {
    void this.ensureListening();
    this.active = true;
    this.committing = false;
    this.cancelRequested = false;
    this.startedAt = Date.now();
    this.lines = [];
    this.llmTail = "";
    this.stageLabel = "Starting import…";
    this.addLine(`Import started — ${platform}/${category}`, "info");
    this.addLine(`Source: ${url}`, "info");
    this.emit();
  }

  /** Extraction done — user is reviewing the preview. Job stays active. */
  review(count: number) {
    if (!this.active) return;
    this.stageLabel = `Review ready — ${count} command(s) awaiting your decision`;
    this.addLine(`Extraction finished — ${count} command(s) extracted, awaiting review`, "info");
    this.emit();
  }

  finish(ok: boolean, note: string) {
    if (!this.active && this.lines.length === 0) return;
    this.active = false;
    this.committing = false;
    this.stageLabel = "";
    this.addLine(note, ok ? "done" : "error");
    this.emit();
  }

  /** User asked to cancel. Returns false when the job is already committing. */
  requestCancel(): boolean {
    if (!this.active) return true;
    if (this.committing) return false;
    this.cancelRequested = true;
    this.active = false;
    this.stageLabel = "";
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
