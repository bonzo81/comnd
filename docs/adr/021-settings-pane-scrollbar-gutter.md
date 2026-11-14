# 021. The Settings pane reserves a scrollbar gutter so the scaled controls cannot shift

Date: 2026-11-14
Status: Accepted

## Context

`.settings-page` (`src/styles/components/_settings-screen.css:80`) is the scrolling content pane
shared by every Settings page: `flex: 1; max-width: 720px; overflow-y: auto`, with
`container-type: inline-size`. Its rows right-align a fixed-width control
(`.settings-row-control .form-input { width: 280px }`), and below
`@container (max-width: 560px)` (line 184) the rows stack. Scrollbars are styled globally in
`src/styles/base.css:53-58` (`scrollbar-width: thin`, `::-webkit-scrollbar { width: 8px }`).

Issue #116 reported a full-app flicker while dragging Settings → Reading Comfort → UI text scale.
The first measured cause (#117) was `.settings-nav` sizing to the max-content width of its labels,
so each drag step widened the rail and pushed the pane — and the slider under a stationary pointer —
roughly 6.19px per 0.05 step. #117 pinned the rail to `width: 196px` with wrapping labels and made
the pane width scale-invariant as long as the pane's overflow state does not change.

Issue #120 is the remaining case. Where scrollbars take layout space (GTK with overlay scrolling
off, WebView2), raising the text scale eventually makes the pane's content overflow; the scrollbar
appears, takes width out of the pane's content box, and the right-aligned slider moves sideways under
a stationary pointer. The slider re-reads a new value from its new rect, fires `input`, changes
`--text-scale` again, and the drag oscillates. Overlay scrollbars take no layout width, so nothing
shifts there. The stylesheet asks for an 8px scrollbar, but the track this WebKitGTK actually
renders is **21px** (23px unstyled), and that is the shift that matters.

Measured on this repo's Linux box (WebKitGTK 4.1, GTK 3.24) in a real WebKitGTK window that loads
the repo's real compiled `main.css` over a replicated app-shell DOM. **This is a proxy, not the
Tauri window**: same engine and same CSS, no Rust window, no Inter webfont. Two modes were driven
with `GTK_OVERLAY_SCROLLING=0|1`.

| 1200×800, classic scrollbars | pane clientWidth | scrollbar | content width | slider x |
|---|---|---|---|---|
| 1.00x – 1.45x | 720 | 0 | 656 | 861 |
| 1.50x | 699 | 21 | 635 | **840** |

The pane's `scrollHeight` crosses its 702px `clientHeight` at 1.50x (712px), which is exactly when
the track appears. 21px of movement across a 280px slider spanning 1.0–1.5 is ≈ **0.04 scale**
re-derived under a still pointer. At 800×600 the scrollbar is present from the start, so that width
never showed the jump.

Engine probes, in both scrollbar modes: `CSS.supports("scrollbar-gutter", "stable")` is **true**;
`overflow-y: overlay` behaves as `auto`; a `::-webkit-scrollbar { width: 8px }` override renders
10px **even with overlay scrolling on**. CSS therefore cannot distinguish overlay from classic
scrollbars, so the layout cannot be conditioned on which one is in use.

During #117, applying `scrollbar-gutter: stable` globally was rejected as insetting every Settings
pane, on the estimate of the 8px stylesheet width; the measured gutter is 21px, so that rejection
holds more strongly than recorded. `docs/specs/12-dyslexia-mode.md` requires the scale to apply live
while dragging, so deferring the update to pointer release is not a fix.

## Options

- **Reserve the gutter on `.settings-page` only** — `scrollbar-gutter: stable`. The content box no
  longer depends on the overflow state, so nothing moves during a drag. Cost: on classic-scrollbar
  platforms every Settings page renders as if a scrollbar were present, whether or not one is.
- **Reserve the gutter and compensate the padding** — add a `padding-right` reduced by the measured
  gutter so the no-scrollbar inset matches today. Cost: CSS cannot measure the gutter or detect the
  scrollbar mode (probes above), so this needs a runtime probe in TypeScript and a new token on a
  deliberately CSS-only layout path.
