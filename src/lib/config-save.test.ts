import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness } from "../../tests/harness";
import type { AppConfig } from "./tauri-api";
import {
  ConfigSaver,
  type ConfigSaverHost,
  type ConfigSaveDescriptor,
} from "./config-save";
import { normalizeDuplicateSessionPolicy } from "./duplicate-session";

type Control = HTMLSelectElement | HTMLInputElement;
type Value = AppConfig[keyof AppConfig];

interface FieldCase {
  key: keyof AppConfig & string;
  failure: string;
  /** What the backend currently holds. */
  stored: Value;
  /** What the user picks. */
  chosen: Value;
  /** A later pick, used to supersede an in-flight write. */
  newer: Value;
  makeControl: () => Control;
  apply: (config: AppConfig | null, control: Control) => void;
  read: (control: Control) => unknown;
}

function selectOf(options: string[], value: string): HTMLSelectElement {
  const el = document.createElement("select");
  for (const option of options) {
    const node = document.createElement("option");
    node.value = option;
    node.textContent = option;
    el.appendChild(node);
  }
  el.value = value;
  return el;
}

function checkbox(checked: boolean): HTMLInputElement {
  const el = document.createElement("input");
  el.type = "checkbox";
  el.checked = checked;
  return el;
}

function textInput(value: string): HTMLInputElement {
  const el = document.createElement("input");
  el.type = "text";
  el.value = value;
  return el;
}

/** Mirrors the user's edit, which happens before the change event fires. */
function setControl(control: Control, value: Value): void {
  if (control instanceof HTMLInputElement && control.type === "checkbox") {
    control.checked = Boolean(value);
    return;
  }
  control.value = value === null ? "" : String(value);
}

let base: AppConfig | null = null;
const baseConfig = () => (base ??= createHarness().fixtures.appConfig());

/** The control value `apply()` renders for `value`. */
function shown(f: FieldCase, value: Value): unknown {
  const control = f.makeControl();
  f.apply({ ...baseConfig(), [f.key]: value } as AppConfig, control);
  return f.read(control);
}

const FIELDS: FieldCase[] = [
  {
    key: "log_level",
    failure: "Failed to save log level",
    stored: "info",
    chosen: "debug",
    newer: "warn",
    makeControl: () => selectOf(["debug", "info", "warn", "error"], "info"),
    apply: (config, control) => {
      (control as HTMLSelectElement).value = config?.log_level ?? "info";
    },
    read: (control) => (control as HTMLSelectElement).value,
  },
  {
    key: "log_max_size_mb",
    failure: "Failed to save log file size",
    stored: 10,
    chosen: 50,
    newer: 100,
    makeControl: () => selectOf(["0", "5", "10", "50", "100"], "10"),
    apply: (config, control) => {
      (control as HTMLSelectElement).value = String(config?.log_max_size_mb ?? 10);
    },
    read: (control) => (control as HTMLSelectElement).value,
  },
  {
    key: "max_sessions",
    failure: "Failed to save session limit",
    stored: 30,
    chosen: 50,
    newer: 100,
    makeControl: () => selectOf(["10", "20", "30", "50", "100", "0"], "30"),
    apply: (config, control) => {
      (control as HTMLSelectElement).value = String(config?.max_sessions ?? 30);
    },
    read: (control) => (control as HTMLSelectElement).value,
  },
  {
    key: "duplicate_session_policy",
    failure: "Failed to save duplicate session policy",
    stored: "ask",
    chosen: "focus",
    newer: "allow",
    makeControl: () => selectOf(["ask", "allow", "focus"], "ask"),
    apply: (config, control) => {
      (control as HTMLSelectElement).value = normalizeDuplicateSessionPolicy(
        config?.duplicate_session_policy,
      );
    },
    read: (control) => (control as HTMLSelectElement).value,
  },
  {
    key: "session_logging",
    failure: "Failed to save session logging",
    stored: true,
    chosen: false,
    newer: true,
    makeControl: () => checkbox(true),
    apply: (config, control) => {
      (control as HTMLInputElement).checked = config?.session_logging ?? true;
    },
    read: (control) => (control as HTMLInputElement).checked,
  },
  {
    key: "session_log_timestamps",
    failure: "Failed to save session log timestamps",
    stored: false,
    chosen: true,
    newer: false,
    makeControl: () => checkbox(false),
    apply: (config, control) => {
      (control as HTMLInputElement).checked = config?.session_log_timestamps ?? true;
    },
    read: (control) => (control as HTMLInputElement).checked,
  },
  {
    key: "session_log_dir",
    failure: "Failed to save session log directory",
    stored: null,
    chosen: "/var/log/comnd",
    newer: "/srv/comnd/logs",
    makeControl: () => textInput(""),
    apply: (config, control) => {
      (control as HTMLInputElement).value = config?.session_log_dir ?? "";
    },
    read: (control) => (control as HTMLInputElement).value,
  },
  {
    key: "log_file_path",
    failure: "Failed to save log file path",
    stored: null,
    chosen: "/tmp/comnd.log",
    newer: "/srv/comnd/comnd.log",
    makeControl: () => textInput(""),
    apply: (config, control) => {
      (control as HTMLInputElement).value = config?.log_file_path ?? "";
    },
    read: (control) => (control as HTMLInputElement).value,
  },
];

