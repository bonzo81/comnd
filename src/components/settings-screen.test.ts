import { afterEach, describe, it, expect, vi } from "vitest";
import { createHarness } from "../../tests/harness";
import type { AppConfig, NetBoxConfig } from "../lib/tauri-api";
import type { ConfigSaveDescriptor } from "../lib/config-save";
import { SettingsScreen } from "./settings-screen";

async function renderNetbox(showEmptyFolders = false) {
  const h = createHarness();
  let config: NetBoxConfig = {
    enabled: true,
    show_empty_folders: showEmptyFolders,
    base_url: "https://netbox.example.com",
    filters: { status: null, sites: [], roles: [], tags: [] },
    platform_policy: "skip",
    platform_fallback: null,
    platform_overrides: {},
    default_username: null,
    default_port: 22,
    default_credential: null,
    allow_invalid_certs: false,
  };
  h.ipc.mock("get_app_config", h.fixtures.appConfig());
  h.ipc.mock("get_session_log_dir", "");
  h.ipc.mockImpl("netbox_get_config", () => ({ config: { ...config }, has_token: false }));
  h.ipc.mock("netbox_get_status", { has_token: false, has_default_pw: false, last_synced: null });
  h.ipc.mock("netbox_get_devices", []);
  h.ipc.mock("list_providers", []);
  h.ipc.mockImpl("netbox_save_config", (args) => {
    config = args.config as NetBoxConfig;
    return { ...config };
  });
  const container = h.mount();
  const screen = new SettingsScreen();
  await screen.mount(container);
  screen.setItem("netbox");
  await vi.waitFor(() => expect(container.querySelector("#netbox-show-empty-folders")).not.toBeNull());
  const toggle = container.querySelector<HTMLInputElement>("#netbox-show-empty-folders")!;
  return { h, container, screen, toggle };
}

describe("SettingsScreen — NetBox folder visibility", () => {
  it("leaves Show empty folders unchecked by default", async () => {
    const { toggle, container } = await renderNetbox();
    expect(toggle.checked).toBe(false);
    expect(container.textContent).toContain("Show empty folders");
  });

  it.each([false, true])("autosaves a change from %s and refreshes the tree", async (initial) => {
    const { h, container, screen, toggle } = await renderNetbox(initial);
    const onTreeChanged = vi.fn();
    screen.onTreeChanged = onTreeChanged;
    container.querySelector<HTMLInputElement>("#netbox-url")!.value = "https://unsaved.example.com";
    toggle.click();

    await vi.waitFor(() => expect(onTreeChanged).toHaveBeenCalledOnce());
    expect(h.ipc.calls("netbox_save_config")).toEqual([{
      args: {
        config: expect.objectContaining({
          enabled: true,
          show_empty_folders: !initial,
          base_url: "https://netbox.example.com",
          filters: { status: null, sites: [], roles: [], tags: [] },
        }),
        defaultPassword: null,
      },
    }]);

    screen.setItem("general");
    screen.setItem("netbox");
    await vi.waitFor(() => {
      expect(container.querySelector<HTMLInputElement>("#netbox-show-empty-folders")?.checked).toBe(!initial);
    });
  });

  it("does not refresh the tree if saving the toggle fails", async () => {
    const { h, screen, toggle, container } = await renderNetbox();
    h.ipc.mockImpl("netbox_save_config", () => { throw new Error("save failed"); });
    const onTreeChanged = vi.fn();
    screen.onTreeChanged = onTreeChanged;
    toggle.click();

    await vi.waitFor(() => expect(document.body.textContent).toContain("Failed to save NetBox settings"));
    expect(onTreeChanged).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLInputElement>("#netbox-enabled")!.checked).toBe(true);
  });
});

