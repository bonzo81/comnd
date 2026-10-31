import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import {
  buildApp,
  invoke,
  pause,
  runCase,
  runSuite,
  runUnderXvfb,
  WAIT_MS,
} from "./lib/harness.mjs";

const mutationRun = process.argv.includes("--mutation");

// The SSH suite's only per-run difference: the mutation run makes the app drop
// typed input at ssh_send, so a passing check cannot be satisfied by a silent
// mock. Teardown is the harness default (stop the SSH mock).
const sshSuite = {
  env: mutationRun ? { COMND_SMOKE_MUTATION: "ssh_send" } : {},
};

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

async function waitForHostList(browser, label) {
  await browser.waitUntil(async () => (await inputState(browser))?.hostList === true, {
    timeout: WAIT_MS,
    interval: 100,
    timeoutMsg: `${label}: host list did not return after the disconnect`,
  });
}

async function sendKeys(browser, keys, { visibleOnly = false } = {}) {
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
  if (runUnderXvfb(import.meta.url)) return;

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
    }, sshSuite);
    console.log(`PASS mutation-check — ${result}`);
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
          await waitForHostList(browser, "Server disconnect");
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
      name: "duplicate-session",
      async run(browser, dataDir) {
        // Session logging is opt-in; turn it on so the two sessions each
        // produce their own log file for the same host:port.
        await invoke(browser, "set_session_logging", { enabled: true });
        const host = await createAndConnect(browser, dataDir);
        await waitForConnection(browser);

        // window.__comndTerminal only tracks the newest terminal, so read each
        // tab's rendered rows and ghost text from its own wrapper.
        const wrapperState = () => browser.execute(() =>
          [...document.querySelectorAll(".session-tab-wrapper")].map((wrapper) => {
            const ghost = wrapper.querySelector(".ghost-text");
            return {
              visible: wrapper.style.display !== "none",
              text: wrapper.querySelector(".xterm-rows")?.textContent ?? "",
              ghost: ghost && getComputedStyle(ghost).display !== "none" ? ghost.textContent : null,
            };
          }));
        const tabLabels = () => browser.execute(() =>
          [...document.querySelectorAll(".session-tab-label")].map((el) => el.textContent));
        const tabCount = () =>
          browser.execute(() => document.querySelectorAll(".session-tab").length);

        // Second connect to the same host via the nav panel row. The row's
        // dblclick handler is the pointer connect path; dispatch it directly
        // because a real double-click lands on the drag-source button inside
        // the row and can be swallowed by the drag threshold.
        const reconnect = () => browser.execute((id) => {
          document
            .querySelector(`.nav-host-row[data-host-id="${id}"]`)
            ?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        }, host.id);

        assert.equal(await tabCount(), 1, "Duplicate session: expected one tab after the first connect");

        await reconnect();
        await browser.waitUntil(
          async () => browser.execute(() => !!document.querySelector(".duplicate-session-dialog")),
          {
            timeout: WAIT_MS,
            interval: 100,
            timeoutMsg: "Duplicate session: the already-connected dialog did not appear",
          },
        );
        assert.equal(
          (await (await browser.$("#duplicate-session-title")).getText()).trim(),
          `${host.display_name} is already connected`,
          "Duplicate session: dialog title must name the device",
        );
        assert(
          await browser.execute(() =>
            document.activeElement?.classList.contains("duplicate-session-new")),
          "Duplicate session: focus must start on the primary action",
        );
        assert.equal(
          await browser.execute(() => document.querySelectorAll(".duplicate-session-dialog").length),
          1,
          "Duplicate session: the second connect must open exactly one dialog",
        );

        // Escape cancels: no second session, no tab switch. A W3C key action
        // reaches the focused dialog button; the dialog shell dismisses on the
        // window capture listener.
        await browser.action("key").down("\uE00C").up("\uE00C").perform();
        await browser.waitUntil(
          async () => browser.execute(() => !document.querySelector(".duplicate-session-dialog")),
          {
            timeout: 5_000,
            interval: 100,
            timeoutMsg: "Duplicate session: Escape did not dismiss the dialog",
          },
        );
        assert.equal(await tabCount(), 1, "Duplicate session: Escape must not open a session");

        // "Open another session" creates an independent second session.
        await reconnect();
        await (await browser.$(".duplicate-session-new")).click();
        await browser.waitUntil(async () => (await tabCount()) === 2, {
          timeout: WAIT_MS,
          interval: 100,
          timeoutMsg: "Duplicate session: expected two tabs after 'Open another session'",
        });
        assert.deepEqual(
          await tabLabels(),
          [host.display_name, host.display_name],
          "Duplicate session: both tabs must show the same host name with no suffix",
        );
        await browser.waitUntil(async () => browser.execute(() =>
          document.querySelectorAll(".tv-sb-dot.sb-connected").length === 2), {
          timeout: WAIT_MS,
          interval: 100,
          timeoutMsg: "Duplicate session: both sessions did not reach the connected state",
        });

        // Same host:port, two sessions, two log files with distinct ids.
        const logDir = path.join(dataDir, "session-logs");
        await browser.waitUntil(async () =>
          existsSync(logDir) && readdirSync(logDir).length >= 2, {
          timeout: WAIT_MS,
          interval: 100,
          timeoutMsg: "Duplicate session: expected one session log per live session",
        });
        const logNames = readdirSync(logDir);
        assert.equal(
          logNames.length,
          2,
          `Duplicate session: expected 2 session logs, saw ${logNames.join(", ")}`,
        );
        const sessionIds = logNames.map((name) => name.replace(/\.log$/, "").split("_").pop());
        assert.notEqual(
          sessionIds[0],
          sessionIds[1],
          "Duplicate session: the two sessions must log under distinct session ids",
        );

        // Suggestion state is per session: typing in the new tab must not
        // reach the other session's ghost text or terminal.
        await browser.execute(() => {
          const wrapper = [...document.querySelectorAll(".session-tab-wrapper")]
            .find((el) => el.style.display !== "none");
          const toggle = wrapper?.querySelector(".tv-suggestions-btn");
          if (toggle && toggle.getAttribute("aria-pressed") !== "true") toggle.click();
        });
        await sendKeys(browser, "ip r", { visibleOnly: true });
        await browser.waitUntil(async () => {
          const state = await wrapperState();
          return state[1]?.visible === true && state[1]?.ghost === "oute";
        }, {
          timeout: WAIT_MS,
          interval: 100,
          timeoutMsg: "Duplicate session: expected the new session to show its own ghost suggestion",
        });
        const typed = await wrapperState();
        assert.equal(
          typed[0].ghost,
          null,
          "Duplicate session: the first session must keep its own (empty) suggestion state",
        );
        assert(
          !typed[0].text.includes("ip r"),
          "Duplicate session: input must not leak into the other session",
        );

        // Switching tabs keeps each session's own suggestion state.
        await (await browser.$$(".session-tab"))[0].click();
        const switched = await wrapperState();
        assert.equal(switched[0].visible, true, "Duplicate session: the first tab should now be visible");
        assert.equal(
          switched[0].ghost,
          null,
          "Duplicate session: switching tabs must not copy suggestion state",
        );
        assert.equal(
          switched[1].ghost,
          "oute",
          "Duplicate session: the other session keeps its own suggestion",
        );

        // Closing one session leaves the other responsive.
        await (await browser.$$(".session-tab-close"))[1].click();
        await browser.execute(() => [...document.querySelectorAll("button")]
          .find((button) => button.textContent?.trim() === "Close Session")
          ?.click());
        await browser.waitUntil(async () => (await tabCount()) === 1, {
          timeout: WAIT_MS,
          interval: 100,
          timeoutMsg: "Duplicate session: closing one tab did not leave exactly one session",
        });
        await sendKeys(browser, "alive", { visibleOnly: true });
        await browser.waitUntil(async () => {
          const state = await wrapperState();
          return state.length === 1 && state[0].text.includes("alive");
        }, {
          timeout: WAIT_MS,
          interval: 100,
          timeoutMsg: "Duplicate session: the surviving session stopped responding after the other closed",
        });
        const status = await browser.execute(() =>
          document.querySelector(".sb-sessions")?.textContent?.trim() ?? "");
        assert(
          status.includes("1 session"),
          `Duplicate session: status bar should report one session, saw ${status}`,
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

  await runSuite(tests, sshSuite);
}

main().catch((error) => {
  console.error(error.stack ?? error);
  process.exit(1);
});
