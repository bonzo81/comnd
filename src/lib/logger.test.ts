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

  it("redacts quoted spans in Suggest messages before any sink sees them", () => {
    const { records, sink } = capture();
    setSinks([sink]);
    log.debug(LogTag.Suggest, "('secretvalue' != '')");
    expect(records[0].msg).toBe("('[REDACTED]')");
    expect(records[0].msg).not.toContain("secretvalue");
  });

  it.each([
    ["empty quoted pair", "('' != 'secretvalue')"],
    ["embedded apostrophe", "('prefix'secretvalue' != '')"],
  ])("redacts ambiguous quoted values in messages and args (%s)", (_label, text) => {
    const { records, sink } = capture();
    setSinks([sink]);
    log.debug(LogTag.Suggest, text, text);

    expect(records[0].msg).not.toContain("secretvalue");
    expect(records[0].args).not.toContain("secretvalue");
    expect(records[0].msg).toContain("[REDACTED]");
    expect(records[0].args).toContain("[REDACTED]");
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
    expect(records[1].args).toContain("[Circular]");
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
