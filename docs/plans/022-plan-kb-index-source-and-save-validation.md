# Plan: KB Index Single Source + Honest Save Validation

The knowledge base is the core differentiator of comnd: it is both the
reference for commands and the live guide during a session (see
docs/specs/06-knowledge-base.md and docs/specs/05-suggestion-engine.md). This plan fixes
two correctness problems in the KB domain, found in an architecture review of
the KB feature (Sep 2026):

1. **The platform index exists in three copies that have drifted.** A user-KB
   import can write a stale copy over behavior-critical data
   (`negation_prefix`, `prompt_patterns`), silently breaking negation
   matching and mode detection for bundled platforms.
2. **`save_kb_command` silently discards invalid token data.** A KB author
   who saves a command with malformed token JSON gets a success message but
   a legacy entry with no tokens — the command stops matching positionally
   and no error is surfaced anywhere in the UI.

Both changes are deletion-first and deepen existing modules; no new modules
are introduced, and nothing on the per-keystroke suggestion path (which must
stay free of Rust round-trips per AGENTS.md) is touched.

## Background

Current state, for readers without session context:

- **Platform index.** Each platform (e.g. `cisco-iosxe`) has an
  `index.yaml` defining `prompt_patterns`, `default_mode`, `versions`, and
  optionally `negation_prefix`. Prompt patterns power mode detection
  (docs/02 § prompt detection); `negation_prefix` enables `no `-prefixed
  matching of `negatable: true` commands (docs/06 § Negation).
- **The three copies.**
  1. Bundled: `knowledge-base/<platform>/index.yaml` — the copy
     `KbStore::load` reads at runtime.
  2. Hardcoded string constants in `src-tauri/src/import.rs` (L593–652):
     `CISCO_IOSXE_INDEX`, `CISCO_NXOS_INDEX`, `F5_TMOS_INDEX`,
     `LINUX_BASH_INDEX`, written by `create_platform_index` (L565) when the
     import pipeline creates a new user-KB platform directory
     (`ensure_kb_structure`, L548).
  3. `src-tauri/kb-templates/*.yaml` — dead files, referenced by no Rust
     code and no config; a third drifting copy.
- **The drift is already a behavior bug.** The bundled
  `knowledge-base/cisco-iosxe/index.yaml` has no `negation_prefix` (so
  `no shutdown` etc. never match negatable commands for bundled IOS-XE),
  while `knowledge-base/cisco-nxos/index.yaml` does set
  `negation_prefix: "no "`. The import.rs constants omit it for **all**
  platforms. Because `KbManager::get_or_load` (kb.rs L545) replaces the
  bundled index **wholesale** with the user index
  (`store.platform = user_store.platform.clone()`), the first import into a
  user KB locks the user's platform to the stale template forever —
  adding `negation_prefix` to the bundled file later has no effect for
  any user who already imported.
- **The wholesale replacement is intentional but fragile.** The comment at
  kb.rs L543–544 says "bundled scaffolds ship with empty prompt_patterns" —
  i.e. the override exists so a user index wins over a *scaffold* index.
  The fix is to make the scaffold a copy of the bundled index, not a stale
  reimplementation. The wholesale-replace merge rule itself stays.
- **Save flow.** `src/components/kb-viewer-dialog.ts` (`saveEdit`, ~L520)
  sends token JSON to the `save_kb_command` Tauri command
  (src-tauri/src/lib.rs L1234). The frontend's only check is a cheap
  `JSON.parse`. The Rust side (L1258–1266) parses the JSON with
  `serde_json::from_str` and on failure logs a warning and saves a command
  with `tokens: vec![]` — a legacy entry. `Result<(), String>` gives the
  frontend no way to learn tokens were dropped.
- **The validator already exists.** `kb.rs::validate_command` (L161)
  returns `Vec<KbValidationIssue>` (`{command, severity, message}`);
  the frontend already renders these issues inline via `validate_kb` →
  `src/lib/validation-cache.ts` → `kb-viewer-dialog`/`sidebar-content`.
  So surfacing save-time issues needs no new validator — only a wider
  return type on the save seam.

## Part 1 — One source of truth for the platform index

Goal: the bundled `knowledge-base/<platform>/index.yaml` files are the only
copies. `create_platform_index` derives new user-KB indexes from them; the
dead template files are deleted; the missing `negation_prefix` is fixed.

### 1.1 Delete `src-tauri/kb-templates/`

Four YAML files, referenced by nothing. Remove the directory and the
`kb-templates` mention in `AGENTS.md` file-locations section.

### 1.2 Fix bundled indexes: add `negation_prefix` where missing

- `knowledge-base/cisco-iosxe/index.yaml`: add `negation_prefix: "no "`
  (docs/06 § Negation documents this as the expected value).
- `knowledge-base/f5-tmos/index.yaml`: `negation_prefix: null` — tmsh uses
  `create`/`delete`, not a global negation prefix. Confirm null is right;
  leave as-is unless research says otherwise.
- `linux-bash` (`null`) and `cisco-nxos` (`"no "`) are already correct.

### 1.3 `create_platform_index` reads the bundled index

Replace the four `const *_INDEX` strings and the generic fallback in
`import.rs` with:

1. If a bundled index exists at `<bundled_kb_path>/<platform>/index.yaml`,
   copy it verbatim to the user path. This keeps every behavior field
   (`prompt_patterns`, `negation_prefix`, `versions`, …) in sync with the
   runtime copy by construction.
2. Only if no bundled index exists (truly custom platform), write the
   generic placeholder (keep the existing `_ =>` fallback arm's content,
   with `default_mode` left as-is; unknown platforms have no mode
   vocabulary to default into).

