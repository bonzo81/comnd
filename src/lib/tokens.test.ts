import { describe, expect, it } from "vitest";
import { renderToken, renderTokenHelp } from "./tokens";

describe("renderToken", () => {
  it("renders non-current lit with empty-class wrapper and per-word spans", () => {
    expect(renderToken({ lit: "show ver" })).toBe(
      '<span class=""><span class="token-lit">show</span> <span class="token-lit">ver</span></span>',
    );
  });

  it("highlights trailing words of a current multi-word lit", () => {
    expect(renderToken({ lit: "show version" }, { current: true, litWordIdx: 1 })).toBe(
      '<span class="current"><span class="token-lit">show</span> <span class="token-lit current">version</span></span>',
    );
  });

  it("renders badges mode lit as a single plain span", () => {
    expect(renderToken({ lit: "show version" }, { badges: true })).toBe(
      '<span class="token-lit">show version</span>',
    );
  });

  it("escapes choice elements", () => {
    expect(renderToken({ choice: ["a<b", "c"] }, { badges: true })).toBe(
      '<span class="token-choice">[a&lt;b | c]</span>',
    );
    expect(renderToken({ choice: ["a", "c"] })).toBe(
      '<span class="token-choice ">[a | c]</span>',
    );
  });

  it("adds opt/rep badges to choice", () => {
    expect(renderToken({ choice: ["a"], optional: true, repeatable: true }, { badges: true })).toBe(
      '<span class="token-choice opt rep">[a]</span>',
    );
  });

  it("adds type and source badges to var in badges mode", () => {
    expect(
      renderToken({ var: "if", type: "enumerable", source: "kb" }, { badges: true }),
    ).toBe(
      '<span class="token-var">&lt;if&gt;<span class="token-type-badge">enumerable</span><span class="token-source-badge">kb</span></span>',
    );
  });

  it("omits badges by default on var", () => {
    expect(renderToken({ var: "if", type: "enumerable" })).toBe(
      '<span class="token-var ">&lt;if&gt;</span>',
    );
  });

  it("renders pipe with escaped filters", () => {
    expect(renderToken({ pipe: true, filters: [{ lit: "include" }] }, { badges: true })).toBe(
      '<span class="token-pipe">| include</span>',
    );
    expect(renderToken({ pipe: true, filters: [{ lit: "i&n" }], optional: true })).toBe(
      '<span class="token-pipe ">| i&amp;n</span>',
    );
  });
});

describe("renderTokenHelp", () => {
  it("pairs a var with the flag that takes it", () => {
    expect(renderTokenHelp([
      { lit: "curl" },
      { lit: "-d", optional: true },
      { var: "data", type: "free", optional: true, description: "POST body" },
    ])).toBe(
      '<dl class="token-help"><dt><code>-d &lt;data&gt;</code></dt><dd>POST body</dd></dl>',
    );
  });

  it("pairs a var with an optional keyword that takes it", () => {
    expect(renderTokenHelp([
      { lit: "show mac address-table" },
      { lit: "vlan", optional: true },
      { var: "vlan-id", type: "numeric", optional: true, description: "VLAN number" },
    ])).toBe(
      '<dl class="token-help"><dt><code>vlan &lt;vlan-id&gt;</code></dt><dd>VLAN number</dd></dl>',
    );
  });

  it("leaves the label bare when a required subcommand precedes the var", () => {
    expect(renderTokenHelp([
      { lit: "show ip route" },
      { var: "network", type: "free", optional: true, description: "Destination prefix" },
    ])).toBe(
      '<dl class="token-help"><dt><code>&lt;network&gt;</code></dt><dd>Destination prefix</dd></dl>',
    );
  });

  it("pairs only with the token immediately before the var", () => {
    expect(renderTokenHelp([
      { lit: "curl" },
      { lit: "-H", optional: true },
      { var: "header", description: "Extra header" },
      { var: "url", description: "URL to fetch" },
    ])).toBe(
      '<dl class="token-help">' +
        '<dt><code>-H &lt;header&gt;</code></dt><dd>Extra header</dd>' +
        '<dt><code>&lt;url&gt;</code></dt><dd>URL to fetch</dd>' +
        "</dl>",
    );
  });
});
