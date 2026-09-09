import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { SuggestionController } from "./suggestion-controller";
import { LineTracker } from "./line-tracker";
import { GhostText, GhostPayload } from "./ghost-text";
import { Dropdown } from "./dropdown";
import type { Command } from "./tauri-api";

// Lightweight widget fakes — only the methods the controller calls.
class FakeGhost {
  shown: GhostPayload | null = null;
  hide = vi.fn(() => { this.shown = null; });
  showPayload = vi.fn((p: GhostPayload) => { this.shown = p; });
  isShowing() { return this.shown !== null; }
}

class FakeDropdown {
  visible = false;
  results: unknown[] = [];
  hide = vi.fn(() => { this.visible = false; });
  isVisible() { return this.visible; }
  show = vi.fn((r: unknown[]) => { this.results = r; this.visible = true; });
  updateResults = vi.fn((r: unknown[]) => { this.results = r; });
  getSelected() { return this.results[0] ?? null; }
}

const cmd = (name: string, mode = "bash"): Command => ({
  id: name, name, mode, category: "test", description: "",
  usage: name, platforms: ["linux-bash"], aliases: [],
} as unknown as Command);

function makeController() {
  const ghost = new FakeGhost();
  const dropdown = new FakeDropdown();
  const tracker = new LineTracker(() => {}, () => {});
  const sent: string[] = [];
  const detail = vi.fn();
  const placeholder = vi.fn();
  const c = new SuggestionController({
    send: (d) => sent.push(d),
    tracker: tracker,
    ghost: () => ghost as unknown as GhostText,
    dropdown: () => dropdown as unknown as Dropdown,
    sidebar: { detail, placeholder },
  });
  c.setConnected(true);
  return { c, ghost, dropdown, tracker, sent, detail, placeholder };
}

// debounce is 40ms — advance fake timers
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("SuggestionController — query pipeline", () => {
  it("typing shows ghost for name match after debounce", () => {
    const { c, ghost } = makeController();
    c.loadCommands([cmd("show interfaces"), cmd("show ip route")], "linux-bash", null);
    c.setMode("bash");
    c.buffer.appendAll("show inter");
    vi.advanceTimersByTime(50);
    expect(ghost.shown).toEqual({ kind: "text", text: "faces" });
  });

  it("no match hides ghost and shows placeholder", () => {
    const { c, ghost, placeholder } = makeController();
    c.loadCommands([cmd("show interfaces")], "linux-bash", null);
    c.setMode("bash");
    c.buffer.appendAll("zzz");
    vi.advanceTimersByTime(50);
    expect(ghost.shown).toBeNull();
    expect(placeholder).toHaveBeenCalled();
  });

  it("stale query re-debounces with current content", () => {
    const { c, ghost } = makeController();
    c.loadCommands([cmd("show interfaces")], "linux-bash", null);
    c.setMode("bash");
    c.buffer.appendAll("show i");
    c.buffer.appendAll("nter"); // buffer changes before debounce fires
    vi.advanceTimersByTime(100);
    expect(ghost.shown).toEqual({ kind: "text", text: "faces" });
  });

  it("openDropdown shows and re-syncs ghost from selection", () => {
    const { c, dropdown, ghost } = makeController();
    c.loadCommands([cmd("show interfaces"), cmd("show ip route")], "linux-bash", null);
    c.setMode("bash");
    c.setSuggestionsEnabled(true);
    c.buffer.appendAll("show ");
    vi.advanceTimersByTime(50);
    expect(dropdown.visible).toBe(true);
    // selection sync keeps ghost in sync with top result
    expect(ghost.shown).not.toBeNull();
  });

  it("suggestions disabled keeps dropdown hidden", () => {
    const { c, dropdown } = makeController();
    c.loadCommands([cmd("show interfaces")], "linux-bash", null);
    c.setMode("bash");
    c.setSuggestionsEnabled(false);
    c.buffer.appendAll("show ");
    vi.advanceTimersByTime(50);
    expect(dropdown.visible).toBe(false);
  });

  it("not connected suppresses suggestions", () => {
    const { c, dropdown } = makeController();
    c.setConnected(false);
    c.loadCommands([cmd("show interfaces")], "linux-bash", null);
    c.setSuggestionsEnabled(true);
    c.setMode("bash");
    c.buffer.appendAll("show ");
    vi.advanceTimersByTime(50);
    expect(dropdown.visible).toBe(false);
  });
});

