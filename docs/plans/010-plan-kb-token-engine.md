# Plan: KB Token Schema Adoption & Suggestion Engine Upgrade

Phased implementation plan for the remaining work after the token schema
foundation landed (docs/06 § Token Schema, `kb.rs` structs, `tauri-api.ts`
interfaces). The schema is in place but unused: no YAML carries `tokens`, the
engine still does flat `name.startsWith(input)`, ghost text stops at the
command name, and three platforms (NX-OS, F5, linux-bash) are empty stubs.

This plan covers everything from "first YAML entry uses tokens" through
"cross-platform consistent ghost text past the command name". Device
tab-completion of enumerable variables and the AI/LLM suggestion layer are
explicitly out of scope — they are post-MVP per docs/08.

## Scope boundaries

In scope:
- Backfill `tokens` on existing cisco-iosxe YAML; populate the three stub
  platforms.
- Upgrade `suggestion-engine.ts` to match against `tokens` positionally so
  ghost text can suggest past the command name (next literal, choice keyword,
  or variable placeholder).
- Ghost text + dropdown render the next expected token, not just the name
  remainder.
- KB viewer UI shows token-structured syntax breakdown.
- Validation (Rust + TS) that YAML `tokens` conform to the schema.
- KB import (Ollama) emits `tokens` for newly imported commands.

Out of scope (post-MVP, tracked in docs/08):
- Device tab-completion of `source: device` variables (querying the live
  device for interface/VLAN/ACL lists). MVP ghosts the placeholder only.
- Command history personalised ranking.
- AI/LLM suggestion layer.
- KB community update registry.
- Additional platforms beyond the four MVP ones (Junos, PAN-OS, Aruba, EOS).

## Phase ordering

Phases are ordered so each one ships a verifiable state on its own. Later
phases depend on earlier ones but do not require them to be feature-complete
across all platforms — a phase can land with cisco-iosxe done and the others
following incrementally.

| Phase | Ships | Depends on |
|---|---|---|
| 1 | Token validator + one backfilled cisco-iosxe file | foundation (done) |
| 2 | Suggestion engine token-aware matching | Phase 1 |
| 3 | Ghost text + dropdown render next token | Phase 2 |
| 4 | All four platforms populated with tokens | Phase 1, 2 |
| 5 | KB viewer shows structured syntax; Ollama import emits tokens | Phase 1, 4 |

---

## Phase 1 — Token validator + first backfill

Goal: prove the schema works against real commands before touching the
engine. End state: one cisco-iosxe YAML file carries `tokens` on every entry,
a validator catches malformed tokens, and `cargo check` / `npm run build`
stay green. No engine behaviour change yet — the engine still falls back to
`name.startsWith` because Phase 2 hasn't shipped.

### 1.1 Token validator (Rust)

New `src-tauri/src/kb_validator.rs` (or fold into `kb.rs` if small — see
Ponytail rule, prefer fewer files; start in `kb.rs` and split only if it
exceeds ~150 lines).

Responsibilities:
- `validate_token(cmd: &Command) -> Result<(), Vec<String>>` returns a list
  of human-readable errors.
- Checks:
  - `lit` tokens: non-empty string; whitespace-only-internal allowed
    (multi-word literals).
  - `choice` tokens: at least one element; all elements non-empty.
  - `var` tokens: `var` name non-empty; `type: numeric` may carry `min`/`max`
    (if both present, `min <= max`); `source: kb` requires `values` to be
    non-empty; `source: device` should not carry `values` (warn, not error —
    a static fallback list is harmless).
  - `pipe` tokens: `pipe: true`; each `filters` entry has non-empty `lit`;
    if `var` present, `type` may be set.
  - `order: flags-anywhere` or `free` requires at least one optional token
    (else the order rule is meaningless — warn, not error).
  - `negatable: true` is valid on any command but meaningless on `show`
    commands (warn, not error — some platforms allow `no show ...` quirks).
- Called from `KbStore::load` for every command; collect errors into a
  `Vec<String>` and log via `log::warn!`. Do NOT fail the load — a warning
  is enough for MVP; bad entries just won't match well. Failing the load
  would brick the app on a single typo in a YAML file.
