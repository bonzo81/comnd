import { describe, it, expect, vi } from "vitest";
import { createHarness, Harness } from "./harness";
import { SettingsScreen } from "../src/components/settings-screen";

async function renderLoggingItem(
  logFilePath: string | null,
): Promise<{ h: Harness; container: HTMLElement }> {
  const h = createHarness();
  const config = h.fixtures.appConfig({ log_file_path: logFilePath });
  h.ipc.mock("get_app_config", config);
  h.ipc.mock("get_session_log_dir", "");
  // Backend semantics: the saved setting is the store of truth, so the
  // screen's post-save refreshConfig() sees the value it just sent.
  h.ipc.mockImpl("set_log_file_path", (args) => {
    config.log_file_path = args.path as string | null;
  });
  const container = h.mount();
  const screen = new SettingsScreen();
  screen.setItem("logging");
  await screen.mount(container);
  return { h, container };
}

describe("SettingsScreen — log file location", () => {
  it("renders the log file path input with the configured value", async () => {
    const { container } = await renderLoggingItem("/custom/path/comnd.log");
    const input = container.querySelector<HTMLInputElement>("#log-file-path");
    expect(input).not.toBeNull();
    expect(input!.value).toBe("/custom/path/comnd.log");
  });

  it("sends the typed value over IPC on change", async () => {
    const { h, container } = await renderLoggingItem(null);
    const input = container.querySelector<HTMLInputElement>("#log-file-path")!;
    input.value = "/tmp/comnd.log";
    input.dispatchEvent(new Event("change"));
    await vi.waitFor(() => {
      expect(h.ipc.calls("set_log_file_path")).toEqual([{ args: { path: "/tmp/comnd.log" } }]);
    });
  });

  it("sends null when the field is cleared and changed", async () => {
    const { h, container } = await renderLoggingItem("/custom/path/comnd.log");
    const input = container.querySelector<HTMLInputElement>("#log-file-path")!;
    input.value = "   ";
    input.dispatchEvent(new Event("change"));
    await vi.waitFor(() => {
      expect(h.ipc.calls("set_log_file_path")).toEqual([{ args: { path: null } }]);
    });
  });

  it("sends null and clears the input on reset", async () => {
    const { h, container } = await renderLoggingItem("/custom/path/comnd.log");
    const input = container.querySelector<HTMLInputElement>("#log-file-path")!;
    container.querySelector<HTMLButtonElement>("#log-file-reset")!.click();
    await vi.waitFor(() => {
      expect(h.ipc.calls("set_log_file_path")).toEqual([{ args: { path: null } }]);
    });
    expect(input.value).toBe("");
  });
});