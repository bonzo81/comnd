import { describe, expect, it } from "vitest";
import {
  linkNetboxSummary,
  netboxBaseUrl,
  netboxDeviceTypeUrl,
  netboxDeviceUrl,
  netboxInterfaceUrl,
  netboxLocationUrl,
  netboxPrefixUrl,
  netboxRackUrl,
  netboxSiteUrl,
  netboxVlanUrl,
} from "./netbox-url";
import type { NetBoxDeviceSummary } from "./tauri-api";
import type { NetBoxResolvedPeer } from "./netbox-peer";

const base = netboxBaseUrl("https://nb.example.com/netbox/");

describe("NetBox URL composition", () => {
  it("normalises a configured base URL and rejects unusable ones", () => {
    expect(netboxBaseUrl("  https://nb.example.com/netbox/  ")).toBe(
      "https://nb.example.com/netbox",
    );
    expect(netboxBaseUrl("https://nb.example.com")).toBe("https://nb.example.com");
    expect(netboxBaseUrl("")).toBeNull();
    expect(netboxBaseUrl(null)).toBeNull();
    expect(netboxBaseUrl("nb.example.com")).toBeNull();
    expect(netboxBaseUrl("ftp://nb.example.com")).toBeNull();
  });

  it("builds the NetBox route for every linkable object type", () => {
    expect(netboxDeviceUrl(base, 201)).toBe(
      "https://nb.example.com/netbox/dcim/devices/201/",
    );
    expect(netboxSiteUrl(base, 7)).toBe("https://nb.example.com/netbox/dcim/sites/7/");
    expect(netboxLocationUrl(base, 9)).toBe(
      "https://nb.example.com/netbox/dcim/locations/9/",
    );
    expect(netboxRackUrl(base, 4)).toBe("https://nb.example.com/netbox/dcim/racks/4/");
    expect(netboxDeviceTypeUrl(base, 3)).toBe(
      "https://nb.example.com/netbox/dcim/device-types/3/",
    );
    expect(netboxInterfaceUrl(base, 11)).toBe(
      "https://nb.example.com/netbox/dcim/interfaces/11/",
    );
    expect(netboxVlanUrl(base, 501)).toBe("https://nb.example.com/netbox/ipam/vlans/501/");
    expect(netboxPrefixUrl(base, 601)).toBe(
      "https://nb.example.com/netbox/ipam/prefixes/601/",
    );
  });

  it("stays plain when the base URL or the id is missing", () => {
    expect(netboxDeviceUrl(null, 201)).toBeNull();
    expect(netboxDeviceUrl(base, null)).toBeNull();
    expect(netboxVlanUrl(base, undefined)).toBeNull();
  });

  it("attaches links to summary items and resolved peers", () => {
    const summary: NetBoxDeviceSummary = {
      netbox_id: 201,
      name: "tab-device",
      status: "active",
      status_label: "Active",
      tags: ["prod"],
      device_type: "Cisco C9300-48P",
      device_type_id: 3,
      site: "DC1 London",
      site_id: 7,
      location: "Rack 1",
      location_id: 9,
      rack: "rack-1",
      rack_id: 4,
      position: 12.5,
      face: "front",
      primary_ip: "127.0.0.1/32",
      interfaces: [
        {
          id: 11,
          name: "GigabitEthernet1/0/1",
          addresses: [{ address: "10.0.0.10/24", vrf: null }],
        },
      ],
      vlans: [{ id: 501, vid: 10, name: "users", group_id: 1, group: "DC1" }],
      subnets: [{ id: 601, prefix: "10.0.0.0/24", vrf: null }],
      peers: [{ netbox_id: 202, name: "core", display: null, primary_ip: null }],
    };
    const peers: NetBoxResolvedPeer[] = [
      {
        netbox_id: 202,
        name: "core",
        display: null,
        primary_ip: null,
        hostId: "netbox:202",
        label: "core",
        sessionId: 9,
        sessionLabel: "core, session 1 of 2",
      },
    ];

    const linked = linkNetboxSummary(summary, "https://nb.example.com/netbox/", peers);
    expect(linked.url).toBe("https://nb.example.com/netbox/dcim/devices/201/");
    expect(linked.device_type_url).toBe(
      "https://nb.example.com/netbox/dcim/device-types/3/",
    );
    expect(linked.site_url).toBe("https://nb.example.com/netbox/dcim/sites/7/");
    expect(linked.location_url).toBe("https://nb.example.com/netbox/dcim/locations/9/");
    expect(linked.rack_url).toBe("https://nb.example.com/netbox/dcim/racks/4/");
    expect(linked.interfaces[0].url).toBe(
      "https://nb.example.com/netbox/dcim/interfaces/11/",
    );
    expect(linked.vlans[0].url).toBe("https://nb.example.com/netbox/ipam/vlans/501/");
    expect(linked.subnets[0].url).toBe(
      "https://nb.example.com/netbox/ipam/prefixes/601/",
    );
    expect(linked.peers[0].url).toBe(
      "https://nb.example.com/netbox/dcim/devices/202/",
    );
    expect(linked.peers[0].sessionId).toBe(9);
    expect(linked.peers[0].sessionLabel).toBe("core, session 1 of 2");
  });

  it("nulls every link when no base URL is configured", () => {
    const summary: NetBoxDeviceSummary = {
      netbox_id: 201,
      name: "tab-device",
      status: "active",
      status_label: "Active",
      tags: [],
      device_type: null,
      device_type_id: 3,
      site: null,
      site_id: null,
      location: null,
      location_id: null,
      rack: null,
      rack_id: null,
      position: null,
      face: null,
      primary_ip: null,
      interfaces: [],
      vlans: [],
      subnets: [],
      peers: [],
    };
    const linked = linkNetboxSummary(summary, null, []);
    expect(linked.url).toBeNull();
    expect(linked.device_type_url).toBeNull();
  });
});