- Expose a Tauri command `validate_kb(platform) -> Vec<KbValidationIssue>`
  so the KB viewer can surface issues in the UI (Phase 5).

### 1.2 Token validator (TypeScript)

Mirror in `src/lib/kb-validator.ts` — same checks, used by the KB viewer
(Phase 5) and optionally by the import dialog for pre-write validation.
Reuse the same error message strings so Rust and TS issues are comparable.

### 1.3 Backfill `cisco-iosxe/commands/networking.yaml`

Convert every entry in `networking.yaml` to carry `tokens` alongside the
existing `syntax` string. Keep `syntax` as the human display string; do not
remove it. This is the proving ground — if the schema can't express these
commands cleanly, the schema needs revision before Phase 4.

Worked examples (reference for the backfiller):

```yaml
- name: show ip interface brief
  syntax: "show ip interface [brief | <interface-name>]"
  tokens:
    - lit: show ip interface
    - choice: [brief]
      optional: true
    - var: interface-name
      type: enumerable
      source: device
      optional: true
  order: fixed
  # ...rest unchanged
```

```yaml
- name: show mac address-table
  syntax: "show mac address-table [dynamic | static] [address <mac>] [interface <name>] [vlan <id>]"
  tokens:
    - lit: show mac address-table
    - choice: [dynamic, static]
      optional: true
    - lit: address
      optional: true
    - var: mac-address
      type: free
      optional: true
    - lit: interface
      optional: true
    - var: interface-name
      type: enumerable
      source: device
      optional: true
    - lit: vlan
      optional: true
    - var: vlan-id
      type: numeric
      min: 1
      max: 4094
      optional: true
  order: free
```

```yaml
- name: show running-config
  syntax: "show running-config [interface <name> | section <regex>]"
  tokens:
    - lit: show running-config
    - pipe: true
      filters:
        - lit: section
          var: regex
          type: free
        - lit: include
          var: regex
          type: free
        - lit: begin
          var: regex
          type: free
      optional: true
      repeatable: true
  order: fixed
```

Commands that take a single fixed argument with no variables (e.g.
`show version`, `show clock`) get a one-element `tokens: [{ lit: ... }]`.

### 1.4 Clean the `(OSPF)` / `(BGP)` name hack

While backfilling `routing.yaml` (do it in this phase too — it has the
worst offenders), remove the parenthetical disambiguation from `name`:

```yaml
# before
- name: network (OSPF)
  mode: routing-config
# after
- name: network
  mode: routing-config
```

The `mode` field already disambiguates `network` (OSPF routing-config) from
any other `network` command. The `(OSPF)` suffix was breaking prefix
matching: typing `net` matched but the ghost text showed `work (OSPF)`.
After cleanup, ghost text shows `work`. Verify no two commands in the same
`mode` share a `name` after the cleanup — the validator should warn on
duplicate `(name, mode)` pairs within a platform.

### 1.5 Verification

- `cargo test` — add unit tests for the validator: one passing sample per
  token kind, one failing sample per check.
- `cargo check` exits 0.
- `npm run build` exits 0.
- Manual: load cisco-iosxe in the KB viewer; the existing UI still renders
  (it ignores `tokens`). Suggestion engine behaviour unchanged because
  Phase 2 hasn't shipped.

---

## Phase 2 — Token-aware suggestion matching

Goal: the engine matches the input buffer against `tokens` positionally, so
a command is matchable past its name. End state: typing `show ip int Gi`
matches `show ip interface brief` and the engine knows the user is inside
the `<interface-name>` variable slot. Ghost text still renders the name
remainder only — rendering the next token is Phase 3.

### 2.1 Token matcher in `suggestion-engine.ts`

New method `matchTokens(input: string, cmd: Command): TokenMatch | null`.

`TokenMatch` shape:
```ts
interface TokenMatch {
  /** index into cmd.tokens of the token the user is currently filling */
  currentTokenIndex: number;
  /** text already typed within the current token */
  currentTokenInput: string;
  /** tokens fully satisfied by the input so far */
  consumedTokens: number[];
  /** remaining tokens (for ghost text / dropdown rendering in Phase 3) */
  remainingTokens: CommandToken[];
}
```

