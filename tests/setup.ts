import { randomFillSync } from "crypto";

// jsdom lacks WebCrypto — polyfill getRandomValues for anything that needs it.
Object.defineProperty(window, "crypto", {
  value: { getRandomValues: (b: Uint8Array) => (randomFillSync(b as BufferSource) as Uint8Array) },
});

// Tauri IPC bridge — in-memory event bus so tests can listen/emit like the app.
type TauriHandler = (event: { event: string; id: number; payload: unknown }) => void;
const tauriListeners = new Map<string, Map<number, TauriHandler>>();
let tauriEventId = 0;

interface TauriInternals {
  transformCallback: (cb: TauriHandler, once?: boolean) => number;
  unregisterCallback: (id: number) => void;
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
}

const internals: TauriInternals = {
  transformCallback: (cb) => {
    const id = ++tauriEventId;
    const cbMap = new Map<number, TauriHandler>([[id, cb]]);
    (window as Record<string, unknown>).__TAURI_CALLBACKS__ = (window as Record<string, unknown>).__TAURI_CALLBACKS__ ?? new Map();
    ((window as Record<string, unknown>).__TAURI_CALLBACKS__ as Map<number, TauriHandler>).set(id, cb);
    return id;
  },
  unregisterCallback: (id) => {
    ((window as Record<string, unknown>).__TAURI_CALLBACKS__ as Map<number, TauriHandler> | undefined)?.delete(id);
  },
  invoke: async (cmd, args = {}) => {
    if (cmd === "plugin:event|listen") {
      const { event, handler } = args as { event: string; handler: number };
      const id = ++tauriEventId;
      if (!tauriListeners.has(event)) tauriListeners.set(event, new Map());
      tauriListeners.get(event)!.set(id, (e) => {
        const cbs = (window as Record<string, unknown>).__TAURI_CALLBACKS__ as Map<number, TauriHandler>;
        cbs.get(handler)?.(e);
      });
      return id;
    }
    if (cmd === "plugin:event|unlisten") {
      const { event, eventId } = args as { event: string; eventId: number };
      tauriListeners.get(event)?.delete(eventId);
      return;
    }
    if (cmd === "plugin:event|emit") {
      const { event, payload } = args as { event: string; payload: unknown };
      // Dispatch to listeners registered by the app under the same event name
      for (const [id, handler] of [...(tauriListeners.get(event) ?? [])]) {
        handler({ event, id, payload });
      }
      return;
    }
    return undefined;
  },
};

Object.defineProperty(window, "__TAURI_INTERNALS__", {
  value: internals,
  configurable: true,
});

// @tauri-apps/api/event._unlisten touches this before invoking
Object.defineProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", {
  value: { unregisterListener: () => {} },
  configurable: true,
});

// jsdom lacks matchMedia — xterm.js probes it on terminal open.
if (typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}
