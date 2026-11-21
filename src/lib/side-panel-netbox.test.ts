import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness } from "../../tests/harness";
import {
  __resetSidePanel,
  clearSidePanelNetboxHost,
  getSidePanelState,
  openSidePanel,
  retrySidePanelNetbox,
  setSidePanelMode,
  setSidePanelNetboxHost,
} from "./side-panel";
import { renderSidePanel, type SidePanelHandlers } from "./side-panel-render";
import type { NetBoxDeviceSummary } from "./tauri-api";

beforeEach(() => __resetSidePanel());
afterEach(() => __resetSidePanel());

function summary(over: Partial<NetBoxDeviceSummary> = {}): NetBoxDeviceSummary {
  return {
    netbox_id: 201,
    name: "tab-device",
    status: "active",
    status_label: "Active",
    device_type: "Cisco C9300-48P",
    site: "DC1 London",
    location: "Rack 1",
    rack: "rack-1",
    position: 12.5,
    face: "front",
    primary_ip: "127.0.0.1/32",
    interfaces: [],
    ...over,
  };
}

function handlers(over: Partial<SidePanelHandlers> = {}): SidePanelHandlers {
  return {
    play: vi.fn(),
    add: vi.fn(),
    runExample: vi.fn(),
    retryNetbox: () => retrySidePanelNetbox(),
    ...over,
  };
}

async function selectNetbox(hostId = "netbox:201") {
  const h = createHarness();
  const owner = {};
  h.ipc.mockImpl("netbox_get_device_summary", () => summary());
  setSidePanelNetboxHost(hostId, owner);
  setSidePanelMode("netbox");
  await vi.waitFor(() =>
    expect(getSidePanelState().snapshot).toMatchObject({ kind: "netbox", phase: "ready" }),
  );
  return { h, owner };
}

function renderCurrent() {
  const root = document.createElement("div");
  document.body.appendChild(root);
  renderSidePanel(root, getSidePanelState().snapshot, handlers());
  return root;
}

