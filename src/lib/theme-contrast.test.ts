/**
 * Theme contrast guard (issue #98).
 *
 * The Light and Solarized Light themes shipped with four text/background pairs
 * below the 4.5:1 WCAG 2.1 AA target that docs/specs/accessibility.md claims
 * (measured baseline: docs/testing/manual-matrix.md F-2). Fixing the tokens
 * once is not enough — a later palette tweak can silently reintroduce the gap,
 * so this test reads src/styles/tokens.css from disk and asserts the ratios.
 *
 * Surfaces are composited the way the browser paints them: a translucent layer
 * (--color-surface-selected) over the opaque base beneath it. Comparing raw
 * hex values would report a ratio the user never sees.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const CSS_PATH = resolve(process.cwd(), "src/styles/tokens.css");

/** Themes whose text pairs are guarded. Dark is included as a regression floor. */
type ThemeId = "dark" | "light" | "solarized-light";

const TEXT_MIN = 4.5;
const NON_TEXT_MIN = 3;
/**
 * F-2 recorded Dark's minimum as 6.28:1, rounded. The unrounded value is
 * 6.276:1, so the floor sits 0.006 below it: a regression below the measured
 * baseline fails, while the record's own rounding cannot cause a false failure.
 */
const DARK_FLOOR = 6.27;

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function parseDeclarations(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const declaration of body.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon === -1) continue;
    const name = declaration.slice(0, colon).trim();
    if (!name.startsWith("--")) continue;
    out[name] = declaration.slice(colon + 1).trim();
  }
  return out;
}

function parseBlocks(css: string): Record<string, Record<string, string>> {
  const blocks: Record<string, Record<string, string>> = {};
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  for (const match of css.matchAll(pattern)) {
    const selector = match[1].trim().replace(/\s+/g, " ");
    blocks[selector] = parseDeclarations(match[2]);
  }
  return blocks;
}

const BLOCKS = parseBlocks(stripComments(readFileSync(CSS_PATH, "utf8")));

/** A theme is `:root` (the dark base) with its own block merged over it. */
function resolveTheme(theme: ThemeId): Record<string, string> {
  const base = BLOCKS[":root"];
  if (!base) throw new Error("tokens.css: no :root block found");
  const overrides = theme === "dark" ? undefined : BLOCKS[`[data-theme="${theme}"]`];
  if (theme !== "dark" && !overrides) {
    throw new Error(`tokens.css: no [data-theme="${theme}"] block found`);
  }
  return { ...base, ...overrides };
}

const THEMES: Record<ThemeId, Record<string, string>> = {
  dark: resolveTheme("dark"),
  light: resolveTheme("light"),
  "solarized-light": resolveTheme("solarized-light"),
};

function parseColor(value: string): Rgba {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const digits = hex[1];
    const full =
      digits.length === 3
        ? digits
            .split("")
            .map((c) => c + c)
            .join("")
        : digits;
    return {
      r: parseInt(full.slice(0, 2), 16),
      g: parseInt(full.slice(2, 4), 16),
      b: parseInt(full.slice(4, 6), 16),
      a: 1,
    };
  }

  const functional = /^rgba?\(([^)]+)\)$/i.exec(value);
  if (functional) {
    const parts = functional[1].split(",").map((part) => Number(part.trim()));
    if (parts.length < 3 || parts.slice(0, 3).some((part) => Number.isNaN(part))) {
      throw new Error(`unsupported color value: ${value}`);
    }
    return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
  }

  throw new Error(`unsupported color value: ${value}`);
}

function tokenColor(theme: ThemeId, token: string): Rgba {
  const value = THEMES[theme][token];
  if (value === undefined) {
    throw new Error(`${theme}: token ${token} is not defined in tokens.css`);
  }
  return parseColor(value);
}

