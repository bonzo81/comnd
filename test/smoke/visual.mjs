#!/usr/bin/env node
// Visual baseline capture (issue #57).
//
// These PNGs are a review aid, not a gate. There is no pixel diff in CI and no
// snapshot per theme/scale permutation: a human compares the new capture with
// the committed one by eye. The procedure lives in docs/testing/visual-baseline.md.
//
//   npm run smoke:visual                      capture into test/smoke/visual-baseline/<platform>
//   npm run smoke:visual -- --check           capture into a temp dir and compare
//   npm run smoke:visual -- --platform=linux  write a Linux set without touching the Windows set
//
// Determinism: one app boot, one 1280x800 viewport, dark app and terminal
// theme, Reading Comfort off, default font sizes, transitions and animations
// disabled, text caret hidden, seeded data via IPC only (no credentials, no
// personal data). The host scale factor is NOT forced — WebView2 ignores
// --force-device-scale-factor — so it is recorded in the manifest instead and
// the committed PNGs reproduce on a machine with the same factor.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp, invoke, pause, root, runCase, runUnderXvfb, WAIT_MS } from "./lib/harness.mjs";

const VIEWPORT = { width: 1280, height: 800 };

// Preferences that change rendering. Every key is written explicitly so the
// capture does not inherit whatever a previous manual run left in the WebView's
// localStorage (which lives outside COMND_DATA_DIR).
const PREFS = {
  "comnd-theme": "dark",
  "comnd-terminal-theme": "dark",
  "comnd-terminal-font-size": "14",
  // Off on a fresh install; the terminal captures switch it on through the
  // toolbar toggle so the suggestion surface is reviewable.
  "comnd-suggestions": "0",
  "comnd-timestamps": "0",
  "comnd-timestamps-format": "24h",
  "comnd-auto-copy": "0",
  "comnd-output-highlight": "0",
  "comnd-search-include-tags": "1",
};
const CLEARED_PREFS = ["comnd-reading-comfort", "comnd.nav.expandedGroups"];

// Substrings that must never reach a committed screenshot. Checked against the
// rendered text of every capture before it is written.
const FORBIDDEN_TEXT = [
  "smoke-secret",
  "smoke-legacy-token",
  "BEGIN OPENSSH",
  "PRIVATE KEY",
  "Bearer ",
  process.env.USERNAME ?? "\u0000",
  process.env.USER ?? "\u0000",
  "C:\\Users",
  "/home/",
];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const ago = (ms) => new Date(Date.now() - ms).toISOString();

// Seeded hosts. `last_connected` sits mid-bucket so `relativeTime` renders the
// same label ("2h ago", "3d ago", "12d ago") for the whole capture window
// instead of flipping at a boundary. No credential material: `password` is the
// default credential source and these hosts are never connected.
const HOSTS = [
  { display_name: "core-rtr-01", hostname: "10.20.0.1", platform: "cisco-iosxe", group: "core", last: ago(2 * HOUR + 30 * MINUTE) },
  { display_name: "core-sw-01", hostname: "10.20.0.2", platform: "cisco-nxos", group: "core", last: ago(3 * DAY + 12 * HOUR) },
  { display_name: "edge-fw-01", hostname: "10.30.0.1", platform: "f5-tmos", group: "edge", last: ago(12 * DAY + 12 * HOUR) },
];

const REPLAY_COMMANDS = [
  { command: "show running-config interface {{interface}}", variables: [{ name: "interface" }], platform: "cisco-iosxe" },
  { command: "show interface status", variables: [], platform: "cisco-nxos" },
  { command: "tmsh show sys hardware", variables: [], platform: "f5-tmos" },
];

