/**
 * ConfigSaver — the one transactional path for Settings config writes.
 *
 * A write is optimistic: the success path patches the cached config and then
 * refreshes it, so the UI does not wait for a re-read. When the write is
 * rejected, the stored config is re-read and written back into the control —
 * never a DOM value captured before the edit, because the backend owns
 * "memory equals disk" (ADR 015).
 *
 * Each field owns a sequence counter, so a write that has been superseded by
 * a newer one cannot overwrite the newer cache entry or control value — in
 * either direction: an old success resolving late, or an old failure's
 * re-read resolving late.
 *
 * A rollback is field-scoped. The re-read returns a whole snapshot, which may
 * pre-date a save of a *different* field that landed while it was in flight,
 * so only the failed field is copied back into the cache.
 */

import { AppConfig, getAppConfig } from "./tauri-api";
import { showToast } from "./toast";

/** A persisted config field: the counter key and the toast text. */
export interface ConfigField {
  /** Sequence-counter key and optimistic cache-patch key. */
  key: keyof AppConfig & string;
  /** Exact toast text shown when the write is rejected. */
  failure: string;
}

export interface ConfigSaveDescriptor<E extends HTMLElement> {
  field: ConfigField;
  /** Element restored from the stored config when the write is rejected.
   *  Read when the rollback lands, not when the save starts, so a control that
   *  a re-render replaced while the write was in flight is still found. */
  control: E | null;
  /** The setter to call, with the new value already captured. */
  write: () => Promise<void>;
  /** Stored config -> control. Receives null when no config is available. */
  apply: (config: AppConfig | null, control: E) => void;
}

/** The owning screen's config cache, which the saver patches optimistically. */
export interface ConfigSaverHost {
  getConfig(): AppConfig | null;
  setConfig(config: AppConfig): void;
  refreshConfig(): Promise<void>;
}

export class ConfigSaver {
  /** Latest write per field; the last one to start owns the field. */
  private readonly counters = new Map<string, number>();

  constructor(private readonly host: ConfigSaverHost) {}

  /**
   * Copy only the failed field out of the re-read. Replacing the whole cache
   * would undo a different field's save that landed while the read was in
   * flight, because the snapshot predates it.
   */
  private restore(key: ConfigField["key"], fetched: AppConfig): void {
    const config = this.host.getConfig();
    if (!config) {
      this.host.setConfig(fetched);
      return;
    }
    Object.assign(config, { [key]: fetched[key] });
  }

  /**
   * Persist `value`, then reconcile. Never rejects: a failed write is
   * reported through the toast and the stored config.
   */
  async save<E extends HTMLElement>(
    descriptor: ConfigSaveDescriptor<E>,
    value: AppConfig[ConfigField["key"]],
  ): Promise<void> {
    const { field, write, apply } = descriptor;
    const seq = (this.counters.get(field.key) ?? 0) + 1;
    this.counters.set(field.key, seq);

    try {
      await write();
    } catch {
      showToast(field.failure, "error");
      const fetched = await getAppConfig().catch(() => null);
      // A newer write owns the field now — this rollback is obsolete.
      if (this.counters.get(field.key) !== seq) return;
      if (fetched) this.restore(field.key, fetched);
      // Re-read the control: a re-render during the write or the read replaced
      // the element the descriptor was built with, and restoring a detached
      // one would leave the visible setting showing the rejected value.
      const control = descriptor.control;
      if (control) apply(this.host.getConfig(), control);
      return;
    }

    // A newer write owns the field: its cache entry and control value must
    // not be replaced by this older completion.
    if (this.counters.get(field.key) !== seq) return;
    const config = this.host.getConfig();
    if (config) Object.assign(config, { [field.key]: value });
    // A failed re-read leaves the optimistic patch in place; nothing to undo.
    await this.host.refreshConfig().catch(() => undefined);
  }
}
