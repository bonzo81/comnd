// App-level NetBox workflow suite (plan 064, issue #55).
//
// Boots the real debug app against the in-process NetBox HTTP mock and drives
// the NetBox settings UI the way a user does: configure, Test Connection, Save
// Connection, enable, Refresh Now. Displayed-tree assertions read the nav panel
// and the settings device list; persistence assertions read the app's own
// netbox-cache.json under the scenario's COMND_DATA_DIR.
//
// The mock's fixtures are hand-written to the shapes the client parses, so a
// passing run proves the client, the sync pipeline, and the UI agree with those
// fixtures. It is NOT evidence of compatibility with any real NetBox version.
//
// The suite supplies COMND_TEST_MOCK_NETBOX_TOKEN because CI has no OS keyring:
// the debug-only override in credentials.rs answers every token read with it.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  buildApp,
  invoke,
  pause,
  runCase,
  runSuite,
  runUnderXvfb,
  waitFor,
  WAIT_MS,
} from "./lib/harness.mjs";

// Typed into the form so Test Connection proves the value the user entered
// reaches the backend. The stored token comes from the suite environment (a
// debug-only override, since CI has no keyring), so syncs use a Bearer token
// while this one is a legacy Token-scheme token.
const TYPED_TOKEN = "smoke-legacy-token";

// Nav toggle glyphs (unicode escapes keep this file ASCII).
const EXPANDED = "\u25be";
const COLLAPSED = "\u25b8";

const CONNECTED_TEXT = "Connected \u2014 NetBox API 4.15.0, 6 devices";
const SYNC_OK_TOAST =
  "Synced 5 devices \u00b7 1 without primary IP \u00b7 1 skipped (unknown platform juniper-junos)";
const SYNC_REFRESH_TOAST = "Synced 3 devices";

const PROBE_PATH = "/api/dcim/devices/?limit=1&exclude=config_context";

// Every endpoint the workflows below may touch, exactly as the client builds
// them. Anything else the mock sees is unexpected traffic.
const EXPECTED_PATHS = [
  PROBE_PATH,
  "/api/dcim/devices/?limit=100&exclude=config_context",
  "/api/dcim/devices/?limit=100&exclude=config_context&offset=100",
  "/api/dcim/regions/?limit=0",
  "/api/dcim/sites/?limit=0",
  "/api/dcim/locations/?limit=0",
  "/api/dcim/sites/?limit=1000&fields=slug,name",
  "/api/dcim/device-roles/?limit=1000&fields=slug,name",
  "/api/extras/tags/?limit=1000&fields=slug,name",
];

// ─── UI helpers ─────────────────────────────────────────────────────

async function click(browser, selector) {
  const element = await browser.$(selector);
  await element.waitForExist({ timeout: WAIT_MS });
  await element.waitForClickable({ timeout: WAIT_MS });
  await element.click();
}

