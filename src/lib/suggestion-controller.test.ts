import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { SuggestionController } from "./suggestion-controller";
import { LineTracker } from "./line-tracker";
import { GhostText } from "./ghost-text";
import { Dropdown } from "./dropdown";
import type { SuggestionResult } from "./suggestion-engine";
import type { Command } from "./tauri-api";

const cmd = (name: string, mode = "bash"): Command => ({
  id: name, name, mode, category: "test", description: "",
  usage: name, platforms: ["linux-bash"], aliases: [],
} as unknown as Command);

function terminalStub(): Terminal {
  return {
    write: vi.fn(),
    buffer: { active: { cursorX: 0, cursorY: 0 } },
    rows: 10,
    cols: 80,
    options: {},
  } as unknown as Terminal;
}

const cleanups: Array<() => void> = [];

function makeController(opts: { suggestionsToggleByte?: () => string | null } = {}) {
  const sent: string[] = [];
  const inputAtSend: string[] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const ghost = new GhostText(terminalStub(), container);
  let c!: SuggestionController;
  const dropdown = new Dropdown(container, (command, payload) => c.acceptFromDropdown(command, payload));
  const detail = vi.fn();
  const placeholder = vi.fn();
  const ui = {
    isSidebarOpen: vi.fn(() => false),
    dismissSidebar: vi.fn(),
    toggleSuggestions: vi.fn(),
  };
  const tracker = new LineTracker(() => {}, () => {});
  const sendSpy = vi.fn((d: string) => {
    sent.push(d);
    inputAtSend.push(c.input);
  });
  c = new SuggestionController({
    send: sendSpy,
    tracker,
    ghost: () => ghost,
    dropdown: () => dropdown,
    sidebar: { detail, placeholder },
    ui,
    // Only pass the dep when a test provides it — an absent dep must keep
    // the historical "\x00" default (plan 058 phase 4).
    ...(opts.suggestionsToggleByte ? { suggestionsToggleByte: opts.suggestionsToggleByte } : {}),
  });
  c.setConnected(true);
  cleanups.push(() => {
    c.dispose();
    ghost.destroy();
    dropdown.destroy();
    container.remove();
  });
  return { c, tracker, ghost, dropdown, sent, sendSpy, inputAtSend, detail, placeholder, ui, container };
}

type Ctx = ReturnType<typeof makeController>;

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
  vi.useRealTimers();
});

function ghostText(container: HTMLElement): string | null {
  const el = container.querySelector(".ghost-text");
  if (!el || (el as HTMLElement).style.display === "none") return null;
  return el.textContent;
}

function type(ctx: Ctx, text: string) {
  for (const ch of text) ctx.c.keyIn(ch);
}

describe("SuggestionController — query pipeline", () => {
  it("typing shows ghost for name match after debounce", () => {
    const ctx = makeController();
    ctx.c.loadCommands([cmd("show interfaces"), cmd("show ip route")], "linux-bash", null);
    ctx.c.setMode("bash");
    ctx.c.buffer.appendAll("show inter");
    vi.advanceTimersByTime(50);
    expect(ghostText(ctx.container)).toBe("faces");
  });

  it("no match hides ghost and shows placeholder", () => {
    const ctx = makeController();
    ctx.c.loadCommands([cmd("show interfaces")], "linux-bash", null);
    ctx.c.setMode("bash");
    ctx.c.buffer.appendAll("zzz");
    vi.advanceTimersByTime(50);
    expect(ghostText(ctx.container)).toBeNull();
    expect(ctx.placeholder).toHaveBeenCalled();
  });

  it("stale query re-debounces with current content", () => {
    const ctx = makeController();
    ctx.c.loadCommands([cmd("show interfaces")], "linux-bash", null);
    ctx.c.setMode("bash");
    ctx.c.buffer.appendAll("show i");
    ctx.c.buffer.appendAll("nter");
    vi.advanceTimersByTime(100);
    expect(ghostText(ctx.container)).toBe("faces");
  });

  it("openDropdown shows and re-syncs ghost from selection", () => {
    const ctx = makeController();
    ctx.c.loadCommands([cmd("show interfaces"), cmd("show ip route")], "linux-bash", null);
    ctx.c.setMode("bash");
    ctx.c.setSuggestionsEnabled(true);
    ctx.c.buffer.appendAll("show ");
    vi.advanceTimersByTime(50);
    expect(ctx.dropdown.isVisible()).toBe(true);
    expect(ghostText(ctx.container)).not.toBeNull();
  });

  it("suggestions disabled keeps dropdown hidden", () => {
    const ctx = makeController();
    ctx.c.loadCommands([cmd("show interfaces")], "linux-bash", null);
    ctx.c.setMode("bash");
    ctx.c.setSuggestionsEnabled(false);
    ctx.c.buffer.appendAll("show ");
    vi.advanceTimersByTime(50);
    expect(ctx.dropdown.isVisible()).toBe(false);
  });

  it("not connected suppresses suggestions", () => {
    const ctx = makeController();
    ctx.c.setConnected(false);
    ctx.c.loadCommands([cmd("show interfaces")], "linux-bash", null);
    ctx.c.setSuggestionsEnabled(true);
    ctx.c.setMode("bash");
    ctx.c.buffer.appendAll("show ");
    vi.advanceTimersByTime(50);
    expect(ctx.dropdown.isVisible()).toBe(false);
  });
});

