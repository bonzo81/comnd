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
 *
 * Issue #114 added the badge and note guards: the custom-KB badge text on its
 * 18% accent tint, the NX-OS badge, the .kb-override-note border, and the
 * border-strong ordering, in all six themes.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const CSS_PATH = resolve(process.cwd(), "src/styles/tokens.css");

/** Themes whose text pairs are guarded. Dark is included as a regression floor. */
type ThemeId = "dark" | "light" | "dracula" | "monokai" | "solarized-light" | "nord";

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
  dracula: resolveTheme("dracula"),
  monokai: resolveTheme("monokai"),
  "solarized-light": resolveTheme("solarized-light"),
  nord: resolveTheme("nord"),
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
const SELECTED_ON_ELEVATED = ["--color-surface-elevated", "--color-surface-selected"];
const HOVER_ON_PRIMARY = ["--color-surface-primary", "--color-surface-hover"];

interface Pair {
  theme: ThemeId;
  /** Where the pair is rendered, so a failure points at the right element. */
  element: string;
  token: string;
  layers: string[];
}

const TERTIARY_THEMES: ThemeId[] = ["light", "solarized-light"];

/**
 * Muted text in the light themes. The token has to clear every surface it is
 * painted on, and surface-secondary is the worst case: it is the darkest of
 * the three, so a value that passes there passes everywhere.
 */
const TERTIARY_PAIRS: Pair[] = TERTIARY_THEMES.flatMap((theme) =>
  [
    { element: "settings group label", layers: PRIMARY },
    { element: "title bar title", layers: SECONDARY },
    { element: "search result secondary text", layers: ELEVATED },
  ].map(({ element, layers }) => ({ theme, element, token: "--color-text-tertiary", layers })),
);

/**
 * The four F-2 pairs, repeated per theme, plus the pairs on the same surfaces
 * that the token fix also had to clear: the Solarized Light host name on
 * surface-secondary and on a selected card, and the secondary-button label on
 * its hover fill, which the border token used to supply.
 */
const TEXT_PAIRS: Pair[] = [
  ...TERTIARY_PAIRS,
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
  {
    theme: "light",
    element: "secondary button label on hover",
    token: "--color-text-primary",
    layers: HOVER_ON_PRIMARY,
  },
  {
    theme: "solarized-light",
    element: "secondary button label on hover",
    token: "--color-text-primary",
    layers: HOVER_ON_PRIMARY,
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

/**
 * Issue #114 guards. Every theme, because the defects it fixed were theme-wide:
 * the custom badge tint, the NX-OS badge, and the KB override note border.
 */
const ALL_THEMES: ThemeId[] = ["dark", "light", "dracula", "monokai", "solarized-light", "nord"];

/**
 * Rows a badge is painted on. `.badge-custom` appears in the host list, the
 * suggestion dropdown and the KB viewer; `.hs-host-badge` carries no tint of
 * its own, so platform badge text sits straight on the row.
 */
const BADGE_SURFACES: { name: string; layers: string[] }[] = [
  { name: "surface-primary", layers: PRIMARY },
  { name: "surface-secondary", layers: SECONDARY },
  { name: "surface-elevated", layers: ELEVATED },
  { name: "surface-hover", layers: HOVER_ON_PRIMARY },
  { name: "surface-selected on primary", layers: SELECTED_ON_PRIMARY },
  { name: "surface-selected on secondary", layers: SELECTED_ON_SECONDARY },
  { name: "surface-selected on elevated", layers: SELECTED_ON_ELEVATED },
];

describe("badge and note contrast (issue #114)", () => {
  for (const theme of ALL_THEMES) {
    for (const surface of BADGE_SURFACES) {
      const base = () => paint(surface.layers.map((t) => tokenColor(theme, t)));

      it(`${theme} · custom badge on ${surface.name} reaches 4.5:1`, () => {
        // The badge paints its text on the 18% accent tint over the row.
        const tinted = composite(tokenColor(theme, "--color-badge-custom-tint"), base());
        expect(contrast(tokenColor(theme, "--color-badge-custom"), tinted)).toBeGreaterThanOrEqual(
          TEXT_MIN,
        );
      });

      it(`${theme} · NX-OS badge on ${surface.name} reaches 4.5:1`, () => {
        expect(contrast(tokenColor(theme, "--color-badge-nxos"), base())).toBeGreaterThanOrEqual(TEXT_MIN);
      });

      it(`${theme} · KB override note border on ${surface.name} reaches 3:1`, () => {
        const painted = composite(tokenColor(theme, "--color-accent-custom"), base());
        expect(contrast(painted, base())).toBeGreaterThanOrEqual(NON_TEXT_MIN);
      });
    }
  }

  it.each(ALL_THEMES)("%s defines a border-strong stronger than its border", (theme) => {
    // Both tokens are translucent over the surface beneath them, so the more
    // opaque one is the stronger border.
    expect(tokenColor(theme, "--color-border-strong").a).toBeGreaterThan(
      tokenColor(theme, "--color-border").a,
    );
  });

  it.each(ALL_THEMES)("%s badge tint matches its accent at 18%", (theme) => {
    // WebKit before Safari 16.2 has no color-mix(), so macOS 13 paints the
    // static tint while newer engines paint the color-mix() expression. The
    // two must stay the same colour.
    const accent = tokenColor(theme, "--color-accent-custom");
    expect(tokenColor(theme, "--color-badge-custom-tint")).toEqual({
      r: accent.r,
      g: accent.g,
      b: accent.b,
      a: 0.18,
    });
  });

  it.each(ALL_THEMES)("%s danger text clears AA on its error fill", (theme) => {
    // --color-fg-on-danger is the only text colour paired with --color-error.
    // Solarized's red is light enough that ink drops to 4.14:1, so that theme
    // overrides the token to white; every other theme inherits ink.
    expect(contrast(tokenColor(theme, "--color-fg-on-danger"), tokenColor(theme, "--color-error")))
      .toBeGreaterThanOrEqual(TEXT_MIN);
  });
});
