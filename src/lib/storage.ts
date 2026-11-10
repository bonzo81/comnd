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
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Write a key. Returns false when storage is unavailable or the write throws. */
export function writeStorage(key: string, value: string): boolean {
  try {
    const store = storage();
    if (!store) return false;
    store.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** Clear every key. A no-op when storage is unavailable. */
export function clearStorage(): void {
  try {
    storage()?.clear();
  } catch {
    // unavailable — nothing to clear
  }
}
