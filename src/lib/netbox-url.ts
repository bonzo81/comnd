/**
 * NetBox links for the side-panel tab.
 *
 * The undocked window has no app config, and external navigation must go
 * through `openUrl` rather than a WebView link. The main window therefore
 * composes every URL from the configured NetBox base URL and stores it in the
 * published snapshot; the renderer only draws the value it receives.
 *
 * An item with no NetBox id, or an app with no usable base URL, stays plain
 * text: a link that cannot be resolved is never rendered.
 */

import type {
  NetBoxDeviceInterface,
  NetBoxDeviceSubnet,
  NetBoxDeviceSummary,
  NetBoxDeviceVlan,
} from "./tauri-api";
import type { NetBoxResolvedPeer } from "./netbox-peer";

export interface NetBoxLinkedInterface extends NetBoxDeviceInterface {
  url: string | null;
}

export interface NetBoxLinkedVlan extends NetBoxDeviceVlan {
  url: string | null;
}

export interface NetBoxLinkedSubnet extends NetBoxDeviceSubnet {
  url: string | null;
}

export interface NetBoxLinkedPeer extends NetBoxResolvedPeer {
  url: string | null;
}

/** The summary after peer resolution and URL composition, as published. */
export interface NetBoxLinkedSummary
  extends Omit<NetBoxDeviceSummary, "interfaces" | "vlans" | "subnets" | "peers"> {
  url: string | null;
  device_type_url: string | null;
  site_url: string | null;
  location_url: string | null;
  rack_url: string | null;
  interfaces: NetBoxLinkedInterface[];
  vlans: NetBoxLinkedVlan[];
  subnets: NetBoxLinkedSubnet[];
  peers: NetBoxLinkedPeer[];
}

/**
 * Normalise the configured base URL. NetBox's own routes are appended, so a
 * trailing slash is dropped; a base that is empty, relative or not HTTP(S)
 * yields null and every item renders as text.
 */
export function netboxBaseUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.origin}${path}`;
  } catch {
    return null;
  }
}

function objectUrl(
  baseUrl: string | null,
  route: string,
  id: number | null | undefined,
): string | null {
  if (!baseUrl || id == null) return null;
  return `${baseUrl}/${route}/${id}/`;
}

export function netboxDeviceUrl(baseUrl: string | null, id: number | null | undefined): string | null {
  return objectUrl(baseUrl, "dcim/devices", id);
}

export function netboxSiteUrl(baseUrl: string | null, id: number | null | undefined): string | null {
  return objectUrl(baseUrl, "dcim/sites", id);
}

export function netboxLocationUrl(baseUrl: string | null, id: number | null | undefined): string | null {
  return objectUrl(baseUrl, "dcim/locations", id);
}

export function netboxRackUrl(baseUrl: string | null, id: number | null | undefined): string | null {
  return objectUrl(baseUrl, "dcim/racks", id);
}

export function netboxDeviceTypeUrl(baseUrl: string | null, id: number | null | undefined): string | null {
  return objectUrl(baseUrl, "dcim/device-types", id);
}

export function netboxInterfaceUrl(baseUrl: string | null, id: number | null | undefined): string | null {
  return objectUrl(baseUrl, "dcim/interfaces", id);
}

export function netboxVlanUrl(baseUrl: string | null, id: number | null | undefined): string | null {
  return objectUrl(baseUrl, "ipam/vlans", id);
}

export function netboxPrefixUrl(baseUrl: string | null, id: number | null | undefined): string | null {
  return objectUrl(baseUrl, "ipam/prefixes", id);
}

/**
 * Attach a URL to every object the panel can link, using the resolved peers
 * the main window already produced. Pure: the renderer and the undocked window
 * receive the result, never a lookup.
 */
export function linkNetboxSummary(
  summary: NetBoxDeviceSummary,
  rawBaseUrl: string | null,
  peers: readonly NetBoxResolvedPeer[],
): NetBoxLinkedSummary {
  const baseUrl = netboxBaseUrl(rawBaseUrl);
  return {
    ...summary,
    url: netboxDeviceUrl(baseUrl, summary.netbox_id),
    device_type_url: netboxDeviceTypeUrl(baseUrl, summary.device_type_id),
    site_url: netboxSiteUrl(baseUrl, summary.site_id),
    location_url: netboxLocationUrl(baseUrl, summary.location_id),
    rack_url: netboxRackUrl(baseUrl, summary.rack_id),
    interfaces: summary.interfaces.map((iface) => ({
      ...iface,
      url: netboxInterfaceUrl(baseUrl, iface.id),
    })),
    vlans: summary.vlans.map((vlan) => ({
      ...vlan,
      url: netboxVlanUrl(baseUrl, vlan.id),
    })),
    subnets: summary.subnets.map((subnet) => ({
      ...subnet,
      url: netboxPrefixUrl(baseUrl, subnet.id),
    })),
    peers: peers.map((peer) => ({
      ...peer,
      url: netboxDeviceUrl(baseUrl, peer.netbox_id),
    })),
  };
}
