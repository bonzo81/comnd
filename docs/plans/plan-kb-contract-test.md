# Plan: KB Command Schema Contract Test (Phase 1)

Pin the Rust↔TypeScript `Command` / `CommandToken` schema with one shared
fixture, checked from both sides of the process seam. Standalone plan from
the Sep 2026 KB architecture review; phase 2 of the KB cleanup, sequenced
after `plan-kb-false-seams.md` so the IPC surface is honest and small before
a test freezes it.

Companion plans, in order: 0 `plan-kb-false-seams.md` · **1 this plan** ·
2 `plan-kb-platform-truth.md` · 3 `plan-kb-import-pipeline.md` ·
4 `plan-kb-import-progress.md` · 5 `plan-kb-version-filter.md` ·
6 `plan-kb-split-modules.md`.

## Why (problem being solved)

The Command/token schema is defined in **five places** with **zero automated
synchronization**:

1. Rust serde structs — `src-tauri/src/kb.rs` L40–346 (authoritative; drives
   both YAML parsing and IPC serialization).
2. TS interfaces — `src/lib/tauri-api.ts` L66–111 (`Command`,
   `CommandToken`, `CommandVersions`, …), hand-maintained mirror of the Rust
   structs.
3. YAML data files — `knowledge-base/<platform>/commands/*.yaml` (22 files).
4. Hand-written JSON Schema embedded in the LLM prompt —
   `src-tauri/src/llm.rs` L633–734 (`extraction_json_schema`,
   `token_json_schema`) plus a worked example at L598–608. Must track the
   serde untagged enum by hand.
5. TS type guards — `src/lib/tokens.ts` L12–37 (`isLit`, `isChoice`,
   `isVar`, `isPipe`) re-encode the union's discriminant shape a second time
   on the TS side.

Drift between (1) and (2) is the highest-consequence gap and has **no
cross-check whatsoever**: if Rust adds or renames a token kind or a field,
the TS side silently misbehaves — `renderToken` returns `""`, matchers
return false, and suggestions just stop for the affected commands. Nothing
fails; nothing logs at the point of breakage. Existing round-trip tests
(kb.rs L1661 YAML round-trip, llm.rs L940 LLM-JSON round-trip) guard the
Rust-internal and prompt edges but never the IPC payload the frontend
consumes.

The review's principle: the interface is the test surface. The IPC contract
*is* the interface between the two halves of the suggestion pipeline, so it
gets a contract test.

## Goals / non-goals

**Goals**

- One canonical fixture file containing a small set of commands exercising
  **every token kind** (`lit` single- and multi-word, `choice` incl.
  `optional`/`repeatable`/`descriptions`, `var` of each `type`
  (`enumerable`/`free`/`numeric` with `min`/`max`, `choice`) and each
  `source` (`device`/`kb` incl. `values`/`none`), `pipe` with `filters`),
  plus every optional schema field (`aliases`, `examples`, `versions`,
  `tags`, `negatable`, `order` = fixed/flags-anywhere/free, `mode`,
  `category`, `source`, `overrides`, `optional: true` on each token kind
  where allowed).
- Rust test: serialize the fixture commands to JSON (exactly the serde
  configuration used for IPC: same enum tag behavior, field casing) and
  compare against the expected JSON embedded in the fixture.
- TS test (vitest): import the same fixture, run it through the type guards
  (`tokens.ts`) and `renderToken`, and compare against the same expected
  values.
- LLM prompt edge (copy 4): a Rust test asserts the embedded
  `extraction_json_schema` accepts every fixture command (validate the
  fixture against the JSON Schema using an existing Rust JSON-Schema
  validator already in the dependency tree — check `Cargo.toml` first; if
  none is present, instead round-trip: deserialize the fixture's expected
  JSON with the same serde path the LLM import uses, which exercises the
  same shape contract).
- The fixture lives in the repo (not temp) so both test suites and future
  agents can read it: `src-tauri/tests/kb-schema.fixture.json` — one file,
  readable by both `cargo test` (relative path from the crate) and vitest
  (import via `fs` relative to repo root). Single file, deliberately not
  under `src/` or `src-tauri/src/`, to keep it out of both build pipelines.

**Non-goals**

- No code-generation of TS types from Rust (or vice versa). The fixture is a
  *detector*, not a generator; if drift becomes a recurring chore, generation
  can be a future plan.
- No change to the serde structs, YAML files, TS interfaces, or LLM prompt —
  this plan only adds tests (plus, if needed, a `#[cfg(test)]` test-only
  helper).
- Not testing the *semantic correctness* of matching (suggestion-engine has
  its own tests); only the wire shape of the schema.
- Not touching `PlatformIndex` — commands only. The index is simpler and
  already exercised by load tests; extend the fixture with an index section
  only if a review shows a concrete drift bug there.

## Detailed design

### Fixture shape

```json
{
  "description": "Canonical Command/CommandToken schema fixture. Both the Rust (src-tauri) and TS (vitest) contract tests assert against expected_ipc_json. Any schema change must update this file in the same commit.",
  "commands": [
    { "rust": { ...Command struct value... } },
    ...
  ],
  "expected_ipc_json": [
    { ...serde_json::Value the Rust side must produce... },
    ...
  ],
  "expected_renders": [
    { "tokenIndex": 0, "expected": "show ip interface" },
    ...
  ]
}
```

Design decisions:

- **Rust source of truth.** The fixture's input values are written as Rust
  struct literals in the Rust test (not as JSON that Rust parses), so the
  test exercises the actual structs and serde attributes — a renamed field
  or changed enum tag fails to compile or fails the JSON comparison. The
  expected IPC JSON is data in the fixture file.
