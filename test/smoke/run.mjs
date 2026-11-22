import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import {
  actOn,
  buildApp,
  invoke,
  parseJobs,
  pause,
  runCase,
  runSuite,
  runUnderXvfb,
  switchToWindow,
  waitFor,
  waitForNoWindow,
  waitForWindowCount,
  windowHandles,
  WAIT_MS,
} from "./lib/harness.mjs";

// ─── Mutation categories (issue #89) ─────────────────────────────────
//
// Every category is a deliberate regression applied inside the app process
// (COMND_SMOKE_MUTATION), and each must make exactly one named assertion fail.
// The category is passed to the frontend through test_smoke_mutation so an
// assertion can prove the mutation actually ran; a broken seam would otherwise
// let an unmutated app satisfy the expected-failure match.
const MUTATION_CATEGORIES = [
  "ssh_send",
  "focus",
  "name",
  "layout",
  "suggestion",
  "kb-layout",
  "terminal-sidebar-layout",
];

function parseMutation(argv) {
  const equals = argv.find((arg) => arg.startsWith("--mutation="));
  const bare = argv.includes("--mutation");
  if (equals && bare) {
    console.error("--mutation takes its categories in one value: pass either --mutation or --mutation=<category>");
    process.exit(2);
  }
  if (!equals) {
    // A bare --mutation keeps its original meaning (ssh_send), so
    // `npm run smoke:mutation` keeps proving the SSH send path drops input.
    return bare ? ["ssh_send"] : null;
  }
  const value = equals.slice("--mutation=".length);
  // `all`, and comma lists, exist so one process can prove every category after
  // a single app build: a separate invocation per category re-runs the whole
  // `tauri build` to drive one ~20s scenario.
  if (value === "all") return [...MUTATION_CATEGORIES];
  const categories = value.split(",").map((category) => category.trim()).filter(Boolean);
  const unknown = categories.find((category) => !MUTATION_CATEGORIES.includes(category));
  if (unknown !== undefined) {
    console.error(
      `Unknown mutation category ${JSON.stringify(unknown)}; `
      + `expected one of ${MUTATION_CATEGORIES.join(", ")}, or all`,
    );
    process.exit(2);
  }
  return categories;
}

const mutationCategories = parseMutation(process.argv);

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
  // Scoped to the prefix path (stripPrefix stops stripping) so the ghost and
  // dropdown assertions in `suggestion-accept` and `dropdown-click` stay green:
  // only `prefix-suggestion` types a prefix command. The matched message is the
  // missing-ghost timeout itself, so a later failure in the same scenario (a
  // stalled mock, say) cannot stand in for a proven broken prefix.
  suggestion: {
    scenario: "prefix-suggestion",
    expectedFailure: /Prefix suggestion: expected the ghost to show 'ctl'[\s\S]*mutation activation: suggestion applied/,
  },
  // Issue #133: KB and side-panel control geometry. Each mutation moves one
  // screen's controls off the window, so the scenario's own in-window box
  // assertion must fail; the hit-test and scroll-width assertions cover the
  // cases CSS cannot fake (an element that is on screen but covered).
  "kb-layout": {
    scenario: "kb-layout",
    expectedFailure: /KB layout: .* is outside the window[\s\S]*mutation activation: kb-layout applied/,
  },
  "terminal-sidebar-layout": {
    scenario: "terminal-sidebar-layout",
    expectedFailure: /Terminal sidebar layout: .* is outside the window[\s\S]*mutation activation: terminal-sidebar-layout applied/,
  },
};

// The suite's environment: a mutation run makes the app misbehave on purpose,
// so a passing check cannot be satisfied by a silent or broken app. The NetBox
// token is seeded because CI has no OS keyring; the accessibility scenarios
// that open the NetBox configure dialog need it.
const sshSuite = {
  env: {
    COMND_TEST_MOCK_NETBOX_TOKEN: "nbt_smoke.token",
    // The app must never launch a browser on its own, and a deliberate launch
    // (the seam proof below) must not open one on the runner either. The app
    // still counts the launch before suppressing it.
    COMND_SMOKE_NO_BROWSER: "1",
  },
  // The accessibility scenarios may start the NetBox mock as well, so stop
  // whichever mock is running instead of only the SSH one. Both Rust commands
  // return Ok when nothing is running, so a rejection here is a real failure.
  async teardown(browser) {
    const results = await Promise.allSettled([
      invoke(browser, "test_stop_mock_server"),
      invoke(browser, "test_stop_netbox_server"),
    ]);
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
  },
};

/** The suite for one mutation category: that run's app misbehaves on purpose. */
const mutationSuite = (category) => ({
  ...sshSuite,
  env: { ...sshSuite.env, COMND_SMOKE_MUTATION: category },
});

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
    // A focus ring drawn with a CSS transition is still animating when the
    // style is read straight after the key press, so the read records the
    // ring's starting width (0px) instead of the settled one. Removing
    // transitions does not change a settled computed value, it only removes
    // the wait, so this is injected once per document, before any walk.
    if (!document.getElementById("comnd-smoke-no-transitions")) {
      const style = document.createElement("style");
      style.id = "comnd-smoke-no-transitions";
      style.textContent = "*, *::before, *::after { transition: none !important; }";
      document.head.append(style);
    }

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

    // A glyph-only label ("×", "▸") is not something a screen reader can
    // announce, so contents only name an element when they carry a word.
    const hasWords = (text) => /[\p{L}\p{N}]/u.test(text);

    // ARIA gives `dialog`/`alertdialog` no name from contents, and a form
    // control is named by its label rather than by its own text, so neither
    // may be satisfied by the text inside it.
    const namedByContent = (el) => {
      const tag = el.tagName.toLowerCase();
      if (tag === "input" || tag === "select" || tag === "textarea") return false;
      const role = el.getAttribute("role");
      return role !== "dialog" && role !== "alertdialog" && role !== "textbox"
        && role !== "combobox" && role !== "listbox" && role !== "searchbox";
    };

    // Accessible name, computed the way a user of a screen reader would hear
    // it for the cases this app uses: aria-labelledby, aria-label, a native
    // label, contents (only where contents name the element), title, then a
    // nested image's alt text.
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
      const text = namedByContent(el) ? (el.textContent ?? "").replace(/\s+/g, " ").trim() : "";
      if (text && hasWords(text)) return text;
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

    // ARIA 1.2 gives `dialog` and `alertdialog` an author-only name source, so
    // a heading inside the panel does not name it: only aria-labelledby or
    // aria-label will do.
    const authorName = (el) => {
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
      return el.getAttribute("aria-label")?.trim() ?? "";
    };

    // Every focus indicator this app uses: an outline, a box-shadow, or a
    // pseudo-element that draws the ring.
    // `documentFocused` travels with every reading because Blink only matches
    // `:focus-visible` while the app window is the OS foreground window: a
    // reading taken after another window took focus shows no ring even though
    // the stylesheet draws one, and the flag is what tells those apart.
    const focusStyle = (el) => {
      if (!el) {
        return {
          outlineStyle: "none",
          outlineWidth: "0px",
          outlineColor: "transparent",
          boxShadow: "none",
          pseudoShadow: "none",
          documentFocused: document.hasFocus(),
        };
      }
      const style = getComputedStyle(el);
      // The two pseudo-element shadow lists are joined with a comma so they
      // stay separate layers; "none" is dropped so it cannot mask a real ring.
      const pseudoShadow = ["::before", "::after"]
        .map((pseudo) => getComputedStyle(el, pseudo).boxShadow)
        .filter((shadow) => shadow !== "none")
        .join(", ") || "none";
      return {
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        outlineColor: style.outlineColor,
        boxShadow: style.boxShadow,
        pseudoShadow,
        documentFocused: document.hasFocus(),
      };
    };

    // Roving-group candidates. A collapsed nav section keeps its rows laid
    // out (so they still have client rects) but visibility:hidden, and such a
    // row cannot take focus, so it is not a tab stop.
    const groupItems = (root, selector) => {
      if (!root) return [];
      return [...root.querySelectorAll(selector)].filter((el) => (
        el.getClientRects().length > 0
        && getComputedStyle(el).visibility === "visible"
        && !el.disabled
      ));
    };

    // A position: fixed box escapes ordinary ancestor clipping: only an
    // ancestor that establishes its containing block can clip it. The nav's
    // context menu is position: fixed but rendered inside .app-nav, which now
    // scrolls horizontally (ADR 024), so its items must not be measured
    // against the panel's edge.
    const fixedContainingBlock = (style) =>
      style.transform !== "none"
      || style.filter !== "none"
      || (style.backdropFilter || "none") !== "none"
      || style.perspective !== "none"
      || /\b(paint|layout|strict|content)\b/.test(style.contain)
      || /transform|filter|perspective/.test(style.willChange);

    window.__comndSmoke = {
      describe,
      nameOf,
      authorName,
      shown,
      focusStyle,
      groupItems,
      /** The last keydown the page saw, for failure messages. */
      lastKey() {
        return window.__comndSmokeLastKey ?? null;
      },
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
          const fixed = getComputedStyle(el).position === "fixed";
          for (let parent = el.parentElement; parent && parent !== document.documentElement; parent = parent.parentElement) {
            const style = getComputedStyle(parent);
            if (fixed && !fixedContainingBlock(style)) continue;
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
          }
        }
        return [...new Set(out)];
      },
      /** Pairs of visible controls whose boxes overlap each other. */
      overlaps(scope) {
        const root = document.querySelector(scope);
        if (!root) return [`${scope} is missing`];
        // A control that runs past an ancestor's edge is painted only up to
        // that edge. The nav rows are as wide as their text and scroll inside
        // .app-nav, so their raw boxes pass under the panel's resizer handle
        // legitimately; comparing raw rects would call that an overlap the user
        // can never see.
        const seenRect = (el) => {
          let rect = el.getBoundingClientRect();
          const fixed = getComputedStyle(el).position === "fixed";
          for (let parent = el.parentElement; parent && parent !== document.documentElement; parent = parent.parentElement) {
            const style = getComputedStyle(parent);
            if (fixed && !fixedContainingBlock(style)) continue;
            if (style.overflowX === "visible" && style.overflowY === "visible") continue;
            const box = parent.getBoundingClientRect();
            const left = Math.max(rect.left, box.left);
            const top = Math.max(rect.top, box.top);
            const right = Math.min(rect.right, box.right);
            const bottom = Math.min(rect.bottom, box.bottom);
            rect = { left, top, right, bottom, width: right - left, height: bottom - top };
            if (rect.width <= 0 || rect.height <= 0) return rect;
          }
          return rect;
        };
        const boxes = [...root.querySelectorAll(INTERACTIVE)]
          .filter(shown)
          .map((el) => ({ el, rect: seenRect(el) }))
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
    // The driver's modifier reporting is not reliable on every platform, so
    // keep the last key event for failure messages.
    window.__comndSmokeLastKey = null;
    document.addEventListener("keydown", (event) => {
      window.__comndSmokeLastKey = { key: event.key, shiftKey: event.shiftKey };
    }, true);
  });
}

/**
 * Focus targets where the app deliberately handles Tab itself, so a real Tab
 * press changes app state instead of moving focus: the global search input
 * toggles its Hosts/Commands mode (07-keyboard-shortcuts.md) and the terminal
 * forwards Tab to the remote device (context-sensitive Tab). Neither has a
 * keyboard route onwards — Escape in the search box blurs to the body, which
 * restarts the order rather than continuing it — so the walk records the stop
 * reached by a real Tab press and then steps over it programmatically.
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
      window.__comndSmokeStopSeq = 0;
      for (const tagged of document.querySelectorAll("[data-comnd-stop]")) {
        tagged.removeAttribute("data-comnd-stop");
      }
    });
  }
  const stops = [];
  let tabInterceptors = 0;
  const readStop = () => browser.execute(() => {
    const el = document.activeElement;
    // Tag the stop so its unfocused style can be read after the walk.
    if (el && el !== document.body && !el.hasAttribute("data-comnd-stop")) {
      const seq = (window.__comndSmokeStopSeq ?? 0) + 1;
      window.__comndSmokeStopSeq = seq;
      el.setAttribute("data-comnd-stop", String(seq));
    }
    return {
      ...window.__comndSmoke.active(),
      ...window.__comndSmoke.focusStyle(el),
      styleKey: el?.getAttribute?.("data-comnd-stop") ?? "",
    };
  });
  for (let index = 0; index < max; index += 1) {
    await browser.keys("\uE004");
    const state = await readWithRingRetry(browser, readStop, {
      isStop: (stop) => !!stop.tag && stop.tag !== "body",
      styleOf: (stop) => stop,
    });
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
  // Read the same stops while they are NOT focused, so an indicator that is
  // always drawn (the inset border on a settings toggle, say) cannot pass for
  // one that appears on focus. Focus is handed back afterwards so a caller
  // that continues the walk with `reset: false` carries on from here.
  const resting = await browser.execute(() => {
    const last = document.activeElement;
    if (last && last !== document.body) last.blur();
    document.body.setAttribute("tabindex", "-1");
    document.body.focus();
    document.body.removeAttribute("tabindex");
    const out = {};
    for (const el of document.querySelectorAll("[data-comnd-stop]")) {
      out[el.getAttribute("data-comnd-stop")] = window.__comndSmoke.focusStyle(el);
      el.removeAttribute("data-comnd-stop");
    }
    if (last && last !== document.body && last.isConnected) last.focus();
    return out;
  });
  for (const stop of stops) stop.resting = resting[stop.styleKey] ?? null;
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

/**
 * Alpha channel of a computed CSS colour. A ring that is painted but fully
 * transparent is not seen, so it must not satisfy the focus check.
 */
function colorAlpha(color) {
  const value = String(color ?? "").trim().toLowerCase();
  if (!value || value === "none" || value === "transparent") return 0;
  const rgb = /^rgba?\(([^)]+)\)$/.exec(value);
  if (rgb) {
    const parts = rgb[1].split(/[,/]/).map((part) => part.trim()).filter(Boolean);
    return parts.length >= 4 ? parseFloat(parts[3]) : 1;
  }
  const modern = /^color\(([^)]+)\)$/.exec(value);
  if (modern) {
    const parts = modern[1].split(/[\s/]+/).filter(Boolean);
    return parts.length >= 4 ? parseFloat(parts[3]) : 1;
  }
  // Named colours, hex and currentcolor all paint.
  return 1;
}

/** True when a box-shadow list paints at least one layer in a visible colour. */
function shadowVisible(value) {
  const text = String(value ?? "").trim();
  if (!text || text.toLowerCase() === "none") return false;
  const layers = text
    .split(/,(?![^(]*\))/)
    .map((layer) => layer.trim())
    .filter((layer) => layer && layer.toLowerCase() !== "none");
  return layers.some((layer) => {
    const color = layer.match(/rgba?\([^)]*\)|color\([^)]*\)|#[0-9a-f]{3,8}|\btransparent\b/i);
    // A layer with no colour token uses currentColor, which paints.
    return color ? colorAlpha(color[0]) > 0 : true;
  });
}

