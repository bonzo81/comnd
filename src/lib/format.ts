/**
 * String formatting helpers — single source of truth for HTML escaping
 * and command mode title-casing used across components.
 */

export function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function formatMode(mode: string): string {
  return mode.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}