describe("SuggestionController — accept paths", () => {
  it("remainderFor returns name remainder", () => {
    const ctx = makeController();
    expect(ctx.c.remainderFor("show interfaces", "show inter")).toBe("faces");
    expect(ctx.c.remainderFor("show interfaces", "")).toBe("show interfaces");
    expect(ctx.c.remainderFor("show interfaces", "xyz")).toBeNull();
  });

  it("acceptFromDropdown sends remainder and resets buffer", () => {
    const ctx = makeController();
    ctx.c.loadCommands([cmd("show interfaces")], "linux-bash", null);
    ctx.c.setMode("bash");
    ctx.c.buffer.appendAll("show inter");
    ctx.c.acceptFromDropdown(cmd("show interfaces"), null);
    expect(ctx.sent).toEqual(["faces"]);
    expect(ctx.c.input).toBe("");
  });

  it("acceptFromDropdown sends payload text when provided", () => {
    const ctx = makeController();
    ctx.c.acceptFromDropdown(cmd("x"), { kind: "text", text: "tok" });
    expect(ctx.sent).toEqual(["tok"]);
    expect(ctx.c.input).toBe("");
  });
});

describe("SuggestionController — output handling", () => {
  it("receivingOutput burst suppresses queries, re-triggers after 300ms", () => {
    const ctx = makeController();
    ctx.c.loadCommands([cmd("show interfaces")], "linux-bash", null);
    ctx.c.setMode("bash");
    ctx.c.setSuggestionsEnabled(true);
    ctx.c.buffer.appendAll("show ");
    vi.advanceTimersByTime(50);
    expect(ctx.dropdown.isVisible()).toBe(true);

    ctx.c.onOutput("command output\nline2\n");
    expect(ctx.dropdown.isVisible()).toBe(false);

    ctx.c.buffer.appendAll("i");
    vi.advanceTimersByTime(100);
    expect(ctx.dropdown.isVisible()).toBe(false);

    vi.advanceTimersByTime(250);
    expect(ctx.dropdown.isVisible()).toBe(true);
  });

  it("echo re-sync rebuilds buffer after cursor move (learned prompt)", () => {
    const ctx = makeController();
    ctx.c.setMode("bash");
    ctx.c.buffer.appendAll("ls");
    ctx.c.onOutput("user@host:~$ ls");
    expect(ctx.c.input).toBe("ls");
    ctx.c.markCursorMoved();
    ctx.c.onOutput("\ruser@host:~$ ls -l");
    expect(ctx.c.input).toBe("ls -l");
  });

  it("passthrough suppresses echo re-sync", () => {
    const ctx = makeController();
    ctx.tracker.loadPatterns({ enable: "Router#" }, "user");
    ctx.c.setMode("enable");
    ctx.c.buffer.appendAll("show");
    ctx.c.markCursorMoved();
    ctx.c.onOutput("top screen\nuptime line\n");
    vi.advanceTimersByTime(2000);
    expect(ctx.tracker.isPassthrough).toBe(true);
    ctx.c.onOutput("Router# show int");
    expect(ctx.c.input).toBe("show");
  });

  it("onPromptDetected resets state", () => {
    const ctx = makeController();
    ctx.c.buffer.appendAll("old");
    ctx.c.markCursorMoved();
    ctx.c.onOutput("out\n");
    ctx.c.onPromptDetected();
    expect(ctx.c.input).toBe("");
    expect(ctx.c.isReceivingOutput).toBe(false);
  });
});

