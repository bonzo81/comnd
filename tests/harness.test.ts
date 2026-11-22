import { describe, it, expect, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TERMINAL_MEMBERS, command, createHarness, createTerminalFake } from "./harness";
import { listen, emit } from "@tauri-apps/api/event";
import { getHosts, setLogLevel } from "../src/lib/tauri-api";

// The harness is the highest-leverage module in the suite â€” its interface
// is the test surface, so it gets the same treatment
// (docs/plans/054-plan-test-harness.md).
// Two pins at the bottom are order-dependent on purpose: they prove the
// previous test's harness (and mount) were cleaned up automatically.
describe("test harness", () => {
  it("throws on an unmocked command, naming it", async () => {
    createHarness();
    await expect(getHosts()).rejects.toThrow('harness: unmocked IPC command "get_hosts"');
  });

  it("resolves a mocked command with the given result", async () => {
    const h = createHarness();
    h.ipc.mock("get_hosts", [h.fixtures.host({ id: "core-rtr", display_name: "core-rtr" })]);
    const hosts = await getHosts();
    expect(hosts).toHaveLength(1);
    expect(hosts[0].display_name).toBe("core-rtr");
  });

  it("treats an explicit undefined mock as a void command", async () => {
    const h = createHarness();
    h.ipc.mock("set_log_level", undefined);
    await expect(setLogLevel("debug")).resolves.toBeUndefined();
    expect(h.ipc.calls("set_log_level")).toEqual([{ args: { level: "debug" } }]);
  });

  it("mockImpl computes from args, and calls are recorded in order", async () => {
    const h = createHarness();
    h.ipc.mockImpl("set_log_level", (args) => args.level);
    await setLogLevel("debug");
    await setLogLevel("info");
    expect(h.ipc.calls("set_log_level")).toEqual([
      { args: { level: "debug" } },
      { args: { level: "info" } },
    ]);
  });

  it("emit() reaches listeners registered through the real listen()", async () => {
    const h = createHarness();
    const seen: unknown[] = [];
    await listen("import-progress", (e) => seen.push(e.payload));
    h.emit("import-progress", { phase: "parse" });
    expect(seen).toEqual([{ phase: "parse" }]);
  });

  it("the real emit() dispatches through an active harness", async () => {
    const h = createHarness();
    const seen: unknown[] = [];
    await listen("import-progress", (e) => seen.push(e.payload));
    await emit("import-progress", "done");
    expect(seen).toEqual(["done"]);
  });

  it("fixture factories produce schema-true wire objects", () => {
    const h = createHarness();
    const expectedConfigKeys = [
      "llm_api_key",
      "llm_api_format",
      "llm_base_url",
      "llm_context_length",
      "llm_model",
      "log_file_path",
      "log_level",
      "log_max_size_mb",
      "max_sessions",
      "duplicate_session_policy",
      "session_log_dir",
      "session_log_timestamps",
      "session_logging",
    ];
    expect(Object.keys(h.fixtures.appConfig()).sort()).toEqual(expectedConfigKeys.sort());
    expect(h.fixtures.host().platform).toBe("linux-bash");
    expect(h.fixtures.hostGroup().name).toBe("Test Group");
    expect(h.fixtures.command("show version").syntax).toBe("show version");
  });

  it("a fixture is usable without createHarness()", () => {
    // Direct import, no harness: the factory must not need the IPC dispatcher.
    const c = command("show version");
    expect(c.name).toBe("show version");
    expect(c.syntax).toBe("show version");
    expect(c.mode).toBe("bash");
  });

  it("mount() attaches a container for the test's lifetime", () => {
    const h = createHarness();
    const el = h.mount();
    expect(document.body.contains(el)).toBe(true);
  });

  it("mounted containers are removed after the test that created them", () => {
    // Order-dependent pin: proves the previous test's mount() was cleaned up.
    expect(document.body.children).toHaveLength(0);
  });

  it("a harness stops leaking once its test ends", () => {
    // Creates a harness without mocking anything; the NEXT test proves the
    // baseline bus came back (a leaked strict dispatcher would throw).
    createHarness();
  });

  it("the baseline bus stays lenient without a harness", async () => {
    // Order-dependent pin: proves auto-restore from the previous test.
    await expect(getHosts()).resolves.toBeUndefined();
  });
});