/** True when a reading paints a focus ring of its own. */
function ringPainted(style) {
  return (style.outlineStyle !== "none"
      && parseFloat(style.outlineWidth) > 0
      && colorAlpha(style.outlineColor) > 0)
    || shadowVisible(style.boxShadow)
    || shadowVisible(style.pseudoShadow);
}

/**
 * Read the focused element, and when the reading shows no focus ring at all,
 * press Shift and read the same element once more.
 *
 * Blink stops matching `:focus-visible` for the focused element while the app
 * window is not the OS foreground window, so a reading taken in that moment
 * reports no ring on a stop whose stylesheet draws one. Shift is a key press
 * that types nothing and restores keyboard modality, and it does not move
 * focus, so the second reading covers the same stop. A ring that is genuinely
 * absent — the `focus` mutation — is absent from both readings, and the
 * failure message then says the re-read did not recover it.
 */
async function readWithRingRetry(browser, read, { isStop, styleOf }) {
  const first = await read();
  if (!first || !isStop(first) || ringPainted(styleOf(first))) return first;
  await browser.keys("\uE008");
  const again = await read();
  if (again && (again.styleKey ?? "") === (first.styleKey ?? "")
    && ringPainted(styleOf(again))) return again;
  return { ...first, ringRetry: "still absent on the Shift re-read" };
}

function assertFocusVisible(stop, label) {
  const resting = stop.resting;
  // A visible indicator is not enough on its own: it has to differ from the
  // unfocused style, or a permanently drawn border or shadow would pass.
  const changed = !!resting
    && (stop.outlineStyle !== resting.outlineStyle
      || stop.outlineWidth !== resting.outlineWidth
      || stop.outlineColor !== resting.outlineColor
      || stop.boxShadow !== resting.boxShadow
      || stop.pseudoShadow !== resting.pseudoShadow);
  assert(
    ringPainted(stop) && changed,
    `${label}: ${stopLabel(stop)} has no visible focus indicator `
    + `(outline ${stop.outlineStyle} ${stop.outlineWidth} ${stop.outlineColor}, `
    + `box-shadow ${stop.boxShadow}, pseudo ${stop.pseudoShadow}; `
    + `unfocused outline ${resting?.outlineStyle ?? "?"} ${resting?.outlineWidth ?? "?"} `
    + `${resting?.outlineColor ?? "?"}, box-shadow ${resting?.boxShadow ?? "?"}, `
    + `pseudo ${resting?.pseudoShadow ?? "?"}; `
    + `document focused ${stop.documentFocused ?? "?"}, `
    + `unfocused document focused ${resting?.documentFocused ?? "?"})`
    + (stop.ringRetry ? `; Shift re-read: ${stop.ringRetry}` : ""),
  );
}

/**
 * Assert that a specific element can take focus, is named, and draws a focus
 * ring. Used for a stop the keyboard walk cannot record: when the walk steps
 * over a Tab interceptor it focuses the next candidate itself, so the element
 * that jump lands on is never the one a Tab press is observed on. This proves
 * the element is focusable and how it looks while focused, not that Tab
 * reaches it.
 */
async function assertScriptFocusStop(browser, selector, label) {
  const probeOnce = () => browser.execute((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    if (document.activeElement === el) el.blur();
    const resting = window.__comndSmoke.focusStyle(el);
    el.focus();
    return {
      took: document.activeElement === el,
      tabIndex: el.tabIndex,
      resting,
      active: window.__comndSmoke.active(),
      focused: window.__comndSmoke.focusStyle(document.activeElement),
    };
  }, selector);
  const probe = await readWithRingRetry(browser, probeOnce, {
    isStop: (state) => state?.took,
    styleOf: (state) => state.focused,
  });
  assert(probe, `${label}: ${selector} is not in the document`);
  assert(probe.took, `${label}: ${selector} cannot take focus (tabIndex ${probe.tabIndex})`);
  const stop = {
    ...probe.active,
    ...probe.focused,
    resting: probe.resting,
    ringRetry: probe.ringRetry,
  };
  assertNamed(stop, label);
  assertFocusVisible(stop, label);
  await browser.execute((sel) => document.querySelector(sel)?.blur(), selector);
  return stop;
}

/**
 * Roving tabindex groups (the nav panel and the settings icon nav) keep one
 * Tab stop and move between their items with arrow keys, so a Tab walk alone
 * would only ever reach the stop it started on. Entry focus is set
 * programmatically to that single stop — the caller has already seen the walk
 * record it — and every move after that is a real key press. After each move
 * exactly one item may be a tab stop, and it must be the focused one.
 */
async function assertRovingGroup(browser, { group, item, label }) {
  await installSmokeHelpers(browser);
  const state = () => browser.execute(({ groupSel, itemSel }) => {
    const root = document.querySelector(groupSel);
    if (!root) return null;
    const items = window.__comndSmoke.groupItems(root, itemSel);
    const active = document.activeElement;
    return {
      count: items.length,
      index: items.indexOf(active),
      tabStops: items.filter((el) => el.tabIndex === 0).length,
      stops: items.filter((el) => el.tabIndex === 0)
        .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]}`
          + `[${JSON.stringify((el.textContent ?? "").trim().slice(0, 18))}]`),
      focus: active ? window.__comndSmoke.focusStyle(active) : null,
      name: active ? window.__comndSmoke.nameOf(active) : "",
    };
  }, { groupSel: group, itemSel: item });

  const count = await browser.execute(({ groupSel, itemSel }) => {
    const root = document.querySelector(groupSel);
    if (!root) return 0;
    const items = window.__comndSmoke.groupItems(root, itemSel);
    (items.find((el) => el.tabIndex === 0) ?? items[0])?.focus();
    return items.length;
  }, { groupSel: group, itemSel: item });
  assert(count >= 2, `${label}: ${group} needs at least two items, saw ${count}`);

  const start = await state();
  assert.equal(start.index >= 0, true, `${label}: the roving stop in ${group} did not take focus`);
  assert.equal(start.tabStops, 1, `${label}: ${group} must expose exactly one Tab stop, saw ${start.tabStops} (${start.stops.join(", ")})`);
  // The nav panel clamps at either end, so step away from the end it started on.
  const forward = start.index < start.count - 1;
  const step = forward ? "\uE015" : "\uE013";
  const back = forward ? "\uE013" : "\uE015";

  await browser.keys(step);
  const moved = await state();
  assert.equal(
    moved.index,
    start.index + (forward ? 1 : -1),
    `${label}: ${forward ? "ArrowDown" : "ArrowUp"} did not move focus one item in ${group}`,
  );
  assert.equal(moved.tabStops, 1, `${label}: ${group} left more than one Tab stop after an arrow move`);
  assert(moved.name.length > 0, `${label}: the ${group} item reached by arrow key has no accessible name`);

  await browser.keys(back);
  const returned = await state();
  assert.equal(returned.index, start.index, `${label}: the reverse arrow did not return to the original item`);
  assert.equal(returned.tabStops, 1, `${label}: ${group} left more than one Tab stop after the reverse arrow`);

  // The item that was moved to is unfocused again, so its resting style can be
  // read and compared with the style it had while focused.
  const resting = await browser.execute(({ groupSel, itemSel, index }) => {
    const root = document.querySelector(groupSel);
    if (!root) return null;
    const items = window.__comndSmoke.groupItems(root, itemSel);
    return items[index] ? window.__comndSmoke.focusStyle(items[index]) : null;
  }, { groupSel: group, itemSel: item, index: moved.index });
  assertFocusVisible({ ...moved.focus, resting }, `${label}: arrow move`);
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

/**
 * Tab and Shift+Tab must never leave the open modal panel: the walk has to
 * visit every focusable control exactly once, wrap at both ends, keep a
 * visible focus indicator on each stop, and the dialog itself must be named.
 */
async function assertModalTrap(browser, panelSelector, label, { expectedControls } = {}) {
  await installSmokeHelpers(browser);
  const inspect = (selector) => browser.execute((sel) => {
    const panel = document.querySelector(sel);
    const el = document.activeElement;
    if (el && panel && panel.contains(el) && !el.hasAttribute("data-comnd-stop")) {
      const seq = (window.__comndSmokeStopSeq ?? 0) + 1;
      window.__comndSmokeStopSeq = seq;
      el.setAttribute("data-comnd-stop", String(seq));
    }
    return {
      inside: !!panel && panel.contains(el),
      active: window.__comndSmoke.active(),
      name: panel ? window.__comndSmoke.authorName(panel) : "",
      focus: window.__comndSmoke.focusStyle(el),
      styleKey: el?.getAttribute?.("data-comnd-stop") ?? "",
      lastKey: window.__comndSmoke.lastKey(),
      // The controls the trap itself can wrap to, counted the same way.
      focusableCount: panel
        ? [...panel.querySelectorAll(
          "a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),"
          + "textarea:not([disabled]),[tabindex]:not([tabindex='-1'])",
        )].filter((element) => {
          // A radio group is a single tab stop: its checked button, else its first.
          if (element.type === "radio" && element.name) {
            const group = [...panel.querySelectorAll(
              `input[type="radio"][name="${CSS.escape(element.name)}"]`,
            )];
            if ((group.find((radio) => radio.checked) ?? group[0]) !== element) return false;
          }
          return !element.hasAttribute("disabled")
            && element.tabIndex >= 0
            && !element.hidden
            && !element.closest(".auth-conditional-hidden")
            && element.getClientRects().length > 0;
        }).length
        : 0,
    };
  }, selector);

  const describeActive = (active) => `${active.tag}${active.id ? `#${active.id}` : ""}`
    + `${active.cls ? `.${active.cls.trim().split(/\s+/).slice(0, 3).join(".")}` : ""}`;
  // A driver does not always report the modifier it acted with, so a trapped
  // escape and a driver quirk look alike; the key state goes in the message.
  const keyHint = (lastKey) => (lastKey
    ? ` (last keydown ${JSON.stringify(lastKey.key)}, shiftKey ${lastKey.shiftKey})`
    : "");

  const forward = [];
  for (let step = 0; step < 12; step += 1) {
    await browser.keys("\uE004");
    const state = await readWithRingRetry(browser, () => inspect(panelSelector), {
      isStop: (stop) => stop.inside,
      styleOf: (stop) => stop.focus,
    });
    assert(
      state.inside,
      `${label}: Tab moved focus out of the dialog to ${describeActive(state.active)}`
      + keyHint(state.lastKey),
    );
    forward.push(state);
    if (forward.length > 1 && forward[0].styleKey === state.styleKey) break;
  }

  const wrapped = forward.length > 1 && forward[0].styleKey === forward.at(-1).styleKey;
  const cycle = wrapped ? forward.slice(0, -1) : forward;
  assert(
    wrapped,
    `${label}: 12 Tab presses did not return focus to ${describeActive(forward[0].active)}, `
    + `so the forward wrap is unproven (stops: ${JSON.stringify(cycle.map((s) => describeActive(s.active)))})`,
  );
  assert(
    cycle.length === forward[0].focusableCount,
    `${label}: the trap cycled through ${cycle.length} control(s) but the dialog exposes `
    + `${forward[0].focusableCount}, so a control is unreachable or repeated `
    + `(stops: ${JSON.stringify(cycle.map((s) => describeActive(s.active)))})`,
  );
  if (expectedControls) {
    // Class order in the markup is not the point, so compare sorted tokens.
    const sortClasses = (description) => {
      const [tagAndId, ...classes] = description.split(".");
      return [tagAndId, ...classes.sort()].join(".");
    };
    const seen = cycle.map((state) => sortClasses(describeActive(state.active))).sort();
    assert.deepEqual(
      seen,
      expectedControls.map(sortClasses).sort(),
      `${label}: the dialog's tab stops are not the expected set`,
    );
  }
  for (const state of cycle) {
    assert(
      state.active.name.length > 0,
      `${label}: ${describeActive(state.active)} is a tab stop inside the dialog `
      + `with no accessible name`,
    );
  }

  // A full backwards cycle from the first control has to land back on it,
  // visiting only controls the forward walk saw.
  const cycleKeys = new Set(cycle.map((state) => state.styleKey));
  for (let step = 0; step < cycle.length; step += 1) {
    await browser.keys(["\uE008", "\uE004", "\uE000"]);
    const state = await inspect(panelSelector);
    assert(
      state.inside,
      `${label}: Shift+Tab moved focus out of the dialog to ${describeActive(state.active)}`
      + keyHint(state.lastKey),
    );
    assert(
      cycleKeys.has(state.styleKey),
      `${label}: Shift+Tab reached ${describeActive(state.active)}, which the forward walk `
      + `never visited`,
    );
  }
  const backAtStart = await inspect(panelSelector);
  assert(
    backAtStart.styleKey === cycle[0].styleKey,
    `${label}: ${cycle.length} Shift+Tab presses from ${describeActive(cycle[0].active)} ended on `
    + `${describeActive(backAtStart.active)}, so the backwards wrap is broken`,
  );

  // Read the stops again while nothing is focused, so a permanently drawn
  // border or shadow cannot pass for a focus indicator.
  const resting = await browser.execute((sel) => {
    const panel = document.querySelector(sel);
    if (!panel) return {};
    const restore = panel.getAttribute("tabindex");
    panel.setAttribute("tabindex", "-1");
    panel.focus();
    const out = {};
    for (const el of panel.querySelectorAll("[data-comnd-stop]")) {
      out[el.getAttribute("data-comnd-stop")] = window.__comndSmoke.focusStyle(el);
      el.removeAttribute("data-comnd-stop");
    }
    if (restore === null) panel.removeAttribute("tabindex");
    else panel.setAttribute("tabindex", restore);
    return out;
  }, panelSelector);
  for (const state of cycle) {
    assertFocusVisible({
      ...state.active,
      ...state.focus,
      resting: resting[state.styleKey] ?? null,
      ringRetry: state.ringRetry,
    }, label);
  }

  const named = await inspect(panelSelector);
  assert(
    named.name.length > 0,
    `${label}: the dialog panel has no author-provided name `
    + `(neither aria-labelledby nor aria-label)`,
  );
  return cycle.map((state) => state.active.name);
}

/** Escape through a real W3C key action: the modal shell listens on window capture. */
async function pressEscape(browser) {
  await browser.action("key").down("\uE00C").up("\uE00C").perform();
}

/** The PTY sizes the mock SSH host was asked for, oldest first. */
async function lastPtySizes(browser) {
  return Array.from(await invoke(browser, "test_smoke_pty_sizes"));
}

/**
 * The app's own view of its windows, from Rust. A window handle list cannot say
 * which window is which — the panel loads the same `index.html`, so both report
 * the same title and URL — while this reports the label, the physical rectangle
 * and visibility.
 */
async function panelWindows(browser) {
  return invoke(browser, "test_panel_windows");
}

/**
 * The one panel window, asserted single and visible.
 *
 * The WebDriver handle list shows a window as soon as it is *created*, while
 * `panel_open` builds it hidden and shows it only once its geometry is applied,
 * so the panel can still be invisible when this is first asked. Poll rather than
 * read once — the same race would otherwise fail a whole run at random.
 */
