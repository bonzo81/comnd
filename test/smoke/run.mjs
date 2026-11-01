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

// ─── Mutation categories (issue #89) ─────────────────────────────────
//
// Every category is a deliberate regression applied inside the app process
// (COMND_SMOKE_MUTATION), and each must make exactly one named assertion fail.
// The category is passed to the frontend through test_smoke_mutation so an
// assertion can prove the mutation actually ran; a broken seam would otherwise
// let an unmutated app satisfy the expected-failure match.
const MUTATION_CATEGORIES = ["ssh_send", "focus", "name", "layout"];

function parseMutation(argv) {
  const equals = argv.find((arg) => arg.startsWith("--mutation="));
  const bare = argv.includes("--mutation");
  if (equals && bare) {
    console.error("--mutation takes one category: pass either --mutation or --mutation=<category>");
    process.exit(2);
  }
  if (!equals) {
    // A bare --mutation keeps its original meaning (ssh_send), so
    // `npm run smoke:mutation` and the CI step that calls it are unchanged.
    return bare ? "ssh_send" : null;
  }
  const category = equals.slice("--mutation=".length);
  if (!MUTATION_CATEGORIES.includes(category)) {
    console.error(
      `Unknown mutation category ${JSON.stringify(category)}; `
      + `expected one of ${MUTATION_CATEGORIES.join(", ")}`,
    );
    process.exit(2);
  }
  return category;
}

const mutationCategory = parseMutation(process.argv);

// Each frontend mutation category must break exactly one scenario, and the
// failure it produces must also prove the mutation was applied. A category
// whose scenario passes is a regression in the assertion, not a pass.
const MUTATION_CASES = {
  focus: {
    scenario: "keyboard-focus",
    expectedFailure: /Keyboard focus: .* has no visible focus indicator[\s\S]*mutation activation: focus applied/,
  },
  name: {
    scenario: "accessible-names-toasts",
    expectedFailure: /Accessible names: .*control\(s\) has no accessible name[\s\S]*mutation activation: name applied/,
  },
  layout: {
    scenario: "sidebar-pty-resize",
    expectedFailure: /Sidebar resize: .*did not shrink the terminal[\s\S]*mutation activation: layout applied/,
  },
};

// The suite's per-run difference: a mutation run makes the app misbehave on
// purpose, so a passing check cannot be satisfied by a silent or broken app.
// The NetBox token is seeded because CI has no OS keyring; the accessibility
// scenarios that open the NetBox configure dialog need it.
const sshSuite = {
  env: {
    COMND_TEST_MOCK_NETBOX_TOKEN: "nbt_smoke.token",
    ...(mutationCategory ? { COMND_SMOKE_MUTATION: mutationCategory } : {}),
  },
  // The accessibility scenarios may start the NetBox mock as well, so stop
  // whichever mock is running instead of only the SSH one.
  async teardown(browser) {
    await invoke(browser, "test_stop_mock_server").catch(() => {});
    await invoke(browser, "test_stop_netbox_server").catch(() => {});
  },
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

// Zero bytes at the mock cannot distinguish "the app dropped the input" from
// "the frontend never sent it" (issue #78). The app reports how many bytes its
// drop branch discarded, and only a non-zero count proves the mutation ran.
async function mutationActivation(browser) {
  try {
    const dropped = await invoke(browser, "test_smoke_mutation_drops");
    return dropped > 0
      ? `mutation activation: ssh_send dropped ${dropped} bytes`
      : "mutation activation missing: ssh_send drop never ran (0 bytes dropped)";
  } catch (error) {
    return `mutation activation unavailable: ${error.message}`;
  }
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

// ─── Keyboard, focus and accessibility helpers (issue #89) ───────────
//
// These assert behaviour the specs require (docs/specs/accessibility.md,
// 07-keyboard-shortcuts.md, 03-ui-visual-design.md). A passing run is evidence
// that those assertions hold in this build; it is not a WCAG 2.1 AA
// conformance claim, and an automated scan cannot replace manual review.

/**
 * Install page-side probes once per page load.
 *
 * The probes are re-installed after every refresh because a navigation throws
 * the window object away.
 */
async function installSmokeHelpers(browser) {
  await browser.execute(() => {
    if (window.__comndSmoke) return;

    // xterm renders its own accessibility tree; it is not app markup.
    const SKIP = ".xterm";

    // Roles that describe a container rather than a control: they are allowed
    // to take their name from their contents or to have none.
    const CONTAINER_ROLES = new Set([
      "presentation", "none", "generic", "group", "list", "listbox", "listitem",
      "radiogroup", "tablist", "tabpanel", "toolbar", "navigation", "region",
      "status", "log", "alert", "menu", "menubar", "menuitem", "progressbar",
      "separator", "application", "document",
    ]);

    const INTERACTIVE = [
      "a[href]", "area[href]", "button", "input", "select", "textarea",
      "summary", "iframe", "[contenteditable='true']", "[tabindex]",
    ].join(",");

    const shown = (el) => {
      if (!el || el.closest(SKIP)) return false;
      if (el.getClientRects().length === 0) return false;
      const style = getComputedStyle(el);
      return style.visibility !== "hidden" && style.display !== "none";
    };

    const describe = (el) => {
      if (!el) return "(none)";
      const tag = el.tagName.toLowerCase();
      const id = el.id ? `#${el.id}` : "";
      const cls = el.classList.length ? `.${[...el.classList].slice(0, 3).join(".")}` : "";
      return `${tag}${id}${cls}`;
    };

    // Accessible name, computed the way a user of a screen reader would hear
    // it for the cases this app uses: aria-labelledby, aria-label, contents,
    // title, then a nested image's alt text.
    const nameOf = (el) => {
      const labelledBy = el.getAttribute("aria-labelledby");
      if (labelledBy) {
        const text = labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? "")
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        if (text) return text;
      }
      const aria = el.getAttribute("aria-label")?.trim();
      if (aria) return aria;
      // A native <label>, wrapping or via for=, names its form control. The
      // duplicate-session dialog puts its checkbox inside the label.
      const labels = el.labels ? [...el.labels] : [];
      if (labels.length) {
        const labelText = labels
          .map((label) => label.textContent ?? "")
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        if (labelText) return labelText;
      }
      const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
      if (text) return text;
      const title = el.getAttribute("title")?.trim();
      if (title) return title;
      // HTML-AAM's last fallback for a text field: the placeholder. The replay
      // dialog's command textarea is named this way.
      const placeholder = el.getAttribute("placeholder")?.trim();
      if (placeholder) return placeholder;
      const image = el.querySelector("img[alt]");
      if (image?.alt?.trim()) return image.alt.trim();
      return "";
    };

    // Every focus indicator this app uses: an outline, a box-shadow, or a
    // pseudo-element that draws the ring.
    const focusStyle = (el) => {
      if (!el) return { outlineStyle: "none", outlineWidth: "0px", boxShadow: "none", pseudoShadow: "none" };
      const style = getComputedStyle(el);
      return {
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        boxShadow: style.boxShadow,
        pseudoShadow: `${getComputedStyle(el, "::before").boxShadow} ${getComputedStyle(el, "::after").boxShadow}`,
      };
    };

    window.__comndSmoke = {
      describe,
      nameOf,
      shown,
      focusStyle,
      active() {
        const el = document.activeElement;
        return {
          tag: el?.tagName?.toLowerCase() ?? null,
          id: el?.id ?? "",
          cls: typeof el?.className === "string" ? el.className : "",
          name: el ? nameOf(el) : "",
          helperTextarea: !!el?.classList?.contains("xterm-helper-textarea"),
          terminalFocusWithin: !!document.querySelector(".tv-terminal:focus-within"),
        };
      },
      /** Visible tab stops and click targets with no accessible name. */
      unnamed(scope) {
        const root = document.querySelector(scope);
        if (!root) return [`${scope} is missing`];
        const out = [];
        for (const el of root.querySelectorAll(INTERACTIVE)) {
          if (!shown(el) || el.disabled) continue;
          if (el.getAttribute("tabindex") === "-1") continue;
          if (nameOf(el)) continue;
          out.push(describe(el));
        }
        for (const el of root.querySelectorAll("[role]")) {
          if (!shown(el)) continue;
          const role = el.getAttribute("role");
          if (CONTAINER_ROLES.has(role)) continue;
          if (nameOf(el)) continue;
          out.push(`${describe(el)}[role=${role}]`);
        }
        return [...new Set(out)];
      },
      /**
       * Controls whose box escapes an ancestor that clips it. Scroll
       * containers are not clipping bugs, so only overflow hidden/clip counts.
       */
      clipped(scope) {
        const root = document.querySelector(scope);
        if (!root) return [`${scope} is missing`];
        const out = [];
        for (const el of root.querySelectorAll(INTERACTIVE)) {
          if (!shown(el)) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width < 2 || rect.height < 2) continue;
          let parent = el.parentElement;
          while (parent && parent !== document.documentElement) {
            const style = getComputedStyle(parent);
            const clipX = style.overflowX === "hidden" || style.overflowX === "clip";
            const clipY = style.overflowY === "hidden" || style.overflowY === "clip";
            if (clipX || clipY) {
              const box = parent.getBoundingClientRect();
              const horizontal = clipX && (rect.left < box.left - 1 || rect.right > box.right + 1);
              const vertical = clipY && (rect.top < box.top - 1 || rect.bottom > box.bottom + 1);
              if (horizontal || vertical) {
                out.push(`${describe(el)} clipped by ${describe(parent)}`);
                break;
              }
            }
            parent = parent.parentElement;
          }
        }
        return [...new Set(out)];
      },
      /** Pairs of visible controls whose boxes overlap each other. */
      overlaps(scope) {
        const root = document.querySelector(scope);
        if (!root) return [`${scope} is missing`];
        const boxes = [...root.querySelectorAll(INTERACTIVE)]
          .filter(shown)
          .map((el) => ({ el, rect: el.getBoundingClientRect() }))
          .filter(({ rect }) => rect.width > 2 && rect.height > 2);
        const out = [];
        for (let i = 0; i < boxes.length; i += 1) {
          for (let j = i + 1; j < boxes.length; j += 1) {
            const a = boxes[i];
            const b = boxes[j];
            // A control inside another control is nesting, not an overlap.
            if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
            const width = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
            const height = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
            if (width > 4 && height > 4) {
              out.push(`${describe(a.el)} overlaps ${describe(b.el)}`);
            }
          }
        }
        return out;
      },
    };
  });
}

