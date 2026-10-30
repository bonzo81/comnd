/**
 * Test harness — the single fake for everything the app talks to: the
 * Tauri IPC seam, shared wire fixtures, and DOM scaffolding.
 *
 * install()       — once, from tests/setup.ts: jsdom polyfills, the
 *                   baseline (lenient) IPC bus, and a global afterEach
 *                   safety net.
 * createHarness() — per test: swaps in a strict dispatcher that throws on
 *                   unmocked commands, plus fixture factories and a DOM
 *                   mount helper. Auto-restored when the test ends.
 *
 * Design: docs/plans/plan-test-harness.md · term: CONTEXT.md ("Test harness").
 */
import { afterEach } from "vitest";
import type { AppConfig, Command, Host, HostGroup } from "../src/lib/tauri-api";

// ─── Tauri internals plumbing ─────────────────────────────────────────────

interface TauriEvent {
  event: string;
  id: number;
  payload: unknown;
}

type TauriHandler = (event: TauriEvent) => void;

interface TauriInternals {
  transformCallback: (cb: TauriHandler, once?: boolean) => number;
  unregisterCallback: (id: number) => void;
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
}

function internalsOf(): TauriInternals {
  return (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
}

/** transformCallback registrations — the bridge between the api package
 *  and the event bus (module-private; nothing else reads it). */
const callbacks = new Map<number, TauriHandler>();
let callbackId = 0;

/** In-memory event bus — the plugin:event|* half of the IPC seam. */
class EventBus {
  private readonly listeners = new Map<string, Map<number, TauriHandler>>();
  private nextId = 0;

  register(event: string, handler: TauriHandler): number {
    const id = ++this.nextId;
    if (!this.listeners.has(event)) this.listeners.set(event, new Map());
    this.listeners.get(event)!.set(id, handler);
    return id;
  }

  unregister(event: string, id: number): void {
    this.listeners.get(event)?.delete(id);
  }

  dispatch(event: string, payload: unknown): void {
    for (const [id, handler] of [...(this.listeners.get(event) ?? [])]) {
      handler({ event, id, payload });
    }
  }
}

/** Handle the three plugin:event|* commands against a bus.
 *  Returns { handled: false } for every other command. */
function eventInvoke(
  bus: EventBus,
  cmd: string,
  args: Record<string, unknown> = {},
): { handled: boolean; result?: unknown } {
  if (cmd === "plugin:event|listen") {
    const { event, handler } = args as { event: string; handler: number };
    const id = bus.register(event, (e) => callbacks.get(handler)?.(e));
    return { handled: true, result: id };
  }
  if (cmd === "plugin:event|unlisten") {
    const { event, eventId } = args as { event: string; eventId: number };
    bus.unregister(event, eventId);
    return { handled: true };
  }
  if (cmd === "plugin:event|emit") {
    const { event, payload } = args as { event: string; payload: unknown };
    bus.dispatch(event, payload);
    return { handled: true };
  }
  return { handled: false };
}

// ─── Baseline bus (lenient) ───────────────────────────────────────────────

const baselineBus = new EventBus();

/** Dispatcher the app sees when no harness is active: event commands work,
 *  everything else resolves undefined (legacy behavior — tests that want
 *  strictness create a harness). */
function baselineInvoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  const evt = eventInvoke(baselineBus, cmd, args);
  if (evt.handled) return Promise.resolve(evt.result);
  return Promise.resolve(undefined);
}

// ─── Fixture factories ────────────────────────────────────────────────────

export interface FixtureFactories {
  host(overrides?: Partial<Host>): Host;
  hostGroup(overrides?: Partial<HostGroup>): HostGroup;
  command(name: string, overrides?: Partial<Command>): Command;
  appConfig(overrides?: Partial<AppConfig>): AppConfig;
}

function makeFactories(): FixtureFactories {
  return {
    host: (overrides: Partial<Host> = {}): Host => ({
      id: "h-1",
      display_name: "Test Host",
      hostname: "10.0.0.1",
      port: 22,
      username: "admin",
      credential: { type: "password" },
      platform: "linux-bash",
      os_version: null,
      highlight_profile: null,
      notes: null,
      last_connected: null,
      created_at: "2026-01-01T00:00:00.000Z",
      sort_order: 0,
      tags: [],
      group_id: null,
      source: null,
      ...overrides,
    }),
    hostGroup: (overrides: Partial<HostGroup> = {}): HostGroup => ({
      id: "g-1",
      name: "Test Group",
      parent_id: null,
      sort_order: 0,
      color: null,
      icon: null,
      created_at: "2026-01-01T00:00:00.000Z",
      ...overrides,
    }),
    command: (name: string, overrides: Partial<Command> = {}): Command => ({
      name,
      syntax: name,
      description: `${name} — harness fixture`,
      category: "test",
      mode: "bash",
      aliases: [],
      examples: [],
      versions: { introduced: null, deprecated: null, notes: null },
      tags: [],
      ...overrides,
    }),
    appConfig: (overrides: Partial<AppConfig> = {}): AppConfig => ({
      llm_api_format: "ollama",
      llm_base_url: "http://localhost:11434",
      llm_model: "llama3.2",
      llm_api_key: null,
      llm_context_length: 64000,
      log_level: "info",
      log_max_size_mb: 10,
      log_file_path: null,
      max_sessions: 6,
      duplicate_session_policy: "ask",
      session_logging: true,
      session_log_timestamps: false,
      session_log_dir: null,
      ...overrides,
    }),
  };
}

