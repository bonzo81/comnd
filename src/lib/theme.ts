import type { ITheme } from "@xterm/xterm";

export type Theme = "dark" | "light";

const APP_KEY = "netsh-theme";
const TERMINAL_KEY = "netsh-terminal-theme";

export function getAppTheme(): Theme {
  return localStorage.getItem(APP_KEY) === "light" ? "light" : "dark";
}

export function setAppTheme(t: Theme): void {
  localStorage.setItem(APP_KEY, t);
  document.documentElement.dataset.theme = t;
  window.dispatchEvent(new CustomEvent("netsh:theme", { detail: t }));
}

export function getTerminalTheme(): Theme {
  return localStorage.getItem(TERMINAL_KEY) === "light" ? "light" : "dark";
}

export function setTerminalTheme(t: Theme): void {
  localStorage.setItem(TERMINAL_KEY, t);
  window.dispatchEvent(new CustomEvent("netsh:terminal-theme", { detail: t }));
}

export const TERMINAL_THEMES: Record<Theme, ITheme> = {
  dark: { background: "#0F172A", foreground: "#F8FAFC", cursor: "#22C55E", selectionBackground: "#1E293B" },
  light: { background: "#F8FAFC", foreground: "#0F172A", cursor: "#16A34A", selectionBackground: "#E2E8F0" },
};
