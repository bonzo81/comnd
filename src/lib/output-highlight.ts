/**
 * Output highlighting feature flag — persisted in Web Storage, synced across
 * tabs via window CustomEvent. Follows the established pattern of the
 * timestamps, suggestions, and auto-copy toggles.
 *
 * See docs/plans/plan-terminal-output-highlighting.md.
 */

import { readStorage, writeStorage } from "./storage";

const STORAGE_KEY = "comnd-output-highlight";

export function getOutputHighlightEnabled(): boolean {
  return readStorage(STORAGE_KEY) === "1";
}

export function setOutputHighlightEnabled(enabled: boolean): void {
  writeStorage(STORAGE_KEY, enabled ? "1" : "0");
  window.dispatchEvent(new CustomEvent("comnd:output-highlight", { detail: enabled }));
}