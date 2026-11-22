/**
 * NetBox cabled-peer identity for the side-panel NetBox tab.
 *
 * The undocked panel window renders only what the main window publishes and
 * has no host list, so the match against Comnd's hosts happens here, in the
 * main window, before the snapshot is stored or sent. The renderer receives a
 * resolved `hostId`/`label` and never looks anything up.
 *
 * Match order is the issue's: NetBox id (`netbox:<id>`), then primary IP
 * against `host.hostname`, then name against `host.display_name`. First match
 * wins. Comparisons ignore a CIDR mask and surrounding whitespace; the name
 * pass is case-insensitive because display names are free text.
 */

import type { Host, NetBoxDevicePeer } from "./tauri-api";

/** The subset of a Comnd host the matcher needs. */
export type PeerHostRef = Pick<Host, "id" | "hostname" | "display_name">;

/** The Comnd host a peer resolved to. */
export interface NetBoxPeerMatch {
  hostId: string;
  label: string;
}

/** A peer carried in the published snapshot: raw NetBox facts plus the match. */
export interface NetBoxResolvedPeer extends NetBoxDevicePeer {
  hostId: string | null;
  label: string | null;
}

/**
 * An address without its CIDR mask, made comparable. IPv6 literals are
 * canonicalised (expanded, lowercased, brackets and any zone suffix removed)
 * because host validation accepts `[2001:db8::1]` and
 * `2001:0db8:0:0:0:0:0:1` as well as the compressed form. Anything that is not
 * an IPv6 literal - a DNS name, an IPv4 address - is only trimmed and
 * lowercased.
 */
export function bareAddress(value: string): string {
  const slash = value.indexOf("/");
  let address = (slash === -1 ? value : value.slice(0, slash)).trim();
  if (address.startsWith("[") && address.endsWith("]")) {
    address = address.slice(1, -1).trim();
  }
  // A zone index is part of the link-local literal, not of the host.
  const zone = address.indexOf("%");
  if (zone !== -1) address = address.slice(0, zone).trim();
  return canonicalIpv6(address) ?? address.toLowerCase();
}

/**
 * Expand an IPv6 literal to eight hex groups with leading zeros dropped.
 * Returns null for anything that is not a valid IPv6 literal (a DNS name or a
 * plain IPv4 address). An embedded IPv4 form (`::ffff:192.0.2.1`) is expanded
 * to the two hex groups it represents, so it equals `::ffff:c000:201`.
 * Comparing the expanded forms makes `2001:db8::1` and
 * `2001:0db8:0:0:0:0:0:1` equal too.
 */
function canonicalIpv6(value: string): string | null {
  if (!value.includes(":")) return null;
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const raw = [...head, ...tail];
  // A dotted-decimal part may only be the final 32 bits, so it cannot sit
  // before a `::` zero-compression either.
  if (halves.length === 2 && head.some((group) => group.includes("."))) {
    return null;
  }
  if (raw.some((group, index) => group.includes(".") && index !== raw.length - 1)) {
    return null;
  }
  const groups = expandIpv4Tail(raw);
  if (!groups) return null;
  if (halves.length === 2) {
    if (groups.length >= 8) return null;
    const missing = 8 - groups.length;
    return [...groups.slice(0, head.length), ...Array<string>(missing).fill("0"), ...groups.slice(head.length)]
      .map((group) => parseInt(group, 16).toString(16))
      .join(":");
  }
  if (groups.length !== 8) return null;
  return groups.map((group) => parseInt(group, 16).toString(16)).join(":");
}

/**
 * Replace a trailing dotted-decimal IPv4 part with the two hex groups it
 * occupies, then validate every group. Returns null on any invalid part.
 */
function expandIpv4Tail(groups: string[]): string[] | null {
  let expanded = groups;
  const last = groups[groups.length - 1];
  if (last?.includes(".")) {
    const octets = last.split(".");
    if (octets.length !== 4) return null;
    const values = octets.map((octet) =>
      /^\d{1,3}$/.test(octet) ? Number(octet) : Number.NaN,
    );
    if (values.some((octet) => Number.isNaN(octet) || octet > 255)) return null;
    expanded = [
      ...groups.slice(0, -1),
      ((values[0] << 8) | values[1]).toString(16),
      ((values[2] << 8) | values[3]).toString(16),
    ];
  }
  if (expanded.some((group) => !/^[0-9a-fA-F]{1,4}$/.test(group))) return null;
  return expanded;
}

function match(host: PeerHostRef): NetBoxPeerMatch {
  return { hostId: host.id, label: host.display_name };
}

/** Resolve one peer against the loaded host list, in the issue's order. */
export function resolvePeerHost(
  peer: NetBoxDevicePeer,
  hosts: readonly PeerHostRef[],
): NetBoxPeerMatch | null {
  const byId = hosts.find((host) => host.id === `netbox:${peer.netbox_id}`);
  if (byId) return match(byId);

  const primary = peer.primary_ip ? bareAddress(peer.primary_ip) : "";
  if (primary) {
    const byIp = hosts.find((host) => bareAddress(host.hostname) === primary);
    if (byIp) return match(byIp);
  }

  const name = peer.name.trim().toLowerCase();
  if (name) {
    const byName = hosts.find(
      (host) => host.display_name.trim().toLowerCase() === name,
    );
    if (byName) return match(byName);
  }

  return null;
}
