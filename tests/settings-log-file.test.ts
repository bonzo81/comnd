import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/lib/tauri-api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/tauri-api")>("../src/lib/tauri-api");
  return {
    ...actual,
    setLogFilePath: vi.fn(async () => {}),
    getAppConfig: vi.fn(async () => ({
      ollama_base_url: "http://localhost:11434",
      ollama_model: "llama3.2",
      ollama_api_key: null,
      ollama_context_length: 64000,
      log_level: "info",
      log_max_size_mb: 10,
      log_file_path: null,
    })),
  };
});

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(async () => null),
}));

import { SettingsScreen } from "../src/components/settings-screen";
import { setLogFilePath, getAppConfig, AppConfig } from "../src/lib/tauri-api";

function baseConfig(logFilePath: string | null): AppConfig {
  return {
    ollama_base_url: "http://localhost:11434",
    ollama_model: "llama3.2",
    ollama_api_key: null,
    ollama_context_length: 64000,
    log_level: "info",
    log_max_size_mb: 10,
    log_file_path: logFilePath,
  };
}

async function renderWithConfig(logFilePath: string | null): Promise<HTMLElement> {
  vi.mocked(getAppConfig).mockResolvedValueOnce(baseConfig(logFilePath));
  const container = document.createElement("div");
  document.body.appendChild(container);
  const screen = new SettingsScreen();
  screen.setItem("general");
  await screen.mount(container);
  return container;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("SettingsScreen — log file location", () => {
  it("renders the log file path input with the configured value", async () => {
    const container = await renderWithConfig("/custom/path/netssh.log");
    const input = container.querySelector<HTMLInputElement>("#log-file-path");
    expect(input).not.toBeNull();
    expect(input!.value).toBe("/custom/path/netssh.log");
  });

  it("calls setLogFilePath with the typed value on change", async () => {
    const container = await renderWithConfig(null);
    const input = container.querySelector<HTMLInputElement>("#log-file-path")!;
    input.value = "/tmp/netssh.log";
    input.dispatchEvent(new Event("change"));
    await vi.waitFor(() => {
      expect(setLogFilePath).toHaveBeenCalledWith("/tmp/netssh.log");
    });
  });

  it("calls setLogFilePath(null) when the field is cleared and changed", async () => {
    const container = await renderWithConfig("/custom/path/netssh.log");
    const input = container.querySelector<HTMLInputElement>("#log-file-path")!;
    input.value = "   ";
    input.dispatchEvent(new Event("change"));
    await vi.waitFor(() => {
      expect(setLogFilePath).toHaveBeenCalledWith(null);
    });
  });

  it("calls setLogFilePath(null) and clears the input on reset", async () => {
    const container = await renderWithConfig("/custom/path/netssh.log");
    const input = container.querySelector<HTMLInputElement>("#log-file-path")!;
    const reset = container.querySelector<HTMLButtonElement>("#log-file-reset")!;
    reset.click();
    await vi.waitFor(() => {
      expect(setLogFilePath).toHaveBeenCalledWith(null);
    });
    expect(input.value).toBe("");
  });
});
