# 018. One `--color-*` naming standard for design tokens, enforced by stylelint

Date: 2026-11-08
Status: Proposed

## Context

`src/styles/tokens.css` is the single token file: about 60 custom properties in `:root` plus six
theme blocks (`light`, `dracula`, `monokai`, `solarized-light`, `nord`, and the default dark).
The core vocabulary — `--color-surface-{primary,secondary,elevated,hover,selected}`,
`--color-text-{primary,secondary,tertiary}`, `--color-{accent,success,warning,error}`,
`--color-border` — is sound and is used roughly 600 times across 16 component stylesheets. It is
the right shape, and it is not the problem.

The problems are at the edges, and nothing guards them:

- **Undefined tokens.** `--font-sans` is used eight times but is never defined; the token is
  `--font-ui`. Six uses hide it behind `var(--font-sans, var(--font-ui))` and two do not, so
  `_dialogs.css:754` and `_terminal-view.css:422` get an invalid `font-family` and inherit.
  `--color-border-strong` is used at `_suggestion.css:26` and is never defined, so it always
  falls back to `--color-border`.
- **A colour token that is not themed, and a badge that fails AA in every theme.**
  `--accent-custom` (`tokens.css:101`, `#38BDF8`) is defined only in `:root` and never
  overridden. It is used as the custom-KB badge's 18% background tint (`main.css:382`) and as a
  border (`_terminal-view.css:248`). The declaration that would have used it as text
  (`main.css:383`) is dead, because `_terminal-view.css:462` overrides it with
  `color: var(--color-text-tertiary) !important`. The surviving colour fails the 4.5:1
  threshold that applies to the badge's `--font-size-2xs` text on its own tint in all six
  themes: 2.18:1 on `--color-surface-secondary` in `solarized-light` and still 2.66:1 in
  `:root`. The target is WCAG 2.1 AA, per `docs/specs/accessibility.md`. The platform badges
  have the same shape — `.badge-nxos` (`_terminal-view.css:459`) is `#0284C7` in `light`, 3.32:1
  on the secondary surface.
- **Dead and inverted tokens.** `--color-border-hover` is used nowhere, and in `:root` and
  `light` it is *less* opaque than `--color-border` (0.20→0.14 and 0.18→0.14), so its name
  describes the opposite of its value; the other four themes are correct (0.14→0.22).
  `--shadow-sm` is also defined and unused.
- **Colour tokens outside the namespace.** `--accent-custom`, `--accent-tint-soft`,
  `--badge-nxos`, `--overlay-backdrop`, `--overlay-solid`, `--suggestion-fade`, `--chrome-tint`
  and `--tint-{iosxe,nxos,tmos,bash}` all carry colour but do not start with `--color-`.
  `--badge-nxos` is a bespoke platform token while the other three platform badges map to
  `--color-accent`, `--color-warning` and `--color-success` (`_terminal-view.css:458-461`).
- **No role tokens, so components reach for primitives.** The focus ring is repeated about 30
  times as `outline: 1px|1.5px|2px solid var(--color-accent)`, with three different widths and
  no shared token. Button hover uses `background: var(--color-border)` (`_buttons.css:48`) and
  danger text uses `color: var(--color-surface-secondary)` (`_buttons.css:53`), because no role
  token exists for either.
- **Local properties bypass the layer.** `--ts-gutter` (`_terminal-view.css:513`) and
  `--preview-gutter` (`_dialogs.css:599`) are unprefixed and undocumented.
- **No enforcement.** There is no stylelint config and no CSS lint step in `package.json`, so
  none of the above is caught by CI.

`docs/specs/03-ui-visual-design.md` also disagrees with `tokens.css` on values
(`--color-surface-secondary` `#111827` against `#0A0F1C`; `--color-border` `0.08` against
`0.20`), and `AGENTS.md` still calls `var(--spacing)` the spacing token. The forcing factor is
growth: more screens and features are planned, and every new page inherits whichever convention
it finds.

## Options

- **Normalise within the current scheme.** Rename the stragglers into `--color-*`, add the
  missing role tokens, delete the dead and inverted ones, and enforce the whole thing with
  stylelint. Cost: a mechanical rename across about 40 files, and every future colour token must
  fit the pattern.
- **Full semantic rewrite to `--color-bg-*` / `--color-fg-*`.** Cost: rewrites roughly 600 call
  sites and all six theme blocks for a vocabulary the current one already expresses; a large diff
  for a small behavioural gain.
- **Two-tier: keep primitives, add an alias layer that components consume.** Cost: doubles the
  token count and adds a lookup to every read, for a design system that does not yet need
  theming indirection.
- **Fix the three bugs only.** Cost: the undefined, inverted and non-namespaced tokens stay, and
  the next page repeats the pattern; no enforcement.

## Decision

Adopt the normalised scheme. It is permanent: a future `--color-bg-*` / `--color-fg-*` rewrite
requires a new ADR that supersedes this one.