function parseArgs(argv) {
  const platform = process.platform === "win32" ? "windows" : "linux";
  const opts = { platform, out: null, check: false };
  for (const arg of argv) {
    if (arg === "--check") opts.check = true;
    else if (arg.startsWith("--platform=")) opts.platform = arg.slice("--platform=".length);
    else if (arg.startsWith("--out=")) opts.out = arg.slice("--out=".length);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

function pngSize(buffer) {
  assert.equal(buffer.subarray(1, 4).toString("latin1"), "PNG", "capture did not produce a PNG");
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

/** Force the rendering inputs that the app would otherwise remember. */
async function applyPreferences(browser) {
  await browser.execute(
    (prefs, cleared) => {
      for (const key of cleared) localStorage.removeItem(key);
      for (const [key, value] of Object.entries(prefs)) localStorage.setItem(key, value);
    },
    PREFS,
    CLEARED_PREFS,
  );
}

/** Seed groups, hosts, replay commands and the mock SSH host through IPC. */
async function seed(browser) {
  const core = await invoke(browser, "save_host_group", {
    id: null,
    name: "Core network",
    parentId: null,
    color: null,
    icon: null,
  });
  const edge = await invoke(browser, "save_host_group", {
    id: null,
    name: "Edge",
    parentId: null,
    color: null,
    icon: null,
  });
  const groupIds = { core: core.id, edge: edge.id };

  for (const host of HOSTS) {
    await invoke(browser, "save_host", {
      host: {
        id: "",
        display_name: host.display_name,
        hostname: host.hostname,
        port: 22,
        username: "netops",
        credential: { type: "password" },
        platform: host.platform,
        highlight_profile: "none",
        last_connected: host.last,
        tags: [],
        group_id: groupIds[host.group],
      },
    });
  }

  // The mock host carries no `last_connected`, so it stays out of Recent
  // Sessions (and therefore out of the committed connections screenshot) while
  // remaining connectable from the nav tree for the terminal captures.
  const port = await invoke(browser, "test_smoke_server", { rejectAuth: false, muteOutput: false });
  const mock = await invoke(browser, "save_host", {
    host: {
      id: "",
      display_name: "mock-linux-01",
      hostname: "127.0.0.1",
      port,
      username: "user",
      credential: { type: "secret_ref", provider: "mock", reference: "smoke", label: "Mock host" },
      platform: "linux-bash",
      highlight_profile: "none",
      tags: [],
      group_id: null,
    },
  });

  for (const command of REPLAY_COMMANDS) {
    await invoke(browser, "replay_save", {
      cmd: { id: "", command: command.command, variables: command.variables, platform: command.platform, created_at: "" },
    });
  }

  return { mockHostId: mock.id, coreGroupId: core.id };
}

async function setViewport(browser) {
  if (typeof browser.setWindowRect === "function") {
    await browser.setWindowRect(0, 0, VIEWPORT.width, VIEWPORT.height);
  } else {
    await browser.setWindowSize(VIEWPORT.width, VIEWPORT.height);
  }
  await pause(250);
  const size = await browser.execute(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    dpr: window.devicePixelRatio,
  }));
  assert.equal(size.width, VIEWPORT.width, `viewport width is ${size.width}, expected ${VIEWPORT.width}`);
  assert.equal(size.height, VIEWPORT.height, `viewport height is ${size.height}, expected ${VIEWPORT.height}`);
  return size.dpr;
}

/** Kill CSS animation so a capture never lands mid-transition. */
async function freeze(browser) {
  await browser.execute(() => {
    if (document.getElementById("comnd-visual-freeze")) return;
    const style = document.createElement("style");
    style.id = "comnd-visual-freeze";
    // The blinking DOM caret is the one remaining time-varying pixel.
    style.textContent = "*, *::before, *::after { transition: none !important; animation: none !important; }"
      + " input, textarea { caret-color: transparent !important; }";
    document.head.append(style);
  });
}

const waitForSelector = (browser, selector, message) => browser.waitUntil(
  async () => browser.execute((sel) => !!document.querySelector(sel), selector),
  { timeout: WAIT_MS, interval: 100, timeoutMsg: message },
);

const waitForGone = (browser, selector, message) => browser.waitUntil(
  async () => browser.execute((sel) => !document.querySelector(sel), selector),
  { timeout: WAIT_MS, interval: 100, timeoutMsg: message },
);

const visible = (browser, selector) => browser.execute((sel) => {
  const element = document.querySelector(sel);
  return !!element && getComputedStyle(element).display !== "none" && element.getClientRects().length > 0;
}, selector);

const terminalText = (browser) => browser.execute(() => {
  const terminal = window.__comndTerminal;
  if (!terminal) return "";
  const buffer = terminal.buffer.active;
  return Array.from({ length: buffer.length }, (_, index) =>
    buffer.getLine(index)?.translateToString(true) ?? "",
  ).join("\n");
});

async function waitForTerminal(browser, text, message) {
  await browser.waitUntil(async () => (await terminalText(browser)).includes(text), {
    timeout: 20_000,
    interval: 100,
    timeoutMsg: message,
  });
}

async function sendKeys(browser, keys) {
  await browser.execute(() => document.querySelector(".xterm-helper-textarea")?.focus());
  const sequence = Array.isArray(keys) ? keys : [...keys];
  if (sequence.some((key) => /[\uE008-\uE00A\uE03D]/.test(key))) {
    await browser.keys(sequence);
    return;
  }
  // One key per command: the drivers coalesce runs of identical characters.
  for (const key of sequence) {
    await browser.keys(key);
    await pause(5);
  }
}

/** Expand a collapsible nav section (Knowledge Base, Replay) if it is closed. */
async function openNavSection(browser, section) {
  const selector = `.nav-section-header[data-section="${section}"]`;
  await waitForSelector(browser, selector, `the ${section} nav section did not render`);
  const expanded = () => browser.execute(
    (sel) => document.querySelector(sel)?.getAttribute("aria-expanded") === "true",
    selector,
  );
  if (!(await expanded())) {
    await browser.execute((sel) => document.querySelector(sel)?.click(), selector);
  }
  await browser.waitUntil(expanded, {
    timeout: WAIT_MS,
    interval: 100,
    timeoutMsg: `the ${section} nav section did not expand`,
  });
}

/** Expand a nav folder row if it is collapsed. */
async function expandNavGroup(browser, groupId) {
  const selector = `.nav-group-row[data-group-id="${groupId}"]`;
  await waitForSelector(browser, selector, `nav group ${groupId} did not render`);
  const collapsed = () => browser.execute((sel) => {
    const row = document.querySelector(sel);
    if (!row) return true;
    return (row.querySelector(".nav-toggle")?.textContent ?? "").includes("▸");
  }, selector);
  if (await collapsed()) {
    await browser.execute((sel) => document.querySelector(sel)?.querySelector(".nav-item")?.click(), selector);
  }
  await browser.waitUntil(async () => !(await collapsed()), {
    timeout: WAIT_MS,
    interval: 100,
    timeoutMsg: `nav group ${groupId} did not expand`,
  });
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
    timeoutMsg: "host-key confirmation did not appear and SSH did not finish",
  });
}

