/**
 * Output highlighting feature flag — persisted in localStorage, synced across
 * tabs via window CustomEvent. Follows the established pattern of the
 * timestamps, suggestions, and auto-copy toggles.
 *
 * See docs/plan-terminal-output-highlighting.md.
 */

const STORAGE_KEY = "netsh-output-highlight";

export function getOutputHighlightEnabled(): boolean {
  return localStorage.getItem(STORAGE_KEY) === "1";
}

export function setOutputHighlightEnabled(enabled: boolean): void {
  localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
  window.dispatchEvent(new CustomEvent("netsh:output-highlight", { detail: enabled }));
}