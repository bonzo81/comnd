// Pure tab transition logic — DOM side effects stay in main.ts.
// Tabs are keyed by session id (not host id): two live sessions to the same
// host are independent tabs, so closing or activating one never touches the
// other.
export interface TabState<K extends string | number = string> {
  id: K;
  active: boolean;
}

export function activateTab<K extends string | number>(tabs: TabState<K>[], id: K): TabState<K>[] {
  return tabs.map((t) => ({ ...t, active: t.id === id }));
}

export function closeTab<K extends string | number>(tabs: TabState<K>[], id: K): TabState<K>[] {
  if (!tabs.some((t) => t.id === id)) return tabs;
  const next = tabs.filter((t) => t.id !== id);
  if (next.length === 0) return next;
  // Activate last remaining tab
  return next.map((t, i) => ({ ...t, active: i === next.length - 1 }));
}