function createCapture(browser, outDir, manifest) {
  const expected = {
    width: Math.round(VIEWPORT.width * manifest.devicePixelRatio),
    height: Math.round(VIEWPORT.height * manifest.devicePixelRatio),
  };
  return async function capture({ file, screen, state }) {
    const text = await browser.execute(() => document.body.innerText);
    for (const needle of FORBIDDEN_TEXT) {
      assert(
        !text.includes(needle),
        `${file}: rendered text contains ${JSON.stringify(needle)}; refusing to commit a screenshot with it`,
      );
    }
    const buffer = Buffer.from(await browser.takeScreenshot(), "base64");
    const size = pngSize(buffer);
    assert.deepEqual(
      size,
      expected,
      `${file}: screenshot is ${size.width}x${size.height}, expected ${expected.width}x${expected.height} `
        + `for a ${VIEWPORT.width}x${VIEWPORT.height} viewport at DPR ${manifest.devicePixelRatio}`,
    );
    writeFileSync(path.join(outDir, file), buffer);
    manifest.shots.push({
      file,
      screen,
      state,
      sha256: sha256(buffer),
      width: size.width,
      height: size.height,
    });
    console.log(`  ${file}  ${size.width}x${size.height}  ${screen}`);
  };
}

async function captureAll(browser, outDir) {
  const seeded = await seed(browser);
  await applyPreferences(browser);
  await browser.refresh();

  await waitForSelector(browser, ".hs-host-item[data-host-id]", "the seeded hosts did not render");
  const dpr = await setViewport(browser);
  await freeze(browser);

  const manifest = {
    viewport: VIEWPORT,
    devicePixelRatio: dpr,
    appTheme: PREFS["comnd-theme"],
    terminalTheme: PREFS["comnd-terminal-theme"],
    readingComfort: "off",
    terminalFontSize: Number(PREFS["comnd-terminal-font-size"]),
    suggestions: "enabled via the terminal toolbar toggle",
    shots: [],
  };
  const capture = createCapture(browser, outDir, manifest);

  await expandNavGroup(browser, seeded.coreGroupId);
  await capture({
    file: "01-connections.png",
    screen: "Connections",
    state: "Recent Sessions with three seeded hosts; nav tree with the Core network folder expanded and Edge collapsed",
  });

  await browser.keys(["\uE009", "n", "\uE000"]);
  await waitForSelector(browser, ".modal-panel.host-form", "Ctrl+N did not open the new-connection form");
  await pause(200);
  await capture({
    file: "02-dialog-new-connection.png",
    screen: "New connection dialog",
    state: "empty form opened with Ctrl+N",
  });
  await browser.keys(["\uE00C"]);
  await waitForGone(browser, ".modal-panel.host-form", "Escape did not close the new-connection form");

  await (await browser.$(".sb-shortcuts")).click();
  await waitForSelector(browser, ".modal-panel.shortcuts-modal", "the shortcuts modal did not open");
  await pause(200);
  await capture({
    file: "03-dialog-shortcuts.png",
    screen: "Keyboard shortcuts dialog",
    state: "opened from the status-bar keyboard button; shortcut list at the top",
  });
  await browser.keys(["\uE00C"]);
  await waitForGone(browser, ".modal-panel.shortcuts-modal", "Escape did not close the shortcuts modal");

  await openNavSection(browser, "kb");
  await (await browser.$('.nav-item[data-section="kb"][data-sub-id="browse"]')).click();
  await waitForSelector(browser, ".kb-command-item[data-index=\"0\"]", "the knowledge base command list did not render");
  await (await browser.$('.kb-command-item[data-index="0"]')).click();
  await waitForSelector(browser, "#kb-command-detail", "the knowledge base detail panel did not render");
  await pause(200);
  await capture({
    file: "04-knowledge-base.png",
    screen: "Knowledge Base",
    state: "default platform, first command selected, detail panel populated",
  });

  await (await browser.$("#kb-cmd-delete-btn")).click();
  await waitForSelector(browser, ".modal-panel.delete-confirm", "the delete confirmation did not open");
  await pause(200);
  await capture({
    file: "05-dialog-confirm-delete.png",
    screen: "Delete confirmation dialog",
    state: "in-app confirm dialog over the Knowledge Base, raised by the command Delete button",
  });
  await (await browser.$(".confirm-cancel")).click();
  await waitForGone(browser, ".modal-panel.delete-confirm", "Cancel did not close the delete confirmation");

  await openNavSection(browser, "replay");
  await (await browser.$('.nav-item[data-section="replay"][data-sub-id="manage"]')).click();
  await waitForSelector(browser, ".rsm-item[data-id]", "the replay command list did not render");
  await pause(200);
  await capture({
    file: "06-replay.png",
    screen: "Command Replay",
    state: "three seeded commands across three platforms, one with a {{variable}}",
  });

  await (await browser.$("#title-bar-settings")).click();
  await waitForSelector(browser, ".settings-nav-item", "the settings screen did not open");
  await (await browser.$('.settings-nav-item[data-item-id="general"]')).click();
  await pause(300);
  await capture({
    file: "07-settings-general.png",
    screen: "Settings",
    state: "General pane",
  });

  await (await browser.$(`.nav-host-row[data-host-id="${seeded.mockHostId}"]`)).doubleClick();
  await acceptHostKeyIfNeeded(browser);
  await browser.waitUntil(async () => (await browser.$(".tv-sb-dot")).getAttribute("class")
    .then((classes) => classes?.includes("sb-connected") ?? false), {
    timeout: 20_000,
    interval: 100,
    timeoutMsg: "SSH connection did not reach the connected state",
  });
  await waitForTerminal(browser, "user@host:~$", "the mock prompt did not appear");

  const suggestions = await browser.$(".tv-suggestions-btn");
  if (await suggestions.getAttribute("aria-pressed") !== "true") await suggestions.click();

  await sendKeys(browser, "ip ");
  await browser.waitUntil(async () => visible(browser, ".suggestion-dropdown"), {
    timeout: WAIT_MS,
    interval: 100,
    timeoutMsg: "the suggestion dropdown did not open for \"ip \"",
  });
  const suggestionState = await browser.execute(() => {
    const ghost = document.querySelector(".ghost-text");
    const items = [...document.querySelectorAll(".suggestion-dropdown .suggestion-item")];
    return {
      rows: items.length,
      names: items.map((item) => item.querySelector(".suggestion-name")?.textContent ?? ""),
      ghost: ghost && getComputedStyle(ghost).display !== "none" ? ghost.textContent : null,
      choices: document.querySelectorAll(".suggestion-dropdown .choice-row").length,
    };
  });
  assert(suggestionState.rows >= 1, `expected a suggestion dropdown, saw ${JSON.stringify(suggestionState)}`);
  manifest.terminalSuggestion = suggestionState;
  await pause(200);
  await capture({
    file: "08-terminal-sidebar-closed.png",
    screen: "Terminal",
    state: `"ip " typed at the mock prompt: ${suggestionState.rows} command row(s) `
      + `(${suggestionState.names.join(", ")}) with ghost text ${JSON.stringify(suggestionState.ghost)}; side panel closed`,
  });

  await (await browser.$(".tv-panel-btn")).click();
  await browser.waitUntil(async () => (await browser.$("#tv-sidebar")).getAttribute("class")
    .then((classes) => !(classes ?? "").includes("hidden")), {
    timeout: WAIT_MS,
    interval: 100,
    timeoutMsg: "the terminal side panel did not open",
  });
  // Opening the panel only refits the terminal; re-typing is what re-renders
  // the panel detail for the current line.
  await sendKeys(browser, ["\uE009", "u", "\uE000"]);
  await sendKeys(browser, "ip ");
  await browser.waitUntil(async () => {
    const text = await browser.execute(() => document.querySelector("#tv-sidebar .sb-content")?.textContent ?? "");
    return !text.includes("Select a suggestion");
  }, {
    timeout: WAIT_MS,
    interval: 100,
    timeoutMsg: "the terminal side panel did not render command detail",
  });
  await pause(300);
  await capture({
    file: "09-terminal-sidebar-open.png",
    screen: "Terminal",
    state: "same command line with the side panel open showing the ip command detail",
  });

  writeFileSync(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function compare(committedDir, freshDir) {
  const manifestPath = path.join(committedDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`No committed baseline at ${committedDir}; run npm run smoke:visual first`);
  }
  const committed = JSON.parse(readFileSync(manifestPath, "utf8"));
  const freshManifestPath = path.join(freshDir, "manifest.json");
  const freshManifest = existsSync(freshManifestPath)
    ? JSON.parse(readFileSync(freshManifestPath, "utf8"))
    : null;
  if (freshManifest) {
    console.log(`Committed: viewport ${committed.viewport.width}x${committed.viewport.height} `
      + `at DPR ${committed.devicePixelRatio}`);
    console.log(`Fresh:     viewport ${freshManifest.viewport.width}x${freshManifest.viewport.height} `
      + `at DPR ${freshManifest.devicePixelRatio}\n`);
  }
  // Byte comparison only means something at the same scale factor: the same
  // layout rasterises to a different pixel count, so every file "differs" for a
  // reason that has nothing to do with the app. Say so instead.
  if (freshManifest && (freshManifest.devicePixelRatio !== committed.devicePixelRatio
    || freshManifest.viewport.width !== committed.viewport.width
    || freshManifest.viewport.height !== committed.viewport.height)) {
    console.log([
      "ENVIRONMENT MISMATCH — the screenshots were not compared.",
      `  baseline: ${committed.viewport.width}x${committed.viewport.height} CSS pixels at DPR ${committed.devicePixelRatio}`,
      `  this run: ${freshManifest.viewport.width}x${freshManifest.viewport.height} CSS pixels at DPR ${freshManifest.devicePixelRatio}`,
      "",
      "The host display scale changed, so the same layout rasterises to a",
      "different pixel count and no file can match. This is not a visual",
      "regression. Either run on a display at the recorded scale, or re-capture",
      "and commit the new set together with the new scale factor.",
    ].join("\n"));
    return committed.shots.length;
  }
  const rows = [];
  let differences = 0;
  let modifiedBaselines = 0;
  for (const shot of committed.shots) {
    const committedFile = path.join(committedDir, shot.file);
    const freshFile = path.join(freshDir, shot.file);
    if (!existsSync(freshFile)) {
      rows.push(`MISSING ${shot.file} (not captured this run)`);
      differences += 1;
      continue;
    }
    if (!existsSync(committedFile)) {
      rows.push(`MISSING ${shot.file} (not in the committed baseline)`);
      differences += 1;
      continue;
    }
    // Read the committed image, not just the manifest: an image edited or
    // corrupted without a manifest update would otherwise still "match" the
    // hash the manifest claims for it.
    const committedBytes = readFileSync(committedFile);
    const committedHash = sha256(committedBytes);
    const committedSize = pngSize(committedBytes);
    if (committedHash !== shot.sha256
      || committedSize.width !== shot.width
      || committedSize.height !== shot.height) {
      rows.push(`BASELINE MODIFIED ${shot.file}  manifest ${shot.sha256.slice(0, 12)} `
        + `(${shot.width}x${shot.height})  on disk ${committedHash.slice(0, 12)} `
        + `(${committedSize.width}x${committedSize.height})`);
      differences += 1;
      modifiedBaselines += 1;
      continue;
    }
    const fresh = readFileSync(freshFile);
    const freshHash = sha256(fresh);
    const freshSize = pngSize(fresh);
    if (freshHash === committedHash) {
      rows.push(`MATCH   ${shot.file}  ${freshSize.width}x${freshSize.height}`);
    } else {
      rows.push(`DIFFERS ${shot.file}  committed ${committedHash.slice(0, 12)} `
        + `(${committedSize.width}x${committedSize.height})  fresh ${freshHash.slice(0, 12)} (${freshSize.width}x${freshSize.height})`);
      differences += 1;
    }
  }
  console.log(rows.join("\n"));
  console.log(differences === 0
    ? `\nAll ${committed.shots.length} committed screenshots reproduced byte for byte.`
    : `\n${differences} of ${committed.shots.length} screenshots differ. Inspect them by eye before replacing the baseline.`);
  if (modifiedBaselines > 0) {
    console.log(`\n${modifiedBaselines} committed image(s) do not match manifest.json. The baseline was `
      + "edited or corrupted outside the capture: restore it from git, or re-capture and commit "
      + "the images and the manifest together.");
  }
  return differences;
}

async function main() {
  if (runUnderXvfb(import.meta.url)) return;
  const opts = parseArgs(process.argv.slice(2));
  const committedDir = path.join(root, "test", "smoke", "visual-baseline", opts.platform);
  // Only ever delete a directory this run allocated. `--out` belongs to the
  // user: `--check --out=tmp/review` must leave whatever was already there.
  const tempDir = !opts.out && opts.check
    ? mkdtempSync(path.join(os.tmpdir(), "comnd-visual-check-"))
    : null;
  const targetDir = opts.out
    ? path.resolve(root, opts.out)
    : (tempDir ?? committedDir);

  mkdirSync(targetDir, { recursive: true });
  console.log(`Capturing the ${opts.platform} visual baseline into ${targetDir}`);
  buildApp();

  let manifest;
  try {
    await runCase({
      name: "visual-baseline",
      run: async (browser) => {
        manifest = await captureAll(browser, targetDir);
      },
    }, {
      // WebView2 ignores --force-device-scale-factor, so the capture runs at the
      // host scale factor and records it in the manifest: the committed set
      // reproduces on a machine with the same scale factor. A different scale
      // factor changes the pixel dimensions, which --check reports rather than
      // silently replacing the baseline.
      teardown: (browser) => invoke(browser, "test_stop_mock_server"),
    });
  } catch (error) {
    console.error(`FAIL ${error.message}`);
    process.exitCode = 1;
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    return;
  }

  if (!opts.check) {
    console.log(`\nCaptured ${manifest.shots.length} screenshots plus manifest.json.`);
    return;
  }

  try {
    const differences = compare(committedDir, targetDir);
    process.exitCode = differences === 0 ? 0 : 1;
  } finally {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
