/**
 * Shared confirm dialog — thin adapter over openModal for the common
 * message + cancel/confirm pattern.
 */

import { openModal } from "./modal";

export interface ConfirmOptions {
  title: string;
  /** May contain escHtml-escaped HTML (call sites interpolate). */
  message: string;
  confirmLabel: string;
  /** Red confirm-button styling. */
  destructive?: boolean;
  onConfirm: () => void;
  /** Called when dismissed without confirming (cancel/Esc/backdrop). */
  onCancel?: () => void;
}

/** Returns a close function for callers that must force-teardown the dialog. */
export function confirmDialog(opts: ConfirmOptions): () => void {
  const handle = openModal({
    panelClass: "delete-confirm",
    content: `
      <h3>${opts.title}</h3>
      <p>${opts.message}</p>
      <div class="form-actions">
        <button class="btn-text confirm-cancel">Cancel</button>
        <button class="${opts.destructive ? "btn-danger" : "btn-primary"} confirm-ok">${opts.confirmLabel}</button>
      </div>
    `,
    initialFocus: ".confirm-ok",
    onDismiss: () => opts.onCancel?.(),
  });

  handle.panel
    .querySelector<HTMLButtonElement>(".confirm-cancel")!
    .addEventListener("click", () => {
      handle.close();
      opts.onCancel?.();
    });
  handle.panel
    .querySelector<HTMLButtonElement>(".confirm-ok")!
    .addEventListener("click", () => {
      handle.close();
      opts.onConfirm();
    });

  return handle.close;
}
