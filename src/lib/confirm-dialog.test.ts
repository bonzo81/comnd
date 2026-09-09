import { afterEach, describe, expect, it, vi } from "vitest";
import { confirmDialog } from "./confirm-dialog";

function openDestructive(overrides: Partial<Parameters<typeof confirmDialog>[0]> = {}) {
  const onConfirm = vi.fn();
  confirmDialog({
    title: "Delete Host",
    message: "Delete <strong>fw1</strong>?",
    confirmLabel: "Delete",
    destructive: true,
    onConfirm,
    ...overrides,
  });
  return { onConfirm };
}

function pressKey(key: string) {
  window.dispatchEvent(new KeyboardEvent("keydown", { key, cancelable: true }));
}

function getOverlay() {
  return document.querySelector<HTMLDivElement>("body > .modal-backdrop");
}

afterEach(() => {
  document.querySelectorAll("body > .modal-backdrop").forEach((el) => el.remove());
});

describe("confirmDialog", () => {
  it("renders title, escaped message, and labels", () => {
    openDestructive();
    const overlay = getOverlay();
    expect(overlay).not.toBeNull();
    expect(overlay!.querySelector("h3")!.textContent).toBe("Delete Host");
    expect(overlay!.querySelector("p")!.innerHTML).toBe("Delete <strong>fw1</strong>?");
    expect(overlay!.querySelector(".confirm-ok")!.textContent).toBe("Delete");
    expect(overlay!.querySelector(".confirm-ok")!.className).toBe("btn-danger confirm-ok");
    expect(overlay!.querySelector(".confirm-cancel")!.textContent).toBe("Cancel");
  });

  it("confirm button calls back and removes overlay", () => {
    const { onConfirm } = openDestructive();
    getOverlay()!.querySelector<HTMLButtonElement>(".confirm-ok")!.click();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(getOverlay()).toBeNull();
  });

  it("cancel button removes overlay without confirming", () => {
    const { onConfirm } = openDestructive();
    getOverlay()!.querySelector<HTMLButtonElement>(".confirm-cancel")!.click();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(getOverlay()).toBeNull();
  });

  it("Escape removes overlay without confirming", () => {
    const { onConfirm } = openDestructive();
    pressKey("Escape");
    expect(onConfirm).not.toHaveBeenCalled();
    expect(getOverlay()).toBeNull();
  });

  it("backdrop click removes overlay without confirming", () => {
    const { onConfirm } = openDestructive();
    getOverlay()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(getOverlay()).toBeNull();
  });

  it("focuses the confirm button", () => {
    openDestructive();
    expect(document.activeElement).toBe(getOverlay()!.querySelector(".confirm-ok"));
  });

  it("non-destructive dialog uses primary button styling", () => {
    openDestructive({ destructive: false, confirmLabel: "Reconnect" });
    expect(getOverlay()!.querySelector(".confirm-ok")!.className).toBe("btn-primary confirm-ok");
  });
});