// Pure tab transition logic — DOM side effects stay in main.ts.
export interface TabState {
  hostId: string;
  active: boolean;
}

export function activateTab(tabs: TabState[], hostId: string): TabState[] {
  return tabs.map((t) => ({ ...t, active: t.hostId === hostId }));
}

export function closeTab(tabs: TabState[], hostId: string): TabState[] {
  if (!tabs.some((t) => t.hostId === hostId)) return tabs;
  const next = tabs.filter((t) => t.hostId !== hostId);
  if (next.length === 0) return next;
  // Activate last remaining tab
  return next.map((t, i) => ({ ...t, active: i === next.length - 1 }));
}
