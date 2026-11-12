import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarContent, wireExampleCopy } from "./sidebar-content";
import type { Command } from "./tauri-api";

function makeCommand(over: Partial<Command> = {}): Command {
  return {
    name: "reload",
    syntax: "reload [reason <text>]",
    description: "Reload the device",
    category: "system",
    mode: "exec",
    aliases: [],
    examples: [],
    versions: { introduced: null, deprecated: null, notes: null },
    tags: [],
    ...over,
  };
}

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