/** Re-derive the Terminal members the app touches straight from `src`, so
 *  adding a member to product code fails the pin below instead of drifting. */
function srcTerminalMembers(): string[] {
  const found = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        const source = readFileSync(path, "utf8");
        for (const match of source.matchAll(/terminal[!?]?\.([A-Za-z_$][\w$]*)/g)) {
          found.add(match[1]);
        }
      }
    }
  };
  walk(join(process.cwd(), "src"));
  return [...found].sort();
}

describe("terminal fake", () => {
  it("pins every Terminal member the app touches", () => {
    expect([...TERMINAL_MEMBERS].sort()).toEqual([
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
    ]);
  });

  it("matches the members src actually uses", () => {
    const fake = createTerminalFake();
    expect([...TERMINAL_MEMBERS].sort()).toEqual(srcTerminalMembers());
    for (const member of TERMINAL_MEMBERS) {
      expect(fake.terminal).toHaveProperty(member);
    }
  });

  it("write records, calls its completion callback, and advances lines", () => {
    const fake = createTerminalFake({ rows: 10, cols: 20 });
    const done = vi.fn();

    fake.terminal.write("hello\r\nworld", done);

    expect(fake.written).toEqual(["hello\r\nworld"]);
    expect(done).toHaveBeenCalledTimes(1);
    expect(fake.buffer).toMatchObject({ cursorX: 5, cursorY: 1, baseY: 0 });
  });

  it("does not advance the cursor for ANSI escapes", () => {
    const fake = createTerminalFake();
    fake.terminal.write("\x1b[?25l");
    fake.terminal.write("\x1b[?25h");
    expect(fake.buffer.cursorX).toBe(0);
    expect(fake.buffer.cursorY).toBe(0);
  });

  it("exposes mutable buffer, rows, cols and options through the Terminal", () => {
    const fake = createTerminalFake();

    fake.buffer.cursorX = 7;
    expect(fake.terminal.buffer.active.cursorX).toBe(7);

    fake.rows = 12;
    fake.cols = 40;
    expect(fake.terminal.rows).toBe(12);
    expect(fake.terminal.cols).toBe(40);

    fake.options.fontSize = 18;
    expect(fake.terminal.options.fontSize).toBe(18);

    fake.options = { lineHeight: 1.4 };
    expect(fake.terminal.options.lineHeight).toBe(1.4);
  });

  it("returns a disposable from every event subscription", () => {
    const fake = createTerminalFake();
    const seen: unknown[] = [];

    const data = fake.terminal.onData((d) => seen.push(d));
    const resize = fake.terminal.onResize((s) => seen.push(s));
    const scroll = fake.terminal.onScroll((y) => seen.push(y));
    const selection = fake.terminal.onSelectionChange(() => seen.push("selection"));

    fake.emitData("a");
    fake.emitResize(40, 12);
    fake.emitScroll(3);
    fake.emitSelectionChange();
    expect(seen).toEqual(["a", { cols: 40, rows: 12 }, 3, "selection"]);

    for (const disposable of [data, resize, scroll, selection]) disposable.dispose();
    fake.emitData("b");
    expect(seen).toHaveLength(4);
  });

  it("records addons and keeps the custom key handler", () => {
    const fake = createTerminalFake();
    const addon = { activate: () => {}, dispose: () => {} };
    fake.terminal.loadAddon(addon);
    expect(fake.addons).toEqual([addon]);

    fake.terminal.attachCustomKeyEventHandler(() => false);
    expect(fake.handleKey(new KeyboardEvent("keydown"))).toBe(false);
  });

  it("returns a renderable decoration that disposes", () => {
    const fake = createTerminalFake();
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    fake.terminal.open(parent);

    const marker = fake.terminal.registerMarker(-1)!;
    const decoration = fake.terminal.registerDecoration({ marker, x: 0, width: 1 })!;
    let rendered: HTMLElement | null = null;
    decoration.onRender((el) => {
      rendered = el;
    });

    expect(rendered).toBe(decoration.element);
    expect(parent.contains(decoration.element!)).toBe(true);
    expect(decoration.isDisposed).toBe(false);

    decoration.dispose();
    expect(decoration.isDisposed).toBe(true);
    expect(parent.contains(decoration.element!)).toBe(false);

    fake.terminal.dispose();
    parent.remove();
  });
});
