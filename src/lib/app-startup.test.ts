import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startApp } from "./app-startup";
import { TerminalView } from "../components/terminal-view";
import { clearStorage, writeStorage } from "./storage";
import { getAppTheme, getTerminalTheme, setAppTheme } from "./theme";
import { getTerminalFontSize } from "./terminal-prefs";
import { getSearchIncludeTags } from "./search-prefs";
import { getTimestampsEnabled, getTimestampFormat } from "./timestamps";
import { getAutoCopyEnabled } from "./auto-copy";
import { getOutputHighlightEnabled } from "./output-highlight";
import { isReadingComfortEnabled } from "./reading-comfort";

const RC_KEY = "comnd-reading-comfort";
const SIZE_KEY = "comnd-terminal-font-size";

function seedReadingComfort(overrides: Record<string, unknown> = {}): void {
  writeStorage(
    RC_KEY,
    JSON.stringify({
      enabled: true,
      prevFontSize: 14,
      lastFontSize: 16,
      uiScale: 1.15,
      lineHeight: 1.4,
      letterSpacing: 2,
      ...overrides,
    }),
  );
}

function rootScale(): string {
  return getComputedStyle(document.documentElement).getPropertyValue("--text-scale").trim();
}

beforeEach(() => {
  clearStorage();
  document.documentElement.style.removeProperty("--text-scale");
  delete document.documentElement.dataset.readingComfort;
  delete document.documentElement.dataset.theme;
});

describe("app startup", () => {
  it("applies stored Reading Comfort before the app is constructed", () => {
    seedReadingComfort();
    writeStorage(SIZE_KEY, "16");

    let observed: { attribute: string | undefined; scale: string } | null = null;
    let created = false;
    startApp(() => {
      created = true;
      observed = {
        attribute: document.documentElement.dataset.readingComfort,
        scale: rootScale(),
      };
    });

    expect(created).toBe(true);
    expect(observed).toEqual({ attribute: "on", scale: "1.15" });
    expect(document.documentElement.dataset.readingComfort).toBe("on");
    expect(rootScale()).toBe("1.15");
  });

  it("leaves typography off on a first run with nothing stored", () => {
    let created = false;
    startApp(() => {
      created = true;
    });

    expect(created).toBe(true);
    expect(document.documentElement.dataset.readingComfort).toBeUndefined();
    expect(rootScale()).toBe("");
  });

  it("leaves typography off when the stored mode is disabled", () => {
    seedReadingComfort({ enabled: false });
    startApp(() => {});

    expect(document.documentElement.dataset.readingComfort).toBeUndefined();
    expect(rootScale()).toBe("");
  });

  it("opens terminals with the stored Reading Comfort typography", () => {
    seedReadingComfort();
    writeStorage(SIZE_KEY, "16");
    startApp(() => {});

    const view = new TerminalView(
      () => {},
      () => {},
      () => {},
      () => {},
    );
    const container = document.createElement("div");
    view.mount(container);
    const terminal = (
      view as unknown as {
        terminal: { options: { fontSize: number; lineHeight: number; letterSpacing: number } } | null;
      }
    ).terminal;

    expect(terminal?.options.fontSize).toBe(16);
    expect(terminal?.options.lineHeight).toBe(1.4);
    expect(terminal?.options.letterSpacing).toBe(2);

    (view as unknown as { cleanup(): void }).cleanup();
  });
});

describe("app startup with blocked storage", () => {
  let original: PropertyDescriptor | undefined;

  /** Reproduce the issue's repro: reading the property itself throws. */
  beforeEach(() => {
    original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("storage blocked", "SecurityError");
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it("constructs the app and falls back to every documented default", () => {
    let created = false;
    startApp(() => {
      created = true;
    });

    expect(created).toBe(true);
    expect(getAppTheme()).toBe("dark");
    expect(getTerminalTheme()).toBe("dark");
    expect(isReadingComfortEnabled()).toBe(false);
    expect(getTerminalFontSize()).toBe(14);
    expect(getSearchIncludeTags()).toBe(false);
    expect(getTimestampsEnabled()).toBe(false);
    expect(getTimestampFormat()).toBe("24h");
    expect(getAutoCopyEnabled()).toBe(false);
    expect(getOutputHighlightEnabled()).toBe(false);
    expect(document.documentElement.dataset.readingComfort).toBeUndefined();
    expect(rootScale()).toBe("");
  });

  it("opens a terminal with default typography and suggestions off", () => {
    startApp(() => {});

    const view = new TerminalView(
      () => {},
      () => {},
      () => {},
      () => {},
    );
    const container = document.createElement("div");
    view.mount(container);
    const terminal = (
      view as unknown as { terminal: { options: { fontSize: number } } | null }
    ).terminal;
    const suggestionsBtn = container.querySelector(".tv-suggestions-btn");

    expect(terminal?.options.fontSize).toBe(14);
    expect(suggestionsBtn).not.toBeNull();
    expect(suggestionsBtn?.classList.contains("active")).toBe(false);

    (view as unknown as { cleanup(): void }).cleanup();
  });

  it("starts when getItem and setItem throw, keeping a failed write in effect", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
    });

    let created = false;
    startApp(() => {
      created = true;
    });

    expect(created).toBe(true);
    expect(() => setAppTheme("light")).not.toThrow();
    expect(document.documentElement.dataset.theme).toBe("light"); // in-memory value survives
    expect(getAppTheme()).toBe("dark"); // unreadable storage → documented default
  });
});
