/**
 * The detail branch is the single renderer both panel homes use, so its
 * reference-link wiring is proven here once rather than per window.
 */
import { describe, expect, it, vi } from "vitest";
import { command } from "../../tests/harness";
import { openUrl } from "./tauri-api";
import { renderSidePanel, type SidePanelHandlers } from "./side-panel-render";

vi.mock("./tauri-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tauri-api")>();
  return { ...actual, openUrl: vi.fn() };
});

function handlers(): SidePanelHandlers {
  return {
    play: vi.fn(),
    add: vi.fn(),
    runExample: vi.fn(),
    retryNetbox: vi.fn(),
    connect: vi.fn(),
    switchSession: vi.fn(),
    openLink: vi.fn(),
  };
}

describe("renderSidePanel detail", () => {
  it("opens the platform reference link through openUrl", () => {
    vi.mocked(openUrl).mockReset().mockResolvedValue(undefined);
    const root = document.createElement("div");

    renderSidePanel(
      root,
      {
        kind: "detail",
        command: command("show version"),
        referenceUrl: "https://example.test/iosxe",
      },
      handlers(),
    );

    root.querySelector<HTMLElement>(".cmd-ref-link")!.click();

    expect(openUrl).toHaveBeenCalledWith("https://example.test/iosxe");
  });
});
