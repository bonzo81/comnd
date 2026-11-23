// Shared full-app smoke-test harness (plans 062 and 064).
//
// Both suites boot the real debug app under tauri-driver, give each scenario
// its own COMND_DATA_DIR temp directory, and tear down every process they own.
// Suite-specific behaviour (which mock to stop, which env to inject) arrives
// through the `suite` argument to runCase/runSuite.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { remote } from "webdriverio";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export const appPath = path.join(
  root,
  "src-tauri",
  "target",
  "debug",
  process.platform === "win32" ? "comnd.exe" : "comnd",
);

export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A millisecond duration as seconds, for suite timing output. */
export const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

// Every phase a scenario can spend time in. Kept in boot→teardown order so the
// printed line reads like the scenario does.
const TIMING_PHASES = ["driver", "session", "run", "stop", "close", "kill"];

const emptyTimings = () => Object.fromEntries(TIMING_PHASES.map((phase) => [phase, 0]));

const addTimings = (total, part) => {
  for (const phase of TIMING_PHASES) total[phase] += part?.[phase] ?? 0;
};

/** ` (3.4s wall: driver 0.2s, session 1.0s, run 2.0s, …)` for a PASS/FAIL line. */
const formatTimings = (elapsed, timings) => {
  if (!timings) return ` (${secs(elapsed)})`;
  const phases = TIMING_PHASES.map((phase) => `${phase} ${secs(timings[phase])}`).join(", ");
  return ` (${secs(elapsed)} wall: ${phases})`;
};

/**
 * `--jobs=N` for a suite: how many scenarios run at once (default 1).
 *
 * Separate invocations used to be the only way to split a suite, and each one
 * re-paid the app build and the driver start-up. A pool inside one process
 * keeps a single build and overlaps the per-scenario wait instead.
 */
export function parseJobs(argv) {
  const equals = argv.find((arg) => arg.startsWith("--jobs="));
  if (!equals) return 1;
  const raw = equals.slice("--jobs=".length);
  const jobs = Number(raw);
  if (!Number.isInteger(jobs) || jobs < 1) {
    console.error(`--jobs takes a positive whole number, got ${JSON.stringify(raw)}`);
    process.exit(2);
  }
  return jobs;
}

export const SCENARIO_TIMEOUT_MS = 180_000;

// CI runners are slow (debug build, Xvfb, WebKit); a tight wait turns runner
// latency into a false failure. The per-scenario cap still bounds the suite.
export const WAIT_MS = 30_000;

export function withTimeout(promise, ms, label) {
  let timer;
  const timerPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not finish within ${ms}ms`)), ms);
  });
  return Promise.race([promise, timerPromise]).finally(() => clearTimeout(timer));
}

// Ports handed out by `freePort` in this process. Two workers asking at once
// can both see the same port free (each probe closes its socket before the
// driver binds), so the set makes the answer unique even then.
const issuedPorts = new Set();

export async function freePort() {
  for (;;) {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address();
    await new Promise((resolve) => server.close(resolve));
    if (!issuedPorts.has(port)) {
      issuedPorts.add(port);
      return port;
    }
  }
}

export async function waitForDriver(driver, port, driverLog) {
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    if (driver.exitCode !== null) {
      await pause(100);
      throw new Error(
        `tauri-driver exited before becoming ready (code ${driver.exitCode}): ${driverLog() || "no stderr output"}`,
      );
    }
    try {
      await new Promise((resolve, reject) => {
        const socket = net.connect(port, "127.0.0.1", () => {
          socket.destroy();
          resolve();
        });
        socket.once("error", reject);
      });
      return;
    } catch {
      await pause(100);
    }
  }
  throw new Error("tauri-driver did not listen within 15 seconds; check tauri-driver and the platform WebDriver");
}

export function buildApp() {
  const result = spawnSync(
    "npm",
    ["run", "tauri", "--", "build", "--debug", "--no-bundle", "--config", "src-tauri/tauri.smoke.conf.json"],
    {
      cwd: root,
      stdio: "inherit",
      shell: process.platform === "win32",
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Smoke app build failed with exit code ${result.status}`);
  if (!existsSync(appPath)) throw new Error(`Smoke app binary not found: ${appPath}`);
}

