/**
 * KbViewerDialog — mount() behavior.
 * Covers the v0.2.0 production bug where an empty platform list (bundled KB
 * path mismatch) left the "Loading knowledge base…" spinner spinning forever,
 * because both load branches in mount() were skipped without rendering anything.
 */
import { describe, it, expect } from "vitest";
import { createHarness } from "../../tests/harness";
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
    h.ipc.mock("list_kb_platforms", ["linux-bash"]);
    h.ipc.mock("load_platform_index", platformIndexFixture());
    h.ipc.mock("get_all_kb_commands", [h.fixtures.command("ip addr")]);
    h.ipc.mock("get_disabled_commands", []);
    // refreshValidation is fire-and-forget from loadPlatform; mock it so the
    // strict harness stays quiet.
    h.ipc.mock("validate_kb", []);
    const el = h.mount();
    await new KbViewerDialog().mount(el);

    expect(el.querySelector(".import-spinner")).toBeNull();
    expect(el.querySelector(".kb-viewer-toolbar")).not.toBeNull();
    expect(el.textContent).toContain("ip addr");
  });
});
