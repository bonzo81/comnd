import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { remote } from "webdriverio";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const mutationRun = process.argv.includes("--mutation");
const appPath = path.join(
  root,
  "src-tauri",
  "target",
  "debug",
  process.platform === "win32" ? "comnd.exe" : "comnd",
);

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SCENARIO_TIMEOUT_MS = 180_000;

// CI runners are slow (debug build, Xvfb, WebKit); a tight wait turns runner
// latency into a false failure. The per-scenario cap still bounds the suite.
const WAIT_MS = 30_000;

function withTimeout(promise, ms, label) {
  let timer;
  const timerPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not finish within ${ms}ms`)), ms);
  });
  return Promise.race([promise, timerPromise]).finally(() => clearTimeout(timer));
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForDriver(driver, port, driverLog) {
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

function buildApp() {
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

async function invoke(browser, command, args = {}) {
  return browser.execute(
    (name, payload) => window.__TAURI_INTERNALS__.invoke(name, payload),
    command,
    args,
  );
}

async function terminalText(browser) {
  return browser.execute(() => {
    const terminal = window.__comndTerminal;
    if (!terminal) return "";
    const buffer = terminal.buffer.active;
    return Array.from({ length: buffer.length }, (_, index) =>
      buffer.getLine(index)?.translateToString(true) ?? "",
    ).join("\n");
  });
}

async function waitForTerminal(browser, text, timeout = 20_000) {
  await browser.waitUntil(async () => (await terminalText(browser)).includes(text), {
    timeout,
    interval: 100,
    timeoutMsg: `Terminal did not show ${JSON.stringify(text)}`,
  });
}

async function readBytes(browser) {
  return Array.from(await invoke(browser, "test_smoke_received"));
}

function escapeBytes(bytes) {
  return `[${bytes.map((byte) => (byte === 0x09 ? "0x09" : byte >= 0x20 && byte < 0x7f
    ? JSON.stringify(String.fromCharCode(byte))
    : `0x${byte.toString(16).padStart(2, "0")}`)).join(" ")}]`;
}

async function inputState(browser) {
  return browser.execute(() => {
    const style = (selector) => {
      const el = document.querySelector(selector);
      // getClientRects() is empty when an ancestor is hidden, which
      // getComputedStyle() alone would miss.
      return !!el && el.getClientRects().length > 0 && getComputedStyle(el).display !== "none";
    };
    return {
      ghost: style(".ghost-text"),
      ghostText: document.querySelector(".ghost-text")?.textContent ?? null,
      dropdown: style(".suggestion-dropdown"),
      suggestionsPressed: document.querySelector(".tv-suggestions-btn")?.getAttribute("aria-pressed") ?? null,
      focused: document.activeElement?.className ?? null,
      connected: !!document.querySelector(".tv-sb-dot.sb-connected"),
      banner: style(".tv-banner"),
      hostList: style(".hs-host-list"),
      overlayError: style(".tv-overlay-error"),
    };
  }).catch(() => null);
}

async function waitForBytes(browser, length, behavior) {
  const expectation = `${behavior}: Mock host did not receive ${length} bytes`;
  try {
    await browser.waitUntil(async () => (await readBytes(browser)).length >= length, {
      timeout: WAIT_MS,
      interval: 50,
      timeoutMsg: expectation,
    });
  } catch (error) {
    // A failed read must not look like a successful read of zero bytes, or the
    // mutation matcher would accept a run that never proved the mock got nothing.
    const received = await readBytes(browser).catch(() => null);
    const observed = received
      ? `mock received ${received.length} bytes ${escapeBytes(received)}`
      : "mock byte count unavailable";
    throw new Error(
      `${expectation}; ${observed}; `
      + `input state ${JSON.stringify(await inputState(browser))} (waitUntil: ${error.message})`,
    );
  }
  return readBytes(browser);
}

function assertBytes(actual, expected, behavior) {
  assert.deepEqual(
    actual,
    expected,
    `${behavior}: expected [${expected.join(" ")}], received [${actual.join(" ")}]`,
  );
}

function countOccurrences(text, value) {
  return text.split(value).length - 1;
}

async function acceptHostKeyIfNeeded(browser) {
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

async function createAndConnect(
  browser,
  dataDir,
  { rejectAuth = false, muteOutput = false, interactiveAuth = false } = {},
) {
  const port = await invoke(browser, "test_smoke_server", { rejectAuth, muteOutput });
  const host = await invoke(browser, "save_host", {
    host: {
      id: "",
      display_name: "Smoke test host",
      hostname: "127.0.0.1",
      port,
      username: "smoke",
      credential: interactiveAuth
        ? { type: "password" }
        : {
            type: "secret_ref",
            provider: "mock",
            reference: "smoke",
            label: "Smoke test secret",
          },
      platform: "linux-bash",
      highlight_profile: "none",
      tags: [],
    },
  });
  assert(existsSync(path.join(dataDir, "hosts.json")), "Isolation: host data was not written under COMND_DATA_DIR");
  await invoke(browser, "touch_host", { id: host.id });
  await browser.refresh();

  const selector = `.hs-host-item[data-host-id="${host.id}"]`;
  const item = await browser.$(selector);
  await item.waitForDisplayed({ timeout: 15_000 });
  await item.click();
  await browser.waitUntil(async () => (await browser.$(selector).getAttribute("aria-selected")) === "true", {
    timeout: 5_000,
    interval: 100,
    timeoutMsg: "Known smoke-test host was not selected",
  });
  await (await browser.$(selector)).doubleClick();
  await acceptHostKeyIfNeeded(browser);
  return host;
}

async function waitForConnection(browser) {
  await browser.waitUntil(async () => {
    const classes = await (await browser.$(".tv-sb-dot")).getAttribute("class");
    return classes?.includes("sb-connected") ?? false;
  }, {
    timeout: 20_000,
    interval: 100,
    timeoutMsg: "SSH connection did not reach the connected state",
  });
  await waitForTerminal(browser, "user@host:~$");
}

async function waitForSessionCleanup(browser, label) {
  await browser.waitUntil(async () => browser.execute(() => {
    return !document.querySelector(".tv-terminal")
      && document.body.innerText.includes("0 sessions");
  }), {
    timeout: WAIT_MS,
    interval: 100,
    timeoutMsg: `${label}: terminal session was not removed`,
  });
}

async function sendKeys(browser, keys) {
  await browser.execute(() => document.querySelector(".xterm-helper-textarea")?.focus());
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

async function startDriver(dataDir) {
  const port = await freePort();
  const env = {
    ...process.env,
    COMND_DATA_DIR: dataDir,
    COMND_TEST_MOCK_SECRET: "smoke-secret",
  };
  // App-side mutation (issue #61): ssh_send drops typed input, so the mutation
  // check proves the suite catches broken app code, not a silent mock. Drop any
  // inherited value first so a normal run never mutates the app.
  delete env.COMND_SMOKE_MUTATION;
  if (mutationRun) env.COMND_SMOKE_MUTATION = "ssh_send";
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

async function runCase(test) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), `comnd-smoke-${test.name}-`));
  let driver;
  let browser;
  let error;
  let cleanupError;

  try {
    const started = await startDriver(dataDir);
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
        await withTimeout(invoke(browser, "test_stop_mock_server"), 15_000, "mock server stop");
      } catch {
        // The app may have failed before the debug command became available.
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

  if (existsSync(dataDir)) {
    cleanupError ??= new Error(`Temporary app data was not removed: ${dataDir}`);
  }
  if (cleanupError) {
    throw new Error(`${test.name}: cleanup failed: ${cleanupError.message}`, { cause: error });
  }
  if (test.expectedFailure) {
    assert(error, `${test.name}: expected the deliberate failure, but the behavior passed`);
    assert.match(String(error.message ?? error), test.expectedFailure);
    return `EXPECTED FAILURE: ${error.message}`;
  }
  if (error) throw new Error(`${test.name}: ${error.message}`, { cause: error });
  return null;
}

async function launchAndConnect(browser, dataDir) {
  const host = await createAndConnect(browser, dataDir);
  await waitForConnection(browser);
  const statusHost = await browser.execute(() =>
    document.querySelector(".tv-sb-host")?.textContent?.trim() ?? "",
  );
  assert.equal(statusHost, "127.0.0.1");
  assert((await terminalText(browser)).includes("user@host:~$"));
  return host;
}

async function commandRoundTrip(browser, dataDir) {
  await createAndConnect(browser, dataDir);
  await waitForConnection(browser);
  const command = "echo smoke";
  const expected = [...Buffer.from(`${command}\r`)];
  await sendKeys(browser, command);
  await sendKeys(browser, "\uE007");
  const actual = await waitForBytes(browser, expected.length, "Command round-trip");
  assertBytes(actual, expected, "Command round-trip: mock received exact bytes once");
  const deadline = Date.now() + 5_000;
  let text = await terminalText(browser);
  while (!text.includes(command) && Date.now() < deadline) {
    await pause(100);
    text = await terminalText(browser);
  }
  const echoes = countOccurrences(text, command);
  assert.equal(echoes, 1, `Command round-trip: expected remote echo exactly once, saw ${echoes}`);
}

async function main() {
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.COMND_SMOKE_XVFB) {
    const result = spawnSync("xvfb-run", ["-a", process.execPath, fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
      cwd: root,
      env: { ...process.env, COMND_SMOKE_XVFB: "1" },
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
    return;
  }

  buildApp();

  if (mutationRun) {
    const result = await runCase({
      name: "mutation-check",
      // The app drops input at ssh_send, so the mock never receives the
      // command and waitForBytes fails first. This must not match the old
      // muteOutput failure (expected remote echo exactly once), otherwise a
      // passing unmutated run could satisfy the check.
      expectedFailure: /Command round-trip: Mock host did not receive \d+ bytes; mock received 0 bytes/,
      run: (browser, dataDir) => commandRoundTrip(browser, dataDir),
    });
    console.log(`PASS mutation-check â€” ${result}`);
    return;
  }

  const tests = [
    {
      name: "launch-and-connect",
      run: launchAndConnect,
    },
    {
      name: "command-round-trip",
      run: (browser, dataDir) => commandRoundTrip(browser, dataDir),
    },
    {
      name: "suggestion-accept",
      async run(browser, dataDir) {
        await launchAndConnect(browser, dataDir);
        const toggle = await browser.$(".tv-suggestions-btn");
        if (await toggle.getAttribute("aria-pressed") !== "true") await toggle.click();
        await sendKeys(browser, "ip r");
        await browser.waitUntil(async () => browser.execute(() => {
          const ghost = document.querySelector(".ghost-text");
          return !!ghost && getComputedStyle(ghost).display !== "none" && ghost.textContent === "oute";
        }), {
          timeout: WAIT_MS,
          interval: 100,
          timeoutMsg: "Suggestion accept: expected ghost remainder 'oute' for 'ip r'",
        });
        await sendKeys(browser, "\uE004");
        await sendKeys(browser, "\uE007");
        const expected = [...Buffer.from("ip route\r")];
        const actual = await waitForBytes(browser, expected.length, "Suggestion accept");
        assertBytes(actual, expected, "Suggestion accept: only the completion remainder was sent");
        await waitForTerminal(browser, "ip route");
        assert.equal(countOccurrences(await terminalText(browser), "ip route"), 1);
      },
    },
    {
      name: "tab-passthrough",
      async run(browser, dataDir) {
        await launchAndConnect(browser, dataDir);
        await sendKeys(browser, "zzzz");
        await sendKeys(browser, "\uE004");
        const expected = [...Buffer.from("zzzz\t")];
        const actual = await waitForBytes(browser, expected.length, "Tab passthrough");
        assertBytes(actual, expected, "Tab passthrough: expected 0x09 at mock with no ghost suggestion");
      },
    },
    {
      name: "auth-reject-cancel",
      async run(browser, dataDir) {
        await createAndConnect(browser, dataDir, { rejectAuth: true, interactiveAuth: true });
        await waitForTerminal(browser, "Password:");
        await sendKeys(browser, "wrong-secret");
        await sendKeys(browser, "\uE007");
        await browser.waitUntil(async () => (await browser.$(".tv-overlay-error")).isDisplayed(), {
          timeout: 20_000,
          interval: 100,
          timeoutMsg: "Rejected auth: failure recovery message did not appear",
        });
        const errorText = await (await browser.$(".tv-overlay-error")).getText();
        assert.match(
          errorText,
          /Authentication failed|Connection dropped during setup/i,
          "Rejected auth: expected a clear recovery error",
        );
        await (await browser.$(".tv-overlay-back")).click();
        await waitForSessionCleanup(browser, "Rejected auth");
        assert.equal(await (await browser.$(".tv-sb-dot")).isExisting(), false);
      },
    },
    {
      name: "user-disconnect",
      async run(browser, dataDir) {
        const host = await launchAndConnect(browser, dataDir);
        await (await browser.$(".session-tab-close")).click();
        await browser.waitUntil(async () => browser.execute(() => [...document.querySelectorAll("button")]
          .some((button) => button.textContent?.trim() === "Close Session")), {
          timeout: 5_000,
          interval: 100,
          timeoutMsg: "User disconnect: confirmation dialog did not appear",
        });
        await browser.execute(() => [...document.querySelectorAll("button")]
          .find((button) => button.textContent?.trim() === "Close Session")
          ?.click());
        await waitForSessionCleanup(browser, "User disconnect");
        await browser.waitUntil(async () => invoke(browser, "test_smoke_client_closed"), {
          timeout: 5_000,
          interval: 100,
          timeoutMsg: "User disconnect: mock host did not observe the SSH connection close",
        });
        assert(await (await browser.$(`.hs-host-item[data-host-id="${host.id}"]`)).isDisplayed());
      },
    },
    {
      name: "server-disconnect",
      async run(browser, dataDir) {
        await launchAndConnect(browser, dataDir);
        await sendKeys(browser, "disconnect");
        await sendKeys(browser, "\uE007");
        try {
          await (await browser.$(".hs-host-list")).waitForDisplayed({ timeout: WAIT_MS });
        } catch (error) {
          const received = await readBytes(browser).catch(() => []);
          throw new Error(
            `${error.message}; mock received ${received.length} bytes ${escapeBytes(received)}; `
            + `state ${JSON.stringify(await inputState(browser))}; terminal text `
            + `${JSON.stringify((await terminalText(browser).catch(() => "")).slice(-400))}`,
          );
        }
        assertBytes(await readBytes(browser), [...Buffer.from("disconnect\r")], "Server disconnect: mock received disconnect command");
      },
    },
    {
      name: "ctrl-w-passthrough",
      async run(browser, dataDir) {
        await launchAndConnect(browser, dataDir);
        await sendKeys(browser, "alpha beta");
        await sendKeys(browser, ["\uE009", "w", "\uE000"]);
        const expected = [...Buffer.from("alpha beta"), 0x17];
        assertBytes(
          await waitForBytes(browser, expected.length, "Ctrl+W passthrough"),
          expected,
          "Ctrl+W passthrough: expected byte 0x17 at mock",
        );
      },
    },
    {
      name: "failure-clarity",
      run() {
        let message = "";
        try {
          assertBytes([], [0x09], "Tab passthrough: expected 0x09 at mock");
        } catch (error) {
          message = error.message;
        }
        assert.match(message, /Tab passthrough: expected 0x09 at mock/);
      },
    },
    {
      name: "isolation-cleanup",
      expectedFailure: /forced cleanup probe/,
      async run(browser, dataDir) {
        await invoke(browser, "test_smoke_server", { rejectAuth: false, muteOutput: false });
        assert(existsSync(dataDir), "Isolation: per-scenario app data directory should exist");
        throw new Error("forced cleanup probe");
      },
    },
  ];

  let failures = 0;
  for (const test of tests) {
    try {
      const expected = await runCase(test);
      console.log(`PASS ${test.name}${expected ? ` â€” ${expected}` : ""}`);
    } catch (error) {
      failures += 1;
      console.error(`FAIL ${test.name}: ${error.message}`);
    }
  }
  // The driver's grandchildren can inherit its stderr pipe, so returning
  // normally leaves Node alive and the CI job hangs until its own timeout.
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error.stack ?? error);
  process.exit(1);
});