/**
 * On Linux, re-run this suite under Xvfb once. Returns true when the current
 * process is the Xvfb wrapper and the caller should stop.
 */
export function runUnderXvfb(importMetaUrl) {
  if (process.platform !== "linux" || process.env.DISPLAY || process.env.COMND_SMOKE_XVFB) {
    return false;
  }
  const result = spawnSync(
    "xvfb-run",
    ["-a", process.execPath, fileURLToPath(importMetaUrl), ...process.argv.slice(2)],
    {
      cwd: root,
      env: { ...process.env, COMND_SMOKE_XVFB: "1" },
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
  return true;
}

export async function invoke(browser, command, args = {}) {
  return browser.execute(
    (name, payload) => window.__TAURI_INTERNALS__.invoke(name, payload),
    command,
    args,
  );
}

/** Poll an in-page predicate; `timeoutMsg` names the behaviour that broke. */
export async function waitFor(browser, predicate, timeoutMsg, timeout = WAIT_MS) {
  await browser.waitUntil(
    async () => browser.execute(predicate),
    { timeout, interval: 100, timeoutMsg },
  );
}

const ACT_ON_ACTIONS = new Set(["click", "dblclick"]);

/**
 * Find an element and act on it in one in-page step.
 *
 * `browser.$()` resolves a WebDriver node handle, and the app re-renders whole
 * panels after an async load, so a handle taken before that render points at a
 * detached node and the next command fails with "Stale element found" instead
 * of retrying. This never holds a handle: the lookup and the action run in the
 * same script, and a retry repeats both together, so a render between attempts
 * is harmless. Polling also covers a control that is rendered but still
 * disabled, whose click is swallowed, which is the wait-for-clickable
 * behaviour `browser.$().click()` used to give. The wait exists only so an
 * unusable element times out naming the selector — an error thrown by the
 * action itself is not swallowed.
 */
export async function actOn(browser, selector, { action = "click", index = 0, timeout = WAIT_MS } = {}) {
  if (!ACT_ON_ACTIONS.has(action)) {
    throw new Error(`actOn: unknown action ${JSON.stringify(action)} for ${selector}`);
  }
  await browser.waitUntil(
    async () => browser.execute(
      (sel, at, kind) => {
        const element = document.querySelectorAll(sel)[at];
        if (!element) return false;
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden"
          || element.getClientRects().length === 0) {
          return false;
        }
        // A rendered but disabled control ignores the click, so returning here
        // would stop polling on a no-op and leave the next wait to time out.
        if (element.matches(":disabled")) return false;
        if (kind === "click") {
          element.click();
        } else {
          element.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
        }
        return true;
      },
      selector,
      index,
      action,
    ),
    {
      timeout,
      interval: 100,
      timeoutMsg: `${action} on ${selector}: the element never became actionable (missing, hidden or disabled)`,
    },
  );
}

// ─── Page helpers ───────────────────────────────────────────────────
//
// Every suite drives the same app through the same page interface, so the
// interface lives here once. Nothing below holds a WebDriver element handle:
// `browser.$()` resolves to a node that a whole-panel re-render detaches, so
// reads go through `browser.execute` and actions through `actOn`.

/**
 * Poll until `selector` exists — and, with `visible`, is also rendered.
 *
 * `message` names the behaviour that broke. The default names the selector,
 * because a bare timeout says nothing about what was missing.
 */
export async function waitForSelector(
  browser,
  selector,
  message = `${selector} did not render`,
  { timeout = WAIT_MS, visible = false } = {},
) {
  await browser.waitUntil(
    async () => browser.execute(
      (sel, needVisible) => {
        const element = document.querySelector(sel);
        if (!element) return false;
        if (!needVisible) return true;
        const style = getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden"
          && element.getClientRects().length > 0;
      },
      selector,
      visible,
    ),
    { timeout, interval: 100, timeoutMsg: message },
  );
}

/** Act on an element; the polled action itself is `actOn`'s. */
export async function click(browser, selector) {
  await actOn(browser, selector);
}

/** Set a form field and fire the events the app listens for. */
export async function setInput(browser, selector, value) {
  await browser.execute(
    (sel, next) => {
      const element = document.querySelector(sel);
      if (!element) throw new Error(`missing element ${sel}`);
      element.value = next;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    },
    selector,
    value,
  );
}

export async function sendKeys(browser, keys, { visibleOnly = false } = {}) {
  // With duplicate sessions there is more than one xterm on the page; the
  // hidden ones keep their own helper textarea, so focus the visible one.
  if (visibleOnly) {
    await browser.execute(() => {
      const wrapper = [...document.querySelectorAll(".session-tab-wrapper")]
        .find((el) => el.style.display !== "none");
      (wrapper ?? document).querySelector(".xterm-helper-textarea")?.focus();
    });
  } else {
    await browser.execute(() => document.querySelector(".xterm-helper-textarea")?.focus());
  }
  const sequence = Array.isArray(keys) ? keys : [...keys];
  // A modifier chord must stay in one command, otherwise WebKit releases the
  // modifier before the character arrives (Ctrl+W becomes a plain "w").
  if (sequence.some((key) => /[\uE008-\uE00A\uE03D]/.test(key))) {
    await browser.keys(sequence);
    return;
  }
  // WebKitWebDriver coalesces a run of identical characters inside one keys()
  // call, so "zzzz" arrives as a single "z" and "disconnect" loses its doubled
  // letter. One character per command keeps the real keystroke path and the
  // exact byte counts the scenarios assert on.
  for (const key of sequence) {
    await browser.keys(key);
    await pause(5);
  }
}

/** The active terminal buffer as text, one line per row; "" before it mounts. */
export async function terminalText(browser) {
  return browser.execute(() => {
    const terminal = window.__comndTerminal;
    if (!terminal) return "";
    const buffer = terminal.buffer.active;
    return Array.from({ length: buffer.length }, (_, index) =>
      buffer.getLine(index)?.translateToString(true) ?? "",
    ).join("\n");
  });
}

/** Wait for the terminal buffer to contain `text`; `message` names the wait. */
export async function waitForTerminal(
  browser,
  text,
  message = `Terminal did not show ${JSON.stringify(text)}`,
  timeout = 20_000,
) {
  await browser.waitUntil(async () => (await terminalText(browser)).includes(text), {
    timeout,
    interval: 100,
    timeoutMsg: message,
  });
}

/** Clear a first-connect host-key confirmation, or wait for the connection to settle. */
export async function acceptHostKeyIfNeeded(browser) {
  await browser.waitUntil(async () => {
    const state = await browser.execute(() => ({
      accept: [...document.querySelectorAll("button")].some(
        (button) => button.textContent?.trim() === "Accept and save",
      ),
      connected: !!document.querySelector(".tv-sb-dot.sb-connected"),
      failed: !!document.querySelector(".tv-overlay-error:not(.hidden)"),
    }));
    if (state.accept) {
      await browser.execute(() => {
        [...document.querySelectorAll("button")]
          .find((button) => button.textContent?.trim() === "Accept and save")
          ?.click();
      });
      return true;
    }
    return state.connected || state.failed;
  }, {
    timeout: WAIT_MS,
    interval: 100,
    timeoutMsg: "Host-key confirmation did not appear and SSH did not finish",
  });
}

/** Expand a collapsible nav section (Knowledge Base, Replay) if it is closed. */
export async function openNavSection(browser, section) {
  const selector = `.nav-section-header[data-section="${section}"]`;
  await waitForSelector(browser, selector, `the ${section} nav section did not render`);
  const expanded = () => browser.execute(
    (sel) => document.querySelector(sel)?.getAttribute("aria-expanded") === "true",
    selector,
  );
  if (!(await expanded())) {
    await actOn(browser, selector);
  }
  await browser.waitUntil(expanded, {
    timeout: WAIT_MS,
    interval: 100,
    timeoutMsg: `the ${section} nav section did not expand`,
  });
}

/** Expand a folder row in the nav tree if it is collapsed. */
export async function expandNavGroup(browser, groupId) {
  const selector = `.nav-group-row[data-group-id="${groupId}"]`;
  await waitForSelector(browser, selector, `nav group ${groupId} did not render`);
  const collapsed = () => browser.execute((sel) => {
    const row = document.querySelector(sel);
    if (!row) return true;
    return (row.querySelector(".nav-toggle")?.textContent ?? "").includes("▸");
  }, selector);
  if (await collapsed()) {
    await actOn(browser, `${selector} .nav-item`);
  }
  await browser.waitUntil(async () => !(await collapsed()), {
    timeout: WAIT_MS,
    interval: 100,
    timeoutMsg: `the nav group ${groupId} did not expand`,
  });
}

/** The toast container's live-region mode and every toast's shape and text. */
export const toastState = (browser) => browser.execute(() => {
  const container = document.querySelector("#toast-container");
  return {
    live: container?.getAttribute("aria-live") ?? null,
    toasts: [...document.querySelectorAll("#toast-container .toast")].map((toast) => ({
      message: (toast.querySelector(".toast-message")?.textContent ?? "").trim(),
      role: toast.getAttribute("role"),
      className: toast.className,
      insideLiveRegion: !!toast.closest('[aria-live]:not([aria-live="off"])'),
      dismissName: toast.querySelector(".toast-close")?.getAttribute("aria-label") ?? "",
    })),
  };
});

export const clearToasts = (browser) => browser.execute(() => {
  document.querySelectorAll("#toast-container .toast").forEach((toast) => toast.remove());
});

/** Wait for a toast matching `pattern`; returns the whole container state. */
export async function waitForToast(browser, pattern, label) {
  try {
    await browser.waitUntil(async () => {
      const state = await toastState(browser);
      return state.toasts.some((toast) => pattern.test(toast.message));
    }, { timeout: WAIT_MS, interval: 100, timeoutMsg: `${label}: no toast matched ${pattern}` });
  } catch (error) {
    const state = await toastState(browser).catch(() => null);
    throw new Error(`${error.message}; toasts were ${JSON.stringify(state?.toasts ?? [])}`);
  }
  return toastState(browser);
}

/** Open the app under an already-running driver, and wait until it has a page. */
export async function openSession(port) {
  const browser = await remote({
    hostname: "127.0.0.1",
    port,
    path: "/",
    logLevel: "error",
    capabilities: {
      "tauri:options": { application: appPath },
    },
  });
  await browser.setTimeout({ implicit: 0, pageLoad: 30_000, script: 30_000 });
  // `#app` rather than `body`: the initial about:blank document also has a
  // body, and scripting it races the real page, where the app's IPC global
  // does not exist yet.
  await waitForSelector(browser, "#app", "the app window never rendered its root", { timeout: 20_000 });
  return browser;
}

// ─── Multi-window helpers (plan 066) ────────────────────────────────
//
// Windows are told apart by a marker the app sets on its own document, not by
// title or URL: the panel window loads the same `index.html`, so both windows
// report the same `document.title` and `location.href` to WebDriver, and
// neither exposes the Tauri window label to the page.

const WINDOW_MARKERS = { main: "main", panel: "panel" };

async function windowMarker(browser) {
  return browser.execute(() => document.documentElement.dataset.comndWindow ?? null);
}

/**
 * Switch to the window whose document is marked `marker`.
 *
 * Returns the handle to restore. Polls, because a freshly created window is not
 * scriptable until its document has loaded — `switchToWindow` on the handle of
 * a half-built window fails rather than returning a blank document.
 */
export async function switchToWindow(browser, marker, timeoutMsg, timeout = WAIT_MS) {
  const until = Date.now() + timeout;
  for (;;) {
    const previous = await browser.getWindowHandle();
    let handles = [];
    try {
      handles = await browser.getWindowHandles();
    } catch {
      handles = [];
    }
    for (const handle of handles) {
      try {
        await browser.switchToWindow(handle);
        if ((await windowMarker(browser)) === marker) return { handle, previous };
      } catch {
        // A window that is still loading rejects the switch; retry below.
      }
    }
    if (handles.includes(previous)) await browser.switchToWindow(previous);
    if (Date.now() >= until) throw new Error(timeoutMsg);
    await pause(100);
  }
}

/** Every handle, so a scenario can prove a second window does or does not exist. */
export async function windowHandles(browser) {
  return browser.getWindowHandles();
}

/** Poll until the app owns exactly `count` windows. */
export async function waitForWindowCount(browser, count, timeoutMsg, timeout = WAIT_MS) {
  let seen = -1;
  try {
    await browser.waitUntil(async () => {
      seen = (await browser.getWindowHandles()).length;
      return seen === count;
    }, { timeout, interval: 100, timeoutMsg });
  } catch {
    throw new Error(`${timeoutMsg}: expected ${count} window(s), last saw ${seen}`);
  }
}

/** Poll until no window is marked `marker` — the panel window is destroyed,
 *  not hidden, so a docked panel has to leave the window list. */
export async function waitForNoWindow(browser, marker, timeoutMsg, timeout = WAIT_MS) {
  const until = Date.now() + timeout;
  for (;;) {
    // The current window may be the very one the app just destroyed, in which
    // case even reading the handle fails. Treat that as "no previous window".
    const previous = await browser.getWindowHandle().catch(() => null);
    let found = false;
    for (const handle of await browser.getWindowHandles()) {
      try {
        await browser.switchToWindow(handle);
        if ((await windowMarker(browser)) === marker) found = true;
      } catch {
        // A destroyed window stays listed for a moment, and a window that is
        // still building has not rendered the panel either. Neither proves the
        // panel is present, so fall through and re-read the list next poll.
      }
      if (found) break;
    }
    if (!found) {
      const handles = await browser.getWindowHandles();
      if (previous && handles.includes(previous)) await browser.switchToWindow(previous);
      return;
    }
    if (Date.now() >= until) throw new Error(timeoutMsg);
    await pause(100);
  }
}

/** Run `fn` in `handle`, then go back to the window that was current. */
export async function withWindow(browser, handle, fn) {
  const previous = await browser.getWindowHandle();
  await browser.switchToWindow(handle);
  try {
    return await fn();
  } finally {
    if (previous !== handle) await browser.switchToWindow(previous);
  }
}

export { WINDOW_MARKERS };

// ─── Per-boot display (Linux) ───────────────────────────────────────
//
// Under a scenario pool, two app windows cannot both hold keyboard focus on
// one X display: the second one reports `document focused false` and the
// focus-ring assertions fail. Each boot therefore gets its own Xvfb display,
// sized like `xvfb-run`'s default so geometry assertions see the same screen.
// Outside a pool this is still what runs, because an isolated display is
// cheaper than reasoning about what else shares one.

let nextDisplay = 20 + (process.pid % 60);

async function startDisplay() {
  if (process.platform !== "linux") return null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const display = nextDisplay;
    nextDisplay = nextDisplay >= 99 ? 20 : nextDisplay + 1;
    if (existsSync(`/tmp/.X11-unix/X${display}`) || existsSync(`/tmp/.X${display}-lock`)) continue;
    const server = spawn(
      "Xvfb",
      [`:${display}`, "-screen", "0", "1280x1024x24", "-nolisten", "tcp"],
      { stdio: "ignore" },
    );
    const until = Date.now() + 5_000;
    while (Date.now() < until) {
      if (existsSync(`/tmp/.X11-unix/X${display}`)) return { server, display };
      // Exited without a socket: the number was taken between the check above
      // and the spawn, so try the next one.
      if (server.exitCode !== null) break;
      await pause(50);
    }
    if (server.exitCode === null) server.kill();
    if (server.exitCode !== null && Date.now() < until) continue;
    throw new Error(`Xvfb :${display} did not start within 5 seconds`);
  }
  throw new Error("Xvfb could not allocate a free display; check the xvfb package");
}

