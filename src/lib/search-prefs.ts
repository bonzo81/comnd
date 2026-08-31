/**
 * Search preferences — localStorage-backed toggles for global/KB search.
 * Mirrors the timestamps.ts pattern: get/set + CustomEvent on change.
 */

const TAGS_KEY = "netssh-search-include-tags";

export function getSearchIncludeTags(): boolean {
  return localStorage.getItem(TAGS_KEY) === "1";
}

export function setSearchIncludeTags(enabled: boolean): void {
  localStorage.setItem(TAGS_KEY, enabled ? "1" : "0");
  window.dispatchEvent(new CustomEvent("netssh:search-tags", { detail: enabled }));
}