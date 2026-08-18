/**
 * Pure host/group filtering and tree helpers for the host screen.
 * No DOM — testable in isolation.
 */
import { Host, HostGroup } from "./tauri-api";

export const ALL_GROUP_ID = "__all__";

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

/** Filter hosts by group (incl. sub-groups) and search query, sorted recently-connected first. */
export function filterHosts(
  hosts: Host[],
  groups: HostGroup[],
  selectedGroupId: string,
  searchQuery: string,
): Host[] {
  let result = [...hosts];

  if (selectedGroupId !== ALL_GROUP_ID) {
    const groupIds = groupAndDescendantIds(groups, selectedGroupId);
    result = result.filter((h) => h.group_id && groupIds.has(h.group_id));
  }

  const q = searchQuery.toLowerCase().trim();
  if (q) {
    result = result.filter(
      (h) =>
        h.display_name.toLowerCase().includes(q) ||
        h.hostname.toLowerCase().includes(q) ||
        h.username.toLowerCase().includes(q) ||
        h.platform.toLowerCase().includes(q) ||
        (h.notes ?? "").toLowerCase().includes(q) ||
        h.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }

  result.sort((a, b) => {
    const aTime = a.last_connected ? new Date(a.last_connected).getTime() : 0;
    const bTime = b.last_connected ? new Date(b.last_connected).getTime() : 0;
    if (aTime !== bTime) return bTime - aTime;
    return a.sort_order - b.sort_order;
  });

  return result;
}
