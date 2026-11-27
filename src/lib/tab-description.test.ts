import { describe, expect, it } from "vitest";
import { connectionLabel, tabText, type TabHostFacts } from "./tab-description";

const host: TabHostFacts = {
  display_name: "core-rtr-lon01",
  hostname: "10.0.0.1",
  platform: "cisco-iosxe",
  os_version: "17.6",
};

describe("connectionLabel", () => {
  it("names every lifecycle the tab can show", () => {
    expect(connectionLabel("connecting")).toBe("Connecting");
    expect(connectionLabel("connected")).toBe("Connected");
    expect(connectionLabel("disconnected")).toBe("Disconnected");
    expect(connectionLabel("error")).toBe("Connection error");
  });
});

describe("tabText", () => {
  it("puts host, platform, version, mode and state in the tooltip", () => {
    expect(tabText(host, "privileged-exec", "connected").title).toBe(
      "core-rtr-lon01 — 10.0.0.1 — Cisco IOS-XE 17.6 — Privileged Exec — Connected",
    );
  });

  it("names the host in the description only once (the tab label is the name)", () => {
    expect(tabText(host, "privileged-exec", "connected").description).toBe(
      "10.0.0.1 — Cisco IOS-XE 17.6 — Privileged Exec — Connected",
    );
  });

  it("omits a missing version", () => {
    const { title } = tabText({ ...host, os_version: null }, "shell", "connecting");
    expect(title).toContain("Cisco IOS-XE —");
    expect(title).not.toContain("Cisco IOS-XE null");
  });

  it("says so when no mode has been detected yet", () => {
    expect(tabText(host, "", "connecting").description).toContain("Mode not detected");
  });
});
