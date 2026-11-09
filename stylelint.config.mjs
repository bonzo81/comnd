// CSS token gate for docs/adr/018-css-token-naming-standard.md.
//
// stylelint covers what is visible in a declaration; scripts/check-css-tokens.mjs
// covers what needs cross-file reasoning (reads from TypeScript, unused tokens,
// theme coverage, var() fallbacks). `npm run lint:css` runs both.
//
// tokens.css is exempt from the colour rules: it is the one file allowed to
// name a colour, and it is where every other file's colour comes from.

const NO_RAW_COLOUR = "/^(?!.*(#[0-9a-fA-F]{3,8}\\b|\\brgba?\\(|\\bhsla?\\())/";

const COLOUR_PROPERTIES = [
  "color",
  "background",
  "background-color",
  "background-image",
  "border",
  "border-top",
  "border-right",
  "border-bottom",
  "border-left",
  "border-color",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "border-block",
  "border-inline",
  "outline",
  "outline-color",
  "box-shadow",
  "text-shadow",
  "text-decoration-color",
  "column-rule-color",
  "caret-color",
  "accent-color",
  "fill",
  "stroke",
  "scrollbar-color",
  "-webkit-text-fill-color",
];

const colourRules = {
  "color-no-hex": true,
  "declaration-property-value-allowed-list": Object.fromEntries(
    COLOUR_PROPERTIES.map((property) => [property, [NO_RAW_COLOUR]]),
  ),
};

export default {
  rules: {
    // A custom property is either a global token in a known namespace or a
    // component-local one. Anything else is a new namespace nobody agreed to.
    "custom-property-pattern":
      "^((color|space|font|radius|shadow|ghost|prose|local|focus-ring)-[a-z0-9-]+|text-scale)$",

    ...colourRules,

    "declaration-property-value-allowed-list": {
      ...colourRules["declaration-property-value-allowed-list"],
      "font-size": ["inherit", "/^var\\(--font-size-[a-z0-9-]+\\)$/"],
      "border-radius": [
        "0",
        "50%",
        "/^(?:0|var\\(--radius-[a-z0-9-]+\\))(?:\\s+(?:0|var\\(--radius-[a-z0-9-]+\\))){0,3}$/",
      ],
      // The shorthand carries a raw size past the font-size rule, which is why
      // `font: 600 27px Inter` needs its own check.
      font: ["inherit", "/^(?!.*\\d+(?:\\.\\d+)?(px|rem|em|pt|%)).*$/"],
    },
  },

  overrides: [
    {
      files: ["src/styles/tokens.css"],
      rules: {
        "color-no-hex": null,
        "declaration-property-value-allowed-list": null,
      },
    },
  ],
};
