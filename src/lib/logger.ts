/// <reference types="vite/client" />
/**
 * Logger — structured frontend logging for net.sh
 *
 * Usage:
 *   import { log, LogTag } from '../lib/logger';
 *   log.info(LogTag.Ssh, 'Connected to host');
 *   log.error(LogTag.Ssh, 'Connection failed', err);
 *
 * Redaction: `msg` is scanned for credential patterns (password/api key) and
 * redacted. `...args` objects are NOT scanned — callers must not pass secret
 * objects in args.
 *
 * Sinks: console always; in production, `msg` plus a JSON-serialized `...args`
 * summary is forwarded to the Rust logger via the `log_frontend` Tauri command
 * (fire-and-forget). Dev stays console-only to avoid IPC latency in the hot
 * path.
 */

import { invoke } from "@tauri-apps/api/core";

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

// ponytail: regex on msg string only, not recursive over args.
// Upgrade path: structured fields with explicit secret flag.
const SECRET_PATTERNS = [/password\s*[:=]\s*\S+/i, /api[_-]?key\s*[:=]\s*\S+/i];

function redact(s: string): string {
  return SECRET_PATTERNS.reduce((acc, p) => acc.replace(p, "$0[REDACTED]"), s);
}

function format(level: LogLevel, tag: LogTag, msg: string): string {
  const ts = new Date().toISOString();
  return `[net.sh:${tag}] ${ts} ${level.toUpperCase()} ${redact(msg)}`;
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

function forward(level: LogLevel, tag: LogTag, msg: string, args: unknown[]): void {
  if (isDev) return;
  invoke("log_frontend", { level, tag, msg, args: serializeArgs(args) }).catch(() => {});
}

export const log = {
  debug(tag: LogTag, msg: string, ...args: unknown[]) {
    if (shouldLog("debug")) {
      console.debug(format("debug", tag, msg), ...args);
      forward("debug", tag, msg, args);
    }
  },
  info(tag: LogTag, msg: string, ...args: unknown[]) {
    if (shouldLog("info")) {
      console.log(format("info", tag, msg), ...args);
      forward("info", tag, msg, args);
    }
  },
  warn(tag: LogTag, msg: string, ...args: unknown[]) {
    if (shouldLog("warn")) {
      console.warn(format("warn", tag, msg), ...args);
      forward("warn", tag, msg, args);
    }
  },
  error(tag: LogTag, msg: string, ...args: unknown[]) {
    if (shouldLog("error")) {
      console.error(format("error", tag, msg), ...args);
      forward("error", tag, msg, args);
    }
  },
};
