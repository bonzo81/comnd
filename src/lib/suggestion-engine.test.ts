/**
 * Unit tests for the token-aware suggestion engine.
 * See docs/plan-kb-token-engine.md § 2.5.
 */

import { describe, expect, it } from "vitest";
import { SuggestionEngine, matchTokens, ghostPayloadFor } from "./suggestion-engine";
import { ghostPayloadAcceptText } from "./ghost-text";
import type { Command } from "./tauri-api";

function mkCmd(partial: Partial<Command>): Command {
  return {
    name: "",
    syntax: "",
    description: "",
    category: "test",
    mode: "privileged-exec",
    aliases: [],
    examples: [],
    versions: { introduced: null, deprecated: null, notes: null },
    tags: [],
    tokens: [],
    order: "fixed",
    negatable: false,
    ...partial,
  };
}

const showIpIntBrief: Command = mkCmd({
  name: "show ip interface brief",
  syntax: "show ip interface [brief | <interface-name>]",
  mode: "privileged-exec",
  aliases: ["sh ip int br", "show ip int brief"],
  tokens: [
    { lit: "show ip interface" },
    { choice: ["brief"], optional: true },
    { var: "interface-name", type: "enumerable", source: "device", optional: true },
  ],
  order: "fixed",
});

const showMac: Command = mkCmd({
  name: "show mac address-table",
  syntax:
    "show mac address-table [dynamic | static] [address <mac>] [interface <name>] [vlan <id>]",
  mode: "privileged-exec",
  tokens: [
    { lit: "show mac address-table" },
    { choice: ["dynamic", "static"], optional: true },
    { lit: "address", optional: true },
    { var: "mac-address", type: "free", optional: true },
    { lit: "interface", optional: true },
    { var: "interface-name", type: "enumerable", source: "device", optional: true },
    { lit: "vlan", optional: true },
    { var: "vlan-id", type: "numeric", min: 1, max: 4094, optional: true },
  ],
  order: "free",
});

const ping: Command = mkCmd({
  name: "ping",
  syntax: "ping [<ip-address> | <hostname>] [repeat <count>] [size <bytes>] [source <interface>]",
  mode: "user-exec",
  tokens: [
    { lit: "ping" },
    { var: "destination", type: "free", optional: true },
    { lit: "repeat", optional: true },
    { var: "count", type: "numeric", min: 1, optional: true },
    { lit: "size", optional: true },
    { var: "bytes", type: "numeric", min: 1, max: 65500, optional: true },
    { lit: "source", optional: true },
    { var: "interface", type: "enumerable", source: "device", optional: true },
  ],
  order: "flags-anywhere",
});

const showRun: Command = mkCmd({
  name: "show running-config",
  syntax: "show running-config [interface <name> | section <regex>]",
  mode: "privileged-exec",
  aliases: ["sh run", "show run"],
  tokens: [
    { lit: "show running-config" },
    {
      pipe: true,
      filters: [
        { lit: "section", var: "regex", type: "free" },
        { lit: "include", var: "regex", type: "free" },
        { lit: "begin", var: "regex", type: "free" },
      ],
      optional: true,
      repeatable: true,
    },
  ],
  order: "fixed",
});

const shutdown: Command = mkCmd({
  name: "shutdown",
  syntax: "shutdown",
  mode: "interface-config",
  tokens: [{ lit: "shutdown" }],
  order: "fixed",
  negatable: true,
});

const legacyCmd: Command = mkCmd({
  name: "show platform",
  syntax: "show platform",
  mode: "privileged-exec",
  // no tokens — legacy
});

describe("matchTokens — fixed order", () => {
  it("matches the command stem via name prefix", () => {
    const m = matchTokens("show ip int", showIpIntBrief);
    expect(m).not.toBeNull();
    expect(m!.currentTokenIndex).toBe(0);
    expect(m!.litWordIndex).toBe(2); // inside "show ip interface"
    expect(m!.currentTokenInput).toBe("int");
  });

  it("completes the lit and moves to the next token (choice)", () => {
    const m = matchTokens("show ip interface ", showIpIntBrief);
    expect(m).not.toBeNull();
    expect(m!.currentTokenIndex).toBe(1); // choice token
    expect(m!.currentTokenInput).toBe("");
  });

  it("matches a choice prefix", () => {
    const m = matchTokens("show ip interface b", showIpIntBrief);
    expect(m).not.toBeNull();
    expect(m!.currentTokenIndex).toBe(1);
    expect(m!.currentTokenInput).toBe("b");
  });

  it("advances past a completed choice into the variable", () => {
    const m = matchTokens("show ip interface brief ", showIpIntBrief);
    expect(m).not.toBeNull();
    expect(m!.currentTokenIndex).toBe(2); // interface-name var
    expect(m!.currentTokenInput).toBe("");
  });

  it("skips the optional choice and lands on the variable", () => {
    const m = matchTokens("show ip interface Gi", showIpIntBrief);
    expect(m).not.toBeNull();
    expect(m!.currentTokenIndex).toBe(2); // interface-name var
    expect(m!.currentTokenInput).toBe("Gi");
  });

  it("alias sh ip int br matches the first lit word-by-word", () => {
    const m = matchTokens("sh ip int br", showIpIntBrief);
    expect(m).not.toBeNull();
    // br matches the choice [brief]
    expect(m!.currentTokenIndex).toBe(1);
    expect(m!.currentTokenInput).toBe("br");
  });

  it("returns null when input does not match the lit", () => {
    const m = matchTokens("show ip route", showIpIntBrief);
    expect(m).toBeNull();
  });

  it("returns null when input goes past all tokens", () => {
    const m = matchTokens("show ip interface brief Gi0/0 extra", showIpIntBrief);
    expect(m).toBeNull();
  });

  it("numeric var rejects non-numeric input", () => {
    const cmd = mkCmd({
      name: "vlan",
      tokens: [
        { lit: "vlan" },
        { var: "vlan-id", type: "numeric", min: 1, max: 4094 },
      ],
    });
    const m = matchTokens("vlan abc", cmd);
    expect(m).toBeNull();
  });
});

