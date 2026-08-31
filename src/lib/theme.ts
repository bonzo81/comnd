import type { ITheme } from "@xterm/xterm";

export type Theme = "dark" | "light";

const APP_KEY = "netssh-theme";
const TERMINAL_KEY = "netssh-terminal-theme";

export function getAppTheme(): Theme {
  return localStorage.getItem(APP_KEY) === "light" ? "light" : "dark";
}

export function setAppTheme(t: Theme): void {
  localStorage.setItem(APP_KEY, t);
  document.documentElement.dataset.theme = t;
  window.dispatchEvent(new CustomEvent("netssh:theme", { detail: t }));
}

export function getTerminalTheme(): Theme {
  return localStorage.getItem(TERMINAL_KEY) === "light" ? "light" : "dark";
}

export function setTerminalTheme(t: Theme): void {
  localStorage.setItem(TERMINAL_KEY, t);
  window.dispatchEvent(new CustomEvent("netssh:terminal-theme", { detail: t }));
}

export const TERMINAL_THEMES: Record<Theme, ITheme> = {
  dark: { background: "#0F172A", foreground: "#F8FAFC", cursor: "#22C55E", selectionBackground: "#334155" },
  light: { background: "#F8FAFC", foreground: "#0F172A", cursor: "#16A34A", selectionBackground: "#CBD5E1" },
};
