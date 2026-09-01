import { describe, expect, it } from "vitest";
import { renderToken } from "./tokens";

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