describe("SuggestionController — keyIn routing", () => {
  it("disconnected input is ignored", () => {
    const ctx = makeController();
    ctx.c.setConnected(false);
    ctx.c.keyIn("a");
    expect(ctx.sent).toEqual([]);
    expect(ctx.c.input).toBe("");
  });

  it("printable char appends to the shadow buffer and sends", () => {
    const ctx = makeController();
    ctx.c.keyIn("z");
    expect(ctx.sent).toEqual(["z"]);
    expect(ctx.c.input).toBe("z");
  });

  it("multi-char paste appends printable chars once", () => {
    const ctx = makeController();
    ctx.c.keyIn("abc");
    expect(ctx.sent).toEqual(["abc"]);
    expect(ctx.c.input).toBe("abc");
  });

  it("paste containing controls appends only printable chars", () => {
    const ctx = makeController();
    ctx.c.keyIn("a\x01b");
    expect(ctx.sent).toEqual(["a\x01b"]);
    expect(ctx.c.input).toBe("ab");
  });

  it("unrecognized control forwards without buffer mutation", () => {
    const ctx = makeController();
    ctx.c.keyIn("\x02");
    expect(ctx.sent).toEqual(["\x02"]);
    expect(ctx.c.input).toBe("");
  });

  it("Tab accepts ghost remainder and resets buffer", () => {
    const ctx = makeController();
    ctx.c.loadCommands([cmd("show interfaces")], "linux-bash", null);
    ctx.c.setMode("bash");
    type(ctx, "show inter");
    vi.advanceTimersByTime(50);
    expect(ghostText(ctx.container)).toBe("faces");
    ctx.c.keyIn("\t");
    expect(ctx.sent[ctx.sent.length - 1]).toBe("faces");
    expect(ctx.c.input).toBe("");
    expect(ghostText(ctx.container)).toBeNull();
  });

  it("Tab with dropdown visible accepts the selection", () => {
    const ctx = makeController();
    ctx.c.loadCommands([cmd("show interfaces")], "linux-bash", null);
    ctx.c.setMode("bash");
    ctx.c.setSuggestionsEnabled(true);
    type(ctx, "show ");
    vi.advanceTimersByTime(50);
    expect(ctx.dropdown.isVisible()).toBe(true);
    ctx.c.keyIn("\t");
    expect(ctx.sent[ctx.sent.length - 1]).toBe("interfaces");
    expect(ctx.c.input).toBe("");
    expect(ctx.dropdown.isVisible()).toBe(false);
    expect(ghostText(ctx.container)).toBeNull();
  });

  it("Tab prefers the dropdown over the ghost when both are visible", () => {
    const ctx = makeController();
    ctx.c.buffer.appendAll("show ");
    ctx.ghost.showPayload({ kind: "text", text: "ghost-remainder" }, 0);
    ctx.dropdown.show(
      [{ command: cmd("show ip route"), matchType: "name", score: 0, matchedText: "show ip route" } as SuggestionResult],
      "show",
    );
    ctx.c.keyIn("\t");
    expect(ctx.sent[ctx.sent.length - 1]).toBe("ip route");
    expect(ctx.c.input).toBe("");
    expect(ctx.dropdown.isVisible()).toBe(false);
    expect(ghostText(ctx.container)).toBeNull();
  });

  it("Tab with no suggestion passes through and resets", () => {
    const ctx = makeController();
    ctx.c.loadCommands([cmd("show interfaces")], "linux-bash", null);
    ctx.c.setMode("bash");
    type(ctx, "zzz");
    vi.advanceTimersByTime(50);
    ctx.c.keyIn("\t");
    expect(ctx.sent[ctx.sent.length - 1]).toBe("\t");
    expect(ctx.c.input).toBe("");
  });

  it("Escape closes the dropdown without sending", () => {
    const ctx = makeController();
    ctx.c.loadCommands([cmd("show interfaces")], "linux-bash", null);
    ctx.c.setMode("bash");
    ctx.c.setSuggestionsEnabled(true);
    type(ctx, "show ");
    vi.advanceTimersByTime(50);
    const before = ctx.sent.length;
    ctx.c.keyIn("\x1b");
    expect(ctx.sent.length).toBe(before);
    expect(ctx.dropdown.isVisible()).toBe(false);
  });

  it("Escape dismisses the sidebar when no dropdown is open", () => {
    const ctx = makeController();
    ctx.ui.isSidebarOpen.mockReturnValue(true);
    const before = ctx.sent.length;
    ctx.c.keyIn("\x1b");
    expect(ctx.sent.length).toBe(before);
    expect(ctx.ui.dismissSidebar).toHaveBeenCalled();
  });

  it("Escape hides the ghost and forwards when nothing else is open", () => {
    const ctx = makeController();
    ctx.c.loadCommands([cmd("show interfaces")], "linux-bash", null);
    ctx.c.setMode("bash");
    type(ctx, "show inter");
    vi.advanceTimersByTime(50);
    const before = ctx.sent.length;
    ctx.c.keyIn("\x1b");
    expect(ctx.sent.length).toBe(before + 1);
    expect(ctx.sent[ctx.sent.length - 1]).toBe("\x1b");
    expect(ghostText(ctx.container)).toBeNull();
    expect(ctx.c.input).toBe("show inter");
  });

  it("Escape forwards when nothing is open", () => {
    const ctx = makeController();
    ctx.c.keyIn("\x1b");
    expect(ctx.sent).toEqual(["\x1b"]);
  });

  it("Escape prefers the dropdown over the sidebar", () => {
    const ctx = makeController();
    ctx.c.loadCommands([cmd("show interfaces")], "linux-bash", null);
    ctx.c.setMode("bash");
    ctx.c.setSuggestionsEnabled(true);
    type(ctx, "show ");
    vi.advanceTimersByTime(50);
    ctx.ui.isSidebarOpen.mockReturnValue(true);
    const before = ctx.sent.length;
    ctx.c.keyIn("\x1b");
    expect(ctx.sent.length).toBe(before);
    expect(ctx.dropdown.isVisible()).toBe(false);
    expect(ctx.ui.dismissSidebar).not.toHaveBeenCalled();
  });

  it("Ctrl+Space toggles suggestions without sending", () => {
    const ctx = makeController();
    const before = ctx.sent.length;
    ctx.c.keyIn("\x00");
    expect(ctx.sent.length).toBe(before);
    expect(ctx.ui.toggleSuggestions).toHaveBeenCalled();
  });

  it("custom toggle byte via the dep claims the new byte and frees \x00", () => {
    // toggle-suggestions rebound to Ctrl+O (registry supplies \x0F)
    const ctx = makeController({ suggestionsToggleByte: () => "\x0F" });
    const before = ctx.sent.length;
    ctx.c.keyIn("\x0F");
    expect(ctx.sent.length).toBe(before); // claimed by the toggle, not sent
    expect(ctx.ui.toggleSuggestions).toHaveBeenCalledTimes(1);
    // The old byte is no longer claimed — it passes through to the remote.
    ctx.c.keyIn("\x00");
    expect(ctx.sent).toContain("\x00");
    expect(ctx.ui.toggleSuggestions).toHaveBeenCalledTimes(1);
  });

  it("null toggle byte (inert override) — \x00 passes through, nothing toggles", () => {
    // Hand-edited config: rebound to a combo with no control byte
    const ctx = makeController({ suggestionsToggleByte: () => null });
    const before = ctx.sent.length;
    ctx.c.keyIn("\x00");
    expect(ctx.sent.length).toBe(before + 1);
    expect(ctx.sent[ctx.sent.length - 1]).toBe("\x00");
    expect(ctx.ui.toggleSuggestions).not.toHaveBeenCalled();
  });
});

