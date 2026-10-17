import { describe, expect, it } from "vitest";
import type { Host } from "./tauri-api";
import { HOST_TOOLTIP_ID, HostTooltip, hostTooltipRows, renderHostTooltipHtml } from "./host-tooltip";

function makeHost(overrides: Partial<Host> = {}): Host {
  return {
    id: "h1",
    display_name: "Core Router",
    hostname: "192.168.1.1",
    port: 22,
    username: "admin",
    platform: "cisco-iosxe",
    os_version: "17.6",
    highlight_profile: null,
    notes: "rack A4, keep secret",
    last_connected: null,
    created_at: "2026-01-01T00:00:00Z",
    sort_order: 0,
    tags: ["core"],
    group_id: "folder/lab",
    source: null,
    ...overrides,
  };
}

describe("hostTooltipRows", () => {
  it("shows hostname, port, platform, and os version when set", () => {
    expect(hostTooltipRows(makeHost())).toEqual([
      { label: "Hostname/IP", value: "192.168.1.1" },
      { label: "Port", value: "22" },
      { label: "Platform", value: "Cisco IOS-XE" },
      { label: "OS Version", value: "17.6" },
    ]);
  });

  it("omits the os version row entirely when null — no empty row, no 'null'", () => {
    const rows = hostTooltipRows(makeHost({ os_version: null }));
    expect(rows.map((r) => r.label)).toEqual(["Hostname/IP", "Port", "Platform"]);
  });

  it("also omits the os version row when it is an empty string", () => {
    const rows = hostTooltipRows(makeHost({ os_version: "" }));
    expect(rows).toHaveLength(3);
    expect(rows.some((r) => r.value === "")).toBe(false);
  });

  it("maps known platforms to their display label and falls back to the raw id", () => {
    expect(hostTooltipRows(makeHost({ platform: "cisco-nxos" }))[2].value).toBe("Cisco NX-OS");
    expect(hostTooltipRows(makeHost({ platform: "custom-fw" }))[2].value).toBe("custom-fw");
  });
});

describe("renderHostTooltipHtml", () => {
  it("renders exactly one row per entry", () => {
    expect(renderHostTooltipHtml(makeHost()).match(/nav-host-tip-row/g)).toHaveLength(4);
    expect(renderHostTooltipHtml(makeHost({ os_version: null })).match(/nav-host-tip-row/g)).toHaveLength(3);
  });

  it("never includes username, site/location, folder path, or any other host field", () => {
    const html = renderHostTooltipHtml(makeHost());
    expect(html).not.toContain("admin");
    expect(html).not.toContain("rack A4");
    expect(html).not.toContain("core");
    expect(html).not.toContain("folder/lab");
    expect(html).not.toContain("Core Router");
  });

  it("escapes html in labels and values", () => {
    const html = renderHostTooltipHtml(
      makeHost({ hostname: "<script>alert(1)</script>", os_version: "<b>17</b>" }),
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>17</b>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;b&gt;17&lt;/b&gt;");
  });
});

describe("HostTooltip", () => {
  it("shows beside a row, links it via aria-describedby, and hides cleanly", () => {
    document.body.innerHTML = "";
    const tip = new HostTooltip();
    const row = document.createElement("div");
    const btn = document.createElement("button");
    btn.className = "nav-item";
    row.appendChild(btn);
    document.body.appendChild(row);

    expect(tip.visible).toBe(false);
    expect(tip.anchorRow).toBeNull();

    tip.show(makeHost(), row);
    expect(tip.visible).toBe(true);
    expect(tip.anchorRow).toBe(row);
    expect(btn.getAttribute("aria-describedby")).toBe(HOST_TOOLTIP_ID);
    const el = document.getElementById(HOST_TOOLTIP_ID);
    expect(el?.getAttribute("role")).toBe("tooltip");
    expect(el?.textContent).toContain("192.168.1.1");
    expect(el?.textContent).toContain("17.6");

    tip.hide();
    expect(tip.visible).toBe(false);
    expect(tip.anchorRow).toBeNull();
    expect(btn.hasAttribute("aria-describedby")).toBe(false);
    expect(el?.hidden).toBe(true);
  });
});