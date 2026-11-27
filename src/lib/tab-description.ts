import type { SessionLifecycle } from "./duplicate-session";
import { formatMode } from "./format";
import { getPlatformMeta } from "./platforms";

/** The host facts a session tab needs for its tooltip and description. */
export interface TabHostFacts {
  display_name: string;
  hostname: string;
  platform: string;
  os_version?: string | null;
}

export interface TabText {
  /** Native hover tooltip: hover the tab to see the session at a glance. */
  title: string;
  /** Accessible description (aria-describedby target). */
  description: string;
}

/** Human wording for the connection indicator the status bar used to show. */
export function connectionLabel(status: SessionLifecycle): string {
  switch (status) {
    case "connecting":
      return "Connecting";
    case "connected":
      return "Connected";
    case "disconnected":
      return "Disconnected";
    case "error":
      return "Connection error";
  }
}

/**
 * Device facts for one session tab. The visible tab label is the display
 * name, so the description repeats the facts rather than the name; the
 * tooltip opens with the name so a duplicate session still reads as a
 * complete sentence.
 */
export function tabText(
  host: TabHostFacts,
  mode: string,
  status: SessionLifecycle,
): TabText {
  const meta = getPlatformMeta(host.platform);
  const platform = `${meta.label}${host.os_version ? ` ${host.os_version}` : ""}`;
  const modeLabel = mode ? formatMode(mode) : "Mode not detected";
  const connection = connectionLabel(status);

  return {
    title: `${host.display_name} — ${host.hostname} — ${platform} — ${modeLabel} — ${connection}`,
    description: `${host.hostname} — ${platform} — ${modeLabel} — ${connection}`,
  };
}
