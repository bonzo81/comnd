import { afterEach, describe, expect, it, vi } from "vitest";
import { Dropdown } from "./dropdown";
import type { SuggestionResult, TokenMatch } from "./suggestion-engine";
import type { Command, CommandToken } from "./tauri-api";

function makeCommand(
  name: string,
  opts: { overrides?: boolean; tokens?: CommandToken[] } = {},
): Command {
  return {
    name,
    syntax: name,
    description: "",
    category: "test",
    mode: "shell",
    aliases: [],
    examples: [],
    versions: { introduced: null, deprecated: null, notes: null },
    tags: [],
    ...(opts.tokens ? { tokens: opts.tokens } : {}),
    ...(opts.overrides ? { overrides: true } : {}),
  };
}

function makeResult(
  command: Command,
  opts: { prefix?: string; tokenMatch?: TokenMatch | null } = {},
): SuggestionResult {
  return {
    command,
    matchType: opts.tokenMatch ? "token" : "name",
    matchedText: command.name,
    tokenMatch: opts.tokenMatch ?? null,
    ...(opts.prefix ? { prefix: opts.prefix } : {}),
  };
}

function tokenMatchAt(tokens: CommandToken[], index: number, input = ""): TokenMatch {
  return {
    currentTokenIndex: index,
    currentTokenInput: input,
    consumedTokens: tokens.map((_, i) => i).filter((i) => i < index),
    remainingTokens: tokens.slice(index),
    litWordIndex: 0,
    negated: false,
  };
}

const cleanups: Array<() => void> = [];

function makeDropdown() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const onAccept = vi.fn();
  const dropdown = new Dropdown(container, onAccept);
  cleanups.push(() => {
    dropdown.destroy();
    container.remove();
  });
  return { dropdown, container, onAccept };
}

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

describe("Dropdown — row rendering", () => {
  it("caps rendered rows at 8 and reports the remainder", () => {
    const { dropdown, container } = makeDropdown();
    const results = Array.from({ length: 10 }, (_, i) => makeResult(makeCommand(`cmd${i}`)));

    dropdown.show(results, "");

    expect(container.querySelectorAll(".suggestion-item")).toHaveLength(8);
    expect(container.querySelector(".scroll-indicator")?.textContent).toBe("+2 more");
  });

  it("shows no scroll indicator when every row fits", () => {
    const { dropdown, container } = makeDropdown();
    const results = Array.from({ length: 8 }, (_, i) => makeResult(makeCommand(`cmd${i}`)));

    dropdown.show(results, "");

    expect(container.querySelectorAll(".suggestion-item")).toHaveLength(8);
    expect(container.querySelector(".scroll-indicator")).toBeNull();
  });

  it("renders a custom badge only for KB entries that override a bundled one", () => {
    const { dropdown, container } = makeDropdown();

    dropdown.show(
      [makeResult(makeCommand("custom-cmd", { overrides: true })), makeResult(makeCommand("bundled-cmd"))],
      "",
    );

    const items = container.querySelectorAll(".suggestion-item");
    expect(items[0].querySelectorAll(".badge-custom")).toHaveLength(1);
    expect(items[1].querySelector(".badge-custom")).toBeNull();
  });

  it("renders the remaining tokens as a syntax suffix", () => {
    const tokens: CommandToken[] = [{ lit: "systemctl restart" }, { var: "unit", type: "free" }];
    const command = makeCommand("systemctl restart", { tokens });
    const { dropdown, container } = makeDropdown();

    dropdown.show([makeResult(command, { tokenMatch: tokenMatchAt(tokens, 1) })], "systemctl restart ");

    const suffix = container.querySelector(".suggestion-item .token-suffix");
    expect(suffix?.textContent).toBe("<unit>");
    expect(suffix?.querySelector(".token-var")).not.toBeNull();
  });

  it("skips the typed-text highlight on prefix-command rows", () => {
    const prefixRow = makeResult(makeCommand("systemctl restart"), { prefix: "sudo" });
    const plainRow = makeResult(makeCommand("system status"));
    const { dropdown, container } = makeDropdown();

    dropdown.show([prefixRow, plainRow], "system");

    const items = container.querySelectorAll(".suggestion-item");
    expect(items[0].querySelector(".prefix-match")).toBeNull();
    expect(items[1].querySelectorAll(".prefix-match")).toHaveLength(1);
    expect(container.querySelectorAll(".prefix-match")).toHaveLength(1);
  });
});

describe("Dropdown — selection", () => {
  it("moves the single .selected row with navigation", () => {
    const { dropdown, container } = makeDropdown();
    dropdown.show(
      [makeCommand("alpha"), makeCommand("beta"), makeCommand("gamma")].map((c) => makeResult(c)),
      "",
    );

    const selectedIndex = () => {
      const selected = container.querySelectorAll(".suggestion-item.selected");
      expect(selected).toHaveLength(1);
      return (selected[0] as HTMLElement).dataset.index;
    };

    expect(selectedIndex()).toBe("0");
    dropdown.moveDown();
    expect(selectedIndex()).toBe("1");
    dropdown.moveDown();
    expect(selectedIndex()).toBe("2");
    dropdown.moveUp();
    expect(selectedIndex()).toBe("1");
  });
});

describe("Dropdown — mouse accept", () => {
  it("accepts the clicked row's payload, not row 0's", () => {
    const alphaTokens: CommandToken[] = [{ lit: "alpha" }];
    const betaTokens: CommandToken[] = [{ lit: "beta" }];
    const alpha = makeResult(makeCommand("alpha", { tokens: alphaTokens }), {
      tokenMatch: tokenMatchAt(alphaTokens, 0),
    });
    const beta = makeResult(makeCommand("beta", { tokens: betaTokens }), {
      tokenMatch: tokenMatchAt(betaTokens, 0),
    });
    const { dropdown, container, onAccept } = makeDropdown();

    dropdown.show([alpha, beta], "");

    const row = container.querySelector<HTMLElement>('.suggestion-item[data-index="1"]');
    expect(row).not.toBeNull();
    row!.click();

    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onAccept.mock.calls[0][0].name).toBe("beta");
    expect(onAccept.mock.calls[0][1]).toEqual({ kind: "literal", text: "beta" });
    expect(dropdown.isVisible()).toBe(false);
  });
});
