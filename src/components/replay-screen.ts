/**
 * Replay Screen — top-level Command Replay management view (docs/09).
 *
 * Lists the user's saved commands across platforms with a platform filter.
 * Edit re-opens the save dialog pre-filled; Delete confirms inline.
 */

import { ReplayCommand, replayList, replayDelete, replaySave } from "../lib/tauri-api";
import { ReplaySaveDialog } from "./replay-save-dialog";
import { showToast } from "../lib/toast";
import { log, LogTag } from "../lib/logger";
import { escHtml } from "../lib/format";
import { platformBadge, platformColorClass } from "../lib/platforms";
import { renderReplayTemplate } from "../lib/replay";

export class ReplayScreen {
  private container: HTMLElement | null = null;
  private commands: ReplayCommand[] = [];
  private platformFilter = "all";

  /** Refresh hook so the nav panel (future badges) can stay in sync. */
  onTreeChanged: () => void = () => {};

  async mount(container: HTMLElement): Promise<void> {
    this.container = container;
    await this.refresh();
  }

  async refresh(): Promise<void> {
    try {
      this.commands = await replayList();
    } catch (e) {
      log.error(LogTag.Terminal, `Failed to load Command Replay: ${e}`);
      this.commands = [];
    }
    this.render();
  }

  private platforms(): string[] {
    return Array.from(new Set(this.commands.map((c) => c.platform))).sort();
  }

  private render(): void {
    if (!this.container) return;
    const platforms = this.platforms();
    if (this.platformFilter !== "all" && !platforms.includes(this.platformFilter)) {
      this.platformFilter = "all";
    }
    const shown = this.commands
      .filter((c) => this.platformFilter === "all" || c.platform === this.platformFilter)
      .sort((a, b) => a.platform.localeCompare(b.platform) || a.command.localeCompare(b.command));

    const options = ['<option value="all">All platforms</option>']
      .concat(platforms.map((p) => `<option value="${escHtml(p)}" ${p === this.platformFilter ? "selected" : ""}>${escHtml(platformBadge(p))}</option>`))
      .join("");

    const list = shown
      .map(
        (c) => `
        <div class="rsm-item" data-id="${escHtml(c.id)}">
          <div class="rsm-main">
            <code class="rsm-cmd">${renderReplayTemplate(c.command)}</code>
            <span class="hs-host-badge ${platformColorClass(c.platform)}">[${escHtml(platformBadge(c.platform))}]</span>
          </div>
          <div class="rsm-actions">
            <button class="btn-text rsm-edit" data-id="${escHtml(c.id)}">Edit</button>
            <button class="btn-text rsm-del" data-id="${escHtml(c.id)}">Delete</button>
          </div>
        </div>`,
      )
      .join("");

    this.container.innerHTML = `
      <div class="replay-screen">
        <div class="rsm-toolbar">
          <h2 class="rsm-title">Command Replay</h2>
          <span class="kb-count">${shown.length} command${shown.length === 1 ? "" : "s"}</span>
          <select id="rsm-platform-filter" class="form-input form-input-sm kb-platform-select" aria-label="Filter by platform">${options}</select>
          <button class="btn-primary rsm-add">+ Add Command</button>
        </div>
        ${shown.length === 0
          ? `<div class="rsm-empty">
               <p>No saved commands yet.</p>
               <p class="rsm-empty-hint">While connected, select text in the terminal and right-click → <strong>Add to Command Replay</strong>, or add one manually above.</p>
             </div>`
          : `<div class="rsm-list">${list}</div>`}
      </div>
    `;

    this.container.querySelector<HTMLSelectElement>("#rsm-platform-filter")?.addEventListener("change", (e) => {
      this.platformFilter = (e.target as HTMLSelectElement).value;
      this.render();
    });
    this.container.querySelector(".rsm-add")?.addEventListener("click", () => {
      new ReplaySaveDialog("", this.platformFilter === "all" ? "linux-bash" : this.platformFilter, () => {
        void this.refresh();
        this.onTreeChanged();
      }).open();
    });
    this.container.querySelectorAll<HTMLButtonElement>(".rsm-edit").forEach((btn) => {
      btn.addEventListener("click", () => {
        const cmd = this.commands.find((c) => c.id === btn.dataset.id);
        if (!cmd) return;
        new ReplaySaveDialog("", cmd.platform, () => {
          void this.refresh();
          this.onTreeChanged();
        }, cmd).open();
      });
    });
    this.container.querySelectorAll<HTMLButtonElement>(".rsm-del").forEach((btn) => {
      btn.addEventListener("click", () => {
        const cmd = this.commands.find((c) => c.id === btn.dataset.id);
        if (!cmd || !confirm(`Delete saved command "${cmd.command}"?`)) return;
        replayDelete(cmd.id)
          .then(() => {
            showToast("Command deleted", "success");
            void this.refresh();
            this.onTreeChanged();
          })
          .catch((e) => showToast(`Delete failed: ${e}`, "error"));
      });
    });
  }

}