Matching algorithm (per `order` mode):

**`fixed` (default):**
1. Split input into whitespace-separated tokens (the user's typed tokens).
   Keep track of raw input for ghost-text positioning.
2. Walk `cmd.tokens` in order. For each command token:
   - `lit`: must match the user's next token(s) by prefix. A multi-word
     `lit` (`show ip interface`) consumes multiple user tokens. Partial
     match (user typed `show ip int`) is a prefix match on the last word
     of the `lit` — ghost text can complete the word.
   - `choice`: user's next token must be a prefix of one of the `choice`
     elements. Empty input at this position (user typed a space) means
     "any of the choices" — ghost can show the first choice.
   - `var`: consumes the user's next token greedily (one whitespace-delimited
     token). `type: numeric` validates the token is numeric (else this
     command is not a match — fall through to the next candidate). Empty
     input at this position means "fill in the variable" — ghost shows the
     placeholder.
   - `pipe`: only reached if the user typed `|`. Match the filter `lit`
     and its `var` as above. If `repeatable`, loop.
3. Optional tokens: if the user's input doesn't match an optional token,
   skip it and try the next. Required tokens must match or the command is
   not a match.
4. A command matches if all required tokens are satisfied and the user's
   current token is a valid prefix of the current expected token. The
   match is ranked by how many tokens are consumed (more = better).

**`flags-anywhere`:**
- Required tokens (`lit` and required `var`) match in order as in `fixed`.
- After the last required token, optional `choice` and optional `var`
  tokens may appear in any order. Build a set of unmatched optional tokens
  and try to match each user token against any remaining optional token.
- This covers linux getopt-style flags: `ping -c 5 10.0.0.1` and
  `ping 10.0.0.1 -c 5` both match.

**`free`:**
- Required tokens match in order at the start.
- After the last required token, all remaining tokens are unordered
  key/value filters. Each user token pair (`key value`) or single keyword
  must match some optional token. Order-independent.

### 2.2 Integrate into `query()`

`query(input)` now returns matches from both paths:
- **Token path:** for commands with `tokens`, run `matchTokens`. If it
  returns a match, include the `TokenMatch` in `SuggestionResult`.
- **Legacy path:** for commands without `tokens`, keep the existing
  `name.startsWith(input)` / alias prefix matching. `SuggestionResult`
  carries `TokenMatch | null`.

Ranking: token matches rank above legacy matches (more precise). Within
token matches, rank by `consumedTokens` count descending, then by name
alphabetical. Within legacy matches, keep current ranking.

### 2.3 Aliases with tokens

Aliases today are flat strings. For token-aware commands, an alias is a
shortcut for the leading `lit` token(s). Define an alias as "an alternate
prefix for the command's first `lit` token". Concretely:

- The engine, when matching a token-aware command, treats the alias as a
  substitute for the first `lit` token during the *first* token match only.
- Example: `sh ip int br` is an alias for `show ip interface brief`. The
  first `lit` is `show ip interface`; the alias `sh ip int` matches that
  `lit` (word-by-word prefix: `sh`→`show`, `ip`→`ip`, `int`→`interface`),
  then `br` matches the `choice: [brief]` token.
- Implementation: in `matchTokens`, before matching the first `lit`, check
  if the input starts with any alias (word-prefix match). If so, consume
  the alias words as the first `lit` and continue with the rest of `tokens`.
- No schema change needed — aliases stay as strings; the matcher interprets
  them against the first `lit`.

### 2.4 Negation matching

If `cmd.negatable === true` and the platform's `negation_prefix` is set
(load it from `PlatformIndex` into the engine on `loadCommands`), the
engine strips the prefix from the input before matching `tokens`, and
records that the negated form was used in `SuggestionResult` (so ghost text
can render the prefix). MVP: just match; rendering the prefix in ghost text
is Phase 3.

### 2.5 Verification

- Unit tests in `suggestion-engine.ts` (or a co-located `*.test.ts`):
  - One test per `order` mode.
  - Alias-against-first-lit test.
  - Negation prefix strip test.
  - Legacy fallback test (command without `tokens`).