/**
 * Focus targets where the app deliberately handles Tab itself, so a real Tab
 * press changes app state instead of moving focus: the global search input
 * toggles its Hosts/Commands mode (07-keyboard-shortcuts.md) and the terminal
 * forwards Tab to the remote device (context-sensitive Tab). The walk records
 * these stops and then steps over them programmatically, so the rest of the
 * order is still reached by real Tab presses.
 */
const TAB_INTERCEPTORS = [".title-bar-search-input", ".xterm-helper-textarea"];

/**
 * Walk the tab order, collecting focus state. Starts from the top of the
 * document unless `reset` is false, which continues from the current focus.
 */
async function tabWalk(browser, max = 20, { reset = true } = {}) {
  await installSmokeHelpers(browser);
  // Focus only shows :focus-visible after a keyboard interaction, so park
  // focus on the body and reach every stop with a real Tab press.
  if (reset) {
    await browser.execute(() => {
      const active = document.activeElement;
      if (active && active !== document.body) active.blur();
      document.body.setAttribute("tabindex", "-1");
      document.body.focus();
      document.body.removeAttribute("tabindex");
    });
  }
  const stops = [];
  let tabInterceptors = 0;
  for (let index = 0; index < max; index += 1) {
    await browser.keys("\uE004");
    const state = await browser.execute(() => ({
      ...window.__comndSmoke.active(),
      ...window.__comndSmoke.focusStyle(document.activeElement),
    }));
    if (!state.tag || state.tag === "body") break;
    stops.push(state);
    const intercepted = await browser.execute((selectors) => selectors.some(
      (selector) => document.activeElement?.matches(selector),
    ), TAB_INTERCEPTORS);
    if (intercepted) {
      tabInterceptors += 1;
      await browser.execute(() => {
        const order = [...document.querySelectorAll(
          "a[href],area[href],button,input,select,textarea,summary,iframe,"
          + "[contenteditable='true'],[tabindex]",
        )].filter((element) => !element.closest(".xterm")
          && element.tabIndex >= 0
          && !element.disabled
          && element.getClientRects().length > 0);
        const active = document.activeElement;
        const index = order.indexOf(active);
        if (index >= 0) {
          order[index + 1]?.focus();
          return;
        }
        // The interceptor is not itself a candidate (xterm's helper textarea),
        // so continue with the first candidate that follows it in the document.
        order.find((element) => (
          active.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING
        ))?.focus();
      });
    }
    // The tab order wrapped back to the first stop.
    if (stops.length > 2
      && stops[0].tag === state.tag
      && stops[0].id === state.id
      && stops[0].cls === state.cls) break;
  }
  return { stops, tabInterceptors };
}

/** Collect the next `count` focus stops from wherever focus is now. */
async function tabFrom(browser, count) {
  return (await tabWalk(browser, count, { reset: false })).stops;
}