async function singlePanelWindow(browser, behavior) {
  const deadline = Date.now() + WAIT_MS;
  let windows = await panelWindows(browser);
  for (;;) {
    const panels = windows.filter((entry) => entry.label === "panel");
    if (panels.length === 1 && panels[0].visible) return panels[0];
    if (Date.now() > deadline) break;
    await pause(100);
    windows = await panelWindows(browser);
  }
  const labels = windows.map((entry) => entry.label).join(", ");
  const panels = windows.filter((entry) => entry.label === "panel");
  assert.equal(
    panels.length,
    1,
    `${behavior}: expected exactly one panel window, found ${panels.length} (windows: ${labels})`,
  );
  assert(
    panels[0].visible,
    `${behavior}: the panel window exists but is not visible (windows: ${labels})`,
  );
  return panels[0];
}

/**
 * Ctrl+Shift+B, the panel's tri-state shortcut (open / undock / dock).
 *
 * The terminal and the panel window both bind it, so it reaches the right
 * handler whichever of the two windows takes the chord. Focus goes to the
 * terminal's helper textarea first when this window has one, so the keystroke
 * travels the terminal's real key path rather than a synthetic event.
 */
async function panelShortcut(browser) {
  await browser.execute(() => document.querySelector(".xterm-helper-textarea")?.focus());
  await browser.keys(["\uE009", "\uE008", "b", "\uE000"]);
}

/**
 * Issue #176: quit while undocked, relaunch, and the panel must stay closed —
 * no docked panel and no panel window — while one keyboard open puts it back in
 * its own window at the geometry the user left it at.
 *
 * Two app processes against one data directory is the only honest proof: an
 * in-process reload keeps the config cache and the window alive. The first
 * launch reports what it persisted into `saved`, so the second asserts against
 * the stored value, not against the rectangle the scenario asked for.
 */
