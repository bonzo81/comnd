/**
 * Auto-copy on selection — when enabled, text selected inside a terminal is
 * copied to the clipboard as the selection changes. Scoped per-terminal via
 * xterm.js onSelectionChange; native DOM selection elsewhere in the app never
 * triggers it.
 */

const STORAGE_KEY = "netssh-auto-copy";

export function getAutoCopyEnabled(): boolean {
  return localStorage.getItem(STORAGE_KEY) === "1";
}

export function setAutoCopyEnabled(enabled: boolean): void {
  localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
  window.dispatchEvent(new CustomEvent("netssh:auto-copy", { detail: enabled }));
}
