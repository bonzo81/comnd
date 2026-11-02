// Vitest bootstrap — the whole environment fake lives in the harness
// (tests/harness.ts). See docs/plans/plan-test-harness.md.
import { install } from "./harness";

// Node 26 ships a `localStorage` global that stays undefined unless the
// process runs with --localstorage-file. Vitest only copies a jsdom global when
// Node does not already define the name, so that global shadows the jsdom one
// and every bare `localStorage` access throws. Supply the missing storage.
if (!globalThis.localStorage) {
  const entries = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return entries.size;
    },
    key: (index: number) => Array.from(entries.keys())[index] ?? null,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(String(key), String(value));
    },
    removeItem: (key: string) => {
      entries.delete(key);
    },
    clear: () => {
      entries.clear();
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
    writable: true,
  });
}

install();