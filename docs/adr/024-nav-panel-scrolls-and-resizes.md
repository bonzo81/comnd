# 024. The nav panel sizes its rows to their text and scrolls, and the panel can be resized

Date: 2026-11-21
Status: Accepted

## Context

Finding F-3 (`docs/testing/manual-matrix.md`) and issue #100: at `--text-scale: 1.5`
(Reading Comfort's maximum) in a 1280×800 window, `.app-nav` gave the folder label
"Core network" 98px of box while the text needed 125px at 19.5px, so `.nav-item-label`
ellipsised it. The label did not truncate at the 1.15 preset, so the cause is the fixed geometry,
not a long name:

```css
.app-nav { width: 240px; overflow-x: hidden; }
.nav-item { height: 32px; }
.nav-item-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
```

(before this change, in `src/styles/components/_nav-panel.css`)

`--font-size-base` is `calc(13px * var(--text-scale))` (`tokens.css:93`), so at 1.5 the label's line
box is 19.5px inside a 32px row whose padding is 8px top and bottom — 35.5px needed, 32px given. Both
halves of the defect come from the same assumption: the panel is a fixed 240px and the row is a
fixed 32px, while the text inside them scales.

The issue's boundaries forbid lowering the maximum scale, redesigning the panel, or revisiting
host-row density, and require the expand/collapse chevron to stay visible and clickable while
`.app-nav` must not scroll horizontally "at any supported scale". That last boundary is the one
this change deliberately reverses: a 240px column cannot hold a 24-character host name at 1.5x
without wrapping or truncating, and both of those were ruled out in review — wrapping pushes the
tree down a line per row, and truncation is the defect being fixed. Reviewing a standalone demo of
the candidate behaviours (wrap, per-label scroll, per-panel scroll, fixed wider panel), the user
chose **per-panel scroll** and asked for the panel to be **resizable in the same change**, the way
the terminal's side panel already is (ADR 003).

## Options

- **Let the row grow and wrap** — `white-space: normal` on the label, `min-height` on the row.
  Simplest, and never overflows. Cost: a folder with long names becomes two-line rows, the tree
  loses its one-row-per-item scanning rhythm, and the panel grows taller at exactly the scale where
  vertical room is already scarce. Rejected by the user.
- **Keep truncating, reveal the full value in a tooltip** — `.nav-host-tip` already exists for host
  rows. Cost: it does not cover folder names at all (F-3 is a folder label), so the issue's first
  acceptance criterion is unmet; and a tooltip is a discovery route, not a rendering one.
- **Scroll the label, not the panel** — `overflow-x: auto` per `.nav-item-label`. Cost: one
  scrollbar per row, a horizontal 8px track eating into a 32px row, and a scroll target that is
  inside a `button` and inside the roving-tabindex nav group.
- **Widen the panel at the top of the scale** — 240px → 360px when `--text-scale` is 1.5. Cost: it
  permanently takes ~120px from the content column and still truncates the names in the issue
  (a 49-character host name needs more than 360px at 19.5px), so it is a partial fix with a fixed
  cost.
- **Scroll the whole panel** — rows size to their own text, the panel takes the widest of them and
  `.app-nav` scrolls. One scrollbar for the whole tree, no row gains height, and the default
  240px stays the default so nothing moves for a user who does not touch the scale. **Chosen.**

## Decision

Rows size to their content, the panel follows them, and the box scrolls:

```css
.app-nav { overflow-x: auto; }
.nav-panel { width: max-content; min-width: 100%; }
```

`max-content` propagates through `.nav-section > .nav-section-items > .nav-host-row > .nav-item`
to the label's `nowrap` width, so no row is ever squeezed and `text-overflow: ellipsis` stops
firing; `min-width: 100%` keeps a narrow tree filling the column instead of collapsing to its
shortest row. Both axes already theme their scrollbar from `base.css:55-86`, which sets
`scrollbar-color: var(--color-scrollbar-thumb) transparent` on `*` and an 8px `::-webkit-scrollbar`
height, so the horizontal bar follows the theme with no new rule — `_nav-panel.css` carries no
scrollbar styling of its own.

The row stops having a fixed height and instead takes a floor that scales with the text:

```css
.nav-item {
  height: max(
    var(--space-8),
    calc(var(--font-size-base) + 2 * var(--space-2) + var(--space-0-5))
  );
  line-height: var(--font-leading-solid);
}
```

32px at the default scale (density unchanged), 37.5px at 1.5 — the 13px/19.5px line box plus the
16px vertical padding plus 2px of slack so a fractional scale cannot shave the last pixel of a
descender. `height`, not `min-height`: the group collapse rule animates `max-height` to `0`, and a
`min-height` floor beats `max-height` in CSS, so a floor would freeze every collapsing row at 32px
and both keyframes would stop moving. Keeping the property that the animation already overrides
leaves the 140ms `max-height`/`padding` collapse, the `nav-row-expand` keyframe and the
`prefers-reduced-motion` block that zeroes `animation-duration` and `transition-duration` for
`.app-nav *` exactly as they were.

The panel becomes resizable, mirroring `.tv-resizer` (`_terminal-view.css:232`):

- `.nav-resizer` is an 8px `role="separator"` handle inserted between the nav and the content
  column, invisible at rest and tinted on hover, focus and drag. Its `margin: 0 calc(-1 * var(--space-2))`
  cancels one `.app-body` gap, so the panel-to-content distance stays the 8px it is today.
- Range 180–420px, additionally capped at 40% of `.app-body` so the content column always keeps
  the larger share; the default stays `240px`.
- Pointer drag (with pointer capture), and the keyboard path the keyboard-first rule requires:
  ← / → by 16px, Shift by 48px, Home to the floor, End to the cap, with `aria-valuemin/max/now`
  kept current.
- The width is announced to the rest of the app as one coalesced `window` resize event per frame,
  which is the event the terminal, the ghost text and the nav tooltip already listen for
  (`terminal-view.ts:758`), so the PTY refits without the nav reaching into them. The clamp is
  re-applied on a window resize only when the window actually shrank past it, so a plain resize
  never undoes a width the user chose.

**Acceptance criterion 2 is met by full visibility, not by the tooltip.** Host names are no longer
truncated, so `.nav-host-tip` stays what it was (hostname, IP, port, platform and OS for the
connected host) instead of becoming the route to a name the panel refuses to show. **Acceptance
criterion 3 ("host names may stay truncated only if the full value stays reachable") is
deliberately reversed** by review: truncating names was ruled out, and a scrollable panel makes
full visibility affordable.

**Not carried over.** The chosen width is session-only; it is not persisted to config, so a restart
returns the panel to 240px. The user did not ask for persistence and it needs a config field and a
migration.

**Accepted risk.** A collapsed group's rows stay in the DOM behind `max-height: 0`, and their text
still contributes its width to `max-content`, so a long name inside a closed folder can make the
panel scroll to a column that has nothing to reveal. It is bounded (the hidden row is the same
width its siblings already force while expanded in most trees) and it disappears once the folder is
opened. The fixes — `overflow: clip` on the collapsed wrapper, or `display: none` after the
transition ends — both interact with the animation this change deliberately leaves alone, so they
are left for a follow-up rather than bundled here.

## Consequences

- What gets easier: F-3 has one cause and one fix — a fixed box around scaling text — so the same
  question about the settings rail or a dialog row now has a written answer to copy; and the nav
  panel is resizable, which it needed independently of Reading Comfort.
- What gets harder: `.nav-item`'s height is now a formula over `--font-size-base` and the vertical
  padding, so changing that padding without the height silently re-clips the label at 1.5x. The
  smoke assertion in `themes-and-text-scale` (`truncated: []` at the maximum scale) is what catches
  that.
- What this rules out: truncating a nav label, wrapping one, or giving a row a `min-height` floor
  while the collapse animation is `max-height`-based.
- Watch: `.app-nav` scrolls on both axes now, so any future absolutely positioned child inside the
  panel is clipped by a scrollport rather than by a fixed box. `.nav-host-tip` already escapes
  through its own positioning (it is `position: fixed` on `document.body`; see the note at
  `_nav-panel.css:521`).
- Verified by `npm run smoke`: `themes-and-text-scale` asserts at 1.5x that no visible nav label
  ellipsises, that a 12+-character folder label renders in full, that `.app-nav` reports
  `overflow-x: auto` and that the chevron sits inside the panel's box; `small-window-long-names`
  asserts the resizer's role, keyboard behaviour and 180px floor, and that a 49-character host name
  renders without its ellipsis at 800×600.
