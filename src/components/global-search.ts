/**
 * Global Search — titlebar search box for hosts or KB commands.
 *
 * A segmented toggle (Hosts | Commands) selects the mode. Results render in a
 * fixed-position dropdown below the titlebar. Arrow keys / Tab navigate;
 * Enter activates (connect to host / open KB command detail).
 */

import { Host, Command, getHosts, listKbPlatforms, getAllKbCommands } from "../lib/tauri-api";
import { escHtml } from "../lib/format";
import { moveListItem } from "../lib/listbox-nav";
import { icons } from "../lib/icons";
import { getSearchIncludeTags } from "../lib/search-prefs";

type Mode = "hosts" | "commands";

interface CommandHit {
  platform: string;
  cmd: Command;
}

interface ResultRow {
  kind: "host" | "command";
  host?: Host;
  cmd?: Command;
  platform?: string;
  primary: string;
  secondary: string;
}

export class GlobalSearch {
  private onConnect: (host: Host) => void;
  private onOpenCommand: (platform: string, cmd: Command) => void;

  private wrapper: HTMLElement;
  private toggle: HTMLElement;
  private input: HTMLInputElement;
  private results: HTMLElement;

  private mode: Mode = "hosts";
  private rows: ResultRow[] = [];
  private selectedIdx = 0;
  private open = false;

  // ponytail: in-memory cache of all commands — fine at KB scale; add a
  // Rust-side search command only if the KB grows to tens of thousands.
  private allCommands: CommandHit[] | null = null;
  private commandsLoading = false;

  private debounceTimer: number | null = null;
  private hoverTimer: number | null = null;

  constructor(
    container: HTMLElement,
    onConnect: (host: Host) => void,
    onOpenCommand: (platform: string, cmd: Command) => void,
  ) {
    this.onConnect = onConnect;
    this.onOpenCommand = onOpenCommand;

    this.wrapper = document.createElement("div");
    this.wrapper.className = "title-bar-search";
    this.wrapper.style.setProperty("-webkit-app-region", "no-drag");

    this.input = document.createElement("input");
    this.input.type = "text";
    this.input.className = "title-bar-search-input";
    this.input.placeholder = "Search hosts…";
    this.input.setAttribute("role", "combobox");
    this.input.setAttribute("aria-expanded", "false");
    this.input.setAttribute("aria-label", "Global search");
    this.input.setAttribute("aria-autocomplete", "list");
    this.input.setAttribute("aria-controls", "global-search-results");
    this.input.addEventListener("input", () => this.onInput());
    this.input.addEventListener("keydown", (e) => this.onKeydown(e));
    this.input.addEventListener("focus", () => {
      if (this.input.value.trim()) this.updateResults();
    });

    this.toggle = document.createElement("div");
    this.toggle.className = "title-bar-search-toggle";
    const hostsBtn = document.createElement("button");
    hostsBtn.type = "button";
    hostsBtn.className = "title-bar-search-seg active";
    hostsBtn.innerHTML = icons.monitor;
    hostsBtn.title = "Search hosts";
    hostsBtn.setAttribute("aria-label", "Search hosts");
    hostsBtn.addEventListener("click", () => this.setMode("hosts"));
    const cmdsBtn = document.createElement("button");
    cmdsBtn.type = "button";
    cmdsBtn.className = "title-bar-search-seg";
    cmdsBtn.innerHTML = icons.settings;
    cmdsBtn.title = "Search commands";
    cmdsBtn.setAttribute("aria-label", "Search commands");
    cmdsBtn.addEventListener("click", () => this.setMode("commands"));
    this.toggle.appendChild(hostsBtn);
    this.toggle.appendChild(cmdsBtn);

    this.wrapper.appendChild(this.input);
    this.wrapper.appendChild(this.toggle);
    container.appendChild(this.wrapper);

    // Results panel — fixed below the titlebar, aligned to the input's left edge
    this.results = document.createElement("div");
    this.results.className = "title-bar-search-results hidden";
    this.results.id = "global-search-results";
    this.results.setAttribute("role", "listbox");
    this.results.setAttribute("aria-label", "Search results");
    this.results.addEventListener("mouseenter", () => this.cancelHide());
    this.results.addEventListener("mouseleave", () => this.scheduleHide());
    this.wrapper.addEventListener("mouseleave", () => this.scheduleHide());
    document.body.appendChild(this.results);
    window.addEventListener("resize", () => {
      if (this.open) this.positionResults();
    });

    this.positionResults();
  }