describe("SettingsScreen — NetBox enabled flag persistence (#11)", () => {
  async function setup(initial: Partial<NetBoxConfig> = {}, failInitialRead = false) {
    const h = createHarness();
    let stored: NetBoxConfig = {
      enabled: false,
      show_empty_folders: false,
      base_url: "",
      filters: { status: null, sites: [], roles: [], tags: [] },
      platform_policy: "skip",
      platform_fallback: null,
      platform_overrides: {},
      default_username: null,
      default_port: 22,
      default_credential: null,
      allow_invalid_certs: false,
      ...initial,
    };
    let hasToken = false;
    h.ipc.mock("get_app_config", h.fixtures.appConfig());
    h.ipc.mock("get_session_log_dir", "");
    h.ipc.mockImpl("netbox_get_config", () => {
      if (failInitialRead && h.ipc.calls("netbox_get_config").length === 1) {
        throw new Error("keyring unavailable");
      }
      return { config: structuredClone(stored), has_token: hasToken };
    });
    h.ipc.mockImpl("netbox_get_status", () => ({ has_token: hasToken, has_default_pw: false, last_synced: null }));
    h.ipc.mock("netbox_get_devices", []);
    h.ipc.mock("netbox_get_sites", []);
    h.ipc.mock("netbox_get_roles", []);
    h.ipc.mock("netbox_get_tags", []);
    h.ipc.mock("list_providers", []);
    h.ipc.mockImpl("netbox_save_config", (args) => {
      stored = structuredClone(args.config as NetBoxConfig);
      return structuredClone(stored);
    });
    h.ipc.mockImpl("netbox_save_token", () => { hasToken = true; return null; });
    h.ipc.mock("netbox_test_connection", { version: "4.0", device_count: 1 });
    // Mirrors netbox_sync in netbox.rs: it reads the persisted config only.
    h.ipc.mockImpl("netbox_sync", () => {
      if (!stored.enabled) throw new Error("NetBox integration is disabled — enable it in Settings → NetBox");
      return { fetched: 1, no_primary_ip: 0, skipped_platform: 0, unmatched_platforms: [] };
    });
    const container = h.mount();
    const screen = new SettingsScreen();
    await screen.mount(container);
    screen.setItem("netbox");
    await vi.waitFor(() => expect(container.querySelector("#netbox-enabled")).not.toBeNull());
    const q = <T extends HTMLElement>(sel: string) => container.querySelector<T>(sel)!;
    return { h, container, screen, q, persisted: () => stored };
  }

  it("keeps Refresh working after a settings change following initial setup", async () => {
    const { h, screen, q, persisted } = await setup();

    q<HTMLInputElement>("#netbox-enabled").click();
    await vi.waitFor(() => expect(persisted().enabled).toBe(true));
    q<HTMLInputElement>("#netbox-url").value = "https://netbox.example.com";
    q<HTMLInputElement>("#netbox-token").value = "token";
    q<HTMLButtonElement>("#netbox-test-btn").click();
    await vi.waitFor(() => expect(q<HTMLButtonElement>("#netbox-token-save").disabled).toBe(false));
    q<HTMLButtonElement>("#netbox-token-save").click();
    await vi.waitFor(() => expect(persisted().base_url).toBe("https://netbox.example.com"));

    q<HTMLButtonElement>("#netbox-sync-btn").click();
    await vi.waitFor(() => expect(h.ipc.calls("netbox_sync")).toHaveLength(1));
    await vi.waitFor(() => expect(q<HTMLButtonElement>("#netbox-sync-btn").disabled).toBe(false));

    // Any auto-saved edit must keep the persisted flag in step with the toggle.
    const username = q<HTMLInputElement>("#netbox-default-username");
    username.value = "netadmin";
    username.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(persisted().default_username).toBe("netadmin"));
    expect(persisted().enabled).toBe(true);
    q<HTMLInputElement>("#netbox-show-empty-folders").click();
    await vi.waitFor(() => expect(persisted().show_empty_folders).toBe(true));
    expect(persisted().enabled).toBe(true);

    q<HTMLButtonElement>("#netbox-sync-btn").click();
    await vi.waitFor(() => expect(h.ipc.calls("netbox_sync")).toHaveLength(2));
    await vi.waitFor(() => expect(q<HTMLButtonElement>("#netbox-sync-btn").disabled).toBe(false));
    expect(document.body.textContent).not.toContain("integration is disabled");
    expect(h.ipc.calls("netbox_save_config").every((c) => (c.args.config as NetBoxConfig).enabled)).toBe(true);

    screen.setItem("general");
    screen.setItem("netbox");
    await vi.waitFor(() => expect(q<HTMLInputElement>("#netbox-enabled")?.checked).toBe(true));
  });

  it("reverts the enable toggle when saving it fails", async () => {
    const { h, q, persisted } = await setup();
    h.ipc.mockImpl("netbox_save_config", () => { throw new Error("save failed"); });
    q<HTMLInputElement>("#netbox-enabled").click();

    await vi.waitFor(() => expect(q<HTMLInputElement>("#netbox-enabled").checked).toBe(false));
    expect(h.ipc.calls("netbox_save_config")).toHaveLength(1);
    expect(q<HTMLElement>(".netbox-body").classList.contains("netbox-body-disabled")).toBe(true);
    expect(persisted().enabled).toBe(false);
  });

  it("reloads the saved config before toggling after an initial read failure", async () => {
    const initial: Partial<NetBoxConfig> = {
      base_url: "https://netbox.example.com",
      filters: { status: "active", sites: ["lab"], roles: ["switch"], tags: ["core"] },
      default_username: "netadmin",
      default_port: 2222,
      default_credential: { type: "agent", identity: null },
    };
    const { h, q, persisted } = await setup(initial, true);
    q<HTMLInputElement>("#netbox-enabled").click();

    await vi.waitFor(() => expect(persisted().enabled).toBe(true));
    expect(h.ipc.calls("netbox_get_config")).toHaveLength(2);
    expect(h.ipc.calls("netbox_save_config")).toEqual([{
      args: { config: expect.objectContaining({ ...initial, enabled: true }), defaultPassword: null },
    }]);
  });

  it("does not write defaults if retrying the saved config read fails", async () => {
    const { h, q, persisted } = await setup({ base_url: "https://netbox.example.com" }, true);
    const initial = structuredClone(persisted());
    h.ipc.mockImpl("netbox_get_config", () => { throw new Error("keyring unavailable"); });
    q<HTMLInputElement>("#netbox-enabled").click();

    await vi.waitFor(() => expect(q<HTMLInputElement>("#netbox-enabled").checked).toBe(false));
    expect(h.ipc.calls("netbox_save_config")).toHaveLength(0);
    expect(persisted()).toEqual(initial);
    expect(q<HTMLElement>(".netbox-body").classList.contains("netbox-body-disabled")).toBe(true);
  });

  it("ignores an older failure while the newest toggle save is pending", async () => {
    const { h, screen, q, persisted } = await setup();
    const pending = Array.from({ length: 3 }, () => {
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
      return { promise, resolve, reject };
    });
    let index = 0;
    const settled = vi.fn();
    h.ipc.mockImpl("netbox_save_config", async (args) => {
      try {
        await pending[index++].promise;
      } finally {
        settled();
      }
      Object.assign(persisted(), structuredClone(args.config as NetBoxConfig));
      return structuredClone(persisted());
    });
    const onTreeChanged = vi.fn();
    screen.onTreeChanged = onTreeChanged;
    const toggle = q<HTMLInputElement>("#netbox-enabled");
    toggle.click();
    toggle.click();
    toggle.click();
    expect(h.ipc.calls("netbox_save_config")).toHaveLength(3);

    pending[1].resolve();
    await vi.waitFor(() => expect(settled).toHaveBeenCalledTimes(1));
    pending[0].reject(new Error("older save failed"));
    await vi.waitFor(() => expect(settled).toHaveBeenCalledTimes(2));
    expect(toggle.checked).toBe(true);
    expect(q<HTMLElement>(".netbox-body").classList.contains("netbox-body-disabled")).toBe(false);
    pending[2].resolve();

    await vi.waitFor(() => expect(onTreeChanged).toHaveBeenCalledOnce());
    expect(persisted().enabled).toBe(true);
    expect(toggle.checked).toBe(true);
    expect(q<HTMLElement>(".netbox-body").classList.contains("netbox-body-disabled")).toBe(false);
    expect(h.ipc.calls("netbox_get_config")).toHaveLength(1);
  });

  it.each([false, true])("reconciles a committed toggle save that rejects (initially %s)", async (enabled) => {
    const { h, screen, q, persisted } = await setup({ enabled });
    h.ipc.mockImpl("netbox_save_config", (args) => {
      Object.assign(persisted(), structuredClone(args.config as NetBoxConfig));
      throw new Error("keyring cleanup failed");
    });
    const onTreeChanged = vi.fn();
    screen.onTreeChanged = onTreeChanged;
    q<HTMLInputElement>("#netbox-enabled").click();

    await vi.waitFor(() => expect(onTreeChanged).toHaveBeenCalledOnce());
    expect(h.ipc.calls("netbox_get_config")).toHaveLength(2);
    expect(persisted().enabled).toBe(!enabled);
    expect(q<HTMLInputElement>("#netbox-enabled").checked).toBe(!enabled);
    expect(q<HTMLElement>(".netbox-body").classList.contains("netbox-body-disabled")).toBe(enabled);
  });
});

