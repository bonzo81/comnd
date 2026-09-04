# Plan: Custom Knowledge Base (User-Owned KB + Scoped LLM Import)

Spec: docs/10-custom-knowledge-base.md. Related: docs/06-knowledge-base.md,
docs/05-suggestion-engine.md, docs/plan-kb-index-source-and-save-validation.md.

Goal: the user KB becomes the **custom KB** — a first-class layer the user owns.
Custom commands win over bundled commands with the same name (suggestions,
ghost text, viewer), with an indicator when a core alternative exists. The LLM
import feature is scoped **exclusively** to the custom KB (strict rule) and
gains a per-command confirmation screen with accept/reject reasons. Users can
add KBs for software the app doesn't cover (new platforms).

No third KB layer is introduced. No new modules. The per-keystroke suggestion
path gains only two optional field reads (badge data), no Rust round-trips.

## Background — current state (file:line)

- **Two KB paths already exist.** Bundled (read-only resources) and user
  (writable, `config.user_kb_path()` = app-data `knowledge-base/`,
  config.rs:362-367). `KbManager::with_user_path` (kb.rs:514) holds both.
- **Merge is name-keyed but fill-if-empty.** `get_or_load` (kb.rs:544-593)
  loads bundled, then `merge_from` (kb.rs:423-453) overlays user commands by
  exact `name` — but only fills **empty** fields (kb.rs:427-444). A user
  command today *cannot* override a bundled description/syntax/tokens. Same
  fill-if-empty in `write_commands_to_yaml` (kb.rs:752-786) when a user
  import collides with an existing user category file.
- **No provenance.** Rust `Command` (kb.rs:39-60) and TS `Command`
  (tauri-api.ts:66) / `SuggestionResult` (suggestion-engine.ts:33) have no
  `source` field. After merge the store is flat; the frontend cannot tell
  custom from bundled.
- **Import pipeline (two-stage, Phase 5.6).** `extract_kb_preview` →
  `extract_from_url` (import.rs:147-234) → frontend preview
  (kb-import-dialog.ts:297-345) → `commit_kb_import` → `commit_import`
  (import.rs:238-259), which writes to
  `user_kb_path/<platform>/commands/<category>.yaml` via
  `write_commands_to_yaml`. Preview is **all-or-nothing** ("Confirm all" /
  "Reject", kb-import-dialog.ts:338-341); no per-command selection.
- **Validation exists.** `validate_extracted_command` (import.rs:459-535):
  name checks, mode coerced to `default_mode` if not in platform
  `prompt_patterns` (import.rs:478-485), `kb::validate_command`; token-error
  commands keep the command but drop tokens → `status: "warn"`. Issues are
  already carried per-command in `CommandPreview.issues` (tauri-api.ts:450).
- **LLM prompts are code-built.** `build_system_prompt` (llm.rs:356-442)
  injects platform name, valid modes, negation_prefix, categories, full token
  schema + worked example + "IMPORTANT RULES" block (llm.rs:427). JSON schema
  appended (llm.rs:446-546). Nothing in the prompt today states the custom-KB
  purpose/boundary.
- **Platform list in the import dialog is hardcoded** to the four bundled
  platforms (kb-import-dialog.ts:34-39). New-platform scaffolds are copied
  from bundled index constants (`create_platform_index`, import.rs:565+;
  being replaced by bundled-index copy in
  docs/plan-kb-index-source-and-save-validation.md — this plan builds on
  that work for the truly-new-platform placeholder).
- **Suggestion flow.** One bulk load per connection: `queryKb("", platform,
  null, version)` returns the merged, version-filtered command set
  (terminal-view.ts:1432-1448); matching, ranking, ghost text and dropdown
  are frontend-only (suggestion-engine.ts:644-877). No dedup by name is
  needed today because merge collapses by name — it must keep doing so.

## Part 1 — User-wins merge + provenance fields

### 1.1 `Command` gains merge-generated fields (Rust)

kb.rs `Command` struct (kb.rs:39-60), both `#[serde(default)]`, skipped in
serialization to YAML output (`#[serde(skip_serializing_if = "Option::is_none")]`
etc.) so authored files stay clean:

- `source: Option<String>` — `Some("custom")` when the command came from the
  user layer; `None` (bundled). Never authored in YAML.
- `overrides: bool` (default false) — true when this command replaced a
  bundled command with the same name. Merge-generated.

### 1.2 Rewrite `merge_from` to user-wins (kb.rs:423-453)

Replace fill-if-empty with: user command fully replaces the bundled command
of the same name, then set `source: Some("custom")` and
`overrides = true` on the replacement. New names are pushed with
`source: Some("custom")`, `overrides: false`. Keep the alphabetical re-sort.

