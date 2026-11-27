import { describe, expect, it } from "vitest";
import { sessionTabLabels } from "./session-label";

describe("session tab labels", () => {
  it("uses the display name alone for the only session to a host", () => {
    const labels = sessionTabLabels([
      { sessionId: 1, hostId: "netbox:201", displayName: "core-rtr" },
    ]);
    expect(labels.get(1)).toEqual({
      label: "core-rtr",
      suffix: "",
      accessibleLabel: "core-rtr",
    });
  });

  it("adds the tab bar's position suffix for duplicate sessions", () => {
    const labels = sessionTabLabels([
      { sessionId: 1, hostId: "netbox:201", displayName: "core-rtr" },
      { sessionId: 2, hostId: "user-edge", displayName: "edge" },
      { sessionId: 3, hostId: "netbox:201", displayName: "core-rtr" },
    ]);
    expect(labels.get(1)).toEqual({
      label: "core-rtr",
      suffix: ", session 1 of 2",
      accessibleLabel: "core-rtr, session 1 of 2",
    });
    expect(labels.get(3)).toEqual({
      label: "core-rtr",
      suffix: ", session 2 of 2",
      accessibleLabel: "core-rtr, session 2 of 2",
    });
    // A different host is still its own first session.
    expect(labels.get(2)?.accessibleLabel).toBe("edge");
  });
});
