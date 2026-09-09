# Plan: Decouple the KB-Import Pipeline from tauri::AppHandle

Candidate 4 from the architecture review. The import pipeline — the
chunked-extraction hot spot from the last three KB commits — cannot run in a
test: every stage reports progress through `tauri::AppHandle`
(import.rs:785–793), `fetch_url` builds its own `reqwest::Client` inline
(465–469), and `LlmClient` owns a private http client with no injection seam
(llm.rs:106–111). Three hidden adapters block all end-to-end tests of the
most recently-churned code in the backend.

While reading, the plan picked up two adjacent fixables in the same function:
`existing_categories_for` (import.rs:420–426) always returns an empty vec, so
the prompt's claim that "existing categories guide the LLM toward reuse"
(import.rs:237) is dead input the LLM never sees; and `emit_progress`'
AppHandle type leaks into three function signatures for no reason but
progress reporting.

---

## 1. The change

### 1.1 Progress: `&tauri::AppHandle` → `&dyn Fn(ImportProgress)`

One seam replaces all twelve `emit_progress(app_handle, ...)` call sites
(import.rs:214, 219, 227, 243, 261, 271, 301, 315, 321, 397, 407, 410):

```rust
// import.rs
pub type ProgressFn<'a> = dyn Fn(&ImportProgress) + Send + Sync + 'a;
```

lib.rs side: one adapter, written once. **Note:** `emit_progress`
(import.rs:785–793) does two jobs — emits the event *and* writes the
persistent log line ("the persistent record of import flows", :788). Both
jobs move into the adapter so logging coverage survives:

```rust
fn tauri_progress(handle: &tauri::AppHandle) -> Box<ProgressFn<'_>> {
    let h = handle.clone();
    Box::new(move |p| {
        log::info!("Import progress: {:?}", p);   // was emit_progress's log line
        let _ = h.emit("import-progress", p);
    })
}
```

Test doubles record progress into a `RefCell<Vec<ImportProgress>>` instead —
no logging there, assertions go through the recorded list.

`extract_from_url`, `import_from_url`, and `commit_import` take
`progress: &ProgressFn` instead of `app_handle: &tauri::AppHandle`. The
`on_output` closure (241–244) captures `&ProgressFn` instead of a cloned
handle. `emit_progress` is deleted. `ImportProgress` stays `Serialize` for
the Tauri event. kb-import-dialog.ts / import-status.ts listeners unchanged
— same event name, same payload.

### 1.2 Fetch: inject the fetch operation

