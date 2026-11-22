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
 * createTerminalFake() — the single test-owned stand-in for xterm's
 *                   `Terminal`: the members src uses, plus the buffer
 *                   geometry ghost text and timestamps read. Holds the
 *                   module's one cast past xterm's interface (issue #182).
 *
 * Design: docs/plans/054-plan-test-harness.md · term: CONTEXT.md ("Test harness").
 */
import { afterEach, vi } from "vitest";
import type { ITerminalOptions, Terminal } from "@xterm/xterm";
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

/** Exported on their own so a test can take a fixture without swapping the
 *  IPC dispatcher. They are the only fixture literals in the suite. */
export function host(overrides: Partial<Host> = {}): Host {
  return {
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
  };
}

export function hostGroup(overrides: Partial<HostGroup> = {}): HostGroup {
  return {
    id: "g-1",
    name: "Test Group",
    parent_id: null,
    sort_order: 0,
    color: null,
    icon: null,
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function command(name: string, overrides: Partial<Command> = {}): Command {
  return {
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
  };
}

export function appConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
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
  };
}

function makeFactories(): FixtureFactories {
  return { host, hostGroup, command, appConfig };
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

/** Minimal in-memory Storage, so tests never depend on the platform's. */
function createStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length(): number {
      return items.size;
    },
    key: (index: number) => [...items.keys()][index] ?? null,
    getItem: (key: string) => items.get(String(key)) ?? null,
    setItem: (key: string, value: string) => {
      items.set(String(key), String(value));
    },
    removeItem: (key: string) => {
      items.delete(String(key));
    },
    clear: () => {
      items.clear();
    },
  } as Storage;
}

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

  // Web Storage: Node 26 defines these globals itself and leaves
  // `localStorage` undefined unless the process was started with
  // --localstorage-file. Vitest's jsdom environment skips globals that already
  // exist, so the app would see the unusable one. Install an in-memory Storage
  // either way, so behaviour does not depend on the Node version.
  for (const key of ["localStorage", "sessionStorage"] as const) {
    Object.defineProperty(globalThis, key, {
      value: createStorage(),
      configurable: true,
      writable: true,
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

// ─── Terminal fake ────────────────────────────────────────────────────────

/** Every `Terminal` member the app touches (derived from `src`, not from the
 *  xterm interface, which is hundreds wide). `tests/harness.test.ts`
 *  re-derives the list from `src`, so a member added to the app fails there
 *  instead of drifting silently. */
export const TERMINAL_MEMBERS = [
  "attachCustomKeyEventHandler",
  "buffer",
  "clear",
  "clearSelection",
  "cols",
  "dispose",
  "element",
  "focus",
  "getSelection",
  "loadAddon",
  "onData",
  "onResize",
  "onScroll",
  "onSelectionChange",
  "open",
  "options",
  "registerDecoration",
  "registerMarker",
  "rows",
  "write",
] as const;

/** The parts of `terminal.buffer.active` the app reads. */
export interface TerminalBufferState {
  cursorX: number;
  cursorY: number;
  baseY: number;
}

export interface TerminalFakeOptions {
  rows?: number;
  cols?: number;
  cursorX?: number;
  cursorY?: number;
  baseY?: number;
  options?: ITerminalOptions;
}

interface Disposable {
  dispose(): void;
}

export interface TerminalFake {
  /** The terminal as the app sees it — pass to code typed against `Terminal`
   *  with no cast at the call site. */
  readonly terminal: Terminal;
  /** The live `terminal.buffer.active`; mutate it to move the cursor. */
  readonly buffer: TerminalBufferState;
  rows: number;
  cols: number;
  options: ITerminalOptions;
  /** Everything written through the terminal, in order. */
  readonly written: string[];
  /** Addons passed to `loadAddon`, in order. */
  readonly addons: readonly unknown[];
  emitData(data: string): void;
  emitResize(cols: number, rows: number): void;
  emitScroll(y: number): void;
  emitSelectionChange(): void;
  /** Run the handler registered through `attachCustomKeyEventHandler`
   *  (defaults to `true`, i.e. xterm would handle the key). */
  handleKey(e: KeyboardEvent): boolean;
}

type DataHandler = (data: string) => void;
type ResizeHandler = (size: { cols: number; rows: number }) => void;
type ScrollHandler = (newPosition: number) => void;
type SelectionHandler = () => void;

function subscribe<T>(handlers: Set<T>, handler: T): Disposable {
  handlers.add(handler);
  return { dispose: () => handlers.delete(handler) };
}

/** One fake for every test that needs a screen; see issue #182. The repo's
 *  single cast past xterm's interface lives here. */
export function createTerminalFake(init: TerminalFakeOptions = {}): TerminalFake {
  const buffer: TerminalBufferState = {
    cursorX: init.cursorX ?? 0,
    cursorY: init.cursorY ?? 0,
    baseY: init.baseY ?? 0,
  };
  let rows = init.rows ?? 24;
  let cols = init.cols ?? 80;
  let options: ITerminalOptions = init.options ?? {};

  const written: string[] = [];
  const addons: unknown[] = [];
  const dataHandlers = new Set<DataHandler>();
  const resizeHandlers = new Set<ResizeHandler>();
  const scrollHandlers = new Set<ScrollHandler>();
  const selectionHandlers = new Set<SelectionHandler>();

  let customKeyHandler: ((e: KeyboardEvent) => boolean) | null = null;
  let selection = "";
  let root: HTMLElement | null = null;
  const decorationElements: HTMLElement[] = [];

  const lineFeed = (): void => {
    if (buffer.cursorY < rows - 1) buffer.cursorY++;
    else buffer.baseY++;
  };

  /** Advance the cursor the way xterm's parser would for the constructs the
   *  app writes: printable text, CR/LF/BS/TAB and ANSI escapes (which are
   *  control sequences, not text — the cursor-hide/show writes must not move
   *  it). */
  const advanceCursor = (text: string): void => {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === "\x1b") {
        const next = text[i + 1];
        if (next === "[") {
          i += 2;
          while (i < text.length) {
            const code = text.charCodeAt(i);
            if (code >= 0x40 && code <= 0x7e) break; // CSI final byte
            i++;
          }
        } else if (next === "]") {
          i += 2;
          while (i < text.length && text[i] !== "\x07" && !(text[i] === "\x1b" && text[i + 1] === "\\")) i++;
          if (text[i] === "\x1b") i++;
        } else {
          i++; // two-character escape
        }
        continue;
      }
      if (ch === "\r") {
        buffer.cursorX = 0;
      } else if (ch === "\n") {
        lineFeed();
      } else if (ch === "\b") {
        if (buffer.cursorX > 0) buffer.cursorX--;
      } else if (ch === "\t") {
        buffer.cursorX = Math.min(cols - 1, (Math.floor(buffer.cursorX / 8) + 1) * 8);
      } else if (text.charCodeAt(i) >= 0x20 && text.charCodeAt(i) !== 0x7f) {
        buffer.cursorX++;
        if (buffer.cursorX >= cols) {
          buffer.cursorX = 0;
          lineFeed();
        }
      }
    }
  };

  const write = vi.fn((data: string | Uint8Array, callback?: () => void): void => {
    const text = typeof data === "string" ? data : new TextDecoder().decode(data);
    written.push(text);
    advanceCursor(text);
    callback?.();
  });

  const open = (parent: HTMLElement): void => {
    root = document.createElement("div");
    root.className = "xterm";
    parent.appendChild(root);
  };

  const disposeDecorations = (): void => {
    for (const el of decorationElements.splice(0)) el.remove();
  };

  const clear = (): void => {
    disposeDecorations();
    selection = "";
  };

  const registerMarker = (_cursorYOffset: number) => ({
    dispose: () => {},
    isDisposed: false,
  });

  const registerDecoration = (_decorationOptions: unknown) => {
    const element = document.createElement("div");
    (root ?? document.body).appendChild(element);
    decorationElements.push(element);
    let disposed = false;
    return {
      element,
      get isDisposed(): boolean {
        return disposed;
      },
      onRender(listener: (el: HTMLElement) => void): Disposable {
        listener(element);
        return { dispose: () => {} };
      },
      dispose(): void {
        if (disposed) return;
        disposed = true;
        element.remove();
      },
    };
  };

  const dispose = (): void => {
    disposeDecorations();
    root?.remove();
    root = null;
    dataHandlers.clear();
    resizeHandlers.clear();
    scrollHandlers.clear();
    selectionHandlers.clear();
    selection = "";
  };

  const target = {
    buffer: { active: buffer },
    get rows(): number {
      return rows;
    },
    set rows(value: number) {
      rows = value;
    },
    get cols(): number {
      return cols;
    },
    set cols(value: number) {
      cols = value;
    },
    get options(): ITerminalOptions {
      return options;
    },
    set options(value: ITerminalOptions) {
      options = value;
    },
    get element(): HTMLElement | undefined {
      return root ?? undefined;
    },
    write,
    open,
    focus: () => {},
    loadAddon: (addon: unknown): void => {
      addons.push(addon);
    },
    onData: (handler: DataHandler) => subscribe(dataHandlers, handler),
    onResize: (handler: ResizeHandler) => subscribe(resizeHandlers, handler),
    onScroll: (handler: ScrollHandler) => subscribe(scrollHandlers, handler),
    onSelectionChange: (handler: SelectionHandler) => subscribe(selectionHandlers, handler),
    attachCustomKeyEventHandler: (handler: (e: KeyboardEvent) => boolean): void => {
      customKeyHandler = handler;
    },
    getSelection: (): string => selection,
    clearSelection: (): void => {
      selection = "";
    },
    clear,
    registerMarker,
    registerDecoration,
    dispose,
  };

  // The one cast: xterm's interface is hundreds of members wide, and only the
  // ones above are real. Everything else is left absent on purpose.
  const terminal = target as unknown as Terminal;

  return {
    terminal,
    buffer,
    get rows(): number {
      return rows;
    },
    set rows(value: number) {
      rows = value;
    },
    get cols(): number {
      return cols;
    },
    set cols(value: number) {
      cols = value;
    },
    get options(): ITerminalOptions {
      return options;
    },
    set options(value: ITerminalOptions) {
      options = value;
    },
    written,
    addons,
    emitData: (data: string): void => {
      for (const handler of [...dataHandlers]) handler(data);
    },
    emitResize: (nextCols: number, nextRows: number): void => {
      for (const handler of [...resizeHandlers]) handler({ cols: nextCols, rows: nextRows });
    },
    emitScroll: (y: number): void => {
      for (const handler of [...scrollHandlers]) handler(y);
    },
    emitSelectionChange: (): void => {
      for (const handler of [...selectionHandlers]) handler();
    },
    handleKey: (e: KeyboardEvent): boolean => (customKeyHandler ? customKeyHandler(e) : true),
  };
}
