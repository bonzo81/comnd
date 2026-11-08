import { beforeEach, describe, expect, it } from "vitest";
import { startApp } from "./app-startup";
import { TerminalView } from "../components/terminal-view";

const RC_KEY = "comnd-reading-comfort";
const SIZE_KEY = "comnd-terminal-font-size";

function seedReadingComfort(overrides: Record<string, unknown> = {}): void {
  localStorage.setItem(
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
  localStorage.clear();
  document.documentElement.style.removeProperty("--text-scale");
  delete document.documentElement.dataset.readingComfort;
});

describe("app startup", () => {
  it("applies stored Reading Comfort before the app is constructed", () => {
    seedReadingComfort();
    localStorage.setItem(SIZE_KEY, "16");

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
    localStorage.setItem(SIZE_KEY, "16");
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
