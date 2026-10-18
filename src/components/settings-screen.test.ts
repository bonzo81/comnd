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
  async function setup() {
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
    };
    let hasToken = false;
    h.ipc.mock("get_app_config", h.fixtures.appConfig());
    h.ipc.mock("get_session_log_dir", "");
    h.ipc.mockImpl("netbox_get_config", () => ({ config: structuredClone(stored), has_token: hasToken }));
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
});