  /** Focus the search input (global "/" shortcut). */
  focus() {
    this.input.focus();
    this.input.select();
  }

  private setMode(mode: Mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    this.toggle.querySelectorAll<HTMLElement>(".title-bar-search-seg").forEach((el) => {
      el.classList.toggle("active", el.getAttribute("aria-label") === (mode === "hosts" ? "Search hosts" : "Search commands"));
    });
    this.input.placeholder = mode === "hosts" ? "Search hosts…" : "Search commands…";
    this.input.value = "";
    this.rows = [];
    this.selectedIdx = 0;
    this.closeResults();
    if (mode === "commands") void this.ensureCommands();
  }

  private async ensureCommands() {
    if (this.allCommands || this.commandsLoading) return;
    this.commandsLoading = true;
    try {
      const platforms = await listKbPlatforms();
      const hits = await Promise.all(
        platforms.map(async (p) => {
          const cmds = await getAllKbCommands(p);
          return cmds.map((cmd) => ({ platform: p, cmd }));
        }),
      );
      this.allCommands = hits.flat();
    } catch (err) {
      console.error("global-search: failed to load commands:", err);
      this.allCommands = [];
    } finally {
      this.commandsLoading = false;
    }
  }

  private onInput() {
    if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(() => this.updateResults(), 120);
  }

  private updateResults() {
    const q = this.input.value.toLowerCase().trim();
    if (!q) {
      this.rows = [];
      this.closeResults();
      return;
    }
    if (this.mode === "hosts") {
      void this.loadHostResults(q);
    } else {
      void this.loadCommandResults(q);
    }
  }

  private async loadHostResults(q: string) {
    let hosts: Host[];
    try {
      hosts = await getHosts();
    } catch {
      hosts = [];
    }
    if (this.input.value.toLowerCase().trim() !== q) return; // stale
    this.rows = hosts
      .filter(
        (h) =>
          h.display_name.toLowerCase().includes(q) ||
          h.hostname.toLowerCase().includes(q) ||
          h.tags.some((t) => t.toLowerCase().includes(q)),
      )
      .map((h) => ({
        kind: "host" as const,
        host: h,
        primary: h.display_name,
        secondary: `${h.hostname}:${h.port}`,
      }));
    this.selectedIdx = 0;
    this.renderResults();
  }

  private async loadCommandResults(q: string) {
    await this.ensureCommands();
    if (this.input.value.toLowerCase().trim() !== q) return; // stale
    const hits = (this.allCommands ?? []).filter(({ cmd }) => {
      if (cmd.name.toLowerCase().includes(q)) return true;
      if (cmd.aliases.some((a) => a.toLowerCase().includes(q))) return true;
      if (getSearchIncludeTags() && cmd.tags.some((t) => t.toLowerCase().includes(q))) return true;
      return false;
    });
    this.rows = hits.map(({ platform, cmd }) => ({
      kind: "command" as const,
      cmd,
      platform,
      primary: cmd.name,
      secondary: `${platform} · ${cmd.category || "uncategorized"}`,
    }));
    this.selectedIdx = 0;
    this.renderResults();
  }

