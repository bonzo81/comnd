/**
 * Unit tests for the import job state module (import-status.ts).
 *
 * formatProgress normalizes every Rust ImportProgress variant; the stale-event
 * filter in handleProgressEvent drops events while no job is active.
 *
 * The variant list mirrors src-tauri/src/import.rs `ImportProgress` (L41–56) —
 * keep in sync manually (the phase-1 contract fixture covers command schema,
 * not progress payloads).
 */

import { describe, expect, it } from "vitest";
import { formatProgress, ImportJobStatus } from "./import-status";

describe("formatProgress", () => {
  const cases: Array<[stage: string, detail: unknown, key: string, label: string]> = [
    ["Fetching", { url: "https://x.example/page" }, "fetching", "Fetching https://x.example/page…"],
    ["ExtractingText", { content_length: 1234 }, "extracting", "Extracting content (1234 chars)…"],
    ["SendingToLlm", {}, "sending", "Sending to LLM…"],
    ["LlmOutput", { chars: 500, tail: "partial" }, "sending", "Receiving LLM output (500 chars)…"],
    ["ExtractingChunk", { chunk: 2, total: 5 }, "extracting", "Extracting commands (chunk 2/5)…"],
    ["ExtractingCommands", {}, "extracting", "Extracting commands…"],
    ["Validating", { command_count: 9 }, "validating", "Validating 9 command(s)…"],
    ["WritingYaml", { command_count: 3, target_file: "linux-bash/commands/networking.yaml" }, "writing", "Writing 3 command(s) to linux-bash/commands/networking.yaml…"],
    ["ReloadingKb", {}, "reloading", "Reloading knowledge base…"],
    ["Complete", { commands_imported: 7, target_file: "x.yaml" }, "complete", "Import complete — 7 command(s) imported"],
    ["Error", { message: "boom" }, "error", "Import failed: boom"],
  ];

  it("normalizes every Rust ImportProgress variant to its key + label", () => {
    for (const [stage, detail, key, label] of cases) {
      const r = formatProgress(stage, detail);
      expect(r.key, stage).toBe(key);
      expect(r.label, stage).toBe(label);
    }
  });

  it("carries the rolling LLM tail on LlmOutput only", () => {
    expect(formatProgress("LlmOutput", { chars: 10, tail: "abc" }).tail).toBe("abc");
    expect(formatProgress("SendingToLlm", {}).tail).toBeUndefined();
  });

  it("falls back to the raw tag for an unknown stage", () => {
    const r = formatProgress("BrandNewStage", {});
    expect(r.key).toBe("idle");
    expect(r.label).toBe("BrandNewStage");
  });
});

describe("handleProgressEvent stale-event filter", () => {
  it("drops events before any job is active", () => {
    const job = new ImportJobStatus();
    job.handleProgressEvent({ stage: "Fetching", detail: { url: "x" } });
    expect(job.stageKey).toBe("idle");
    expect(job.stageLabel).toBe("");
  });

  it("advances state while a job is active", () => {
    const job = new ImportJobStatus();
    job.active = true;
    job.handleProgressEvent({ stage: "Validating", detail: { command_count: 4 } });
    expect(job.stageKey).toBe("validating");
    expect(job.stageLabel).toBe("Validating 4 command(s)…");
  });

  it("drops events once the job finishes", () => {
    const job = new ImportJobStatus();
    job.active = true;
    job.handleProgressEvent({ stage: "WritingYaml", detail: { command_count: 2, target_file: "f.yaml" } });
    expect(job.committing).toBe(true);
    job.finish(true, "done");
    expect(job.active).toBe(false);
    // Late event after finish must not resurrect committing state.
    job.handleProgressEvent({ stage: "ReloadingKb", detail: {} });
    expect(job.stageKey).toBe("idle");
    expect(job.committing).toBe(false);
  });

  it("drops events after a user cancel", () => {
    const job = new ImportJobStatus();
    job.active = true;
    expect(job.requestCancel()).toBe(true);
    job.handleProgressEvent({ stage: "Complete", detail: { commands_imported: 1, target_file: "f.yaml" } });
    expect(job.stageKey).toBe("idle");
    expect(job.result).toBeNull();
  });
});