describe("SuggestionController — accept paths", () => {
  it("remainderFor returns name remainder", () => {
    const { c } = makeController();
    expect(c.remainderFor("show interfaces", "show inter")).toBe("faces");
    expect(c.remainderFor("show interfaces", "")).toBe("show interfaces");
    expect(c.remainderFor("show interfaces", "xyz")).toBeNull();
  });

  it("acceptFromDropdown sends remainder and resets buffer", () => {
    const { c, sent } = makeController();
    c.loadCommands([cmd("show interfaces")], "linux-bash", null);
    c.setMode("bash");
    c.buffer.appendAll("show inter");
    c.acceptFromDropdown(cmd("show interfaces"), null);
    expect(sent).toEqual(["faces"]);
    expect(c.input).toBe("");
  });

  it("acceptFromDropdown sends payload text when provided", () => {
    const { c, sent } = makeController();
    c.acceptFromDropdown(cmd("x"), { kind: "text", text: "tok" });
    expect(sent).toEqual(["tok"]);
    expect(c.input).toBe("");
  });
});

describe("SuggestionController — output handling", () => {
  it("receivingOutput burst suppresses queries, re-triggers after 300ms", () => {
    const { c, dropdown } = makeController();
    c.loadCommands([cmd("show interfaces")], "linux-bash", null);
    c.setMode("bash");
    c.setSuggestionsEnabled(true);
    c.buffer.appendAll("show ");
    vi.advanceTimersByTime(50);
    expect(dropdown.visible).toBe(true);

    c.onOutput("command output\nline2\n");
    expect(dropdown.visible).toBe(false);

    // Queries stay suppressed while the burst timer runs
    c.buffer.appendAll("i");
    vi.advanceTimersByTime(100);
    expect(dropdown.visible).toBe(false);

    vi.advanceTimersByTime(250);
    expect(dropdown.visible).toBe(true);
  });

  it("echo re-sync rebuilds buffer after cursor move (learned prompt)", () => {
    const { c } = makeController();
    c.setMode("bash");
    c.buffer.appendAll("ls");
    // Trusted EOL echo: line = prompt + buffer → tracker learns the prefix
    c.onOutput("user@host:~$ ls");
    expect(c.input).toBe("ls");
    c.markCursorMoved();
    // Arrow-key redraw of the edited line — no newline, no burst
    c.onOutput("\ruser@host:~$ ls -l");
    expect(c.input).toBe("ls -l");
  });

  it("passthrough suppresses echo re-sync", () => {
    const { c, tracker } = makeController();
    tracker.loadPatterns({ enable: "Router#" }, "user");
    c.setMode("enable");
    c.buffer.appendAll("show");
    c.markCursorMoved();
    // Interactive-app output (vi/more/top) — no prompt for 2s arms passthrough
    c.onOutput("top screen\nuptime line\n");
    vi.advanceTimersByTime(2000);
    expect(tracker.isPassthrough).toBe(true);
    // A prompt-looking echo arrives during passthrough — re-sync must be skipped
    c.onOutput("Router# show int");
    expect(c.input).toBe("show");
  });

  it("onPromptDetected resets state", () => {
    const { c } = makeController();
    c.buffer.appendAll("old");
    c.markCursorMoved();
    c.onOutput("out\n");
    c.onPromptDetected();
    expect(c.input).toBe("");
    expect(c.isReceivingOutput).toBe(false);
  });
});