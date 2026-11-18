import { describe, it, expect, beforeEach, vi } from "vitest";
import { NavPanel, NavCallbacks } from "../src/components/nav-panel";
import { createHarness, Harness } from "./harness";

describe("nav panel motion", () => {
  let container: HTMLElement;
  let panel: NavPanel;
  let h: Harness;

  beforeEach(() => {
    h = createHarness();
    h.ipc.mock("get_hosts", [
      h.fixtures.host({ id: "h1", display_name: "alpha" }),
      h.fixtures.host({ id: "h2", display_name: "beta" }),
    ]);
    h.ipc.mock("get_host_groups", []);
    const cb = {} as Record<string, ReturnType<typeof vi.fn>>;
    for (const k of [
      "onSelectHost",
      "onConnectHost",
      "onEditHost",
      "onKbTab",
      "onNewConnection",
      "onAddHostToGroup",
      "onTreeChanged",
    ]) {
      cb[k] = vi.fn();
    }
    cb.getActiveSessions = vi.fn(() => new Set<string>());
    localStorage.removeItem("comnd.nav.expandedGroups");
    container = h.mount();
    panel = new NavPanel(container, cb as unknown as NavCallbacks);
  });

  function body(section: string): HTMLElement {
    const el = container.querySelector<HTMLElement>(
      `.nav-section[data-section="${section}"] .nav-section-items`,
    );
    expect(el, `section ${section} not rendered`).toBeTruthy();
    return el!;
  }

  function header(section: string): HTMLElement {
    return container.querySelector<HTMLElement>(
      `.nav-section[data-section="${section}"] .nav-section-header`,
    )!;
  }

  function hostRow(id: string): HTMLElement {
    const el = container.querySelector<HTMLElement>(`.nav-item[data-host-id="${id}"]`);
    expect(el, `row ${id} not rendered`).toBeTruthy();
    return el!;
  }

  function hostRowWrapper(id: string): HTMLElement {
    return hostRow(id).closest<HTMLElement>(".nav-host-row")!;
  }

  describe("section disclosure", () => {
    // A collapsed section stays visible for its 120ms collapse, so it must
    // leave the tab order at once: otherwise Tab can enter the clipped list.
    it("marks a collapsed section inert and lifts it when opened", async () => {
      await panel.mount();
      expect(body("kb").hasAttribute("inert")).toBe(true);

      panel.setSection("kb");
      expect(body("kb").classList.contains("open")).toBe(true);
      expect(body("kb").hasAttribute("inert")).toBe(false);
    });

    it("restores inert when a section collapses", async () => {
      await panel.mount();
      panel.setSection("kb");
      expect(body("kb").hasAttribute("inert")).toBe(false);

      header("kb").click();
      expect(body("kb").classList.contains("open")).toBe(false);
      expect(body("kb").hasAttribute("inert")).toBe(true);
    });

    it("lifts inert before ArrowRight focuses a row it reveals", async () => {
      await panel.mount();
      header("kb").focus();
      header("kb").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));

      const active = document.activeElement as HTMLElement | null;
      expect(active?.classList.contains("nav-item")).toBe(true);
      expect(active?.closest(".nav-section-items")).toBe(body("kb"));
      expect(body("kb").hasAttribute("inert")).toBe(false);
    });
  });

  describe("host selection settle", () => {
    // The row is rebuilt on every render, so the selection fade starts from
    // transparent. Re-clicking the selected host must not replay it.
    it("settles on a new selection but not on the selected host again", async () => {
      await panel.mount();
      hostRow("h1").click();
      expect(hostRowWrapper("h1").classList.contains("nav-settle")).toBe(true);

      hostRow("h1").click();
      expect(hostRowWrapper("h1").classList.contains("nav-selected")).toBe(true);
      expect(hostRowWrapper("h1").classList.contains("nav-settle")).toBe(false);

      hostRow("h2").click();
      expect(hostRowWrapper("h2").classList.contains("nav-settle")).toBe(true);
    });
  });
});