- **`scrollbar-gutter: stable both-edges`** — same as the first option plus a matching left inset.
  Cost: a larger, symmetric visual change to every Settings page for no gain here.
- **`overflow-y: scroll`** — universally supported, but permanently renders a track, including on
  overlay-scrollbar platforms, so it breaks "identical on overlay" and is redundant where
  `scrollbar-gutter` is supported (measured true).
- **Keep the scrollbar automatic and pin the controls** — right-anchor the slider so the scrollbar
  cannot move it. Cost: fixes only the controls that get pinned; the rest of the pane still reflows,
  and every future full-width control needs the same treatment.
- **Compensate with JavaScript** — measure the gutter with a `ResizeObserver` and set padding
  dynamically. Cost: layout work in the interaction path, brittle, against the CSS-only layout.
- **Make the pane never overflow at any supported scale** — budget page height so no scrollbar
  appears. Cost: breaks when a page gains a row, and does not hold at the 800px window.
- **Accept the oscillation on classic-scrollbar platforms** — fails #120's done criteria and leaves
  a known drag loop in the app.

## Decision

Add `scrollbar-gutter: stable` to `.settings-page` and nothing else: no `padding-right`
compensation, no TypeScript, no new token, no global rule. The pane's content box is then
independent of the overflow state, so the slider stays under the pointer for the whole range.

Post-change in the proxy, one distinct tuple at every scale: 1200×800 → pane clientWidth 699,
content 635, scrollbar 21, slider x **840**; 800×600 → 317, 253, 21, **485**; a 20-event
1.0 → 1.5 → 1.0 pointer sweep shows no reversal. On overlay scrollbars every compared value
(`clientWidth`, `scrollbarW`, content width, both paddings, slider rect, row flex direction,
`scrollHeight`, `clientHeight`) is identical to the pre-change baseline at all 14 scales and both
widths; only the computed `scrollbar-gutter` changes, from `auto` to `stable`, reserving 0px.

**Accepted cost.** On classic-scrollbar platforms the no-scrollbar state now carries a permanent
21px gutter: text inset 32px → **53px**, content 656 → 635, slider x 861 → 840 at 1200×800. The
slider stays right-aligned with the text, so the pane keeps its intended reading measure and nothing
overlaps; the price is asymmetry between the left and right padding that a runtime probe could have
removed. That probe is the rejected second option.

**Container query.** The unnamed `@container (max-width: 560px)` measures the pane's content box, so
the reserved gutter moves the stacking boundary ~21px earlier in window terms — column at ≤1107,
row at ≥1110 (pre-change: column ≤1086, row ≥1090) — and the rule text stays at 560px because it
still means "content box ≤ 560". A side effect is that stacking is now scale-invariant; pre-change
it was not: at 1100×800 and 1.5x the content was 553px wide yet the rows had not stacked, because
the query settled against the width from before the scrollbar appeared in the same layout pass.

**Preserved.** `.settings-nav` stays `width: 196px` with `flex-shrink: 0` and wrapping labels (#117);
the scale still applies live on `input` (spec 12); overlay-scrollbar platforms render identically.

**Not established.** The real app's gutter width on this Linux box, the WebView2 gutter, and the
behaviour of the scaled pane inside the Tauri window. The proxy reproduces the mechanism and the
invariances; a human drag in the built app under `GTK_OVERLAY_SCROLLING=0`, and on Windows, is still
the confirming evidence for #120.

## Consequences

- What gets easier: the "layout moves under a stationary pointer" class has a recorded decision, so
  the next scrolling pane or full-width control is not solved from scratch; and the measurement
  habit (drive both scrollbar modes, compare the tuple) is written down.
- What gets harder: because every Settings page shares `.settings-page`, the rule binds all of them
  and every classic-scrollbar page now reserves 21px it may not use. A page that needs a different
  treatment needs its own rule and its own justification.
- What this rules out: a global `scrollbar-gutter: stable` (rejected in #117, now on measured
  evidence), a fixed-width custom scrollbar as a workaround (it would apply on overlay platforms
  too), and fixing the slider by applying the scale only on pointer release (spec 12).
- Unrecorded: why #117 preferred pinning the rail to reserving a gutter. That comparison lives only
  in the #117 discussion.
