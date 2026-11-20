# 023. Suggestion-panel translucency reads through the blur radius, not the alpha

Date: 2026-11-18
Status: Accepted

## Context

`.suggestion-dropdown` (`src/styles/components/_suggestion.css`) sits over the terminal pane. Its
first frost was `color-mix(in srgb, var(--color-surface-elevated) 70%, transparent)` with
`backdrop-filter: blur(20px)`, added so the output behind the list stays faintly present instead of
the panel reading as a hole cut in the window.

Successive alphas — 93%, 84%, 70%, 50% — produced no visible change, reported four times as "still
a solid colour". The panel *was* translucent: the computed style carried the `color-mix` and the
filter, and the rule survived the real cascade. The alpha was simply not the variable that carries
the effect.

## Measurement

Dense mock terminal output behind the box, `.suggestion-dropdown`'s own rect captured as a clipped
screenshot, sampled on a 2px grid and reduced to mean luminance and its standard deviation. Children
hidden with `visibility: hidden`, border and shadow removed, so each capture is fill over backdrop
only. Luminance is `(R+G+B)/3`; the panel's own fill is `--color-surface-elevated` = `#1E293B` =
**43.3**.

| fill | panel tone | spread (sd) | range |
|---|---|---|---|
| opaque `#1E293B` | 43.3 | 0.10 | 30.0–43.3 |
| 70% + blur 20px | 43.2 | 1.55 | 26.7–47.0 |
| 50% + blur 20px | 43.3 | 2.66 | 23.7–53.0 |
| 50% + blur 8px | 43.2 | 5.20 | 23.7–70.0 |
| 50% + blur 6px | 43.3 | 6.13 | 23.7–68.7 |
| 50% + blur 4px | 43.3 | 8.92 | 23.7–75.3 |
| 35% + blur 4px | 43.3 | 11.62 | 21.7–85.7 |

**The panel tone is 43.3 at every alpha from 35% to 100%.** Blurring the dark terminal averages its
text into a wash of ≈43 luminance, which is the same luminance as the elevated surface role; a
50/50 mix of two equal tones is that tone. Alpha therefore only ever changed the texture *behind*
the fill, and `blur(20px)` over an 18px line grid flattened that texture to a 1.5-level spread
against 0.1 for an opaque box — a difference no one perceives as transparency.

The blur radius is what carries the effect: at a 50% fill the spread goes 8.9 / 6.1 / 5.2 / 2.7 for
4 / 6 / 8 / 20px. A smaller radius keeps the output's line shapes as soft bands, which is the cue
that reads as glass.

The coincidence is specific to this surface pair on the dark theme. Where the backdrop's blurred
average is not the elevated tone — a light theme, or a mostly empty terminal — alpha *does* move the
panel tone; it moved it here by nothing.

## Options

- **Lower the alpha further** — 35% still measures 43.3. Rejected: no alpha can change the tone
  while the blurred backdrop averages to the fill's luminance, and the user-visible result was four
  reports of "no change".
- **Raise alpha back to opaque and drop the frost** — cheapest, but loses the intent (the terminal
  staying present behind the list) and the panel becomes a flat slab over output.
- **Small blur radius at a moderate alpha** — keeps the intent and produces a measurable, perceptible
  texture (sd 8.9 at 4px, 6.1 at 6px) while the rows stay legible: peak backdrop luminance behind
  the rows is ≈75, so primary text still clears 8:1.
- **Make the fill lighter than the backdrop** — a tonal step the eye can see, but it changes the
  panel's colour identity in all six themes and pushes the surface role toward the text colour.
  Rejected for this pass; it is the option to reach for if a *tone* change is ever wanted.
- **`saturate()`/`contrast()` on the backdrop** — no effect on a near-greyscale terminal palette.

## Decision

The dropdown is `color-mix(in srgb, var(--color-surface-elevated) 50%, transparent)` with
`backdrop-filter: blur(4px)`. The alpha is set for the ghosting, the radius is set for the structure;
neither alone works. The radius started at 6px and was taken one step down on review: 6px read as
haze laid over the terminal, where 4px keeps the line shapes as bands distinguishable from a fog.
The rationale and the table above are repeated in the comment above the rule so
the next person to "make it more translucent" starts from the measurement.

**Not established.** The figures come from a probe page loading the real `src/styles/main.css` in
WebView2, not from the Tauri window over a live SSH session; the mechanism and the tone invariance
are engine-level and reproduce there, the exact spread on a given theme's terminal palette does not.
The same test has not been run on WebKitGTK (Linux) or WKWebView (macOS), where `backdrop-filter`
cost also differs.

## Consequences

- What gets easier: "the panel does not look translucent" now has a first diagnostic — compare the
  composited tone at two alphas, then compare the spread at two radii — instead of an alpha sweep.
- What gets harder: transparency here is now a two-variable decision, and a future theme whose
  `--color-surface-elevated` sits far from its terminal background will make the same 50%/4px look
  more transparent than it does today. Each theme is a separate check.
- What this rules out: treating alpha as the translucency dial on a surface whose backdrop averages
  to its own luminance, and large blur radii (≥12px) for overlays whose backdrop is line-structured
  text — the radius erases the very structure it is meant to reveal.
- Every theme inherits the rule, because it is derived from the `--color-surface-elevated` role
  rather than a literal. No new token was added; `color-mix()` in a component rule is permitted by
  `scripts/check-css-tokens.mjs`, which restricts colour literals only inside `--local-*` values.
