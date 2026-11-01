import { describe, expect, it } from "vitest";
import {
  ALL_GROUP_ID,
  NETBOX_GROUP_ID,
  groupAndDescendantIds,
  hostMatches,
  isNetboxGroup,
  isNetboxHost,
  isNetboxHostId,
  recentHosts,
  sortByRecent,
} from "./host-filters";
import type { Host, HostGroup } from "./tauri-api";

const host = (overrides: Partial<Host> = {}): Host => ({
  id: "h-1",
  display_name: "Test Host",
  hostname: "10.0.0.1",
  port: 22,
  username: "admin",
  credential: { type: "password" },
  platform: "linux-bash",
  os_version: null,
  highlight_profile: null,
  notes: null,
  last_connected: null,
  created_at: "2026-01-01T00:00:00.000Z",
  sort_order: 0,
  tags: [],
  group_id: null,
  source: null,
  ...overrides,
});

const hostGroup = (overrides: Partial<HostGroup> = {}): HostGroup => ({
  id: "g-1",
  name: "Test Group",
  parent_id: null,
  sort_order: 0,
  color: null,
  icon: null,
  created_at: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

describe("isNetboxHost", () => {
  it("is true for a NetBox-sourced host", () => {
    expect(isNetboxHost(host({ source: "netbox" }))).toBe(true);
  });

  it("is true for a host whose id carries the netbox prefix", () => {
    expect(isNetboxHost(host({ id: "netbox:42" }))).toBe(true);
  });

  it("is false for a user-created host", () => {
    expect(isNetboxHost(host())).toBe(false);
  });
});

describe("netbox id guards", () => {
  it("detects the netbox host prefix only at the start", () => {
    expect(isNetboxHostId("netbox:7")).toBe(true);
    expect(isNetboxHostId("host-netbox:7")).toBe(false);
  });

  it("detects synthetic netbox groups", () => {
    expect(isNetboxGroup(NETBOX_GROUP_ID)).toBe(true);
    expect(isNetboxGroup(`${NETBOX_GROUP_ID}-region-eu`)).toBe(true);
    expect(isNetboxGroup(ALL_GROUP_ID)).toBe(false);
  });
});

describe("groupAndDescendantIds", () => {
  it("includes children and grandchildren regardless of order", () => {
    const groups = [
      hostGroup({ id: "grandchild", parent_id: "child" }),
      hostGroup({ id: "child", parent_id: "root" }),
      hostGroup({ id: "root", parent_id: null }),
      hostGroup({ id: "unrelated", parent_id: null }),
    ];
    const ids = groupAndDescendantIds(groups, "root");
    expect([...ids].sort()).toEqual(["child", "grandchild", "root"]);
  });

  it("returns only the id for a leaf group", () => {
    const ids = groupAndDescendantIds([hostGroup({ id: "leaf", parent_id: "root" })], "leaf");
    expect([...ids]).toEqual(["leaf"]);
  });

  it("does not loop forever on a parent cycle", () => {
    const groups = [
      hostGroup({ id: "a", parent_id: "b" }),
      hostGroup({ id: "b", parent_id: "a" }),
    ];
    expect([...groupAndDescendantIds(groups, "a")].sort()).toEqual(["a", "b"]);
  });
});

describe("hostMatches", () => {
  const h = host({
    display_name: "Core Router",
    hostname: "10.0.0.1",
    username: "netops",
    platform: "cisco-iosxe",
    notes: "London DC",
    tags: ["production"],
  });

  it("matches an empty query", () => {
    expect(hostMatches(h, "   ")).toBe(true);
  });

  it("matches each searchable field, case-insensitively", () => {
    expect(hostMatches(h, "core")).toBe(true);
    expect(hostMatches(h, "10.0.0")).toBe(true);
    expect(hostMatches(h, "NETOPS")).toBe(true);
    expect(hostMatches(h, "iosxe")).toBe(true);
    expect(hostMatches(h, "london")).toBe(true);
    expect(hostMatches(h, "produc")).toBe(true);
  });

  it("rejects a query no field contains", () => {
    expect(hostMatches(h, "sydney")).toBe(false);
  });
});

describe("recentHosts", () => {
  it("drops hosts that were never connected and sorts newest first", () => {
    const out = recentHosts([
      host({ id: "never", last_connected: null }),
      host({ id: "older", last_connected: "2026-01-01T00:00:00.000Z" }),
      host({ id: "newer", last_connected: "2026-02-01T00:00:00.000Z" }),
    ]);
    expect(out.map((x) => x.id)).toEqual(["newer", "older"]);
  });

  it("breaks a last_connected tie by sort_order", () => {
    const same = "2026-01-01T00:00:00.000Z";
    const out = recentHosts([
      host({ id: "second", last_connected: same, sort_order: 1 }),
      host({ id: "first", last_connected: same, sort_order: 0 }),
    ]);
    expect(out.map((x) => x.id)).toEqual(["first", "second"]);
  });

  it("keeps never-connected hosts last when sorting by recency", () => {
    const out = sortByRecent([
      host({ id: "never", last_connected: null, sort_order: 0 }),
      host({ id: "connected", last_connected: "2026-01-01T00:00:00.000Z", sort_order: 5 }),
    ]);
    expect(out.map((x) => x.id)).toEqual(["connected", "never"]);
  });
});
