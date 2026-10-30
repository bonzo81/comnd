/**
 * Shared modal shell — backdrop + panel + Escape/backdrop dismiss + focus.
 * One imperative overlay for every dialog so escape handling, backdrop-click
 * dismiss, and focus behavior match. The shell owns only open/close/escape/
 * focus mechanics; content, submit, and error display stay caller-owned.
 */

export interface ModalOptions {
  /** Panel CSS class (e.g. "host-form"). Appended to `modal-panel`. */
  panelClass?: string;
  /** HTML for the modal panel's interior. */
  content: string;
  /** Close on Escape (default true). */
  dismissOnEscape?: boolean;
  /** Close on backdrop click (default true). */
  dismissOnBackdrop?: boolean;
  /** Element to focus after mount (defaults to first button, then the panel). */
  initialFocus?: string;
  /** Called when dismissed without an explicit close (Esc/backdrop). */
  onDismiss?: () => void;
}

export interface ModalHandle {
  close(): void; // force-teardown; onDismiss NOT called
  readonly panel: HTMLElement; // mount point for the caller's content
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hasAttribute("disabled") && el.tabIndex >= 0 && !el.hidden,
  );
}

export function openModal(opts: ModalOptions): ModalHandle {
  const dismissOnEscape = opts.dismissOnEscape ?? true;
  const dismissOnBackdrop = opts.dismissOnBackdrop ?? true;

  const previouslyFocused = document.activeElement as HTMLElement | null;

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  const panel = document.createElement("div");
  panel.className = `modal-panel${opts.panelClass ? " " + opts.panelClass : ""}`;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.innerHTML = opts.content;
  backdrop.appendChild(panel);
  document.body.appendChild(backdrop);

  let closed = false;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Tab") {
      trapTab(e);
      return;
    }
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation(); // keep Escape away from xterm cascade
    if (dismissOnEscape) dismiss();
  };

  // Keyboard-first: Tab and Shift+Tab cycle inside the panel instead of
  // escaping into the terminal behind the backdrop.
  const trapTab = (e: KeyboardEvent) => {
    const focusables = focusableIn(panel);
    if (focusables.length === 0) {
      e.preventDefault();
      panel.focus();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement as HTMLElement | null;
    const inside = active !== null && panel.contains(active);
    if (e.shiftKey) {
      if (!inside || active === first) {
        e.preventDefault();
        e.stopPropagation();
        last.focus();
      }
    } else if (!inside || active === last) {
      e.preventDefault();
      e.stopPropagation();
      first.focus();
    }
  };
  const close = () => {
    if (closed) return;
    closed = true;
    backdrop.remove();
    window.removeEventListener("keydown", onKey, true);
    if (previouslyFocused && previouslyFocused.isConnected) previouslyFocused.focus();
  };
  const dismiss = () => {
    close();
    opts.onDismiss?.();
  };

  window.addEventListener("keydown", onKey, true);

  if (dismissOnBackdrop) {
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) dismiss();
    });
  }

  const focusTarget =
    (opts.initialFocus ? panel.querySelector<HTMLElement>(opts.initialFocus) : null) ??
    panel.querySelector<HTMLElement>("button") ??
    panel;
  if (focusTarget === panel) panel.setAttribute("tabindex", "-1");
  focusTarget.focus();

  return { close, panel };
}
