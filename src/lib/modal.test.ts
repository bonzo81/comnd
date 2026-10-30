import { afterEach, describe, expect, it, vi } from "vitest";
import { openModal } from "./modal";

function pressKey(key: string) {
  window.dispatchEvent(new KeyboardEvent("keydown", { key, cancelable: true }));
}

function getOverlay() {
  return document.querySelector<HTMLDivElement>("body > .modal-backdrop");
}

// Every modal opened here is closed afterwards. Closing removes the window
// keydown listener; a leaked listener would keep trapping Tab for later tests.
const handles: { close(): void }[] = [];

function open(opts: Parameters<typeof openModal>[0]) {
  const handle = openModal(opts);
  handles.push(handle);
  return handle;
}

afterEach(() => {
  handles.splice(0).forEach((h) => h.close());
  document.querySelectorAll("body > .modal-backdrop").forEach((el) => el.remove());
});

describe("openModal", () => {
  it("mounts a role=dialog panel inside the backdrop", () => {
    open({ content: "<p>hi</p>" });
    const overlay = getOverlay()!;
    expect(overlay).not.toBeNull();
    const panel = overlay.querySelector<HTMLElement>(".modal-panel")!;
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(panel.getAttribute("aria-modal")).toBe("true");
    expect(panel.textContent).toContain("hi");
  });

  it("applies panelClass to the panel", () => {
    open({ content: "", panelClass: "host-form" });
    expect(getOverlay()!.querySelector(".modal-panel.host-form")).not.toBeNull();
  });

  it("Escape dismisses, calls onDismiss once, and removes the listener", () => {
    const onDismiss = vi.fn();
    open({ content: "", onDismiss });
    pressKey("Escape");
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(getOverlay()).toBeNull();
    pressKey("Escape");
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("Escape with dismissOnEscape:false does not dismiss and does not propagate", () => {
    const seen = vi.fn();
    document.addEventListener("keydown", seen, true);
    try {
      open({ content: "", dismissOnEscape: false });
      pressKey("Escape");
      expect(getOverlay()).not.toBeNull();
      expect(seen).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", seen, true);
    }
  });

  it("backdrop click dismisses by default", () => {
    const onDismiss = vi.fn();
    open({ content: "", onDismiss });
    getOverlay()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(getOverlay()).toBeNull();
  });

  it("backdrop click does not dismiss when dismissOnBackdrop:false", () => {
    open({ content: "", dismissOnBackdrop: false });
    getOverlay()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(getOverlay()).not.toBeNull();
  });

  it("close() tears down without calling onDismiss", () => {
    const onDismiss = vi.fn();
    const handle = open({ content: "", onDismiss });
    handle.close();
    expect(onDismiss).not.toHaveBeenCalled();
    expect(getOverlay()).toBeNull();
  });

  it("focuses the initialFocus selector when given", () => {
    open({ content: '<button id="a">A</button><button id="b">B</button>', initialFocus: "#b" });
    expect(document.activeElement).toBe(getOverlay()!.querySelector("#b"));
  });

  it("focuses the first button by default", () => {
    open({ content: '<button id="a">A</button><button id="b">B</button>' });
    expect(document.activeElement).toBe(getOverlay()!.querySelector("#a"));
  });

  it("focuses the panel when there is no button", () => {
    open({ content: "<p>no buttons</p>" });
    const panel = getOverlay()!.querySelector<HTMLElement>(".modal-panel")!;
    expect(document.activeElement).toBe(panel);
    expect(panel.getAttribute("tabindex")).toBe("-1");
  });

  it("restores focus to the previously focused element on close", () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    try {
      trigger.focus();
      const handle = open({ content: "" });
      expect(document.activeElement).not.toBe(trigger);
      handle.close();
      expect(document.activeElement).toBe(trigger);
    } finally {
      trigger.remove();
    }
  });

  describe("focus trap", () => {
    const content =
      '<button id="a">A</button><input id="b" /><button id="c">C</button><button id="off" disabled>Off</button>';

    it("wraps Tab from the last focusable back to the first", () => {
      open({ content, initialFocus: "#c" });
      const overlay = getOverlay()!;
      const last = overlay.querySelector<HTMLElement>("#c")!;
      const first = overlay.querySelector<HTMLElement>("#a")!;
      expect(document.activeElement).toBe(last);
      const event = new KeyboardEvent("keydown", { key: "Tab", cancelable: true });
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(first);
    });

    it("wraps Shift+Tab from the first focusable to the last", () => {
      open({ content, initialFocus: "#a" });
      const overlay = getOverlay()!;
      const last = overlay.querySelector<HTMLElement>("#c")!;
      const event = new KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        cancelable: true,
      });
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(last);
    });

    it("pulls focus back inside when it escaped the panel", () => {
      const outside = document.createElement("button");
      document.body.appendChild(outside);
      try {
        open({ content, initialFocus: "#b" });
        outside.focus();
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", cancelable: true }));
        expect(document.activeElement).toBe(getOverlay()!.querySelector("#a"));
      } finally {
        outside.remove();
      }
    });

    it("leaves in-panel forward Tab alone so the browser can move focus", () => {
      open({ content, initialFocus: "#a" });
      const event = new KeyboardEvent("keydown", { key: "Tab", cancelable: true });
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    });

    it("keeps focus on the panel when it has no focusable children", () => {
      open({ content: "<p>text only</p>" });
      const panel = getOverlay()!.querySelector<HTMLElement>(".modal-panel")!;
      panel.blur();
      const event = new KeyboardEvent("keydown", { key: "Tab", cancelable: true });
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(panel);
    });
  });

  describe("stacked modals", () => {
    it("lets only the topmost modal handle Escape", () => {
      const bottom = open({ content: '<button id="b1">B</button>' });
      const top = open({ content: '<button id="t1">T</button>' });
      pressKey("Escape");
      expect(top.panel.isConnected).toBe(false);
      expect(bottom.panel.isConnected).toBe(true);
    });

    it("traps Tab inside the topmost modal only", () => {
      open({ content: '<button id="b1">B</button><button id="b2">B2</button>' });
      const top = open({
        content: '<button id="t1">T</button><button id="t2">T2</button>',
        initialFocus: "#t2",
      });
      const event = new KeyboardEvent("keydown", { key: "Tab", cancelable: true });
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(top.panel.querySelector("#t1"));
    });

    it("hands keyboard control back when the top modal closes", () => {
      const bottom = open({ content: '<button id="b1">B</button>' });
      const top = open({ content: '<button id="t1">T</button>' });
      pressKey("Escape");
      expect(top.panel.isConnected).toBe(false);
      pressKey("Escape");
      expect(bottom.panel.isConnected).toBe(false);
    });
  });
});