/** Paint `over` on top of `under`, keeping fractional channels. */
function composite(over: Rgba, under: Rgba): Rgba {
  const a = over.a + under.a * (1 - over.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  return {
    r: (over.r * over.a + under.r * under.a * (1 - over.a)) / a,
    g: (over.g * over.a + under.g * under.a * (1 - over.a)) / a,
    b: (over.b * over.a + under.b * under.a * (1 - over.a)) / a,
    a,
  };
}

/** Layers are listed back-to-front; the first must be opaque. */
function paint(layers: Rgba[]): Rgba {
  if (layers.length === 0) throw new Error("paint() needs at least one layer");
  if (layers[0].a !== 1) throw new Error("paint() needs an opaque base layer");
  return layers.reduce((under, over) => composite(over, under));
}

function channel(value: number): number {
  const scaled = value / 255;
  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

function luminance({ r, g, b }: Rgba): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: Rgba, b: Rgba): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

const PRIMARY = ["--color-surface-primary"];
const SECONDARY = ["--color-surface-secondary"];
const ELEVATED = ["--color-surface-elevated"];
const SELECTED_ON_PRIMARY = ["--color-surface-primary", "--color-surface-selected"];
const SELECTED_ON_SECONDARY = ["--color-surface-secondary", "--color-surface-selected"];

interface Pair {
  theme: ThemeId;
  /** Where the pair is rendered, so a failure points at the right element. */
  element: string;
  token: string;
  layers: string[];
}

/**
 * The four F-2 pairs, repeated per theme, plus the two Solarized Light pairs
 * on the same surfaces that the token fix also had to clear (the host name on
 * surface-secondary and on a selected card).
 */
const TEXT_PAIRS: Pair[] = [
  {
    theme: "light",
    element: "settings nav active label",
    token: "--color-accent",
    layers: SELECTED_ON_PRIMARY,
  },
  { theme: "light", element: "New Connection nav label", token: "--color-accent", layers: PRIMARY },
  {
    theme: "light",
    element: "recent-session timestamp",
    token: "--color-text-secondary",
    layers: SELECTED_ON_SECONDARY,
  },
  {
    theme: "solarized-light",
    element: "settings nav active label",
    token: "--color-accent",
    layers: SELECTED_ON_PRIMARY,
  },
  {
    theme: "solarized-light",
    element: "New Connection nav label",
    token: "--color-accent",
    layers: PRIMARY,
  },
  {
    theme: "solarized-light",
    element: "recent-session timestamp",
    token: "--color-text-secondary",
    layers: SELECTED_ON_SECONDARY,
  },
  {
    theme: "solarized-light",
    element: "host name",
    token: "--color-text-primary",
    layers: SECONDARY,
  },
  {
    theme: "solarized-light",
    element: "host name on selected card",
    token: "--color-text-primary",
    layers: SELECTED_ON_SECONDARY,
  },
];

const DARK_PAIRS: Pair[] = [
  { theme: "dark", element: "settings nav active label", token: "--color-accent", layers: SELECTED_ON_PRIMARY },
  { theme: "dark", element: "New Connection nav label", token: "--color-accent", layers: PRIMARY },
  {
    theme: "dark",
    element: "recent-session timestamp",
    token: "--color-text-secondary",
    layers: SELECTED_ON_SECONDARY,
  },
  { theme: "dark", element: "host name on selected card", token: "--color-text-primary", layers: SELECTED_ON_SECONDARY },
];

function textRatio(pair: Pair): number {
  return contrast(tokenColor(pair.theme, pair.token), paint(pair.layers.map((t) => tokenColor(pair.theme, t))));
}

describe("theme text contrast (WCAG 2.1 AA)", () => {
  it.each(TEXT_PAIRS)("$theme · $element reaches 4.5:1", (pair) => {
    // Unrounded: 4.499 must fail, not round up to a pass.
    expect(textRatio(pair)).toBeGreaterThanOrEqual(TEXT_MIN);
  });

  it("Dark theme keeps its F-2 baseline of 6.28:1 over the same elements", () => {
    const ratios = DARK_PAIRS.map(textRatio);
    const worst = Math.min(...ratios);
    // Not a threshold on each pair: F-2 recorded a single minimum for Dark, and
    // that is the number the issue says must not regress.
    expect(worst).toBeGreaterThanOrEqual(DARK_FLOOR);
  });
});

const NON_TEXT_SURFACES: { name: string; layers: string[] }[] = [
  { name: "surface-primary", layers: PRIMARY },
  { name: "surface-secondary", layers: SECONDARY },
  { name: "surface-elevated", layers: ELEVATED },
  { name: "surface-selected", layers: SELECTED_ON_PRIMARY },
];

const NON_TEXT_TOKENS = ["--color-accent", "--color-border"] as const;

describe("theme non-text contrast (focus rings, borders)", () => {
  for (const theme of ["light", "solarized-light"] as const) {
    for (const token of NON_TEXT_TOKENS) {
      for (const surface of NON_TEXT_SURFACES) {
        it(`${theme} · ${token} on ${surface.name} reaches 3:1`, () => {
          const layers = surface.layers.map((t) => tokenColor(theme, t));
          const base = paint(layers);
          // A border or focus ring is painted over the surface, then measured
          // against that same surface.
          const painted = composite(tokenColor(theme, token), base);
          expect(contrast(painted, base)).toBeGreaterThanOrEqual(NON_TEXT_MIN);
        });
      }
    }
  }
});
