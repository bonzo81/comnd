/**
 * Global toast notifications (bottom-right stack).
 */

import { escHtml } from "./format";
import { icons } from "./icons";

let toastContainer: HTMLElement | null = null;

function getToastContainer(): HTMLElement {
  if (!toastContainer || !document.body.contains(toastContainer)) {
    const existing = document.getElementById("toast-container");
    if (existing) {
      toastContainer = existing;
      return toastContainer;
    }
    const container = document.createElement("div");
    container.id = "toast-container";
    container.className = "toast-container";
    container.setAttribute("role", "status");
    container.setAttribute("aria-live", "polite");
    document.body.appendChild(container);
    toastContainer = container;
  }
  return toastContainer;
}

export function showToast(message: string, type: "success" | "error" | "info" = "info", duration = 4000) {
  const container = getToastContainer();
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  if (type === "error") toast.setAttribute("role", "alert");
  const iconsByType: Record<string, string> = { success: icons.check, error: icons.x, info: icons.info };
  toast.innerHTML = `
    <span class="toast-icon">${iconsByType[type] ?? icons.info}</span>
    <span class="toast-message">${escHtml(message)}</span>
    <button class="toast-close" aria-label="Dismiss notification">&times;</button>
  `;
  toast.querySelector(".toast-close")?.addEventListener("click", () => toast.remove());
  container.appendChild(toast);
  const remove = () => {
    if (!document.body.contains(toast)) return;
    toast.style.opacity = "0";
    toast.style.transition = "opacity 0.3s ease";
    setTimeout(() => { if (document.body.contains(toast)) toast.remove(); }, 300);
  };
  setTimeout(remove, duration);
}