function stopLabel(stop) {
  const id = stop.id ? `#${stop.id}` : "";
  const cls = stop.cls ? `.${String(stop.cls).split(" ")[0]}` : "";
  return `${stop.tag}${id}${cls}${stop.name ? ` (${JSON.stringify(stop.name)})` : ""}`;
}

function assertNamed(stop, label) {
  assert(stop.name.length > 0, `${label}: ${stopLabel(stop)} is a tab stop with no accessible name`);
}

function assertFocusVisible(stop, label) {
  const outlined = stop.outlineStyle !== "none" && parseFloat(stop.outlineWidth) > 0;
  const shadowed = stop.boxShadow !== "none" || !/^(none )*none$/.test(stop.pseudoShadow);
  assert(
    outlined || shadowed,
    `${label}: ${stopLabel(stop)} has no visible focus indicator `
    + `(outline ${stop.outlineStyle} ${stop.outlineWidth}, box-shadow ${stop.boxShadow})`,
  );
}

function assertNamedControls(violations, label) {
  assert(
    violations.length === 0,
    `${label}: ${violations.length} control(s) has no accessible name: ${violations.join(", ")}`,
  );
}

function assertNothingClipped(violations, label) {
  assert(violations.length === 0, `${label}: ${violations.join(", ")}`);
}

/** Tab and Shift+Tab must never leave the open modal panel. */
async function assertModalTrap(browser, panelSelector, label) {
  await installSmokeHelpers(browser);
  const inside = (selector) => browser.execute((sel) => {
    const panel = document.querySelector(sel);
    return {
      inside: !!panel && panel.contains(document.activeElement),
      active: window.__comndSmoke.active(),
      name: panel ? window.__comndSmoke.nameOf(panel) : "",
    };
  }, selector);

  const describeActive = (active) => `${active.tag}${active.id ? `#${active.id}` : ""}`
    + `${active.cls ? `.${active.cls.trim().split(/\s+/).slice(0, 3).join(".")}` : ""}`;

  const names = [];
  for (let step = 0; step < 10; step += 1) {
    await browser.keys("\uE004");
    const state = await inside(panelSelector);
    assert(
      state.inside,
      `${label}: Tab moved focus out of the dialog to ${describeActive(state.active)}`,
    );
    names.push({ name: state.active.name, control: describeActive(state.active) });
  }
  for (let step = 0; step < 3; step += 1) {
    await browser.keys(["\uE008", "\uE004", "\uE000"]);
    const state = await inside(panelSelector);
    assert(
      state.inside,
      `${label}: Shift+Tab moved focus out of the dialog to ${describeActive(state.active)}`,
    );
  }
  for (const stop of names) {
    assert(
      stop.name.length > 0,
      `${label}: ${stop.control} is a tab stop inside the dialog with no accessible name`,
    );
  }
  const named = await inside(panelSelector);
  assert(named.name.length > 0, `${label}: the dialog itself has no accessible name`);
  return names.map((stop) => stop.name);
}

/** Escape through a real W3C key action: the modal shell listens on window capture. */
async function pressEscape(browser) {
  await browser.action("key").down("\uE00C").up("\uE00C").perform();
}

/** The PTY sizes the mock SSH host was asked for, oldest first. */
async function lastPtySizes(browser) {
  return Array.from(await invoke(browser, "test_smoke_pty_sizes"));
}

/** Proof that the app process handed the mutation to the frontend and it applied it. */
async function categoryActivation(browser, category) {
  let reported = null;
  try {
    reported = await invoke(browser, "test_smoke_mutation");
  } catch (error) {
    return `mutation activation unavailable: ${error.message}`;
  }
  const applied = await browser.execute(() => document.documentElement.dataset.smokeMutation ?? null);
  if (applied === category) return `mutation activation: ${category} applied`;
  return `mutation activation missing: the app process reports ${JSON.stringify(reported)} `
    + `but the frontend applied ${JSON.stringify(applied)}`;
}

async function createHost(browser, overrides = {}) {
  return invoke(browser, "save_host", {
    host: {
      id: "",
      display_name: "Smoke host",
      hostname: "127.0.0.1",
      port: 22,
      username: "smoke",
      credential: {
        type: "secret_ref",
        provider: "mock",
        reference: "smoke",
        label: "Smoke test secret",
      },
      platform: "linux-bash",
      highlight_profile: "none",
      tags: [],
      group_id: null,
      ...overrides,
    },
  });
}

async function openSettings(browser) {
  await (await browser.$("#title-bar-settings")).click();
  // Poll: `$(".settings-nav-item")` matches eight rows, so strict mode fails.
  await browser.waitUntil(
    async () => browser.execute(() => !!document.querySelector(".settings-nav-item")),
    { timeout: WAIT_MS, interval: 100, timeoutMsg: "Settings: the settings screen did not open" },
  );
}

async function openSettingsItem(browser, itemId) {
  await (await browser.$(`.settings-nav-item[data-item-id="${itemId}"]`)).click();
}