// A runner has no GPU and no accessibility bus, and WebKitGTK's DMA-BUF
// renderer, compositing and AT-SPI bridge each stall window start-up there;
// its bubblewrap sandbox also cannot initialise in the runner container. None
// of these change what the scenarios assert (DOM state and geometry), and the
// session phase of each PASS line shows whether a knob is still needed.
const headlessWebkitEnv = () => (process.platform === "linux"
  ? {
    WEBKIT_DISABLE_DMABUF_RENDERER: "1",
    WEBKIT_DISABLE_COMPOSITING_MODE: "1",
    WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS: "1",
    NO_AT_BRIDGE: "1",
  }
  : {});

// Windows keeps WebView2's user-data folder (cookies, localStorage) outside
// `COMND_DATA_DIR`, so a pooled run would share one profile between scenarios:
// the app process trees are linked through it, and one scenario's stored state
// can change another's results. WebView2 reads this variable at startup, and
// the folder lives inside the scenario's data directory, so it is removed with
// it. The Linux equivalent, the Xvfb display, is per boot for the same reason.
const webviewProfileEnv = (dataDir) => (process.platform === "win32"
  ? { WEBVIEW2_USER_DATA_FOLDER: path.join(dataDir, "webview2") }
  : {});

export async function startDriver(dataDir, extraEnv = {}) {
  const port = await freePort();
  // tauri-driver forwards to the platform WebDriver, which listens on its own
  // native port. Left at the default, every driver instance shares it, so two
  // scenarios running at once knock each other's sessions out ("invalid
  // session id", or a session attached to the other scenario's app).
  const nativePort = await freePort();
  const display = await startDisplay();
  const env = {
    ...process.env,
    ...headlessWebkitEnv(),
    ...webviewProfileEnv(dataDir),
    ...(display ? { DISPLAY: `:${display.display}` } : {}),
    COMND_DATA_DIR: dataDir,
    COMND_TEST_MOCK_SECRET: "smoke-secret",
    ...extraEnv,
  };
  // App-side mutation (issue #61): ssh_send drops typed input, so the mutation
  // check proves the suite catches broken app code, not a silent mock. Drop any
  // inherited value first so a normal run never mutates the app.
  delete env.COMND_SMOKE_MUTATION;
  if (extraEnv.COMND_SMOKE_MUTATION) env.COMND_SMOKE_MUTATION = extraEnv.COMND_SMOKE_MUTATION;
  const driver = spawn("tauri-driver", ["--port", String(port), "--native-port", String(nativePort)], {
    cwd: root,
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  driver.stderr.on("data", (chunk) => {
    if (stderr.length < 4000) stderr += chunk.toString();
  });
  return { driver, port, display, driverLog: () => stderr.trim() };
}

/**
 * Boot one app process and its WebDriver session against `dataDir`.
 *
 * Split out of `runCase` because a scenario that spans a relaunch
 * (`test.phases`) boots twice against the *same* data directory: the whole
 * point is that the second launch reads what the first one persisted.
 */
async function bootApp(dataDir, suite) {
  const started = await startDriver(dataDir, suite.env);
  const timings = { driver: 0, session: 0 };
  let browser;
  const driverStarted = Date.now();
  try {
    await waitForDriver(started.driver, started.port, started.driverLog);
    timings.driver = Date.now() - driverStarted;
    const sessionStarted = Date.now();
    browser = await openSession(started.port);
    timings.session = Date.now() - sessionStarted;
  } catch (error) {
    if (started.driver.exitCode === null) started.driver.kill();
    if (started.display?.server.exitCode === null) started.display.server.kill();
    throw error;
  }
  return { driver: started.driver, browser, display: started.display, driverLog: started.driverLog, timings };
}

/** Tear down one boot: the suite's teardown, then the session, the driver and the display. */
async function shutdownApp({ driver, browser, display }, teardown) {
  let cleanupError;
  let teardownError;
  const timings = { stop: 0, close: 0, kill: 0 };
  if (browser) {
    const stopStarted = Date.now();
    try {
      await withTimeout(teardown(browser), 15_000, "suite teardown");
    } catch (caught) {
      teardownError = caught;
    }
    timings.stop = Date.now() - stopStarted;
    const closeStarted = Date.now();
    try {
      await withTimeout(browser.deleteSession(), 20_000, "session teardown");
    } catch (caught) {
      // Ending the session on a window the app has already destroyed is not a
      // leak: the driver is killed below either way, and the data dir is removed.
      // Neither is a closed transport: undici can lose the keep-alive socket
      // between the teardown command and this DELETE (UND_ERR_CLOSED), and the
      // driver kill that follows ends any session that was still open.
      const alreadyGone = /no such window|no such session|UND_ERR_CLOSED|UND_ERR_SOCKET|ECONNRESET|ECONNREFUSED|socket hang up/i;
      if (!alreadyGone.test(String(caught?.message ?? caught))) cleanupError = caught;
    }
    timings.close = Date.now() - closeStarted;
  }
  if (driver && driver.exitCode === null) {
    const killStarted = Date.now();
    driver.kill();
    await Promise.race([
      new Promise((resolve) => driver.once("exit", resolve)),
      pause(5_000),
    ]);
    timings.kill = Date.now() - killStarted;
  }
  if (display?.server.exitCode === null) display.server.kill();
  return { cleanupError, teardownError, timings };
}

/** The failure report: what the user could see when the scenario broke. */
async function describeFailure(browser, caught) {
  if (!browser) return caught;
  const state = await withTimeout(browser.execute(() => ({
    text: document.body.innerText,
    terminal: !!document.querySelector(".tv-terminal"),
    connected: !!document.querySelector(".tv-sb-dot.sb-connected"),
  })), 15_000, "failure state capture").catch(() => null);
  if (!state) return caught;
  return new Error(
    `${caught.message}\nVisible app text: ${state.text}\nTerminal mounted: ${state.terminal}; connected: ${state.connected}`,
    { cause: caught },
  );
}

/** Shared pass/fail reporting for `runCase` and `runBoots`. */
function reportCase(test, { error, cleanupError, teardownError, appReady, dataDir, timings }) {
  // `timings` rides on the failure so the suite can still print which phase ate
  // the time when a scenario goes red.
  const fail = (message, cause) => {
    const failure = new Error(message, { cause });
    failure.timings = timings;
    return failure;
  };
  // Before the app window is up the suite's debug command may not exist yet, so
  // a teardown failure there is not actionable. Afterwards it is: a scenario
  // that reports PASS must have stopped the mock it started.
  if (teardownError && appReady) {
    cleanupError ??= teardownError;
  }
  if (existsSync(dataDir)) {
    cleanupError ??= new Error(`Temporary app data was not removed: ${dataDir}`);
  }
  if (cleanupError) {
    // Keep the scenario's own failure visible instead of replacing it.
    const after = error ? ` (after: ${error.message})` : "";
    throw fail(`${test.name}: cleanup failed: ${cleanupError.message}${after}`, error);
  }
  if (test.expectedFailure) {
    try {
      assert(error, `${test.name}: expected the deliberate failure, but the behavior passed`);
      assert.match(String(error.message ?? error), test.expectedFailure);
    } catch (caught) {
      throw fail(caught.message, caught);
    }
    return { expected: `EXPECTED FAILURE: ${error.message}`, timings };
  }
  if (error) throw fail(`${test.name}: ${error.message}`, error);
  return { expected: null, timings };
}

/**
 * Run one scenario in its own app process and its own data directory.
 *
 * `suite` supplies the per-suite parts: `env` merged into the app process
 * environment, and `teardown(browser)` run before the session is closed (the
 * default stops the SSH mock, which every SSH scenario starts).
 *
 * A scenario with `needsApp: false` asserts on helpers rather than the running
 * app, so it skips the boot: an app launch costs more than the assertion does.
 *
 * Returns `{ expected, timings }`, where `timings` records every phase in
 * milliseconds, so a slow suite can be read off its own log.
 */
export async function runCase(test, suite = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), `comnd-smoke-${test.name}-`));
  const teardown = suite.teardown ?? ((browser) => invoke(browser, "test_stop_mock_server"));
  const timings = emptyTimings();
  let app;
  let error;
  let appReady = false;
  let cleanupError;
  let teardownError;
  let runStarted = 0;

  try {
    if (test.needsApp === false) {
      appReady = true;
    } else {
      app = await bootApp(dataDir, suite);
      addTimings(timings, app.timings);
      appReady = true;
      // A session that takes seconds to create is the app start-up, and the
      // driver's stderr is the only place WebKitGTK explains itself. Print it
      // where the log will be read rather than only when a boot fails.
      if (app.timings.session > 5_000) {
        console.log(`${test.name}: slow session ${secs(app.timings.session)}; `
          + `driver log: ${app.driverLog() || "(empty)"}`);
      }
    }
    runStarted = Date.now();
    // A wedged WebDriver session otherwise blocks the whole job until its timeout.
    await withTimeout(Promise.resolve(test.run(app?.browser, dataDir)), SCENARIO_TIMEOUT_MS, test.name);
    timings.run = Date.now() - runStarted;
  } catch (caught) {
    if (runStarted) timings.run = Date.now() - runStarted;
    error = await describeFailure(app?.browser, caught);
  } finally {
    if (app) {
      const shut = await shutdownApp(app, teardown);
      addTimings(timings, shut.timings);
      cleanupError = shut.cleanupError;
      teardownError = shut.teardownError;
    }
    try {
      await rm(dataDir, { recursive: true, force: true });
    } catch (caught) {
      cleanupError ??= caught;
    }
  }

  return reportCase(test, { error, cleanupError, teardownError, appReady, dataDir, timings });
}

