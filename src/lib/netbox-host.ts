/**
 * NetBox host identity — the frontend mirror of `hosts.rs`.
 *
 * A NetBox-sourced host is encoded two ways: `Host.source === "netbox"` on the
 * materialized host, and the `netbox:<id>` host id that `materialize_host`
 * creates and `touch_host` parses back. User hosts are UUIDs with no source,
 * so neither check can match them. Keeping both checks here means the tab
 * strip, the shared panel state and the backend command agree on one rule.
 */

import type { Host } from "./tauri-api";

/** The subset of a host these predicates need. */
export type NetboxHostRef = Pick<Host, "id"> & { source?: string | null };

/** `netbox:<digits>` — the host id `materialize_host` creates. */
export function isNetboxHostId(id: string): boolean {
  const prefix = "netbox:";
  if (!id.startsWith(prefix)) return false;
  const rest = id.slice(prefix.length);
  return rest.length > 0 && /^\d+$/.test(rest);
}

/** True only for a NetBox-sourced host; a user host never qualifies. */
export function isNetboxHost(host: NetboxHostRef | null | undefined): boolean {
  if (!host) return false;
  return host.source === "netbox" || isNetboxHostId(host.id);
}