// ─── Harness ──────────────────────────────────────────────────────────────

export interface IpcCall {
  args: Record<string, unknown>;
}

type MockImpl = (args: Record<string, unknown>) => unknown | Promise<unknown>;

interface MockEntry {
  result?: unknown;
  impl?: MockImpl;
}

export interface Harness {
  readonly ipc: {
    /** Static result. `undefined` is a legal result — it is how a test
     *  expresses "this command returns nothing" (the only escape hatch
     *  from strictness; unmocked commands throw). */
    mock(cmd: string, result: unknown): void;
    /** Dynamic result, computed from the invoke args. */
    mockImpl(cmd: string, impl: MockImpl): void;
    /** Recorded args per command, in invoke order. */
    calls(cmd: string): IpcCall[];
  };
  /** Dispatch an event to listeners registered via the real listen(). */
  emit(event: string, payload: unknown): void;
  /** A <div> appended to the body, removed when the test ends. */
  mount(): HTMLElement;
  readonly fixtures: FixtureFactories;
}

const activeHarnesses: HarnessImpl[] = [];

class HarnessImpl implements Harness {
  private readonly mocks = new Map<string, MockEntry>();
  private readonly callLog = new Map<string, IpcCall[]>();
  private readonly bus = new EventBus();
  private readonly mounted: HTMLElement[] = [];
  private readonly previousInvoke: TauriInternals["invoke"];
  private restored = false;

  readonly ipc = {
    mock: (cmd: string, result: unknown): void => {
      this.mocks.set(cmd, { result });
    },
    mockImpl: (cmd: string, impl: MockImpl): void => {
      this.mocks.set(cmd, { impl });
    },
    calls: (cmd: string): IpcCall[] => this.callLog.get(cmd) ?? [],
  };

  readonly fixtures = makeFactories();

  constructor() {
    this.previousInvoke = internalsOf().invoke;
    internalsOf().invoke = this.dispatch;
    activeHarnesses.push(this);
  }

  emit(event: string, payload: unknown): void {
    this.bus.dispatch(event, payload);
  }

  mount(): HTMLElement {
    const el = document.createElement("div");
    document.body.appendChild(el);
    this.mounted.push(el);
    return el;
  }

  restore(): void {
    if (this.restored) return;
    this.restored = true;
    internalsOf().invoke = this.previousInvoke;
    for (const el of this.mounted) el.remove();
    this.mounted.length = 0;
    const idx = activeHarnesses.indexOf(this);
    if (idx !== -1) activeHarnesses.splice(idx, 1);
  }

  private readonly dispatch = (
    cmd: string,
    args: Record<string, unknown> = {},
  ): Promise<unknown> => {
    const evt = eventInvoke(this.bus, cmd, args);
    if (evt.handled) return Promise.resolve(evt.result);
    const entry = this.mocks.get(cmd);
    if (!entry) {
      return Promise.reject(new Error(`harness: unmocked IPC command "${cmd}"`));
    }
    const calls = this.callLog.get(cmd) ?? [];
    calls.push({ args });
    this.callLog.set(cmd, calls);
    if (entry.impl) return Promise.resolve(entry.impl(args));
    return Promise.resolve(entry.result);
  };
}

// ─── install() + createHarness() ──────────────────────────────────────────

let installed = false;

/** Bootstrap the fake environment. Idempotent; called from tests/setup.ts
 *  (and lazily by createHarness, so direct runs still work). */
export function install(): void {
  if (installed) return;
  installed = true;

  // jsdom lacks WebCrypto — test randomness does not need a cryptographic source.
  Object.defineProperty(window, "crypto", {
    value: {
      getRandomValues: (b: Uint8Array): Uint8Array => {
        for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256);
        return b;
      },
    },
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

  // @tauri-apps/api/event._unlisten touches this before invoking.
  Object.defineProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", {
    value: { unregisterListener: () => {} },
    configurable: true,
  });

  const internals: TauriInternals = {
    transformCallback: (cb) => {
      const id = ++callbackId;
      callbacks.set(id, cb);
      return id;
    },
    unregisterCallback: (id) => {
      callbacks.delete(id);
    },
    invoke: baselineInvoke,
  };
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: internals,
    configurable: true,
  });

  // Safety net: restore any harness a test forgot to tear down.
  afterEach(() => {
    while (activeHarnesses.length > 0) {
      activeHarnesses[activeHarnesses.length - 1].restore();
    }
  });
}

/** Per-test instance: strict IPC dispatcher + fixtures + mount. */
export function createHarness(): Harness {
  install();
  return new HarnessImpl();
}