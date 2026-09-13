# Plan: KB Schema Deepening — Single Validator & Shared Token Module

The knowledge base is a core differentiator of netssh: it is both the
reference for commands and the live guide during a session (see
docs/specs/06-knowledge-base.md for the YAML schema and docs/specs/05-suggestion-engine.md
for the suggestion flow). Its correctness therefore depends on two things
being solid: **schema validation** (KB files must be checked against the
documented token schema) and **one shared interpretation of the token
vocabulary** (`lit | choice | var | pipe`) across every module that matches,
validates, or renders a command.

Today both are fragmented:

1. **The schema is validated twice.** Rust (`src-tauri/src/kb.rs`) holds the
   canonical validator (`validate_command` / `validate_platform`, tested in
   kb.rs's test suite and reused by the import pipeline). But
   `src/lib/kb-validator.ts` is a hand-maintained TypeScript mirror — its
   header says "same checks, same message strings" — kept in sync by
   discipline, with no test pinning the two copies together. Any drift is
   invisible until a user sees mismatched validation output.
2. **The token vocabulary is interpreted in six places.** Four modules each
   carry their own copy of the token type guards (`isLit`/`isChoice`/
   `isVar`/`isPipe`), and two of them carry near-identical token→HTML
   renderers. A change to how a token kind works — or a new token kind —
   must be replicated across all of them.

This plan consolidates both into fewer, deeper modules:

1. **Delete the TypeScript validator mirror** (`kb-validator.ts`) — the
   Rust validator in `kb.rs` becomes the single source of truth, and
   validation issues cross the Tauri IPC seam once per platform load
   instead of being recomputed (and re-drifted) in the frontend.
2. **One shared token module** (`src/lib/tokens.ts`) — a single home for
   the token type guards and one token→HTML renderer, consumed by the
   suggestion engine, the suggestion dropdown, and the terminal sidebar.

Both refactors are deletion-first: net lines go down, rendered output and
matching behaviour are unchanged, and no new IPC is added to the
keystroke path (which must stay free of Rust round-trips per
AGENTS.md — all per-keystroke suggestion logic runs in the frontend
against commands loaded once at connect time).

## Background

Current state, for readers without session context:

- **What the token schema is.** Each command in `knowledge-base/
  <platform>/commands/*.yaml` may declare `tokens`: an ordered list of
  `lit` (fixed keywords), `choice` (one of a fixed keyword set), `var`
  (variable slots, optionally typed/bounded), and `pipe` (filter
  separator) entries. `src/lib/suggestion-engine.ts` matches user input
  against these positionally; the dropdown and terminal sidebar render
  them back to the user. Full schema: docs/specs/06-knowledge-base.md
  § "Token Schema".
- **The duplicated validator.** `src/lib/kb-validator.ts` mirrors
  `kb.rs::validate_command` ("same checks, same message strings"), held
  in sync by hand. Nothing pins the copies together, and the TS copy has
  no tests (the Rust original does). Its only consumer is the inline
  issue badges in `sidebar-content.ts:83`.
- **The seam already exists.** The Rust side exposes validation results
  over Tauri IPC: the `validate_kb` command (`src-tauri/src/lib.rs:182`)
  returns `KbValidationIssue[]`, already wrapped in TypeScript as
  `validateKb()` (`src/lib/tauri-api.ts:123`) — currently **uncalled**
  by any component. The plan wires this existing seam rather than
  inventing a new one.
- **Scattered token interpretation.** Type guards ×4
  (`suggestion-engine.ts:99`, `kb-validator.ts:17`, `dropdown.ts:266`
  (self-labelled "duplicated from suggestion-engine"),
  `sidebar-content.ts:124`), and two near-identical token→HTML renderers
  (`dropdown.ts:229 renderToken`, `sidebar-content.ts:97 renderToken`).
  A new token kind touches 6 files.

## Scope boundaries

In scope:
- Remove `src/lib/kb-validator.ts` and all imports of it.
- Surface Rust validation issues in the terminal sidebar (and anywhere
  else the mirror was used) via the existing `validateKb` IPC, cached per
  platform at load time.
- New `src/lib/tokens.ts`: shared type guards + one `renderToken`
  function. Engine, dropdown, sidebar-content import from it.
- Keep the rendered HTML identical to today (class names, structure) —
  pure consolidation, no visual diff.

Out of scope:
- Any matching-behaviour change in `suggestion-engine.ts` (guards move
  out; matchers stay put).
- min/max range enforcement, `values` completion, `VarType::Choice`
  cleanup, dead `queryKb` params — the schema currently declares fields
  the matcher never reads (e.g. `min`/`max` are validated but not
  enforced, `VarType::Choice` has no code path, `setVersion` has no
  caller, and `queryKb` carries unused `prefix`/`mode` params). Those
  gaps are real but orthogonal: this plan changes no matching behaviour.
- Rust-side changes beyond none: `kb.rs` validator is canonical and
  untouched.
- Device tab-completion (post-MVP per docs/08).

## Phase ordering

| Phase | Ships | Depends on |
|---|---|---|
| 1 | Issues cache: platform load fetches `validateKb()` once | — |
| 2 | Delete `kb-validator.ts`; sidebar renders from the cache | 1 |
| 3 | `tokens.ts` with guards; engine/dropdown/sidebar adopt | — (parallel-safe with 1–2) |
| 4 | One `renderToken` in `tokens.ts`; both renderers deleted | 3 |

Phases 1–2 and 3–4 are independent; land in either order or interleaved.
Each phase leaves `npm run build` green.

---

## Phase 1 — Issues cache at platform load

Goal: the frontend holds `KbValidationIssue[]` per platform, fetched once
at KB load, with zero new IPC in the keystroke path.

### 1.1 Cache shape

Small map held by the module that already owns platform KB state
(`terminal-view` load path, or a tiny `validation-cache.ts` if terminal
view is already crowded — prefer reusing existing state, start with the
fewest files):

```ts
// issues per platform, fetched via validateKb(platform) at load
const issuesByPlatform = new Map<string, KbValidationIssue[]>();

// lookup: all issues for one command
export function issuesFor(cmdName: string): KbValidationIssue[] { ... }
```

### 1.2 Fetch point

Where `loadKbCommands` already runs (`terminal-view.ts`, connect time),
call `validateKb(platform)` alongside it and populate the cache. Also
invalidate on KB import/save/delete (those flows already trigger KB
reloads — hook the same points).

### 1.3 Failure mode

`validateKb` rejection → log via existing `logger`, cache an empty list.
Sidebar simply shows no issue badges; never blocks the terminal.

### Verification

- `npm run build` exits 0.
- Manual: connect to a host with a deliberately malformed user-KB command
  → sidebar still shows the badge, one `validate_kb` call in the log.

## Phase 2 — Delete the mirror

Goal: `src/lib/kb-validator.ts` is gone; every former consumer reads from
the cache.

### 2.1 Migrate the consumer

`sidebar-content.ts:83` is the only caller of `validateCommand`. Change
`SidebarContent.render()` to receive the pre-fetched issue list (argument
or cache lookup by `command.name`), delete the
`import { validateCommand } from "./kb-validator"` line.

The KbValidationIssue interface already exists in `tauri-api.ts:117` —
use that type everywhere; `kb-validator.ts`'s duplicate interface dies
with the file.

### 2.2 Delete

Remove `src/lib/kb-validator.ts`. Grep for stragglers:

```
rg -n "kb-validator" src
```

Expect zero hits. Note the deletion in the header comment history of
`suggestion-engine.ts` if it references the mirror.

### Verification

- `npm run build` exits 0.
- `rg -n "kb-validator" src` → no matches.
- Rust tests remain the single validator test surface: `cargo test` in
  `src-tauri/` passes (kb.rs:993–1280 suite unchanged).

---

## Phase 3 — `tokens.ts`: shared guards

Goal: one definition of "what kind of token is this".

### 3.1 New module

`src/lib/tokens.ts` exports exactly:

```ts
import type { CommandToken, VarType, VarSource } from "./tauri-api";

export function isLit(t: CommandToken): t is { lit: string; optional?: boolean }
export function isChoice(t: CommandToken): t is { choice: string[]; optional?: boolean; repeatable?: boolean }
export function isVar(t: CommandToken): t is { var: string; type?: VarType; source?: VarSource; optional?: boolean; values?: string[]; min?: number; max?: number }
export function isPipe(t: CommandToken): t is { pipe: boolean; filters?: { lit: string; var?: string; type?: VarType }[]; optional?: boolean; repeatable?: boolean }
```

Widest guard signatures win (the `isVar` with `values`/`min`/`max`) —
callers that need those fields currently re-narrow; after this they
don't.

### 3.2 Adopt

- `suggestion-engine.ts:99–123`: delete local guards, import from
  `./tokens`. Internal call sites (`isLit(...)` etc.) unchanged.
- `dropdown.ts:266–279`: delete the self-labelled duplicate block, import
  from `./tokens`. Keep local aliases if names collide with existing
  locals (`isLitTok` → `isLit` rename at call sites, or
  `import { isLit as isLitTok }`).
- `sidebar-content.ts:124–135`: same.
- `kb-validator.ts` guards die with Phase 2; if Phase 3 lands first,
  migrate it too and delete it in Phase 2 as planned.

### Verification

- `npm run build` exits 0 (tsc confirms type-narrowing still holds).
- `npm test` passes — existing suggestion-engine tests unchanged,
  matching behaviour untouched.

## Phase 4 — One `renderToken`

Goal: one function turns a token into HTML; dropdown and sidebar call it.

### 4.1 The seam

The two renderers differ deliberately:

- `dropdown.renderToken(t, isCurrent, litWordIdx)` — highlights the
  current token and the current word within a multi-word `lit`.
- `sidebar-content.renderToken(t)` — badges (`opt`/`rep`, var type and
  source badges).

Consolidate as one function with optional detail flags:

```ts
export interface RenderTokenOpts {
  current?: boolean;        // dropdown highlight
  litWordIdx?: number;     // dropdown: first word to highlight
  badges?: boolean;        // sidebar: opt/rep/type/source badges
}
export function renderToken(t: CommandToken, opts: RenderTokenOpts = {}): string
```

Output HTML for the shared cases must be byte-identical to today: same
class names (`token-lit`, `token-choice`, `token-var`, `token-pipe`,
`current`), same structure. The `escHtml` helper is imported from
`./format` (both files already use it).

### 4.2 Migrate

- `dropdown.ts:229` body deleted; `renderToken` calls route to
  `tokens.ts` with `{ current, litWordIdx }`.
- `sidebar-content.ts:97` body deleted; routes with `{ badges: true }`.
- Both files drop their `CommandToken`/`VarType`/`VarSource` type
  imports if now unused.

### 4.3 Test surface

Add a small `src/lib/tokens.test.ts` (same style as
`suggestion-engine.test.ts` — plain asserts against constructed
commands):

- each token kind renders expected class + escaped text
- `current` + `litWordIdx` highlights only the trailing words of a
  multi-word `lit`
- `badges: true` adds opt/rep/type/source badges; default omits
- choice elements are HTML-escaped

This is the first test coverage either renderer has had.

### Verification

- `npm run build` exits 0.
- `tokens.test.ts` passes.
- Manual visual check: terminal dropdown row and sidebar token
  breakdown for a `choice` + `var` + `pipe` command (e.g. any
  `show ... | include` entry) — identical to pre-refactor screenshot.

---

## Expected end state

- `kb-validator.ts` deleted (~154 lines). Rust `kb.rs` is the only
  schema validator; `validate_kb` IPC is the only seam; issues are
  cached per platform at load.
- `tokens.ts` (~80 lines) is the single module for token kind guards and
  token→HTML rendering. ~120 duplicated lines deleted across
  suggestion-engine, dropdown, sidebar-content.
- A new token kind now touches 2 files (`tokens.ts` + the engine
  matcher), not 6.
- No IPC in the keystroke path; no matching-behaviour change; rendered
  output unchanged.

## Risks

- **Issue staleness** (Phase 1): the cache can go stale between an
  out-of-band YAML edit and the next reload. Acceptable — same staleness
  the loaded commands themselves already have.
- **Type-narrowing regressions** (Phase 3): tsc strict mode is the
  guard; the build failing IS the failure signal.
- **Visual drift** (Phase 4): mitigated by byte-identical HTML
  requirement + the new `tokens.test.ts` + one manual screenshot diff.