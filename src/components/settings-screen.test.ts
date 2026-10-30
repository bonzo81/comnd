import { describe, it, expect, vi } from "vitest";
import { createHarness } from "../../tests/harness";
import type { NetBoxConfig } from "../lib/tauri-api";
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