- `npm run build` exits 0.
- Manual: with the Phase 1 backfilled `networking.yaml`, typing
  `show ip int Gi` returns a match with `currentTokenIndex` pointing at the
  `interface-name` var. Ghost text still shows the name remainder only
  (Phase 3 changes rendering).

---

## Phase 3 — Ghost text + dropdown render next token

Goal: ghost text and dropdown show the *next expected token*, not just the
command name remainder. End state: typing `show ip int ` ghosts `erface
brief` (completing the literal) and then, once the literal is complete,
ghosts `<interface-name>` as a placeholder. Typing past a `choice` token
ghosts the first matching choice keyword.

### 3.1 Ghost text rendering rules

`GhostText.show()` currently takes a `remainder` string. Extend it to take
a `GhostPayload`:

```ts
type GhostPayload =
  | { kind: "text"; text: string }                              // legacy: name remainder
  | { kind: "literal"; text: string }                           // completing a lit word
  | { kind: "choice"; options: string[]; pick: string }         // choice token
  | { kind: "variable"; placeholder: string; hint?: string };   // var token
```

Rendering:
- `literal`: same as today — greyed-out text completing the current word.
- `choice`: render the `pick` (best-matching choice) as greyed text; the
  dropdown (Phase 3.2) shows all `options`.
- `variable`: render the placeholder in a distinct style (italic + dimmed
  border? — see `_ghost-text.css` update) so the user sees it's a slot to
  fill, not literal text to accept. Tab does NOT accept a variable
  placeholder — Tab only accepts `literal` and `choice` ghosts. For a
  variable, Tab passes through to the remote (per AGENTS.md rule 5: Tab
  is context-sensitive; no suggestion visible = pass through). A variable
  placeholder is not a suggestion to accept, it's a hint.

### 3.2 Dropdown rendering

`Dropdown` currently shows command names. Extend each row to show:
- The matched command name (bold).
- The remaining tokens as a tokenized suffix (literals plain, choices in
  brackets, variables in `<>`).
- The current token highlighted (the one the user is filling).

For a `choice` token, the dropdown can expand to show each choice as a
selectable sub-row (arrow keys move into the choices, Enter picks one).
MVP simplification: if the current token is a `choice`, the dropdown rows
are the choice options (not the commands) — pick one, then return to
command-level rows for the next token. This matches how VS Code handles
parameter placeholders.

### 3.3 Wire `SuggestionResult.TokenMatch` → `GhostPayload`

In `terminal-view.ts` (or wherever the onKey handler calls
`topMatch()` today), translate the `TokenMatch` into a `GhostPayload`:
- If `currentTokenIndex` points at a `lit` and `currentTokenInput` is a
  prefix of the lit → `literal` payload with the remainder.
- If at a `choice` → `choice` payload with all options + best prefix pick.
- If at a `var` → `variable` payload with the var name as placeholder.
- If at a `pipe` → `choice` payload with the filter `lit` names.

### 3.4 CSS

`src/styles/components/_ghost-text.css`:
- `.ghost-text--variable`: italic, lower opacity, dashed underline.
- `.ghost-text--choice`: same as literal but with a faint left border.
- `.dropdown-row .token-suffix`: monospace, dimmed; `.token-suffix .current`
  highlighted.

### 3.5 Tab behaviour update

Per AGENTS.md rule 5: Tab accepts ghost suggestion when one is showing;
passes through otherwise. Refine:
- Tab accepts `literal` and `choice` ghosts (completes the word/keyword).
- Tab does NOT accept `variable` ghosts (no suggestion to accept — the
  placeholder is informational). Pass Tab through to the remote.
- This preserves the rule: Tab only intercepts when there is real
  completable text. A variable placeholder is not completable text.

### 3.6 Verification

- `npm run build` exits 0.
- Manual:
  - `show ip int` → ghost `erface brief` (literal completion).
  - `show ip interface ` (trailing space) → ghost `brief` (choice, first
    option) + dropdown shows `[brief]`.
  - `show ip interface brief ` → ghost `<interface-name>` (variable
    placeholder, italic). Tab passes through.
  - `show mac address-table ` → dropdown shows `[dynamic, static]` as
    choices; pick one; next ghost is `address` literal or `interface`
    literal (order: free).
  - `show running-config | s` → ghost `ection` (pipe filter literal).

