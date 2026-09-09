import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { LineTracker } from "./line-tracker";

function makeTracker() {
  const onModeChange = vi.fn();
  const onPromptDetected = vi.fn();
  const t = new LineTracker(onModeChange, onPromptDetected);
  return { t, onModeChange, onPromptDetected };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("LineTracker — prompt detection", () => {
  it("matches a prompt after the idle window and fires callbacks", () => {
    const { t, onModeChange, onPromptDetected } = makeTracker();
    t.loadPatterns({ enable: "Router#", user: "Router>" }, "user");
    expect(onModeChange).not.toHaveBeenCalled();

    t.feed("Router#");
    vi.advanceTimersByTime(200);

    expect(onModeChange).toHaveBeenCalledWith("enable");
    expect(t.lastPrompt).toBe("Router#");
    expect(onModeChange).toHaveBeenCalledWith("enable");
    expect(onPromptDetected).toHaveBeenCalledTimes(1);
  });

  it("does NOT treat prompt + typed input as a new prompt (real IOS-XE patterns)", () => {
    const { t, onPromptDetected } = makeTracker();
    t.loadPatterns(
      { "user-exec": "^[\w\\-]+>", "privileged-exec": "^[\w\\-]+#", "global-config": "^[\w\\-]+\\(config\\)#" },
      "privileged-exec",
    );
    t.feed("Router#sh");
    vi.advanceTimersByTime(200);
    expect(onPromptDetected).not.toHaveBeenCalled();
  });

  it("does not fire before the idle gap elapses", () => {
    const { t, onPromptDetected } = makeTracker();
    t.loadPatterns({ enable: "Router#" }, "user");
    t.feed("Router#");
    vi.advanceTimersByTime(100);
    expect(onPromptDetected).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(onPromptDetected).toHaveBeenCalledTimes(1);
  });

  it("same-mode prompt repeat does not re-fire the mode callback", () => {
    const { t, onModeChange } = makeTracker();
    t.loadPatterns({ enable: "Router#" }, "enable");
    t.feed("Router#");
    vi.advanceTimersByTime(200);
    t.feed("Router#");
    vi.advanceTimersByTime(200);
    expect(onModeChange).not.toHaveBeenCalled();
  });

  it("backspace echo (\\b \\b triples) deletes one char per erase, prompt then matches", () => {
    const { t, onModeChange, onPromptDetected } = makeTracker();
    t.loadPatterns({ enable: "Router#" }, "user");
    t.feed("Router#sh");
    t.feed("\b \b\b \b"); // device erases 's' then 'h' (2 × BS SP BS)
    vi.advanceTimersByTime(200);
    expect(onModeChange).toHaveBeenCalledWith("enable");
    expect(t.lastPrompt).toBe("Router#");
    expect(onPromptDetected).toHaveBeenCalledTimes(1);
  });

  it("bare backspaces still delete (no overwrite spaces)", () => {
    const { t } = makeTracker();
    t.loadPatterns({ enable: "Router#" }, "user");
    t.feed("Router#sh");
    t.feed("\b\b"); // no overwrite spaces at all
    expect(t.currentLine).toBe("Router#");
  });

  it("Ctrl+W kill (\\b \\b runs) erases a whole word", () => {
    const { t } = makeTracker();
    t.loadPatterns({ enable: "Router#" }, "user");
    t.feed("Router# show run");
    t.feed("\b \b\b \b\b \b"); // erase "run"
    t.feed("start");
    expect(t.currentLine).toBe("Router# show start");
  });

  it("\\r repaint replaces the line (history recall)", () => {
    const { t } = makeTracker();
    t.loadPatterns({ enable: "Router#" }, "user");
    t.feed("Router# sh");
    t.feed("\rRouter# show running-config");
    expect(t.currentLine).toBe("Router# show running-config");
    expect(t.contentAfter("Router#", "")).toBe("show running-config");
  });

  it("passthrough arms after 2s of newline output without a prompt, clears on match", () => {
    const { t } = makeTracker();
    t.loadPatterns({ enable: "Router#" }, "user");
    t.feed("top screen\nuptime line\n");
    expect(t.isPassthrough).toBe(false);
    vi.advanceTimersByTime(2000);
    expect(t.isPassthrough).toBe(true);

    t.feed("Router#");
    vi.advanceTimersByTime(200);
    expect(t.isPassthrough).toBe(false);
  });

  it("passthrough never arms without patterns (bash ships {})", () => {
    const { t } = makeTracker();
    t.loadPatterns({}, "bash");
    t.feed("output\nmore output\n");
    vi.advanceTimersByTime(5000);
    expect(t.isPassthrough).toBe(false);
  });

  it("loadPatterns resets line state from a previous session", () => {
    const { t } = makeTracker();
    t.loadPatterns({ enable: "Router#" }, "user");
    t.feed("stale line");
    expect(t.currentLine).toBe("stale line");
    t.loadPatterns({ enable: "Router#" }, "user");
    expect(t.currentLine).toBe("");
  });
});

describe("LineTracker — line reconstruction", () => {
  it("tracks the current line across chunks and newlines", () => {
    const { t } = makeTracker();
    t.feed("Router#sho ");
    t.feed("int");
    expect(t.currentLine).toBe("Router#sho int");
    t.feed("\r\noutput\r\nRouter#");
    expect(t.currentLine).toBe("Router#");
  });

  it("strips ANSI before reconstructing", () => {
    const { t } = makeTracker();
    t.feed("\x1b[32mRouter#\x1b[0m");
    expect(t.currentLine).toBe("Router#");
  });
});

describe("LineTracker — contentAfter / learnPrompt", () => {
  it("strips a detected prompt prefix from the line (trailing space is typed content)", () => {
    const { t } = makeTracker();
    t.feed("Router# show ");
    expect(t.contentAfter("Router#", "show")).toBe("show ");
  });

  it("handles a prompt echoed with trailing CRLF (typed echo on fresh line)", () => {
    const { t } = makeTracker();
    t.feed("Router#\r\nshow ver");
    expect(t.currentLine).toBe("show ver");
    expect(t.contentAfter("Router#", "")).toBe("show ver");
  });

  it("falls back to the learned prompt when no patterns exist (bash)", () => {
    const { t } = makeTracker();
    t.loadPatterns({}, "bash");
    t.feed("user@host:~$ ls "); // trusted EOL state: line = prompt + buffer
    t.learnPrompt("ls ");       // learnedPrompt = "user@host:~$"
    t.feed("-l");               // cursor-moved redraw: line = "user@host:~$ ls -l"
    expect(t.contentAfter("", "ls")).toBe("ls -l");
  });

  it("learned prompt: mid-line backspace reconciles after learning (bash)", () => {
    const { t } = makeTracker();
    t.loadPatterns({}, "bash");
    t.feed("andy@host:~$ ");
    t.feed("sudo apt update");
    t.learnPrompt("sudo apt update");
    t.feed("\b\b\b"); // cursor mid-line: backspaces delete before the cursor
    expect(t.contentAfter("", "sudo apt upd")).toBe("sudo apt upd");
  });

  it("prompt echoed with trailing CRLF: typed echo lands on fresh line, backspace after it works", () => {
    const { t } = makeTracker();
    t.loadPatterns({ enable: "Router#" }, "user");
    t.feed("Router# \r\n");
    t.feed("show rn");
    t.feed("\b \b");
    t.feed("u");
    expect(t.contentAfter("Router#", "")).toBe("show ru");
  });

  it("fully cleared line reconciles to empty string", () => {
    const { t } = makeTracker();
    t.loadPatterns({ enable: "Router#" }, "user");
    t.feed("Router# sudo");
    t.feed("\b \b\b \b\b \b\b \b"); // erase "sudo" — 4 × BS SP BS
    expect(t.contentAfter("Router#", "")).toBe("");
  });

  it("no patterns: consistency fallback returns expected when echo ends with it", () => {
    const { t } = makeTracker();
    t.loadPatterns({}, "bash");
    t.feed("bash-5.1$ sh");
    expect(t.contentAfter("", "sh")).toBe("sh");
  });

  it("returns null when the prompt doesn't match and line doesn't end with expected", () => {
    const { t } = makeTracker();
    t.feed("Router# show ");
    expect(t.contentAfter("Switch#", "zzz")).toBeNull();
  });

  it("learnPrompt ignores an empty buffer (can't separate prompt from junk)", () => {
    const { t } = makeTracker();
    t.loadPatterns({}, "bash");
    t.feed("user@host:~$ ls ");
    t.learnPrompt(""); // no-op — learnedPrompt stays empty
    // No learned prompt, line doesn't end with expected → null (fallback fails)
    expect(t.contentAfter("", "zzz")).toBeNull();
  });

  it("reset clears line state but keeps prompt detection state", () => {
    const { t, onModeChange } = makeTracker();
    t.loadPatterns({ enable: "Router#" }, "user");
    t.feed("Router#sho");
    t.reset();
    expect(t.currentLine).toBe("");
    // Detection state survives reset: the next prompt still fires a mode change.
    t.feed("Router#");
    vi.advanceTimersByTime(200);
    expect(onModeChange).toHaveBeenCalledWith("enable");
  });
});
