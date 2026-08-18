import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PromptDetector, PromptPatterns } from "../src/lib/prompt-detector";

const IOSXE_PATTERNS: PromptPatterns = {
  "user-exec": "^[\\w\\-]+>",
  "privileged-exec": "^[\\w\\-]+#",
  "global-config": "^[\\w\\-]+\\(config\\)#",
};

describe("PromptDetector", () => {
  let onModeChange: ReturnType<typeof vi.fn>;
  let onPromptDetected: ReturnType<typeof vi.fn>;
  let detector: PromptDetector;

  beforeEach(() => {
    vi.useFakeTimers();
    onModeChange = vi.fn();
    onPromptDetected = vi.fn();
    detector = new PromptDetector(onModeChange, onPromptDetected);
    detector.loadPatterns(IOSXE_PATTERNS, "privileged-exec");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const idle = () => vi.advanceTimersByTime(250);

  it("detects a bare prompt (full-line match)", () => {
    detector.feed("Router#");
    idle();
    expect(onPromptDetected).toHaveBeenCalledTimes(1);
    expect(onModeChange).not.toHaveBeenCalled(); // already in privileged-exec
  });

  it("does NOT treat prompt + typed input as a new prompt", () => {
    // The user has typed "sh" after the prompt. This must not re-trigger
    // prompt detection, or the shadow buffer resets mid-command and the
    // ghost text disappears while typing.
    detector.feed("Router#sh");
    idle();
    expect(onPromptDetected).not.toHaveBeenCalled();
  });

  it("detects a mode change to global-config", () => {
    detector.feed("Router(config)#");
    idle();
    expect(onModeChange).toHaveBeenCalledWith("global-config");
    expect(onPromptDetected).toHaveBeenCalledTimes(1);
  });

  it("does not fire before the idle gap elapses", () => {
    detector.feed("Router#");
    vi.advanceTimersByTime(100);
    expect(onPromptDetected).not.toHaveBeenCalled();
    vi.advanceTimersByTime(150);
    expect(onPromptDetected).toHaveBeenCalledTimes(1);
  });

  it("keeps only the trailing text after a newline", () => {
    detector.feed("show clock\n12:00:00 UTC\nRouter#");
    idle();
    expect(onPromptDetected).toHaveBeenCalledTimes(1);
  });

  it("user-exec prompt matches on '>'", () => {
    detector.feed("Switch>");
    idle();
    expect(onModeChange).toHaveBeenCalledWith("user-exec");
  });
});
