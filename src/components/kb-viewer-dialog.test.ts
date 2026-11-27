/**
 * KbViewerDialog — mount() behavior.
 * Covers the v0.2.0 production bug where an empty platform list (bundled KB
 * path mismatch) left the "Loading knowledge base…" spinner spinning forever,
 * because both load branches in mount() were skipped without rendering anything.
 */
import { describe, it, expect, vi } from "vitest";
import type { Command } from "../lib/tauri-api";
import { createHarness, type Harness } from "../../tests/harness";
import { KbViewerDialog } from "./kb-viewer-dialog";

function platformIndexFixture() {
  return {
    id: "linux-bash",
    name: "Linux (bash)",
    description: "General-purpose Linux shell",
    reference_url: "",
    versions: [],
    prompt_patterns: {},
    default_mode: "bash",
  };
}

async function mountViewer(
  h: Harness,
  commands: Command[] | (() => Command[] | Promise<Command[]>),
): Promise<HTMLElement> {
  h.ipc.mock("list_kb_platforms", ["linux-bash"]);
  h.ipc.mock("load_platform_index", platformIndexFixture());
  if (typeof commands === "function") {
    h.ipc.mockImpl("get_all_kb_commands", commands);
  } else {
    h.ipc.mock("get_all_kb_commands", commands);
  }
  // refreshValidation is fire-and-forget from loadPlatform; mock it so the
  // strict harness stays quiet.
  h.ipc.mock("validate_kb", []);
  const el = h.mount();
  await new KbViewerDialog().mount(el);
  return el;
}

function rowFor(el: HTMLElement, name: string): HTMLElement {
  const row = [...el.querySelectorAll<HTMLElement>(".kb-command-item")].find((r) =>
    r.textContent?.includes(name),
  );
  expect(row, `row for "${name}"`).toBeTruthy();
  return row!;
}

describe("KbViewerDialog.mount", () => {
  it("renders an error instead of spinning forever when no platforms exist", async () => {
    const h = createHarness();
    h.ipc.mock("list_kb_platforms", []);
    const el = h.mount();
    await new KbViewerDialog().mount(el);

    expect(el.querySelector(".import-spinner")).toBeNull();
    expect(el.querySelector(".import-error")).not.toBeNull();
    expect(el.textContent).toContain("No knowledge base platforms found");
  });

  it("loads the first platform when a non-empty list is returned", async () => {
    const h = createHarness();
    const el = await mountViewer(h, [h.fixtures.command("ip addr")]);

    expect(el.querySelector(".import-spinner")).toBeNull();
    expect(el.querySelector(".kb-viewer-toolbar")).not.toBeNull();
    expect(el.textContent).toContain("ip addr");
  });
});