describe("SettingsScreen — stale async page loads", () => {
  it("keeps rail focus when an obsolete auth load resolves after switching pages", async () => {
    const h = createHarness();
    let resolveProviders!: (v: unknown[]) => void;
    h.ipc.mock("get_app_config", h.fixtures.appConfig());
    h.ipc.mock("get_session_log_dir", "");
    h.ipc.mockImpl("list_providers", () => new Promise<unknown[]>((res) => (resolveProviders = res)));
    h.ipc.mock("get_provider_state", { enabled: false, has_secret: false });
    const container = h.mount();
    const screen = new SettingsScreen();
    await screen.mount(container);

    screen.setItem("auth"); // starts the (pending) provider load
    screen.setItem("general"); // synchronous render — active page is General
    const railBtn = container.querySelector<HTMLButtonElement>(
      '.settings-nav-item[data-item-id="general"]',
    );
    railBtn?.focus();
    expect(document.activeElement).toBe(railBtn);

    // The auth load resolves after the switch — its render must be dropped,
    // or the DOM rebuild steals focus from the rail (PR #46 review).
    resolveProviders([]);
    await new Promise((r) => setTimeout(r, 0));

    expect(document.activeElement).toBe(railBtn);
    expect(container.querySelector(".settings-nav-item.active")?.getAttribute("data-item-id")).toBe("general");
  });
});

