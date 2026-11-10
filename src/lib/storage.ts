/**
 * Guarded Web Storage access — the one place `src/` touches localStorage.
 *
 * A WebView can refuse storage entirely (policy, private mode, an opaque
 * origin). Then even reading `window.localStorage` throws SecurityError, and
 * `getItem`/`setItem` can throw on quota. Launch must degrade instead of
 * aborting, so every preference read returns null (callers fall through to
 * their documented default) and every failed write leaves the in-memory value
 * in effect without throwing.
 *
 * Failed writes are deliberately silent: user-visible feedback belongs to #87.
 */

/**
 * Values whose write failed, kept for the rest of the session. Consumers of a
 * preference event re-read the key instead of using the event detail, so a
 * discarded write would silently revert the change they just made.
 */
const unsaved = new Map<string, string>();

/** The storage object, or null when even the property access throws. */
function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Read a key. Returns null when storage is unavailable or the read throws. */
export function readStorage(key: string): string | null {
  const pending = unsaved.get(key);
  if (pending !== undefined) return pending;
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Write a key. Returns false when storage is unavailable or the write throws;
 *  the value stays readable for the session either way. */
export function writeStorage(key: string, value: string): boolean {
  try {
    const store = storage();
    if (store) {
      store.setItem(key, value);
      unsaved.delete(key);
      return true;
    }
  } catch {
    // fall through to the in-memory fallback
  }
  unsaved.set(key, value);
  return false;
}

/** Clear every key. A no-op when storage is unavailable. */
export function clearStorage(): void {
  unsaved.clear();
  try {
    storage()?.clear();
  } catch {
    // unavailable — nothing to clear
  }
}
