import { describe, expect, it } from "vitest";
import { bareAddress, resolvePeerHost } from "./netbox-peer";
import type { NetBoxDevicePeer } from "./tauri-api";

function peer(over: Partial<NetBoxDevicePeer> = {}): NetBoxDevicePeer {
  return {
    netbox_id: 300,
    name: "peer",
    display: "peer",
    primary_ip: null,
    ...over,
  };
}

const hosts = [
  { id: "netbox:201", hostname: "10.0.0.1", display_name: "core-rtr" },
  { id: "user-edge", hostname: "10.0.0.2", display_name: "edge-by-ip" },
  { id: "user-access", hostname: "access.example", display_name: "Access-SW" },
];

describe("NetBox peer → host matching", () => {
  it("strips a CIDR mask and normalises case", () => {
    expect(bareAddress("10.0.0.1/24")).toBe("10.0.0.1");
    expect(bareAddress("2001:DB8::1/64")).toBe("2001:db8::1");
    expect(bareAddress(" 10.0.0.1 ")).toBe("10.0.0.1");
  });

  it("matches by NetBox id first", () => {
    const found = resolvePeerHost(
      peer({ netbox_id: 201, name: "anything", primary_ip: "10.9.9.9/24" }),
      hosts,
    );
    expect(found).toEqual({ hostId: "netbox:201", label: "core-rtr" });
  });

  it("matches by primary IP when the host id is absent", () => {
    const found = resolvePeerHost(
      peer({ netbox_id: 202, name: "anything", primary_ip: "10.0.0.2/24" }),
      hosts,
    );
    expect(found).toEqual({ hostId: "user-edge", label: "edge-by-ip" });
  });

  it("matches by name, case-insensitively, when id and IP fail", () => {
    const found = resolvePeerHost(
      peer({ netbox_id: 203, name: "access-sw", primary_ip: "10.9.9.9/24" }),
      hosts,
    );
    expect(found).toEqual({ hostId: "user-access", label: "Access-SW" });
  });

  it("returns null for an unmatched peer", () => {
    expect(
      resolvePeerHost(peer({ netbox_id: 204, name: "ghost", primary_ip: "10.9.9.9/24" }), hosts),
    ).toBeNull();
  });

  it("keeps the id pass ahead of IP and name when all three would match", () => {
    const found = resolvePeerHost(
      peer({ netbox_id: 201, name: "Access-SW", primary_ip: "10.0.0.2/24" }),
      hosts,
    );
    expect(found?.hostId).toBe("netbox:201");
  });
});
