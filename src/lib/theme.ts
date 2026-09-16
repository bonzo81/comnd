import type { ITheme } from "@xterm/xterm";

export const APP_THEMES = [
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
  { id: 'dracula', label: 'Dracula' },
  { id: 'monokai', label: 'Monokai' },
  { id: 'solarized-light', label: 'Solarized Light' },
  { id: 'nord', label: 'Nord' },
] as const;

export type Theme = (typeof APP_THEMES)[number]["id"];

const APP_KEY = "netssh-theme";
const TERMINAL_KEY = "netssh-terminal-theme";

export function getAppTheme(): Theme {
  const stored = localStorage.getItem(APP_KEY);
  return APP_THEMES.some((t) => t.id === stored) ? (stored as Theme) : "dark";
}

export function setAppTheme(t: Theme): void {
  localStorage.setItem(APP_KEY, t);
  document.documentElement.dataset.theme = t;
  window.dispatchEvent(new CustomEvent("netssh:theme", { detail: t }));
}

export type TerminalTheme = 'dark' | 'warm-charcoal' | 'cream' | 'light';

// Cycle order for the toolbar theme button (spec 12 §Terminal themes).
export const TERMINAL_THEME_ORDER: TerminalTheme[] = ["dark", "warm-charcoal", "cream", "light"];

export function getTerminalTheme(): TerminalTheme {
  const stored = localStorage.getItem(TERMINAL_KEY);
  return TERMINAL_THEME_ORDER.includes(stored as TerminalTheme) ? (stored as TerminalTheme) : "dark";
}

export function setTerminalTheme(t: TerminalTheme): void {
  localStorage.setItem(TERMINAL_KEY, t);
  window.dispatchEvent(new CustomEvent("netssh:terminal-theme", { detail: t }));
}

export const TERMINAL_THEMES: Record<TerminalTheme, ITheme> = {
  dark: { background: "#0F172A", foreground: "#F8FAFC", cursor: "#22C55E", selectionBackground: "#334155" },
  "warm-charcoal": { background: "#1A1A1F", foreground: "#EDEDED", cursor: "#22C55E", selectionBackground: "#3A3A42" },
  cream: { background: "#F7F0DC", foreground: "#1A1A1A", cursor: "#16A34A", selectionBackground: "#D9D0BC" },
  light: { background: "#F8FAFC", foreground: "#0F172A", cursor: "#16A34A", selectionBackground: "#CBD5E1" },
};
