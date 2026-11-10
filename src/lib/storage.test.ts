import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearStorage, readStorage, writeStorage } from "./storage";

/** Descriptor of the real storage, restored after each case so a stubbed
 *  global never leaks into the next test file. */
let original: PropertyDescriptor | undefined;

beforeEach(() => {
  original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (original) Object.defineProperty(globalThis, "localStorage", original);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("guarded storage", () => {
  it("round-trips a value and clears it", () => {
    expect(writeStorage("comnd-storage-test", "value")).toBe(true);
    expect(readStorage("comnd-storage-test")).toBe("value");

    clearStorage();
    expect(readStorage("comnd-storage-test")).toBeNull();
  });

  it("returns null when getItem throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
      setItem: () => {},
    });

    expect(readStorage("comnd-theme")).toBeNull();
  });

  it("returns false when setItem throws, without throwing", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("full", "QuotaExceededError");
      },
    });

    expect(() => writeStorage("comnd-theme", "light")).not.toThrow();
    expect(writeStorage("comnd-theme", "light")).toBe(false);
  });

  it("survives a localStorage getter that throws", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("denied", "SecurityError");
      },
    });

    expect(readStorage("comnd-theme")).toBeNull();
    expect(writeStorage("comnd-theme", "light")).toBe(false);
    expect(() => clearStorage()).not.toThrow();
  });
});
