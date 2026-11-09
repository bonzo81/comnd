// Token-layer checks stylelint cannot express, per docs/adr/018-css-token-naming-standard.md:
//
//   1. every var(--x) read resolves to a declaration, in CSS *and* TypeScript.
//      Four --color-platform-tint-* tokens are only ever read from
//      src/components/terminal-view.ts, so a CSS-only scan would report them as
//      unused and a reader would delete live tokens.
//   2. every token declared in tokens.css is read somewhere. Per-theme
//      overrides are declarations, never uses, so a token that only a theme
//      block mentions still counts as unused.
//   3. a --local-* property holds a component value, never a colour literal.
//   4. a token declared in a theme block also exists in :root, so no theme can
//      inherit a value from the wrong place.
//   5. no var() fallback. A fallback hides a typo: the property silently paints
//      the fallback instead of failing.
//
// Usage: node scripts/check-css-tokens.mjs

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const STYLES_DIR = "src/styles";
const SOURCE_DIR = "src";
const TOKENS_FILE = "src/styles/tokens.css";

const COLOUR_LITERAL =
  /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\bcolor-mix\(|\b(?:transparent|white|black)\b/;
const VAR_WITH_FALLBACK = /\bvar\(\s*(--[a-z0-9-]+)\s*,/g;
const DECLARATION = /^(--[a-z0-9-]+)\s*:\s*([\s\S]+)$/;

const SCRIPT_FILE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const LINE_COMMENT = /(^|[\s;{}()])\/\/.*$/gm;

/**
 * Block comments go from every file. Line comments only go from scripts: CSS
 * has none, and the prefix guard keeps `https://` in a URL intact. Token names
 * are still read from quoted strings, because that is how `terminal-view.ts`
 * references the platform tints.
 */
export function stripComments(text, file = "") {
  const withoutBlocks = text.replace(/\/\*[\s\S]*?\*\//g, "");
  if (!SCRIPT_FILE.test(file)) return withoutBlocks;
  return withoutBlocks.replace(LINE_COMMENT, "$1");
}

/**
 * Declarations of the form `--name: value`, tagged with the selector of the
 * block they sit in. Only meaningful for CSS; the walk is character-based so a
 * block written on one line is read the same as one spread over many.
 */
export function parseDeclarations(text, file) {
  const found = [];
  const selectors = [];
  let buffer = "";

  const flushDeclaration = () => {
    const declaration = buffer.trim();
    buffer = "";
    if (!declaration) return;
    const match = DECLARATION.exec(declaration);
    if (match) {
      found.push({
        name: match[1],
        value: match[2].trim(),
        selector: selectors[selectors.length - 1] ?? null,
        file,
      });
    }
  };

  for (const character of stripComments(text, file)) {
    if (character === "{") {
      selectors.push(buffer.trim());
      buffer = "";
    } else if (character === "}") {
      flushDeclaration();
      selectors.pop();
    } else if (character === ";") {
      flushDeclaration();
    } else {
      buffer += character;
    }
  }
  flushDeclaration();

  return found;
}

/** Every `--name` named by a `var(--name)` read, with the file it came from. */
export function parseReads(text, file) {
  const found = [];
  const pattern = /\bvar\(\s*(--[a-z0-9-]+)/g;
  for (const match of stripComments(text, file).matchAll(pattern)) {
    found.push({ name: match[1], file });
  }
  return found;
}

/** Every `var(--name, ...)` fallback, which ADR 018 rule 4 forbids. */
export function parseFallbacks(text, file) {
  const found = [];
  for (const match of stripComments(text, file).matchAll(VAR_WITH_FALLBACK)) {
    found.push({ name: match[1], file });
  }
  return found;
}

/**
 * @param {{ path: string, text: string }[]} files every CSS and TypeScript file
 *   under src/, as text.
 */
export function checkTokens(files) {
  const problems = [];

  const declarations = files
    .filter((file) => file.path.endsWith(".css"))
    .flatMap((file) => parseDeclarations(file.text, file.path));
  const declared = new Set(declarations.map((entry) => entry.name));

  const reads = files.flatMap((file) => parseReads(file.text, file.path));
  const read = new Set(reads.map((entry) => entry.name));

  for (const fallback of files.flatMap((file) => parseFallbacks(file.text, file.path))) {
    problems.push(
      `${fallback.file}: var(${fallback.name}, ...) has a fallback; ` +
        "ADR 018 rule 4 requires the token to be declared instead",
    );
  }

  for (const name of [...read].sort()) {
    if (declared.has(name)) continue;
    const where = [...new Set(reads.filter((entry) => entry.name === name).map((entry) => entry.file))];
    problems.push(
      `undefined token ${name}: read in ${where.join(", ")} but never declared`,
    );
  }

  const tokensFile = files.find((file) => file.path === TOKENS_FILE);
  if (!tokensFile) {
    problems.push(`missing ${TOKENS_FILE}; cannot check the token layer`);
    return { problems, tokens: [] };
  }

  const tokens = parseDeclarations(tokensFile.text, TOKENS_FILE);
  const rootNames = new Set(
    tokens.filter((entry) => entry.selector === ":root").map((entry) => entry.name),
  );

  for (const entry of tokens) {
    if (entry.selector !== ":root" && !rootNames.has(entry.name)) {
      problems.push(
        `${TOKENS_FILE}: ${entry.name} is declared in ${entry.selector} but not in :root, ` +
          "so a theme that does not override it inherits nothing",
      );
    }
  }

  for (const name of [...new Set(tokens.map((entry) => entry.name))].sort()) {
    if (!read.has(name)) {
      problems.push(
        `unused token ${name}: declared in ${TOKENS_FILE} but no CSS or TypeScript file reads it`,
      );
    }
  }

  for (const entry of declarations) {
    if (!entry.name.startsWith("--local-")) continue;
    if (!COLOUR_LITERAL.test(entry.value)) continue;
    problems.push(
      `${entry.file}: ${entry.name} holds the colour literal "${entry.value}"; ` +
        "a --local-* property must not bypass the colour tokens",
    );
  }

  return { problems, tokens };
}

/** Every CSS and TypeScript file under `dir`, with forward-slash paths. */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(path));
    } else if (/\.(css|ts)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      out.push(path.replace(/\\/g, "/"));
    }
  }
  return out;
}

/** Scans every stylesheet and TypeScript file and exits non-zero on a problem. */
function main() {
  const paths = [...new Set([...walk(STYLES_DIR), ...walk(SOURCE_DIR)])].sort();
  const files = paths.map((path) => ({ path, text: readFileSync(path, "utf8") }));
  const { problems, tokens } = checkTokens(files);

  for (const problem of problems) console.error(`FAIL ${problem}`);

  if (problems.length > 0) {
    console.error(
      `\n${problems.length} token problem(s). The standard is ` +
        "docs/adr/018-css-token-naming-standard.md.",
    );
    return 1;
  }

  const names = new Set(tokens.map((entry) => entry.name));
  console.log(
    `css tokens ok: ${names.size} tokens, ${files.length} files scanned ` +
      `(${paths.filter((path) => path.endsWith(".css")).length} CSS, ` +
      `${paths.filter((path) => path.endsWith(".ts")).length} TypeScript)`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
