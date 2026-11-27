import { afterEach, describe, expect, it, vi } from "vitest";
import { showToast } from "./toast";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.querySelectorAll(".toast").forEach((el) => el.remove());
});

describe("showToast timers", () => {
  it("survives its dismiss timer firing after the jsdom environment is gone", () => {
    // Regression: CI's frontend ubuntu leg failed with
    // "ReferenceError: document is not defined" from the auto-dismiss timer
    // when a test finished before the timer fired.
    vi.useFakeTimers();
    showToast("hello", "info", 4000);
    vi.stubGlobal("document", undefined);

    expect(() => vi.advanceTimersByTime(4000)).not.toThrow();
  });
});
