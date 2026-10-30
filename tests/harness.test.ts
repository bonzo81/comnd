import { describe, it, expect } from "vitest";
import { createHarness } from "./harness";
import { listen, emit } from "@tauri-apps/api/event";
import { getHosts, setLogLevel } from "../src/lib/tauri-api";

// The harness is the highest-leverage module in the suite â€” its interface
// is the test surface, so it gets the same treatment (plan-test-harness.md).
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