/**
 * Search preferences — Web Storage-backed toggles for global/KB search.
 * Mirrors the timestamps.ts pattern: get/set + CustomEvent on change.
 */

import { readStorage, writeStorage } from "./storage";

const TAGS_KEY = "comnd-search-include-tags";

export function getSearchIncludeTags(): boolean {
  return readStorage(TAGS_KEY) === "1";
}

export function setSearchIncludeTags(enabled: boolean): void {
  writeStorage(TAGS_KEY, enabled ? "1" : "0");
  window.dispatchEvent(new CustomEvent("comnd:search-tags", { detail: enabled }));
}