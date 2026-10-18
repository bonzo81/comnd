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
 * netssh.log via the `log_frontend` command, fire-and-forget). Tests swap
 * in a capture sink via setSinks() and restore with resetSinks().
 *
 * Redaction: `msg` and the serialized `args` summary are scanned for
 * credential patterns (password / api key, plus the JSON-quoted form they
 * take after serialization). Suggest-tagged records also redact bare
 * single-quoted strings. Redaction happens BEFORE any sink sees the record.
 * `rawArgs` are for devtools only and never persisted; callers must still not
 * log secret objects (devtools shows them raw).
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

function redactSuggestQuotedText(s: string): string {
  const firstQuote = s.indexOf("'");
  if (firstQuote === -1) return s;
  const lastQuote = s.lastIndexOf("'");
  const suffix = lastQuote === firstQuote ? "" : s.slice(lastQuote + 1);
  // Embedded apostrophes make individual quoted spans ambiguous; mask the
  // whole range rather than risk leaving text between matches visible.
  return `${s.slice(0, firstQuote)}'[REDACTED]'${suffix}`;
}

function redact(s: string, tag: LogTag): string {
  const redacted = SECRET_PATTERNS.reduce(
    (acc, [pattern, replacement]) => acc.replace(pattern, replacement),
    s,
  );
  return tag === LogTag.Suggest
    ? redactSuggestQuotedText(redacted)
    : redacted;
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
  return `[netssh:${record.tag}] ${ts} ${record.level.toUpperCase()} ${record.msg}`;
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
    msg: redact(msg, tag),
    rawArgs: args,
    args: redact(serializeArgs(args), tag),
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