function caseFor(key: string): FieldCase {
  const found = FIELDS.find((f) => f.key === key);
  if (!found) throw new Error(`no field case for ${key}`);
  return found;
}

function descriptor(
  f: FieldCase,
  write: () => Promise<void>,
  control: Control | null = null,
): ConfigSaveDescriptor<Control> {
  return {
    field: { key: f.key, failure: f.failure },
    control,
    write,
    apply: (config, el) => f.apply(config, el),
  };
}

function setup(f: FieldCase) {
  const h = createHarness();
  let cache: AppConfig | null = h.fixtures.appConfig({
    [f.key]: f.stored,
  } as Partial<AppConfig>);
  h.ipc.mockImpl("get_app_config", () => (cache ? structuredClone(cache) : null));
  const refreshConfig = vi.fn(async () => undefined);
  const host: ConfigSaverHost = {
    getConfig: () => cache,
    setConfig: (next) => { cache = next; },
    refreshConfig,
  };
  return { h, saver: new ConfigSaver(host), cache: () => cache, refreshConfig };
}

afterEach(() => {
  document.querySelectorAll(".toast").forEach((el) => el.remove());
});

describe.each(FIELDS)("ConfigSaver — $key", (f) => {
  it("toasts and restores the stored value when the write is rejected", async () => {
    const { saver, cache } = setup(f);
    const control = f.makeControl();
    setControl(control, f.chosen);

    await saver.save(
      descriptor(f, () => Promise.reject(new Error("save failed")), control),
      f.chosen,
    );

    expect(document.body.textContent).toContain(f.failure);
    expect(cache()?.[f.key]).toEqual(f.stored);
    expect(f.read(control)).toEqual(shown(f, f.stored));
  });

  it("patches the cache and refreshes without a re-read when the write succeeds", async () => {
    const { h, saver, cache, refreshConfig } = setup(f);
    const control = f.makeControl();
    setControl(control, f.chosen);

    await saver.save(descriptor(f, async () => undefined, control), f.chosen);

    expect(cache()?.[f.key]).toEqual(f.chosen);
    expect(refreshConfig).toHaveBeenCalledTimes(1);
    expect(h.ipc.calls("get_app_config")).toEqual([]);
    expect(document.body.textContent).not.toContain(f.failure);
  });

  it("ignores a superseded success so the newer value wins", async () => {
    const { saver, cache, refreshConfig } = setup(f);
    const control = f.makeControl();
    let releaseOlder!: () => void;
    const older = new Promise<void>((resolve) => { releaseOlder = resolve; });

    const olderSave = saver.save(descriptor(f, () => older, control), f.chosen);
    await saver.save(descriptor(f, async () => undefined, control), f.newer);
    releaseOlder();
    await olderSave;

    expect(cache()?.[f.key]).toEqual(f.newer);
    expect(refreshConfig).toHaveBeenCalledTimes(1);
  });

  it("ignores a rollback re-read superseded by a newer save", async () => {
    const { h, saver, cache } = setup(f);
    // The stale read carries the value the user had just picked, so a
    // rollback that wrongly lands would be visible in the cache and control.
    const stale = h.fixtures.appConfig({ [f.key]: f.chosen } as Partial<AppConfig>);
    let releaseRead!: () => void;
    let holdNextRead = true;
    h.ipc.mockImpl("get_app_config", () => {
      if (holdNextRead) {
        holdNextRead = false;
        return new Promise<AppConfig>((resolve) => {
          releaseRead = () => resolve(stale);
        });
      }
      return structuredClone(cache());
    });
    const control = f.makeControl();
    setControl(control, f.chosen);

    const rejected = saver.save(
      descriptor(f, () => Promise.reject(new Error("save failed")), control),
      f.chosen,
    );
    await vi.waitFor(() => expect(document.body.textContent).toContain(f.failure));

    // A newer save lands while the rejection's re-read is still in flight.
    await saver.save(descriptor(f, async () => undefined, control), f.newer);
    setControl(control, f.newer);
    releaseRead();
    await rejected;

    expect(cache()?.[f.key]).toEqual(f.newer);
    expect(f.read(control)).toEqual(shown(f, f.newer));
  });
});

