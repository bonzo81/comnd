import { describe, it, expect, beforeEach, vi } from "vitest";
import { NavPanel, NavCallbacks } from "../src/components/nav-panel";
import { createHarness, Harness } from "./harness";

describe("nav panel context menu", () => {
  let container: HTMLElement;
  let panel: NavPanel;
  const cb = {} as Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    const h = createHarness();
    h.ipc.mock("get_hosts", [
      h.fixtures.host({ id: "h1", display_name: "alpha" }),
      h.fixtures.host({ id: "h2", display_name: "beta" }),
    ]);
    h.ipc.mock("get_host_groups", []);
    for (const k of [
      "onSelectHost",
      "onConnectHost",
      "onEditHost",
      "onKbTab",
      "onNewConnection",
      "onAddHostToGroup",
      "onTreeChanged",
    ]) {
      cb[k] = vi.fn();
    }
    cb.getActiveSessions = vi.fn(() => new Set<string>());

    container = h.mount();
    panel = new NavPanel(container, cb as unknown as NavCallbacks);
  });

  function row(id: string): HTMLElement {
    const el = container.querySelector<HTMLElement>(`.nav-item[data-host-id="${id}"]`);
    expect(el, `row ${id} not rendered`).toBeTruthy();
    return el!;
  }

  function openMenuOn(id: string) {
    row(id).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
  }

  it("closes on pointerdown outside the menu (row click, where mousedown is suppressed)", async () => {
    await panel.mount();
    openMenuOn("h1");
    expect(container.querySelector("#nav-context-menu")).toBeTruthy();

    row("h2").dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0 }));

    expect(container.querySelector("#nav-context-menu")).toBeNull();
  });

  it("keeps the menu open for pointerdown inside the menu", async () => {
    await panel.mount();
    openMenuOn("h1");
    const menu = container.querySelector<HTMLElement>("#nav-context-menu")!;
    menu.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    expect(container.querySelector("#nav-context-menu")).toBeTruthy();
  });

  it("removes the menu from the DOM after clicking Edit", async () => {
    await panel.mount();
    openMenuOn("h1");
    const item = container.querySelector<HTMLElement>('.ctx-item[data-action="edit"]')!;
    item.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(cb.onEditHost).toHaveBeenCalledWith("h1");
    expect(container.querySelector("#nav-context-menu")).toBeNull();
  });

  it("removes the menu from the DOM after clicking Connect", async () => {
    await panel.mount();
    openMenuOn("h1");
    const item = container.querySelector<HTMLElement>('.ctx-item[data-action="connect"]')!;
    item.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(cb.onConnectHost).toHaveBeenCalledWith("h1");
    expect(container.querySelector("#nav-context-menu")).toBeNull();
  });
});