- **TS reads only `expected_ipc_json` + `expected_renders`.** The vitest
  side parses `expected_ipc_json` as `Command[]` — via the type guards and
  renderer, not `as` casts — and asserts: (a) every command passes the
  appropriate guard checks, (b) token renders match `expected_renders`,
  (c) field presence matches the TS `Command` interface expectations. If the
  Rust side adds a field, the expected JSON grows a key the TS interface
  does not declare; the test asserts key sets explicitly so this fails
  loudly.
- **Two drift directions covered.** Rust→TS (new field/kind in expected JSON
  TS doesn't know) and TS→Rust (TS test expects a guard shape Rust stopped
  producing).
- **Every token kind mandatory.** The fixture must keep at least one example
  of each token kind and each optional modifier; the Rust test enforces this
  structurally by counting kinds present (a cheap sanity assertion) so the
  fixture cannot silently shrink.

### Rust test (src-tauri/src/kb.rs `mod tests`, or a new `#[cfg(test)] mod contract`)

- Build the fixture commands as struct literals.
- `serde_json::to_value(&cmd)` each; compare against
  `expected_ipc_json[i]` loaded from the fixture file
  (`../../tests/kb-schema.fixture.json` relative to crate root — resolve via
  `env!("CARGO_MANIFEST_DIR")`).
- Note on serde shape: IPC payloads go through Tauri's serialization, which
  uses the same serde attributes as `serde_json::to_value` (field renaming
  and untagged/adjacent enum behavior are struct-driven, not
  framework-driven). If a discrepancy between `to_value` and actual IPC wire
  format is ever suspected, the plan's follow-up is a Tauri-command-level
  test — not needed now.
- LLM prompt edge: parse `expected_ipc_json` through the same
  deserialization path the LLM import uses for extracted commands
  (`llm.rs` — the `ExtractedCommand` → `Command` conversion, if one exists,
  else `serde_json::from_value::<Command>`); asserts the prompt schema and
  the IPC schema agree on shape. If import.rs's `validate_command` accepts a
  fixture command, this test also runs it through `validate_command` and
  expects zero issues for the valid entries (and, for a small
  `"invalid"` section if added, the expected issue codes).

### TS test (src/lib/ — new `kb-schema.contract.test.ts`)

- Read the fixture with `fs.readFileSync` (path relative to repo root via
  `import.meta` / vitest config; vitest runs from repo root, so
  `src-tauri/tests/kb-schema.fixture.json` is stable).
- Assert per command: `isLit/isChoice/isVar/isPipe` classify each token
  exactly as `expected_renders`/guard expectations demand; exactly one guard
  matches per token (a token matching two guards is a discriminant bug).
- `renderToken` output for each token equals the expected render string.
- Key-set check: `Object.keys(command)` matches the TS interface's declared
  optional/required fields (allow-list comparison), so an added Rust field
  fails TS until the interface is updated — that is the point.

### Failure mode = the deliverable

When this test fails, the fix is a deliberate, reviewable diff: update the
schema on one side, the fixture expected JSON, and the mirror interface —
in the same commit. The fixture file's header comment states this contract.

## Tasks / checklist

- [ ] Create `src-tauri/tests/kb-schema.fixture.json` with all token kinds, modifiers, and optional fields represented; header comment states the same-commit rule
- [ ] Rust contract test: struct literals → `serde_json::to_value` → compare to fixture expected JSON; kind-coverage sanity assertions
- [ ] Rust LLM-shape test: `expected_ipc_json` round-trips through the LLM import deserialization path (+ `validate_command` zero-issues for valid entries)
- [ ] TS contract test (`src/lib/kb-schema.contract.test.ts`): guards + renderer + key-set assertions against the same fixture
- [ ] `cargo test` exits 0 (new tests included)
- [ ] `npm run test` exits 0 (new test included)
- [ ] `npm run build` exits 0
- [ ] `cargo check` exits 0

## Verification

- All four commands green (`cargo check`, `cargo test`, `npm run build`,
  `npm run test`).
- Mutation check (do once, then revert): rename a field in the Rust
  `Command` struct (e.g. `description` → `desc`); `cargo test` must fail on
  the contract test. Restore a TS guard to accept a stale shape;
  `npm run test` must fail on the contract test. This proves the fixture
  actually bites in both directions.
- AI-navigability: an agent landing on a schema change now gets a failing
  test naming the exact contract, instead of silently degraded suggestions.

## Risks / open questions

- **Fixture location read by two toolchains**: `src-tauri/tests/` is outside
  the vitest root but inside the repo; `fs` import from vitest is fine, and
  cargo finds it via `CARGO_MANIFEST_DIR`. If the CI gate copies only
  package sources, add the fixture path to the test-gate workflow's
  checkout/paths (verify against `.github/workflows` when implementing).
- **Untagged enum JSON shape**: `CommandToken` is an untagged enum, so its
  JSON has no explicit tag; the guards' job of distinguishing by key
  presence is exactly what the TS test exercises — which is good, but means
  the expected JSON must be written carefully (e.g. `pipe` vs `lit` both
  keyed distinctly). Implementation should derive the expected JSON by
  running `serde_json::to_value` once and pasting the result, not by hand.
- Open question: add an `"invalid"` section to the fixture for negative
  cases (duplicate names, unknown token key)? Defer — validators have
  existing tests; add when a validator/IPC drift bug class appears.