describe("NetBox side-panel tab", () => {
  it("fetches nothing until the tab is selected", async () => {
    const h = createHarness();
    h.ipc.mockImpl("netbox_get_device_summary", () => summary());

    setSidePanelNetboxHost("netbox:201", {});
    expect(getSidePanelState().netboxHostId).toBe("netbox:201");
    expect(h.ipc.calls("netbox_get_device_summary")).toHaveLength(0);

    setSidePanelMode("netbox");
    await vi.waitFor(() =>
      expect(h.ipc.calls("netbox_get_device_summary")).toHaveLength(1),
    );
  });

  it("does not offer the tab for a user host", () => {
    const h = createHarness();
    setSidePanelNetboxHost("0d5f7c2a-3b6e-4f10-9a8c-2b4c6d8e0f12", {});
    expect(getSidePanelState().netboxHostId).toBeNull();
    setSidePanelMode("netbox");
    expect(getSidePanelState().mode).toBe("kb");
    expect(h.ipc.calls("netbox_get_device_summary")).toHaveLength(0);
  });

  it("renders identity, status, device type, site, location, rack and U", async () => {
    await selectNetbox();
    const root = renderCurrent();

    expect(root.querySelector(".nbd-name")?.textContent).toBe("tab-device");
    expect(root.querySelector(".nbd-status")?.textContent).toBe("Active");
    const facts = root.textContent ?? "";
    expect(facts).toContain("Device type");
    expect(facts).toContain("Cisco C9300-48P");
    expect(facts).toContain("Site");
    expect(facts).toContain("DC1 London");
    expect(facts).toContain("Location");
    expect(facts).toContain("Rack 1");
    expect(facts).toContain("Rack / U");
    expect(facts).toContain("rack-1 · U12.5 · front");
    expect(root.textContent).not.toContain("Failed to load");
  });

  it("groups two interfaces' three addresses under their interfaces", async () => {
    const h = createHarness();
    h.ipc.mockImpl("netbox_get_device_summary", () =>
      summary({
        interfaces: [
          {
            id: 11,
            name: "GigabitEthernet1/0/1",
            addresses: [
              { address: "10.0.0.10/24", vrf: null },
              { address: "10.0.0.11/24", vrf: null },
            ],
          },
          {
            id: 12,
            name: "TenGigabitEthernet1/1/1",
            addresses: [{ address: "2001:db8::10/64", vrf: "blue" }],
          },
        ],
      }),
    );
    setSidePanelNetboxHost("netbox:201", {});
    setSidePanelMode("netbox");
    await vi.waitFor(() =>
      expect(getSidePanelState().snapshot).toMatchObject({ kind: "netbox", phase: "ready" }),
    );

    const root = renderCurrent();
    const groups = [...root.querySelectorAll(".nbd-iface")];
    expect(groups).toHaveLength(2);
    expect(groups[0].querySelector(".nbd-iface-name")?.textContent).toBe("GigabitEthernet1/0/1");
    const first = [...groups[0].querySelectorAll(".nbd-address")].map((el) => el.textContent?.trim());
    expect(first).toEqual(["10.0.0.10/24", "10.0.0.11/24"]);
    expect(groups[1].querySelector(".nbd-iface-name")?.textContent).toBe("TenGigabitEthernet1/1/1");
    expect(groups[1].querySelector(".nbd-vrf")?.textContent).toBe("blue");
  });

  it("replaces a failed fetch with an error and Retry refetches", async () => {
    const h = createHarness();
    let calls = 0;
    h.ipc.mockImpl("netbox_get_device_summary", () => {
      calls += 1;
      if (calls === 2) throw new Error("NetBox token lacks permission");
      return summary({ name: calls === 1 ? "first-device" : "second-device" });
    });

    setSidePanelNetboxHost("netbox:201", {});
    setSidePanelMode("netbox");
    await vi.waitFor(() =>
      expect(getSidePanelState().snapshot).toMatchObject({ kind: "netbox", phase: "ready" }),
    );
    const root = renderCurrent();
    expect(root.textContent).toContain("first-device");

    // Selecting the tab again is a new selection: it clears the pane first and
    // then fails. No value from the first fetch may survive.
    setSidePanelMode("netbox");
    expect(getSidePanelState().snapshot).toMatchObject({ kind: "netbox", phase: "loading" });
    renderSidePanel(root, getSidePanelState().snapshot, handlers());
    expect(root.textContent).not.toContain("first-device");

    await vi.waitFor(() =>
      expect(getSidePanelState().snapshot).toMatchObject({ kind: "netbox", phase: "error" }),
    );
    renderSidePanel(root, getSidePanelState().snapshot, handlers());
    expect(root.textContent).toContain("Failed to load NetBox device details");
    expect(root.textContent).not.toContain("first-device");
    expect(root.textContent).not.toContain("second-device");

    root.querySelector<HTMLButtonElement>(".nbd-retry")!.click();
    await vi.waitFor(() =>
      expect(getSidePanelState().snapshot).toMatchObject({ kind: "netbox", phase: "ready" }),
    );
    expect(calls).toBe(3);
    renderSidePanel(root, getSidePanelState().snapshot, handlers());
    expect(root.textContent).toContain("second-device");
    expect(root.textContent).not.toContain("first-device");
  });

  it("drops the tab and falls back to KB when the active host is a user host", async () => {
    const { owner } = await selectNetbox();
    expect(getSidePanelState().mode).toBe("netbox");

    // Hand-off order: the outgoing view clears its subject first, then the
    // incoming user host has the final word.
    clearSidePanelNetboxHost(owner);
    expect(getSidePanelState().netboxHostId).toBeNull();
    expect(getSidePanelState().mode).toBe("netbox");
    setSidePanelNetboxHost(null, {});
    expect(getSidePanelState().netboxHostId).toBeNull();
    expect(getSidePanelState().mode).toBe("kb");
    expect(getSidePanelState().snapshot).toMatchObject({ kind: "placeholder" });
  });

  it("keeps the NetBox tab live across a NetBox-to-NetBox hand-off", async () => {
    const h = createHarness();
    h.ipc.mockImpl("netbox_get_device_summary", (args) =>
      summary({
        netbox_id: Number(String(args.hostId).split(":")[1]),
        name: args.hostId === "netbox:201" ? "first-device" : "second-device",
      }),
    );
    const first = {};
    const second = {};
    // The hand-off only fetches while the panel is showing the tab.
    openSidePanel();
    setSidePanelNetboxHost("netbox:201", first);
    setSidePanelMode("netbox");
    await vi.waitFor(() =>
      expect(getSidePanelState().snapshot).toMatchObject({ kind: "netbox", phase: "ready" }),
    );

    clearSidePanelNetboxHost(first);
    setSidePanelNetboxHost("netbox:202", second);
    await vi.waitFor(() => {
      const snapshot = getSidePanelState().snapshot;
      expect(snapshot.kind).toBe("netbox");
      if (snapshot.kind === "netbox" && snapshot.phase === "ready") {
        expect(snapshot.summary.name).toBe("second-device");
      } else {
        throw new Error("the second host's summary is not ready");
      }
    });
    expect(getSidePanelState().mode).toBe("netbox");
    expect(h.ipc.calls("netbox_get_device_summary")).toHaveLength(2);
  });

  it("keeps the subject when duplicate sessions share one NetBox host id", async () => {
    const h = createHarness();
    h.ipc.mockImpl("netbox_get_device_summary", () => summary());
    const outgoing = {};
    const incoming = {};

    openSidePanel();
    setSidePanelNetboxHost("netbox:201", outgoing);
    setSidePanelMode("netbox");
    await vi.waitFor(() =>
      expect(getSidePanelState().snapshot).toMatchObject({ kind: "netbox", phase: "ready" }),
    );

    // Activation order: the incoming duplicate session publishes the same id
    // first, then the outgoing one clears. Ownership, not the id, decides.
    setSidePanelNetboxHost("netbox:201", incoming);
    clearSidePanelNetboxHost(outgoing);

    expect(getSidePanelState().netboxHostId).toBe("netbox:201");
    expect(getSidePanelState().mode).toBe("netbox");
    await vi.waitFor(() =>
      expect(getSidePanelState().snapshot).toMatchObject({ kind: "netbox", phase: "ready" }),
    );
    expect(h.ipc.calls("netbox_get_device_summary")).toHaveLength(2);
  });
});