function panelUndockRelaunchScenario() {
  let saved = null;
  return {
    name: "panel-undock-relaunch",
    phases: [
      async (browser, dataDir) => {
        await installSmokeHelpers(browser);
        await launchAndConnect(browser, dataDir);

        await panelShortcut(browser);
        await waitFor(browser, () => {
          const panel = document.querySelector("#tv-sidebar");
          return !!panel && panel.getClientRects().length > 0
            && !panel.classList.contains("hidden");
        }, "Panel relaunch: the shortcut did not open the panel");
        await panelShortcut(browser);
        await waitForWindowCount(browser, 2,
          "Panel relaunch: undocking did not put the panel in its own window");
        await singlePanelWindow(browser, "Panel relaunch");

        // Park the panel at a known on-screen rectangle, so the restored
        // position is the user's rather than wherever the default landed.
        const main = (await panelWindows(browser)).find((entry) => entry.label === "main");
        assert(main, "Panel relaunch: the main window is missing from the window list");
        const requested = { x: main.x + 48, y: main.y + 48, width: 560, height: 460 };
        await invoke(browser, "test_panel_set_geometry", requested);
        const placed = await singlePanelWindow(browser, "Panel relaunch (placed)");
        for (const key of ["width", "height"]) {
          assert(
            Math.abs(placed[key] - requested[key]) <= 2,
            `Panel relaunch: the panel window did not take the requested ${key} `
              + `(${placed[key]}, expected ${requested[key]})`,
          );
        }
        // `test_panel_set_geometry` only moves the window; the production
        // Moved/Resized tracker is what saves. Waiting for the saved rectangle to
        // match the live one is the assertion that a real drag would also
        // survive, rather than the debug command writing the value itself.
        const persisted = async () => {
          const config = await invoke(browser, "panel_get_state");
          return config.window;
        };
        let stored = null;
        try {
          await browser.waitUntil(async () => {
            stored = await persisted();
            return !!stored
              && ["x", "y", "width", "height"]
                .every((key) => Math.abs(stored[key] - placed[key]) <= 2);
          }, {
            timeout: WAIT_MS,
            interval: 100,
            timeoutMsg: "Panel relaunch: the production geometry tracker never saved the live rectangle",
          });
        } catch (error) {
          throw new Error(
            `${error.message} (saved ${JSON.stringify(stored)}, live ${JSON.stringify(placed)})`,
          );
        }
        const config = await invoke(browser, "panel_get_state");
        assert.equal(config.undocked, true,
          "Panel relaunch: the undocked home was not written to the config");
        saved = config.window;

        // Two closes racing while the debounce worker is paused inside a write.
        // The command moves the window twice, so the paused write holds a stale
        // rectangle: the close paths must save the live one, not that stale one.
        const raced = await invoke(browser, "test_panel_race_close");
        for (const key of ["x", "y", "width", "height"]) {
          assert(
            Math.abs(raced.saved[key] - raced.live[key]) <= 2,
            `Panel relaunch: a racing close saved ${key} ${raced.saved[key]}, `
              + `expected the live ${raced.live[key]}`,
          );
        }
        assert(
          Math.abs(raced.saved.x - raced.stale.x) > 20,
          `Panel relaunch: the paused stale write won `
            + `(saved x ${raced.saved.x}, stale x ${raced.stale.x})`,
        );
        await waitForNoWindow(browser, "panel",
          "Panel relaunch: the racing close left the panel window open");
        await waitForWindowCount(browser, 1,
          "Panel relaunch: the racing close left an extra window behind");
        // Assert the relaunch against what the close paths actually left behind.
        saved = (await invoke(browser, "panel_get_state")).window;
      },
      async (browser, dataDir) => {
        assert(saved, "Panel relaunch: the first launch never recorded the panel geometry");

        // Launch two: the app was quit undocked, so nothing may open the panel.
        const handles = await windowHandles(browser);
        assert.equal(
          handles.length,
          1,
          `Panel relaunch: launch opened ${handles.length} windows; the panel must never open itself`,
        );
        await waitFor(browser, () => {
          const panel = document.querySelector("#tv-sidebar");
          return !panel || panel.getClientRects().length === 0
            || panel.classList.contains("hidden");
        }, "Panel relaunch: the docked panel was open at launch");
        const config = await invoke(browser, "panel_get_state");
        assert.equal(config.undocked, true,
          "Panel relaunch: the undocked home was lost across the relaunch");

        await installSmokeHelpers(browser);
        await launchAndConnect(browser, dataDir);
        assert.equal((await windowHandles(browser)).length, 1,
          "Panel relaunch: connecting opened a panel window");

        // One keyboard open, and the panel is back undocked where it was left.
        await panelShortcut(browser);
        await waitForWindowCount(browser, 2,
          "Panel relaunch: opening the panel did not restore its window");
        const restored = await singlePanelWindow(browser, "Panel relaunch (restored)");
        for (const key of ["x", "y", "width", "height"]) {
          assert(
            Math.abs(restored[key] - saved[key]) <= 2,
            `Panel relaunch: the restored ${key} is ${restored[key]}, `
              + `expected ${saved[key]} (the saved geometry)`,
          );
        }
      },
    ],
  };
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

/**
 * Start both in-process mocks and sync the one `device-tab` NetBox fixture,
 * whose primary IP is loopback so the SSH mock can accept the connection. Its
 * source defaults point at the SSH mock's ephemeral port and at the mock secret
 * provider, so the materialized host is a real NetBox-sourced host that a user
 * can open.
 */
async function installNetboxTabHost(browser) {
  const baseUrl = await invoke(browser, "test_netbox_server");
  const sshPort = await invoke(browser, "test_smoke_server", {
    rejectAuth: false,
    muteOutput: false,
  });
  await invoke(browser, "test_netbox_set_scenario", { scenario: "device-tab" });
  await invoke(browser, "netbox_save_config", {
    config: {
      enabled: true,
      show_empty_folders: false,
      base_url: baseUrl,
      filters: { status: null, sites: [], roles: [], tags: [] },
      platform_policy: "skip",
      platform_fallback: null,
      platform_overrides: {},
      default_username: "smoke",
      default_port: sshPort,
      default_credential: {
        type: "secret_ref",
        provider: "mock",
        reference: "smoke",
        label: "Smoke test secret",
      },
      allow_invalid_certs: false,
    },
    defaultPassword: null,
  });
  const report = await invoke(browser, "netbox_sync");
  assert.equal(
    report.fetched,
    1,
    `NetBox tab: expected one synced device, got ${JSON.stringify(report)}`,
  );
  await invoke(browser, "touch_host", { id: "netbox:201" });
  return { baseUrl, sshPort };
}

async function connectNetboxTabHost(browser) {
  const selector = `.hs-host-item[data-host-id="netbox:201"]`;
  await actOn(browser, selector);
  await actOn(browser, selector, { action: "dblclick" });
  await acceptHostKeyIfNeeded(browser);
  await waitForConnection(browser);
}

/**
 * Open the docked panel, prove the icon-only strip is keyboard reachable, named
 * and at the top right, then select the NetBox tab and assert the live summary.
 * Runs first in `keyboard-focus`, so `--mutation=focus` fails on this assertion
 * and proves it still catches a removed focus ring.
 */
async function assertNetboxDeviceTab(browser) {
  await browser.execute(() => document.querySelector(".tv-panel-btn")?.focus());
  await browser.keys("\uE007");
  await browser.waitUntil(
    async () => browser.execute(() => {
      const panel = document.querySelector("#tv-sidebar");
      return !!panel && panel.getClientRects().length > 0 && !panel.classList.contains("hidden");
    }),
    { timeout: WAIT_MS, interval: 100, timeoutMsg: "NetBox tab: the side panel did not open" },
  );

  const netboxTab = await browser.execute(() => {
    const tab = document.querySelector(".sb-toggle-netbox");
    return tab ? { hidden: tab.hidden, label: tab.getAttribute("aria-label") } : null;
  });
  assert(netboxTab && !netboxTab.hidden,
    "NetBox tab: a NetBox-sourced host did not expose the tab");
  assert.equal(netboxTab.label, "NetBox device details");

  for (const selector of [".sb-toggle-kb", ".sb-toggle-replay", ".sb-toggle-netbox"]) {
    await assertScriptFocusStop(browser, selector, "Keyboard focus: panel tabs");
  }

  const placement = await browser.execute(() => {
    const strip = document.querySelector(".sb-toggle");
    const content = document.querySelector(".sb-content");
    if (!strip || !content) return null;
    const s = strip.getBoundingClientRect();
    const c = content.getBoundingClientRect();
    const visible = [...strip.children].filter((element) => element.getClientRects().length > 0);
    const last = visible[visible.length - 1];
    if (!last) return null;
    return {
      contentRight: s.right - parseFloat(getComputedStyle(strip).paddingRight),
      lastRight: last.getBoundingClientRect().right,
      stripBottom: s.bottom,
      contentTop: c.top,
    };
  });
  assert(placement, "Keyboard focus: the panel tab strip was never rendered");
  assert(
    Math.abs(placement.lastRight - placement.contentRight) <= 1,
    `Keyboard focus: the icon tabs are not right-aligned in the panel `
      + `(last control ends at ${placement.lastRight}, strip content ends at ${placement.contentRight})`,
  );
  assert(
    placement.stripBottom <= placement.contentTop + 1,
    "Keyboard focus: the tab strip is not above the panel content",
  );

  await actOn(browser, ".sb-toggle-netbox");
  await browser.waitUntil(
    async () => browser.execute(() => {
      const name = document.querySelector(".nbd-name")?.textContent ?? "";
      return name === "tab-device" && document.querySelectorAll(".nbd-iface").length === 2;
    }),
    { timeout: WAIT_MS, interval: 100, timeoutMsg: "NetBox tab: the device summary did not render" },
  );

  const details = await browser.execute(() => ({
    text: document.querySelector(".sb-content")?.textContent ?? "",
    status: document.querySelector(".nbd-status")?.textContent ?? "",
    groups: [...document.querySelectorAll(".nbd-iface")].map((group) => ({
      name: group.querySelector(".nbd-iface-name")?.textContent ?? "",
      addresses: [...group.querySelectorAll(".nbd-address")].map((address) => ({
        text: (address.firstChild?.textContent ?? "").trim(),
        vrf: address.querySelector(".nbd-vrf")?.textContent ?? null,
      })),
    })),
  }));
  assert.equal(details.status, "Active");
  for (const expected of ["Cisco C9300-48P", "DC1 London", "Rack 1", "rack-1 · U12.5 · front"]) {
    assert(
      details.text.includes(expected),
      `NetBox tab: the summary is missing ${JSON.stringify(expected)}`,
    );
  }
  assert.deepEqual(
    details.groups.map((group) => group.name),
    ["GigabitEthernet1/0/1", "TenGigabitEthernet1/1/1"],
  );
  assert.deepEqual(
    details.groups[0].addresses.map((address) => address.text),
    ["10.0.0.10/24", "10.0.0.11/24"],
  );
  assert.deepEqual(details.groups[1].addresses, [
    { text: "2001:db8::10/64", vrf: "blue" },
  ]);
  assert(
    !details.text.includes("192.0.2.1/24"),
    "NetBox tab: a virtual-chassis sibling's address leaked into this device",
  );
}

async function openSettings(browser) {
  await actOn(browser, "#title-bar-settings");
  // Poll: `$(".settings-nav-item")` matches eight rows, so strict mode fails.
  await browser.waitUntil(
    async () => browser.execute(() => !!document.querySelector(".settings-nav-item")),
    { timeout: WAIT_MS, interval: 100, timeoutMsg: "Settings: the settings screen did not open" },
  );
}

async function openSettingsItem(browser, itemId) {
  // The item's async load re-renders the whole nav, so the click must not hold
  // a handle taken before that render (issue #126).
  await actOn(browser, `.settings-nav-item[data-item-id="${itemId}"]`);
}

/** Expand a collapsible nav section (Knowledge Base, Replay) if it is closed. */
async function openNavSection(browser, section) {
  const selector = `.nav-section-header[data-section="${section}"]`;
  // Safe: one awaited wait, never acted on and never re-queried.
  await (await browser.$(selector)).waitForExist({ timeout: WAIT_MS });
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
async function expandNavGroup(browser, groupId) {
  const selector = `.nav-group-row[data-group-id="${groupId}"]`;
  // Safe: one awaited wait, never acted on and never re-queried.
  await (await browser.$(selector)).waitForExist({ timeout: WAIT_MS });
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

/** Resize the app window; the driver names this differently across versions. */
async function resizeWindow(browser, width, height) {
  if (typeof browser.setWindowRect === "function") {
    await browser.setWindowRect(0, 0, width, height);
  } else {
    await browser.setWindowSize(width, height);
  }
  // The resize reaches the page asynchronously, and a loaded xvfb runner can lag
  // it by seconds. Callers assert the new size immediately afterwards, so wait
  // for the page to report it rather than reading the old size and flaking.
  const deadline = Date.now() + WAIT_MS;
  let size = { width: 0, height: 0 };
  for (;;) {
    size = await browser.execute(() => ({ width: window.innerWidth, height: window.innerHeight }));
    if (size.width <= width + 40 && size.height <= height + 40) return;
    if (Date.now() > deadline) break;
    await pause(100);
  }
  throw new Error(
    `resizeWindow: the window never reached ${width}x${height} `
      + `(it reports ${size.width}x${size.height})`,
  );
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
  // The pane's async load re-renders the whole screen, so this wait must not
  // hold a node handle across that render (issue #126).
  await browser.waitUntil(
    async () => browser.execute(() => !!document.querySelector("#netbox-enabled")),
    {
      timeout: WAIT_MS,
      interval: 100,
      timeoutMsg: "NetBox: the settings pane never rendered the enable switch",
    },
  );
  await actOn(browser, "#netbox-enabled");
  await browser.waitUntil(
    async () => (await invoke(browser, "netbox_get_config")).config.enabled === true,
    { timeout: WAIT_MS, interval: 200, timeoutMsg: "NetBox: the enable switch never persisted" },
  );
  await pause(200);
  await setField(browser, "#netbox-url", baseUrl);
  await setField(browser, "#netbox-token", "smoke-legacy-token");
  await actOn(browser, "#netbox-test-btn");
  await browser.waitUntil(async () => {
    const status = await browser.execute(() =>
      document.querySelector("#netbox-test-status")?.textContent?.trim() ?? "");
    return status.startsWith("Connected");
  }, { timeout: WAIT_MS, interval: 100, timeoutMsg: "NetBox: Test Connection never reported Connected" });
  await actOn(browser, "#netbox-token-save");
  await waitForToast(browser, /^Connection saved$/, "NetBox");
  await clearToasts(browser);
  return baseUrl;
}

async function syncNetbox(browser, pattern) {
  await clearToasts(browser);
  await actOn(browser, "#netbox-sync-btn");
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
  // Selecting the row re-renders the list, so click through actOn rather than
  // holding a handle across that render.
  await actOn(browser, selector);
  // Safe: one awaited read per poll; no handle outlives the predicate.
  await browser.waitUntil(async () => (await browser.$(selector).getAttribute("aria-selected")) === "true", {
    timeout: 5_000,
    interval: 100,
    timeoutMsg: "Known smoke-test host was not selected",
  });
  await actOn(browser, selector, { action: "dblclick" });
  await acceptHostKeyIfNeeded(browser);
  return host;
}

async function waitForConnection(browser) {
  await browser.waitUntil(async () => {
    // Safe: one awaited read per poll; no handle outlives the predicate.
    const classes = await (await browser.$(".tv-sb-dot")).getAttribute("class");
    return classes?.includes("sb-connected") ?? false;
  }, {
    timeout: 20_000,
    interval: 100,
    timeoutMsg: "SSH connection did not reach the connected state",
  });
  await waitForTerminal(browser, "user@host:~$");
}

/**
 * Wait for the *active* session to connect, accepting its host key. The
 * global helper above is single-session (its `.tv-sb-dot` lookup is strict),
 * and "any connected dot" would pass on a session left running in the
 * background. Only the wrapper that is not `display: none` is the active one.
 */
async function waitForActiveConnection(browser, label) {
  await browser.waitUntil(async () =>
    browser.execute(() => {
      // The host-key confirmation is a document-level modal.
      const accept = [...document.querySelectorAll("button")]
        .find((button) => button.textContent?.trim() === "Accept and save");
      if (accept) {
        accept.click();
        return false;
      }
      const wrapper = [...document.querySelectorAll(".session-tab-wrapper")]
        .find((element) => element.style.display !== "none");
      const dot = wrapper?.querySelector(".tv-sb-dot");
      return dot?.classList.contains("sb-connected") ?? false;
    }), {
    timeout: 20_000,
    interval: 100,
    timeoutMsg: `${label}: the active session did not reach the connected state`,
  });
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

// Suggestions are off until the toolbar toggle is pressed, and the session
// view is rebuilt under it, so act through actOn and read the state with one
// execute per poll instead of holding a handle.
async function enableSuggestions(browser) {
  const pressed = await browser.execute(() =>
    document.querySelector(".tv-suggestions-btn")?.getAttribute("aria-pressed") ?? null,
  );
  if (pressed !== "true") await actOn(browser, ".tv-suggestions-btn");
  await waitFor(
    browser,
    () => document.querySelector(".tv-suggestions-btn")?.getAttribute("aria-pressed") === "true",
    "Suggestions: the toolbar toggle never reported pressed",
  );
}

/** Wait until the ghost shows exactly `text` in a box the user can actually see. */
async function waitForGhost(browser, text, behavior) {
  await browser.waitUntil(async () => browser.execute((expected) => {
    const ghost = document.querySelector(".ghost-text");
    if (!ghost || ghost.textContent !== expected) return false;
    // `display` alone accepts a hidden ghost: `visibility: hidden` and a
    // collapsed box both leave the text unreadable on screen.
    const style = getComputedStyle(ghost);
    const rect = ghost.getBoundingClientRect();
    return style.display !== "none"
      && style.visibility === "visible"
      && ghost.getClientRects().length > 0
      && rect.width > 0
      && rect.height > 0;
  }, text), {
    timeout: WAIT_MS,
    interval: 100,
    timeoutMsg: `${behavior}: expected the ghost to show '${text}'`,
  });
}

/**
 * What sits at the centre of `selector`, read in one execute. `elementFromPoint`
 * returns null for a point off screen, so those report `found: false` rather
 * than a hit that was never sampled. `index` picks among several matches, which
 * the side panel needs because it renders one copy button per example.
 */
async function hitTestCentre(browser, selector, index = 0) {
  return browser.execute((sel, at) => {
    const el = document.querySelectorAll(sel)[at];
    if (!el) return { missing: true };
    const name = (node) => (node
      ? `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ""}`
      : "nothing");
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const onScreen = x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight;
    const hit = onScreen ? document.elementFromPoint(x, y) : null;
    return {
      missing: false,
      point: `${Math.round(x)},${Math.round(y)}`,
      onScreen,
      found: !!hit,
      self: !!hit && (hit === el || el.contains(hit)),
      hit: name(hit),
    };
  }, selector, index);
}

/**
 * One control's box and hit test at the window size the app opens with. `label`
 * names the owning scenario's assertion so a failure says which screen broke,
 * and `index` selects among several matches. The box must sit inside the window
 * and its centre must hit the control itself, which catches an element that is
 * on screen but covered by a sibling.
 *
 * `scroll` brings the control into view first, for a panel that scrolls by
 * design: the terminal side panel is `overflow-y: auto`, so a long entry puts
 * its last controls below the fold until the user scrolls. Only that vertical
 * scroll survives: `overflow-y: auto` makes the panel scroll horizontally too,
 * so `scrollIntoView` could pull a control that really overflows back into the
 * window and hide the regression it is meant to catch. Every ancestor's
 * horizontal offset is therefore restored before the box is read, and the
 * scroll and the measurement share one execute so the box always describes the
 * layout the assertions are about.
 */
async function assertControlInWindow(browser, selector, index, label, { scroll = false } = {}) {
  const name = selector.startsWith("#") ? selector : `${selector}[${index}]`;
  const box = await browser.execute((sel, at, bring) => {
    const el = document.querySelectorAll(sel)[at];
    if (!el) return null;
    if (bring) {
      const ancestors = [];
      for (let node = el.parentElement; node; node = node.parentElement) {
        ancestors.push([node, node.scrollLeft]);
      }
      el.scrollIntoView({ block: "nearest", inline: "nearest" });
      for (const [node, left] of ancestors) node.scrollLeft = left;
    }
    const r = el.getBoundingClientRect();
    return {
      left: r.left,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
      width: window.innerWidth,
      height: window.innerHeight,
    };
  }, selector, index, scroll);
  assert(box, `${label}: ${name} was never rendered`);
  assert(
    box.left >= 0 && box.top >= 0 && box.right <= box.width && box.bottom <= box.height,
    `${label}: ${name} is outside the window `
      + `(left ${Math.round(box.left)}, top ${Math.round(box.top)}, `
      + `right ${Math.round(box.right)}, bottom ${Math.round(box.bottom)}, `
      + `window ${box.width}x${box.height})`,
  );
  const hit = await hitTestCentre(browser, selector, index);
  assert(!hit.missing, `${label}: ${name} disappeared after its box was measured`);
  assert(
    hit.onScreen && hit.found && hit.self,
    `${label}: ${name} is not hit-testable at its centre `
      + `(point ${hit.point}, onScreen=${hit.onScreen}, found=${hit.found}, `
      + `self=${hit.self}, hit ${hit.hit})`,
  );
}

/**
 * The visible ghost's geometry, read in a single execute so the numbers cannot
 * come from two different renders. `expectedLeft` applies the placement formula
 * under test (`GhostText.positionAtCursor`): the left edge of `.xterm-screen`
 * plus one cell per column the cursor has advanced. Returns null when the ghost
 * has no box a user could see, so the caller's assertion fails rather than
 * measuring an invisible overlay.
 */
async function measureGhost(browser) {
  return browser.execute(() => {
    const ghost = document.querySelector(".ghost-text");
    const screen = document.querySelector(".xterm-screen");
    const term = window.__comndTerminal;
    const cols = term?.cols ?? 0;
    if (!ghost || !screen || !cols || !term) return null;
    const ghostRect = ghost.getBoundingClientRect();
    const ghostStyle = getComputedStyle(ghost);
    if (ghostStyle.display === "none"
      || ghostStyle.visibility !== "visible"
      || ghost.getClientRects().length === 0
      || ghostRect.width === 0
      || ghostRect.height === 0) return null;
    const rect = screen.getBoundingClientRect();
    const cellWidth = rect.width / cols;
    const cursorX = term.buffer.active.cursorX;
    return {
      left: ghost.getBoundingClientRect().left,
      cellWidth,
      cursorX,
      expectedLeft: rect.left + cursorX * cellWidth,
    };
  });
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
        await enableSuggestions(browser);
        await sendKeys(browser, "ip r");
        await waitForGhost(browser, "oute", "Suggestion accept");
        // Suggestions auto-open the dropdown, so both overlays are on screen and
        // both hit-tests run here rather than in a scenario of their own.
        const overlays = await browser.execute(() => {
          // A visible overlay means a box the user can see, not merely a
          // non-`none` display: `visibility: hidden` and a collapsed box both
          // leave nothing on screen while the text and geometry still read.
          const visible = (el) => {
            if (!el) return false;
            const style = getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return style.display !== "none"
              && style.visibility === "visible"
              && el.getClientRects().length > 0
              && rect.width > 0
              && rect.height > 0;
          };
          const name = (el) => el
            ? `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}`
            : "nothing";
          const ghost = document.querySelector(".ghost-text");
          const dropdown = document.querySelector(".suggestion-dropdown");
          if (!visible(ghost) || !visible(dropdown)) {
            return { ghostUp: visible(ghost), dropdownUp: visible(dropdown) };
          }
          // Centre point, whether that point is on screen at all, and what sits
          // there. Outside the viewport elementFromPoint returns null, which
          // would otherwise read as "the overlay did not swallow the click" and
          // pass a test that never actually sampled the overlay.
          const probe = (el) => {
            const r = el.getBoundingClientRect();
            const x = r.left + r.width / 2;
            const y = r.top + r.height / 2;
            const onScreen = x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight;
            const hit = onScreen ? document.elementFromPoint(x, y) : null;
            return {
              point: `${Math.round(x)},${Math.round(y)}`,
              onScreen,
              found: !!hit,
              hit: name(hit),
              holds: !!hit && (hit === el || el.contains(hit)),
            };
          };
          const ghostProbe = probe(ghost);
          const dropdownProbe = probe(dropdown);
          return { ghostUp: true, dropdownUp: true, ghostProbe, dropdownProbe };
        });
        assert(overlays.ghostUp && overlays.dropdownUp,
          "Suggestion accept: expected both the ghost and the dropdown to be visible for 'ip r'");
        const { ghostProbe, dropdownProbe } = overlays;
        assert(ghostProbe.onScreen && ghostProbe.found,
          `Suggestion accept: could not sample the ghost at ${ghostProbe.point} `
          + `(on screen: ${ghostProbe.onScreen}, hit ${ghostProbe.hit})`);
        assert(!ghostProbe.holds,
          `Suggestion accept: the ghost is not click-through at its centre `
          + `(hit ${ghostProbe.hit} at ${ghostProbe.point})`);
        assert(dropdownProbe.onScreen && dropdownProbe.found,
          `Suggestion accept: could not sample the dropdown at ${dropdownProbe.point} `
          + `(on screen: ${dropdownProbe.onScreen}, hit ${dropdownProbe.hit})`);
        assert(dropdownProbe.holds,
          `Suggestion accept: nothing clickable at the dropdown centre `
          + `(hit ${dropdownProbe.hit} at ${dropdownProbe.point})`);
        // The ghost is anchored to the cursor cell, so its absolute left edge is
        // the screen's left edge plus one cell per cursor column. Checking only
        // the shift below would pass a ghost parked a cell behind the cursor,
        // since that one moves by a cell too.
        const anchor = await measureGhost(browser);
        assert(anchor,
          "Suggestion accept: could not measure the ghost before typing 'o' "
          + "(missing, hidden, or without a non-empty box)");
        const anchorOff = anchor.left - anchor.expectedLeft;
        assert(Math.abs(anchorOff) <= 1,
          `Suggestion accept: the ghost starts ${(anchorOff / anchor.cellWidth).toFixed(2)} cells `
          + `from the cursor cell at column ${anchor.cursorX} `
          + `(${anchor.cellWidth.toFixed(1)}px per cell)`);
        // One more character must move the ghost exactly one cell right. A
        // one-render-stale anchor leaves the remainder sitting over the
        // character it is meant to continue.
        await sendKeys(browser, "o");
        await waitForGhost(browser, "ute", "Suggestion accept");
        const shifted = await measureGhost(browser);
        assert(shifted,
          "Suggestion accept: could not measure the ghost after typing 'o' "
          + "(missing, hidden, or without a non-empty box)");
        const cells = (shifted.left - anchor.left) / shifted.cellWidth;
        assert(Math.abs(cells - 1) <= 1 / shifted.cellWidth,
          `Suggestion accept: the ghost moved ${cells.toFixed(2)} cells `
          + `(${shifted.cellWidth.toFixed(1)}px per cell) for one character`);
        const shiftedOff = shifted.left - shifted.expectedLeft;
        assert(Math.abs(shiftedOff) <= 1,
          `Suggestion accept: the ghost ended ${(shiftedOff / shifted.cellWidth).toFixed(2)} cells `
          + `from the cursor cell at column ${shifted.cursorX}`);
        await sendKeys(browser, "\uE004");
        await sendKeys(browser, "\uE007");
        const expected = [...Buffer.from("ip route\r")];
        const actual = await waitForBytes(browser, expected.length, "Suggestion accept");
        assertBytes(actual, expected, "Suggestion accept: only the completion remainder was sent");
        await waitForTerminal(browser, "ip route");
        const seen = countOccurrences(await terminalText(browser), "ip route");
        assert.equal(seen, 1,
          `Suggestion accept: expected 'ip route' in the terminal exactly once, saw ${seen}`);
      },
    },
    {
      name: "prefix-suggestion",
      async run(browser, dataDir) {
        await launchAndConnect(browser, dataDir);
        await enableSuggestions(browser);
        // The engine strips the `sudo` prefix and matches `system` against the
        // inner command, ghosting its remainder.
        await sendKeys(browser, "sudo system");
        await waitForGhost(browser, "ctl", "Prefix suggestion");
        await sendKeys(browser, "\uE004");
        await sendKeys(browser, "\uE007");
        const expected = [...Buffer.from("sudo systemctl\r")];
        const actual = await waitForBytes(browser, expected.length, "Prefix suggestion");
        assertBytes(actual, expected,
          "Prefix suggestion: expected 'sudo systemctl' and Enter at the mock");
        await waitForTerminal(browser, "sudo systemctl");
        const seen = countOccurrences(await terminalText(browser), "sudo systemctl");
        assert.equal(seen, 1,
          `Prefix suggestion: expected 'sudo systemctl' in the terminal exactly once, saw ${seen}`);
      },
    },
    {
      name: "dropdown-click",
      async run(browser, dataDir) {
        await launchAndConnect(browser, dataDir);
        await enableSuggestions(browser);
        // Seven bundled commands match a single `s`, ordered by name, so row 1
        // is `sed`; clicking it must send only the remainder after the typed
        // letter.
        await sendKeys(browser, "s");
        await waitFor(browser, () => document.querySelectorAll(".suggestion-item").length > 1,
          "Dropdown click: expected the dropdown to list at least two 's' commands");
        const rowName = await browser.execute(() =>
          document.querySelector('.suggestion-item[data-index="1"] .suggestion-name')?.textContent ?? null);
        assert.equal(rowName, "sed",
          `Dropdown click: row 1 is ${JSON.stringify(rowName)}, expected 'sed'`);
        // `actOn` dispatches a synthetic click, which a row the pointer cannot
        // reach (inside a clipped overlay, or under `pointer-events: none`)
        // would still accept. Hit-test the row's centre first so the click below
        // proves a pointer can get there.
        const reach = await hitTestCentre(browser, '.suggestion-item[data-index="1"]');
        assert(!reach.missing && reach.onScreen && reach.found && reach.self,
          reach.missing
            ? "Dropdown click: row 1 was gone before the pointer reachability check"
            : `Dropdown click: row 1 is not reachable by the pointer at ${reach.point} `
              + `(on screen: ${reach.onScreen}, hit ${reach.hit})`);
        await actOn(browser, '.suggestion-item[data-index="1"]', { action: "click" });
        await waitFor(browser, () => {
          const dropdown = document.querySelector(".suggestion-dropdown");
          return !dropdown || getComputedStyle(dropdown).display === "none";
        }, "Dropdown click: clicking row 1 left the dropdown open");
        await sendKeys(browser, "\uE007");
        const expected = [...Buffer.from("sed\r")];
        const actual = await waitForBytes(browser, expected.length, "Dropdown click");
        assertBytes(actual, expected, "Dropdown click: expected 'sed' and Enter at the mock");
        await waitForTerminal(browser, "sed");
        const seen = countOccurrences(await terminalText(browser), "sed");
        assert.equal(seen, 1,
          `Dropdown click: expected 'sed' in the terminal exactly once, saw ${seen}`);
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
        // Safe: one awaited read per poll, and the handle is never acted on.
        await browser.waitUntil(async () => (await browser.$(".tv-overlay-error")).isDisplayed(), {
          timeout: 20_000,
          interval: 100,
          timeoutMsg: "Rejected auth: failure recovery message did not appear",
        });
        // Safe: a single awaited read, never re-queried.
        const errorText = await (await browser.$(".tv-overlay-error")).getText();
        assert.match(
          errorText,
          /Authentication failed|Connection dropped during setup/i,
          "Rejected auth: expected a clear recovery error",
        );
        await actOn(browser, ".tv-overlay-back");
        await waitForSessionCleanup(browser, "Rejected auth");
        // Safe: a single awaited read, never re-queried.
        assert.equal(await (await browser.$(".tv-sb-dot")).isExisting(), false);
      },
    },
    {
      // The default mock persona is a Tailscale-style check-mode gateway: it
      // prints a login URL during authentication. A server-supplied URL is a
      // phishing surface, so the app must surface it and wait for a click.
      name: "browser-auth-url",
      async run(browser, dataDir) {
        await createAndConnect(browser, dataDir);
        await waitForConnection(browser);

        // Prove the browser-auth path actually ran, so the zero below is not
        // a vacuous pass on a host that never emitted a URL. The expected value
        // comes from the mock host itself, so the fixture has one definition
        // rather than a copy in this driver. Compare parsed URLs rather than
        // substrings: an exact match proves the app received the mock's URL,
        // not a longer URL that embeds it. Every emission site the connection
        // reaches records its own entry, so the count is not fixed; requiring
        // every recorded URL to match catches a single stale site, which a
        // "some URL matched" check would let through.
        const expected = new URL(await invoke(browser, "test_smoke_mock_auth_url")).href;
        const urls = await invoke(browser, "test_smoke_auth_urls");
        assert(
          urls.length > 0,
          `Auth URL: the mock host emitted no login URL (expected ${expected})`,
        );
        const mismatched = urls.filter((u) => {
          try {
            return new URL(u).href !== expected;
          } catch {
            return true;
          }
        });
        assert.deepStrictEqual(
          mismatched,
          [],
          `Auth URL: the mock host emitted a login URL that differs from its own fixture (expected ${expected}, mismatched ${JSON.stringify(mismatched)}, surfaced ${JSON.stringify(urls)})`,
        );

        // The recording above happens before the IPC emit, so on its own it
        // cannot prove the frontend rendered anything. Check the overlay the
        // URL is meant to drive: the stage text names the login step, and the
        // button exists for the user to click.
        const surface = await browser.execute(() => ({
          stage: document.querySelector(".tv-overlay-stage")?.textContent?.trim() ?? "",
          button: document.querySelector(".tv-overlay-actions .tv-open-auth")?.textContent?.trim() ?? "",
        }));
        assert.match(
          surface.stage,
          /Authentication required/i,
          `Auth URL: the auth overlay never showed the login prompt (stage: ${JSON.stringify(surface.stage)})`,
        );
        assert.equal(
          surface.button,
          "Open login page",
          "Auth URL: the auth overlay never rendered the login button",
        );

        const opened = await invoke(browser, "test_smoke_open_url_calls");
        assert.equal(
          opened,
          0,
          `Auth URL: the app opened the login URL without a user click (${opened} launch(es))`,
        );

        // Prove the counter tracks the real launch path, so the zero above
        // cannot be a dead seam: click the button the user would click. A DOM
        // click rather than a WebDriver one — the overlay is hidden once the
        // session connects.
        await browser.execute(() => document.querySelector(".tv-open-auth")?.click());
        // This wait proves only that a launch happened: a click that launches
        // twice satisfies it too, so exactness is judged by the count below.
        await browser.waitUntil(
          async () => (await invoke(browser, "test_smoke_open_url_calls")) >= 1,
          {
            timeout: 5_000,
            interval: 100,
            timeoutMsg: "Auth URL: clicking the login button did not register a launch",
          },
        );
        // A duplicate launch issued by the same click lands right after the
        // first, possibly between the wait above and the read below. One fixed
        // settle window makes it visible before the count is judged. 300 ms is
        // a judgement call: the duplicate is issued synchronously inside the
        // click handler, so it beats any window; a later scheduled launch
        // would not, and this assertion does not claim to catch one.
        await pause(300);
        const launched = await invoke(browser, "test_smoke_open_url_calls");
        assert.equal(
          launched,
          1,
          `Auth URL: one click must launch the login URL exactly once (launched ${launched} time(s))`,
        );
      },
    },
    {
      name: "user-disconnect",
      async run(browser, dataDir) {
        const host = await launchAndConnect(browser, dataDir);
        await actOn(browser, ".session-tab-close");
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
        // Safe: a single awaited read, never re-queried.
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
        // Safe: a single awaited read, never re-queried.
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

        // Tab and Shift+Tab stay inside the dialog, the dialog is named, and
        // its tab stops are exactly the four controls it renders.
        await assertModalTrap(browser, ".modal-panel", "Duplicate session", {
          expectedControls: [
            "input.duplicate-session-remember",
            "button.duplicate-session-cancel.btn-text",
            "button.duplicate-session-focus.btn-text",
            "button.duplicate-session-new.btn-primary",
          ],
        });

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
        await actOn(browser, ".duplicate-session-new");
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
        await actOn(browser, ".session-tab");
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
        await actOn(browser, ".session-tab-close", { index: 1 });
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
        // Both mocks: the loopback NetBox device is connectable through the SSH
        // mock, so this scenario can prove the real NetBox tab, not a stub.
        await installNetboxTabHost(browser);
        const host = await createHost(browser, { display_name: "Keyboard focus host" });
        // The connections view lists recent sessions, so the host has to have
        // been used once to appear in it (as createAndConnect does).
        await invoke(browser, "touch_host", { id: host.id });
        await browser.refresh();
        // Safe: each is a single awaited wait, never acted on or re-queried.
        await (await browser.$(".hs-host-list")).waitForExist({ timeout: WAIT_MS });
        await (await browser.$(`.hs-host-item[data-host-id="${host.id}"]`))
          .waitForDisplayed({ timeout: WAIT_MS });
        await installSmokeHelpers(browser);

        // The NetBox tab first: `--mutation=focus` must fail on these tab
        // assertions, and a failure here cannot be masked by a later check.
        await connectNetboxTabHost(browser);
        await assertNetboxDeviceTab(browser);

        // Back to the connection manager for the rest of the walk. The live
        // NetBox session stays with the backend until teardown.
        await browser.refresh();
        await (await browser.$(".hs-host-list")).waitForExist({ timeout: WAIT_MS });
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
        // The nav panel is a roving tabindex group: Tab reaches one item and
        // the arrows move between them, so a Tab walk alone cannot prove the
        // rest of the panel is reachable.
        await assertRovingGroup(browser, {
          group: ".nav-panel",
          item: ".nav-section-header, .nav-item",
          label: "Keyboard focus: nav panel",
        });

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
        await assertRovingGroup(browser, {
          group: ".settings-nav",
          item: ".settings-nav-item",
          label: "Keyboard focus: settings nav",
        });

        // KB import is an embedded tab panel rather than a modal (approved
        // deviation: reachability and names only, no trap to assert).
        await openNavSection(browser, "kb");
        await actOn(browser, '.nav-item[data-sub-id="import"]');
        // Safe: a single awaited wait, never acted on or re-queried.
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
        await actOn(browser, '.nav-item[data-sub-id="manage"]');
        await waitFor(browser, () => !!document.querySelector(".rsm-add"),
          "Keyboard focus: the replay command list did not render");
        await browser.execute(() => document.querySelector(".rsm-add")?.focus());
        await browser.keys("\uE007");
        // Safe: a single awaited wait, never acted on or re-queried.
        await (await browser.$("#rsv-title")).waitForExist({ timeout: WAIT_MS });
        assert(
          await browser.execute(() => document.querySelector("#rsv-text") === document.activeElement),
          "Keyboard focus: the replay dialog must put initial focus in the command field",
        );
        await assertModalTrap(browser, ".modal-panel", "Keyboard focus", {
          expectedControls: [
            "textarea#rsv-text.form-input",
            "select#rsv-platform.form-input",
            "button#rsv-cancel.btn-text",
            "button#rsv-save.btn-primary",
          ],
        });
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
      name: "netbox-device-sections",
      async run(browser) {
        await installSmokeHelpers(browser);
        const { sshPort } = await installNetboxTabHost(browser);
        // One Comnd host, matched only by the unique display name of peer 203.
        // Neither peer primary IP belongs to a host, so the IP pass cannot match
        // the NetBox host or this one: the result does not depend on the order
        // the backend returns hosts in. The first session is closed before the
        // second Connect so the duplicate-session prompt cannot interfere.
        const nameHost = await createHost(browser, {
          display_name: "peer-by-name",
          hostname: "127.0.0.1",
          port: sshPort,
        });
        // The sync and the host save ran through IPC, so reload to give the
        // host screen the materialized NetBox host and the user host.
        await browser.refresh();
        await installSmokeHelpers(browser);

        await connectNetboxTabHost(browser);
        await browser.execute(() => document.querySelector(".tv-panel-btn")?.focus());
        await browser.keys("\uE007");
        await waitFor(browser, () => {
          const panel = document.querySelector("#tv-sidebar");
          return !!panel && panel.getClientRects().length > 0 && !panel.classList.contains("hidden");
        }, "NetBox sections: the side panel did not open");
        await actOn(browser, ".sb-toggle-netbox");
        await browser.waitUntil(
          async () => browser.execute(() => {
            const name = document.querySelector(".nbd-name")?.textContent ?? "";
            return name === "tab-device"
              && document.querySelectorAll(".nbd-vlan-group").length === 2
              && document.querySelectorAll(".nbd-peer").length === 3;
          }),
          { timeout: WAIT_MS, interval: 100, timeoutMsg: "NetBox sections: the phase 2 sections did not render" },
        );

        const sections = await browser.execute(() => ({
          groups: [...document.querySelectorAll(".nbd-vlan-group")].map((group) => ({
            name: group.querySelector(".nbd-vlan-group-name")?.textContent ?? "",
            vlans: [...group.querySelectorAll(".nbd-vlan")].map((vlan) => [
              vlan.querySelector(".nbd-vlan-vid")?.textContent ?? "",
              vlan.querySelector(".nbd-vlan-name")?.textContent ?? "",
            ]),
          })),
          subnets: [...document.querySelectorAll(".nbd-subnet-prefix")]
            .map((prefix) => prefix.textContent ?? ""),
          peers: [...document.querySelectorAll(".nbd-peer")].map((peer) => ({
            name: peer.querySelector(".nbd-peer-name")?.textContent ?? "",
            connect: !!peer.querySelector(".nbd-connect"),
          })),
          text: document.querySelector(".sb-content")?.textContent ?? "",
        }));
        assert.deepEqual(
          sections.groups.map((group) => group.name),
          ["DC1", "DC1-MGMT"],
          `NetBox sections: wrong VLAN groups ${JSON.stringify(sections.groups)}`,
        );
        assert.deepEqual(sections.groups[0].vlans, [["10", "users"], ["20", "voice"]]);
        assert.deepEqual(sections.groups[1].vlans, [["100", "mgmt"], ["200", "servers"]]);
        assert.deepEqual(
          sections.subnets,
          ["10.0.0.0/24", "10.0.20.0/24", "2001:db8::/32"],
          `NetBox sections: wrong subnet union ${JSON.stringify(sections.subnets)}`,
        );
        assert.deepEqual(
          sections.peers,
          [
            { name: "peer-by-name", connect: true },
            { name: "peer-switch", connect: false },
            { name: "unmatched-peer", connect: false },
          ],
          `NetBox sections: wrong peer rows ${JSON.stringify(sections.peers)}`,
        );
        assert.equal(
          await browser.execute(() => document.querySelectorAll(".nbd-connect").length),
          1,
          "NetBox sections: only the name-matched peer should offer Connect",
        );
        assert(
          !sections.text.includes("sibling-only") && !sections.text.includes("999"),
          "NetBox sections: a virtual-chassis sibling's VLAN leaked into the device",
        );

        // Docked Connect: peer 203 resolves to the only host by display name.
        await actOn(browser, '.nbd-peer[data-peer-id="203"] .nbd-connect');
        await waitForActiveConnection(browser, "NetBox sections (docked Connect)");
        await browser.waitUntil(
          async () => browser.execute(() =>
            (document.querySelector(".sb-sessions")?.textContent ?? "").includes("2 sessions")),
          { timeout: WAIT_MS, interval: 100, timeoutMsg: "NetBox sections: the docked Connect did not open a second session" },
        );

        // Close the session before the second Connect: a live session on the
        // matched host is what would open the duplicate-session prompt.
        await actOn(browser, `.session-tab[data-host-id="${nameHost.id}"] .session-tab-close`);
        await actOn(browser, ".confirm-ok");
        await browser.waitUntil(
          async () => browser.execute(() =>
            (document.querySelector(".sb-sessions")?.textContent ?? "").includes("1 session")),
          { timeout: WAIT_MS, interval: 100, timeoutMsg: "NetBox sections: closing the docked session did not return to one session" },
        );

        // The NetBox session is active again; reselect its tab and Connect
        // from the undocked window. The panel follows the active session.
        await waitForActiveConnection(browser, "NetBox sections (back to the NetBox session)");
        await actOn(browser, ".sb-toggle-netbox");
        await panelShortcut(browser);
        const panelTarget = await switchToWindow(browser, "panel",
          "NetBox sections: the undocked panel window never became scriptable");
        await waitFor(browser, () => !!document.querySelector(".nbd-peer"),
          "NetBox sections: the undocked window did not render the peers");
        assert.equal(
          await browser.execute(() => document.querySelectorAll(".nbd-vlan-group").length),
          2,
          "NetBox sections: the undocked window rendered different sections",
        );
        await actOn(browser, '.nbd-peer[data-peer-id="203"] .nbd-connect');
        await browser.switchToWindow(panelTarget.previous);
        await waitForActiveConnection(browser, "NetBox sections (undocked Connect)");
        await browser.waitUntil(
          async () => browser.execute(() =>
            (document.querySelector(".sb-sessions")?.textContent ?? "").includes("2 sessions")),
          { timeout: WAIT_MS, interval: 100, timeoutMsg: "NetBox sections: the undocked Connect did not open a second session" },
        );

        // Leave the app docked for teardown.
        await panelShortcut(browser);
        await waitForNoWindow(browser, "panel",
          "NetBox sections: the final dock did not close the panel window");
        await waitForWindowCount(browser, 1,
          "NetBox sections: the final dock left an extra window behind");
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
        const panelStops = await tabFrom(browser, 10);
        assert(
          panelStops.some((stop) => String(stop.cls).includes("sb-toggle")),
          `Terminal focus: the open sidebar is not reachable with Tab; saw `
          + `${JSON.stringify(panelStops.map((stop) => stop.cls || stop.tag))}`,
        );
        for (const stop of panelStops) {
          assertNamed(stop, "Terminal focus");
          assertFocusVisible(stop, "Terminal focus");
        }

        // The splitter between terminal and sidebar is a real tab stop while
        // the sidebar is open, so it must be named and visibly focused like
        // any other control. The keyboard walk cannot record it: stepping over
        // the terminal's Tab interceptor focuses the next candidate directly,
        // so the element that jump lands on is never the one a Tab press is
        // observed on. This proves it is focusable and how it looks focused.
        await assertScriptFocusStop(browser, "#tv-sidebar-resizer", "Terminal focus");

        // The session tab is a tab stop of its own, and its ring is drawn
        // through a CSS transition, so it is the case that proves the read is
        // taken after the ring has settled.
        await assertScriptFocusStop(browser, ".session-tab", "Terminal focus");

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

        await actOn(browser, ".tv-panel-btn");
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
        await actOn(browser, ".tv-panel-btn");
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
      // Issue #133: the KB browse detail actions and the command count must stay
      // on screen at the window the app opens with (1200x800 per
      // src-tauri/tauri.conf.json), so this scenario never resizes the window.
      name: "kb-layout",
      async run(browser) {
        await openNavSection(browser, "kb");
        await actOn(browser, '.nav-item[data-section="kb"][data-sub-id="browse"]');
        await waitFor(
          browser,
          () => !!document.querySelector(".kb-command-item"),
          "KB layout: the browse list never rendered a command",
        );
        // Any command works for the detail pane, so take the first one rather
        // than depending on one platform's ordering.
        await actOn(browser, ".kb-command-item");
        await waitFor(
          browser,
          () => !!document.querySelector("#kb-cmd-edit-btn"),
          "KB layout: selecting a command did not render the detail actions",
        );

        for (const id of ["#kb-cmd-edit-btn", "#kb-cmd-ignore-btn", "#kb-cmd-delete-btn"]) {
          await assertControlInWindow(browser, id, 0, "KB layout");
        }

        // "Fully inside the viewport" is both axes: a count pushed below the
        // window would leave its horizontal position alone, so checking only
        // left/right would still pass.
        const count = await browser.execute(() => {
          const el = document.querySelector(".kb-count");
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return {
            left: r.left,
            right: r.right,
            top: r.top,
            bottom: r.bottom,
            width: window.innerWidth,
            height: window.innerHeight,
          };
        });
        assert(count, "KB layout: .kb-count was never rendered");
        assert(
          count.left >= 0 && count.right <= count.width
            && count.top >= 0 && count.bottom <= count.height,
          `KB layout: .kb-count is outside the window `
            + `(left ${Math.round(count.left)}, top ${Math.round(count.top)}, `
            + `right ${Math.round(count.right)}, bottom ${Math.round(count.bottom)}, `
            + `window ${count.width}x${count.height})`,
        );

        const detail = await browser.execute(() => {
          const el = document.querySelector(".kb-command-detail");
          if (!el) return null;
          return { clientWidth: el.clientWidth, scrollWidth: el.scrollWidth };
        });
        assert(detail, "KB layout: .kb-command-detail was never rendered");
        assert.equal(
          detail.clientWidth,
          detail.scrollWidth,
          `KB layout: .kb-command-detail scrolls horizontally `
            + `(clientWidth ${detail.clientWidth}, scrollWidth ${detail.scrollWidth})`,
        );
      },
    },
    {
      // Issue #133: the same geometry rules for the terminal's side panel, which
      // renders the same SidebarContent markup in a 320px column.
      name: "terminal-sidebar-layout",
      async run(browser, dataDir) {
        await installSmokeHelpers(browser);
        await launchAndConnect(browser, dataDir);
        await enableSuggestions(browser);
        await actOn(browser, ".tv-panel-btn");
        await waitFor(
          browser,
          () => document.querySelector(".tv-panel-btn")?.getAttribute("aria-expanded") === "true",
          "Terminal sidebar layout: the side panel did not open",
        );
        await sendKeys(browser, "ip r");
        await waitFor(
          browser,
          () => !!document.querySelector(".sb-content .cmd-name"),
          "Terminal sidebar layout: typing a command did not fill the side panel",
        );

        // One copy button per example, so index through however many the
        // command renders rather than assuming a fixed count.
        const copies = await browser.execute(
          () => document.querySelectorAll(".sb-content .example-copy").length,
        );
        assert(
          copies > 0,
          "Terminal sidebar layout: the side panel rendered no example copy button",
        );
        for (let i = 0; i < copies; i += 1) {
          await assertControlInWindow(browser, ".sb-content .example-copy", i, "Terminal sidebar layout",
            { scroll: true });
        }
        await assertControlInWindow(browser, ".sb-content .cmd-ref-link", 0, "Terminal sidebar layout",
          { scroll: true });
        // The resizer is unhidden by toggleSidebar, so it must be on screen
        // whenever the panel is open.
        await assertControlInWindow(browser, "#tv-sidebar-resizer", 0, "Terminal sidebar layout",
          { scroll: true });

        const content = await browser.execute(() => {
          const el = document.querySelector(".sb-content");
          if (!el) return null;
          return { clientWidth: el.clientWidth, scrollWidth: el.scrollWidth };
        });
        assert(content, "Terminal sidebar layout: .sb-content was never rendered");
        assert.equal(
          content.clientWidth,
          content.scrollWidth,
          `Terminal sidebar layout: .sb-content scrolls horizontally `
            + `(clientWidth ${content.clientWidth}, scrollWidth ${content.scrollWidth})`,
        );

        // The grid must fit inside the pane's inset. FitAddon proposes rows and
        // cols from parseInt(getComputedStyle(.tv-terminal).width), and Chrome
        // reports the *border* box there for a border-box element, so an inset
        // that the fit cannot see leaves the grid hanging past it into
        // overflow:hidden — the last row and column are silently clipped.
        // Rect-based, so it measures the outcome rather than restating the CSS.
        const grid = await browser.execute(() => {
          const term = document.querySelector(".tv-terminal");
          const screen = term?.querySelector(".xterm-screen");
          if (!term || !screen) return null;
          const cs = getComputedStyle(term);
          const r = term.getBoundingClientRect();
          const s = screen.getBoundingClientRect();
          return {
            padLeft: parseFloat(cs.paddingLeft),
            padRight: parseFloat(cs.paddingRight),
            padTop: parseFloat(cs.paddingTop),
            padBottom: parseFloat(cs.paddingBottom),
            left: s.left - r.left,
            top: s.top - r.top,
            right: r.right - s.right,
            bottom: r.bottom - s.bottom,
          };
        });
        assert(grid, "Terminal sidebar layout: the terminal grid was never rendered");
        assert(
          grid.padLeft > 0 && grid.padTop > 0 && grid.padRight > 0 && grid.padBottom > 0,
          `Terminal sidebar layout: the terminal screen has no inset from the pane frame `
            + `(padding ${grid.padTop}px ${grid.padRight}px ${grid.padBottom}px ${grid.padLeft}px)`,
        );
        // 1px tolerance for subpixel rounding of fractional cell widths.
        assert(
          grid.left >= grid.padLeft - 1
            && grid.top >= grid.padTop - 1
            && grid.right >= grid.padRight - 1
            && grid.bottom >= grid.padBottom - 1,
          `Terminal sidebar layout: the terminal grid overflows its inset `
            + `(left ${grid.left} for ${grid.padLeft}px padding, top ${grid.top} for `
            + `${grid.padTop}px, right ${grid.right} for ${grid.padRight}px, bottom `
            + `${grid.bottom} for ${grid.padBottom}px)`,
        );

        // Everything from the tab bar down lives inside `.app-content`, whose
        // `overflow: hidden` is the real clip edge. The tab host is a column
        // flex container so the bar's height comes off the session wrapper; if
        // the wrapper goes back to filling the host's whole height from below
        // the bar, the bottom of the terminal view hangs past that edge and the
        // status bar and the pane frame's bottom border are clipped away.
        const clip = await browser.execute(() => {
          const content = document.querySelector(".app-content");
          const wrap = document.querySelector(".tv-terminal-wrap");
          const statusbar = document.querySelector(".tv-statusbar");
          if (!content || !wrap || !statusbar) return null;
          const bottom = content.getBoundingClientRect().bottom
            - parseFloat(getComputedStyle(content).borderBottomWidth);
          return {
            wrap: wrap.getBoundingClientRect().bottom - bottom,
            statusbar: statusbar.getBoundingClientRect().bottom - bottom,
          };
        });
        assert(clip, "Terminal sidebar layout: the terminal pane or status bar was never rendered");
        // 1px tolerance for subpixel rounding at fractional display scale.
        assert(
          clip.wrap <= 1 && clip.statusbar <= 1,
          `Terminal sidebar layout: the bottom of the terminal view is clipped `
            + `(frame ${clip.wrap}px, status bar ${clip.statusbar}px past the bottom of `
            + `.app-content)`,
        );

        // Issues #176/#177: the three tab buttons are icon-only, while the
        // Undock control keeps its word. At the 240px minimum width and the
        // largest UI text scale the strip must wrap rather than let a control
        // paint over its neighbour, and nothing may be clipped. Measured from
        // rendered rectangles, so it proves the outcome rather than restating
        // the CSS.
        await browser.execute(() => {
          document.documentElement.style.setProperty("--text-scale", "1.5");
          document.querySelector("#tv-sidebar-resizer")?.focus();
        });
        assert.equal(
          await browser.execute(() => document.activeElement?.id ?? ""),
          "tv-sidebar-resizer",
          "Terminal sidebar layout: the resizer did not take keyboard focus",
        );
        await browser.keys(["\uE011"]); // Home: the resizer's own 240px stop
        await pause(300);
        const strip = await browser.execute(() => {
          const sidebar = document.querySelector("#tv-sidebar");
          if (!sidebar) return null;
          const frame = sidebar.getBoundingClientRect();
          // A hidden NetBox tab (user host) has no layout, so it is not a box
          // the strip has to keep inside the panel.
          const boxes = [...sidebar.querySelectorAll(".sb-toggle > *")]
            .filter((element) => element.getClientRects().length > 0)
            .map((element) => {
              const rect = element.getBoundingClientRect();
              return {
                name: element.id || element.textContent?.trim() || "?",
                left: rect.left,
                right: rect.right,
                top: rect.top,
                bottom: rect.bottom,
                clipped: element.scrollWidth > element.clientWidth + 1,
              };
            });
          return { frame: { left: frame.left, right: frame.right, width: frame.width }, boxes };
        });
        assert(strip, "Terminal sidebar layout: the tab strip was never rendered");
        assert(
          Math.abs(strip.frame.width - 240) <= 2,
          `Terminal sidebar layout: Home did not take the panel to 240px `
            + `(it is ${strip.frame.width}px)`,
        );
        assert(
          strip.boxes.length >= 3,
          `Terminal sidebar layout: expected the icon tabs and Undock, found ${strip.boxes.length} item(s)`,
        );
        for (const box of strip.boxes) {
          assert(
            !box.clipped,
            `Terminal sidebar layout: "${box.name}" is clipped at 240px with `
              + `the largest text scale`,
          );
          assert(
            box.left >= strip.frame.left - 1 && box.right <= strip.frame.right + 1,
            `Terminal sidebar layout: "${box.name}" escapes the panel at 240px `
              + `(${box.left}-${box.right} against ${strip.frame.left}-${strip.frame.right})`,
          );
        }
        for (let i = 0; i < strip.boxes.length; i += 1) {
          for (let j = i + 1; j < strip.boxes.length; j += 1) {
            const a = strip.boxes[i];
            const b = strip.boxes[j];
            const sharesRow = a.top < b.bottom - 1 && b.top < a.bottom - 1;
            assert(
              !sharesRow || a.right <= b.left + 1 || b.right <= a.left + 1,
              `Terminal sidebar layout: "${a.name}" overlaps "${b.name}" at 240px `
                + `with the largest text scale`,
            );
          }
        }
        await browser.execute(() => {
          document.documentElement.style.removeProperty("--text-scale");
        });
      },
    },
    {
      // Issue #176, ADR-003: the panel can undock into its own OS window, and
      // undocking is what gives the terminal the full width back. Driven only by
      // Ctrl+Shift+B, so the keyboard path is the one proved here.
      name: "panel-undock-dock",
      async run(browser, dataDir) {
        await installSmokeHelpers(browser);
        await launchAndConnect(browser, dataDir);

        const layout = () => browser.execute(() => {
          const box = (selector) => {
            const element = document.querySelector(selector);
            if (!element) return null;
            const rect = element.getBoundingClientRect();
            return { left: rect.left, right: rect.right, width: rect.width };
          };
          const panel = document.querySelector("#tv-sidebar");
          return {
            terminal: box(".tv-terminal"),
            sidebar: box("#tv-sidebar"),
            main: box(".tv-main"),
            // The panel stays in the DOM when it is not docked, so visibility is
            // a class/box question, not an existence question.
            sidebarVisible: !!panel
              && panel.getClientRects().length > 0
              && !panel.classList.contains("hidden"),
          };
        });

        const closed = await layout();
        assert(closed.terminal && closed.terminal.width > 0,
          "Panel undock: the terminal has no measurable width");
        assert.equal(closed.sidebarVisible, false, "Panel undock: the panel should start closed");
        const closedSizes = await lastPtySizes(browser);
        assert(closedSizes.length > 0, "Panel undock: the mock host recorded no PTY size");
        const closedCols = closedSizes[closedSizes.length - 1][0];

        // 1. Closed → open, docked: still one window, and the terminal narrows.
        await panelShortcut(browser);
        await waitFor(browser, () => {
          const panel = document.querySelector("#tv-sidebar");
          return !!panel && panel.getClientRects().length > 0
            && !panel.classList.contains("hidden");
        }, "Panel undock: the shortcut did not open the panel");
        assert.equal((await windowHandles(browser)).length, 1,
          "Panel undock: opening the panel docked must not create a window");
        // The view refits 250 ms after the layout change and resizes the PTY then.
        await pause(800);
        const docked = await layout();
        assert(docked.sidebar && docked.sidebar.width > 0,
          "Panel undock: the docked panel has no width");
        assert(
          docked.terminal.width < closed.terminal.width - 100,
          `Panel undock: opening the docked panel did not narrow the terminal `
            + `(${closed.terminal.width}px -> ${docked.terminal.width}px)`,
        );
        await browser.waitUntil(
          async () => (await lastPtySizes(browser)).length > closedSizes.length,
          {
            timeout: WAIT_MS,
            interval: 100,
            timeoutMsg: "Panel undock: opening the docked panel never resized the remote PTY",
          },
        );
        const dockedSizes = await lastPtySizes(browser);
        const dockedCols = dockedSizes[dockedSizes.length - 1][0];
        assert(
          dockedCols < closedCols,
          `Panel undock: the PTY width did not follow the docked panel `
            + `(${closedCols} cols -> ${dockedCols} cols)`,
        );

        // Widen the docked panel through the resizer's own keyboard path, so the
        // redock assertion cannot pass by falling back to the 320px default. The
        // write is debounced, so wait for the config to catch up: the saved value
        // is what docking must restore.
        await browser.execute(() => document.querySelector("#tv-sidebar-resizer")?.focus());
        assert.equal(
          await browser.execute(() => document.activeElement?.id ?? ""),
          "tv-sidebar-resizer",
          "Panel undock: the resizer did not take keyboard focus",
        );
        for (let i = 0; i < 3; i += 1) await browser.keys(["\uE008", "\uE012"]);
        await pause(900);
        const widened = (await layout()).sidebar.width;
        assert(
          widened > docked.sidebar.width + 20,
          `Panel undock: the resizer did not widen the docked panel `
            + `(${docked.sidebar.width}px -> ${widened}px)`,
        );
        const savedWidth = (await invoke(browser, "panel_get_state")).docked_width;
        assert(
          Math.abs(savedWidth - Math.round(widened)) <= 2,
          `Panel undock: the widened width was not saved `
            + `(config ${savedWidth}px, live ${widened}px)`,
        );

        // 2. Open → undocked: the panel leaves the row and the terminal takes
        //    the full width back, through the same fit() → ssh_resize path.
        await panelShortcut(browser);
        await waitForWindowCount(browser, 2,
          "Panel undock: undocking did not put the panel in its own window");
        const panelInfo = await singlePanelWindow(browser, "Panel undock");
        assert(panelInfo.width > 0 && panelInfo.height > 0,
          `Panel undock: the panel window has no size `
            + `(${panelInfo.width}x${panelInfo.height})`);
        await waitFor(browser, () => {
          const panel = document.querySelector("#tv-sidebar");
          return !panel || panel.getClientRects().length === 0
            || panel.classList.contains("hidden");
        }, "Panel undock: the docked panel did not leave the terminal row");
        await pause(800);
        const undocked = await layout();
        assert(
          Math.abs(undocked.terminal.width - closed.terminal.width) <= 1,
          `Panel undock: undocking did not give the terminal the full width `
            + `(${undocked.terminal.width}px, closed was ${closed.terminal.width}px)`,
        );
        await browser.waitUntil(
          async () => (await lastPtySizes(browser)).length > dockedSizes.length,
          {
            timeout: WAIT_MS,
            interval: 100,
            timeoutMsg: "Panel undock: undocking never resized the remote PTY",
          },
        );
        const undockedSizes = await lastPtySizes(browser);
        const undockedCols = undockedSizes[undockedSizes.length - 1][0];
        assert(
          Math.abs(undockedCols - closedCols) <= 1,
          `Panel undock: the PTY width did not widen back on undock `
            + `(${dockedCols} cols docked, ${undockedCols} cols undocked, `
            + `${closedCols} cols closed)`,
        );

        // 3. The panel's own window offers Dock and not Undock.
        const panelTarget = await switchToWindow(browser, "panel",
          "Panel undock: the undocked panel window never became scriptable");
        await waitFor(browser, () => !!document.querySelector(".pw-title"),
          "Panel undock: the panel window did not render its header");
        assert.equal(
          await browser.execute(() => document.querySelectorAll("#panel-dock").length),
          1,
          "Panel undock: the undocked panel window has no Dock control",
        );
        assert.equal(
          await browser.execute(() => document.querySelectorAll("#panel-undock").length),
          0,
          "Panel undock: the undocked panel window offers Undock; dock is the only way back",
        );

        // 4. Dock by key from the panel window: one window again, the panel back
        //    at the width it was docked at. Docking destroys the window the key
        //    went to, so re-target the main handle before polling — a command
        //    sent to a window that closed mid-command fails instead of returning.
        await panelShortcut(browser).catch((caught) => {
          if (!/no such window/i.test(String(caught?.message ?? caught))) throw caught;
        });
        await browser.switchToWindow(panelTarget.previous);
        await waitForNoWindow(browser, "panel",
          "Panel undock: docking from the panel window did not close it");
        await waitForWindowCount(browser, 1,
          "Panel undock: docking left an extra window behind");
        await browser.switchToWindow(panelTarget.previous);
        await waitFor(browser, () => {
          const panel = document.querySelector("#tv-sidebar");
          return !!panel && panel.getClientRects().length > 0
            && !panel.classList.contains("hidden");
        }, "Panel undock: docking did not bring the panel back into the terminal row");
        await pause(800);
        const redocked = await layout();
        assert(
          Math.abs(redocked.sidebar.width - savedWidth) <= 1,
          `Panel undock: docking did not restore the saved width `
            + `(${savedWidth}px saved, ${redocked.sidebar.width}px after redocking)`,
        );
        assert(
          redocked.sidebar.left >= redocked.terminal.right - 1,
          `Panel undock: the docked panel overlays the terminal instead of pushing it `
            + `(sidebar left ${redocked.sidebar.left}, terminal right ${redocked.terminal.right})`,
        );
        assert(
          redocked.terminal.width < undocked.terminal.width - 100,
          `Panel undock: docking did not narrow the terminal again `
            + `(${undocked.terminal.width}px -> ${redocked.terminal.width}px)`,
        );
        await browser.waitUntil(
          async () => (await lastPtySizes(browser)).length > undockedSizes.length,
          {
            timeout: WAIT_MS,
            interval: 100,
            timeoutMsg: "Panel undock: docking never resized the remote PTY back",
          },
        );
        const redockedCols = (await lastPtySizes(browser)).slice(-1)[0][0];
        assert(
          redockedCols < undockedCols,
          `Panel undock: the PTY width did not follow the docked panel again `
            + `(${undockedCols} cols -> ${redockedCols} cols)`,
        );

        // 5. Undock again and ask for the window a second time: the same single
        //    window comes back, never a copy. The WebDriver handle proves reuse —
        //    destroying and rebuilding the window at the same width would satisfy
        //    the count and the width on its own.
        await panelShortcut(browser);
        await waitForWindowCount(browser, 2,
          "Panel undock: undocking a second time did not open exactly one window");
        const firstTarget = await switchToWindow(browser, "panel",
          "Panel undock: the second undock did not open a panel window");
        const first = await singlePanelWindow(browser, "Panel undock (second undock)");
        await browser.switchToWindow(firstTarget.previous);
        await invoke(browser, "panel_open");
        await pause(500);
        await waitForWindowCount(browser, 2,
          "Panel undock: requesting the panel window again created a second copy");
        const second = await singlePanelWindow(browser, "Panel undock (reopened)");
        assert.equal(second.width, first.width,
          `Panel undock: the reused window changed width `
            + `(${first.width}px -> ${second.width}px)`);
        const again = await switchToWindow(browser, "panel",
          "Panel undock: the requested panel window never became scriptable");
        assert.equal(again.handle, firstTarget.handle,
          "Panel undock: the panel window was destroyed and rebuilt instead of reused");
        await browser.switchToWindow(again.previous);

        // 6. Finish docked, so the app is left in its default home for teardown.
        await panelShortcut(browser);
        await waitForNoWindow(browser, "panel",
          "Panel undock: the final dock did not close the panel window");
        await waitForWindowCount(browser, 1,
          "Panel undock: the final dock left an extra window behind");
      },
    },
    panelUndockRelaunchScenario(),
    {
      name: "accessible-names-toasts",
      async run(browser, dataDir) {
        await installSmokeHelpers(browser);
        await createHost(browser, { display_name: "Names host" });
        await browser.refresh();
        // Safe: a single awaited wait, never acted on or re-queried.
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
        await actOn(browser, "#netbox-sync-btn");
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
        // A folder label long enough that the 240px panel cannot hold it at the
        // Reading Comfort maximum: the case issue #100 (finding F-3) reports.
        const folder = await invoke(browser, "save_host_group", {
          id: null,
          name: "Regional core switches",
          parentId: null,
          color: null,
          icon: null,
        });
        await createHost(browser, { display_name: "Theme host" });
        await browser.refresh();
        // Safe: single awaited waits, never acted on or re-queried.
        await (await browser.$(".hs-host-list")).waitForExist({ timeout: WAIT_MS });
        await installSmokeHelpers(browser);
        await openSettings(browser);
        await openSettingsItem(browser, "theme");
        // Safe: a single awaited wait, never acted on or re-queried.
        await (await browser.$("#theme-app")).waitForExist({ timeout: WAIT_MS });

        const applyTheme = async (theme) => {
          await setField(browser, "#theme-app", theme);
          await browser.waitUntil(
            async () => (await browser.execute(() => document.documentElement.dataset.theme)) === theme,
            { timeout: WAIT_MS, interval: 100, timeoutMsg: `Theme: the ${theme} theme was not applied` },
          );
          return browser.execute(() => {
            const root = getComputedStyle(document.documentElement);
            // .app-nav carries the nav chrome background; .nav-panel is a
            // transparent flex column inside it and would always read empty.
            const nav = document.querySelector(".app-nav");
            return {
              theme: document.documentElement.dataset.theme,
              bg: root.getPropertyValue("--color-surface-primary").trim(),
              navBackground: nav ? getComputedStyle(nav).backgroundColor : "",
              scrollbarThumb: root.getPropertyValue("--color-scrollbar-thumb").trim(),
              scrollbarColor: nav ? getComputedStyle(nav).scrollbarColor : "",
              // Decided by the engine, not by the values under test.
              supportsScrollbarColor: CSS.supports("scrollbar-color", "auto"),
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
        // The token existing is not the same as it reaching the chrome: the
        // nav panel has to repaint for each theme too.
        const navBackgrounds = new Set(Object.values(applied).map((entry) => entry.navBackground));
        assert.equal(
          navBackgrounds.size,
          3,
          `Theme: the nav panel must repaint for each theme, saw `
          + `${JSON.stringify([...navBackgrounds])}`,
        );
        // The nav scrolls on both axes, so its horizontal bar has to be legible
        // against every theme too. The thumb colour is a token, and base.css
        // paints both axes from it.
        const scrollbarThumbs = new Set(Object.values(applied).map((entry) => entry.scrollbarThumb));
        assert.equal(
          scrollbarThumbs.size,
          3,
          `Theme: the scrollbar thumb must be theme-specific, saw `
          + `${JSON.stringify([...scrollbarThumbs])}`,
        );
        // Engines that paint scrollbar-color report the resolved token here;
        // the WebKit-only engines report "auto" and are painted by
        // ::-webkit-scrollbar-thumb instead, which is the same token.
        const themedScrollbars = new Set(Object.values(applied).map((entry) => entry.scrollbarColor));
        if (applied.dark.supportsScrollbarColor) {
          assert.equal(
            themedScrollbars.size,
            3,
            `Theme: the nav scrollbars must repaint for each theme, saw `
            + `${JSON.stringify([...themedScrollbars])}`,
          );
        }
        await applyTheme("dark");

        // Reading Comfort, then enlarged UI text, both measured rather than
        // assumed: the scale token must change and the text must grow.
        await openSettingsItem(browser, "reading-comfort");
        // Safe: a single awaited wait, never acted on or re-queried.
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
        await actOn(browser, "#rc-enabled");
        await browser.waitUntil(
          async () => (await measure()).readingComfort === "on",
          { timeout: WAIT_MS, interval: 100, timeoutMsg: "Reading Comfort: the mode never turned on" },
        );
        // Safe: a single awaited wait, never acted on or re-queried.
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

        // Issue #100 / F-3: at the maximum scale a folder name must read in
        // full. Rows size to their own text and .app-nav scrolls, so no label
        // is allowed to fall back to its ellipsis.
        const navText = await browser.execute((groupId) => {
          const panel = document.querySelector(".app-nav");
          const labels = [...document.querySelectorAll(".app-nav .nav-item-label")]
            .filter((el) => el.getClientRects().length > 0);
          const group = document.querySelector(`.nav-group-row[data-group-id="${groupId}"] .nav-item-label`);
          const toggle = document.querySelector(".nav-group-row .nav-toggle");
          const toggleBox = toggle?.getBoundingClientRect();
          const panelBox = panel?.getBoundingClientRect();
          return {
            truncated: labels
              .filter((el) => el.scrollWidth > el.clientWidth + 1)
              .map((el) => el.textContent.trim()),
            groupText: group ? group.textContent.trim() : "",
            groupFits: group ? group.scrollWidth <= group.clientWidth + 1 : false,
            overflowX: panel ? getComputedStyle(panel).overflowX : "",
            // Scrolled to the start, which is where the panel opens: the
            // expand/collapse chevron leads the row and must stay on screen.
            chevronVisible: !!toggleBox && !!panelBox
              && toggleBox.width > 4
              && toggleBox.left >= panelBox.left - 1
              && toggleBox.right <= panelBox.right + 1,
          };
        }, folder.id);
        assert.deepEqual(
          navText.truncated,
          [],
          "Enlarged text: nav labels are still truncated at the 1.5x UI scale "
          + `(${JSON.stringify(navText.truncated)})`,
        );
        assert(
          navText.groupText.length >= 12 && navText.groupFits,
          `Enlarged text: the folder label "${navText.groupText}" `
          + `(${navText.groupText.length} characters) does not render in full`,
        );
        assert.equal(
          navText.overflowX,
          "auto",
          `Enlarged text: the nav panel cannot scroll to a wider name `
          + `(overflow-x is ${navText.overflowX})`,
        );
        assert(
          navText.chevronVisible,
          "Enlarged text: the expand/collapse chevron is outside the nav panel",
        );
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
        // Safe: a single awaited wait, never acted on or re-queried.
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
        // Safe: single awaited waits, never acted on or re-queried.
        await (await browser.$(`.nav-host-row[data-host-id="${hosts[0].id}"]`))
          .waitForDisplayed({ timeout: WAIT_MS });
        await expandNavGroup(browser, nestedGroup.id);
        // Safe: a single awaited wait, never acted on or re-queried.
        await (await browser.$(`.nav-group-row[data-group-id="${nestedGroup.id}"]`))
          .waitForDisplayed({ timeout: WAIT_MS });
        // Rows a group expand inserts belong to the same roving group: the
        // whole panel stays one Tab stop with the arrows moving inside it.
        await assertRovingGroup(browser, {
          group: ".nav-panel",
          item: ".nav-section-header, .nav-item",
          label: "Expanded folder tree: nav panel",
        });

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
          return {
            left: a.left,
            right: a.right,
            rowLeft: b.left,
            rowRight: b.right,
            text: label.textContent,
            truncated: label.scrollWidth > label.clientWidth + 1,
          };
        }, hosts[0].id);
        assert(labelBox, "Small window: the long-named host is not rendered in the nav panel");
        assert(
          labelBox.left >= labelBox.rowLeft - 1 && labelBox.right <= labelBox.rowRight + 1,
          `Small window: the long host name overflows its row `
          + `(${labelBox.left}-${labelBox.right} inside ${labelBox.rowLeft}-${labelBox.rowRight})`,
        );
        // Issue #100 acceptance criterion 2: a long host name is fully visible;
        // the nav scrolls to it rather than ellipsising it (ADR 024).
        assert(
          labelBox.text.length >= 24 && !labelBox.truncated,
          `Small window: the ${labelBox.text.length}-character host name is truncated `
          + `(${labelBox.text})`,
        );

        // A dialog taller than the window must scroll, not clip its controls.
        await openNavSection(browser, "replay");
        await actOn(browser, '.nav-item[data-sub-id="manage"]');
        await actOn(browser, ".rsm-add");
        // Safe: a single awaited wait, never acted on or re-queried.
        await (await browser.$(".modal-panel")).waitForExist({ timeout: WAIT_MS });
        const panel = await browser.execute(() => {
          const element = document.querySelector(".modal-panel");
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return {
            overflowY: style.overflowY,
            name: window.__comndSmoke.nameOf(element),
            top: rect.top,
            bottom: rect.bottom,
            viewportHeight: window.innerHeight,
          };
        });
        assert(panel.name.length > 0, "Dialog overflow: the dialog has no accessible name");
        assert(
          panel.top >= -1 && panel.bottom <= panel.viewportHeight + 1,
          `Dialog overflow: the dialog does not fit the window `
          + `(${Math.round(panel.top)}-${Math.round(panel.bottom)} in ${panel.viewportHeight}px)`,
        );
        assertNothingClipped(await browser.execute(() => window.__comndSmoke.clipped(".modal-panel")),
          "Dialog overflow: the dialog clips a control");
        assert.deepEqual(await browser.execute(() => window.__comndSmoke.overlaps(".modal-panel")), [],
          "Dialog overflow: dialog controls overlap");

        // The replay dialog is short, so its content is lengthened: the scroll
        // path has to hold whether or not this particular dialog overflows.
        const forced = await browser.execute(() => {
          const element = document.querySelector(".modal-panel");
          const spacer = document.createElement("div");
          spacer.id = "smoke-dialog-overflow";
          // The replay dialog is a flex column, so the spacer has to refuse to
          // shrink or it contributes no height at all.
          spacer.style.flex = "0 0 auto";
          spacer.style.height = "2000px";
          element.appendChild(spacer);
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return {
            scrollHeight: element.scrollHeight,
            clientHeight: element.clientHeight,
            overflowY: style.overflowY,
            top: rect.top,
            bottom: rect.bottom,
            viewportHeight: window.innerHeight,
          };
        });
        assert(
          forced.scrollHeight > forced.clientHeight,
          `Dialog overflow: the dialog does not scroll its content `
          + `(${forced.scrollHeight}px of content in ${forced.clientHeight}px)`,
        );
        assert(
          forced.overflowY === "auto" || forced.overflowY === "scroll",
          `Dialog overflow: the dialog's content is taller than it but overflow-y is ${forced.overflowY}`,
        );
        assert(
          forced.top >= -1 && forced.bottom <= forced.viewportHeight + 1,
          `Dialog overflow: the dialog grew past the window instead of scrolling `
          + `(${Math.round(forced.top)}-${Math.round(forced.bottom)} in ${forced.viewportHeight}px)`,
        );
        const scrolled = await browser.execute(() => {
          const element = document.querySelector(".modal-panel");
          element.scrollTop = element.scrollHeight;
          const atEnd = element.scrollTop > 0;
          element.scrollTop = 0;
          const box = element.getBoundingClientRect();
          const cancel = element.querySelector("#rsv-cancel")?.getBoundingClientRect();
          return {
            atEnd,
            boxTop: box.top,
            boxBottom: box.bottom,
            cancelTop: cancel?.top ?? null,
            cancelBottom: cancel?.bottom ?? null,
          };
        });
        assert(scrolled.atEnd, "Dialog overflow: the dialog did not scroll to its end");
        assert(
          scrolled.cancelTop !== null
            && scrolled.cancelTop >= scrolled.boxTop - 1
            && scrolled.cancelBottom <= scrolled.boxBottom + 1,
          "Dialog overflow: the dialog's actions are not reachable after scrolling "
          + `(${Math.round(scrolled.cancelTop ?? -1)}-${Math.round(scrolled.cancelBottom ?? -1)} `
          + `outside ${Math.round(scrolled.boxTop)}-${Math.round(scrolled.boxBottom)})`,
        );
        await pressEscape(browser);
        await browser.waitUntil(
          async () => browser.execute(() => !document.querySelector(".modal-panel")),
          { timeout: WAIT_MS, interval: 100, timeoutMsg: "Dialog overflow: Escape did not close the dialog" },
        );

        // The nav panel is resizable (ADR 024) and keyboard-first: the splitter
        // has to answer the arrow keys and hold its documented 180px floor.
        const splitter = () => browser.execute(() => {
          const handle = document.querySelector(".nav-resizer");
          const nav = document.querySelector(".app-nav");
          return {
            present: !!handle,
            now: handle ? Number(handle.getAttribute("aria-valuenow")) : null,
            min: handle ? Number(handle.getAttribute("aria-valuemin")) : null,
            max: handle ? Number(handle.getAttribute("aria-valuemax")) : null,
            role: handle ? handle.getAttribute("role") : null,
            orientation: handle ? handle.getAttribute("aria-orientation") : null,
            focused: handle === document.activeElement,
            width: nav ? nav.getBoundingClientRect().width : 0,
          };
        });
        const splitterStart = await splitter();
        assert(splitterStart.present, "Nav resize: the nav panel has no resize handle");
        assert.equal(splitterStart.role, "separator",
          "Nav resize: the resize handle is not exposed as a separator");
        assert.equal(splitterStart.orientation, "vertical",
          "Nav resize: the resize handle does not say which axis it resizes");
        await browser.execute(() => document.querySelector(".nav-resizer").focus());
        await browser.keys("\uE014");
        await browser.waitUntil(
          async () => {
            const state = await splitter();
            return state.focused && state.now > splitterStart.now;
          },
          {
            timeout: WAIT_MS,
            interval: 100,
            timeoutMsg: `Nav resize: ArrowRight did not widen the nav panel from ${splitterStart.now}px`,
          },
        );
        const splitterRight = await splitter();
        await browser.keys("\uE012");
        await browser.waitUntil(
          async () => (await splitter()).now === splitterStart.now,
          {
            timeout: WAIT_MS,
            interval: 100,
            timeoutMsg: `Nav resize: ArrowLeft did not narrow the nav panel back from ${splitterRight.now}px`,
          },
        );
        await browser.keys("\uE011");
        await browser.waitUntil(
          async () => (await splitter()).now === 180,
          {
            timeout: WAIT_MS,
            interval: 100,
            timeoutMsg: "Nav resize: Home did not move the nav panel to its 180px floor",
          },
        );
        const splitterMin = await splitter();
        assert.equal(splitterMin.min, 180,
          `Nav resize: the handle advertises a ${splitterMin.min}px floor, not 180px`);
        assert(
          Math.abs(splitterMin.width - 180) <= 2,
          `Nav resize: the nav panel did not follow its handle to the floor (${Math.round(splitterMin.width)}px)`,
        );
        await browser.keys("\uE010");
        await browser.waitUntil(
          async () => (await splitter()).now === splitterMin.max,
          {
            timeout: WAIT_MS,
            interval: 100,
            timeoutMsg: `Nav resize: End did not move the nav panel to its ${splitterMin.max}px ceiling`,
          },
        );
        const splitterMax = await splitter();
        assert(
          Math.abs(splitterMax.width - splitterMax.now) <= 2,
          `Nav resize: the nav panel did not follow its handle to the ceiling `
          + `(${Math.round(splitterMax.width)}px, handle says ${splitterMax.now}px)`,
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
        // dialog must hand focus back to, and it is the keyboard tab stop. The
        // contextmenu event is dispatched because Shift+F10 support differs
        // between the WebKit and WebView2 drivers; everything after that is
        // real key input, so the menu's own keyboard handling opens the dialog.
        await browser.execute((id) => {
          const row = document.querySelector(`.nav-host-row[data-host-id="${id}"]`);
          const button = row?.querySelector(".nav-item");
          if (!row || !button) throw new Error(`no nav row for ${id}`);
          button.focus();
          row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 120, clientY: 240 }));
        }, hostId);
        // Safe: a single awaited wait, never acted on or re-queried.
        await (await browser.$('.ctx-item[data-action="configure"]')).waitForExist({ timeout: WAIT_MS });
        const menuFocus = await browser.execute(() => {
          const menu = document.querySelector("#nav-context-menu");
          const first = menu?.querySelector(".ctx-item:not(.ctx-disabled)");
          const active = document.activeElement;
          return {
            ok: !!first && active === first,
            menu: !!menu,
            first: first?.textContent?.trim() ?? null,
            active: `${active?.tagName?.toLowerCase() ?? "?"}${active?.id ? `#${active.id}` : ""}`
              + `${active?.className ? `.${String(active.className).trim().split(/\s+/).join(".")}` : ""}`
              + ` (${(active?.textContent ?? "").trim().slice(0, 40)})`,
          };
        });
        assert(
          menuFocus.ok,
          `NetBox configure: opening the context menu must move focus to its first item `
          + `(menu ${menuFocus.menu ? `present, first item ${JSON.stringify(menuFocus.first)}` : "missing"}; `
          + `focus is on ${menuFocus.active})`,
        );
        let reached = false;
        for (let step = 0; step < 12; step += 1) {
          reached = await browser.execute(() =>
            document.activeElement?.dataset?.action === "configure");
          if (reached) break;
          await browser.action("key").down("\uE015").up("\uE015").perform();
        }
        assert(reached, "NetBox configure: ArrowDown never reached the Configure menu item");
        await browser.action("key").down("\uE007").up("\uE007").perform();
        // Safe: a single awaited wait, never acted on or re-queried.
        await (await browser.$("#nb-cfg-title")).waitForExist({ timeout: WAIT_MS });

        assert.deepEqual(await browser.execute(() => window.__comndSmoke.unnamed(".modal-panel")), [],
          "NetBox configure: the dialog has controls with no accessible name");
        await assertModalTrap(browser, ".modal-panel", "NetBox configure", {
          expectedControls: [
            "input.form-input",
            "input.form-input",
            "input",
            "textarea.form-input",
            "button#nb-cfg-cancel.btn-text",
            "button.btn-primary",
          ],
        });

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
      // Asserts on the byte-comparison helper itself; booting an app for it
      // would cost a full launch to test no app behaviour.
      needsApp: false,
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

  // A mutation run boots the same app with COMND_SMOKE_MUTATION set and drives
  // only the scenario that regression is supposed to break. The expected
  // failure must name the assertion and carry proof that the frontend (or, for
  // ssh_send, the app) applied the mutation, so a broken seam cannot pass
  // silently. Every requested category runs here, in one process after one
  // build, so proving all seven costs seven scenario boots rather than seven
  // full `tauri build` runs.
  if (mutationCategories) {
    const failures = [];
    for (const category of mutationCategories) {
      try {
        const result = await runMutation(category, tests);
        console.log(`PASS ${result.name} — ${result.expected}`);
      } catch (error) {
        failures.push(error.message);
        console.error(`FAIL ${error.message}`);
      }
    }
    if (failures.length) throw new Error(failures.join("\n"));
    return;
  }

  await runSuite(tests, { ...sshSuite, jobs: parseJobs(process.argv) });
}

/** Prove one mutation category breaks exactly the scenario it is meant to. */
async function runMutation(category, tests) {
  const suite = mutationSuite(category);
  try {
    if (category === "ssh_send") {
      return {
        name: "mutation-check",
        expected: (await runCase({
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
        }, suite)).expected,
      };
    }

    const target = MUTATION_CASES[category];
    const scenario = tests.find((test) => test.name === target.scenario);
    assert(scenario, `mutation ${category} names an unknown scenario ${target.scenario}`);
    return {
      name: `mutation-${category}`,
      expected: (await runCase({
        name: `mutation-${category}`,
        expectedFailure: target.expectedFailure,
        run: async (browser, dataDir) => {
          try {
            await scenario.run(browser, dataDir);
          } catch (error) {
            throw new Error(`${error.message}; ${await categoryActivation(browser, category)}`);
          }
          throw new Error(
            `passed, but the ${category} mutation was supposed to break it; `
            + await categoryActivation(browser, category),
          );
        },
      }, suite)).expected,
    };
  } catch (error) {
    throw new Error(
      `mutation-${category === "ssh_send" ? "check" : category}: the ${category} regression was not proven active: `
      + error.message,
      { cause: error },
    );
  }
}

main().catch((error) => {
  console.error(error.stack ?? error);
  process.exit(1);
});