describe("SettingsScreen — config save wiring (#148)", () => {
  interface Wire {
    name: string;
    page: "general" | "logging";
    control: string;
    field: keyof AppConfig & string;
    failure: string;
    /** Value handed to ConfigSaver.save. */
    value: unknown;
    command: string;
    args: Record<string, unknown>;
    /** Stored config the rollback would read back. */
    stored: Partial<AppConfig>;
    /** What that stored config renders into the control. */
    rendered: string;
    read: (el: HTMLElement) => string;
    trigger: (container: HTMLElement) => void | Promise<void>;
    /** Dialog plugin answer for the browse buttons. */
    dialog?: { command: string; result: string };
  }

  const SET_COMMANDS = [
    "set_log_level",
    "set_log_max_size",
    "set_max_sessions",
    "set_duplicate_session_policy",
    "set_session_logging",
    "set_session_log_timestamps",
    "set_session_log_dir",
    "set_log_file_path",
  ];

  const selectValue = (el: HTMLElement) => (el as HTMLSelectElement).value;
  const inputValue = (el: HTMLElement) => (el as HTMLInputElement).value;
  const checked = (el: HTMLElement) => String((el as HTMLInputElement).checked);

  function setSelect(container: HTMLElement, selector: string, value: string) {
    const el = container.querySelector<HTMLSelectElement>(selector);
    if (!el) throw new Error(`missing ${selector}`);
    el.value = value;
    el.dispatchEvent(new Event("change"));
  }

  function setText(container: HTMLElement, selector: string, value: string) {
    const el = container.querySelector<HTMLInputElement>(selector);
    if (!el) throw new Error(`missing ${selector}`);
    el.value = value;
    el.dispatchEvent(new Event("change"));
  }

  function clickOn(container: HTMLElement, selector: string) {
    const el = container.querySelector<HTMLElement>(selector);
    if (!el) throw new Error(`missing ${selector}`);
    el.click();
  }

  const WIRES: Wire[] = [
    {
      name: "log level",
      page: "logging",
      control: "#log-level",
      field: "log_level",
      failure: "Failed to save log level",
      value: "debug",
      command: "set_log_level",
      args: { level: "debug" },
      stored: { log_level: "warn" },
      rendered: "warn",
      read: selectValue,
      trigger: (container) => setSelect(container, "#log-level", "debug"),
    },
    {
      name: "log file size",
      page: "logging",
      control: "#log-max-size",
      field: "log_max_size_mb",
      failure: "Failed to save log file size",
      value: 50,
      command: "set_log_max_size",
      args: { maxMb: 50 },
      stored: { log_max_size_mb: 100 },
      rendered: "100",
      read: selectValue,
      trigger: (container) => setSelect(container, "#log-max-size", "50"),
    },
    {
      name: "session limit",
      page: "general",
      control: "#max-sessions",
      field: "max_sessions",
      failure: "Failed to save session limit",
      value: 20,
      command: "set_max_sessions",
      args: { max: 20 },
      stored: { max_sessions: 50 },
      rendered: "50",
      read: selectValue,
      trigger: (container) => setSelect(container, "#max-sessions", "20"),
    },
    {
      name: "duplicate session policy",
      page: "general",
      control: "#duplicate-session-policy",
      field: "duplicate_session_policy",
      failure: "Failed to save duplicate session policy",
      value: "allow",
      command: "set_duplicate_session_policy",
      args: { policy: "allow" },
      stored: { duplicate_session_policy: "focus" },
      rendered: "focus",
      read: selectValue,
      trigger: (container) => setSelect(container, "#duplicate-session-policy", "allow"),
    },
    {
      name: "session logging",
      page: "logging",
      control: "#session-logging",
      field: "session_logging",
      failure: "Failed to save session logging",
      value: false,
      command: "set_session_logging",
      args: { enabled: false },
      stored: { session_logging: true },
      rendered: "true",
      read: checked,
      trigger: (container) => clickOn(container, "#session-logging"),
    },
    {
      name: "session log timestamps",
      page: "logging",
      control: "#session-log-timestamps",
      field: "session_log_timestamps",
      failure: "Failed to save session log timestamps",
      value: true,
      command: "set_session_log_timestamps",
      args: { enabled: true },
      stored: { session_log_timestamps: false },
      rendered: "false",
      read: checked,
      trigger: (container) => clickOn(container, "#session-log-timestamps"),
    },
    {
      // Typed input is trimmed before it is persisted.
      name: "session log directory",
      page: "logging",
      control: "#session-log-dir",
      field: "session_log_dir",
      failure: "Failed to save session log directory",
      value: "/srv/logs",
      command: "set_session_log_dir",
      args: { dir: "/srv/logs" },
      stored: { session_log_dir: "/var/log/comnd" },
      rendered: "/var/log/comnd",
      read: inputValue,
      trigger: (container) => setText(container, "#session-log-dir", "  /srv/logs  "),
    },
    {
      name: "session log directory reset",
      page: "logging",
      control: "#session-log-dir",
      field: "session_log_dir",
      failure: "Failed to reset session log directory",
      value: null,
      command: "set_session_log_dir",
      args: { dir: null },
      stored: { session_log_dir: "/var/log/comnd" },
      rendered: "/var/log/comnd",
      read: inputValue,
      trigger: (container) => clickOn(container, "#session-log-dir-reset"),
    },
    {
      name: "session log directory browse",
      page: "logging",
      control: "#session-log-dir",
      field: "session_log_dir",
      failure: "Failed to save session log directory",
      value: "/picked/logs",
      command: "set_session_log_dir",
      args: { dir: "/picked/logs" },
      stored: { session_log_dir: "/var/log/comnd" },
      rendered: "/var/log/comnd",
      read: inputValue,
      trigger: (container) => clickOn(container, "#session-log-dir-browse"),
      dialog: { command: "plugin:dialog|open", result: "/picked/logs" },
    },
    {
      name: "log file path",
      page: "logging",
      control: "#log-file-path",
      field: "log_file_path",
      failure: "Failed to save log file path",
      value: "/tmp/comnd.log",
      command: "set_log_file_path",
      args: { path: "/tmp/comnd.log" },
      stored: { log_file_path: "/var/log/comnd.log" },
      rendered: "/var/log/comnd.log",
      read: inputValue,
      trigger: (container) => setText(container, "#log-file-path", "/tmp/comnd.log"),
    },
    {
      name: "log file path reset",
      page: "logging",
      control: "#log-file-path",
      field: "log_file_path",
      failure: "Failed to reset log file path",
      value: null,
      command: "set_log_file_path",
      args: { path: null },
      stored: { log_file_path: "/var/log/comnd.log" },
      rendered: "/var/log/comnd.log",
      read: inputValue,
      trigger: (container) => clickOn(container, "#log-file-reset"),
    },
    {
      name: "log file path browse",
      page: "logging",
      control: "#log-file-path",
      field: "log_file_path",
      failure: "Failed to save log file path",
      value: "/picked/comnd.log",
      command: "set_log_file_path",
      args: { path: "/picked/comnd.log" },
      stored: { log_file_path: "/var/log/comnd.log" },
      rendered: "/var/log/comnd.log",
      read: inputValue,
      trigger: (container) => clickOn(container, "#log-file-browse"),
      dialog: { command: "plugin:dialog|save", result: "/picked/comnd.log" },
    },
  ];

  async function render(wire: Wire) {
    const h = createHarness();
    h.ipc.mock("get_app_config", h.fixtures.appConfig());
    h.ipc.mock("get_session_log_dir", "");
    for (const command of SET_COMMANDS) h.ipc.mock(command, undefined);
    if (wire.dialog) h.ipc.mock(wire.dialog.command, wire.dialog.result);
    const container = h.mount();
    const screen = new SettingsScreen();
    await screen.mount(container);
    screen.setItem(wire.page);
    return { h, container, screen };
  }

  it.each(WIRES)("routes $name through exactly one descriptor", async (wire) => {
    const { h, container, screen } = await render(wire);
    const saved: { descriptor: ConfigSaveDescriptor<HTMLElement>; value: unknown }[] = [];
    vi.spyOn(screen.saver, "save").mockImplementation(async (descriptor, value) => {
      saved.push({ descriptor: descriptor as ConfigSaveDescriptor<HTMLElement>, value });
    });

    await wire.trigger(container);
    await vi.waitFor(() => expect(saved).toHaveLength(1));

    const [{ descriptor, value }] = saved;
    expect(descriptor.field).toEqual({ key: wire.field, failure: wire.failure });
    expect(descriptor.control).toBe(container.querySelector(wire.control));
    expect(value).toBe(wire.value);

    // The descriptor's write is the field's own setter, with the value baked in.
    await descriptor.write();
    expect(h.ipc.calls(wire.command)).toEqual([{ args: wire.args }]);

    // Its apply renders the stored config back into that same control.
    descriptor.apply(h.fixtures.appConfig(wire.stored), descriptor.control!);
    expect(wire.read(descriptor.control!)).toBe(wire.rendered);
  });

  it("does not save when the browse dialog is dismissed", async () => {
    const wire = WIRES.find((w) => w.name === "log file path browse")!;
    const h = createHarness();
    h.ipc.mock("get_app_config", h.fixtures.appConfig());
    h.ipc.mock("get_session_log_dir", "");
    h.ipc.mock("plugin:dialog|save", null);
    const container = h.mount();
    const screen = new SettingsScreen();
    await screen.mount(container);
    screen.setItem(wire.page);
    const save = vi.spyOn(screen.saver, "save");

    clickOn(container, "#log-file-browse");
    await new Promise((r) => setTimeout(r, 0));
    expect(save).not.toHaveBeenCalled();
  });
});

