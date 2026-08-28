/**
 * Accessibility helpers shared across components.
 *
 * Context menus in this app are plain divs (.context-menu / .ctx-item). These
 * helpers give them the WAI-ARIA menu pattern: role="menu"/"menuitem",
 * initial focus on the first item, Arrow/Home/End navigation, Enter/Space
 * activation, and Escape/Tab to dismiss.
 */

/** Wire role + keyboard interaction on a rendered context menu. */
export function initContextMenu(menu: HTMLElement, onClose: () => void): void {
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-orientation", "vertical");
  menu.querySelectorAll<HTMLElement>(".ctx-item").forEach((el) => {
    el.setAttribute("role", "menuitem");
    if (!el.hasAttribute("tabindex")) el.tabIndex = -1;
  });

  const items = menu.querySelectorAll<HTMLElement>(".ctx-item:not(.ctx-disabled)");
  if (items.length > 0) items[0].focus();

  menu.addEventListener("keydown", (e: KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        e.stopPropagation();
        moveMenuFocus(items, 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        e.stopPropagation();
        moveMenuFocus(items, -1);
        break;
      case "Home":
        e.preventDefault();
        items[0]?.focus();
        break;
      case "End":
        e.preventDefault();
        items[items.length - 1]?.focus();
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        e.stopPropagation();
        (document.activeElement as HTMLElement | null)?.click();
        break;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        onClose();
        break;
      case "Tab":
        e.preventDefault();
        onClose();
        break;
    }
  });
}

function moveMenuFocus(items: NodeListOf<HTMLElement>, delta: number): void {
  const current = Array.from(items).indexOf(document.activeElement as HTMLElement);
  const next = current < 0 ? 0 : (current + delta + items.length) % items.length;
  items[next]?.focus();
}

/** Set aria-pressed on a toggle button and keep the accessible label in sync. */
export function setToggleState(btn: HTMLElement, pressed: boolean, label: string): void {
  btn.setAttribute("aria-pressed", String(pressed));
  btn.setAttribute("aria-label", label);
  btn.title = label;
}