describe("SuggestionController — keyIn dropdown navigation and line editing", () => {
  it("arrow keys move the dropdown selection and rebuild ghost", () => {
    const ctx = makeController();
    ctx.c.loadCommands([cmd("show interfaces"), cmd("show ip route")], "linux-bash", null);
    ctx.c.setMode("bash");
    ctx.c.setSuggestionsEnabled(true);
    type(ctx, "show ");
    vi.advanceTimersByTime(50);
    expect(ghostText(ctx.container)).toBe("interfaces");
    ctx.c.keyIn("\x1b[B");
    expect(ghostText(ctx.container)).toBe("ip route");
    ctx.c.keyIn("\x1b[A");
    expect(ghostText(ctx.container)).toBe("interfaces");
  });

  it("Tab accepts the moved dropdown selection", () => {
    const ctx = makeController();
    ctx.c.loadCommands([cmd("show interfaces"), cmd("show ip route")], "linux-bash", null);
    ctx.c.setMode("bash");
    ctx.c.setSuggestionsEnabled(true);
    type(ctx, "show ");
    vi.advanceTimersByTime(50);
    ctx.c.keyIn("\x1b[B");
    ctx.c.keyIn("\t");
    expect(ctx.sent[ctx.sent.length - 1]).toBe("ip route");
    expect(ctx.c.input).toBe("");
    expect(ctx.dropdown.isVisible()).toBe(false);
  });

  it("arrow up with no dropdown resets and hides ghost", () => {
    const ctx = makeController();
    ctx.c.loadCommands([cmd("show interfaces")], "linux-bash", null);
    ctx.c.setMode("bash");
    type(ctx, "show inter");
    vi.advanceTimersByTime(50);
    ctx.c.keyIn("\x1b[A");
    expect(ctx.sent[ctx.sent.length - 1]).toBe("\x1b[A");
    expect(ctx.c.input).toBe("");
    expect(ghostText(ctx.container)).toBeNull();
  });

  it("arrow down with no dropdown resets and hides ghost", () => {
    const ctx = makeController();
    ctx.c.loadCommands([cmd("show interfaces")], "linux-bash", null);
    ctx.c.setMode("bash");
    type(ctx, "show inter");
    vi.advanceTimersByTime(50);
    ctx.c.keyIn("\x1b[B");
    expect(ctx.sent[ctx.sent.length - 1]).toBe("\x1b[B");
    expect(ctx.c.input).toBe("");
    expect(ghostText(ctx.container)).toBeNull();
  });

  const ALT_KEYS: Array<[string, string]> = [
    ["alt-right-1", "\x1b[1;3C"],
    ["alt-right-2", "\x1b\x1b[C"],
    ["alt-right-3", "\x1b\x1b[1;3C"],
  ];

  it.each(ALT_KEYS)("Alt+right %s accepts the next word of the ghost remainder", (_label, seq) => {
    const ctx = makeController();
    ctx.c.loadCommands([cmd("show interfaces brief")], "linux-bash", null);
    ctx.c.setMode("bash");
    type(ctx, "show inter");
    vi.advanceTimersByTime(50);
    ctx.c.keyIn(seq);
    expect(ctx.sent[ctx.sent.length - 1]).toBe("faces ");
    expect(ctx.c.input).toBe("show interfaces ");
    expect(ctx.ghost.getCurrentRemainder()).toBe("brief");
  });

  it.each(ALT_KEYS)("Alt+right %s forwards raw when no ghost is showing", (_label, seq) => {
    const ctx = makeController();
    ctx.c.keyIn(seq);
    expect(ctx.sent).toEqual([seq]);
    expect(ctx.c.input).toBe("");
  });

  it("Enter commits the line and resets", () => {
    const ctx = makeController();
    ctx.c.loadCommands([cmd("show interfaces")], "linux-bash", null);
    ctx.c.setMode("bash");
    type(ctx, "show inter");
    vi.advanceTimersByTime(50);
    ctx.c.keyIn("\r");
    expect(ctx.sent[ctx.sent.length - 1]).toBe("\r");
    expect(ctx.c.input).toBe("");
    expect(ghostText(ctx.container)).toBeNull();
  });

  it("Ctrl+C aborts the line and resets", () => {
    const ctx = makeController();
    ctx.c.loadCommands([cmd("show interfaces")], "linux-bash", null);
    ctx.c.setMode("bash");
    type(ctx, "show inter");
    vi.advanceTimersByTime(50);
    ctx.c.keyIn("\x03");
    expect(ctx.sent[ctx.sent.length - 1]).toBe("\x03");
    expect(ctx.c.input).toBe("");
    expect(ghostText(ctx.container)).toBeNull();
  });

  const BACKSPACE_KEYS: Array<[string, string]> = [
    ["delete", "\x7f"],
    ["backspace", "\b"],
  ];

  it.each(BACKSPACE_KEYS)("backspace %s edits the shadow buffer", (_label, key) => {
    const ctx = makeController();
    type(ctx, "ab");
    ctx.c.keyIn(key);
    expect(ctx.c.input).toBe("a");
  });

  const LINE_EDIT_KEYS: Array<[string, string]> = [
    ["left", "\x1b[D"],
    ["right", "\x1b[C"],
    ["home", "\x1b[H"],
    ["end", "\x1b[F"],
    ["delete", "\x1b[1~"],
    ["insert", "\x1b[4~"],
    ["ctrl-u", "\x15"],
    ["ctrl-w", "\x17"],
    ["ctrl-d", "\x04"],
  ];

  it.each(LINE_EDIT_KEYS)("line-editing %s suppresses suggestions until re-sync", (_label, seq) => {
    const ctx = makeController();
    ctx.c.loadCommands([cmd("show interfaces")], "linux-bash", null);
    ctx.c.setMode("bash");
    type(ctx, "show inter");
    vi.advanceTimersByTime(50);
    expect(ghostText(ctx.container)).toBe("faces");
    ctx.c.keyIn(seq);
    type(ctx, "f");
    vi.advanceTimersByTime(50);
    expect(ghostText(ctx.container)).toBeNull();
  });

  it("line-editing hides the open dropdown", () => {
    const ctx = makeController();
    ctx.c.loadCommands([cmd("show interfaces"), cmd("show ip route")], "linux-bash", null);
    ctx.c.setMode("bash");
    ctx.c.setSuggestionsEnabled(true);
    type(ctx, "show ");
    vi.advanceTimersByTime(50);
    expect(ctx.dropdown.isVisible()).toBe(true);
    ctx.c.keyIn("\x1b[D");
    expect(ctx.dropdown.isVisible()).toBe(false);
  });
});

