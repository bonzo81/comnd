/**
 * Unit tests for the in-app updater state logic (P1.4).
 * The Tauri updater plugin is mocked so no Tauri runtime is needed;
 * the real dynamic import path in updater.ts stays under test.
 */

import { describe, expect, it, vi } from "vitest";

// updater.ts reads navigator.userAgent at import time and jsdom derives it from
// the host OS, so pin it to keep the install-path tests identical on every OS.
vi.hoisted(() => {
  Object.defineProperty(navigator, "userAgent", {
    value: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
    configurable: true,
  });
});

import {
  applyAvailableUpdate,
  checkForUpdatesNow,
  detectPlatform,
  getUpdateStatus,
  nextUpdateState,
  updateAction,
} from "./updater";

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: vi.fn().mockResolvedValue(undefined),
}));

import { check } from "@tauri-apps/plugin-updater";
import type { Update } from "@tauri-apps/plugin-updater";

const mockedCheck = vi.mocked(check);

/** Minimal stand-in for the plugin's Update (only the fields updater.ts reads). */
function fakeUpdate(version: string): Update {
  return {
    version,
    body: "release notes",
    downloadAndInstall: vi.fn().mockResolvedValue(undefined),
  } as unknown as Update;
}

describe("detectPlatform", () => {
  it("detects Windows from the user agent", () => {
    expect(detectPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")).toBe("windows");
  });

  it("detects macOS from the user agent", () => {
    expect(detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15")).toBe("darwin");
  });

  it("treats anything else as Linux", () => {
    expect(detectPlatform("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36")).toBe("linux");
  });
});

describe("updateAction", () => {
  it("installs in place on Windows and Linux", () => {
    expect(updateAction("windows")).toBe("install");
    expect(updateAction("linux")).toBe("install");
  });

  it("opens the release page on macOS (ADR-006)", () => {
    expect(updateAction("darwin")).toBe("open-release-page");
  });
});

describe("nextUpdateState", () => {
  it("starts a check from any state", () => {
    for (const s of ["idle", "no-update", "update-available", "error", "installed"] as const) {
      expect(nextUpdateState(s, { type: "check-started" })).toBe("checking");
    }
  });

  it("transitions checking → no-update when nothing is newer", () => {
    expect(nextUpdateState("checking", { type: "no-update" })).toBe("no-update");
  });

  it("transitions checking → update-available when a newer version exists", () => {
    expect(nextUpdateState("checking", { type: "update-found", version: "0.2.0" })).toBe("update-available");
  });

  it("walks the install path: download-started → installed", () => {
    expect(nextUpdateState("update-available", { type: "download-started" })).toBe("downloading");
    expect(nextUpdateState("downloading", { type: "installed" })).toBe("installed");
  });

  it("lands in error when a check or download fails", () => {
    expect(nextUpdateState("checking", { type: "failed", message: "offline" })).toBe("error");
    expect(nextUpdateState("downloading", { type: "failed", message: "checksum mismatch" })).toBe("error");
  });

  it("ignores stale events in the wrong state", () => {
    expect(nextUpdateState("idle", { type: "no-update" })).toBe("idle");
    expect(nextUpdateState("no-update", { type: "update-found", version: "0.2.0" })).toBe("no-update");
    expect(nextUpdateState("idle", { type: "download-started" })).toBe("idle");
    expect(nextUpdateState("downloading", { type: "no-update" })).toBe("downloading");
  });
});

describe("checkForUpdatesNow (observable flow)", () => {
  it("reports no-update when the plugin finds nothing newer", async () => {
    mockedCheck.mockResolvedValue(null);
    await checkForUpdatesNow();
    const s = getUpdateStatus();
    expect(s.state).toBe("no-update");
    expect(s.version).toBeNull();
  });

  it("reports update-available with the version when one exists", async () => {
    mockedCheck.mockResolvedValue(fakeUpdate("0.2.0"));
    await checkForUpdatesNow();
    const s = getUpdateStatus();
    expect(s.state).toBe("update-available");
    expect(s.version).toBe("0.2.0");
    expect(s.notes).toBe("release notes");
  });

  it("reports error when the check fails (e.g. offline)", async () => {
    mockedCheck.mockRejectedValue(new Error("network unreachable"));
    await checkForUpdatesNow();
    const s = getUpdateStatus();
    expect(s.state).toBe("error");
    expect(s.error).toBe("network unreachable");
  });

  it("recovers from error on the next successful check", async () => {
    mockedCheck.mockRejectedValueOnce(new Error("offline"));
    await checkForUpdatesNow();
    expect(getUpdateStatus().state).toBe("error");
    mockedCheck.mockResolvedValue(null);
    await checkForUpdatesNow();
    expect(getUpdateStatus().state).toBe("no-update");
  });
});

describe("applyAvailableUpdate (re-entry guard)", () => {
  it("rejects a second install while one is already downloading", async () => {
    // Hold the first download open so we can observe the in-flight window.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const update = {
      version: "0.2.0",
      body: "notes",
      downloadAndInstall: vi.fn().mockImplementation(() => gate),
    } as unknown as Update;

    mockedCheck.mockResolvedValue(update);
    await checkForUpdatesNow();
    expect(getUpdateStatus().state).toBe("update-available");

    // First click runs synchronously up to its first await, so by the time this
    // returns the state is already "downloading" and one download has started.
    const first = applyAvailableUpdate();
    expect(getUpdateStatus().state).toBe("downloading");
    expect(update.downloadAndInstall).toHaveBeenCalledTimes(1);

    // A repeated click while in flight must be rejected and must NOT start a
    // second download (the plugin does not serialize concurrent installs).
    await expect(applyAvailableUpdate()).rejects.toThrow("already being applied");
    expect(update.downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(getUpdateStatus().state).toBe("downloading");

    // Let the first install finish; it should still complete cleanly.
    release();
    await first;
    expect(getUpdateStatus().state).toBe("installed");
  });
});
