# Plan: Move the Version Filter into the Suggestion Engine (Phase 5)

Move the last per-query KB logic out of Rust into the frontend module that
already owns all the other matching. Standalone plan from the Sep 2026 KB
architecture review; phase 6 of the KB cleanup — sequenced late because it
changes live behavior at the process seam (unlike phases 0–4, which are
deletions/consolidations).

Companion plans, in order: 0 `plan-kb-false-seams.md` ·
1 `plan-kb-contract-test.md` · 2 `plan-kb-platform-truth.md` ·
3 `plan-kb-import-pipeline.md` · 4 `plan-kb-import-progress.md` ·
**5 this plan** · 6 `plan-kb-split-modules.md`.

## Why (problem being solved)

`query_kb` (src-tauri/src/kb.rs L1106–1116) is the per-connect IPC command
that hands the suggestion pipeline its command set. After phase 0 removed
the dead `_prefix`/`_mode` params, one piece of real per-query logic remains
in Rust: the **major-version filter** — `KbStore::query` (kb.rs L455–495)
plus `parse_major_version` (kb.rs L484–501) — which filters commands by the
host's OS version (`introduced <= host_major`, `deprecated > host_major`,
docs/specs/06 "Version Filtering Logic").

Problems:

1. **Split matching across the process seam.** Mode filtering, prefix
   matching, alias matching, and token matching all live in
   `SuggestionEngine` (src/lib/suggestion-engine.ts L724+). The version
   filter alone lives in Rust, so understanding "which commands are
   eligible" requires reading both sides of the IPC seam. No locality.
2. **Forced full clone per connect.** Because the filter runs in Rust,
   `KbManager::get_commands_for` (kb.rs ~L615–625) clones the merged
   `Vec<Command>` — every command, every field — across IPC on every
   connect. The frontend can't re-run the filter itself because the
   filtered-out commands never reach it.
3. **AGENTS.md rule**: "No heavy logic in Rust that could run in the
   frontend. IPC latency harms the terminal." The version filter is a
   pure predicate over data the frontend already receives (the `versions`
   field ships on every command).

The deletion test: deleting `KbStore::query`'s filter logic and moving the
predicate next to the engine's mode filter concentrates *all* eligibility
matching in one module. Rust's interface shrinks to "give me the commands
for this platform".

Trade-off made explicit: unfiltered payloads are larger across IPC (all
commands, including version-excluded ones, ship once per connect). This is
accepted: it is a one-time cost per connection, not per keystroke, and it
is what makes frontend filtering possible at all. For the bundled KBs
(tens of commands per platform) the growth is negligible.

## Goals / non-goals

**Goals**

- `query_kb` loses its `version` parameter; it returns the full merged
  command set for a platform. Its Tauri-command interface becomes
  `(platform) -> Vec<Command>`.
- `SuggestionEngine` gains a version predicate, applied where the mode
  filter is applied, using the same major-version comparison rules
  (first numeric segment; missing `introduced` = always eligible;
  missing `deprecated` = never deprecated).
- The TS wrapper `queryKb` loses the `version` param;
  `terminal-view.ts` passes the host version to the engine instead of the
  IPC call.
- Rust tests for `KbStore::query`'s filtering and `parse_major_version`
  move to the frontend as engine tests (the Rust versions are deleted with
  the logic).
- The phase-1 contract fixture needs no change (`versions` fields are
  already represented); confirm its `Command` examples still pass.

**Non-goals**

- Not changing version semantics (still major-version matching per
  docs/specs/06; sub-version filtering remains post-MVP).
- Not changing when the command set is fetched (once per connect, cached
  in the engine — current behavior, just unfiltered now).
- Not touching mode detection, prompt patterns, or any keystroke-path
  logic (the filter runs at set-load time in the engine, not per
  keystroke).
- Not removing `KbStore`/`KbManager` caching in Rust — the store cache and
  merge stay; only the per-query filtering goes.

## Detailed design

### 1. Rust side: shrink the interface

- `query_kb` (kb.rs L1106): drop `version` param; return
  `kb.get_all_commands(platform)`-equivalent (the existing
  `get_all_kb_commands` path, kb.rs L1131, already does this — unify on
  it: `query_kb` may simply delegate to the same manager method, or the
  two commands merge; prefer **merging** if the wire contracts can align,
  but if `get_all_kb_commands` has other consumers with different needs
  (e.g. the KB viewer, which wants disabled/tombstoned visibility —
  check), keep both commands and just have `query_kb` stop filtering).
- `KbStore::query` (kb.rs L455–495): delete the filter; the method either
  goes away entirely or becomes a plain `commands()` accessor. Follow what
  callers need — expect deletion.
