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

/** An address without its CIDR mask, lowercased for IPv6 comparison. */
export function bareAddress(value: string): string {
  const slash = value.indexOf("/");
  return (slash === -1 ? value : value.slice(0, slash)).trim().toLowerCase();
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
