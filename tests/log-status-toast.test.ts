import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const statusValue = "Log file could not be opened at the custom path; using the default location.";

vi.mock("../src/lib/tauri-api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/tauri-api")>("../src/lib/tauri-api");
  return {
    ...actual,
    getLogStatus: vi.fn(async () => statusValue),
  };
});

import { showToast } from "../src/lib/toast";
import { listen } from "@tauri-apps/api/event";
import { getLogStatus } from "../src/lib/tauri-api";

// Mirror of App.syncLogStatus() in src/main.ts — the private method is not
// exported, so we exercise the same getLogStatus → showToast wiring here.
async function syncLogStatus() {
  const status = await getLogStatus().catch(() => null);
  if (status) {
    showToast(status, "error", 8000);
  }
  try {
    await listen<string>("log-location-warning", (event) => {
      showToast(event.payload, "error", 8000);
    });
  } catch {
    // Tauri not running (unit test) — ignore
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("syncLogStatus — toast on unreachable custom path", () => {
  it("shows an error toast when getLogStatus returns a message", async () => {
    vi.mocked(getLogStatus).mockResolvedValueOnce(statusValue);
    await syncLogStatus();
    const toast = document.querySelector<HTMLElement>(".toast-error");
    expect(toast).not.toBeNull();
    expect(toast!.textContent).toContain(statusValue);
  });

  it("shows no toast when getLogStatus returns null", async () => {
    vi.mocked(getLogStatus).mockResolvedValueOnce(null);
    await syncLogStatus();
    expect(document.querySelector<HTMLElement>(".toast-error")).toBeNull();
  });
});