`get_or_load` (kb.rs:544-593) calls `merge_from(user_store)` — signature
stays; the "user" semantics live inside `merge_from`. Bundled-loaded commands
get `source: None` (serde default handles it; add an explicit
`store.commands.iter_mut().for_each(...)` only if serde default can't
distinguish "absent" — it can, so no code needed).

### 1.3 Keep YAML writes clean

`write_commands_to_yaml` (kb.rs:719+) and `save_kb_command` must strip/
ignore `source`/`overrides` on write (they are computed, not stored). Because
they're `skip_serializing`, this is free — verify in the round-trip test.

### 1.4 Thread the fields to the frontend

- TS `Command` (tauri-api.ts:66): add `source?: string; overrides?: boolean;`
- `SuggestionResult` (suggestion-engine.ts:33): carry `source`/`overrides`
  from the matched command (set wherever the result object is built in
  `matchInput`/`matchFixed`/`matchUnordered` result construction).
- Versioning: old user YAML without the fields still loads (serde defaults).

### 1.5 Tests (Rust, kb.rs `#[cfg(test)]`)

- User command with same name replaces bundled: merged store has one command
  with the user's description/tokens, `overrides == true`.
- User-only command added, `overrides == false`, both present.
- Round-trip: serialize a merged store to YAML, reload — no `source`/
  `overrides` keys in the file (skip_serializing works).
- Tombstone interplay: user `_deleted.yaml` name still hides the bundled
  command after the merge change (existing behaviour, pin it with a test).

## Part 2 — Override indicator (frontend)