  private renderResults() {
    this.open = true;
    this.results.classList.remove("hidden");
    this.positionResults();
    this.input.setAttribute("aria-expanded", "true");
    this.results.innerHTML =
      this.rows.length === 0
        ? `<div class="title-bar-search-row title-bar-search-empty">No results</div>`
        : this.rows
            .map((row, i) => {
              const icon = row.kind === "host" ? icons.monitor : icons.settings;
              return `
              <div class="title-bar-search-row${i === this.selectedIdx ? " selected" : ""}"
                   data-index="${i}" role="option" tabindex="-1" aria-selected="${i === this.selectedIdx}">
                <span class="title-bar-search-row-icon">${icon}</span>
                <span class="title-bar-search-row-text">
                  <span class="title-bar-search-row-primary">${escHtml(row.primary)}</span>
                  <span class="title-bar-search-row-secondary">${escHtml(row.secondary)}</span>
                </span>
              </div>`;
            })
            .join("");
    this.results.querySelectorAll<HTMLElement>(".title-bar-search-row[data-index]").forEach((el) => {
      el.addEventListener("click", () => this.activate(this.rows[Number(el.dataset.index)]));
      el.addEventListener("mouseenter", () => {
        this.selectedIdx = Number(el.dataset.index);
        this.markSelected();
      });
    });
  }

  private markSelected() {
    this.results.querySelectorAll<HTMLElement>(".title-bar-search-row[data-index]").forEach((el) => {
      const sel = Number(el.dataset.index) === this.selectedIdx;
      el.classList.toggle("selected", sel);
      el.setAttribute("aria-selected", String(sel));
    });
    this.scrollSelectedIntoView();
  }

  private scrollSelectedIntoView() {
    const sel = this.results.querySelector<HTMLElement>(".title-bar-search-row.selected");
    if (!sel) return;
    const c = this.results;
    const above = sel.offsetTop - c.offsetTop < c.scrollTop;
    const below = sel.offsetTop - c.offsetTop + sel.offsetHeight > c.scrollTop + c.clientHeight;
    if (above) c.scrollTop = sel.offsetTop - c.offsetTop;
    else if (below) c.scrollTop = sel.offsetTop - c.offsetTop + sel.offsetHeight - c.clientHeight;
  }

  private positionResults() {
    const rect = this.input.getBoundingClientRect();
    this.results.style.left = `${rect.left}px`;
    this.results.style.top = `${rect.bottom}px`;
  }

  private openResults() {
    if (this.open) return;
    if (this.rows.length > 0) this.renderResults();
  }

  private closeResults() {
    this.open = false;
    this.results.classList.add("hidden");
    this.input.setAttribute("aria-expanded", "false");
  }

  private scheduleHide() {
    this.cancelHide();
    this.hoverTimer = window.setTimeout(() => this.closeResults(), 200);
  }

  private cancelHide() {
    if (this.hoverTimer !== null) {
      window.clearTimeout(this.hoverTimer);
      this.hoverTimer = null;
    }
  }

  private onKeydown(e: KeyboardEvent) {
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp":
        e.preventDefault();
        if (!this.open) this.openResults();
        moveListItem(this.rows.length, this.selectedIdx, (i) => {
          this.selectedIdx = i;
          this.markSelected();
        }, e.key === "ArrowDown" ? 1 : -1);
        break;
      case "Tab":
        if (this.open && this.rows.length > 0) {
          e.preventDefault();
          this.selectedIdx = e.shiftKey
            ? (this.selectedIdx - 1 + this.rows.length) % this.rows.length
            : (this.selectedIdx + 1) % this.rows.length;
          this.markSelected();
        } else {
          // No results open — Tab cycles Hosts | Commands mode
          e.preventDefault();
          e.stopPropagation();
          this.setMode(this.mode === "hosts" ? "commands" : "hosts");
        }
        break;
      case "Enter":
        if (this.open && this.rows.length > 0) {
          e.preventDefault();
          this.activate(this.rows[this.selectedIdx]);
        }
        break;
      case "Escape":
        e.preventDefault();
        this.closeResults();
        this.input.blur();
        break;
    }
  }

  private activate(row: ResultRow | undefined) {
    if (!row) return;
    if (row.kind === "host" && row.host) {
      this.onConnect(row.host);
    } else if (row.kind === "command" && row.cmd && row.platform) {
      this.onOpenCommand(row.platform, row.cmd);
    }
    this.input.value = "";
    this.rows = [];
    this.selectedIdx = 0;
    this.closeResults();
    this.input.blur();
  }
}