describe("SuggestionController — order-of-application pins", () => {
  it("Enter sends before shadow reset and hides widgets after reset", () => {
    const ctx = makeController();
    ctx.c.loadCommands([cmd("show interfaces"), cmd("show ip route")], "linux-bash", null);
    ctx.c.setMode("bash");
    ctx.c.setSuggestionsEnabled(true);
    type(ctx, "show ");
    vi.advanceTimersByTime(50);
    expect(ctx.dropdown.isVisible()).toBe(true);
    expect(ghostText(ctx.container)).not.toBeNull();

    const inputAtGhostHide: string[] = [];
    const inputAtDropdownHide: string[] = [];
    const originalGhostHide = ctx.ghost.hide.bind(ctx.ghost);
    const originalDropdownHide = ctx.dropdown.hide.bind(ctx.dropdown);
    const ghostHide = vi.spyOn(ctx.ghost, "hide");
    const dropdownHide = vi.spyOn(ctx.dropdown, "hide");
    ghostHide.mockImplementation(() => {
      inputAtGhostHide.push(ctx.c.input);
      originalGhostHide();
    });
    dropdownHide.mockImplementation(() => {
      inputAtDropdownHide.push(ctx.c.input);
      originalDropdownHide();
    });

    ctx.sendSpy.mockClear();
    ghostHide.mockClear();
    dropdownHide.mockClear();
    ctx.c.keyIn("\r");

    expect(ctx.sendSpy).toHaveBeenCalledTimes(1);
    expect(ctx.sendSpy).toHaveBeenCalledWith("\r");
    expect(ctx.inputAtSend[ctx.inputAtSend.length - 1]).toBe("show ");
    expect(inputAtGhostHide.length).toBeGreaterThan(0);
    expect(inputAtGhostHide.every((v) => v === "")).toBe(true);
    expect(inputAtDropdownHide.length).toBeGreaterThan(0);
    expect(inputAtDropdownHide.every((v) => v === "")).toBe(true);
    expect(ctx.sendSpy.mock.invocationCallOrder![0]).toBeLessThan(ghostHide.mock.invocationCallOrder![0]);
    expect(ghostHide.mock.invocationCallOrder![0]).toBeLessThan(dropdownHide.mock.invocationCallOrder![0]);

    ghostHide.mockRestore();
    dropdownHide.mockRestore();
  });
});
