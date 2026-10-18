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
