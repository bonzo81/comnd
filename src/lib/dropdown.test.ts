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

const SYSTEMCTL_OPTIONS = [
  "status", "start", "stop", "restart", "reload", "enable", "disable", "mask",
  "unmask", "is-active", "is-enabled", "list-units", "list-unit-files", "daemon-reload",
];

const SYSTEMCTL_DESCRIPTIONS: Record<string, string> = {
  status: "Show unit status and recent log lines",
  start: "Start a unit",
  stop: "Stop a unit",
  restart: "Restart a unit",
  reload: "Reload the service's own config",
  enable: "Enable at boot (does not start now)",
  disable: "Disable at boot",
  mask: "Prevent the unit from ever starting",
  unmask: "Undo mask",
  "is-active": "Check whether a unit is running",
  "is-enabled": "Check boot-time enablement",
  "list-units": "List loaded units",
  "list-unit-files": "List installed unit files",
  "daemon-reload": "Reload systemd's unit files",
};

function systemctlTokens(): CommandToken[] {
  return [
    { lit: "systemctl" },
    { choice: [...SYSTEMCTL_OPTIONS], descriptions: { ...SYSTEMCTL_DESCRIPTIONS } },
    { lit: "--now", optional: true },
    { var: "unit", type: "free", optional: true },
  ];
}

function systemctlResult(tokens: CommandToken[], currentTokenInput = ""): SuggestionResult {
  return makeResult(makeCommand("systemctl", { tokens }), {
    tokenMatch: tokenMatchAt(tokens, 1, currentTokenInput),
  });
}

