/**
 * Pure host/group filtering and tree helpers.
 * No DOM — testable in isolation.
 */
import { Host, HostGroup } from "./tauri-api";

export const ALL_GROUP_ID = "__all__";

/** NetBox root group id (synthetic — rendered by get_host_groups, never editable). */
export const NETBOX_GROUP_ID = "__netbox__";

/** Whether the host id belongs to a NetBox-sourced host (`netbox:<id>`). */
export function isNetboxHostId(id: string): boolean {
  return id.startsWith("netbox:");
}

/** Whether the host was materialized by the NetBox host source. */
export function isNetboxHost(host: Host): boolean {
  return host.source === "netbox" || isNetboxHostId(host.id);
}

/** Whether the group id is one of the synthetic NetBox groups. */
export function isNetboxGroup(groupId: string): boolean {
  return groupId.startsWith(NETBOX_GROUP_ID);
}

/** All group ids reachable from `groupId` (children, grandchildren, …), order-independent. */
export function groupAndDescendantIds(groups: HostGroup[], groupId: string): Set<string> {
  const ids = new Set([groupId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const g of groups) {
      if (g.parent_id && ids.has(g.parent_id) && !ids.has(g.id)) {
        ids.add(g.id);
        changed = true;
      }
    }
  }
  return ids;
}

/** Substring match across the host's searchable fields. */
export function hostMatches(host: Host, query: string): boolean {
  const q = query.toLowerCase().trim();
  if (!q) return true;
  return (
    host.display_name.toLowerCase().includes(q) ||
    host.hostname.toLowerCase().includes(q) ||
    host.username.toLowerCase().includes(q) ||
    host.platform.toLowerCase().includes(q) ||
    (host.notes ?? "").toLowerCase().includes(q) ||
    host.tags.some((t) => t.toLowerCase().includes(q))
  );
}

/** Recently connected hosts, most recent first. */
export function recentHosts(hosts: Host[]): Host[] {
  return hosts
    .filter((h) => h.last_connected)
    .sort((a, b) => {
      const aTime = new Date(a.last_connected!).getTime();
      const bTime = new Date(b.last_connected!).getTime();
      if (aTime !== bTime) return bTime - aTime;
      return a.sort_order - b.sort_order;
    });
}

/** Sort hosts by last_connected desc (nulls last), then sort_order. */
export function sortByRecent(hosts: Host[]): Host[] {
  return [...hosts].sort((a, b) => {
    const aTime = a.last_connected ? new Date(a.last_connected).getTime() : 0;
    const bTime = b.last_connected ? new Date(b.last_connected).getTime() : 0;
    if (aTime !== bTime) return bTime - aTime;
    return a.sort_order - b.sort_order;
  });
}
