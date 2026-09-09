import { describe, expect, it } from "vitest";
import { escAttr, escHtml } from "./format";

describe("escape set pin", () => {
  it("escHtml escapes & < > \"", () => {
    expect(escHtml(`&<>"`)).toBe("&amp;&lt;&gt;&quot;");
  });

  it("escAttr additionally escapes '", () => {
    expect(escAttr(`&<>'"`)).toBe("&amp;&lt;&gt;&#39;&quot;");
  });

  it("tolerates null/undefined inputs", () => {
    expect(escHtml(null as unknown as string)).toBe("");
    expect(escAttr(undefined as unknown as string)).toBe("");
  });

  it.each([
    ["&", "&amp;"],
    ["<", "&lt;"],
    [">", "&gt;"],
    ['"', "&quot;"],
    ["'", "&#39;"],
  ])("escAttr escapes %s", (input, expected) => {
    expect(escAttr(input)).toBe(expected);
  });
});