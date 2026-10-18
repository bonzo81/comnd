import { describe, it, expect, vi } from "vitest";
import { createHarness } from "../../tests/harness";
import type { NetBoxConfig } from "../lib/tauri-api";
import { SettingsScreen } from "./settings-screen";

describe("repro", () => {
  it("flow", async () => {
    const h = createHarness();
    let stored: NetBoxConfig = {
      enabled: false, show_empty_folders: false, base_url: "",
      filters: { status: null, sites: [], roles: [], tags: [] },
      platform_policy: "skip", platform_fallback: null, platform_overrides: {},
      default_username: null, default_port: 22, default_credential: null, allow_invalid_certs: false,
    };
    let hasToken = false;
    h.ipc.mock("get_app_config", h.fixtures.appConfig());
    h.ipc.mock("get_session_log_dir", "");
    h.ipc.mockImpl("netbox_get_config", () => ({ config: structuredClone(stored), has_token: hasToken }));
    h.ipc.mockImpl("netbox_get_status", () => ({ has_token: hasToken, has_default_pw: false, last_synced: null }));
    h.ipc.mock("netbox_get_devices", []);
    h.ipc.mock("netbox_get_sites", [{slug:"s1",name:"S1"}]);
    h.ipc.mock("netbox_get_roles", []);
    h.ipc.mock("netbox_get_tags", []);
    h.ipc.mock("list_providers", []);
    h.ipc.mockImpl("netbox_save_config", (args) => { stored = structuredClone(args.config as NetBoxConfig); console.log("SAVE", JSON.stringify(stored)); return structuredClone(stored); });
    h.ipc.mockImpl("netbox_save_token", () => { hasToken = true; return null; });
    h.ipc.mock("netbox_test_connection", { version: "4", device_count: 1 });
    h.ipc.mockImpl("netbox_sync", () => { if (!stored.enabled) throw new Error("DISABLED"); return { fetched: 1, no_primary_ip: 0, skipped_platform: 0, unmatched_platforms: [] }; });
    const c = h.mount();
    const s = new SettingsScreen();
    await s.mount(c);
    s.setItem("netbox");
    await vi.waitFor(() => expect(c.querySelector("#netbox-enabled")).not.toBeNull());
    const q = <T extends HTMLElement>(sel: string) => c.querySelector<T>(sel)!;
    q<HTMLInputElement>("#netbox-enabled").click();
    await vi.waitFor(() => expect(stored.enabled).toBe(true));
    q<HTMLInputElement>("#netbox-url").value = "https://nb.example.com";
    q<HTMLInputElement>("#netbox-token").value = "tok";
    q<HTMLButtonElement>("#netbox-test-btn").click();
    await vi.waitFor(() => expect(q<HTMLButtonElement>("#netbox-token-save").disabled).toBe(false));
    q<HTMLButtonElement>("#netbox-token-save").click();
    await vi.waitFor(() => expect(stored.base_url).toBe("https://nb.example.com"));
    q<HTMLButtonElement>("#netbox-sync-btn").click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Synced 1"));
    await new Promise(r => setTimeout(r, 50));
    console.log("checkbox", q<HTMLInputElement>("#netbox-enabled").checked, "stored", stored.enabled);
    const u = q<HTMLInputElement>("#netbox-default-username"); u.value = "admin"; u.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(stored.default_username).toBe("admin"));
    console.log("checkbox", q<HTMLInputElement>("#netbox-enabled").checked, "stored", stored.enabled);
    q<HTMLButtonElement>("#netbox-sync-btn").click();
    await new Promise(r => setTimeout(r, 50));
    console.log(document.body.textContent?.includes("DISABLED"));
    expect(stored.enabled).toBe(true);
  });
});