Badge text: `custom` (tooltip: "Overrides built-in KB entry — your version is
shown"). Only rendered when `overrides === true`. Pure custom commands get no
badge (phase-1 scope; revisit on feedback).

- **Dropdown row** (`src/lib/dropdown.ts` row rendering): small tag after the
  command name. Reuse the existing mode-badge styling pattern; add a token +
  rule in `src/styles/components/`.
- **Side panel detail** (`src/lib/sidebar-content.ts`): same tag next to the
  command name.
- **Ghost text**: no inline marker (ghost text stays pure text per spec).
- **KB viewer dialog** (`kb-viewer-dialog.ts`): info note when viewing a
  command with `overrides: true`, plus a "Delete custom version" affordance
  already exists via `deleteKbCommand` — label it "Restore built-in version"
  when `overrides` is true. Delete is class-aware (docs/plan-kb-ignore-disable.md):
  for an override it removes the user copy and un-tombstones the name, so the
  bundled command resurfaces; a tombstone is written only when deleting a
  bundled-only command with no user copy.
- Styling: new custom property if needed in `tokens.css` (e.g.
  `--accent-custom`); dark theme first per AGENTS.md.

## Part 3 — LLM strict custom-KB rule (prompt + invariant)

### 3.1 `build_system_prompt` (llm.rs:356-442)

Prepend a purpose/boundary paragraph to the system prompt:

> You are extracting commands for the user's PERSONAL CUSTOM knowledge base.
> This is not the app's built-in knowledge base and must never be treated as
> one: output is shown to this user for review, then saved to their private
> profile. Extract only commands documented in the provided text — do not
> invent, generalize from other platforms, or fill gaps from your own
> knowledge. Every command must conform exactly to the schema below; the app
> validates your output and the user rejects invalid commands at review.

Extend the IMPORTANT RULES block (llm.rs:427) with: valid `mode` values are
only the injected ones; unknown modes are coerced to `default_mode` (matches
import.rs:478-485 behaviour — prompt and validator must agree); token syntax
rules already stated stay authoritative.

Update the two existing prompt tests (llm.rs:601-620) + add one asserting the
boundary sentence is present.

### 3.2 Invariant guard (import.rs)

`commit_import` already writes only to `user_kb_path` (import.rs:246-258).
Add a doc-comment on `commit_import` and `get_target_yaml_path` stating the
invariant: "LLM import writes ONLY to the custom (user) KB — never the
bundled KB; see docs/10-custom-knowledge-base.md". No runtime guard needed
(the bundled path is not reachable from this call chain); the comment is the
tripwire for future refactors.

## Part 4 — Per-command confirmation screen

### 4.1 Backend: subset commit

- `commit_import` / `commit_kb_import` (import.rs:238-259, lib.rs:1210-1242):
  accept the full `Vec<CommandPreview>` as today plus nothing new structurally
  — the **frontend filters** to accepted commands before calling. Simplest
  contract: frontend sends only accepted previews. Backend unchanged except a
  count check (committing zero commands → error "no commands selected").
- Preview enrichment: `extract_from_url` (import.rs:147-234) gains a
  bundled-name lookup — after validation, for each preview command compute
  `in_bundled: bool` (name exists in the **bundled-only** store; load via
  `KbStore::load(platform, bundled_path)` directly, bypassing merge) and
  return it on `CommandPreview` (tauri-api.ts:450 gains `in_bundled?: boolean`).
  This drives "New command" vs "Overrides built-in entry" labels without a
  new IPC call.

### 4.2 Frontend: accept/reject preview (kb-import-dialog.ts)

Replace the all-or-nothing preview (kb-import-dialog.ts:297-345):

- Each row gets a checkbox, **checked by default** for `status === "ok"`,
  **unchecked** for `status === "warn"` (salvageable token drops — user can
  force-accept, warned that tokens are gone and the command becomes
  legacy/`name.startsWith` matched).
- Row content per spec (docs/10):
  - Accepted-ready rows: name, mode badge, tokenized syntax, one-line "why" —
    first sentence of the command description, plus label "New command" or
    "Overrides built-in entry" from `in_bundled`.
  - Invalid rows (`issues` non-empty): issues rendered verbatim
    (validate_extracted_command / kb::validate_command messages) with the
    consequence stated (e.g. "mode not valid for this platform — coerced to
    privileged-exec", "tokens dropped — command will match by name prefix
    only"). These rows are unchecked; user opts in deliberately.
- Summary line: "N of M selected · K new · J override built-in · W with
  warnings". Buttons: "Import selected (N)" (replaces "Confirm all") /
  "Reject".
- `confirmPreview` (kb-import-dialog.ts:478-511) filters
  `this.preview.previews` to checked rows before `commitKbImport`; result
  screen reports accepted vs rejected counts (`this.preview.previews.length -
  selected.length` rejected by user, `preview.errors.length` dropped at
  extraction).
- Keep `preview-row` DOM/CSS structure; add checkbox column + status classes
  in the existing import dialog stylesheet.

## Part 5 — New platforms (user's other software)

Depends on plan-kb-index-source-and-save-validation.md Part 1
(bundled-index-copy scaffold). This part covers the truly-new-platform case.

### 5.1 Minimal new-platform index

When import targets a platform with no bundled index:

```yaml
id: <user-id>
name: <user-name>
prompt_patterns: {}
default_mode: default
```

Single-mode platform (mirrors linux-bash's single `shell` mode): prompt
detector falls back to `default_mode`, suggestions unfiltered by mode
(docs/05 § Mode Detection). `create_platform_index` placeholder arm
(import.rs) writes this shape with the user-supplied id/name instead of the
hardcoded per-platform constants. No prompt-pattern authoring UI this phase —
users who want modes edit `index.yaml` by hand (loader already supports it;
document in the KB screen help text).

### 5.2 Dynamic platform list

kb-import-dialog.ts: replace hardcoded `PLATFORM_OPTIONS` (lines 34-39) with
`listPlatforms()` (existing IPC, used by kb-screen) at mount, plus an
optgroup "Custom" entry "New platform…" that reveals two text inputs
(display name + id slug, validated: lowercase, `[a-z0-9-]`). Category select
gains one free-text option "Other…" → text input (new category file name).

### 5.3 Host plumbing (verify-only)

`Host.platform` is already a free string; connecting to a host with a custom
platform already loads its user-dir index + commands (`get_or_load` creates
the store from the user path). Add a manual test: create custom platform via
import, save a host with that platform, connect (test_server), confirm
suggestions and mode fallback work. No code expected.

## Verification

Per AGENTS.md:

- `cargo check` in `src-tauri/` after each Rust part; `cargo test` for Part 1
  and Part 3 tests.
- `npm run build` after each frontend part (Parts 2, 4, 5).
- Manual: import with two commands sharing a bundled name → dropdown shows
  custom badge; delete custom version → bundled version + suggestions return.
- Manual: new-platform import → host connect → single-mode suggestions.

## Sequencing

1. Part 1 (merge + fields) — foundational; changes existing override
   behaviour to the intended one. Ship behind no flag.
2. Part 3 (prompt + comments) — small, independent.
3. Part 4 (confirmation screen) — depends on Part 4.1's `in_bundled`, which
   is independent of Parts 1-2.
4. Part 2 (indicator) — depends on Part 1.
5. Part 5 (new platforms) — depends on the index-source plan landing first;
   otherwise last.

## Out of scope (unchanged, per docs/10)

- No LLM in the keystroke/suggestion path. No core-KB writes from LLM. No
  custom prompt-pattern UI. No custom-KB sharing beyond existing backup/zip
  (paths.rs:135 already includes the user KB dir).
