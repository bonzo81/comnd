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
 * Run one scenario in its own app process and its own data directory.
 *
 * `suite` supplies the per-suite parts: `env` merged into the app process
 * environment, and `teardown(browser)` run before the session is closed (the
 * default stops the SSH mock, which every SSH scenario starts).
 */
export async function runCase(test, suite = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), `comnd-smoke-${test.name}-`));
  const teardown = suite.teardown ?? ((browser) => invoke(browser, "test_stop_mock_server"));
  let driver;
  let browser;
  let error;
  let cleanupError;
  let teardownError;
  let appReady = false;

  try {
    const started = await startDriver(dataDir, suite.env);
    driver = started.driver;
    await waitForDriver(driver, started.port, started.driverLog);
    browser = await remote({
      hostname: "127.0.0.1",
      port: started.port,
      path: "/",
      logLevel: "error",
      capabilities: {
        "tauri:options": { application: appPath },
      },
    });
    await browser.setTimeout({ implicit: 0, pageLoad: 30_000, script: 30_000 });
    await (await browser.$("body")).waitForExist({ timeout: 20_000 });
    appReady = true;
    // A wedged WebDriver session otherwise blocks the whole job until its timeout.
    await withTimeout(test.run(browser, dataDir), SCENARIO_TIMEOUT_MS, test.name);
  } catch (caught) {
    error = caught;
    if (browser) {
      const state = await withTimeout(browser.execute(() => ({
        text: document.body.innerText,
        terminal: !!document.querySelector(".tv-terminal"),
        connected: !!document.querySelector(".tv-sb-dot.sb-connected"),
      })), 15_000, "failure state capture").catch(() => null);
      if (state) {
        error = new Error(
          `${caught.message}\nVisible app text: ${state.text}\nTerminal mounted: ${state.terminal}; connected: ${state.connected}`,
          { cause: caught },
        );
      }
    }
  } finally {
    if (browser) {
      try {
        await withTimeout(teardown(browser), 15_000, "suite teardown");
      } catch (caught) {
        teardownError = caught;
      }
      try {
        await withTimeout(browser.deleteSession(), 20_000, "session teardown");
      } catch (caught) {
        cleanupError ??= caught;
      }
    }
    if (driver && driver.exitCode === null) {
      driver.kill();
      await Promise.race([
        new Promise((resolve) => driver.once("exit", resolve)),
        pause(5_000),
      ]);
    }
    try {
      await rm(dataDir, { recursive: true, force: true });
    } catch (caught) {
      cleanupError ??= caught;
    }
  }

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

/** Run every scenario, report pass/fail per scenario, and exit non-zero on failure. */
export async function runSuite(tests, suite = {}) {
  let failures = 0;
  for (const test of tests) {
    try {
      const expected = await runCase(test, suite);
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