- `parse_major_version` (kb.rs L484–501): delete with its tests
  (kb.rs L1297+); logic is reimplemented in TS (step 3).
- Keep the log line that reports result counts if useful (it moves to the
  manager method or goes; logging lives where the data flows).

### 2. TS wrapper + call site

- `queryKb` (tauri-api.ts L115): signature becomes `queryKb(platform)`.
- `terminal-view.ts` L1203: `queryKb(platform)`; the host version already
  available at this call site (it was passed as the `version` argument)
  now goes to the engine.

### 3. Engine-side version predicate

- `SuggestionEngine` (suggestion-engine.ts L724+): add an optional
  `hostVersion` to its set-load/configuration (where the command set and
  platform index are installed — find the existing load point, do not add
  a second one).
- Predicate rules (mirror kb.rs L455–495 exactly):
  - no host version set → all commands eligible (current Rust behavior
    when `version` is `None`);
  - `introduced` present and its major > host major → excluded;
  - `deprecated` present and its major <= host major → excluded;
  - major = first numeric segment of the trimmed string (`"16.12.4a"` →
    `16`); non-numeric leading segment → command stays eligible (Rust
    returns `None` from `parse_major_version` and the filter skipped —
    verify against kb.rs L455–495 and copy the skip behavior, including
    the `introduced`-unparseable and `deprecated`-unparseable cases).
- Apply the predicate where the mode filter is applied in the load/query
  path — once per `query(input)` set reduction, not per keystroke
  (check the engine's hot loop; the mode filter's placement is the
  template).
- Implementation shape: one small pure function
  (`versionEligible(cmd, hostMajor)`) next to the engine, exported for
  tests, mirroring how `ghostPayloadFor` and `matchTokens` are exported
  today. No new module file — keep it in suggestion-engine.ts beside its
  sibling filters.

### 4. Tests

- Port kb.rs's version tests to `suggestion-engine.test.ts`:
  `test_parse_major_version` (kb.rs L1297) and `test_version_filter`
  (kb.rs L1305) cases — no-version-set, introduced-below/equal/above,
  deprecated-below/equal/above, non-numeric strings, both-fields-missing.
- Add one integration-ish case: engine loaded with a mixed fixture +
  hostVersion set → excluded commands never appear in suggestions and
  never trigger ghost text.
- The frontend had no version tests (the logic was in Rust), so these are
  new coverage, not moved coverage — same cases, new home.

## Tasks / checklist

- [ ] `query_kb` drops `version`; delegates to the unfiltered commands path (or merges with `get_all_kb_commands` if contracts align)
- [ ] Delete `KbStore::query` filtering + `parse_major_version` + their Rust tests
- [ ] `queryKb(platform)` wrapper; terminal-view passes host version to the engine instead
- [ ] `versionEligible` predicate in suggestion-engine.ts, applied alongside the mode filter
- [ ] Ported + new version tests in suggestion-engine.test.ts (all cases from kb.rs L1297/L1305 enumerated)
- [ ] Phase-1 contract fixture still green (no fixture change expected)
- [ ] `cargo check` + `cargo test` exit 0
- [ ] `npm run build` exits 0
- [ ] `npm run test` exits 0

## Verification

- All four commands green.
- Behavior parity probe: with a host whose saved OS version is e.g.
  `"16.4"` and the cisco-iosxe KB (which carries `introduced` values),
  confirm before/after that the same command list reaches the engine —
  easiest is a temporary log of command names at the engine load point,
  compared between a pre-change and post-change run.
- Manual smoke: connect with no OS version set → all commands suggest;
  connect with OS version set → commands with newer `introduced` do not
  suggest; commands with `deprecated` at/below the host version do not
  suggest.
- `rg parse_major_version src-tauri/` returns nothing.

## Risks / open questions

- **Behavior parity is the whole risk.** The Rust filter's edge-case skips
  (unparseable `introduced`/`deprecated`, missing fields) must be copied
  exactly, not "improved" — any tightening/loosening is a behavior change
  this plan does not authorize. The ported tests are the guard.
- **Payload growth**: all commands now ship per connect. If a future KB
  grows into thousands of entries, revisit (e.g. frontend passes the
  version set once at connect and Rust filters — the seam stays honest
  either way). Note as a `ponytail:` comment at the predicate.
- Open question: the KB *viewer* uses `get_all_kb_commands` (unfiltered —
  the viewer shows everything including version-excluded commands by
  design). After this change the two consumers' needs are identical for
  the terminal path; if merging the two IPC commands turns out messy,
  keeping both is fine — they are now both thin, and phase 7
  (`plan-kb-split-modules.md`) will place them adjacently anyway.