/**
 * Run one scenario that spans a relaunch: every entry in `test.phases` gets its
 * own app process and session, but all of them share one data directory. That is
 * the only way to prove a persisted value survives a quit — an in-process reload
 * keeps module state and the app's own config cache alive.
 */
export async function runBoots(test, suite = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), `comnd-smoke-${test.name}-`));
  const teardown = suite.teardown ?? ((browser) => invoke(browser, "test_stop_mock_server"));
  const timings = emptyTimings();
  let error;
  let appReady = false;
  let cleanupError;
  let teardownError;

  try {
    for (const [index, phase] of test.phases.entries()) {
      const app = await bootApp(dataDir, suite);
      addTimings(timings, app.timings);
      appReady = true;
      const runStarted = Date.now();
      try {
        await withTimeout(phase(app.browser, dataDir), SCENARIO_TIMEOUT_MS, `${test.name} boot ${index + 1}`);
      } catch (caught) {
        error = await describeFailure(app.browser, new Error(
          `${test.name}: launch ${index + 1} of ${test.phases.length}: ${caught.message}`,
          { cause: caught },
        ));
      } finally {
        timings.run += Date.now() - runStarted;
        const shut = await shutdownApp(app, teardown);
        addTimings(timings, shut.timings);
        cleanupError = shut.cleanupError ?? cleanupError;
        teardownError = shut.teardownError ?? teardownError;
      }
      if (error) break;
    }
  } finally {
    try {
      await rm(dataDir, { recursive: true, force: true });
    } catch (caught) {
      cleanupError ??= caught;
    }
  }

  return reportCase(test, { error, cleanupError, teardownError, appReady, dataDir, timings });
}