`fetch_url` (457–507) already has the right shape — validate, then get. Make
the operation injectable, not the client (a `reqwest::Client` handle is a
weaker seam than the function: tests want "returns this HTML", not "spins a
local TCP server"):

```rust
// No new dependency: spell the boxed future without futures::future::BoxFuture
// (futures is only a transitive dep here — not nameable).
pub type FetchFn<'a> = dyn Fn(&str) -> Pin<Box<dyn Future<Output = Result<String, String>> + Send + 'a>>
    + Send + Sync + 'a;

pub async fn extract_from_url(
    request: ImportRequest,
    config: &AppConfig,
    progress: &ProgressFn<'_>,
    fetch: &FetchFn<'_>,          // lib.rs passes real_http_fetch; tests pass a closure
    platform_index: &PlatformIndex,
) -> Result<ExtractPreview, String>
```

`real_http_fetch` keeps `validate_fetch_url` (SSRF guard) inside it — the
guard protects real fetches, and tests that inject closures skip it
deliberately (they fetch fake:// URLs). `validate_fetch_url` itself gains
unit tests: pure, security-adjacent, currently untested (zero existing test
references).

### 1.3 LLM: reuse what exists

`LlmClient::extract_commands` already takes `on_output: impl Fn(usize, &str)`
(llm.rs:140) — the streaming-progress seam exists. The missing piece is only
constructor injection of the http client for tests. Smallest change that
unblocks it:

```rust
#[cfg(test)]
pub fn with_http_client(mut self, c: reqwest::Client) -> Self { self.http_client = c; self }
```

Test-side, avoid new dependencies: `hyper` is in Cargo.lock only
transitively (via reqwest) and cannot be named in code without adding it as
a `[dev-dependencies]` entry. Use a stdlib `std::net::TcpListener` mock
instead — spawn a thread, accept one connection, write a minimal HTTP/1.1
chunked SSE response, drop. Same pattern as `test_server.rs`'s hand-rolled
SSH mock (~30 lines of HTTP on top). No Cargo.toml change anywhere in this
plan.

### 1.4 Fix the dead input: real `existing_categories_for`

With the manager accessible at the call site (lib.rs:1155 already has
`state.kb` locked and calls `get_platform_index`), thread the store's
category list through: add
`pub fn categories_for_platform(&mut self, platform: &str) -> Vec<String>`
to KbManager (one line over `get_or_load` + group by `cmd.category`),
pass `Vec<String>` into `extract_from_url`, delete the stub. The LLM prompt
finally gets the input its system prompt advertises. (Small behavior change:
prompt content — desirable, and it's what the comment always claimed.)

## 2. What this buys

- **The chunking hot spot becomes testable end-to-end**: fake fetch + fake
  LLM + progress recorder → assert chunk count, dedup, partial-failure
  tolerance (the "one failing chunk doesn't kill the import" logic at
  264–313 — subtle, untested, recently written).
- **Interface shrinks honestly**: functions stop pretending to be Tauri
  functions; `AppHandle` appears only in lib.rs.
- **Two shallow things die**: the `existing_categories_for` stub and the
  misleading prompt claim.
- **SSRF guard gets tests** — security-adjacent, pure, cheap.

## 3. What this does NOT touch

- Event name/payload (`import-progress`) and both frontend listeners —
  unchanged.
- `split_text_chunks`, `extract_text_from_html`, `validate_extracted_command`
  — already pure and tested; no signature changes.
- `commit_import`'s path-taking style and the callers' `reload_all()`
  orchestration — that stays as-is. Note: plan-kb-single-interface
  explicitly does *not* move commit flow into KbManager either (its §1.3
  keeps the import handlers' config reads). So after both plans land, the
  import path remains a parallel KB write interface — accepted for now;
  unifying it is unowned follow-up work. This plan only changes *how
  progress is reported* on that path, not how it writes.

## 4. Steps

1. **Progress seam:** add `ProgressFn`, write `tauri_progress` adapter in
   lib.rs, change three signatures + internal call sites (mechanical, 12
   sites). `cargo check`. No behavior change.
2. **Fetch seam:** add `FetchFn`, `real_http_fetch`, rewire
   `extract_from_url`/`import_from_url`. Unit tests for
   `validate_fetch_url` (https-only, loopback/private/link-local v4,
   loopback v6, hostname pass-through). `cargo test`.
3. **LLM seam + mock:** `with_http_client` builder + ~30-line SSE mock in
   llm.rs tests (openai format, `data:` chunks, `[DONE]`). One test:
   extract_commands parses a streamed response.
4. **Pipeline tests** (the payoff): in import.rs tests, fake fetch + fake
   progress recorder + real LlmClient against the mock:
   - single-chunk happy path → previews, status ok
   - multi-chunk: 3 chunks, middle fails → error surfaced, other chunks'
     commands survive (the partial-failure contract)
   - dedup across chunks
   - `existing_categories_for` replacement: categories appear in prompt
     (assert via the mock's captured prompt)
5. **Dead-input fix:** KbManager::categories_for_platform + thread through
   lib.rs + delete stub. `cargo check` + `cargo test`.

## 5. Verification

- `cargo check` + `cargo test` after each step; existing tests
  (split_text_chunks, HTML extraction, validation) untouched and passing.
- New tests per §4.2–4.4 (~12 cases).
- Manual: one real LLM import against linux-bash with the streaming modal
  open — progress events, chunk reporting, and completion behavior
  unchanged.

## 6. Deliberate non-goals

- No trait hierarchies for fetch/LLM — two `dyn Fn` types and one
  `#[cfg(test)]` builder cover the seams; adapters are written once each.
  No new dependencies: the fetch future type is spelled with stdlib
  `Pin<Box<dyn Future>>` (futures is transitively present but not a direct
  dep, and we don't add it for a type alias), and the LLM mock is a stdlib
  `TcpListener`, not hyper/wiremock.
- No SSRF hardening (DNS resolution of hostnames) — the existing ponytail
  comment at 431–432 stands; this plan only tests current behavior.
- No changes to chunk size, prompts, or validation semantics — except §1.4,
  which makes an advertised input real.