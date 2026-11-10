import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearStorage, readStorage, writeStorage } from "./storage";

/** Descriptor of the real storage, restored after each case so a stubbed
 *  global never leaks into the next test file. */
let original: PropertyDescriptor | undefined;

beforeEach(() => {
  original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  clearStorage();
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

  it("keeps a failed write readable until the session ends", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
    });

    expect(writeStorage("comnd-terminal-font-size", "18")).toBe(false);
    // Consumers re-read the key after the change event, so the value must survive.
    expect(readStorage("comnd-terminal-font-size")).toBe("18");

    clearStorage();
    expect(readStorage("comnd-terminal-font-size")).toBeNull();
  });

  it("drops the fallback once a write reaches real storage", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
    });
    expect(writeStorage("comnd-theme", "light")).toBe(false);

    const real = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => real.get(k) ?? null,
      setItem: (k: string, v: string) => void real.set(k, v),
    });

    expect(writeStorage("comnd-theme", "solarized")).toBe(true);
    expect(readStorage("comnd-theme")).toBe("solarized");
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