/**
 * Run every scenario, report pass/fail per scenario, and exit non-zero on failure.
 *
 * `suite.jobs` runs that many scenarios at once. Scenarios are independent —
 * each boots its own driver and app on its own port against its own data
 * directory — so a pool is safe, and on CI the per-scenario cost is mostly
 * waiting, which overlapping recovers almost linearly. Keep it below the
 * runner's core count: the app renders in software under Xvfb.
 */
export async function runSuite(tests, suite = {}) {
  const jobs = Math.max(1, Math.min(suite.jobs ?? 1, tests.length));
  const results = new Array(tests.length);
  const started = Date.now();
  let cursor = 0;

  const worker = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= tests.length) return;
      const test = tests[index];
      const caseStarted = Date.now();
      try {
        const result = test.phases ? await runBoots(test, suite) : await runCase(test, suite);
        results[index] = { ok: true, elapsed: Date.now() - caseStarted, ...result };
      } catch (error) {
        results[index] = { ok: false, elapsed: Date.now() - caseStarted, error };
      }
    }
  };
  await Promise.all(Array.from({ length: jobs }, worker));

  let failures = 0;
  for (const [index, result] of results.entries()) {
    const test = tests[index];
    const timings = result.ok ? result.timings : result.error.timings;
    const breakdown = formatTimings(result.elapsed, timings);
    if (result.ok) {
      console.log(`PASS ${test.name}${breakdown}${result.expected ? ` — ${result.expected}` : ""}`);
    } else {
      failures += 1;
      console.error(`FAIL ${test.name}${breakdown}: ${result.error.message}`);
    }
  }
  console.log(`${tests.length} scenario(s) with ${jobs} worker(s) in ${secs(Date.now() - started)}, ${failures} failure(s)`);
  // The driver's grandchildren can inherit its stderr pipe, so returning
  // normally leaves Node alive and the CI job hangs until its own timeout.
  process.exit(failures ? 1 : 0);
}
