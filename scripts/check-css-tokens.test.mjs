import { describe, expect, it } from "vitest";

import { checkTokens, parseDeclarations, parseReads } from "./check-css-tokens.mjs";

const TOKENS = "src/styles/tokens.css";

function tokensFile(body) {
  return { path: TOKENS, text: `:root {\n${body}\n}\n` };
}

function problems(files) {
  return checkTokens(files).problems;
}

describe("parseDeclarations", () => {
  it("tags each declaration with its block selector", () => {
    const text = ':root {\n  --color-accent: #fff;\n}\n[data-theme="light"] {\n  --color-accent: #000;\n}\n';
    expect(parseDeclarations(text, "t.css")).toEqual([
      { name: "--color-accent", value: "#fff", selector: ":root", file: "t.css" },
      { name: "--color-accent", value: "#000", selector: '[data-theme="light"]', file: "t.css" },
    ]);
  });

  it("ignores commented-out declarations", () => {
    const text = ":root {\n  /* --color-accent: #fff; */\n}\n";
    expect(parseDeclarations(text, "t.css")).toEqual([]);
  });
});

describe("parseReads", () => {
  it("finds reads in a template string", () => {
    expect(parseReads('const s = "var(--color-accent)";', "a.ts")).toEqual([
      { name: "--color-accent", file: "a.ts" },
    ]);
  });

  it("ignores a token named in a line comment", () => {
    expect(parseReads("// var(--color-accent)\nconst a = 1;", "a.ts")).toEqual([]);
    expect(parseReads("const a = 1; // var(--color-accent)", "a.ts")).toEqual([]);
  });

  it("does not mistake a URL for a comment", () => {
    expect(parseReads('const u = "https://x"; const t = "var(--color-accent)";', "a.ts")).toEqual([
      { name: "--color-accent", file: "a.ts" },
    ]);
  });

  it("keeps a line comment in a stylesheet", () => {
    expect(parseReads(".a { content: '// var(--color-accent)'; }", "a.css")).toEqual([
      { name: "--color-accent", file: "a.css" },
    ]);
  });
});

describe("checkTokens", () => {
  it("passes a read that resolves", () => {
    expect(
      problems([
        tokensFile("  --color-accent: #fff;"),
        { path: "src/styles/a.css", text: ".a { color: var(--color-accent); }" },
      ]),
    ).toEqual([]);
  });

  it("reports a read with no declaration", () => {
    const found = problems([
      tokensFile("  --color-accent: #fff;"),
      { path: "src/styles/a.css", text: ".a { color: var(--color-missing); }" },
    ]);
    expect(found).toHaveLength(2);
    expect(found[0]).toContain("undefined token --color-missing");
    expect(found[1]).toContain("unused token --color-accent");
  });

  it("names a file once when a missing token is read twice in it", () => {
    const found = problems([
      tokensFile("  --color-accent: #fff;"),
      {
        path: "src/styles/a.css",
        text: ".a { color: var(--color-missing); }\n.b { color: var(--color-missing); }",
      },
    ]);
    expect(found[0]).toBe("undefined token --color-missing: read in src/styles/a.css but never declared");
  });

  it("ignores a token named in a TypeScript comment", () => {
    expect(
      problems([
        tokensFile("  --color-accent: #fff;"),
        {
          path: "src/components/a.ts",
          text: 'const a = "var(--color-accent)"; // was var(--color-missing)',
        },
      ]),
    ).toEqual([]);
  });

  it("counts a TypeScript read as a use", () => {
    expect(
      problems([
        tokensFile("  --color-platform-tint-iosxe: #123;"),
        {
          path: "src/components/terminal-view.ts",
          text: 'el.style.setProperty("background", "var(--color-platform-tint-iosxe)");',
        },
      ]),
    ).toEqual([]);
  });

  it("does not count a theme override as a use", () => {
    const found = problems([
      {
        path: TOKENS,
        text:
          ':root {\n  --color-accent: #fff;\n}\n[data-theme="light"] {\n' +
          "  --color-accent: #000;\n}\n",
      },
    ]);
    expect(found).toEqual([
      "unused token --color-accent: declared in src/styles/tokens.css but no CSS or TypeScript file reads it",
    ]);
  });

  it("reports a theme token that :root does not declare", () => {
    const found = problems([
      {
        path: TOKENS,
        text: ':root {\n  --color-accent: #fff;\n}\n[data-theme="light"] {\n  --color-extra: #000;\n}\n',
      },
      { path: "src/styles/a.css", text: ".a { color: var(--color-accent); }" },
    ]);
    expect(found.some((line) => line.includes("--color-extra"))).toBe(true);
  });

  it("reports a var() fallback", () => {
    const found = problems([
      tokensFile("  --color-accent: #fff;"),
      { path: "src/styles/a.css", text: ".a { color: var(--color-accent, #fff); }" },
    ]);
    expect(found).toEqual([
      "src/styles/a.css: var(--color-accent, ...) has a fallback; " +
        "ADR 018 rule 4 requires the token to be declared instead",
    ]);
  });

  it("reports a --local-* property holding a colour literal", () => {
    const found = problems([
      tokensFile("  --color-accent: #fff;"),
      { path: "src/styles/a.css", text: ".a { color: var(--color-accent); --local-wash: rgb(255 0 0); }" },
    ]);
    expect(found).toEqual([
      'src/styles/a.css: --local-wash holds the colour literal "rgb(255 0 0)"; ' +
        "a --local-* property must not bypass the colour tokens",
    ]);
  });

  it("allows a --local-* property holding a layout value", () => {
    expect(
      problems([
        tokensFile("  --color-accent: #fff;"),
        {
          path: "src/styles/a.css",
          text: ".a { color: var(--color-accent); --local-gutter: calc(8ch + 12px); }",
        },
      ]),
    ).toEqual([]);
  });

  it("fails loudly when tokens.css is missing", () => {
    expect(problems([{ path: "src/styles/a.css", text: ".a { color: var(--x); }" }])).toContain(
      "missing src/styles/tokens.css; cannot check the token layer",
    );
  });
});
