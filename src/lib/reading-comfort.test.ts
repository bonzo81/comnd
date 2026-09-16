import { describe, expect, it, beforeEach } from "vitest";
import {
  enable,
  disable,
  update,
  resetToPreset,
  getReadingComfortState,
  isReadingComfortEnabled,
  applyReadingComfort,
  RC_PRESET,
} from "./reading-comfort";
import { getTerminalFontSize, setTerminalFontSize } from "./terminal-prefs";
import { getAppTheme, setAppTheme, getTerminalTheme, setTerminalTheme } from "./theme";

const KEY = "netssh-reading-comfort";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.style.removeProperty("--text-scale");
  delete document.documentElement.dataset.readingComfort;
  setTerminalTheme("dark");
  setAppTheme("dark");
});

describe("Reading Comfort mode", () => {
  it("enable() stamps the preset, snapshots prev font size, sets --text-scale + attribute", () => {
    setTerminalFontSize(14);
    enable();

    const s = getReadingComfortState()!;
    expect(s.prevFontSize).toBe(14);
    expect(s.uiScale).toBe(RC_PRESET.uiScale);
    expect(s.lineHeight).toBe(RC_PRESET.lineHeight);
    expect(s.letterSpacing).toBe(RC_PRESET.letterSpacing);

    expect(getTerminalFontSize()).toBe(RC_PRESET.fontSize); // 16
    expect(document.documentElement.style.getPropertyValue("--text-scale")).toBe(String(RC_PRESET.uiScale));
    expect(document.documentElement.dataset.readingComfort).toBe("on");
    expect(isReadingComfortEnabled()).toBe(true);
  });

  it("disable() restores prev font size, flips enabled off, clears DOM", () => {
    setTerminalFontSize(14);
    enable();
    // user nudged a slider while on
    update({ uiScale: 1.3 });

    disable();

    expect(getReadingComfortState()).toBeNull();
    expect(localStorage.getItem(KEY)).not.toBeNull(); // key kept: values survive the cycle
    expect(getTerminalFontSize()).toBe(14); // restored from prev, not preset
    expect(document.documentElement.style.getPropertyValue("--text-scale")).toBe("");
    expect(document.documentElement.dataset.readingComfort).toBeUndefined();
    expect(isReadingComfortEnabled()).toBe(false);
  });

  it("re-enable restores user-adjusted values and last-used font size", () => {
    setTerminalFontSize(14);
    enable();
    update({ uiScale: 1.4, lineHeight: 1.7, letterSpacing: 5 });
    setTerminalFontSize(22); // user zoomed while on
    disable();
    expect(getTerminalFontSize()).toBe(14); // prev restored on OFF

    enable();

    const s = getReadingComfortState()!;
    expect(s.uiScale).toBe(1.4); // user values, not preset
    expect(s.lineHeight).toBe(1.7);
    expect(s.letterSpacing).toBe(5);
    expect(s.prevFontSize).toBe(14); // new snapshot taken at re-ON
    expect(getTerminalFontSize()).toBe(22); // last-used size, not preset 16
  });

  it("resetToPreset() after a toggle cycle still stamps preset font size", () => {
    setTerminalFontSize(14);
    enable();
    setTerminalFontSize(22);
    disable();
    enable();
    expect(getTerminalFontSize()).toBe(22); // remembered

    resetToPreset();
    expect(getTerminalFontSize()).toBe(RC_PRESET.fontSize); // explicit reset → 16
  });

  it("update() clamps slider fields to their ranges", () => {
    setTerminalFontSize(14);
    enable();
    update({ uiScale: 99, lineHeight: -5, letterSpacing: 100 });

    const s = getReadingComfortState()!;
    expect(s.uiScale).toBe(1.5); // clamped to max
    expect(s.lineHeight).toBe(1.0); // clamped to min
    expect(s.letterSpacing).toBe(6); // clamped to max
  });

  it("resetToPreset() rewrites preset values but keeps prevFontSize", () => {
    setTerminalFontSize(20);
    enable();
    update({ uiScale: 1.4, lineHeight: 1.7, letterSpacing: 5 });
    resetToPreset();

    const s = getReadingComfortState()!;
    expect(s.prevFontSize).toBe(20); // preserved
    expect(s.uiScale).toBe(RC_PRESET.uiScale);
    expect(s.lineHeight).toBe(RC_PRESET.lineHeight);
    expect(s.letterSpacing).toBe(RC_PRESET.letterSpacing);
    expect(getTerminalFontSize()).toBe(RC_PRESET.fontSize);
  });

  it("update() is a no-op while mode is off", () => {
    update({ uiScale: 1.4 });
    expect(getReadingComfortState()).toBeNull();
  });

  it("corrupt JSON in the key is treated as off", () => {
    localStorage.setItem(KEY, "{not json");
    expect(getReadingComfortState()).toBeNull();
    expect(isReadingComfortEnabled()).toBe(false);
    applyReadingComfort(); // must not throw; clears DOM instead of stamping
    expect(document.documentElement.dataset.readingComfort).toBeUndefined();
  });

  it("enable() stamps themes: terminal dark→warm-charcoal, app light→solarized-light", () => {
    setTerminalTheme("dark");
    setAppTheme("light");
    enable();
    expect(getTerminalTheme()).toBe("warm-charcoal");
    expect(getAppTheme()).toBe("solarized-light");
  });

  it("enable() stamps terminal light→cream but leaves third-party app themes alone", () => {
    setTerminalTheme("light");
    setAppTheme("dracula");
    enable();
    expect(getTerminalTheme()).toBe("cream");
    expect(getAppTheme()).toBe("dracula");
  });

  it("disable() leaves theme choices in place", () => {
    setAppTheme("light");
    enable();
    disable();
    expect(getTerminalTheme()).toBe("warm-charcoal");
    expect(getAppTheme()).toBe("solarized-light");
  });
});
