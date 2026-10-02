# Plan: One Import-Progress Listener (Phase 4)

Consolidate the two independent `import-progress` event consumers into one
state-owning module. Standalone plan from the Sep 2026 KB architecture
review; phase 5 of the KB cleanup.

Companion plans, in order: 0 `plan-kb-false-seams.md` ·
1 `plan-kb-contract-test.md` · 2 `plan-kb-platform-truth.md` ·
3 `plan-kb-import-pipeline.md` · **4 this plan** ·
5 `plan-kb-version-filter.md` · 6 `plan-kb-split-modules.md`.

## Why (problem being solved)

The Rust backend emits one event stream for import progress
(`import-progress`, via the `tauri_progress` adapter,
src-tauri/src/import.rs L1307–1312, payload = the `ImportProgress` enum,
import.rs L41–56). The frontend has **two independent listeners** over that
one stream, each maintaining its own state machine:

1. **The import dialog's private listener**
   (`src/components/kb-import-dialog.ts` L145–171, wired at L132):
   maintains the in-dialog progress banner (L299), applies its own
   stage→label mapping (`stageLabel` map, L173–187), and carries its own
   stale-event filter (L152).
2. **The import job singleton** (`src/lib/import-status.ts` L156–193,
   `ensureListening`): maintains job state for any view — status line,
   TTFT heartbeat, `formatProgress` (L39–68) which re-normalizes the Rust
   PascalCase stage tags into kebab-case keys.

Friction, concretely:

- **Two models of "what is happening"** can disagree — the dialog has a
  stale-event filter the singleton lacks, so the two can show different
  stages for the same job.
- **The stage vocabulary is encoded three times**: Rust enum variants →
  `formatProgress`'s kebab re-encoding → the dialog's `stageLabel` map.
  Adding a backend stage touches three hand-maintained maps in two files.
- **The untested half**: neither listener has tests, but the dialog's
  private copy is embedded in an 817-line component where it cannot be
  unit-tested without mounting the whole dialog.

The deletion test: removing the dialog's listener does not move complexity
— it *concentrates* the progress model in `import-status.ts`, which already
exists, is already a module (not a component), and already serves
view-independent consumers. The dialog becomes a pure subscriber, reading
the job module's interface.

## Goals / non-goals

**Goals**

- Exactly one `listen("import-progress")` call site: inside
  `import-status.ts`.
- The dialog's progress banner renders from `importJob` state (subscribe or
  pull per existing patterns), not from its own listener.
- One stage vocabulary: the kebab keys produced by `formatProgress` are the
  canonical frontend stage names; the dialog's `stageLabel` map keys off
  them (labels stay dialog-local — wording is a UI concern — but the *key
  space* is the singleton's).
- The stale-event filter moves into the singleton so both consumers benefit.
- `formatProgress` and the stage normalization get direct vitest coverage
  (currently zero tests touch them).

**Non-goals**

- No backend change: `ImportProgress` enum, event name, and payload stay as
  they are (the enum's shape is pinned by the phase-1 contract fixture
  only insofar as commands are; progress payloads are not part of that
  fixture — fine).
- No visual/UX changes to the banner or status line.
- Not merging `import-status.ts` into any component — it stays a standalone
  lib module.
- Not adding new progress stages or heartbeat behavior — pure
  consolidation of what exists.

## Detailed design

### 1. Absorb the dialog listener into `import-status.ts`

- Move the stale-event filter logic (kb-import-dialog.ts L152) into the
  singleton's event handler: events for a job id older than the current/
  last-completed job id are dropped. Reuse the dialog's semantics exactly
  (do not invent a new filter).
- Ensure the singleton's listener lifecycle is unchanged (it already
  lazily subscribes on first use, L156–160, and never unsubscribes — one
  global listener is the intended shape).
- If the dialog needs per-job granularity it does not already have (e.g.
  distinguishing "my job" from another), expose it through the job
  module's existing interface (job id on `importJob`) rather than a second
  listener.

### 2. Rewrite the dialog as a subscriber

- Delete `listenForProgress`, the `unlistenProgress` field, and the
  listener wiring at L132.
- The dialog's banner rendering (`renderPreview` / the
  `import-progress-banner` at L299) reads from the singleton: either a
  subscription callback the job module already supports, or (if it has
  none) a small `onChange` registration on `importJob` — check the
  module's current consumers for the established pattern and reuse it;
  add nothing speculative.
- The dialog's own stage→label map keeps its *wording* but its *keys*
  become the canonical kebab stages (so `stageLabel` is keyed by
  `formatProgress` output keys, not by raw Rust tags — if it already is
  after phase 0's cleanups, this step is a no-op check).

### 3. Tests for the surviving model

- New `src/lib/import-status.test.ts`: `formatProgress` over every Rust
  `ImportProgress` variant (fetched from the enum list in
  src-tauri/src/import.rs L41–56 — keep the test's variant list in sync
  manually; the phase-1 fixture covers command schema, not progress, so a
  comment cross-referencing the enum's line range is the pragmatic guard).
- Stale-event filter: an event for an old job id does not advance state; a
  current one does. Drive the singleton's handler directly (it must be
  testable without a real Tauri event — inject/mimic the event callback
  the same way other lib tests fake the Tauri layer; check
  `confirm-dialog.test.ts` / `session-channel.test.ts` for the repo's
  established fake-invoke pattern).

## Tasks / checklist

- [ ] Stale-event filter moved into import-status.ts's listener (semantics preserved from dialog L152)
- [ ] Dialog listener (`listenForProgress`, `unlistenProgress`, wiring at L132) deleted
- [ ] Dialog banner renders from the job module via the established consumer pattern
- [ ] `stageLabel` map keyed off canonical `formatProgress` stages
- [ ] New `import-status.test.ts`: every `ImportProgress` variant covered in `formatProgress`; stale-event filter cases
- [ ] `rg "listen\(" src/components/kb-import-dialog.ts` returns nothing
- [ ] `rg "import-progress" src/` returns exactly one `listen` call site (import-status.ts)
- [ ] `npm run build` exits 0
- [ ] `npm run test` exits 0
- [ ] `cargo check` exits 0 (no Rust change expected — confirms scope)

## Verification

- `npm run build` and `npm run test` green; `cargo check` green.
- Manual smoke (both surfaces): start a URL import from the dialog — the
  in-dialog banner advances through stages, and the status-line consumer of
  `importJob` shows the same stage at the same time (open both surfaces if
  the app allows; at minimum confirm no regression in each separately).
- Cancel mid-import: both surfaces show cancellation consistently (this is
  the stale-event/disagreement class this plan removes).
- Paste-text import (no network): stages advance; heartbeat behavior
  unchanged.

## Risks / open questions

- **Event-ordering assumptions**: the dialog may rely on receiving events
  only while mounted (e.g. to reset state on close). Audit the dialog's
  close path at implementation; any reset must now go through the job
  module's interface (e.g. clearing job state when the dialog closes —
  check what today's close handler does with listener state and mirror
  it).
- **Two consumers, one singleton**: if the dialog and status line ever
  show different things after this change, that is a bug in the
  consolidation (they must read the same object), not a reason to fork
  listeners again.
- Open question: should the Rust enum tags themselves become the canonical
  frontend keys (drop the kebab re-encoding)? That would remove one
  vocabulary layer, but changes payload-facing strings across the UI —
  defer; the three-encodings friction is resolved by this plan collapsing
  the consumers, and the kebab normalization is now tested and owned by
  one module. Revisit only if stage keys churn again.