describe("ConfigSaver — rollback fallbacks", () => {
  it("keeps the cached value when the re-read after a rejection fails", async () => {
    const f = caseFor("log_level");
    const { h, saver, cache } = setup(f);
    h.ipc.mockImpl("get_app_config", () => {
      throw new Error("config read failed");
    });
    const control = f.makeControl();
    setControl(control, f.chosen);

    await saver.save(
      descriptor(f, () => Promise.reject(new Error("save failed")), control),
      f.chosen,
    );

    expect(document.body.textContent).toContain(f.failure);
    expect(cache()?.log_level).toBe("info");
    expect(f.read(control)).toBe("info");
  });

  it("restores nothing when the descriptor has no control", async () => {
    const f = caseFor("log_file_path");
    const { saver, cache } = setup(f);

    await expect(
      saver.save(descriptor(f, () => Promise.reject(new Error("nope"))), "/tmp/x.log"),
    ).resolves.toBeUndefined();

    expect(document.body.textContent).toContain(f.failure);
    expect(cache()?.log_file_path).toEqual(f.stored);
  });

  it("does not reject when the post-save refresh fails", async () => {
    const f = caseFor("log_level");
    const { saver, cache, refreshConfig } = setup(f);
    refreshConfig.mockRejectedValueOnce(new Error("read failed"));

    await expect(
      saver.save(descriptor(f, async () => undefined, f.makeControl()), f.chosen),
    ).resolves.toBeUndefined();

    expect(cache()?.log_level).toBe(f.chosen);
  });

  it("orders writes per field, not globally", async () => {
    const level = caseFor("log_level");
    const size = caseFor("log_max_size_mb");
    let cache = createHarness().fixtures.appConfig();
    const refreshConfig = vi.fn(async () => undefined);
    const saver = new ConfigSaver({
      getConfig: () => cache,
      setConfig: (next) => { cache = next; },
      refreshConfig,
    });
    let releaseLevel!: () => void;
    const levelWrite = new Promise<void>((resolve) => { releaseLevel = resolve; });

    const levelSave = saver.save(
      descriptor(level, () => levelWrite, level.makeControl()),
      level.chosen,
    );
    await saver.save(descriptor(size, async () => undefined, size.makeControl()), size.chosen);
    releaseLevel();
    await levelSave;

    expect(cache.log_level).toBe(level.chosen);
    expect(cache.log_max_size_mb).toBe(size.chosen);
    expect(refreshConfig).toHaveBeenCalledTimes(2);
  });
});
