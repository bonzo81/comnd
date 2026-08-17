/**
 * Platform metadata helpers — single source of truth for platform
 * badge/label/color mappings used across components.
 */

export const PLATFORM_META: Record<string, { badge: string; label: string }> = {
  "cisco-iosxe": { badge: "IOS", label: "Cisco IOS-XE" },
  "cisco-nxos": { badge: "NXOS", label: "Cisco NX-OS" },
  "f5-tmos": { badge: "F5", label: "F5 TMOS" },
  "linux-bash": { badge: "BASH", label: "Linux Bash" },
};

export const PLATFORM_COLOR_CLASS: Record<string, string> = {
  "cisco-iosxe": "badge-iosxe",
  "cisco-nxos": "badge-nxos",
  "f5-tmos": "badge-tmos",
  "linux-bash": "badge-bash",
};

export function platformBadge(platform: string): string {
  return PLATFORM_META[platform]?.badge ?? platform.toUpperCase().slice(0, 4);
}

export function platformColorClass(platform: string): string {
  return PLATFORM_COLOR_CLASS[platform] ?? "";
}

export function getPlatformMeta(platform: string): { badge: string; label: string } {
  return PLATFORM_META[platform] ?? { badge: platform.slice(0, 4).toUpperCase(), label: platform };
}