`create_platform_index` needs the bundled KB path — thread it through
`ensure_kb_structure` from `commit_import`'s caller (the Tauri command in
lib.rs already holds it via `AppState.kb`; expose a getter on `KbManager`,
e.g. `bundled_path()`, or pass the path alongside `user_kb_path`).

### 1.4 Test round-trip: user index ≡ bundled index

Add a test (in `import.rs` `#[cfg(test)]` or a new integration test) that,
for each bundled platform, `create_platform_index` produces a byte-identical
copy of the bundled `knowledge-base/<platform>/index.yaml`. This pins the
single-source property: if someone adds a field to the bundled index, the
scaffold copy inherits it automatically; if someone reintroduces a
hand-written template, the test fails on the next bundled-index edit.

Note: existing tests at import.rs L718–747 (`iosxe_index`/`linux_index`
helpers) build `PlatformIndex` values directly and are unaffected.

### 1.5 Doc cleanup

- docs/specs/06-knowledge-base.md: verify § Negation and the index example match
  the now-shipped `negation_prefix` values.
- `docs/user-guide/` files that instruct users to maintain `command_files:`
  in index.yaml: `KbStore::load` globs `commands/*.yaml` and never reads the
  list (kb.rs L356–371) — remove those instructions (optional, low
  priority; do not change loader behavior in this plan).

### Verification (Part 1)

- `cargo check` / `cargo test` in `src-tauri/` — exit 0.
- New test from 1.4 passes.
- `rg "kb-templates"` returns no hits outside git history.

## Part 2 — `save_kb_command` returns a verdict, not a silent downgrade

Goal: invalid token data cannot enter the KB silently. The Rust validator is
the single source of truth; the save seam returns its issues.

### 2.1 Rust: parse errors become `Err`, not a downgrade

In `lib.rs::save_kb_command` (L1258–1266):

- `serde_json::from_str` failure → return `Err` immediately with a message
  the dialog can show verbatim, e.g.
  `format!("Invalid tokens JSON: {}", e)`. Delete the
  `unwrap_or_else(log::warn → vec![])` downgrade and its comment.

### 2.2 Rust: run the validator before writing

After building the `Command` (L1274–1291), run `kb::validate_command(&command)`:

- If any issue has `severity == "error"` → do not save; return the issues.
- Warnings → save (current behavior for load-time warnings is log-and-
  continue; keep save permissive for warnings).

Return type: change `Result<(), String>` to
`Result<Result<(), Vec<KbValidationIssue>>, String>`, or flatten to
`Result<(), SaveKbError>` where

```rust
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SaveKbError {
    Validation { issues: Vec<KbValidationIssue> },
    Message { text: String },
}
```

The nested-`Result` form is the smaller diff (Tauri commands already
return `Result<T, String>`; the outer `String` covers lock/IO errors).
Pick whichever the implementer finds cleaner — the interface contract is
what matters:

- Save succeeds → `Ok(Ok(()))`.
- Token JSON invalid or validator errors → `Ok(Err(issues))` — the command
  was NOT saved.
- IO/lock failure → `Err(String)` as today.

### 2.3 Frontend: render the verdict

- `src/lib/tauri-api.ts` `saveKbCommand` (L465): update the return type to
  match 2.2. `KbValidationIssue` is already defined here (L117).
- `kb-viewer-dialog.ts` `saveEdit` (~L546–566):
  - Keep the cheap `JSON.parse` pre-check (fast feedback, no round-trip).
  - On `Err(issues)`: render the issue messages in the existing
    `#kb-edit-errors` element (same element the JSON.parse failure and
    name-required check already use — no new UI). One line per issue:
    `tokens[2]: choice list is empty` etc.
  - On success: unchanged (`this.editing = false; await this.loadPlatform()`).
  - Do NOT silently save a downgraded legacy entry in any branch.
- After a successful save, the dialog's existing `loadPlatform()` →
  `refreshValidation` flow re-fetches load-time issues, so the inline
  warning badges (warnings that were saved) appear without extra wiring.

### 2.4 Tests

- Rust: add a `#[cfg(test)]` case for the save path (the validator itself is
  already well-tested in kb.rs — ~17 cases): a command with valid tokens
  passes; a command with an empty `choice` list is rejected with a
  validation error; malformed `tokens_json` yields the parse error. The
  save path lives in lib.rs behind `tauri::State`, so the leanest test is
  to extract the parse+validate step into a small helper fn in lib.rs (or
  kb.rs, e.g. `parse_tokens_and_validate(tokens_json, &command) ->
  Result<Vec<CommandToken>, ...>`) and test the helper directly. Do not
  add a tauri test harness for this.
- Frontend: `npm run build` (runs `tsc`) — exit 0. No new frontend validator
  is created; nothing to mirror.

### Verification (Part 2)

- `cargo check` / `cargo test` — exit 0.
- `npm run build` — exit 0.
- Manual check: open KB viewer, edit a command, paste `[{ "type": "lit",
  "lit": "" }]` into tokens, save → inline error "tokens[0]: lit is empty",
  command not persisted.

## Out of scope (recorded, not done here)

- `query_kb`'s ignored `_prefix`/`_mode` params and the stale doc-02
  description of per-keystroke IPC queries (separate cleanup).
- The `existing_categories_for` stub and the near-dead one-shot
  `import_from_url` path (separate cleanup).
- The KB import dialog's hardcoded `PLATFORM_OPTIONS` list.
- Frontend tests for prompt-detector/shadow-buffer state machines.