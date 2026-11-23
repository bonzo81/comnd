# 025. Suggestion surfaces settle on arrival and vanish instantly

Date: 2026-11-23
Status: Proposed

## Context

`docs/specs/03-ui-visual-design.md` once said ghost text is "Instant on/off — no animation, no
fade", and `docs/plans/001-implementation-plan.md` said the dropdown and ghost text "must be
instant". The reason was latency: any delay in a terminal reads as lag.

PR #173 (`feat(suggestion): settle suggestions, ghost text and panel content`) added a short
arrival settle to the ghost text, the match-count badge, the suggestion dropdown and the side
panel's content. The spec's Motion section now records it ("Arrivals settle, departures are
instant"). Two older lines still said "no animation": the Ghost Text rule in the same spec, and the
user guide. They contradicted the new rule, so a reader could not tell which one held.

## Options considered

- **Keep everything instant.** Matches the old rule. Rejected: a suggestion that pops in mid-word
  reads as a stutter, and the first attempt at motion showed nothing at all was perceptible below
  about 180ms.
- **Animate arrivals and departures.** Rejected: a surface that lingers after the input stopped
  matching misreports what the remote will receive.
- **Settle arrivals, make departures instant.** Chosen.

## Decision

Ghost text, the match-count badge, the suggestion dropdown and the side panel's content arrive over
180–220ms, and disappear in the frame they stop matching. The arrival never moves glyphs off the
terminal cell grid, and it never replays on a per-keystroke re-render. `prefers-reduced-motion`
removes it. The Ghost Text "instant" rule now applies to departure only.

## Consequences

- Easier: one rule for all three surfaces; the older "no animation" lines no longer contradict it.
- Harder: motion code must hang the entrance class on the hidden-to-shown edge only, because
  `showPayload()` runs per keystroke.
- `docs/plans/001-implementation-plan.md` keeps its original wording as a historical record.