---

## Phase 4 — Populate all four platforms

Goal: every MVP platform has a populated, token-backfilled KB. End state:
cisco-iosxe (done in Phase 1), cisco-nxos, f5-tmos, linux-bash all carry
`tokens` on every command and render consistent ghost text.

This phase is mostly content authoring, not code. It can run in parallel
with Phase 2/3 once the schema is proven (Phase 1 done). Order the
platforms by effort/leverage:

### 4.1 cisco-nxos

- Write `index.yaml` prompt patterns (per docs/05 table).
- Author command files. NX-OS shares most IOS-XE syntax but differs in:
  - `show` commands often accept `|` pipe (same filters).
  - Some commands have NX-OS-specific keywords (`show running-config vdc`,
    `show vlan internal`).
  - VDC and VRF concepts add variables.
- Reuse IOS-XE tokens as a starting point; diverge where syntax differs.
  Duplication is intentional per docs/06 § Design Decision.

### 4.2 linux-bash

- Write `index.yaml`: `prompt_patterns: {}`, `default_mode: shell`,
  `negation_prefix: null` (linux uses `--no-` per-flag, not a global
  prefix — handle via `choice` tokens with `--no-x` as options, or a
  dedicated flag token kind if the schema needs it; revisit when authoring).
- Author command files grouped by category. Linux commands demonstrate
  `order: flags-anywhere` heavily:
  ```yaml
  - name: ping
    tokens:
      - lit: ping
      - choice: ["-c", "-i", "-s", "-W"]
        optional: true
        repeatable: true            # flags can repeat / appear in any order
      - var: count
        type: numeric
        optional: true
      - var: destination
        type: free
    order: flags-anywhere
  ```
  Note: `repeatable: true` on a `choice` is a new field — add it to the
  schema in Phase 1.1 validator if not already present. (Check: the
  foundation schema in docs/06 does not list `repeatable` on `choice`. Add
  it during Phase 1.1 if Phase 4.2 needs it; if added later, it's a
  backward-compatible optional field.)
- Linux `|` pipelines: model with `pipe` token, `filters` empty (post-pipe
  command is arbitrary). Engine falls back to platform-level behaviour
  (post-MVP). MVP: ghost text does not suggest past `|` on linux.

### 4.3 f5-tmos

- Write `index.yaml` with tmsh prompt patterns (per docs/05). F5 prompts
  are the most complex — the regex must capture the `(tmos.ltm)` context
  path to set mode. Validate the regex against real prompt samples.
- Author command files. tmsh commands are hierarchical
  (`tmsh list /ltm/virtual`, `tmsh create /ltm/virtual ...`). Model the
  path segments as a sequence of `lit` + `var` tokens. tmsh also has a
  `bash` mode for shell access — those commands belong in a separate
  `bash` category and reuse linux-bash tokens where identical.
- F5 has both `tmsh` and `bash` modes; `mode` field distinguishes.

### 4.4 Verification per platform

