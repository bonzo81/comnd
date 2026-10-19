/**
 * In-app updater (P1.4).
 *
 * Pure state logic lives here and is unit-tested in updater.test.ts. The
 * Tauri updater/process plugins are imported dynamically inside functions so
 * vitest never touches the Tauri runtime.
 *
 * Platform behaviour (ADR-006):
 *  - windows/linux — real in-app update: download, install, relaunch
 *  - darwin        — no silent replace until notarization exists; the
 *                    indicator opens the latest GitHub Release page instead
 */

export type UpdatePlatform = "windows" | "linux" | "darwin";

/** What clicking the update indicator does on a given platform. */
export type UpdateActionKind = "install" | "open-release-page";

export const RELEASE_PAGE_URL = "https://github.com/bonzo81/comnd/releases/latest";

/** Detect the desktop OS from the user agent (Tauri webview UAs). */
export function detectPlatform(userAgent: string = navigator.userAgent): UpdatePlatform {
  const ua = userAgent.toLowerCase();
  if (ua.includes("win32") || ua.includes("windows")) return "windows";
  // Tauri webview UAs say "Mac OS X" / "Macintosh", not the bare token "macos".
  if (ua.includes("mac os") || ua.includes("macos") || ua.includes("darwin") || ua.includes("macintosh")) {
    return "darwin";
  }
  return "linux";
}

/** darwin falls back to the GitHub Release page (ADR-006); others install in place. */
export function updateAction(platform: UpdatePlatform): UpdateActionKind {
  return platform === "darwin" ? "open-release-page" : "install";
}

// ─── State machine ──────────────────────────────────────────────────

export type UpdateState =
  | "idle"
  | "checking"
  | "no-update"
  | "update-available"
  | "downloading"
  | "installed"
  | "error";

export type UpdateEvent =
  | { type: "check-started" }
  | { type: "no-update" }
  | { type: "update-found"; version: string; notes?: string }
  | { type: "download-started" }
  | { type: "installed" }
  | { type: "failed"; message: string };

/** Pure transition function — the single source of truth for state flow. */
export function nextUpdateState(current: UpdateState, event: UpdateEvent): UpdateState {
  switch (event.type) {
    case "check-started":
      return "checking";
    case "no-update":
      return current === "checking" ? "no-update" : current;
    case "update-found":
      return current === "checking" ? "update-available" : current;
    case "download-started":
      return current === "update-available" ? "downloading" : current;
    case "installed":
      return current === "downloading" ? "installed" : current;
    case "failed":
      return current === "checking" || current === "downloading" ? "error" : current;
  }
}

// ─── Observable status (title-bar indicator + settings pane) ────────

/** Minimal structural shape of the plugin's Update object. */
export interface PendingUpdate {
  version: string;
  body?: string;
  downloadAndInstall(onEvent?: (downloaded: number, total: number) => void): Promise<void>;
}

export interface UpdateStatus {
  state: UpdateState;
  platform: UpdatePlatform;
  version: string | null;
  notes: string | null;
  error: string | null;
}

let status: UpdateStatus = {
  state: "idle",
  platform: detectPlatform(),
  version: null,
  notes: null,
  error: null,
};
let pendingUpdate: PendingUpdate | null = null;
let checking = false;

const listeners = new Set<() => void>();

export function getUpdateStatus(): UpdateStatus {
  return status;
}

/** Subscribe to status changes; returns an unsubscribe function. */
export function subscribeUpdates(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function emit(): void {
  for (const fn of [...listeners]) fn();
}

function apply(event: UpdateEvent): void {
  status = { ...status, state: nextUpdateState(status.state, event) };
  if (event.type === "check-started") status.error = null;
  if (event.type === "update-found") {
    status.version = event.version;
    status.notes = event.notes ?? null;
  }
  if (event.type === "failed") status.error = event.message;
  emit();
}

/** Run an update check. Safe to call from anywhere; concurrent calls no-op. */
export async function checkForUpdatesNow(): Promise<void> {
  if (checking) return;
  checking = true;
  apply({ type: "check-started" });
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (update) {
      // The plugin's Update carries extra members we don't use; keep the
      // structural shape narrow and cast through unknown.
      pendingUpdate = update as unknown as PendingUpdate;
      apply({ type: "update-found", version: update.version, notes: update.body });
    } else {
      pendingUpdate = null;
      apply({ type: "no-update" });
    }
  } catch (err) {
    apply({ type: "failed", message: err instanceof Error ? err.message : String(err) });
  } finally {
    checking = false;
  }
}

export function getPendingUpdate(): PendingUpdate | null {
  return pendingUpdate;
}

/**
 * Act on the pending update for the current platform.
 * Returns "installed" (the app is relaunching) or "opened-release-page"
 * (darwin fallback). Throws on failure.
 */
export async function applyAvailableUpdate(): Promise<"installed" | "opened-release-page"> {
  const update = pendingUpdate;
  if (!update) throw new Error("No update available");

  if (updateAction(status.platform) === "open-release-page") {
    // macOS: never replace silently — open the latest release page (ADR-006).
    // Idempotent, so a repeated click just opens the page again.
    const { openUrl } = await import("./tauri-api");
    await openUrl(RELEASE_PAGE_URL);
    return "opened-release-page";
  }

  // Re-entry guard for the destructive install path (windows/linux). The
  // title-bar indicator hides itself on the "downloading" transition, which in
  // practice already blocks a second click; this keeps the function safe by
  // construction against rapid double-clicks or any future call site. The Tauri
  // plugin does not serialize concurrent downloadAndInstall() calls.
  if (status.state === "downloading") {
    throw new Error("An update is already being applied");
  }

  apply({ type: "download-started" });
  try {
    await update.downloadAndInstall();
    apply({ type: "installed" });
    // Windows (NSIS) exits the app during install; relaunch covers Linux.
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
    return "installed";
  } catch (err) {
    apply({ type: "failed", message: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}
