/**
 * Shared confirm dialog — backdrop + message + cancel/confirm buttons.
 * One imperative overlay used by every delete/close confirmation so
 * escape handling, backdrop-click dismiss, and focus behavior match.
 */

export interface ConfirmOptions {
  title: string;
  /** May contain escHtml-escaped HTML (call sites interpolate). */
  message: string;
  confirmLabel: string;
  /** Red confirm-button styling. */
  destructive?: boolean;
  onConfirm: () => void;
}

export function confirmDialog(opts: ConfirmOptions): void {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal-panel delete-confirm" role="dialog" aria-modal="true">
      <h3>${opts.title}</h3>
      <p>${opts.message}</p>
      <div class="form-actions">
        <button class="btn-text confirm-cancel">Cancel</button>
        <button class="${opts.destructive ? "btn-danger" : "btn-primary"} confirm-ok">${opts.confirmLabel}</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);

  const okBtn = backdrop.querySelector<HTMLButtonElement>(".confirm-ok")!;
  const cancelBtn = backdrop.querySelector<HTMLButtonElement>(".confirm-cancel")!;

  const cleanup = () => {
    backdrop.remove();
    window.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation(); // keep Escape away from xterm cascade
      cleanup();
    }
  };
  window.addEventListener("keydown", onKey, true);

  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) cleanup();
  });
  cancelBtn.addEventListener("click", cleanup);
  okBtn.addEventListener("click", () => {
    cleanup();
    opts.onConfirm();
  });

  okBtn.focus();
}