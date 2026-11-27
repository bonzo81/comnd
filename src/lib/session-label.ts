// Pure tab-bar naming. The visible label is the host's display name; two
// sessions to one host share it, so the accessible name carries the position.
// The NetBox tab's Switch control reuses the same label, which is why this
// lives beside the other pure tab transition logic.

export interface SessionLabelTab {
  sessionId: number;
  hostId: string;
  displayName: string;
}

export interface SessionTabLabel {
  /** Visible text — duplicate sessions intentionally share it. */
  label: string;
  /** `, session 1 of 2`, or empty when the host has one tab. */
  suffix: string;
  /** Visible text plus the suffix — the tab's accessible name. */
  accessibleLabel: string;
}

export function sessionTabLabels(
  tabs: readonly SessionLabelTab[],
): Map<number, SessionTabLabel> {
  const totals = new Map<string, number>();
  for (const tab of tabs) {
    totals.set(tab.hostId, (totals.get(tab.hostId) ?? 0) + 1);
  }

  const seen = new Map<string, number>();
  const labels = new Map<number, SessionTabLabel>();
  for (const tab of tabs) {
    const total = totals.get(tab.hostId) ?? 1;
    const index = (seen.get(tab.hostId) ?? 0) + 1;
    seen.set(tab.hostId, index);
    const suffix = total > 1 ? `, session ${index} of ${total}` : "";
    labels.set(tab.sessionId, {
      label: tab.displayName,
      suffix,
      accessibleLabel: `${tab.displayName}${suffix}`,
    });
  }
  return labels;
}
