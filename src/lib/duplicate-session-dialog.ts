/**
 * Duplicate-session dialog — thin adapter over openModal.
 *
 * Shown when the user connects to a host that already has a live session and
 * the resolved policy is "ask". Reuses the shared modal shell so Escape,
 * backdrop dismiss, focus trap and focus restore match every other dialog.
 */

import { escHtml } from "./format";
import { openModal } from "./modal";
import type { DuplicateSessionPolicy } from "./duplicate-session";

export interface DuplicateSessionDialogOptions {
  /** Host entry name shown to the user (device name, not the host id). */
  deviceName: string;
  /** True when the session cap is already reached. */
  atLimit: boolean;
  /** Effective session cap; only used in the at-limit explanation. */
  maxSessions: number;
}

export interface DuplicateSessionDialogResult {
  choice: "new" | "focus" | "cancel";
  /** True when the user ticked "Remember my choice" and the choice is storable. */
  remember: boolean;
}

/**
 * Resolves with the user's choice. Escape, backdrop click and Cancel all
 * resolve `cancel`, which means no session and no tab switch.
 */
export function openDuplicateSessionDialog(
  opts: DuplicateSessionDialogOptions,
): Promise<DuplicateSessionDialogResult> {
  const name = escHtml(opts.deviceName);

  return new Promise((resolve) => {
    const body = opts.atLimit
      ? `<p class="modal-intro">The session limit of ${opts.maxSessions} is reached, so a second session cannot be opened. Switch to the session that is already running?</p>`
      : `<p class="modal-intro">Open a second session to this device, or switch to the session that is already running?</p>`;

    const limitHint = opts.atLimit
      ? `<p class="form-hint duplicate-session-limit">Close a session to open another.</p>`
      : "";

    const newButton = opts.atLimit
      ? ""
      : `<button type="button" class="btn-primary duplicate-session-new">Open another session</button>`;

    const handle = openModal({
      panelClass: "duplicate-session-dialog",
      content: `
        <h3 id="duplicate-session-title">${name} is already connected</h3>
        ${body}
        ${limitHint}
        <label class="duplicate-session-remember-row">
          <input type="checkbox" class="duplicate-session-remember" />
          <span>Remember my choice</span>
        </label>
        <div class="form-actions">
          <button type="button" class="btn-text duplicate-session-cancel">Cancel</button>
          <button type="button" class="${opts.atLimit ? "btn-primary" : "btn-text"} duplicate-session-focus">Go to existing session</button>
          ${newButton}
        </div>
      `,
      // Focus starts on the primary action: a new session when offered, the
      // existing session when the limit leaves no second session.
      initialFocus: opts.atLimit ? ".duplicate-session-focus" : ".duplicate-session-new",
      onDismiss: () => resolve({ choice: "cancel", remember: false }),
    });

    handle.panel.setAttribute("aria-labelledby", "duplicate-session-title");

    const rememberBox = handle.panel.querySelector<HTMLInputElement>(".duplicate-session-remember")!;
    const finish = (choice: DuplicateSessionDialogResult["choice"]) => {
      // Cancelling is not a preference worth remembering.
      const remember = choice !== "cancel" && rememberBox.checked;
      handle.close();
      resolve({ choice, remember });
    };

    handle.panel
      .querySelector<HTMLButtonElement>(".duplicate-session-cancel")!
      .addEventListener("click", () => finish("cancel"));
    handle.panel
      .querySelector<HTMLButtonElement>(".duplicate-session-focus")!
      .addEventListener("click", () => finish("focus"));
    handle.panel
      .querySelector<HTMLButtonElement>(".duplicate-session-new")
      ?.addEventListener("click", () => finish("new"));
  });
}

/** Policy to persist for a remembered choice, or null when nothing is storable. */
export function policyForRememberedChoice(
  choice: DuplicateSessionDialogResult["choice"],
  remember: boolean,
): DuplicateSessionPolicy | null {
  if (!remember) return null;
  if (choice === "new") return "allow";
  if (choice === "focus") return "focus";
  return null;
}
