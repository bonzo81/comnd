# Plan: Frontend Logger — One Record, N Sinks

**Status: proposed — not implemented.**

Origin: architecture review of logging (2026-09-19), candidate 2 (Strong).
Self-contained: all findings restated below. Line numbers are as of
2026-09-19 and may drift — re-locate by symbol names.

**Updated 2026-09-21** against `main` @ `45fe61d` (test-harness commit
`tests/harness.ts`): the `"log-location-warning"` listener now has a landed
test asserting its toast behavior, so this plan **keeps** it (P4 withdrawn,
decision 6 reversed), and P5 uses the harness fake instead of `vi.mock`.

## Problem — a credential-leak gap, not tidiness

`src/lib/logger.ts` has two output paths that disagree about redaction:

- The **console** line goes through `format()` (logger.ts:67-70), which calls
  `redact(msg)` — secrets are masked in devtools.
- The **forward** path (`forward()`, logger.ts:92-95) sends the **raw,
  un-redacted** `msg` (plus serialized args) to the Rust `log_frontend`
  Tauri command, which writes it **verbatim** into `comnd.log`
  (`src-tauri/src/config.rs:563-576`).

So `log.error(tag, "password=hunter2 rejected")` prints
`password=[REDACTED]` in devtools but persists `password=hunter2` in
`comnd.log` — the file users attach to bug reports.
`plan-logging-improvements.md` P2.1 intended redaction to cover logging; the
P3.1 forward path bypassed it. The guard protects the sink that doesn't
persist and skips the one that does.

Related friction around the same code (item 3 withdrawn — see its note):

1. **Four `console.error` call sites bypass the logger entirely** (below) —
   they never reach `comnd.log`, carry no tag/timestamp, and can't be
   level-filtered.
2. **`LogTag.Ssh` is dead** (defined logger.ts:27, used only in the header
   doc-comment).
