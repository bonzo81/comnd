/**
 * Replay Save Dialog — save a command to Command Replay (docs/specs/09-command-replay.md).
 *
 * Single modal: type/edit the command, see it live in the preview, select a
 * span of the preview and click "Mark as variable" to turn it into a {{name}}
 * chip. Chips can be renamed inline or removed by clicking. The command box
 * locks once a variable is marked (remove the chips to edit again). Platform
 * is pre-filled (session platform) but always changeable.
 */

import { ReplayCommand, ReplayVariable, replaySave } from "../lib/tauri-api";
import { showToast } from "../lib/toast";
import { log, LogTag } from "../lib/logger";
import { escHtml } from "../lib/format";
import { PLATFORM_META } from "../lib/platforms";
import { openModal, ModalHandle } from "../lib/modal";

const VALID_PLATFORMS = Object.keys(PLATFORM_META);

interface Segment {
  kind: "text" | "var";
  /** var: the variable name. text: the literal text. */
  text: string;
  /** var only — original selected text, restored when the chip is removed. */
  orig?: string;
}

export class ReplaySaveDialog {
  private modal: ModalHandle | null = null;
  private segments: Segment[] = [];
  private vars: ReplayVariable[] = [];
  /** Pending selection inside the preview, as [startOffset, endOffset] into raw text. */
  private sel: [number, number] | null = null;
  private varCounter = 0;
  private selectionHandler: (() => void) | null = null;

  constructor(
    private commandText: string,
    private platform: string,
    private onSaved: () => void,
    private existing?: ReplayCommand,
  ) {}

  open(): void {
    if (this.existing) {
      // Edit mode: parse the {{name}} template back into segments.
      this.platform = this.existing.platform;
      this.commandText = this.existing.command;
      this.segments = [];
      const parts = this.existing.command.split(/(\{\{[^{}]+\}\})/g);
      for (const part of parts) {
        const m = part.match(/^\{\{([^{}]+)\}\}$/);
        if (m) this.segments.push({ kind: "var", text: m[1].trim(), orig: m[1].trim() });
        else if (part) this.segments.push({ kind: "text", text: part });
      }
      // Keep declared vars whose chip survived the parse; order matches template.
      const names = this.segments.filter((s) => s.kind === "var").map((s) => s.text);
      this.vars = names.map(
        (name) => this.existing?.variables.find((v) => v.name === name) ?? { name },
      );
      this.varCounter = names.length;
    } else {
      this.commandText = this.commandText.trim();
      this.segments = this.commandText ? [{ kind: "text", text: this.commandText }] : [];
    }
    this.render();
  }

  private render(): void {
    // Re-renders replace the current modal — never stack modals.
    this.close();
    const platformOptions = VALID_PLATFORMS.map(
      (p) => `<option value="${p}" ${p === this.platform ? "selected" : ""}>${p}</option>`,
    ).join("");
    const content = `
      <h2 id="rsv-title">${this.existing ? "Edit Command Replay" : "Add Command Replay"}</h2>
      <p class="replay-dialog-hint">Type the command, then highlight part of it in the preview and click <strong>Mark as variable</strong>. Click a highlighted chip to remove it.</p>
      <textarea class="form-input" id="rsv-text" rows="3" spellcheck="false"
                placeholder="e.g. show running-config interface GigabitEthernet0/1">${escHtml(this.commandText)}</textarea>
      <div class="rsv-preview ${this.commandText ? "" : "rsv-preview-empty"}" id="rsv-preview"
           title="Select text to mark as a variable">${this.renderPreview()}</div>
      <div class="rsv-mark-row">
        <button type="button" class="btn-text" id="rsv-mark" disabled>Mark as variable</button>
      </div>
      <div id="rsv-vars">${this.renderVars()}</div>
      <label>
        <span>Platform</span>
        <select class="form-input" id="rsv-platform">${platformOptions}</select>
      </label>
      <div class="form-actions">
        <button type="button" class="btn-text" id="rsv-cancel">Cancel</button>
        <button type="button" class="btn-primary" id="rsv-save">Save</button>
      </div>
      <div class="form-errors" id="rsv-errors" role="alert"></div>
    `;

    this.modal = openModal({
      panelClass: "replay-dialog",
      content,
      initialFocus: this.existing ? undefined : "#rsv-text",
      onDismiss: () => this.close(),
    });
    this.modal.panel.setAttribute("aria-labelledby", "rsv-title");

    this.bind(this.modal.panel);

    const ta = this.modal.panel.querySelector<HTMLTextAreaElement>("#rsv-text");
    ta?.addEventListener("input", () => {
      if (this.vars.length > 0) return; // locked while variables are marked
      this.commandText = ta.value;
      this.segments = this.commandText ? [{ kind: "text", text: this.commandText }] : [];
      this.updatePreview();
    });
  }

