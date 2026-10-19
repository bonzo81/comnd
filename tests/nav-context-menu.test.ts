import { describe, it, expect, beforeEach, vi } from "vitest";
import { NavPanel, NavCallbacks } from "../src/components/nav-panel";
import { createHarness, Harness } from "./harness";

describe("nav panel context menu", () => {
  let container: HTMLElement;
  let panel: NavPanel;
  let h: Harness;
  const cb = {} as Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    h = createHarness();
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

    localStorage.removeItem("comnd.nav.expandedGroups");
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

  it("opens a NetBox host menu on a host revealed by expanding locations", async () => {
    const rootId = "__netbox__";
    const siteId = "__netbox__:site:dc1";
    const locationId = "__netbox__:loc:rack-1";
    h.ipc.mock("get_hosts", [h.fixtures.host({
      id: "netbox:42",
      display_name: "switch-42",
      group_id: locationId,
      source: "netbox",
    })]);
    h.ipc.mock("get_host_groups", [
      h.fixtures.hostGroup({ id: rootId, name: "NetBox", icon: "netbox" }),
      h.fixtures.hostGroup({ id: siteId, name: "DC1", parent_id: rootId }),
      h.fixtures.hostGroup({ id: locationId, name: "Rack 1", parent_id: siteId }),
    ]);

    await panel.mount();
    for (const id of [rootId, siteId, locationId]) {
      const group = container.querySelector<HTMLElement>(`.nav-item[data-group-id="${id}"]`);
      expect(group, `group ${id} should be visible`).toBeTruthy();
      group!.click();
    }

    const host = row("netbox:42");
    host.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 80, clientY: 120 }));

    expect(container.querySelector("#nav-context-menu")).toBeTruthy();
    expect(container.querySelector('.ctx-item[data-action="configure"]')).toBeTruthy();
    expect(cb.onSelectHost).not.toHaveBeenCalled();
  });

  it("opens a group menu on a subgroup revealed by expansion", async () => {
    h.ipc.mock("get_host_groups", [
      h.fixtures.hostGroup({ id: "parent", name: "Parent" }),
      h.fixtures.hostGroup({ id: "child", name: "Child", parent_id: "parent" }),
    ]);

    await panel.mount();
    container.querySelector<HTMLElement>('.nav-item[data-group-id="parent"]')!.click();
    const child = container.querySelector<HTMLElement>('.nav-item[data-group-id="child"]')!;
    child.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));

    expect(container.querySelector("#nav-context-menu")).toBeTruthy();
    expect(container.querySelector('.ctx-item[data-action="rename"]')).toBeTruthy();
  });
});