1. **Every colour token starts with `--color-`**, in the shape
   `--color-{category}[-{variant}]`. The variant is optional: the core primitives are
   unqualified (`--color-accent`, `--color-border`, `--color-success`). Categories in use:
   `surface`, `text`, `border`, `accent`, `success`, `warning`, `error`, `overlay`, `badge`,
   `platform-tint`, `scrollbar`, `focus-ring`, `fg`, `suggestion` and `chrome`. The rename map:

   | Current | Standard |
   |---|---|
   | `--accent-custom` | `--color-accent-custom` |
   | `--accent-tint-soft` | `--color-accent-soft` |
   | `--badge-nxos` | `--color-badge-nxos` |
   | `--overlay-backdrop` | `--color-overlay-backdrop` |
   | `--overlay-solid` | `--color-overlay-solid` |
   | `--suggestion-fade` | `--color-suggestion-fade` |
   | `--chrome-tint` | `--color-chrome-tint` |
   | `--tint-iosxe` / `-nxos` / `-tmos` / `-bash` | `--color-platform-tint-iosxe` / `-nxos` / `-tmos` / `-bash` |

2. **Non-colour categories keep their prefixes:** `--space-*`, `--font-*`, `--radius-*`,
   `--shadow-*`, `--text-scale`, `--ghost-*` and `--prose-*`. No new top-level prefix without an
   amendment to this ADR.

3. **Add role tokens so components stop reaching for primitives:** `--color-border-strong`
   (replaces the undefined reference), `--color-focus-ring` together with `--focus-ring-width`
   and `--focus-ring-offset`, `--color-fg-on-danger`, `--color-scrollbar-thumb` with
   `--color-scrollbar-thumb-hover`, and `--color-badge-custom` so the custom-KB badge has a
   themeable text colour that meets 4.5:1 on its own tint. Each is defined in `:root` and
   overridden in every theme that changes the underlying colour. The badge tokens replace the
   `!important` overrides that currently win at `_terminal-view.css:459-462`.

4. **No `var()` fallbacks.** Tokens are always defined; a fallback hides a typo, which is how
   `--font-sans` survived. Delete all eight.

5. **Delete, do not deprecate:** the `--spacing` alias (one use, `main.ts:1132`), `--shadow-sm`
   while it is unused, and `--color-border-hover` in favour of `--color-border-strong` with a
   corrected direction.

6. **Component-local properties are prefixed `--local-`**, or promoted to `tokens.css` when more
   than one component needs them.

7. **No raw colour, font-size or radius values in component CSS.** Colour properties take a
   `var()` or a keyword (`transparent`, `currentColor`, `none`, `inherit`). The type scale is
   extended where a real step is missing; the mechanical mapping lives in the tracking issue.

8. **Enforcement is part of the standard, not a follow-up.** Add stylelint with `color-no-hex`,
   `custom-property-pattern`, and `declaration-property-value-allowed-list` covering
   colour-bearing properties, `font-size`, `border-radius` and the `font` shorthand — the
   shorthand matters because `font: 600 27px Inter` hides a raw size that a `font-size` rule
   never sees. Add `scripts/check-css-tokens.mjs` for what stylelint cannot see:
   `var(--undefined)`, tokens that are defined but never used, and a colour literal assigned to
   a `--local-*` property, which `color-no-hex` misses when it is written as `rgb()`. The
   standard is met only when `npm run lint:css` passes in CI.

9. **`tokens.css` is the single source of truth.** Reconcile the values in
   `docs/specs/03-ui-visual-design.md` and the spacing line in `AGENTS.md` to it.

## Consequences

- Easier: a new screen starts from a vocabulary that is complete (role tokens exist), enforced
  (CI fails on an undefined token, a raw colour, a raw `font-size` or a raw radius) and
  documented in one place. The rename itself fixes the two broken `font-family` declarations and
  the undefined `--color-border-strong`. It fixes no colour value, so the badge contrast
  correction is a deliberate value edit in the same change, verified against measured ratios
  rather than assumed from the rename.
- Harder: every colour token must now fit `--color-*`, so a genuinely new category needs this
  ADR amended. The rename touches about 40 files in one change and must land atomically, or the
  theme blocks and the call sites drift apart mid-merge.
- Rules out: a new colour token outside `--color-*`; `var()` fallbacks; the `--spacing` alias;
  raw hex, raw `rgba()`, raw `font-size` or raw radius in component CSS; an `!important`
  component override of a global token; and landing a token change without the stylelint config
  in the same pull request.
- Not covered: the visual design of the new role tokens — which exact opacity
  `--color-border-strong` uses, for example — is a design decision recorded in `tokens.css`. This
  ADR fixes the names and the enforcement, not the values.
- Revisit when: a second product surface needs a different token set, or the six themes diverge
  enough that a two-tier alias layer earns its indirection. That is a new ADR superseding this
  one.