/** Expand a collapsible nav section (Knowledge Base, Replay) if it is closed. */
async function openNavSection(browser, section) {
  const selector = `.nav-section-header[data-section="${section}"]`;
  await (await browser.$(selector)).waitForExist({ timeout: WAIT_MS });
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

/** Expand a folder row in the nav tree if it is collapsed. */
async function expandNavGroup(browser, groupId) {
  const selector = `.nav-group-row[data-group-id="${groupId}"]`;
  await (await browser.$(selector)).waitForExist({ timeout: WAIT_MS });
  const collapsed = () => browser.execute((sel) => {
    const row = document.querySelector(sel);
    if (!row) return true;
    return (row.querySelector(".nav-toggle")?.textContent ?? "").includes("▸");
  }, selector);
  if (await collapsed()) {
    await browser.execute(
      (sel) => document.querySelector(sel)?.querySelector(".nav-item")?.click(),
      selector,
    );
  }
  await browser.waitUntil(async () => !(await collapsed()), {
    timeout: WAIT_MS,
    interval: 100,
    timeoutMsg: `the nav group ${groupId} did not expand`,
  });
}

/** Resize the app window; the driver names this differently across versions. */
async function resizeWindow(browser, width, height) {
  if (typeof browser.setWindowRect === "function") {
    await browser.setWindowRect(0, 0, width, height);
  } else {
    await browser.setWindowSize(width, height);
  }
}

const setField = (browser, selector, value) => browser.execute(
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

const toastState = (browser) => browser.execute(() => {
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

const clearToasts = (browser) => browser.execute(() => {
  document.querySelectorAll("#toast-container .toast").forEach((toast) => toast.remove());
});

async function waitForToast(browser, pattern, label) {
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

/** Configure the NetBox source through the settings UI, as a user would. */
async function configureNetbox(browser) {
  const baseUrl = await invoke(browser, "test_netbox_server");
  await openSettings(browser);
  await openSettingsItem(browser, "netbox");
  await (await browser.$("#netbox-enabled")).waitForExist({ timeout: WAIT_MS });
  await (await browser.$("#netbox-enabled")).click();
  await browser.waitUntil(
    async () => (await invoke(browser, "netbox_get_config")).config.enabled === true,
    { timeout: WAIT_MS, interval: 200, timeoutMsg: "NetBox: the enable switch never persisted" },
  );
  await pause(200);
  await setField(browser, "#netbox-url", baseUrl);
  await setField(browser, "#netbox-token", "smoke-legacy-token");
  await (await browser.$("#netbox-test-btn")).click();
  await browser.waitUntil(async () => {
    const status = await browser.execute(() =>
      document.querySelector("#netbox-test-status")?.textContent?.trim() ?? "");
    return status.startsWith("Connected");
  }, { timeout: WAIT_MS, interval: 100, timeoutMsg: "NetBox: Test Connection never reported Connected" });
  await (await browser.$("#netbox-token-save")).click();
  await waitForToast(browser, /^Connection saved$/, "NetBox");
  await clearToasts(browser);
  return baseUrl;
}

async function syncNetbox(browser, pattern) {
  await clearToasts(browser);
  await (await browser.$("#netbox-sync-btn")).click();
  return waitForToast(browser, pattern, "NetBox");
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

  if (mutationCategory === "ssh_send") {
    try {
      const result = await runCase({
        name: "mutation-check",
        // The app drops input at ssh_send, so the mock never receives the
        // command and waitForBytes fails first. That failure alone is not
        // enough: the app must also report a non-zero drop count, otherwise a
        // frontend that never reaches ssh_send would satisfy the check. This
        // must not match the old muteOutput failure (expected remote echo
        // exactly once) either, so a passing unmutated run cannot satisfy it.
        expectedFailure: /Command round-trip: Mock host did not receive \d+ bytes; mock received 0 bytes[\s\S]*mutation activation: ssh_send dropped [1-9]\d* bytes/,
        run: async (browser, dataDir) => {
          try {
            await commandRoundTrip(browser, dataDir);
          } catch (error) {
            throw new Error(`${error.message}; ${await mutationActivation(browser)}`);
          }
          throw new Error("Command round-trip: passed, but the mutation was supposed to drop input");
        },
      }, sshSuite);
      console.log(`PASS mutation-check — ${result}`);
    } catch (error) {
      throw new Error(
        `mutation-check: the ssh_send drop was not proven active: ${error.message}`,
        { cause: error },
      );
    }
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

        // Keyboard path: the nav row's button is the tab stop, Enter connects,
        // and the dialog must trap focus and hand it back to that button.
        await browser.execute((id) => {
          document.querySelector(`.nav-host-row[data-host-id="${id}"] > .nav-item`)?.focus();
        }, host.id);
        await browser.keys("\uE007");
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

        // Tab and Shift+Tab stay inside the dialog, and the dialog is named.
        await assertModalTrap(browser, ".modal-panel", "Duplicate session");

        // Escape cancels: no second session, no tab switch. A W3C key action
        // reaches the focused dialog button; the dialog shell dismisses on the
        // window capture listener.
        await pressEscape(browser);
        await browser.waitUntil(
          async () => browser.execute(() => !document.querySelector(".duplicate-session-dialog")),
          {
            timeout: 5_000,
            interval: 100,
            timeoutMsg: "Duplicate session: Escape did not dismiss the dialog",
          },
        );
        assert.equal(await tabCount(), 1, "Duplicate session: Escape must not open a session");
        assert(
          await browser.execute((id) => {
            const button = document.querySelector(`.nav-host-row[data-host-id="${id}"] > .nav-item`);
            return !!button && document.activeElement === button;
          }, host.id),
          "Duplicate session: closing the dialog must restore focus to the nav row that opened it",
        );

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
      name: "keyboard-focus",
      async run(browser, dataDir) {
        await installSmokeHelpers(browser);
        const host = await createHost(browser, { display_name: "Keyboard focus host" });
        // The connections view lists recent sessions, so the host has to have
        // been used once to appear in it (as createAndConnect does).
        await invoke(browser, "touch_host", { id: host.id });
        await browser.refresh();
        await (await browser.$(".hs-host-list")).waitForExist({ timeout: WAIT_MS });
        await (await browser.$(`.hs-host-item[data-host-id="${host.id}"]`))
          .waitForDisplayed({ timeout: WAIT_MS });
        await installSmokeHelpers(browser);

        // Connection manager: every tab stop is named and draws a focus ring,
        // and the two controls a keyboard user needs are in the tab order.
        const manager = (await tabWalk(browser, 30)).stops;
        assert(
          manager.length >= 6,
          `Keyboard focus: the connection manager exposed only ${manager.length} tab stops `
          + `(${JSON.stringify(manager.map(stopLabel))})`,
        );
        for (const stop of manager) {
          assertNamed(stop, "Keyboard focus");
          assertFocusVisible(stop, "Keyboard focus");
        }
        const managerNames = manager.map((stop) => stop.name);
        for (const required of ["Settings", "Keyboard focus host"]) {
          assert(
            managerNames.some((name) => name.includes(required)),
            `Keyboard focus: ${JSON.stringify(required)} is not reachable with Tab; `
            + `tab order was ${JSON.stringify(managerNames)}`,
          );
        }
        assert.deepEqual(await browser.execute(() => window.__comndSmoke.unnamed("body")), [],
          "Keyboard focus: the connection manager has unnamed controls");

        // Settings: reached by activating the focused title-bar button with
        // Enter, which is the keyboard path a user takes.
        await browser.execute(() => document.querySelector("#title-bar-settings")?.focus());
        await browser.keys("\uE007");
        await browser.waitUntil(
          async () => browser.execute(() => !!document.querySelector(".settings-nav-item")),
          { timeout: WAIT_MS, interval: 100, timeoutMsg: "Keyboard focus: Enter did not open settings" },
        );
        const settings = (await tabWalk(browser, 40)).stops;
        assert(
          settings.length >= 6,
          `Keyboard focus: settings exposed only ${settings.length} tab stops`,
        );
        for (const stop of settings) {
          assertNamed(stop, "Keyboard focus");
          assertFocusVisible(stop, "Keyboard focus");
        }
        assert.deepEqual(await browser.execute(() => window.__comndSmoke.unnamed("body")), [],
          "Keyboard focus: settings has unnamed controls");

        // KB import is an embedded tab panel rather than a modal (approved
        // deviation: reachability and names only, no trap to assert).
        await openNavSection(browser, "kb");
        const importItem = await browser.$('.nav-item[data-sub-id="import"]');
        await importItem.waitForDisplayed({ timeout: WAIT_MS });
        await importItem.click();
        await (await browser.$("#import-mode-url")).waitForExist({ timeout: WAIT_MS });
        const importPanel = (await tabWalk(browser, 40)).stops;
        assert(
          importPanel.some((stop) => stop.id === "import-mode-text"),
          `Keyboard focus: the KB import panel is not reachable with Tab; saw `
          + `${JSON.stringify(importPanel.map((stop) => stop.id || stop.tag))}`,
        );
        for (const stop of importPanel) {
          assertNamed(stop, "Keyboard focus");
          assertFocusVisible(stop, "Keyboard focus");
        }
        assert.deepEqual(await browser.execute(() => window.__comndSmoke.unnamed("body")), [],
          "Keyboard focus: the KB import panel has unnamed controls");

        // Replay save is a real modal: focus starts inside, Tab and Shift+Tab
        // stay inside, and Escape returns focus to the button that opened it.
        await openNavSection(browser, "replay");
        const manageItem = await browser.$('.nav-item[data-sub-id="manage"]');
        await manageItem.waitForDisplayed({ timeout: WAIT_MS });
        await manageItem.click();
        const addCommand = await browser.$(".rsm-add");
        await addCommand.waitForDisplayed({ timeout: WAIT_MS });
        await browser.execute(() => document.querySelector(".rsm-add")?.focus());
        await browser.keys("\uE007");
        await (await browser.$("#rsv-title")).waitForExist({ timeout: WAIT_MS });
        assert(
          await browser.execute(() => document.querySelector("#rsv-text") === document.activeElement),
          "Keyboard focus: the replay dialog must put initial focus in the command field",
        );
        await assertModalTrap(browser, ".modal-panel", "Keyboard focus");
        await pressEscape(browser);
        await browser.waitUntil(
          async () => browser.execute(() => !document.querySelector(".modal-panel")),
          { timeout: WAIT_MS, interval: 100, timeoutMsg: "Keyboard focus: Escape did not close the replay dialog" },
        );
        assert(
          await browser.execute(() => document.activeElement?.classList.contains("rsm-add") ?? false),
          "Keyboard focus: closing the replay dialog must restore focus to the button that opened it",
        );
      },
    },
    {
      name: "terminal-focus-and-sidebar",
      async run(browser, dataDir) {
        await installSmokeHelpers(browser);
        await launchAndConnect(browser, dataDir);
        await installSmokeHelpers(browser);

        // Terminal chrome is reachable and visibly focused. The walk steps over
        // the search input and the terminal's own Tab handling (both documented
        // interceptors) and keeps going, so the toolbar is still reached by
        // real Tab presses.
        const chromeWalk = await tabWalk(browser, 40);
        const chrome = chromeWalk.stops;
        assert(
          chrome.some((stop) => String(stop.cls).includes("tv-panel-btn")),
          `Terminal focus: the sidebar toggle is not reachable with Tab; saw `
          + `${JSON.stringify(chrome.map((stop) => stop.cls || stop.tag))}`,
        );
        for (const stop of chrome) {
          assertNamed(stop, "Terminal focus");
          assertFocusVisible(stop, "Terminal focus");
        }

        // Documented exception: the terminal's focus target is xterm's
        // offscreen helper textarea, which cannot draw a ring of its own, so
        // the assertion is that focus lands there and that the pane reports
        // :focus-within, not that a ring is painted around the pane.
        await browser.execute(() => document.querySelector(".xterm-helper-textarea")?.focus());
        const terminalFocus = await browser.execute(() => window.__comndSmoke.active());
        assert(
          terminalFocus.helperTextarea,
          `Terminal focus: typing focus did not land on the terminal input (it is on `
          + `${terminalFocus.tag}${terminalFocus.id ? `#${terminalFocus.id}` : ""})`,
        );
        assert(
          terminalFocus.terminalFocusWithin,
          "Terminal focus: the terminal pane does not report :focus-within",
        );

        const sidebar = () => browser.execute(() => {
          const panel = document.querySelector("#tv-sidebar");
          const toggle = document.querySelector(".tv-panel-btn");
          return {
            expanded: toggle?.getAttribute("aria-expanded") ?? null,
            visible: !!panel && panel.getClientRects().length > 0
              && !panel.classList.contains("hidden"),
          };
        });

        assert.equal((await sidebar()).visible, false, "Terminal focus: the sidebar should start closed");

        // Open by keyboard. Activating a toolbar toggle must leave focus on
        // that toggle: the toolbar keeps focus in the terminal for mouse
        // clicks only, so a keyboard user can operate it a second time.
        await browser.execute(() => document.querySelector(".tv-panel-btn")?.focus());
        await browser.keys("\uE007");
        await browser.waitUntil(async () => {
          const state = await sidebar();
          return state.visible && state.expanded === "true";
        }, { timeout: WAIT_MS, interval: 100, timeoutMsg: "Terminal focus: Enter did not open the sidebar" });
        assert(
          await browser.execute(() => document.activeElement?.classList.contains("tv-panel-btn") ?? false),
          "Terminal focus: activating the panel toggle by keyboard moved focus out of the toggle",
        );

        // With the sidebar open, its own controls are the next tab stops and
        // they are named and visibly focused.
        const panelStops = await tabFrom(browser, 6);
        assert(
          panelStops.some((stop) => String(stop.cls).includes("sb-toggle")),
          `Terminal focus: the open sidebar is not reachable with Tab; saw `
          + `${JSON.stringify(panelStops.map((stop) => stop.cls || stop.tag))}`,
        );
        for (const stop of panelStops) {
          assertNamed(stop, "Terminal focus");
          assertFocusVisible(stop, "Terminal focus");
        }

        // Close by keyboard, from the same toggle.
        await browser.execute(() => document.querySelector(".tv-panel-btn")?.focus());
        await browser.keys("\uE007");
        await browser.waitUntil(async () => {
          const state = await sidebar();
          return !state.visible && state.expanded === "false";
        }, { timeout: WAIT_MS, interval: 100, timeoutMsg: "Terminal focus: Enter did not close the sidebar" });
        assert(
          await browser.execute(() => document.activeElement?.classList.contains("tv-panel-btn") ?? false),
          "Terminal focus: closing the sidebar by keyboard moved focus out of the toggle",
        );

        // Ctrl+W is delete-word in a shell and must never be intercepted by
        // keyboard navigation; ctrl-w-passthrough asserts the bytes, and this
        // asserts the sidebar did not react to the chord.
        await sendKeys(browser, ["\uE009", "w", "\uE000"]);
        assert.equal(
          (await sidebar()).visible,
          false,
          "Terminal focus: Ctrl+W must not toggle the sidebar",
        );
      },
    },
    {
      name: "sidebar-pty-resize",
      async run(browser, dataDir) {
        await installSmokeHelpers(browser);
        await launchAndConnect(browser, dataDir);

        const geometry = () => browser.execute(() => {
          const box = (selector) => {
            const element = document.querySelector(selector);
            if (!element) return null;
            const rect = element.getBoundingClientRect();
            return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width };
          };
          // The panel stays in the DOM when closed (`.hidden` = display:none),
          // so visibility is a class/box question, not an existence question.
          const panel = document.querySelector("#tv-sidebar");
          const toggle = document.querySelector(".tv-panel-btn");
          return {
            terminal: box(".tv-terminal"),
            sidebar: box("#tv-sidebar"),
            main: box(".tv-main"),
            sidebarVisible: !!panel
              && panel.getClientRects().length > 0
              && !panel.classList.contains("hidden"),
            expanded: toggle?.getAttribute("aria-expanded") ?? null,
          };
        });

        const closedGeometry = await geometry();
        assert.equal(closedGeometry.sidebarVisible, false,
          "Sidebar resize: the sidebar should start closed");
        assert.equal(closedGeometry.expanded, "false",
          `Sidebar resize: the toggle should report aria-expanded="false", it reports `
          + `${JSON.stringify(closedGeometry.expanded)}`);
        assert(closedGeometry.terminal && closedGeometry.terminal.width > 0,
          "Sidebar resize: the terminal has no measurable width");
        const closedSizes = await lastPtySizes(browser);
        assert(
          closedSizes.length > 0,
          "Sidebar resize: the mock host recorded no PTY size for the initial session",
        );

        await (await browser.$(".tv-panel-btn")).click();
        await browser.waitUntil(async () => {
          const state = await geometry();
          return state.sidebarVisible && state.expanded === "true";
        }, {
          timeout: WAIT_MS,
          interval: 100,
          timeoutMsg: "Sidebar resize: the sidebar never became visible",
        });
        // The view refits 250 ms after the toggle and resizes the PTY then.
        await pause(800);

        const openGeometry = await geometry();
        assert(
          openGeometry.terminal.width < closedGeometry.terminal.width - 100,
          `Sidebar resize: opening the sidebar did not shrink the terminal `
          + `(${closedGeometry.terminal.width}px -> ${openGeometry.terminal.width}px)`,
        );
        assert(
          openGeometry.sidebar.left >= openGeometry.terminal.right - 1,
          `Sidebar resize: the sidebar overlays the terminal instead of pushing it `
          + `(sidebar left ${openGeometry.sidebar.left}, terminal right ${openGeometry.terminal.right})`,
        );
        assert(
          openGeometry.sidebar.width > 0 && openGeometry.sidebar.width < openGeometry.main.width,
          `Sidebar resize: the sidebar is not laid out inside the terminal row `
          + `(${openGeometry.sidebar.width}px of ${openGeometry.main.width}px)`,
        );

        await browser.waitUntil(async () => (await lastPtySizes(browser)).length > closedSizes.length, {
          timeout: WAIT_MS,
          interval: 100,
          timeoutMsg: "Sidebar resize: opening the sidebar never resized the remote PTY",
        });
        const openSizes = await lastPtySizes(browser);
        const before = closedSizes[closedSizes.length - 1];
        const after = openSizes[openSizes.length - 1];
        assert(
          after[0] < before[0],
          `Sidebar resize: the PTY width did not follow the terminal (${before[0]} cols -> ${after[0]} cols)`,
        );

        // Closing the sidebar must restore the terminal and the PTY width.
        await (await browser.$(".tv-panel-btn")).click();
        await browser.waitUntil(async () => {
          const state = await geometry();
          return !state.sidebarVisible && state.expanded === "false";
        }, {
          timeout: WAIT_MS,
          interval: 100,
          timeoutMsg: "Sidebar resize: the sidebar did not close",
        });
        await pause(800);
        const restored = await geometry();
        assert(
          Math.abs(restored.terminal.width - closedGeometry.terminal.width) < 2,
          `Sidebar resize: closing the sidebar did not restore the terminal width `
          + `(${closedGeometry.terminal.width}px -> ${restored.terminal.width}px)`,
        );
        const finalSizes = await lastPtySizes(browser);
        assert(
          finalSizes.length > openSizes.length && finalSizes[finalSizes.length - 1][0] >= before[0],
          `Sidebar resize: closing the sidebar did not restore the PTY width `
          + `(sizes ${JSON.stringify(finalSizes)})`,
        );
      },
    },
    {
      name: "accessible-names-toasts",
      async run(browser, dataDir) {
        await installSmokeHelpers(browser);
        await createHost(browser, { display_name: "Names host" });
        await browser.refresh();
        await (await browser.$(".hs-host-list")).waitForExist({ timeout: WAIT_MS });
        await installSmokeHelpers(browser);

        // Controls with no visible label must carry a name.
        assertNamedControls(await browser.execute(() => window.__comndSmoke.unnamed("body")),
          "Accessible names: the connection manager");

        await openSettings(browser);
        for (const item of ["general", "theme", "reading-comfort", "netbox"]) {
          await openSettingsItem(browser, item);
          assertNamedControls(await browser.execute(() => window.__comndSmoke.unnamed("body")),
            `Accessible names: the ${item} settings`);
        }

        // An error toast must be announced, not merely drawn: it needs an
        // alert role inside a live region, and its dismiss control a name.
        await configureNetbox(browser);
        await invoke(browser, "test_netbox_set_scenario", { scenario: "server_error" });
        await clearToasts(browser);
        await (await browser.$("#netbox-sync-btn")).click();
        const toast = await waitForToast(browser, /Sync failed: NetBox server error \(HTTP 500\)/,
          "Accessible names");
        const errorToast = toast.toasts.find((entry) => /Sync failed/.test(entry.message));
        assert(errorToast, "Accessible names: the error toast disappeared before it could be asserted");
        assert.equal(toast.live, "polite",
          `Accessible names: the toast container must be a polite live region, its aria-live is ${JSON.stringify(toast.live)}`);
        assert.equal(errorToast.role, "alert",
          `Accessible names: the error toast must be announced as an alert, its role is ${JSON.stringify(errorToast.role)}`);
        assert.equal(errorToast.insideLiveRegion, true,
          "Accessible names: the error toast is outside any live region");
        assert.equal(errorToast.dismissName, "Dismiss notification",
          `Accessible names: the toast dismiss button is named ${JSON.stringify(errorToast.dismissName)}`);
      },
    },
    {
      name: "themes-and-text-scale",
      async run(browser, dataDir) {
        await installSmokeHelpers(browser);
        await createHost(browser, { display_name: "Theme host" });
        await browser.refresh();
        await (await browser.$(".hs-host-list")).waitForExist({ timeout: WAIT_MS });
        await installSmokeHelpers(browser);
        await openSettings(browser);
        await openSettingsItem(browser, "theme");
        await (await browser.$("#theme-app")).waitForExist({ timeout: WAIT_MS });

        const applyTheme = async (theme) => {
          await setField(browser, "#theme-app", theme);
          await browser.waitUntil(
            async () => (await browser.execute(() => document.documentElement.dataset.theme)) === theme,
            { timeout: WAIT_MS, interval: 100, timeoutMsg: `Theme: the ${theme} theme was not applied` },
          );
          return browser.execute(() => {
            const root = getComputedStyle(document.documentElement);
            const nav = document.querySelector(".nav-panel");
            return {
              theme: document.documentElement.dataset.theme,
              bg: root.getPropertyValue("--color-surface-primary").trim(),
              navBackground: nav ? getComputedStyle(nav).backgroundColor : "",
            };
          });
        };

        const applied = {};
        for (const theme of ["dark", "light", "solarized-light"]) {
          applied[theme] = await applyTheme(theme);
          assert.equal(applied[theme].theme, theme, `Theme: ${theme} did not reach the document`);
          assert(applied[theme].bg.length > 0,
            `Theme: ${theme} defines no --color-surface-primary token`);
          assertNamedControls(await browser.execute(() => window.__comndSmoke.unnamed("body")),
            `Theme: the ${theme} theme`);
          assertNothingClipped(await browser.execute(() => window.__comndSmoke.clipped("body")),
            `Theme: the ${theme} theme clips controls`);
        }
        const backgrounds = new Set(Object.values(applied).map((entry) => entry.bg));
        assert.equal(
          backgrounds.size,
          3,
          `Theme: dark, light and solarized-light must render distinct chrome, saw `
          + `${JSON.stringify([...backgrounds])}`,
        );
        await applyTheme("dark");

        // Reading Comfort, then enlarged UI text, both measured rather than
        // assumed: the scale token must change and the text must grow.
        await openSettingsItem(browser, "reading-comfort");
        await (await browser.$("#rc-enabled")).waitForExist({ timeout: WAIT_MS });
        const measure = () => browser.execute(() => {
          const label = document.querySelector('.settings-nav-item[data-item-id="reading-comfort"]');
          return {
            scale: getComputedStyle(document.documentElement).getPropertyValue("--text-scale").trim(),
            fontSize: label ? parseFloat(getComputedStyle(label).fontSize) : 0,
            readingComfort: document.documentElement.dataset.readingComfort ?? "off",
          };
        });
        const before = await measure();
        await (await browser.$("#rc-enabled")).click();
        await browser.waitUntil(
          async () => (await measure()).readingComfort === "on",
          { timeout: WAIT_MS, interval: 100, timeoutMsg: "Reading Comfort: the mode never turned on" },
        );
        await (await browser.$("#rc-ui-scale")).waitForExist({ timeout: WAIT_MS });
        await setField(browser, "#rc-ui-scale", "1.5");
        await browser.waitUntil(
          async () => Math.abs(parseFloat((await measure()).scale) - 1.5) < 0.001,
          { timeout: WAIT_MS, interval: 100, timeoutMsg: "Reading Comfort: the UI text scale never reached 1.5x" },
        );
        const after = await measure();
        assert(
          after.fontSize > before.fontSize,
          `Enlarged text: the 1.5x UI scale did not grow interface text `
          + `(${before.fontSize}px -> ${after.fontSize}px)`,
        );
        assertNothingClipped(await browser.execute(() => window.__comndSmoke.clipped("body")),
          "Enlarged text: controls are clipped at the 1.5x UI scale");
        assert.deepEqual(await browser.execute(() => window.__comndSmoke.overlaps("body")), [],
          "Enlarged text: controls overlap at the 1.5x UI scale");
      },
    },
    {
      name: "small-window-long-names",
      async run(browser, dataDir) {
        await installSmokeHelpers(browser);
        const group = await invoke(browser, "save_host_group", {
          id: null,
          name: "Long name group",
          parentId: null,
          color: null,
          icon: null,
        });
        const nestedGroup = await invoke(browser, "save_host_group", {
          id: null,
          name: "Nested subgroup with a long name",
          parentId: group.id,
          color: null,
          icon: null,
        });
        const longName = "core-sw1.site-very-long-region-name.example.internal";
        const hosts = [];
        for (const name of [longName, "edge-router-2", "fw-cluster-3"]) {
          hosts.push(await createHost(browser, {
            display_name: name,
            hostname: `${name}.example.internal`,
            group_id: group.id,
          }));
        }
        await browser.refresh();
        await (await browser.$(".nav-panel")).waitForExist({ timeout: WAIT_MS });
        await installSmokeHelpers(browser);

        // The smallest window the app allows: minWidth 800, minHeight 600.
        await resizeWindow(browser, 800, 600);
        const size = await browser.execute(() => ({ width: window.innerWidth, height: window.innerHeight }));
        assert(
          size.width <= 840 && size.height <= 640,
          `Small window: the window did not shrink to 800x600 (it reports ${size.width}x${size.height})`,
        );

        // Expand the folder tree so the long names are actually rendered.
        await expandNavGroup(browser, group.id);
        await (await browser.$(`.nav-host-row[data-host-id="${hosts[0].id}"]`))
          .waitForDisplayed({ timeout: WAIT_MS });
        await expandNavGroup(browser, nestedGroup.id);
        await (await browser.$(`.nav-group-row[data-group-id="${nestedGroup.id}"]`))
          .waitForDisplayed({ timeout: WAIT_MS });

        assertNothingClipped(await browser.execute(() => window.__comndSmoke.clipped(".nav-panel")),
          "Small window: the nav panel clips a control");
        assert.deepEqual(await browser.execute(() => window.__comndSmoke.overlaps(".nav-panel")), [],
          "Small window: nav panel controls overlap");
        assertNothingClipped(await browser.execute(() => window.__comndSmoke.clipped("body")),
          "Small window: a control is clipped");
        assert.deepEqual(await browser.execute(() => window.__comndSmoke.overlaps("body")), [],
          "Small window: controls overlap");
        const labelBox = await browser.execute((id) => {
          const label = document.querySelector(`.nav-host-row[data-host-id="${id}"] .nav-item-label`);
          const row = document.querySelector(`.nav-host-row[data-host-id="${id}"]`);
          if (!label || !row) return null;
          const a = label.getBoundingClientRect();
          const b = row.getBoundingClientRect();
          return { left: a.left, right: a.right, rowLeft: b.left, rowRight: b.right, text: label.textContent };
        }, hosts[0].id);
        assert(labelBox, "Small window: the long-named host is not rendered in the nav panel");
        assert(
          labelBox.left >= labelBox.rowLeft - 1 && labelBox.right <= labelBox.rowRight + 1,
          `Small window: the long host name overflows its row `
          + `(${labelBox.left}-${labelBox.right} inside ${labelBox.rowLeft}-${labelBox.rowRight})`,
        );

        // A dialog taller than the window must scroll, not clip its controls.
        await openNavSection(browser, "replay");
        const manageItem = await browser.$('.nav-item[data-sub-id="manage"]');
        await manageItem.waitForDisplayed({ timeout: WAIT_MS });
        await manageItem.click();
        await (await browser.$(".rsm-add")).waitForDisplayed({ timeout: WAIT_MS });
        await (await browser.$(".rsm-add")).click();
        await (await browser.$(".modal-panel")).waitForExist({ timeout: WAIT_MS });
        const panel = await browser.execute(() => {
          const element = document.querySelector(".modal-panel");
          const style = getComputedStyle(element);
          return {
            scrollHeight: element.scrollHeight,
            clientHeight: element.clientHeight,
            overflowY: style.overflowY,
            name: window.__comndSmoke.nameOf(element),
          };
        });
        assert(panel.name.length > 0, "Dialog overflow: the dialog has no accessible name");
        if (panel.scrollHeight > panel.clientHeight) {
          assert(
            panel.overflowY === "auto" || panel.overflowY === "scroll",
            `Dialog overflow: the dialog is taller than the window but does not scroll `
            + `(${panel.scrollHeight}px of content in ${panel.clientHeight}px, overflow-y ${panel.overflowY})`,
          );
        }
        assertNothingClipped(await browser.execute(() => window.__comndSmoke.clipped(".modal-panel")),
          "Dialog overflow: the dialog clips a control");
        assert.deepEqual(await browser.execute(() => window.__comndSmoke.overlaps(".modal-panel")), [],
          "Dialog overflow: dialog controls overlap");
        await pressEscape(browser);
        await browser.waitUntil(
          async () => browser.execute(() => !document.querySelector(".modal-panel")),
          { timeout: WAIT_MS, interval: 100, timeoutMsg: "Dialog overflow: Escape did not close the dialog" },
        );
      },
    },
    {
      name: "netbox-configure-dialog",
      async run(browser, dataDir) {
        await installSmokeHelpers(browser);
        await configureNetbox(browser);
        await installSmokeHelpers(browser);
        await syncNetbox(browser, /^Synced/);

        // NetBox hosts appear in the nav panel after the sync; the configure
        // dialog is opened from the row's context menu. Devices land in a
        // synthetic `__netbox__` group below All Hosts, so expand both.
        const netboxRow = () => browser.execute(() =>
          document.querySelector('.nav-host-row[data-host-id^="netbox:"]')?.dataset.hostId ?? null);
        if (!(await netboxRow())) {
          await expandNavGroup(browser, "__all__");
          await browser.waitUntil(
            async () => browser.execute(() =>
              !!document.querySelector('.nav-group-row[data-group-id^="__netbox__"]')),
            {
              timeout: WAIT_MS,
              interval: 100,
              timeoutMsg: "NetBox configure: the sync produced no NetBox group in the nav panel",
            },
          );
          await expandNavGroup(browser, "__netbox__");
          await browser.waitUntil(async () => !!(await netboxRow()), {
            timeout: WAIT_MS,
            interval: 100,
            timeoutMsg: "NetBox configure: the sync produced no NetBox host row in the nav panel",
          });
        }
        const hostId = await netboxRow();

        // Focus the row's own button first: it is the invoking element the
        // dialog must hand focus back to, and it is the keyboard tab stop.
        await browser.execute((id) => {
          const row = document.querySelector(`.nav-host-row[data-host-id="${id}"]`);
          const button = row?.querySelector(".nav-item");
          if (!row || !button) throw new Error(`no nav row for ${id}`);
          button.focus();
          row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 120, clientY: 240 }));
        }, hostId);
        await (await browser.$('.ctx-item[data-action="configure"]')).waitForExist({ timeout: WAIT_MS });
        await browser.execute(() => document.querySelector('.ctx-item[data-action="configure"]')?.click());
        await (await browser.$("#nb-cfg-title")).waitForExist({ timeout: WAIT_MS });

        assert.deepEqual(await browser.execute(() => window.__comndSmoke.unnamed(".modal-panel")), [],
          "NetBox configure: the dialog has controls with no accessible name");
        await assertModalTrap(browser, ".modal-panel", "NetBox configure");

        await pressEscape(browser);
        await browser.waitUntil(
          async () => browser.execute(() => !document.querySelector(".modal-panel")),
          { timeout: WAIT_MS, interval: 100, timeoutMsg: "NetBox configure: Escape did not close the dialog" },
        );
        assert(
          await browser.execute((id) => {
            const button = document.querySelector(`.nav-host-row[data-host-id="${id}"] > .nav-item`);
            return !!button && document.activeElement === button;
          }, hostId),
          "NetBox configure: closing the dialog must restore focus to the nav row that opened it",
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

  // A focus/name/layout run boots the same app with COMND_SMOKE_MUTATION set
  // and drives only the scenario that regression is supposed to break. The
  // expected failure must name the assertion and carry proof that the
  // frontend applied the mutation, so a broken seam cannot pass silently.
  if (mutationCategory) {
    const target = MUTATION_CASES[mutationCategory];
    const scenario = tests.find((test) => test.name === target.scenario);
    assert(scenario, `mutation ${mutationCategory} names an unknown scenario ${target.scenario}`);
    try {
      const result = await runCase({
        name: `mutation-${mutationCategory}`,
        expectedFailure: target.expectedFailure,
        run: async (browser, dataDir) => {
          try {
            await scenario.run(browser, dataDir);
          } catch (error) {
            throw new Error(`${error.message}; ${await categoryActivation(browser, mutationCategory)}`);
          }
          throw new Error(
            `passed, but the ${mutationCategory} mutation was supposed to break it; `
            + await categoryActivation(browser, mutationCategory),
          );
        },
      }, sshSuite);
      console.log(`PASS mutation-${mutationCategory} — ${result}`);
    } catch (error) {
      throw new Error(
        `mutation-${mutationCategory}: the ${mutationCategory} regression was not proven active: `
        + error.message,
        { cause: error },
      );
    }
    return;
  }

  await runSuite(tests, sshSuite);
}

main().catch((error) => {
  console.error(error.stack ?? error);
  process.exit(1);
});