describe("Dropdown — choice mode", () => {
  it("renders one .choice-row per allowed word with its KB description", () => {
    const tokens = systemctlTokens();
    const { dropdown, container } = makeDropdown();

    dropdown.show([systemctlResult(tokens)], "systemctl ");

    const rows = container.querySelectorAll(".suggestion-item.choice-row");
    expect(rows).toHaveLength(SYSTEMCTL_OPTIONS.length);
    expect(container.querySelector(".scroll-indicator")).toBeNull();

    rows.forEach((row, i) => {
      const word = SYSTEMCTL_OPTIONS[i];
      expect(row.querySelector(".suggestion-name")?.textContent).toBe(word);
      expect(row.querySelector(".choice-desc")?.textContent).toBe(SYSTEMCTL_DESCRIPTIONS[word]);
    });
  });

  it("moves .selected between choice rows and wraps like listbox-nav", () => {
    const tokens = systemctlTokens();
    const { dropdown, container } = makeDropdown();
    dropdown.show([systemctlResult(tokens)], "systemctl ");

    const selectedIndex = () => {
      const selected = container.querySelectorAll(".choice-row.selected");
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
    dropdown.moveUp();
    expect(selectedIndex()).toBe("0");
    dropdown.moveUp();
    expect(selectedIndex()).toBe(String(SYSTEMCTL_OPTIONS.length - 1));
    dropdown.moveDown();
    expect(selectedIndex()).toBe("0");
  });

  it("sends the full word when none of it has been typed", () => {
    const tokens = systemctlTokens();
    const { dropdown, container, onAccept } = makeDropdown();
    dropdown.show([systemctlResult(tokens)], "systemctl ");

    container.querySelector<HTMLElement>('.choice-row[data-index="1"]')!.click();

    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onAccept.mock.calls[0][0].name).toBe("systemctl");
    expect(onAccept.mock.calls[0][1]).toEqual({
      kind: "choice",
      options: SYSTEMCTL_OPTIONS,
      pick: "start",
    });
    expect(dropdown.isVisible()).toBe(false);
  });

  it("sends only the merged remainder when part of the word is typed", () => {
    const tokens = systemctlTokens();
    const { dropdown, container, onAccept } = makeDropdown();
    dropdown.show([systemctlResult(tokens, "sta")], "systemctl sta");

    container.querySelector<HTMLElement>('.choice-row[data-index="1"]')!.click();

    expect(onAccept.mock.calls[0][1]).toEqual({
      kind: "choice",
      options: SYSTEMCTL_OPTIONS,
      pick: "rt",
    });
  });

  it("merges from the live token match on the keyboard accept path", () => {
    const tokens = systemctlTokens();
    const { dropdown } = makeDropdown();
    // Opened before "sta" was typed, so the cached prefix is stale by design.
    dropdown.show([systemctlResult(tokens)], "systemctl ");
    dropdown.updateResults([systemctlResult(tokens, "sta")]);

    dropdown.moveDown();
    const selected = dropdown.getSelected();
    expect(selected?.command.name).toBe("systemctl");
    expect(dropdown.getSelectedPayload()).toEqual({
      kind: "choice",
      options: SYSTEMCTL_OPTIONS,
      pick: "rt",
    });
  });

  it("keeps the arrow-key position while the partial word still completes that row", () => {
    const tokens = systemctlTokens();
    const { dropdown, container } = makeDropdown();
    dropdown.show([systemctlResult(tokens)], "systemctl ");
    dropdown.moveDown();

    dropdown.updateResults([systemctlResult(tokens, "sta")]);

    const selected = container.querySelectorAll(".choice-row.selected");
    expect(selected).toHaveLength(1);
    expect((selected[0] as HTMLElement).dataset.index).toBe("1");
  });

  it("moves the selection to a row the partial word can complete", () => {
    const tokens = systemctlTokens();
    const { dropdown, container } = makeDropdown();
    dropdown.show([systemctlResult(tokens)], "systemctl ");
    dropdown.moveDown();
    dropdown.moveDown();

    // "sta" rules out "stop", so the selection cannot stay on it.
    dropdown.updateResults([systemctlResult(tokens, "sta")]);

    const selected = container.querySelectorAll(".choice-row.selected");
    expect((selected[0] as HTMLElement).dataset.index).toBe("0");
  });

  it("keeps every row visible but marks the ones the partial word rules out", () => {
    const tokens = systemctlTokens();
    const { dropdown, container } = makeDropdown();
    dropdown.show([systemctlResult(tokens, "sta")], "systemctl sta");

    const rows = container.querySelectorAll<HTMLElement>(".choice-row");
    expect(rows).toHaveLength(SYSTEMCTL_OPTIONS.length);
    expect(rows[0].getAttribute("aria-disabled")).toBeNull();
    expect(rows[1].getAttribute("aria-disabled")).toBeNull();
    expect(rows[2].getAttribute("aria-disabled")).toBe("true");
  });

  it("skips rows the partial word cannot complete when navigating", () => {
    const tokens = systemctlTokens();
    const { dropdown, container } = makeDropdown();
    dropdown.show([systemctlResult(tokens, "sta")], "systemctl sta");

    const selectedIndex = () => {
      const selected = container.querySelectorAll(".choice-row.selected");
      expect(selected).toHaveLength(1);
      return (selected[0] as HTMLElement).dataset.index;
    };

    expect(selectedIndex()).toBe("0");
    dropdown.moveDown();
    expect(selectedIndex()).toBe("1");
    dropdown.moveDown();
    expect(selectedIndex()).toBe("0");
    dropdown.moveUp();
    expect(selectedIndex()).toBe("1");
  });

  it("ignores clicks on rows the partial word cannot complete", () => {
    const tokens = systemctlTokens();
    const { dropdown, container, onAccept } = makeDropdown();
    dropdown.show([systemctlResult(tokens, "sta")], "systemctl sta");

    container.querySelector<HTMLElement>('.choice-row[data-index="2"]')!.click();

    // Accepting "stop" here would leave "systemctl stastop" on the wire.
    expect(onAccept).not.toHaveBeenCalled();
    const selected = container.querySelectorAll(".choice-row.selected");
    expect((selected[0] as HTMLElement).dataset.index).toBe("0");
  });

  it("returns to command rows when the current token is no longer a choice", () => {
    const tokens = systemctlTokens();
    const { dropdown, container } = makeDropdown();
    dropdown.show([systemctlResult(tokens)], "systemctl ");
    expect(container.querySelectorAll(".choice-row")).toHaveLength(SYSTEMCTL_OPTIONS.length);

    dropdown.updateResults([
      makeResult(makeCommand("systemctl", { tokens }), { tokenMatch: tokenMatchAt(tokens, 2) }),
    ]);

    expect(container.querySelector(".choice-row")).toBeNull();
    expect(container.querySelectorAll(".suggestion-item")).toHaveLength(1);
  });

  it("hides when the choice results disappear", () => {
    const tokens = systemctlTokens();
    const { dropdown } = makeDropdown();
    dropdown.show([systemctlResult(tokens)], "systemctl ");

    dropdown.updateResults([]);

    expect(dropdown.isVisible()).toBe(false);
  });
});
