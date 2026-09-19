/**
 * Validation Cache — KbValidationIssue[] for the current platform, fetched
 * via the `validate_kb` IPC once at KB load. Rust kb/validate.rs is the single
 * validator; this replaces the old kb-validator.ts mirror. See
 * docs/plans/plan-kb-schema-deepening.md.
 */

import { validateKb, KbValidationIssue } from "./tauri-api";
import { log, LogTag } from "./logger";

let currentPlatform: string | null = null;
let currentIssues: KbValidationIssue[] = [];

/** Fetch (or re-fetch) issues for a platform. Failure caches an empty list. */
export async function refreshValidation(platform: string): Promise<void> {
  try {
    currentIssues = await validateKb(platform);
    currentPlatform = platform;
  } catch (e) {
    log.warn(LogTag.Kb, `validateKb failed for ${platform}: ${e}`);
    currentIssues = [];
    currentPlatform = platform;
  }
}

/** Issues for one command of the current platform. */
export function issuesFor(cmdName: string): KbValidationIssue[] {
  if (!currentPlatform) return [];
  return currentIssues.filter((i) => i.command === cmdName);
}