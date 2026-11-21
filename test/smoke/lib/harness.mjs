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

export async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
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
  // Safe: `body` is never replaced by a render, and the handle is used once.
  await (await browser.$("body")).waitForExist({ timeout: 20_000 });
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

export async function startDriver(dataDir, extraEnv = {}) {
  const port = await freePort();
  const env = {
    ...process.env,
    COMND_DATA_DIR: dataDir,
    COMND_TEST_MOCK_SECRET: "smoke-secret",
    ...extraEnv,
  };
  // App-side mutation (issue #61): ssh_send drops typed input, so the mutation
  // check proves the suite catches broken app code, not a silent mock. Drop any
  // inherited value first so a normal run never mutates the app.
  delete env.COMND_SMOKE_MUTATION;
  if (extraEnv.COMND_SMOKE_MUTATION) env.COMND_SMOKE_MUTATION = extraEnv.COMND_SMOKE_MUTATION;
  const driver = spawn("tauri-driver", ["--port", String(port)], {
    cwd: root,
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  driver.stderr.on("data", (chunk) => {
    if (stderr.length < 4000) stderr += chunk.toString();
  });
  return { driver, port, driverLog: () => stderr.trim() };
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
  let browser;
  try {
    await waitForDriver(started.driver, started.port, started.driverLog);
    browser = await openSession(started.port);
  } catch (error) {
    if (started.driver.exitCode === null) started.driver.kill();
    throw error;
  }
  return { driver: started.driver, browser };
}

/** Tear down one boot: the suite's teardown, then the session, then the driver. */
async function shutdownApp({ driver, browser }, teardown) {
  let cleanupError;
  let teardownError;
  if (browser) {
    try {
      await withTimeout(teardown(browser), 15_000, "suite teardown");
    } catch (caught) {
      teardownError = caught;
    }
    try {
      await withTimeout(browser.deleteSession(), 20_000, "session teardown");
    } catch (caught) {
      // Ending the session on a window the app has already destroyed is not a
      // leak: the driver is killed below either way, and the data dir is removed.
      if (!/no such window/i.test(String(caught?.message ?? caught))) cleanupError = caught;
    }
  }
  if (driver && driver.exitCode === null) {
    driver.kill();
    await Promise.race([
      new Promise((resolve) => driver.once("exit", resolve)),
      pause(5_000),
    ]);
  }
  return { cleanupError, teardownError };
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
function reportCase(test, { error, cleanupError, teardownError, appReady, dataDir }) {
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
    throw new Error(`${test.name}: cleanup failed: ${cleanupError.message}${after}`, { cause: error });
  }
  if (test.expectedFailure) {
    assert(error, `${test.name}: expected the deliberate failure, but the behavior passed`);
    assert.match(String(error.message ?? error), test.expectedFailure);
    return `EXPECTED FAILURE: ${error.message}`;
  }
  if (error) throw new Error(`${test.name}: ${error.message}`, { cause: error });
  return null;
}

/**
 * Run one scenario in its own app process and its own data directory.
 *
 * `suite` supplies the per-suite parts: `env` merged into the app process
 * environment, and `teardown(browser)` run before the session is closed (the
 * default stops the SSH mock, which every SSH scenario starts).
 */
export async function runCase(test, suite = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), `comnd-smoke-${test.name}-`));
  const teardown = suite.teardown ?? ((browser) => invoke(browser, "test_stop_mock_server"));
  let app;
  let error;
  let appReady = false;
  let cleanupError;
  let teardownError;

  try {
    app = await bootApp(dataDir, suite);
    appReady = true;
    // A wedged WebDriver session otherwise blocks the whole job until its timeout.
    await withTimeout(test.run(app.browser, dataDir), SCENARIO_TIMEOUT_MS, test.name);
  } catch (caught) {
    error = await describeFailure(app?.browser, caught);
  } finally {
    if (app) {
      const shut = await shutdownApp(app, teardown);
      cleanupError = shut.cleanupError;
      teardownError = shut.teardownError;
    }
    try {
      await rm(dataDir, { recursive: true, force: true });
    } catch (caught) {
      cleanupError ??= caught;
    }
  }

  return reportCase(test, { error, cleanupError, teardownError, appReady, dataDir });
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
  let error;
  let appReady = false;
  let cleanupError;
  let teardownError;

  try {
    for (const [index, phase] of test.phases.entries()) {
      const app = await bootApp(dataDir, suite);
      appReady = true;
      try {
        await withTimeout(phase(app.browser, dataDir), SCENARIO_TIMEOUT_MS, `${test.name} boot ${index + 1}`);
      } catch (caught) {
        error = await describeFailure(app.browser, new Error(
          `${test.name}: launch ${index + 1} of ${test.phases.length}: ${caught.message}`,
          { cause: caught },
        ));
      } finally {
        const shut = await shutdownApp(app, teardown);
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

  return reportCase(test, { error, cleanupError, teardownError, appReady, dataDir });
}

/** Run every scenario, report pass/fail per scenario, and exit non-zero on failure. */
export async function runSuite(tests, suite = {}) {
  let failures = 0;
  for (const test of tests) {
    try {
      const expected = test.phases ? await runBoots(test, suite) : await runCase(test, suite);
      console.log(`PASS ${test.name}${expected ? ` — ${expected}` : ""}`);
    } catch (error) {
      failures += 1;
      console.error(`FAIL ${test.name}: ${error.message}`);
    }
  }
  // The driver's grandchildren can inherit its stderr pipe, so returning
  // normally leaves Node alive and the CI job hangs until its own timeout.
  process.exit(failures ? 1 : 0);
}