describe("KbViewerDialog disabled commands", () => {
  it("keeps a disabled command in its category and renders no Ignored section", async () => {
    const h = createHarness();
    const el = await mountViewer(h, [
      h.fixtures.command("show version", { category: "system" }),
      h.fixtures.command("show ip route", { category: "routing", disabled: true }),
    ]);

    const headers = [...el.querySelectorAll(".kb-category-header")].map((n) => n.textContent ?? "");
    expect(headers.some((t) => t.includes("Ignored"))).toBe(false);
    expect(headers.some((t) => t.startsWith("routing"))).toBe(true);

    const row = rowFor(el, "show ip route");
    expect(row.classList.contains("kb-command-ignored")).toBe(true);
    expect(row.getAttribute("aria-disabled")).toBeNull();
    expect(row.textContent).toContain("disabled from suggestions");
  });

  it("selecting a disabled command shows its details with the disabled banner", async () => {
    const h = createHarness();
    const el = await mountViewer(h, [
      h.fixtures.command("show ip route", { category: "routing", disabled: true }),
    ]);

    rowFor(el, "show ip route").click();

    const detail = el.querySelector("#kb-command-detail")!;
    expect(detail.textContent).toContain("show ip route");
    const banner = detail.querySelector("[role='status']");
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain("Disabled from suggestions");
  });

  it("search still finds a disabled command in its category", async () => {
    const h = createHarness();
    const el = await mountViewer(h, [
      h.fixtures.command("show version", { category: "system" }),
      h.fixtures.command("show ip route", { category: "routing", disabled: true }),
    ]);

    const input = el.querySelector<HTMLInputElement>("#kb-search")!;
    input.value = "route";
    input.dispatchEvent(new Event("input"));

    const row = rowFor(el, "show ip route");
    expect(row.classList.contains("kb-command-ignored")).toBe(true);
    expect(el.querySelector(".kb-category-header")?.textContent).toContain("routing");
  });

  it("toggles disable/enable, updates aria-pressed, and keeps selection and scroll", async () => {
    const h = createHarness();
    let commands: Command[] = [h.fixtures.command("show version", { category: "system" })];
    h.ipc.mockImpl("get_all_kb_commands", () => commands);
    h.ipc.mockImpl("disable_kb_command", () => {
      commands = commands.map((c) => ({ ...c, disabled: true }));
    });
    h.ipc.mockImpl("enable_kb_command", () => {
      commands = commands.map((c) => ({ ...c, disabled: false }));
    });
    h.ipc.mock("list_kb_platforms", ["linux-bash"]);
    h.ipc.mock("load_platform_index", platformIndexFixture());
    h.ipc.mock("validate_kb", []);

    const el = h.mount();
    await new KbViewerDialog().mount(el);

    rowFor(el, "show version").click();
    el.querySelector<HTMLElement>(".kb-command-list")!.scrollTop = 42;

    el.querySelector<HTMLButtonElement>("#kb-cmd-ignore-btn")!.click();
    await vi.waitFor(() =>
      expect(h.ipc.calls("disable_kb_command")).toHaveLength(1),
    );
    expect(h.ipc.calls("disable_kb_command")[0].args).toMatchObject({
      platform: "linux-bash",
      commandName: "show version",
    });

    await vi.waitFor(() =>
      expect(el.querySelector("#kb-cmd-ignore-btn")?.getAttribute("aria-pressed")).toBe("true"),
    );
    const toggle = el.querySelector<HTMLButtonElement>("#kb-cmd-ignore-btn")!;
    expect(toggle.getAttribute("aria-label")).toBe("Enable command");
    expect(el.querySelector(".kb-command-selected")?.textContent).toContain("show version");
    expect(el.querySelector<HTMLElement>(".kb-command-list")!.scrollTop).toBe(42);
    expect(el.querySelector("#kb-command-detail [role='status']")).not.toBeNull();

    toggle.click();
    await vi.waitFor(() =>
      expect(h.ipc.calls("enable_kb_command")).toHaveLength(1),
    );
    expect(h.ipc.calls("enable_kb_command")[0].args).toMatchObject({
      platform: "linux-bash",
      commandName: "show version",
    });
    await vi.waitFor(() =>
      expect(el.querySelector("#kb-cmd-ignore-btn")?.getAttribute("aria-pressed")).toBe("false"),
    );
    expect(el.querySelector("#kb-cmd-ignore-btn")?.getAttribute("aria-label")).toBe("Ignore command");
    expect(el.querySelector("#kb-command-detail [role='status']")).toBeNull();
  });

  it("does not steal the selection when another command is picked during the reload", async () => {
    const h = createHarness();
    const alpha = h.fixtures.command("alpha", { category: "routing" });
    const beta = h.fixtures.command("beta", { category: "routing" });
    let commands: Command[] = [alpha, beta];
    let resolveReload: ((value: Command[]) => void) | null = null;
    let fetches = 0;

    const el = await mountViewer(h, () => {
      fetches += 1;
      if (fetches === 1) return commands;
      return new Promise<Command[]>((resolve) => {
        resolveReload = resolve;
      });
    });
    h.ipc.mockImpl("disable_kb_command", () => {
      commands = commands.map((c) => (c.name === "alpha" ? { ...c, disabled: true } : c));
    });

    rowFor(el, "alpha").click();
    el.querySelector<HTMLButtonElement>("#kb-cmd-ignore-btn")!.click();
    await vi.waitFor(() => expect(h.ipc.calls("disable_kb_command")).toHaveLength(1));
    await vi.waitFor(() => expect(resolveReload).not.toBeNull());

    rowFor(el, "beta").click();
    resolveReload!(commands);

    await vi.waitFor(() =>
      expect(rowFor(el, "alpha").classList.contains("kb-command-ignored")).toBe(true),
    );
    expect(el.querySelector(".kb-command-selected")?.textContent).toContain("beta");
  });

  it("keeps an open edit draft when the reload returns", async () => {
    const h = createHarness();
    const alpha = h.fixtures.command("alpha", { category: "routing" });
    const beta = h.fixtures.command("beta", { category: "routing" });
    let commands: Command[] = [alpha, beta];
    let resolveReload: ((value: Command[]) => void) | null = null;
    let fetches = 0;

    const el = await mountViewer(h, () => {
      fetches += 1;
      if (fetches === 1) return commands;
      return new Promise<Command[]>((resolve) => {
        resolveReload = resolve;
      });
    });
    h.ipc.mockImpl("disable_kb_command", () => {
      commands = commands.map((c) => (c.name === "alpha" ? { ...c, disabled: true } : c));
    });

    rowFor(el, "alpha").click();
    el.querySelector<HTMLButtonElement>("#kb-cmd-ignore-btn")!.click();
    await vi.waitFor(() => expect(resolveReload).not.toBeNull());

    rowFor(el, "beta").click();
    expect(el.querySelector(".kb-command-selected")?.textContent).toContain("beta");
    el.querySelector<HTMLButtonElement>("#kb-cmd-edit-btn")!.click();
    expect(el.querySelector(".kb-edit-form")).not.toBeNull();

    resolveReload!(commands);
    await new Promise((r) => setTimeout(r, 0));

    expect(el.querySelector(".kb-edit-form")).not.toBeNull();
    expect(el.querySelector<HTMLInputElement>("#kb-edit-name")?.value).toBe("beta");
  });
});
