import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SidebarContent,
  wireExampleCopy,
  wireReferenceLink,
} from "./sidebar-content";
import { openUrl } from "./tauri-api";
import { showToast } from "./toast";
import type { Command } from "./tauri-api";
import { command } from "../../tests/harness";

vi.mock("./tauri-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tauri-api")>();
  return { ...actual, openUrl: vi.fn() };
});

vi.mock("./toast", () => ({ showToast: vi.fn() }));

/** These fixtures are about `reload`; the shared factory supplies the rest. */
const makeCommand = (over: Partial<Command> = {}): Command =>
  command("reload", {
    syntax: "reload [reason <text>]",
    description: "Reload the device",
    category: "system",
    mode: "exec",
    ...over,
  });

const pane = (html: string) => html.replace(/\s+/g, " ");

describe("SidebarContent token pane", () => {
  it("keeps the authored syntax when no token carries help text", () => {
    const html = new SidebarContent().render(makeCommand({
      tokens: [
        { lit: "reload" },
        { lit: "reason", optional: true },
        { var: "reason-text" },
      ],
    }), null);

    // The brackets that mark `reason` optional survive; the notation would drop them.
    expect(pane(html)).toContain('<span class="syntax-optional">[reason &lt;text&gt;]</span>');
    expect(html).not.toContain("token-breakdown");
  });

  it("falls back to the token notation when help text exists but syntax is empty", () => {
    const html = new SidebarContent().render(makeCommand({
      name: "curl",
      syntax: "",
      tokens: [
        { lit: "curl" },
        { lit: "-d", optional: true },
        { var: "data", description: "POST body", optional: true },
      ],
    }), null);

    // A token with no help row would otherwise have no visible representation.
    expect(html).toContain('<code class="token-breakdown">');
    expect(pane(html)).toContain("token-lit");
    expect(pane(html)).toContain("<dt><code>-d &lt;data&gt;</code></dt><dd>POST body</dd>");
  });

  it("falls back to the token notation when syntax is empty and no token has help", () => {
    const html = new SidebarContent().render(makeCommand({
      syntax: "",
      tokens: [{ lit: "reload" }, { lit: "reason", optional: true }],
    }), null);

    expect(pane(html)).toContain('<code class="token-breakdown">');
  });
});

describe("wireExampleCopy", () => {
  let writeText: ReturnType<typeof vi.fn>;
  let root: HTMLElement;
  let rowClicks: number;

  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    root = document.createElement("div");
    root.innerHTML = `
      <div class="example-item" data-command="show version">
        <button class="example-copy" data-command="show version">copy</button>
      </div>`;
    rowClicks = 0;
    root.querySelector(".example-item")?.addEventListener("click", () => { rowClicks++; });
    wireExampleCopy(root);
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("copies without running the row's click-to-run handler", () => {
    root.querySelector<HTMLElement>(".example-copy")?.click();

    expect(writeText).toHaveBeenCalledWith("show version");
    expect(rowClicks).toBe(0);
  });

  it("cancels the pointer press so the button never takes focus", () => {
    const btn = root.querySelector<HTMLElement>(".example-copy")!;
    const event = new MouseEvent("pointerdown", { bubbles: true, cancelable: true });
    btn.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });
});

describe("SidebarContent reference link", () => {
  it("renders the docs link as a button carrying the platform URL", () => {
    const root = document.createElement("div");
    root.innerHTML = new SidebarContent().render(makeCommand(), "https://example.test/kb");

    const link = root.querySelector<HTMLElement>(".cmd-ref-link");
    expect(link?.tagName).toBe("BUTTON");
    expect(link?.textContent).toBe("Documentation ↗");
    expect(link?.dataset.url).toBe("https://example.test/kb");
    // No anchor means no default navigation for the WebView to perform.
    expect(root.querySelector(".cmd-ref-link[href]")).toBeNull();
  });

  it("renders no link when the platform has no reference URL", () => {
    const html = new SidebarContent().render(makeCommand(), null);

    expect(html).not.toContain("cmd-ref-link");
    expect(html).not.toContain("Documentation");
  });
});

describe("wireReferenceLink", () => {
  const url = "https://example.test/kb";

  let root: HTMLElement;

  beforeEach(() => {
    vi.mocked(openUrl).mockReset().mockResolvedValue(undefined);
    vi.mocked(showToast).mockReset();
    root = document.createElement("div");
    root.innerHTML = `<footer><button type="button" class="cmd-ref-link btn-link" data-url="${url}">Documentation ↗</button></footer>`;
    wireReferenceLink(root);
  });

  it("opens the exact URL through openUrl", () => {
    root.querySelector<HTMLElement>(".cmd-ref-link")!.click();

    expect(openUrl).toHaveBeenCalledWith(url);
  });

  it("cancels the click's default action", () => {
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    root.querySelector<HTMLElement>(".cmd-ref-link")!.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it("reports a failed open instead of swallowing it", async () => {
    vi.mocked(openUrl).mockRejectedValue(new Error("no browser"));
    root.querySelector<HTMLElement>(".cmd-ref-link")!.click();

    await vi.waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(
        "Could not open the documentation link",
        "error",
      );
    });
  });
});