describe("matchTokens — pipe token", () => {
  it("matches the pipe literal then a filter lit prefix", () => {
    const m = matchTokens("show running-config | s", showRun);
    expect(m).not.toBeNull();
    expect(m!.currentTokenIndex).toBe(1);
    expect(m!.currentTokenInput).toBe("s");
  });

  it("advances past the filter lit into the filter var", () => {
    const m = matchTokens("show running-config | section ", showRun);
    expect(m).not.toBeNull();
    expect(m!.currentTokenInput).toBe("");
  });

  it("rejects an unknown filter", () => {
    const m = matchTokens("show running-config | bogus", showRun);
    expect(m).toBeNull();
  });
});

describe("matchTokens — free order", () => {
  it("matches the stem then points at the first optional", () => {
    const m = matchTokens("show mac address-table ", showMac);
    expect(m).not.toBeNull();
    expect(m!.currentTokenIndex).toBe(1); // choice [dynamic, static]
    expect(m!.currentTokenInput).toBe("");
  });

  it("accepts filters in any order", () => {
    const m = matchTokens("show mac address-table vlan 10 dynamic", showMac);
    expect(m).not.toBeNull();
    // After consuming vlan 10 and dynamic, the next slot is address (first unused optional).
    expect(m!.consumedTokens.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects an unknown filter keyword", () => {
    const m = matchTokens("show mac address-table bogus", showMac);
    expect(m).toBeNull();
  });
});

describe("matchTokens — flags-anywhere order", () => {
  it("matches required stem then optional flags in any order", () => {
    const m1 = matchTokens("ping repeat 5 10.0.0.1", ping);
    expect(m1).not.toBeNull();
    const m2 = matchTokens("ping 10.0.0.1 repeat 5", ping);
    expect(m2).not.toBeNull();
  });

  it("points at the destination var when only the stem is typed", () => {
    const m = matchTokens("ping ", ping);
    expect(m).not.toBeNull();
    expect(m!.currentTokenIndex).toBe(1); // destination var
  });
});

describe("matchTokens — repeatable choice (Phase 4)", () => {
  const ls: Command = mkCmd({
    name: "ls",
    syntax: "ls [-l] [-a] [-h] [-t] [<path>]",
    mode: "shell",
    tokens: [
      { lit: "ls" },
      { choice: ["-l", "-a", "-h", "-t"], optional: true, repeatable: true },
      { var: "path", type: "free", optional: true },
    ],
    order: "flags-anywhere",
  });

  it("accepts the same flag token multiple times", () => {
    const m = matchTokens("ls -l -a", ls);
    expect(m).not.toBeNull();
  });

  it("accepts a mix of repeatable flags then the path", () => {
    const m = matchTokens("ls -l -a -h /var/log", ls);
    expect(m).not.toBeNull();
  });

  it("points at the path var after a single flag", () => {
    const m = matchTokens("ls -l /var", ls);
    expect(m).not.toBeNull();
  });
});

describe("matchTokens — negation", () => {
  it("strips the negation prefix when the command is negatable", () => {
    const m = matchTokens("no shutdown", shutdown, "no ");
    expect(m).not.toBeNull();
    expect(m!.negated).toBe(true);
    expect(m!.currentTokenIndex).toBe(0);
    expect(m!.currentTokenInput).toBe("shutdown");
  });

  it("does not strip when the command is not negatable", () => {
    const m = matchTokens("no shutdown", showIpIntBrief, "no ");
    expect(m).toBeNull();
  });
});

describe("SuggestionEngine.query — integration", () => {
  function engine(...cmds: Command[]): SuggestionEngine {
    const e = new SuggestionEngine();
    e.loadCommands(cmds, "cisco-iosxe", "no ");
    e.setMode("privileged-exec");
    return e;
  }

  it("returns token matches ranked above legacy matches", () => {
    const e = engine(showIpIntBrief, legacyCmd);
    const results = e.query("show ip int");
    expect(results.length).toBeGreaterThan(0);
    // show ip interface brief is a token match; show platform is not a prefix of "show ip int".
    expect(results[0].matchType).toBe("token");
    expect(results[0].command.name).toBe("show ip interface brief");
  });

  it("falls back to legacy name matching for commands without tokens", () => {
    const e = engine(legacyCmd);
    const results = e.query("show plat");
    expect(results.length).toBe(1);
    expect(results[0].matchType).toBe("name");
    expect(results[0].command.name).toBe("show platform");
    expect(results[0].tokenMatch).toBeNull();
  });

  it("uses alias prefix matching for legacy commands", () => {
    const cmd = mkCmd({ name: "show ip route", aliases: ["sh ip ro"] });
    const e = engine(cmd);
    const results = e.query("sh ip ro");
    expect(results.length).toBe(1);
    expect(results[0].matchType).toBe("alias");
  });

  it("empty input returns all commands for the current mode", () => {
    const e = engine(showIpIntBrief, legacyCmd);
    const results = e.query("");
    expect(results.length).toBe(2);
  });

  it("filters by mode", () => {
    const e = engine(showIpIntBrief, shutdown);
    e.setMode("interface-config");
    const results = e.query("");
    expect(results.length).toBe(1);
    expect(results[0].command.name).toBe("shutdown");
  });

  it("token match knows the user is inside the interface-name slot", () => {
    const e = engine(showIpIntBrief);
    const results = e.query("show ip int Gi");
    expect(results[0].matchType).toBe("token");
    const tm = results[0].tokenMatch!;
    expect(tm.currentTokenIndex).toBe(2); // interface-name var
    expect(tm.currentTokenInput).toBe("Gi");
  });

  it("ranks token matches with more consumed tokens higher", () => {
    const a = mkCmd({
      name: "show ip interface brief",
      tokens: [
        { lit: "show ip interface" },
        { choice: ["brief"], optional: true },
      ],
    });
    const b = mkCmd({
      name: "show ip interface",
      tokens: [{ lit: "show ip interface" }],
    });
    const e = engine(a, b);
    const results = e.query("show ip interface b");
    // a consumed the choice token; b only consumed the lit.
    expect(results[0].command.name).toBe("show ip interface brief");
  });
});

// ─── Phase 3: ghost payload derivation ───────────────────────────────

describe("ghostPayloadFor — Phase 3", () => {
  it("completes a multi-word literal from the current word index", () => {
    const m = matchTokens("show ip int", showIpIntBrief)!;
    const p = ghostPayloadFor(m, showIpIntBrief);
    expect(p).not.toBeNull();
    expect(p!.kind).toBe("literal");
    if (p!.kind === "literal") expect(p!.text).toBe("erface");
  });

  it("ghosts the choice pick when at a choice slot", () => {
    const m = matchTokens("show ip interface b", showIpIntBrief)!;
    const p = ghostPayloadFor(m, showIpIntBrief);
    expect(p).not.toBeNull();
    expect(p!.kind).toBe("choice");
    if (p!.kind === "choice") {
      expect(p!.pick).toBe("brief");
      expect(p!.options).toEqual(["brief"]);
    }
  });

  it("ghosts the variable placeholder when at a var slot", () => {
    const m = matchTokens("show ip interface brief Gi", showIpIntBrief)!;
    const p = ghostPayloadFor(m, showIpIntBrief);
    expect(p).not.toBeNull();
    expect(p!.kind).toBe("variable");
    if (p!.kind === "variable") expect(p!.placeholder).toBe("interface-name");
  });

  it("pipe token ghost renders the matching filter lit", () => {
    const m = matchTokens("show running-config | s", showRun)!;
    const p = ghostPayloadFor(m, showRun);
    expect(p).not.toBeNull();
    expect(p!.kind).toBe("choice");
    if (p!.kind === "choice") expect(p!.pick).toBe("section");
  });
});

describe("ghostPayloadAcceptText — Tab behaviour (Phase 3.5)", () => {
  it("accepts literal payloads (returns the completion text)", () => {
    expect(ghostPayloadAcceptText({ kind: "literal", text: "erface" })).toBe("erface");
  });
  it("accepts choice payloads (returns the pick)", () => {
    expect(ghostPayloadAcceptText({ kind: "choice", options: ["brief"], pick: "brief" })).toBe("brief");
  });
  it("accepts text payloads (legacy remainder)", () => {
    expect(ghostPayloadAcceptText({ kind: "text", text: " brief" })).toBe(" brief");
  });
  it("does NOT accept variable placeholders (Tab passes through)", () => {
    expect(ghostPayloadAcceptText({ kind: "variable", placeholder: "interface-name" })).toBeNull();
  });
});