  private bind(panel: HTMLElement): void {
    const preview = panel.querySelector<HTMLDivElement>("#rsv-preview")!;
    const markBtn = panel.querySelector<HTMLButtonElement>("#rsv-mark")!;
    const cancelBtn = panel.querySelector<HTMLButtonElement>("#rsv-cancel")!;
    const saveBtn = panel.querySelector<HTMLButtonElement>("#rsv-save")!;

    cancelBtn.addEventListener("click", () => this.close());
    saveBtn.addEventListener("click", () => void this.save());

    const selectionToOffsets = (): [number, number] | null => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
      const range = sel.getRangeAt(0);
      if (!preview.contains(range.commonAncestorContainer)) return null;
      let start = -1;
      let end = -1;
      let offset = 0;
      const walker = document.createTreeWalker(preview, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        const len = node.textContent?.length ?? 0;
        if (node === range.startContainer) start = offset + range.startOffset;
        if (node === range.endContainer) end = offset + range.endOffset;
        offset += len;
        node = walker.nextNode();
      }
      if (start < 0 || end < 0 || start >= end) return null;
      return [start, end];
    };

    document.addEventListener("selectionchange", (this.selectionHandler = () => {
      if (!this.modal) return;
      this.sel = selectionToOffsets();
      markBtn.disabled = !this.sel;
    }));

    markBtn.addEventListener("click", () => {
      if (!this.sel) return;
      const [s, e] = this.sel;
      this.markVariable(s, e);
      this.sel = null;
      window.getSelection()?.removeAllRanges();
    });

    preview.addEventListener("click", (e) => {
      const chip = (e.target as HTMLElement).closest<HTMLElement>(".rsv-chip");
      if (!chip) return;
      this.unmarkVariable(chip.dataset.var ?? "");
    });

