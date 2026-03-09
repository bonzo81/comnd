/**
 * Logger — structured frontend logging for net.sh
 *
 * Usage:
 *   import { log } from '../lib/logger';
 *   log.info('ssh', 'Connected to host');
 *   log.error('ssh', 'Connection failed', err);
 */

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const isDev = import.meta.env.DEV;
const minLevel: LogLevel = isDev ? "debug" : "info";

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel];
}

function format(level: LogLevel, tag: string, msg: string): string {
  return `[net.sh:${tag}] ${level.toUpperCase()} ${msg}`;
}

export const log = {
  debug(tag: string, msg: string, ...args: unknown[]) {
    if (shouldLog("debug")) console.debug(format("debug", tag, msg), ...args);
  },
  info(tag: string, msg: string, ...args: unknown[]) {
    if (shouldLog("info")) console.log(format("info", tag, msg), ...args);
  },
  warn(tag: string, msg: string, ...args: unknown[]) {
    if (shouldLog("warn")) console.warn(format("warn", tag, msg), ...args);
  },
  error(tag: string, msg: string, ...args: unknown[]) {
    if (shouldLog("error")) console.error(format("error", tag, msg), ...args);
  },
};