describe("SettingsScreen — duplicate-session policy freshness", () => {
  it("re-reads the saved policy when another surface persists a remembered choice", async () => {
    const h = createHarness();
    let config = h.fixtures.appConfig({ duplicate_session_policy: "ask" });
    h.ipc.mockImpl("get_app_config", () => config);
    h.ipc.mock("get_session_log_dir", "");
    const container = h.mount();
    const screen = new SettingsScreen();
    await screen.mount(container);
    screen.setItem("general");
    const select = () => container.querySelector<HTMLSelectElement>("#duplicate-session-policy")!;
    expect(select().value).toBe("ask");

    // The connect dialog persists the remembered choice while Settings sits
    // mounted but hidden; the cached snapshot would otherwise show "ask".
    config = h.fixtures.appConfig({ duplicate_session_policy: "allow" });
    await screen.reloadConfig();
    expect(select().value).toBe("allow");
  });

  it("refreshes the cached config after saving the policy from the dropdown", async () => {
    const h = createHarness();
    let config = h.fixtures.appConfig({ duplicate_session_policy: "ask" });
    h.ipc.mockImpl("get_app_config", () => config);
    h.ipc.mock("get_session_log_dir", "");
    h.ipc.mockImpl("set_duplicate_session_policy", (args) => {
      config = h.fixtures.appConfig({
        duplicate_session_policy: (args as { policy: string }).policy,
      });
      return null;
    });
    const container = h.mount();
    const screen = new SettingsScreen();
    await screen.mount(container);
    screen.setItem("general");
    const select = () => container.querySelector<HTMLSelectElement>("#duplicate-session-policy")!;
    expect(select().value).toBe("ask");

    // Without the refresh, the cached snapshot keeps saying "ask" and the
    // dropdown snaps back when the user returns to General.
    select().value = "focus";
    select().dispatchEvent(new Event("change"));
    await new Promise((r) => setTimeout(r, 0));

    screen.setItem("appearance");
    screen.setItem("general");
    expect(select().value).toBe("focus");
  });
});