3. ~~`main.ts:244-250` listens for `"log-location-warning"`~~ — originally
   flagged as dead wiring (Rust never emits it), but `main` @ 45fe61d then
   landed a harness test asserting the listener's toast behavior
   (`tests/log-status-toast.test.ts`: "shows an error toast when the backend
   emits log-location-warning"). That ratifies it as intentional
   forward-compatible wiring — this plan now leaves it alone (decision 6).
4. **Zero tests** for `redact()`, `serializeArgs()`, the level gate, or the
   forward payload — there is no seam to test through.

## Goal

| Item | Why |
|---|---|
| Build **one redacted record** per call, then fan out to sinks | Redaction covers every sink, including the persistent one |
| A sink seam (`LogSink` + `setSinks`/`resetSinks`) | First unit tests for redact / serialize / level gate / payload |
| Route the 4 `console.error` bypasses through the logger | Real errors reach `comnd.log` |

## Non-goals

- **Rust-side redaction in `log_frontend`** — rejected: the policy would live
  in two places (TS + Rust) and drift. Redaction belongs at record
  construction, in one place. Rust stays a dumb sink.
- Structured JSON logging, log aggregation (non-goals in
  `plan-logging-improvements.md`).
- The error double-reporting convention (some failures log twice, others
  never — separate review candidate).
- Rust changes of any kind. `log_frontend` is untouched.

## Current state (what we build on)

- **logger.ts** (122 lines): `LogTag` registry (10 tags, `Ssh` unused),
  module-level `minLevel` + `setLogLevel`, two `SECRET_PATTERNS` regexes,
  `redact()` applied **only** inside `format()`, `serializeArgs()`
  (JSON + Error→`"Name: message"` + `[Circular]`), `forward()` (prod-only
  `invoke("log_frontend", …)`, fire-and-forget), and the `log` object with
  `debug/info/warn/error`. Public surface imported elsewhere:
  `log`, `LogTag`, `LogLevel`, `setLogLevel` — keep all exports stable.
- **The four bypass sites** (all are error paths):
  1. `src/main.ts:276` — `console.error("title-bar action failed:", err)`
     inside the title-bar button click try/catch.
  2. `src/main.ts:702-704` — `view.connect(host).catch((err) => {
     console.error("Connect failed:", err); })`. Context: the *primary*
     connect-failure path is already logged by `terminal-view.ts:731`
     (`log.error(LogTag.Terminal, "Connection failed: …")` + error overlay)
     — `TerminalView.connect` catches internally and does not rethrow, so
     this `.catch` is a **safety net** that fires only if `connect` throws
     before its internal try (early setup). Convert it, don't delete it —
     an unhandled rejection is worse than a rare duplicate line.
  3. `src/components/global-search.ts:153` — `console.error("global-search:
     failed to load commands:", err)` in `ensureCommands`.
  4. `src/components/kb-screen.ts:71` — `console.error("Failed to load KB
     platforms:", err)` in `loadPlatforms`.
- **tauri-api.ts**: config/log command wrappers live ~lines 330-360 and
  404-409 (`setLogFilePath`, `getLogStatus`). There is **no** `logFrontend`
  wrapper — logger.ts invokes `@tauri-apps/api/core` directly. tauri-api.ts
  imports only `invoke` (line 6), so logger → tauri-api adds no cycle.
- **Test setup**: vitest (jsdom, globals, `tests/setup.ts`). Since `main`
  @ 45fe61d the fake lives in `tests/harness.ts` — one fake for the Tauri
  IPC seam. `createHarness()` per test swaps in a **strict** dispatcher
  (unmocked commands throw); `h.ipc.mock(cmd, result)` /
  `h.ipc.mockImpl(cmd, impl)` stub commands, `h.ipc.calls(cmd)` returns
  recorded invoke args in order, and `h.emit(event, payload)` dispatches
  events. Everything auto-restores when the test ends; `tests/setup.ts`
  now only installs the lenient baseline bus. Colocated unit tests:
  `src/lib/*.test.ts`; component tests: `tests/`.
- `import.meta.env.DEV` is **true** under vitest (mode `test`) — relevant to
  the sink registration decision below.

## Design decisions (recorded — do not re-litigate)

1. **Redaction happens once, at record construction** — before any sink sees
   the record. Both string fields (`msg`, serialized `args`) are redacted.
2. **`rawArgs` stay console-only.** Devtools keeps rich object inspection
   (today's `console.log(line, ...args)` behavior); the persisted form is
   `record.msg` + `record.args`. Callers must still not pass secret objects —
   devtools shows them raw (documented in the header, as today).
3. **Serialized args are now redacted too.** `{"password":"x"}` does **not**
   match the `key=value` / `key: value` regexes, so two JSON-quoted patterns
   are added. This is cheap insurance on top of the caller-responsibility
   note.
4. **The dev/prod gate moves from per-record to sink registration.**
   Prod default sinks: `[consoleSink, forwardSink]`; dev (and vitest):
   `[consoleSink]`. Same behavior as today (forward was prod-only), one
   check, and `forwardSink` stays directly unit-testable.
5. **main.ts:703 becomes `LogTag.Ssh`** — the connection-lifecycle safety net
   revives the dead tag. Tag assignments: title-bar → `App`,
   global-search → `Kb`, kb-screen → `Kb`.
6. **The `"log-location-warning"` listener stays.** *(Reversed 2026-09-21.)*
   The original proposal removed it as dead wiring (Rust has no emit site;
   the pull model covers the startup-fallback case). But `main` @ 45fe61d
   then landed a harness test asserting the listener's toast behavior —
   treating it as intentional forward-compatible wiring for mid-session
   log moves. Removing it now would break a landed test for a cosmetic
   cleanup. Leave it; revisit only if log-path switching is ever built —
   or explicitly dropped as a feature.

## P1 — `logFrontend` wrapper (`src/lib/tauri-api.ts`)

Add next to the other log wrappers (~line 409, after `getLogStatus`):

```ts
/** Forward a frontend log record to the Rust logger (persisted to comnd.log). */
export function logFrontend(level: string, tag: string, msg: string, args: string): Promise<void> {
  return invoke<void>("log_frontend", { level, tag, msg, args });
}
```

Argument names must match the Rust command parameters exactly
(`config.rs:563`: `level, tag, msg, args`). Rust treats empty `args` as
absent (`config.rs:564-566`), so passing `""` is fine.

## P2 — logger.ts redesign (full replacement file)

```ts
/// <reference types="vite/client" />
/**
 * Logger — one record, N sinks.
 *
 * Usage:
 *   import { log, LogTag } from "../lib/logger";
 *   log.info(LogTag.Ssh, "Connected to host");
 *   log.error(LogTag.Ssh, "Connection failed", err);
 *
 * Every call builds one LogRecord — redaction happens ONCE, at record
 * construction — then the record fans out to the registered sinks. Default
 * sinks: console (always) and forward-to-Rust (production only, persists to
 * comnd.log via the `log_frontend` command, fire-and-forget). Tests swap
 * in a capture sink via setSinks() and restore with resetSinks().
 *
 * Redaction: `msg` and the serialized `args` summary are scanned for
 * credential patterns (password / api key, plus the JSON-quoted form they
 * take after serialization) BEFORE any sink sees the record — the console
 * line and the persisted comnd.log line are both covered. `rawArgs` are
 * for devtools only and never persisted; callers must still not log secret
 * objects (devtools shows them raw).
 */

import { logFrontend } from "./tauri-api";

export type LogLevel = "debug" | "info" | "warn" | "error";

export const LogTag = {
  App: "app",
  Ssh: "ssh",
  Terminal: "terminal",
  Prompt: "prompt",
  Suggest: "suggest",
  Kb: "kb",
  KbImport: "kb-import",
  HostScreen: "host-screen",
  NavPanel: "nav-panel",
  Netbox: "netbox",
} as const;
export type LogTag = (typeof LogTag)[keyof typeof LogTag];

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const isDev = import.meta.env.DEV;
let minLevel: LogLevel = isDev ? "debug" : "info";

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel];
}

// ponytail: regex on msg + serialized args, not recursive over raw objects.
// Upgrade path: structured fields with explicit secret flag.
const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(password\s*[:=]\s*)\S+/gi, "$1[REDACTED]"],
  [/(api[_-]?key\s*[:=]\s*)\S+/gi, "$1[REDACTED]"],
  // JSON-quoted form after serializeArgs: {"password":"hunter2"}
  [/("password"\s*:\s*")[^"]*"/gi, '$1[REDACTED]"'],
  [/("api[_-]?key"\s*:\s*")[^"]*"/gi, '$1[REDACTED]"'],
];

function redact(s: string): string {
  return SECRET_PATTERNS.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), s);
}

// ponytail: JSON.stringify + Error name/message only. Circular refs → "[Circular]".
// Upgrade path: custom serializer with depth limit if args get richer.
function serializeArgs(args: unknown[]): string {
  if (args.length === 0) return "";
  try {
    const seen = new WeakSet();
    const json = JSON.stringify(args, (_k, v) => {
      if (typeof v === "object" && v !== null) {
        if (seen.has(v)) return "[Circular]";
        seen.add(v);
      }
      if (v instanceof Error) return `${v.name}: ${v.message}`;
      return v;
    });
    return json ?? String(args[0]);
  } catch {
    return args.map((a) => String(a)).join(" ");
  }
}

/** One log entry, built once per call. Both string fields are redacted. */
export interface LogRecord {
  level: LogLevel;
  tag: LogTag;
  /** Redacted message — safe for every sink. */
  msg: string;
  /** Original args — console/devtools only, never persisted. */
  rawArgs: unknown[];
  /** Serialized + redacted args summary — safe for every sink ("" if none). */
  args: string;
}

export type LogSink = (record: LogRecord) => void;

function format(record: LogRecord): string {
  const ts = new Date().toISOString();
  return `[comnd:${record.tag}] ${ts} ${record.level.toUpperCase()} ${record.msg}`;
}

export const consoleSink: LogSink = (record) => {
  const line = format(record);
  switch (record.level) {
    case "debug": console.debug(line, ...record.rawArgs); break;
    case "info": console.log(line, ...record.rawArgs); break;
    case "warn": console.warn(line, ...record.rawArgs); break;
    case "error": console.error(line, ...record.rawArgs); break;
  }
};

export const forwardSink: LogSink = (record) => {
  // Fire-and-forget: logging must never break the caller.
  logFrontend(record.level, record.tag, record.msg, record.args).catch(() => {});
};

function defaultSinks(): LogSink[] {
  return isDev ? [consoleSink] : [consoleSink, forwardSink];
}

let sinks: LogSink[] = defaultSinks();

/** Test-only: replace the sink list (e.g. a capture sink). Pair with resetSinks(). */
export function setSinks(next: LogSink[]): void {
  sinks = next;
}

/** Test-only: restore the default sink list. */
export function resetSinks(): void {
  sinks = defaultSinks();
}

function emit(level: LogLevel, tag: LogTag, msg: string, args: unknown[]): void {
  if (!shouldLog(level)) return;
  const record: LogRecord = {
    level,
    tag,
    msg: redact(msg),
    rawArgs: args,
    args: redact(serializeArgs(args)),
  };
  for (const sink of sinks) {
    sink(record);
  }
}

export const log = {
  debug(tag: LogTag, msg: string, ...args: unknown[]) {
    emit("debug", tag, msg, args);
  },
  info(tag: LogTag, msg: string, ...args: unknown[]) {
    emit("info", tag, msg, args);
  },
  warn(tag: LogTag, msg: string, ...args: unknown[]) {
    emit("warn", tag, msg, args);
  },
  error(tag: LogTag, msg: string, ...args: unknown[]) {
    emit("error", tag, msg, args);
  },
};
```

Behavior deltas vs today (all intended):

- Persisted `[fe:…]` lines in `comnd.log` are now redacted (the fix).
- Dev console output is byte-identical to today (same format, same spread
  args, same level gate).
- The forward gate is evaluated once at registration instead of per record
  — invisible to behavior, cheaper.

## P3 — Route the four bypasses through the logger

All four keep their exact message text so log grepping stays stable.

**1. `src/main.ts:276`** (title-bar button try/catch; `log`/`LogTag` already
imported at main.ts:11):

```ts
        } catch (err) {
          log.error(LogTag.App, "title-bar action failed:", err);
        }
```

**2. `src/main.ts:702-704`** (connect safety net — see Current state for why
this is a conversion, not a deletion):

```ts
    view.connect(host).catch((err) => {
      // Safety net: TerminalView.connect logs its primary failure path
      // (terminal-view.ts "Connection failed: …"). This fires only if it
      // throws before that — LogTag.Ssh marks the connection lifecycle.
      log.error(LogTag.Ssh, "Connect failed:", err);
    });
```

**3. `src/components/global-search.ts:153`** — add
`import { log, LogTag } from "../lib/logger";` alongside the existing
imports, then:

```ts
    } catch (err) {
      log.error(LogTag.Kb, "global-search: failed to load commands:", err);
      this.allCommands = [];
```

**4. `src/components/kb-screen.ts:71`** — add the same import, then:

```ts
    } catch (err) {
      log.error(LogTag.Kb, "Failed to load KB platforms:", err);
    }
```

## P4 — `"log-location-warning"` listener: **no change** (withdrawn 2026-09-21)

The original proposal removed the listener and its test mirror as dead
wiring. Then `main` @ 45fe61d landed a harness test asserting the
listener's toast behavior ("shows an error toast when the backend emits
log-location-warning"), ratifying it as intentional forward-compatible
wiring for mid-session log moves. Do **not** touch
`src/main.ts syncLogStatus()` or `tests/log-status-toast.test.ts`.
This plan's code scope is P1–P3 + P5.

## P5 — Tests: `src/lib/logger.test.ts` (new)

```ts
/**
 * Unit tests for the logger — one record, N sinks.
 * Capture sinks exercise the record contract; the real sinks are tested
 * separately (consoleSink via console spy, forwardSink through the
 * harness IPC fake — which also covers the real tauri-api wrapper).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  log,
  LogTag,
  setLogLevel,
  setSinks,
  resetSinks,
  consoleSink,
  forwardSink,
  type LogRecord,
  type LogSink,
} from "./logger";
import { createHarness } from "../../tests/harness";

function capture(): { records: LogRecord[]; sink: LogSink } {
  const records: LogRecord[] = [];
  return { records, sink: (r) => records.push(r) };
}

const record = (over: Partial<LogRecord>): LogRecord => ({
  level: "error",
  tag: LogTag.App,
  msg: "msg",
  rawArgs: [],
  args: "",
  ...over,
});

beforeEach(() => {
  resetSinks();
  setLogLevel("debug");
});

afterEach(() => {
  resetSinks();
  setLogLevel("debug");
  vi.restoreAllMocks();
});

describe("record construction", () => {
  it("redacts password= in msg before any sink sees it", () => {
    const { records, sink } = capture();
    setSinks([sink]);
    log.error(LogTag.App, "auth failed password=hunter2");
    expect(records[0].msg).toBe("auth failed password=[REDACTED]");
  });

  it("redacts api_key: form and JSON-quoted args", () => {
    const { records, sink } = capture();
    setSinks([sink]);
    log.info(LogTag.App, "api_key: abc123", { password: "hunter2", api_key: "xyz" });
    expect(records[0].msg).toBe("api_key: [REDACTED]");
    expect(records[0].args).toContain('"password":"[REDACTED]"');
    expect(records[0].args).not.toContain("hunter2");
    expect(records[0].args).toContain('"api_key":"[REDACTED]"');
    expect(records[0].args).not.toContain('"xyz"');
  });

  it("leaves clean messages untouched and keeps rawArgs raw", () => {
    const { records, sink } = capture();
    setSinks([sink]);
    const obj = { a: 1 };
    log.info(LogTag.Ssh, "Connected", obj);
    expect(records[0].msg).toBe("Connected");
    expect(records[0].rawArgs).toEqual([obj]);
  });

  it("serializes Error args as name: message and marks circular refs", () => {
    const { records, sink } = capture();
    setSinks([sink]);
    log.warn(LogTag.App, "boom", new TypeError("nope"));
    expect(records[0].args).toContain("TypeError: nope");

    const circ: Record<string, unknown> = {};
    circ.self = circ;
    log.warn(LogTag.App, "circ", circ);
    expect(records[0].args).toContain("[Circular]");
  });

  it("serializes nothing when there are no args", () => {
    const { records, sink } = capture();
    setSinks([sink]);
    log.info(LogTag.App, "plain");
    expect(records[0].args).toBe("");
  });

  it("filters below the configured level", () => {
    const { records, sink } = capture();
    setSinks([sink]);
    setLogLevel("error");
    log.info(LogTag.App, "hidden");
    expect(records).toHaveLength(0);
    log.error(LogTag.App, "shown");
    expect(records).toHaveLength(1);
  });

  it("delivers the same record to every registered sink", () => {
    const a = capture();
    const b = capture();
    setSinks([a.sink, b.sink]);
    log.debug(LogTag.Suggest, "once");
    expect(a.records[0]).toEqual(b.records[0]);
    expect(a.records[0].tag).toBe("suggest");
  });
});

describe("sinks", () => {
  it("forwardSink sends the redacted record through the IPC seam", () => {
    const h = createHarness();
    // Strict dispatcher: unmocked commands throw — forwardSink's
    // .catch(() => {}) swallows that, so a forgotten mock shows up as zero
    // recorded calls, not a failure. Always mock log_frontend first.
    h.ipc.mock("log_frontend", undefined);
    forwardSink(record({ level: "error", tag: LogTag.Ssh, msg: "password=[REDACTED]", args: "" }));
    const calls = h.ipc.calls("log_frontend");
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual({
      level: "error",
      tag: "ssh",
      msg: "password=[REDACTED]",
      args: "",
    });
  });

  it("consoleSink writes the formatted, redacted line", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleSink(record({ level: "info", tag: LogTag.App, msg: "hello password=[REDACTED]" }));
    expect(spy).toHaveBeenCalledTimes(1);
    const line = spy.mock.calls[0][0] as string;
    expect(line).toContain("[comnd:app]");
    expect(line).toContain("INFO");
    expect(line).toContain("hello password=[REDACTED]");
  });
});
```

Notes:

- `createHarness()` (from `tests/harness.ts`; import path from `src/lib` is
  `../../tests/harness`) fakes the whole IPC seam, so the sink test
  exercises the real `tauri-api.ts` `logFrontend` wrapper instead of a
  module mock. The harness auto-restores when the test ends.
- The harness dispatcher is strict: unmocked commands throw, and
  `forwardSink`'s `.catch(() => {})` swallows the rejection — mock
  `log_frontend` before triggering any forward path.
- Because `import.meta.env.DEV` is true under vitest, the default sink list
  is console-only; tests install capture sinks explicitly, so nothing leaks
  into test output except the two direct sink tests, which spy the console.

## Verification

1. `npm run build` — exit 0 (runs `tsc`; strict mode).
2. `npm run test` — exit 0 (new `logger.test.ts` + all existing suites).
3. Grep for regressions: `grep -rn "console\.\(log\|warn\|error\|info\|debug\)" src/`
   should now match only `src/lib/logger.ts` (the consoleSink).
4. Optional manual (release build): trigger a frontend error (e.g. point the
   app at an unreachable KB path), then confirm the `[fe:…]` line in
   `comnd.log` — and that a `password=…` test message shows up as
   `password=[REDACTED]` in the file.

## Files touched

| File | Change |
|---|---|
| `src/lib/logger.ts` | Full redesign: `LogRecord`, `LogSink`, `consoleSink`/`forwardSink` exports, `setSinks`/`resetSinks`, redaction at record construction, JSON-quoted secret patterns |
| `src/lib/tauri-api.ts` | New `logFrontend` wrapper (placed with the other log wrappers) |
| `src/main.ts` | 2 bypass conversions (title-bar → `App`, connect net → `Ssh`); `syncLogStatus` unchanged (P4 withdrawn) |
| `src/components/global-search.ts` | Bypass conversion → `LogTag.Kb` + import |
| `src/components/kb-screen.ts` | Bypass conversion → `LogTag.Kb` + import |
| `src/lib/logger.test.ts` | **New** — record contract, redaction, serialization, level gate, sinks (harness idiom) |

## Open questions (resolved)

- Rust-side redaction — rejected (single source of truth; see Non-goals).
- `main.ts:703` convert vs delete — convert (safety net; the primary path is
  logged by terminal-view, this covers throws before its internal try).
- Listener removal — **withdrawn 2026-09-21**: `main` @ 45fe61d landed a
  harness test exercising the listener; it stays (decision 6).
- Tag assignments — `Ssh` for the connect net (revives the dead tag), `App`
  for title-bar, `Kb` for both KB-loading failures.
- Dev gate placement — registration-time (per-plan decision 4).