import { afterEach, describe, expect, it } from "vitest";
import { openDuplicateSessionDialog, policyForRememberedChoice } from "./duplicate-session-dialog";

function panel(): HTMLElement {
  return document.querySelector<HTMLElement>(".duplicate-session-dialog")!;
}

afterEach(() => {
  document.querySelectorAll("body > .modal-backdrop").forEach((el) => el.remove());
});

describe("openDuplicateSessionDialog", () => {
  it("names the device and exposes an accessible name", async () => {
    const result = openDuplicateSessionDialog({
      deviceName: "core-sw1",
      atLimit: false,
      maxSessions: 0,
    });
    const dialog = panel();
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBe("duplicate-session-title");
    expect(dialog.textContent).toContain("core-sw1 is already connected");
    expect(dialog.textContent).toContain("switch to the session that is already running");
    dialog.querySelector<HTMLButtonElement>(".duplicate-session-cancel")!.click();
    await expect(result).resolves.toEqual({ choice: "cancel", remember: false });
  });

  it("focuses the primary action and offers all three choices", () => {
    openDuplicateSessionDialog({ deviceName: "core-sw1", atLimit: false, maxSessions: 0 });
    expect(document.activeElement).toBe(panel().querySelector(".duplicate-session-new"));
    expect(panel().querySelector(".duplicate-session-focus")).not.toBeNull();
    expect(panel().querySelector(".duplicate-session-cancel")).not.toBeNull();
  });

  it("offers no second session at the limit and focuses the existing one", async () => {
    const result = openDuplicateSessionDialog({
      deviceName: "core-sw1",
      atLimit: true,
      maxSessions: 4,
    });
    const dialog = panel();
    expect(dialog.querySelector(".duplicate-session-new")).toBeNull();
    expect(dialog.querySelector(".duplicate-session-focus")).not.toBeNull();
    expect(dialog.querySelector(".duplicate-session-cancel")).not.toBeNull();
    expect(dialog.textContent).toContain("session limit of 4 is reached");
    expect(document.activeElement).toBe(dialog.querySelector(".duplicate-session-focus"));
    dialog.querySelector<HTMLButtonElement>(".duplicate-session-focus")!.click();
    await expect(result).resolves.toEqual({ choice: "focus", remember: false });
  });

  it("resolves cancel on Escape", async () => {
    const result = openDuplicateSessionDialog({
      deviceName: "core-sw1",
      atLimit: false,
      maxSessions: 0,
    });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    await expect(result).resolves.toEqual({ choice: "cancel", remember: false });
  });

  it("reports the remembered choice", async () => {
    const result = openDuplicateSessionDialog({
      deviceName: "core-sw1",
      atLimit: false,
      maxSessions: 0,
    });
    panel().querySelector<HTMLInputElement>(".duplicate-session-remember")!.checked = true;
    panel().querySelector<HTMLButtonElement>(".duplicate-session-new")!.click();
    await expect(result).resolves.toEqual({ choice: "new", remember: true });
  });
});

describe("policyForRememberedChoice", () => {
  it("maps storable choices to policies", () => {
    expect(policyForRememberedChoice("new", true)).toBe("allow");
    expect(policyForRememberedChoice("focus", true)).toBe("focus");
  });

  it("stores nothing when the box is unticked or the user cancels", () => {
    expect(policyForRememberedChoice("new", false)).toBeNull();
    expect(policyForRememberedChoice("focus", false)).toBeNull();
    expect(policyForRememberedChoice("cancel", true)).toBeNull();
  });
});
