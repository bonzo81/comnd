import { afterEach, describe, expect, it, vi } from "vitest";
import { initContextMenu, setToggleState } from "./a11y";

function menuWithItems(...specs: { role?: string; disabled?: boolean }[]) {
  const menu = document.createElement("div");
  menu.className = "context-menu";
  const items = specs.map((spec) => {
    const item = document.createElement("div");
    item.className = spec.disabled ? "ctx-item ctx-disabled" : "ctx-item";
    if (spec.role) item.setAttribute("role", spec.role);
    menu.appendChild(item);
    return item;
  });
  document.body.appendChild(menu);
  return { menu, items };
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("initContextMenu", () => {
  it("keeps a pre-declared menuitemcheckbox role and focuses the first enabled item", () => {
    const { menu, items } = menuWithItems(
      { role: "menuitemcheckbox" },
      { disabled: true },
      {},
    );
    initContextMenu(menu, () => {});

    expect(menu.getAttribute("role")).toBe("menu");
    expect(items[0].getAttribute("role")).toBe("menuitemcheckbox");
    expect(items[2].getAttribute("role")).toBe("menuitem");
    expect(items[0].tabIndex).toBe(-1);
    expect(document.activeElement).toBe(items[0]);
  });

  it("moves focus with ArrowDown/ArrowUp, Home and End, skipping disabled items", () => {
    const { menu, items } = menuWithItems({}, { disabled: true }, {});
    initContextMenu(menu, () => {});
    const press = (key: string) =>
      menu.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));

    press("ArrowDown");
    expect(document.activeElement).toBe(items[2]);
    press("ArrowDown");
    expect(document.activeElement).toBe(items[0]);
    press("ArrowUp");
    expect(document.activeElement).toBe(items[2]);
    press("Home");
    expect(document.activeElement).toBe(items[0]);
    press("End");
    expect(document.activeElement).toBe(items[2]);
  });

  it("clicks the focused item on Enter and on Space", () => {
    const { menu, items } = menuWithItems({});
    const onClick = vi.fn();
    items[0].addEventListener("click", onClick);
    initContextMenu(menu, () => {});

    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it("closes on Escape and on Tab", () => {
    const { menu } = menuWithItems({});
    const onClose = vi.fn();
    initContextMenu(menu, onClose);

    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe("setToggleState", () => {
  it("sets aria-pressed and keeps the label and tooltip in step", () => {
    const btn = document.createElement("button");
    setToggleState(btn, true, "Disable command suggestions");
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(btn.getAttribute("aria-label")).toBe("Disable command suggestions");
    expect(btn.title).toBe("Disable command suggestions");
  });
});
