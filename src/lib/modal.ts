/**
 * Shared modal shell ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â backdrop + panel + Escape/backdrop dismiss + focus.
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
    (el) =>
      !el.hasAttribute("disabled") &&
      el.tabIndex >= 0 &&
      !el.hidden &&
      // Sections collapsed by CSS keep their inputs focusable (credential
      // fields that do not apply to the chosen auth type), so skip them.
      !el.closest(".auth-conditional-hidden"),
  );
}

/**
 * Open modals, bottom-most first. Only the topmost one handles Escape and Tab,
 * so a dialog opened over another (the shortcuts help over the duplicate-session
 * prompt, say) cannot fight the covered one for focus.
 */
const openModals: object[] = [];

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
  const token = {};
  openModals.push(token);
  const isTopmost = () => openModals[openModals.length - 1] === token;

  const onKey = (e: KeyboardEvent) => {
    if (!isTopmost()) return;
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
    // An index lookup covers the panel itself and anything outside it, both of
    // which must wrap, without trusting the event's modifier state.
    const index = active ? focusables.indexOf(active) : -1;
    if (e.shiftKey) {
      if (index <= 0) {
        e.preventDefault();
        e.stopPropagation();
        last.focus();
      }
    } else if (index === -1 || index === focusables.length - 1) {
      e.preventDefault();
      e.stopPropagation();
      first.focus();
    }
  };

  // Focus can also leave the panel without a Tab keydown this handler can
  // read: a webdriver can perform a backwards move while reporting
  // shiftKey: false, and assistive tooling can focus an element directly.
  // Watch where focus lands instead of trusting the key event.
  let restoringFocus = false;
  const onFocusIn = (e: FocusEvent) => {
    if (closed || restoringFocus || !isTopmost()) return;
    const target = e.target as Node | null;
    if (target && panel.contains(target)) return;
    const focusables = focusableIn(panel);
    if (focusables.length === 0) {
      panel.focus();
      return;
    }
    // Re-enter from the side the focus left: a target that precedes the panel
    // in document order means focus was moving backwards.
    const backwards =
      target instanceof Node &&
      (target.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    restoringFocus = true;
    try {
      (backwards ? focusables[focusables.length - 1] : focusables[0]).focus();
    } finally {
      restoringFocus = false;
    }
  };
  const close = () => {
    if (closed) return;
    closed = true;
    backdrop.remove();
    window.removeEventListener("keydown", onKey, true);
    document.removeEventListener("focusin", onFocusIn, true);
    const stackIndex = openModals.indexOf(token);
    if (stackIndex >= 0) openModals.splice(stackIndex, 1);
    if (previouslyFocused && previouslyFocused.isConnected) previouslyFocused.focus();
  };
  const dismiss = () => {
    close();
    opts.onDismiss?.();
  };

  window.addEventListener("keydown", onKey, true);
  document.addEventListener("focusin", onFocusIn, true);

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
