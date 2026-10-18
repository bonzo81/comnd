# Plan: Fix config keychain test flake (parallel `cargo test`)

## Symptom

`cargo test --lib` intermittently fails one of two tests, and *which* one fails
varies run to run:

- `config::tests::test_save_and_get_llm_api_key` (config.rs:644)
- `config::tests::test_save_and_get_provider_secret` (config.rs:745)

Both pass in isolation and the full suite passes with `-- --test-threads=1`.
The failure is a flake, not a regression. Observed assertion failures land at
the keychain read-back / `NoEntry` checks.

## Root cause

Both tests drive the **OS keyring** (Windows Credential Manager on this box).
The two use different targets:

| Test | Keyring target | Unique? |
|---|---|---|
| `test_save_and_get_provider_secret` | `"comnd_provider_<uuid>"` (config.rs:750) | yes — per-run UUID |
| `test_save_and_get_llm_api_key` | `LLM_KEY_ENTRY = "comnd_ollama_api_key"` (config.rs:655, const at :129) | **no — fixed** |

`LLM_KEY_ENTRY` is the *production* target — `save_llm_api_key` /
`get_llm_api_key` (config.rs:132–149) use it. The test writes a throwaway value
to that fixed entry, asserts the read-back, then deletes it and asserts
`NoEntry`.

Two problems, one line apart:

1. **Cross-test interference.** Under default parallel `cargo test`, tests run
   on separate threads in one process. The provider test's keychain calls race
   with the llm-key test's set/get/delete against Credential Manager. Windows
   Credential Manager has a documented session-scoping quirk (already noted in
   the test comments, config.rs:651–654) where an entry written by one `Entry`
   instance may not be visible to another in the same process; concurrent
   set/delete/get across threads amplifies it. Whichever test loses the race
   fails its read-back or `NoEntry` assertion — hence the *rotating* failure.
2. **Clobbers real user data.** Because the target is fixed, running the suite
   locally overwrites then deletes whatever live LLM API key the developer had
   stored under `comnd/comnd_ollama_api_key`. Silent data loss on a plain
   `cargo test`.

The provider test does not exhibit (2) because its target is already unique; it
only suffers (1) as a bystander in the same process.

## Fix

Give `test_save_and_get_llm_api_key` a **unique per-run keyring target**,
matching the pattern the provider test already uses. The test's purpose is to
exercise the keychain set → get → delete → `NoEntry` roundtrip; it does not
need the production target name for that, and using the fixed name is what
causes both problems.

Change (config.rs:655–661): construct the entry from a fresh UUID instead of
`LLM_KEY_ENTRY`, e.g.

```rust
let id = format!("comnd_test_llm_{}", uuid::Uuid::new_v4());
let entry = keyring::Entry::new("comnd", &id).unwrap();
entry.set_password(test_key).unwrap();
assert_eq!(entry.get_password().unwrap(), test_key);
entry.delete_credential().unwrap();
let e2 = keyring::Entry::new("comnd", &id).unwrap();
assert!(matches!(e2.get_password(), Err(keyring::Error::NoEntry)));
```

Leave `LLM_KEY_ENTRY` and the production `save_llm_api_key` /
`get_llm_api_key` untouched — they are correct. Only the test's target changes.

Scope note: this is a one-test, ~4-line change in `config.rs`. No production
code, no API, no frontend. If the flake persists after this (i.e. the provider
test still flakes on its own under parallel runs), the remaining cause is
Credential Manager's same-process multi-thread limit — then the follow-up is to
gate *both* keychain tests behind a single shared `std::sync::Mutex` so they
serialize, or mark them `#[ignore]` and run via a dedicated integration test.
Do not add that until the unique-target fix alone is measured insufficient.

## Verification

1. `cargo check --lib` exits 0.
2. Run the full suite under **default parallelism** (no `--test-threads`) at
   least 5× to confirm no flake:
   `cargo test --lib` (repeat). The prior failure mode was non-deterministic,
   so a single green run is not sufficient evidence.
3. Confirm the two keychain tests still pass in isolation.
4. **No data loss:** after a local `cargo test`, the developer's real LLM API
   key under `comnd/comnd_ollama_api_key` must be unchanged (the test no
   longer touches that target).

## Non-goals

- Not restructuring the whole config test module or adding temp-dir isolation
  for keychain tests — the keyring has no path override, so per-test dirs do
  not apply; unique *targets* are the isolation unit.
- Not changing production keyring behavior.
- Not adding a shared lock across all keychain tests up front (see scope note).
