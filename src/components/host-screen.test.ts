/**
 * Narrow HostScreen tests: the host-form save path. Everything else in the
 * screen is untouched — these assert what happens when validation fails and
 * when the save IPC rejects, because both decide whether the user's input is
 * silently lost.
 */

import { describe, expect, it, vi } from "vitest";
import { createHarness } from "../../tests/harness";
import { HostScreen } from "./host-screen";

async function openHostForm() {
  const h = createHarness();
  h.ipc.mock("get_hosts", []);
  h.ipc.mock("get_host_groups", []);
  h.ipc.mock("list_kb_platforms", []);
  h.ipc.mock("agent_list_identities", []);
  h.ipc.mock("list_providers", []);

  const container = h.mount();
  const screen = new HostScreen(
    () => {},
    () => new Set<string>(),
  );
  await screen.mount(container);
  screen.openNewConnection();

  await vi.waitFor(() => expect(document.querySelector("#hs-host-form")).not.toBeNull());
  const form = document.querySelector<HTMLFormElement>("#hs-host-form")!;
  const errors = document.querySelector<HTMLElement>("#hs-form-errors")!;
  const save = document.querySelector<HTMLButtonElement>("#hs-form-save")!;
  const cancel = document.querySelector<HTMLButtonElement>("#hs-form-cancel")!;

  const fill = (name: string, value: string) => {
    const el = form.querySelector<HTMLInputElement>(`[name="${name}"]`);
    if (!el) throw new Error(`missing form field ${name}`);
    el.value = value;
  };

  return { h, screen, form, errors, save, cancel, fill };
}

describe("HostScreen — host form save", () => {
  it("blocks the save IPC and names the blank required fields", async () => {
    const { h, save, errors, form, fill, cancel } = await openHostForm();
    fill("hostname", "10.0.0.5");
    fill("display_name", "");
    fill("username", "   ");

    save.click();

    await vi.waitFor(() =>
      expect(errors.textContent).toBe("Display name is required. Username is required."),
    );
    expect(h.ipc.calls("save_host")).toEqual([]);
    // The form stays open so the user can correct the fields.
    expect(document.querySelector("#hs-host-form")).toBe(form);
    cancel.click();
  });

  it("shows the failure and keeps the form open when the save IPC rejects", async () => {
    const { h, save, errors, form, fill, cancel } = await openHostForm();
    fill("display_name", "Core Router");
    fill("hostname", "10.0.0.5");
    fill("username", "admin");
    h.ipc.mockImpl("save_host", () => Promise.reject(new Error("hosts: disk full")));

    save.click();

    await vi.waitFor(() => expect(errors.textContent).toContain("Save failed:"));
    expect(errors.textContent).toContain("hosts: disk full");
    expect(document.querySelector("#hs-host-form")).toBe(form);
    // No reload and no credential write after a failed save.
    expect(h.ipc.calls("get_hosts")).toHaveLength(1);
    expect(h.ipc.calls("save_credential")).toEqual([]);
    cancel.click();
  });
});
