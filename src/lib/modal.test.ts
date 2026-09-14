import { afterEach, describe, expect, it, vi } from "vitest";
import { openModal } from "./modal";

function pressKey(key: string) {
  window.dispatchEvent(new KeyboardEvent("keydown", { key, cancelable: true }));
}

function getOverlay() {
  return document.querySelector<HTMLDivElement>("body > .modal-backdrop");
}

afterEach(() => {
  document.querySelectorAll("body > .modal-backdrop").forEach((el) => el.remove());
});

describe("openModal", () => {
  it("mounts a role=dialog panel inside the backdrop", () => {
    openModal({ content: "<p>hi</p>" });
    const overlay = getOverlay()!;
    expect(overlay).not.toBeNull();
    const panel = overlay.querySelector<HTMLElement>(".modal-panel")!;
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(panel.getAttribute("aria-modal")).toBe("true");
    expect(panel.textContent).toContain("hi");
  });

  it("applies panelClass to the panel", () => {
    openModal({ content: "", panelClass: "host-form" });
    expect(getOverlay()!.querySelector(".modal-panel.host-form")).not.toBeNull();
  });

  it("Escape dismisses, calls onDismiss once, and removes the listener", () => {
    const onDismiss = vi.fn();
    openModal({ content: "", onDismiss });
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
      openModal({ content: "", dismissOnEscape: false });
      pressKey("Escape");
      expect(getOverlay()).not.toBeNull();
      expect(seen).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", seen, true);
    }
  });

  it("backdrop click dismisses by default", () => {
    const onDismiss = vi.fn();
    openModal({ content: "", onDismiss });
    getOverlay()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(getOverlay()).toBeNull();
  });

  it("backdrop click does not dismiss when dismissOnBackdrop:false", () => {
    openModal({ content: "", dismissOnBackdrop: false });
    getOverlay()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(getOverlay()).not.toBeNull();
  });

  it("close() tears down without calling onDismiss", () => {
    const onDismiss = vi.fn();
    const handle = openModal({ content: "", onDismiss });
    handle.close();
    expect(onDismiss).not.toHaveBeenCalled();
    expect(getOverlay()).toBeNull();
  });

  it("focuses the initialFocus selector when given", () => {
    openModal({ content: '<button id="a">A</button><button id="b">B</button>', initialFocus: "#b" });
    expect(document.activeElement).toBe(getOverlay()!.querySelector("#b"));
  });

  it("focuses the first button by default", () => {
    openModal({ content: '<button id="a">A</button><button id="b">B</button>' });
    expect(document.activeElement).toBe(getOverlay()!.querySelector("#a"));
  });

  it("focuses the panel when there is no button", () => {
    openModal({ content: "<p>no buttons</p>" });
    const panel = getOverlay()!.querySelector<HTMLElement>(".modal-panel")!;
    expect(document.activeElement).toBe(panel);
    expect(panel.getAttribute("tabindex")).toBe("-1");
  });

  it("restores focus to the previously focused element on close", () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    try {
      trigger.focus();
      const handle = openModal({ content: "" });
      expect(document.activeElement).not.toBe(trigger);
      handle.close();
      expect(document.activeElement).toBe(trigger);
    } finally {
      trigger.remove();
    }
  });
});