- `cargo check` + `npm run build` exit 0.
- Run the Rust validator (Phase 1.1) on each platform; fix all errors.
- Manual: connect (or use the test server) and exercise ghost text for a
  representative command from each category. Confirm mode filtering works
  (e.g. tmsh commands don't appear in bash mode).

---

## Phase 5 — Import fully understands the command model

Goal: the import pipeline produces token-backed commands that the engine
can match past the command name, with a human review step before write.
End state: imported commands carry `tokens`/`order`/`negatable`, the LLM
is given the platform's real mode vocabulary + worked token examples, the
merge logic upgrades legacy entries, serde round-trips safely, and the
user sees a preview before anything lands in YAML.

**Review-driven reordering.** The original plan put the KB viewer UI
(5.1) first and import token emission (5.3) last. The import review
showed that import is the primary growth path for the KB — if it doesn't
emit tokens, the token schema is decoration and the viewer has nothing
worth viewing. This phase now leads with the import pipeline fixes, then
adds the trust/quality guards (round-trip test, merge fix, preview), and
lands the viewer UI last, when there's token-backed content to render.

### 5.1 Ollama prompt + schema emit tokens

**Highest-leverage change in the plan.** Without this, every imported
command is a legacy entry and the token schema is unused on the growth
path.

`ollama.rs`:
- Add `tokens`, `order`, `negatable` to `ExtractedCommand` (mirror
  `CommandToken`/`CommandOrder`). Use the same serde tagging as `kb.rs`
  (`#[serde(rename_all = "lowercase")]` on the tagged union) so the LLM's
  JSON output maps directly to the KB structs.
- Update the JSON schema sent to Ollama (`extract_commands`, `ollama.rs:140`)
  to include `tokens` (oneOf per token kind), `order` (enum), `negatable`
  (boolean). Ollama's structured-output mode enforces the schema, so the
  LLM can't produce malformed tokens — but it can produce semantically
  wrong ones (e.g. `type: numeric` with no `min`/`max`), which 5.3 catches.
- Rewrite `build_system_prompt` (`ollama.rs:277`):
  - Remove the hardcoded mode cheat sheet (lines 285-289). Instead inject
    `platform_index.prompt_patterns` keys (the real valid mode vocabulary)
    and `platform_index.default_mode`. Pass `PlatformIndex` into
    `extract_commands` (signature change — thread it through from
    `import_from_url`, which already has it).
  - Inject `platform_index.negation_prefix` if set, with instruction to
    set `negatable: true` on commands that accept the prefix.
  - Inject the platform's existing category list (load from `KbStore`) so
    the LLM uses an existing category rather than inventing a new one.
  - Add the token schema description with **one worked example per token
    kind**:
    ```
    "tokens" is an ordered list. Each element is one of:
    - {"lit": "show ip interface"}                      # fixed literal
    - {"choice": ["permit","deny"], "optional": true}   # keyword choice
    - {"var": "interface-name", "type": "enumerable", "source": "device", "optional": true}
    - {"pipe": true, "filters": [{"lit":"section","var":"regex","type":"free"}], "optional": true}
    ```
    LLMs extract structured fields far more reliably from worked examples
    than from schema prose. Include a full worked command (e.g. `show ip
    interface brief`) showing `name` + `syntax` + `tokens` together, so
    the model sees how the three relate.
  - Instruct: "`syntax` is the human-readable display string derived from
    `tokens` — keep them consistent."

`import.rs`:
- `validate_extracted_command` (`import.rs:315`) maps `extracted.tokens`,
  `extracted.order`, `extracted.negatable` into the `Command` struct.
  Replace today's hardcoded `tokens: vec![]` / `negatable: false`.

### 5.2 Preserve `<pre>`/`<code>` block structure in HTML extraction

`extract_text_from_html` (`import.rs:235`) flattens everything into
space-joined prose. Cisco/F5/Juniper docs put command syntax in `<pre>`
and `<code>` blocks; flattening loses the structural cue that "this
monospace block is a command, this paragraph is description".
- Update the extractor to wrap `<pre>`/`<code>` block text in ``` fences
  before joining. The LLM then sees command syntax as distinct blocks and
  maps them to `tokens` more reliably.
- Keep the existing `main`/`article`/body fallback chain. Only change how
  text nodes inside `<pre>`/`<code>` are emitted (fenced vs inline).

### 5.3 Validate extracted tokens; drop bad tokens, keep the command

`import.rs` `validate_extracted_command`:
- After mapping to `Command`, run `kb::validate_command(&command)` (exists
  at `kb.rs:153`, tests pass).
- If there are any `severity: "error"` issues touching `tokens`:
  - Drop `command.tokens` to `vec![]` and reset `command.order` to
    `Fixed` / `command.negatable` to `false`.
  - Keep the command itself (name/description/examples are still valid).
  - Push a warning string into the import `errors` list so the result
    dialog shows "N commands imported with token issues".
- This is the "drop tokens that fail validation but keep the command"
  rule from the original plan, now concrete.

### 5.4 Fix merge logic to upgrade legacy entries with tokens

`kb.rs` `write_commands_to_yaml` (`kb.rs:726`):
- Add token-aware merge arms alongside the existing field-granular ones:
  ```rust
  if !cmd.tokens.is_empty() && existing.tokens.is_empty() {
      existing.tokens = cmd.tokens.clone();
  }
  if cmd.order != CommandOrder::Fixed && existing.order == CommandOrder::Fixed {
      existing.order = cmd.order.clone();
  }
  if cmd.negatable && !existing.negatable {
      existing.negatable = cmd.negatable;
  }
  ```
- Without this, re-importing a command that previously landed as a legacy
  entry (empty `tokens`) silently discards the new tokens. The existing
  field-granular pattern (`!cmd.X.is_empty() && existing.X.is_empty()`)
  already covers `description`/`syntax`/`aliases`/`examples`/`tags`; tokens
  were missing from the pattern.
- Note: `order` is an enum, not a Vec — the "is empty" check doesn't apply.
  Use `!= Fixed` vs `== Fixed` as the "has meaningful value" check, since
  `Fixed` is the default and a non-default value from import should win
  over a default. If both are non-default and differ, keep the existing
  (don't clobber a hand-set value with an LLM guess). Add a test for this
  edge case.

### 5.5 YAML round-trip test (ship before token-emitting import)

`kb.rs` tests:
- Hand-craft a `Command` with all four token kinds (`lit`, `choice`,
  `var` with `type: numeric` + `min`/`max`, `pipe` with two filters),
  `order: flags-anywhere`, `negatable: true`.
- Serialize via `serialize_commands`, write to a temp file, read back via
  `KbStore::load` (or direct `serde_yml::from_str`), assert field equality.
- This guards the `#[serde(rename_all = "lowercase")]` tagged union — a
  tag mismatch would silently drop tokens on read or write and corrupt
  every imported command. Ship this test in the same commit as 5.1, before
  any real import runs.

### 5.6 Import preview dialog (trust boundary)

`kb-import-dialog.ts` + `import.rs`:
- Today the pipeline goes fetch → extract → validate → write → reload,
  with the user seeing only a count after write. For an LLM writing to a
  KB that drives ghost text on a production terminal, an unreviewed dump
  is a trust risk.
- Split `import_from_url` into two stages:
  1. `extract_from_url` — fetch + extract + validate, returns
     `Vec<Command>` (or a preview struct with name/syntax/tokens/mode)
     **without writing**.
  2. `commit_import(commands, platform, category)` — writes + reloads.
- New Tauri command `extract_kb_preview(url, platform, category) ->
  Vec<CommandPreview>`; keep `import_kb_url` as the commit step (or add
  `commit_kb_import`).
- `KbImportDialog` gains a preview screen between the form and the
  result: shows a scrollable list of extracted commands with name, mode
  badge, and tokenized syntax (reuse the Phase 5.8 viewer rendering). User
  can:
  - Confirm → commits to YAML.
  - Reject → discards, returns to form.
  - (Stretch, not MVP: per-command checkboxes to select a subset.)
- This is the human review step that the original plan lacked. It does
  not block the pipeline for power users — a "Confirm all" button is the
  default action.

### 5.7 KB viewer renders token breakdown

`kb-viewer-dialog.ts`:
- When `cmd.tokens` is present, render a tokenized syntax line:
  - `lit` → plain monospace.
  - `choice` → `[opt1 | opt2]` with a chevron colour.
  - `var` → `<name>` with a type annotation badge (`enum`, `num`, `free`).
  - `pipe` → `|` separator with filter names listed below.
- Keep the flat `syntax` string as a fallback when `tokens` is absent.
- Clicking a token highlights it and shows its detail (type, source,
  optionality) in a side panel or tooltip. This is the same data the
  validator (Phase 1.2) checks — reuse the TS validator to surface issues
  inline (`⚠ type: numeric but min > max`).
- Reuse this rendering in the import preview dialog (5.6) so the user
  sees the same tokenized syntax before committing.

### 5.8 KB editor form gains token fields (minimal)

If the KB editor (the form behind `save_kb_command`) is still in use,
extend it to author `tokens`:
- A repeating token list editor: add token, pick kind (lit/choice/var/pipe),
  fill fields per kind.
- This is the human-friendly authoring path for hand-written entries.
- If the editor is not heavily used (most KB comes from import + manual YAML
  edits), keep this minimal — a token-kind dropdown + raw fields. Do not
  build a drag-and-drop token builder (YAGNI).

### 5.9 Verification

- `cargo test` — round-trip test (5.5) passes; merge-upgrade test (5.4)
  passes; validator-on-extracted test (5.3) passes.
- `cargo check` + `npm run build` exit 0.
- Manual:
  - Import a small doc page (e.g. a Cisco `show` commands reference) via
    Ollama; confirm the preview dialog shows commands with tokenized
    syntax, not just flat strings.
  - Confirm a command with a malformed token (force one via a test
    fixture) lands as a legacy entry with a warning, not dropped.
  - Confirm re-importing the same URL upgrades existing legacy entries
    with `tokens` (check the YAML file after the second import).
  - Confirm an imported command produces ghost text past its name in the
    terminal (requires Phase 2/3 landed; if not, verify via the engine
    unit test instead).
  - Confirm the KB viewer shows the tokenized syntax for an imported
    command.

---

## Cross-cutting work

These run alongside the phases, not sequenced after them:

### Test coverage

- The foundation added no engine tests. Phase 2 adds matcher unit tests.
- Phase 1 adds validator unit tests (Rust + TS).
- Phase 5 adds: YAML round-trip test (5.5), merge-upgrade test (5.4),
  validator-on-extracted test (5.3).
- No integration test framework is introduced — keep using `cargo test`
  and TS unit tests co-located with the modules. Add a test runner only if
  the TS tests need one (check `package.json` for an existing runner
  before adding one).

### Documentation

- docs/06 already has the Token Schema section (landed with the
  foundation). Update it only if Phase 4.2 surfaces the need for
  `repeatable: true` on `choice` tokens, or any other schema addition.
- docs/05 (Suggestion Engine) describes the MVP behaviour in terms of
  name prefix matching. After Phase 2/3 land, update docs/05 to describe
  token-aware matching and the ghost text rendering rules. Keep the old
  description under a "Legacy fallback" subsection for commands without
  `tokens`.
- Add a decision-log entry to docs/08 for the token schema adoption,
  citing the date and the rationale (cross-platform consistency, ghost
  text past command name, future tab-completion hook).

### Performance

- Token matching is O(tokens × input-tokens) per command, per keystroke.
  With ~100 commands per platform and ~6 tokens per command, this is
  trivially fast in JS. No caching needed for MVP.
- If Phase 4 pushes platform command counts above ~500, revisit — but
  the mode filter already cuts the candidate set dramatically.

## Out-of-scope reminders (do not build in this plan)

- Device tab-completion of `source: device` variables.
- Command history personalised ranking.
- AI/LLM suggestion layer.
- KB community update registry.
- Platforms beyond the four MVP ones.
- Drag-and-drop token editor in the KB UI.

## Phase summary table

| Phase | Est. files touched | New code | New content | Risk |
|---|---|---|---|---|
| 1 Validator + first backfill | `kb.rs`, new `kb-validator.ts`, `networking.yaml`, `routing.yaml` | ~200 lines Rust + ~150 lines TS | ~25 commands backfilled | Low — schema already landed |
| 2 Token-aware matching | `suggestion-engine.ts` + tests | ~250 lines TS | none | Medium — matching algorithm has edge cases |
| 3 Ghost text + dropdown rendering | `ghost-text.ts`, `dropdown.ts`, `terminal-view.ts`, CSS | ~200 lines TS + CSS | none | Medium — Tab behaviour refinement, CSS for variable placeholders |
| 4 Populate platforms | 3× `index.yaml`, ~9 command files | none | ~150 commands authored | Low code risk, high content effort |
| 5 Import token-aware + preview + viewer | `ollama.rs`, `import.rs`, `kb.rs`, `kb-import-dialog.ts`, `kb-viewer-dialog.ts` | ~250 lines Rust + ~350 lines TS | none | High — LLM prompt tuning, serde round-trip, trust boundary UI |