describe("SettingsScreen — version footer (#102)", () => {
  async function mountWithVersion(version?: string | Promise<never>) {
    const h = createHarness();
    h.ipc.mock("get_app_config", h.fixtures.appConfig());
    h.ipc.mock("get_session_log_dir", "");
    if (version !== undefined) {
      if (typeof version === "string") h.ipc.mock("plugin:app|version", version);
      else h.ipc.mockImpl("plugin:app|version", () => version);
    }
    const container = h.mount();
    const screen = new SettingsScreen();
    await screen.mount(container);
    return { h, container, screen };
  }

  it("renders the runtime version as the last child of the rail", async () => {
    const { container } = await mountWithVersion("0.5.0");
    const nav = container.querySelector<HTMLElement>(".settings-nav")!;
    const line = nav.lastElementChild!;

    expect(line.classList.contains("settings-nav-version")).toBe(true);
    expect(line.textContent).toBe("Version v0.5.0");
    // The value comes from the runtime call, not a literal in the markup.
    expect(nav.querySelectorAll(".settings-nav-item")).toHaveLength(8);
  });

  it("keeps the footer non-interactive", async () => {
    const { container } = await mountWithVersion("0.5.0");
    const line = container.querySelector<HTMLElement>(".settings-nav-version")!;

    expect(line.hasAttribute("tabindex")).toBe(false);
    expect(line.getAttribute("role")).toBeNull();
    expect(line.tagName).toBe("SPAN");
  });

  it("omits the footer when the version call rejects", async () => {
    const { container } = await mountWithVersion(Promise.reject(new Error("no app plugin")));
    expect(container.querySelector(".settings-nav-version")).toBeNull();
    expect(container.querySelectorAll(".settings-nav-item")).toHaveLength(8);
  });

  it("omits the footer when the version is empty", async () => {
    const { container } = await mountWithVersion("");
    expect(container.querySelector(".settings-nav-version")).toBeNull();
    expect(container.querySelectorAll(".settings-nav-item")).toHaveLength(8);
  });

  it("leaves the roving tabindex cycling only the nav buttons", async () => {
    const { container } = await mountWithVersion("0.5.0");
    const nav = container.querySelector<HTMLElement>(".settings-nav")!;
    const buttons = nav.querySelectorAll<HTMLButtonElement>(".settings-nav-item");
    const footer = container.querySelector(".settings-nav-version")!;
    buttons[0].focus();

    nav.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);
    expect(document.activeElement).not.toBe(footer);

    nav.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(buttons[0]);
  });
});
