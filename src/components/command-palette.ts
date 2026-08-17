/**
 * Command Palette — searchable keyboard shortcut reference
 * Opens on Ctrl+K. Escape to close.
 */

import { escHtml } from "../lib/format";

interface ShortcutItem {
  shortcut: string;
  action: string;
  context?: string;
}

const SHORTCUTS: ShortcutItem[] = [
  // Terminal shortcuts
  { shortcut: "Tab", action: "Accept ghost suggestion / pass through", context: "Terminal" },
  { shortcut: "Ctrl+Space", action: "Open suggestion dropdown", context: "Terminal" },
  { shortcut: "Escape", action: "Dismiss dropdown / panel / back to hosts", context: "Global" },
  { shortcut: "↑ / ↓", action: "Navigate dropdown / history", context: "Terminal" },
  { shortcut: "Enter", action: "Select dropdown item / send command", context: "Terminal" },
  { shortcut: "Ctrl+`", action: "Toggle side panel", context: "Terminal" },
  { shortcut: "Ctrl+Shift+W", action: "Disconnect session", context: "Terminal" },
  { shortcut: "Ctrl++", action: "Zoom in", context: "Terminal" },
  { shortcut: "Ctrl+-", action: "Zoom out", context: "Terminal" },
  { shortcut: "Ctrl+0", action: "Reset zoom", context: "Terminal" },
  { shortcut: "Ctrl+W", action: "Delete previous word (passes to remote)", context: "Terminal" },

  // Connection manager shortcuts
  { shortcut: "↑ / ↓", action: "Navigate host list", context: "Connections" },
  { shortcut: "Enter", action: "Connect to selected host", context: "Connections" },
  { shortcut: "/", action: "Focus search bar", context: "Connections" },
  { shortcut: "Ctrl+N", action: "New connection", context: "Connections" },
  { shortcut: "Delete", action: "Delete selected host", context: "Connections" },

  // Global shortcuts
  { shortcut: "Tab / Shift+Tab", action: "Move focus between elements", context: "Global" },
  { shortcut: "Ctrl+,", action: "Open settings", context: "Global" },
  { shortcut: "Ctrl+K", action: "Open this command palette", context: "Global" },
];

export class CommandPalette {
  private el: HTMLDivElement;
  private overlay: HTMLDivElement;
  private input: HTMLInputElement;
  private list: HTMLDivElement;
  private visible = false;
  private filtered: ShortcutItem[] = [];
  private selectedIndex = 0;

  constructor() {
    // Create overlay
    this.overlay = document.createElement("div");
    this.overlay.className = "cmd-palette-overlay hidden";
    this.overlay.addEventListener("click", (e) => {
      if (e.target === this.overlay) this.hide();
    });

    // Create palette panel
    this.el = document.createElement("div");
    this.el.className = "cmd-palette";

    // Header
    const header = document.createElement("div");
    header.className = "cmd-palette-header";
    header.textContent = "Keyboard Shortcuts";

    // Search input
    this.input = document.createElement("input");
    this.input.type = "text";
    this.input.className = "cmd-palette-input";
    this.input.placeholder = "Search shortcuts...";
    this.input.addEventListener("input", () => this.filter());
    this.input.addEventListener("keydown", (e) => this.onKeydown(e));

    // List container
    this.list = document.createElement("div");
    this.list.className = "cmd-palette-list";

    this.el.appendChild(header);
    this.el.appendChild(this.input);
    this.el.appendChild(this.list);
    this.overlay.appendChild(this.el);
    document.body.appendChild(this.overlay);

    this.filtered = SHORTCUTS;
  }

  /** Show the command palette */
  show() {
    this.visible = true;
    this.overlay.classList.remove("hidden");
    this.input.value = "";
    this.filtered = SHORTCUTS;
    this.selectedIndex = 0;
    this.render();
    this.input.focus();
  }

  /** Hide the command palette */
  hide() {
    this.visible = false;
    this.overlay.classList.add("hidden");
  }

  /** Is the palette currently visible? */
  isVisible(): boolean {
    return this.visible;
  }

  /** Clean up DOM */
  destroy() {
    this.overlay.remove();
  }

  private filter() {
    const query = this.input.value.toLowerCase();
    this.filtered = SHORTCUTS.filter(
      (s) =>
        s.action.toLowerCase().includes(query) ||
        s.shortcut.toLowerCase().includes(query) ||
        (s.context?.toLowerCase().includes(query) ?? false)
    );
    this.selectedIndex = 0;
    this.render();
  }

  private onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      this.hide();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      this.selectedIndex = (this.selectedIndex + 1) % this.filtered.length;
      this.render();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      this.selectedIndex = (this.selectedIndex - 1 + this.filtered.length) % this.filtered.length;
      this.render();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      // Just keep it open — palette is reference only
      return;
    }
  }

  private render() {
    if (this.filtered.length === 0) {
      this.list.innerHTML = `<div class="cmd-palette-empty">No shortcuts found</div>`;
      return;
    }

    this.list.innerHTML = this.filtered
      .map((item, i) => {
        const selected = i === this.selectedIndex ? " selected" : "";
        return `<div class="cmd-palette-item${selected}" data-index="${i}">
          <span class="cmd-palette-shortcut">${escHtml(item.shortcut)}</span>
          <span class="cmd-palette-action">${escHtml(item.action)}</span>
          <span class="cmd-palette-context">${escHtml(item.context ?? "")}</span>
        </div>`;
      })
      .join("");

    // Scroll selected into view
    const selectedEl = this.list.querySelector(".selected") as HTMLElement;
    if (selectedEl) {
      selectedEl.scrollIntoView({ block: "nearest" });
    }
  }
}