/** Set a form field and fire the events the app listens for. */
function setInput(browser, selector, value) {
  return browser.execute(
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

const text = (browser, selector) =>
  browser.execute((sel) => document.querySelector(sel)?.textContent?.trim() ?? "", selector);

const toastMessages = (browser) =>
  browser.execute(() =>
    Array.from(document.querySelectorAll("#toast-container .toast-message")).map((el) =>
      (el.textContent ?? "").trim(),
    ),
  );

const clearToasts = (browser) =>
  browser.execute(() => {
    document.querySelectorAll("#toast-container .toast").forEach((el) => el.remove());
  });

async function waitForToast(browser, pattern) {
  let matched = "";
  try {
    await browser.waitUntil(
      async () => {
        matched = (await toastMessages(browser)).find((message) => pattern.test(message)) ?? "";
        return matched !== "";
      },
      { timeout: WAIT_MS, interval: 100, timeoutMsg: `no toast matched ${pattern}` },
    );
  } catch (error) {
    throw new Error(`${error.message}; toasts were ${JSON.stringify(await toastMessages(browser))}`);
  }
  return matched;
}

async function waitForText(browser, selector, expected) {
  try {
    await browser.waitUntil(async () => (await text(browser, selector)) === expected, {
      timeout: WAIT_MS,
      interval: 100,
      timeoutMsg: `${selector} never showed ${JSON.stringify(expected)}`,
    });
  } catch (error) {
    throw new Error(`${error.message}; it shows ${JSON.stringify(await text(browser, selector))}`);
  }
}

async function openNetboxSettings(browser) {
  await click(browser, "#title-bar-settings");
  await click(browser, '.settings-nav-item[data-item-id="netbox"]');
  await (await browser.$("#netbox-url")).waitForExist({ timeout: WAIT_MS });
}

const netboxBodyLocked = (browser) =>
  browser.execute(() =>
    !!document.querySelector(".netbox-body")?.classList.contains("netbox-body-disabled"),
  );

/** The whole NetBox body is inert until the source is enabled. */
async function enableNetbox(browser) {
  await click(browser, "#netbox-enabled");
  try {
    await browser.waitUntil(
      async () => (await invoke(browser, "netbox_get_config")).config.enabled === true,
      { timeout: WAIT_MS, interval: 200, timeoutMsg: "the enable switch never persisted" },
    );
  } catch (error) {
    throw new Error(`${error.message}: enabling the NetBox host source failed`);
  }
  // The switch's save resolves in JS just after the backend write; give the
  // handler a beat so Save Connection spreads the enabled config, not a stale
  // one (a stale spread would persist enabled: false).
  await pause(200);
  assert.equal(await netboxBodyLocked(browser), false, "enabling the source must unlock the NetBox form");
}

/**
 * Configure the source through the UI and commit it: enable, URL, token, Test
 * Connection, Save Connection. Returns the mock's base URL.
 */
async function configureSource(browser) {
  const baseUrl = await invoke(browser, "test_netbox_server");
  await openNetboxSettings(browser);
  await enableNetbox(browser);
  await setInput(browser, "#netbox-url", baseUrl);
  await setInput(browser, "#netbox-token", TYPED_TOKEN);
  await click(browser, "#netbox-test-btn");
  await waitForText(browser, "#netbox-test-status", CONNECTED_TEXT);
  await click(browser, "#netbox-token-save");
  await waitForToast(browser, /^Connection saved$/);
  await clearToasts(browser);
  return baseUrl;
}

async function syncAndWait(browser, pattern) {
  await clearToasts(browser);
  await click(browser, "#netbox-sync-btn");
  return waitForToast(browser, pattern);
}

const deviceRows = (browser) =>
  browser.execute(() =>
    Array.from(document.querySelectorAll(".netbox-device-row")).map((row) => {
      const toggle = row.querySelector("[data-netbox-device]");
      return {
        id: Number(toggle?.dataset.netboxDevice ?? "0"),
        enabled: !!toggle?.checked,
        disabled: row.classList.contains("netbox-device-disabled"),
        name: row.querySelector(".netbox-device-name")?.textContent?.trim() ?? "",
        meta: row.querySelector(".netbox-device-meta")?.textContent?.trim() ?? "",
      };
    }),
  );

async function waitForDeviceRows(browser, count) {
  try {
    await browser.waitUntil(async () => (await deviceRows(browser)).length === count, {
      timeout: WAIT_MS,
      interval: 100,
      timeoutMsg: `the NetBox device list never showed ${count} devices`,
    });
  } catch (error) {
    const seen = (await deviceRows(browser)).map((row) => row.id);
    throw new Error(`${error.message}; it shows ${JSON.stringify(seen)}`);
  }
}

const hostRowIds = (browser) =>
  browser.execute(() =>
    Array.from(document.querySelectorAll(".nav-host-row[data-host-id]")).map(
      (row) => row.dataset.hostId,
    ),
  );

const groupToggle = (browser, id) =>
  browser.execute((groupId) => {
    const row = document.querySelector(`.nav-group-row[data-group-id="${groupId}"]`);
    return row?.querySelector(".nav-toggle")?.textContent?.trim() ?? null;
  }, id);

const groupLabel = (browser, id) =>
  browser.execute((groupId) => {
    const row = document.querySelector(`.nav-group-row[data-group-id="${groupId}"]`);
    return row?.querySelector(".nav-item-label")?.textContent?.trim() ?? "";
  }, id);

/** Expand a nav group, tolerating an already-expanded state from a prior run. */
async function expandGroup(browser, id) {
  await (await browser.$(`.nav-group-row[data-group-id="${id}"]`)).waitForExist({ timeout: WAIT_MS });
  if ((await groupToggle(browser, id)) === COLLAPSED) {
    await click(browser, `.nav-group-row[data-group-id="${id}"] > .nav-item`);
  }
  try {
    await browser.waitUntil(async () => (await groupToggle(browser, id)) === EXPANDED, {
      timeout: WAIT_MS,
      interval: 100,
      timeoutMsg: `nav group ${id} did not expand`,
    });
  } catch (error) {
    throw new Error(`${error.message}; its toggle shows ${JSON.stringify(await groupToggle(browser, id))}`);
  }
}

/** Focus a host row (the keyboard trigger) and read the detail tooltip. */
async function hostTooltip(browser, hostId) {
  await browser.execute((id) => {
    const row = document.querySelector(`.nav-host-row[data-host-id="${id}"]`);
    if (!row) throw new Error(`no nav row for ${id}`);
    row.querySelector(".nav-item").focus();
  }, hostId);
  try {
    await browser.waitUntil(
      () => browser.execute(() => document.getElementById("nav-host-tooltip")?.hidden === false),
      { timeout: WAIT_MS, interval: 100, timeoutMsg: `the host tooltip never opened for ${hostId}` },
    );
  } catch (error) {
    throw new Error(`${error.message}: focusing a host row must show its details`);
  }
  return browser.execute(() => {
    const rows = Array.from(document.querySelectorAll("#nav-host-tooltip .nav-host-tip-row"));
    return Object.fromEntries(
      rows.map((row) => [
        row.querySelector(".nav-host-tip-label")?.textContent?.trim() ?? "",
        row.querySelector(".nav-host-tip-value")?.textContent?.trim() ?? "",
      ]),
    );
  });
}

const cachePath = (dataDir) => path.join(dataDir, "netbox-cache.json");

/** Read the persisted cache once it satisfies `predicate`. */
async function waitForCache(dataDir, predicate, label) {
  const file = cachePath(dataDir);
  const until = Date.now() + WAIT_MS;
  while (Date.now() < until) {
    if (existsSync(file)) {
      try {
        const cache = JSON.parse(readFileSync(file, "utf8"));
        if (predicate(cache)) return cache;
      } catch {
        // Written but not yet readable — retry.
      }
    }
    await pause(100);
  }
  throw new Error(`netbox-cache.json never reached the expected state (${label})`);
}

const groupIds = async (browser) =>
  (await invoke(browser, "get_host_groups")).map((group) => group.id);

const hostById = async (browser) =>
  new Map((await invoke(browser, "get_hosts")).map((host) => [host.id, host]));

// ─── Scenarios ──────────────────────────────────────────────────────

const LOCAL_HOST = {
  id: "",
  display_name: "local-lab",
  hostname: "192.0.2.10",
  port: 22,
  username: "netadmin",
  credential: null,
  platform: "linux-bash",
  os_version: null,
  highlight_profile: null,
  notes: null,
  last_connected: null,
  created_at: "",
  sort_order: 0,
  tags: [],
  group_id: null,
};

const tests = [
  {
    // Definition of done: configure through the UI, Test connection, and prove
    // the entered URL and token state reach the backend.
    name: "configure-and-test",
    async run(browser) {
      const baseUrl = await invoke(browser, "test_netbox_server");
      assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/, "the mock must be a loopback instance");

      await openNetboxSettings(browser);
      // A first-run form: everything below the switch is inert until the
      // source is enabled, so the suite has to follow the user's order.
      assert.equal(await netboxBodyLocked(browser), true, "the NetBox form starts locked until enabled");

      await enableNetbox(browser);
      await setInput(browser, "#netbox-url", baseUrl);
      await setInput(browser, "#netbox-token", TYPED_TOKEN);
      assert.equal(
        await (await browser.$("#netbox-token-save")).isEnabled(),
        false,
        "Save Connection must stay locked until a Test succeeds",
      );

      await click(browser, "#netbox-test-btn");
      await waitForText(browser, "#netbox-test-status", CONNECTED_TEXT);
      assert.match(
        await (await browser.$("#netbox-test-status")).getAttribute("class"),
        /import-test-ok/,
        "a successful Test must render as success, not an error",
      );
      assert.equal(
        await (await browser.$("#netbox-token-save")).isEnabled(),
        true,
        "a successful Test must unlock Save Connection",
      );

      await click(browser, "#netbox-token-save");
      await waitForToast(browser, /^Connection saved$/);

      const state = await invoke(browser, "netbox_get_config");
      assert.equal(state.config.base_url, baseUrl, "the URL typed into the form must reach the backend");
      assert.equal(state.config.enabled, true, "Save Connection must keep the source enabled");
      assert.equal(state.has_token, true, "the backend must report a stored token");

      const requests = await invoke(browser, "test_netbox_requests");
      assert.ok(requests.length > 0, "Test Connection must reach the mock");
      assert.ok(
        requests.every((request) => request.method === "GET"),
        `the NetBox integration is read-only; saw ${JSON.stringify(requests.map((r) => r.method))}`,
      );
      const probes = requests.filter((request) => request.path === PROBE_PATH);
      assert.equal(probes.length, 1, "Test Connection issues exactly one limit=1 probe");
      assert.equal(probes[0].has_auth, true, "the probe must carry an Authorization header");
      assert.equal(
        probes[0].auth_scheme,
        "Token",
        "the probe must use the token typed into the form, not the environment's nbt_ token",
      );
    },
  },
  {
    // Definition of done: sync multiple API pages; assert hosts, addresses and
    // folder hierarchy in the displayed tree and in the persisted cache.
    name: "sync-pagination",
    async run(browser, dataDir) {
      await configureSource(browser);
      const toast = await syncAndWait(browser, /^Synced 5 devices/);
      assert.equal(toast, SYNC_OK_TOAST, "the sync summary must report both skip reasons");

      await waitForDeviceRows(browser, 4);
      const rows = await deviceRows(browser);
      assert.deepEqual(rows.map((row) => row.id), [101, 102, 103, 106]);
      assert.deepEqual(
        rows.map((row) => row.meta),
        [
          "10.10.0.1 \u00b7 dc1 / rack-1 \u00b7 active",
          "10.10.0.2 \u00b7 dc1 / rack-2 \u00b7 active",
          "10.20.0.1 \u00b7 dc2 \u00b7 active",
          "10.40.0.9",
        ],
      );
      assert.ok(rows.every((row) => row.enabled), "newly synced devices are enabled by default");
      assert.match(
        await text(browser, "#netbox-status-line"),
        /^4 devices cached \(4 enabled\) \u00b7 last synced /,
      );

      const cache = await waitForCache(dataDir, (value) => value.devices?.length === 4, "four devices");
      assert.equal(cache.version, 2);
      assert.deepEqual(cache.devices.map((device) => device.netbox_id), [101, 102, 103, 106]);
      assert.deepEqual(
        cache.devices.map((device) => device.address),
        ["10.10.0.1", "10.10.0.2", "10.20.0.1", "10.40.0.9"],
      );
      assert.deepEqual(cache.sync_report, {
        fetched: 5,
        no_primary_ip: 1,
        skipped_platform: 1,
        unmatched_platforms: ["juniper-junos"],
      });
      assert.deepEqual(cache.geo.regions.map((node) => node.slug), ["emea"]);
      assert.deepEqual(cache.geo.sites.map((node) => node.slug), ["dc1", "dc2"]);
      assert.deepEqual(cache.geo.locations.map((node) => node.slug), ["rack-1", "rack-2"]);

      // Displayed hierarchy: NetBox -> EMEA -> site -> location -> device.
      await expandGroup(browser, "__netbox__");
      await expandGroup(browser, "__netbox__:region:emea");
      await expandGroup(browser, "__netbox__:site:dc1");
      await expandGroup(browser, "__netbox__:site:dc2");
      await expandGroup(browser, "__netbox__:loc:rack-1");
      await expandGroup(browser, "__netbox__:loc:rack-2");
      assert.equal(await groupLabel(browser, "__netbox__"), "NetBox");
      assert.equal(await groupLabel(browser, "__netbox__:region:emea"), "EMEA");
      assert.equal(await groupLabel(browser, "__netbox__:site:dc1"), "DC1 London");
      assert.equal(await groupLabel(browser, "__netbox__:site:dc2"), "DC2 Manchester");
      assert.equal(await groupLabel(browser, "__netbox__:loc:rack-1"), "Rack 1");
      assert.equal(await groupLabel(browser, "__netbox__:loc:rack-2"), "Rack 2");

      // Devices nest under their location, else site, else the NetBox root.
      assert.deepEqual(
        await hostRowIds(browser),
        ["netbox:101", "netbox:102", "netbox:103", "netbox:106"],
        "host rows must appear once each, in tree order",
      );
      const hosts = await hostById(browser);
      assert.equal(hosts.get("netbox:101").group_id, "__netbox__:loc:rack-1");
      assert.equal(hosts.get("netbox:102").group_id, "__netbox__:loc:rack-2");
      assert.equal(hosts.get("netbox:103").group_id, "__netbox__:site:dc2");
      assert.equal(hosts.get("netbox:106").group_id, "__netbox__");
      assert.equal(hosts.get("netbox:101").hostname, "10.10.0.1", "the CIDR suffix must be stripped");
      assert.equal(hosts.get("netbox:101").source, "netbox");

      const tooltip = await hostTooltip(browser, "netbox:101");
      assert.equal(tooltip["Hostname/IP"], "10.10.0.1");
      assert.equal(tooltip["Port"], "22");
      assert.equal(tooltip["Platform"], "Cisco IOS-XE");
    },
  },
  {
    // Definition of done: refresh changed remote data; assert update/removal,
    // no duplicate hosts, unrelated local hosts intact.
    name: "refresh-changes",
    async run(browser, dataDir) {
      await configureSource(browser);
      // A host the user owns: a NetBox sync must never touch it.
      const local = await invoke(browser, "save_host", { host: LOCAL_HOST });

      assert.equal(await syncAndWait(browser, /^Synced 5 devices/), SYNC_OK_TOAST);
      await waitForDeviceRows(browser, 4);

      // User-owned state on a synced device: an overlay and a disabled device.
      await invoke(browser, "netbox_set_device_overlay", {
        netboxId: 101,
        overlay: {
          username: "netadmin",
          port: 2222,
          notes: "overlay probe",
          credential: { type: "password" },
        },
        password: null,
      });
      await invoke(browser, "netbox_set_device_enabled", { netboxId: 103, enabled: false });

      await invoke(browser, "test_netbox_set_scenario", { scenario: "refresh" });
      assert.equal(
        await syncAndWait(browser, /^Synced 3 devices$/),
        SYNC_REFRESH_TOAST,
        "the second sync must report the changed device count",
      );
      await waitForDeviceRows(browser, 3);

      const cache = await waitForCache(
        dataDir,
        (value) => value.devices?.length === 3,
        "three devices after the refresh",
      );
      assert.deepEqual(
        cache.devices.map((device) => device.netbox_id),
        [101, 103, 106],
        "102 was removed remotely, so it must leave the cache",
      );
      const renamed = cache.devices.find((device) => device.netbox_id === 101);
      assert.equal(renamed.name, "edge-rtr-01-renamed", "an updated device must be re-read");
      assert.equal(renamed.address, "10.10.1.1", "a changed primary IP must be re-read");
      assert.equal(renamed.overlay.port, 2222, "a sync must preserve the user's overlay");
      assert.equal(renamed.overlay.username, "netadmin");
      assert.equal(renamed.overlay.notes, "overlay probe");
      assert.equal(renamed.overlay.credential.type, "password");
      assert.equal(
        cache.devices.find((device) => device.netbox_id === 103).enabled,
        false,
        "a sync must preserve the user's disabled flag",
      );

      // No duplicates, and the disabled device is gone from the tree. Groups
      // start collapsed in a fresh profile, so open the branch holding 101.
      await expandGroup(browser, "__netbox__");
      await expandGroup(browser, "__netbox__:region:emea");
      await expandGroup(browser, "__netbox__:site:dc1");
      await expandGroup(browser, "__netbox__:loc:rack-1");
      const ids = await hostRowIds(browser);
      assert.equal(new Set(ids).size, ids.length, `duplicate host rows: ${ids.join(", ")}`);
      assert.ok(ids.includes("netbox:101"), "the renamed device must still be in the tree");
      assert.ok(!ids.includes("netbox:102"), "a remotely removed device must leave the tree");
      assert.ok(!ids.includes("netbox:103"), "a disabled device must not render a host row");
      assert.ok(ids.includes(local.id), "an unrelated local host must stay in the tree");

      const hosts = await hostById(browser);
      const localAfter = hosts.get(local.id);
      assert.ok(localAfter, "an unrelated local host must survive a sync");
      assert.equal(localAfter.hostname, "192.0.2.10");
      assert.equal(localAfter.display_name, "local-lab");
      assert.equal(hosts.get("netbox:101").port, 2222, "the overlay port must reach the host");

      // Folders that no longer hold an enabled device disappear.
      const groups = await groupIds(browser);
      for (const expected of [
        "__netbox__",
        "__netbox__:region:emea",
        "__netbox__:site:dc1",
        "__netbox__:loc:rack-1",
      ]) {
        assert.ok(groups.includes(expected), `expected group ${expected}, saw ${JSON.stringify(groups)}`);
      }
      for (const gone of ["__netbox__:site:dc2", "__netbox__:loc:rack-2"]) {
        assert.ok(!groups.includes(gone), `group ${gone} should be hidden: no enabled device left in it`);
      }

      const tooltip = await hostTooltip(browser, "netbox:101");
      assert.equal(tooltip["Hostname/IP"], "10.10.1.1", "the tooltip must show the refreshed address");
      assert.equal(tooltip["Port"], "2222", "the tooltip must show the overlay port");
    },
  },
  {
    // Definition of done: devices with missing primary IPs and absent optional
    // fields, with explicit expected outcomes.
    name: "missing-fields",
    async run(browser, dataDir) {
      await configureSource(browser);
      assert.equal(await syncAndWait(browser, /^Synced 5 devices/), SYNC_OK_TOAST);

      const devices = await invoke(browser, "netbox_get_devices");
      assert.ok(
        !devices.some((device) => device.netbox_id === 104),
        "a device with no primary IP is counted, not synced",
      );
      assert.ok(
        !devices.some((device) => device.netbox_id === 105),
        "a device on an unmapped platform is skipped under the default policy",
      );

      const bare = devices.find((device) => device.netbox_id === 106);
      assert.ok(bare, "a device with every optional field absent must still sync");
      assert.equal(bare.name, "bare-device");
      assert.equal(bare.address, "10.40.0.9");
      assert.equal(bare.platform, "linux-bash");
      assert.equal(bare.site, null);
      assert.equal(bare.location, null);
      assert.deepEqual(bare.tags, []);
      assert.equal(bare.status, "");
      assert.equal(bare.enabled, true);

      const cache = await waitForCache(dataDir, (value) => value.devices?.length === 4, "four devices");
      assert.equal(cache.sync_report.no_primary_ip, 1, "the missing primary IP must be reported");
      assert.equal(cache.sync_report.fetched, 5);

      await waitForDeviceRows(browser, 4);
      const bareRow = (await deviceRows(browser)).find((row) => row.id === 106);
      assert.equal(
        bareRow.meta,
        "10.40.0.9",
        "a device with no site, location, or status renders its address alone",
      );

      const hosts = await hostById(browser);
      assert.equal(hosts.get("netbox:106").group_id, "__netbox__", "no site puts the device in the NetBox root");
      await expandGroup(browser, "__netbox__");
      const tooltip = await hostTooltip(browser, "netbox:106");
      assert.equal(tooltip["Hostname/IP"], "10.40.0.9");
      assert.equal(tooltip["Platform"], "Linux Bash");
    },
  },
  {
    // Definition of done: 401/403/429/5xx give useful feedback each time, never
    // a success-shaped partial sync, and leave the previous tree untouched.
    name: "error-paths",
    async run(browser, dataDir) {
      await configureSource(browser);
      assert.equal(await syncAndWait(browser, /^Synced 5 devices/), SYNC_OK_TOAST);
      await waitForDeviceRows(browser, 4);

      const before = {
        cache: readFileSync(cachePath(dataDir), "utf8"),
        devices: await invoke(browser, "netbox_get_devices"),
        hosts: await invoke(browser, "get_hosts"),
        groups: await invoke(browser, "get_host_groups"),
        rows: await hostRowIds(browser),
      };
      assert.equal(before.devices.length, 4);

      // Test Connection does not read Retry-After, the device fetch does, so
      // the 429 wording differs between the two paths by design.
      const cases = [
        {
          scenario: "unauthorized",
          test: "Invalid or expired NetBox API token",
          sync: "Invalid or expired NetBox API token",
        },
        {
          scenario: "forbidden",
          test: "NetBox token lacks permission to list devices (DCIM > Device needs read access)",
          sync: "NetBox token lacks permission to list devices (DCIM > Device needs read access)",
        },
        {
          scenario: "throttled",
          test: "Rate limited by NetBox \u2014 wait a moment and try again",
          sync: "Rate limited by NetBox \u2014 retry after 42s",
        },
        {
          scenario: "server_error",
          test: "NetBox server error (HTTP 500)",
          sync: "NetBox server error (HTTP 500)",
        },
      ];

      for (const current of cases) {
        await invoke(browser, "test_netbox_set_scenario", { scenario: current.scenario });

        await clearToasts(browser);
        await click(browser, "#netbox-test-btn");
        await waitForText(browser, "#netbox-test-status", `Connection failed: ${current.test}`);
        assert.match(
          await (await browser.$("#netbox-test-status")).getAttribute("class"),
          /import-test-err/,
          `${current.scenario}: a failed Test must render as an error`,
        );

        await clearToasts(browser);
        await click(browser, "#netbox-sync-btn");
        assert.equal(
          await waitForToast(browser, /^Sync failed:/),
          `Sync failed: ${current.sync}`,
          `${current.scenario}: the sync failure must be reported`,
        );

        const toasts = await toastMessages(browser);
        assert.deepEqual(
          toasts.filter((message) => message.startsWith("Synced")),
          [],
          `${current.scenario}: a failed sync must never report success`,
        );
        assert.deepEqual(
          await invoke(browser, "netbox_get_devices"),
          before.devices,
          `${current.scenario}: a failed sync must not rewrite the cached devices`,
        );
        assert.deepEqual(
          await invoke(browser, "get_hosts"),
          before.hosts,
          `${current.scenario}: a failed sync must not change the host list`,
        );
        assert.deepEqual(
          await invoke(browser, "get_host_groups"),
          before.groups,
          `${current.scenario}: a failed sync must not change the folder tree`,
        );
        assert.deepEqual(
          await hostRowIds(browser),
          before.rows,
          `${current.scenario}: a failed sync must not change the displayed tree`,
        );
        assert.equal(
          readFileSync(cachePath(dataDir), "utf8"),
          before.cache,
          `${current.scenario}: a failed sync must leave netbox-cache.json byte-identical`,
        );
        assert.equal(await (await browser.$("#netbox-sync-btn")).isEnabled(), true, "Refresh must recover");
      }
    },
  },
  {
    // Definition of done: record every request these workflows make and assert
    // GET-only access to the expected endpoints.
    name: "request-audit",
    async run(browser) {
      await configureSource(browser);
      assert.equal(await syncAndWait(browser, /^Synced 5 devices/), SYNC_OK_TOAST);
      await waitForDeviceRows(browser, 4);
      await invoke(browser, "test_netbox_set_scenario", { scenario: "refresh" });
      assert.equal(await syncAndWait(browser, /^Synced 3 devices$/), SYNC_REFRESH_TOAST);
      await waitForDeviceRows(browser, 3);

      const requests = await invoke(browser, "test_netbox_requests");
      assert.ok(requests.length > 0, "the workflows must have made requests");

      const verbs = [...new Set(requests.map((request) => request.method))];
      assert.deepEqual(verbs, ["GET"], `the integration must only ever GET, saw ${JSON.stringify(verbs)}`);

      const unexpected = requests
        .map((request) => request.path)
        .filter((requestPath) => !EXPECTED_PATHS.includes(requestPath));
      assert.deepEqual(unexpected, [], "unexpected endpoints were requested");

      const counts = (requestPath) =>
        requests.filter((request) => request.path === requestPath).length;
      // One probe from Test Connection, then one page 1 + one page 2 + one geo
      // round + one choices round per sync.
      assert.equal(counts(PROBE_PATH), 1, "only Test Connection probes");
      assert.equal(counts(EXPECTED_PATHS[1]), 2, "one page-1 request per sync");
      assert.equal(counts(EXPECTED_PATHS[2]), 2, "pagination must follow the next link once per sync");
      assert.equal(counts("/api/dcim/regions/?limit=0"), 2);
      assert.equal(counts("/api/dcim/sites/?limit=0"), 2);
      assert.equal(counts("/api/dcim/locations/?limit=0"), 2);
      assert.equal(counts("/api/dcim/sites/?limit=1000&fields=slug,name"), 2);
      assert.equal(counts("/api/dcim/device-roles/?limit=1000&fields=slug,name"), 2);
      assert.equal(counts("/api/extras/tags/?limit=1000&fields=slug,name"), 2);

      assert.ok(
        requests.every((request) => request.has_auth),
        "every request must carry an Authorization header",
      );
      const probe = requests.find((request) => request.path === PROBE_PATH);
      assert.equal(probe.auth_scheme, "Token", "the probe used the token typed into the form");
      assert.deepEqual(
        [...new Set(requests.filter((r) => r.path !== PROBE_PATH).map((r) => r.auth_scheme))],
        ["Bearer"],
        "sync and choices use the stored nbt_ token (Bearer), which CI supplies via the debug override",
      );
    },
  },
  {
    // Definition of done: cleanup verified after a forced failure. runCase
    // checks the temp data dir is gone before it honours expectedFailure, so
    // reaching this scenario's PASS proves teardown and removal still ran.
    name: "cleanup-on-failure",
    expectedFailure: /forced cleanup probe/,
    async run(browser, dataDir) {
      await invoke(browser, "test_netbox_server");
      assert.ok(existsSync(dataDir), "the scenario data directory exists while the app runs");
      throw new Error(
        "forced cleanup probe: the harness must still stop the mock, kill the driver, and delete the temp data directory",
      );
    },
  },
];

const netboxSuite = {
  // CI has no OS keyring; the debug-only override stands in for the token.
  env: { COMND_TEST_MOCK_NETBOX_TOKEN: "nbt_smoke.token" },
  teardown: (browser) => invoke(browser, "test_stop_netbox_server"),
};

async function main() {
  if (runUnderXvfb(import.meta.url)) return;

  buildApp();
  await runSuite(tests, netboxSuite);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
