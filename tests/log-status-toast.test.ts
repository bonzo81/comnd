import { describe, it, expect, afterEach } from "vitest";
import { createHarness, Harness } from "./harness";
import { showToast } from "../src/lib/toast";
import { listen } from "@tauri-apps/api/event";
import { getLogStatus } from "../src/lib/tauri-api";

const statusValue = "Log file could not be opened at the custom path; using the default location.";

// Mirror of App.syncLogStatus() in src/main.ts — the private method is not
// exported, so we exercise the same getLogStatus → showToast wiring here.
// (The screen lifecycle interface — review candidate 4 — will retire this copy.)
async function syncLogStatus() {
  const status = await getLogStatus().catch(() => null);
  if (status) {
    showToast(status, "error", 8000);
  }
  await listen<string>("log-location-warning", (event) => {
    showToast(event.payload, "error", 8000);
  });
}

function makeHarness(logStatus: string | null): Harness {
  const h = createHarness();
  h.ipc.mock("get_log_status", logStatus);
  return h;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("syncLogStatus — toast on unreachable custom path", () => {
  it("shows an error toast when getLogStatus returns a message", async () => {
    makeHarness(statusValue);
    await syncLogStatus();
    const toast = document.querySelector<HTMLElement>(".toast-error");
    expect(toast).not.toBeNull();
    expect(toast!.textContent).toContain(statusValue);
  });

  it("shows no toast when getLogStatus returns null", async () => {
    makeHarness(null);
    await syncLogStatus();
    expect(document.querySelector<HTMLElement>(".toast-error")).toBeNull();
  });

  it("shows an error toast when the backend emits log-location-warning", async () => {
    const h = makeHarness(null);
    await syncLogStatus();
    h.emit("log-location-warning", "Log moved: /var/log/comnd/comnd.log is in use");
    const toast = document.querySelector<HTMLElement>(".toast-error");
    expect(toast).not.toBeNull();
    expect(toast!.textContent).toContain("Log moved");
  });
});