    panel.addEventListener("input", (e) => {
      const input = e.target as HTMLInputElement;
      if (input.classList.contains("rsv-var-name")) {
        this.renameVariable(parseInt(input.dataset.idx ?? "-1", 10), input.value);
      }
    });
    panel.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>(".rsv-var-remove");
      if (btn) this.unmarkVariable(this.vars[parseInt(btn.dataset.idx ?? "-1", 10)]?.name ?? "");
    });
  }

  // ─── Rendering helpers ───────────────────────────────────────────

  private renderPreview(): string {
    return this.segments
      .map((seg) =>
        seg.kind === "var"
          ? `<span class="rsv-chip" data-var="${escHtml(seg.text)}" title="Click to remove variable">{{${escHtml(seg.text)}}}</span>`
          : escHtml(seg.text),
      )
      .join("");
  }

  private renderVars(): string {
    if (this.vars.length === 0) return "";
    const rows = this.vars
      .map(
        (v, i) => `
        <div class="rsv-var-row">
          <code class="rsv-var-token">{{${escHtml(v.name)}}}</code>
          <span class="rsv-var-arrow">→</span>
          <input type="text" class="form-input rsv-var-name" data-idx="${i}"
                 value="${escHtml(v.name)}" placeholder="variable name" spellcheck="false" />
          <button type="button" class="rsv-var-remove" data-idx="${i}" title="Remove variable">×</button>
        </div>`,
      )
      .join("");
    return `<div class="rsv-vars-list"><h4>Variables</h4>${rows}</div>`;
  }

  /** Update the preview + vars list in place (no modal re-render). */
  private updatePreview(): void {
    const preview = this.modal?.panel.querySelector<HTMLDivElement>("#rsv-preview");
    const vars = this.modal?.panel.querySelector<HTMLElement>("#rsv-vars");
    if (preview) {
      preview.innerHTML = this.renderPreview();
      preview.classList.toggle("rsv-preview-empty", this.segments.length === 0);
    }
    if (vars) vars.innerHTML = this.renderVars();
  }

  private setError(msg: string): void {
    const el = this.modal?.panel.querySelector<HTMLElement>("#rsv-errors");
    if (el) el.textContent = msg;
  }

  // ─── Segment / variable editing ─────────────────────────────────

  /** Raw text of the current segments (text + var values). */
  private rawText(): string {
    return this.segments.map((s) => s.text).join("");
  }

  private markVariable(start: number, end: number): void {
    const text = this.rawText().slice(start, end).trim();
    if (!text) {
      this.setError("Selection is empty.");
      return;
    }
    const name = `var${++this.varCounter}`;
    const out: Segment[] = [];
    let pos = 0;
    for (const seg of this.segments) {
      const segStart = pos;
      const segEnd = pos + seg.text.length;
      pos = segEnd;
      if (seg.kind === "var" || segEnd <= start || segStart >= end) {
        out.push(seg);
        continue;
      }
      const s = Math.max(start, segStart) - segStart;
      const e = Math.min(end, segEnd) - segStart;
      if (s > 0) out.push({ kind: "text", text: seg.text.slice(0, s) });
      out.push({ kind: "var", text: name, orig: text });
      if (e < seg.text.length) out.push({ kind: "text", text: seg.text.slice(e) });
    }
    this.segments = out;
    this.vars.push({ name });
    // Lock the command box while variables are marked — editing the raw text
    // would silently invalidate the chips.
    const ta = this.modal?.panel.querySelector<HTMLTextAreaElement>("#rsv-text");
    if (ta) {
      ta.disabled = true;
      ta.value = this.template();
    }
    this.updatePreview();
  }

  private unmarkVariable(name: string): void {
    // Restore the var's original text (the span that was marked).
    this.segments = this.segments.map((seg) =>
      seg.kind === "var" && seg.text === name ? { kind: "text", text: seg.orig ?? seg.text } : seg,
    );
    this.vars = this.vars.filter((v) => v.name !== name);
    if (this.vars.length === 0) {
      // Last chip removed — unlock the command box for editing.
      const ta = this.modal?.panel.querySelector<HTMLTextAreaElement>("#rsv-text");
      if (ta) {
        ta.disabled = false;
        this.commandText = this.rawText();
        ta.value = this.commandText;
      }
    }
    this.updatePreview();
  }

  private renameVariable(idx: number, newName: string): void {
    const v = this.vars[idx];
    if (!v) return;
    const old = v.name;
    const clean = newName.trim().replace(/\s+/g, "-");
    if (!clean || this.vars.some((o, i) => i !== idx && o.name === clean)) return;
    v.name = clean;
    this.segments = this.segments.map((seg) =>
      seg.kind === "var" && seg.text === old ? { ...seg, text: clean } : seg,
    );
    // Update the preview only — re-rendering the vars list would destroy the
    // focused input mid-keystroke.
    const preview = this.modal?.panel.querySelector<HTMLDivElement>("#rsv-preview");
    if (preview) preview.innerHTML = this.renderPreview();
  }

  /** Build the template string from current segments. */
  private template(): string {
    return this.segments.map((s) => (s.kind === "var" ? `{{${s.text}}}` : s.text)).join("");
  }

  // ─── Save ────────────────────────────────────────────────────────

  private async save(): Promise<void> {
    const platform = this.modal?.panel.querySelector<HTMLSelectElement>("#rsv-platform")?.value ?? this.platform;
    if (!this.rawText().trim()) {
      this.setError("Enter a command first.");
      return;
    }
    // Drop declared vars that no longer appear in the template (chips removed).
    const tpl = this.template();
    const variables = this.vars.filter((v) => tpl.includes(`{{${v.name}}}`));
    const cmd: ReplayCommand = {
      id: this.existing?.id ?? "",
      command: tpl,
      variables,
      platform,
      created_at: this.existing?.created_at ?? "",
    };
    try {
      await replaySave(cmd);
      log.info(LogTag.Terminal, `Command Replay saved for ${platform}`);
      showToast("Saved to Command Replay", "success");
      this.close();
      this.onSaved();
    } catch (e) {
      this.setError(`Save failed: ${e}`);
    }
  }

  close(): void {
    if (this.selectionHandler) {
      document.removeEventListener("selectionchange", this.selectionHandler);
      this.selectionHandler = null;
    }
    this.modal?.close();
    this.modal = null;
  }
}
