# Custom Knowledge Base

## Goal

Users can build their own knowledge base:

* Add commands missing from the app's bundled (core) KB.
* Add KBs for software not covered by the app (new platforms).

Custom commands participate in suggestions/ghost text exactly like core commands — no new suggestion behaviour — except a **source indicator** when a custom command overrides (or duplicates) a core one.

## Core Decision: No Third Layer

The **user KB already exists** — `config.user_kb_path()` (`config.rs:362`) holds commands written by LLM import (`import.rs`) and manual edit (`save_kb_command`, `delete_kb_command`). The custom KB **is** the user KB, reframed.

Three layers (bundled / core-updates / custom) is rejected: LLM never touches core anyway (strict rule below), so there is nothing for a third layer to do.

## Strict LLM Rule

The LLM import feature writes **only** to the custom (user) KB. It is never a core-KB update or distribution channel. This is enforced in:

1. **Prompt** (`llm.rs` `build_system_prompt`): state the purpose and boundaries explicitly — "You are extracting commands for the user's personal custom knowledge base for this platform. You do not update or replace the app's built-in knowledge base. Output must conform to the command schema below; invalid commands are rejected at validation."
2. **Code**: no code change needed — `commit_import` already targets `user_kb_path` (`import.rs:246-258`). Add a comment/guard noting the invariant so future changes don't reroute it.

## Schema Changes

`Command` (`kb.rs:39`) gains two optional, serde-defaulted fields:

```yaml
source: custom        # "custom" (user layer) | absent/"bundled" (core). Not authored in YAML; set by the merge.
overrides: true       # true when a custom command replaced a core command with the same name. Merge-generated.
```

* Neither field is authored by users or the LLM; both are set during merge (`KbManager::get_or_load`, `kb.rs:544-593`).
* Frontend `Command` / `SuggestionResult` types gain the same optional fields.

## Merge Semantics Change (the one real code change)

Today `merge_from` (`kb.rs:427-444`) and `write_commands_to_yaml` (`kb.rs:752-786`) use **fill-if-empty** semantics — a user command cannot actually override a bundled one. Change to **user-wins**:

* Custom (user-layer) command with the same `name` fully replaces the bundled command; merged entry gets `source: custom`, `overrides: true`.
* Custom command with a new `name` is added as-is, `source: custom`.
* Everything else (mode filtering, version filtering, aliases, prefix matching, negation, tokens) is untouched — the engine already treats merged commands uniformly.

Consequence for existing users: commands they manually edited previously appeared "fill-if-empty"; they now fully override. This is the intended behaviour.

## Indicator

When a suggestion's command has `source: custom && overrides: true`, show a small badge/tag (e.g. `custom`, with tooltip "Overrides built-in KB entry") on:

* Dropdown row (`dropdown.ts`)
* Ghost-text acceptance moment — no inline marker; ghost text stays pure text. The badge appears in the side panel detail and dropdown only.
* Side panel command detail (`sidebar-content`)
* KB viewer/edit dialog ("Overrides built-in entry — reset by deleting the custom command")

No indicator for pure custom commands (no core counterpart) — the Browse/KB viewer already shows which files are user files. Revisit if users ask.

## LLM Import Confirmation Screen (redesign)

Current preview (`kb-import-dialog.ts:297-345`) is all-or-nothing. Required: per-command confirmation.

* Each extracted command row becomes **accept (default: checked) / reject (unchecked)**. `commit_kb_import` gains a selected-subset parameter (indices or filtered `ExtractedCommand` list).
* **Accepted rows** show: name, syntax, mode badge, category, and a one-line "why add" — derived from the command description (and "not in built-in KB" vs "overrides built-in KB entry" via a name lookup against the bundled store, which `extract_from_url` can compute at preview time).
* **Rejected (invalid) rows** show: name, the concrete validation failures verbatim from `validate_extracted_command` / `kb::validate_command` (e.g. "mode 'foo' not valid for platform, coerced to privileged-exec", "token error: unknown token kind", "name too short"), and why it matters (invalid commands would produce broken ghost text, so tokens were dropped or the command excluded).
* Rows with token errors that were salvageable (tokens dropped, command kept) default to unchecked with a warning; user can force-accept knowing tokens are gone.
* Commit writes only accepted commands; summary screen shows accepted/rejected counts.

## New Platforms (user's other software)

Import into an existing platform already works. Import into a **new platform** needs:

1. **Platform selection**: replace hardcoded `PLATFORM_OPTIONS` (`kb-import-dialog.ts:34-39`) with `list_platforms()` results **plus** a "New platform…" entry (name + id fields).
2. **index.yaml scaffold for a new platform**: today the scaffold is copied from the bundled platform (`import.rs:568-613`) — impossible for a new one. Minimal scaffold instead:
   ```yaml
   id: <user-id>
   name: <user-name>
   prompt_patterns: {}      # empty = single-mode platform
   default_mode: default
   ```
   Single-mode (like linux bash's `shell`) is the MVP: no prompt-pattern authoring UI, prompt detector falls back to default mode, suggestions unfiltered by mode. Custom `prompt_patterns` authoring is post-MVP (edit index.yaml by hand; loader already supports it).
3. Version filtering: custom commands with no `versions` field show for all host versions (already the behaviour).

## Out of Scope / Unchanged

* No LLM in the suggestion/keystroke path (existing rule).
* No core-KB shipping or update mechanism via LLM.
* No sharing/export of custom KBs beyond the existing backup/restore zip (already includes user KB dir, `paths.rs:135`).
* Suggestion engine behaviour unchanged apart from reading two new optional fields for the badge.

## Implementation Phases

1. **Merge semantics + provenance fields** — `merge_from` user-wins, `source`/`overrides` on Rust + TS `Command`, thread through `SuggestionResult`. `cargo check` + `npm run build`.
2. **Indicator UI** — dropdown badge, sidebar badge, KB viewer note.
3. **Confirmation screen** — per-command accept/reject, rejected reasons, subset commit, bundled-lookup for "overrides" vs "new" labelling.
4. **LLM prompt scope text** — capabilities/boundaries/purpose paragraph in `build_system_prompt`; invariant comment on commit path.
5. **New-platform import** — dynamic platform list, "New platform…" form, minimal index scaffold (single-mode).

Phase 1 is the only behavioural risk (existing user overrides become real); ship it behind no flag — it is the feature.

## Open Questions

* Should the KB viewer offer "restore built-in version" for an overridden command (delete custom command, since tombstone already handles re-hide)? — cheap, likely yes in phase 2.
* Badge style/placement — designer call, see docs/03.
