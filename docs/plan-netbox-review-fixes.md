# Plan: Over-Engineering Review Fixes (NetBox host source)

Status: approved review, not yet implemented. Scope: shrink/simplify the
NetBox implementation per the ponytail review pass. No behavior changes —
pure deletions and stdlib swaps. Obey `AGENTS.md` verification gates.

## 1. Goal

Apply the over-engineering findings from the review of the NetBox host
source work (`docs/plan-netbox-host-source.md`). Every change is a net line
reduction with no behavior change. Three findings survived verification;
three were retracted after checking the code (see §4).

## 2. Confirmed decisions

| Question | Decision |
|---|---|
| Behavior change allowed? | No. Pure refactor/shrink. |
| New abstractions? | None. |
| Touch the a11y pass? | No — accessibility is a requested feature, never simplify it away (ponytail rule). |
| Verification | `cargo check` + `cargo test` (src-tauri/), `npm run build`. All must exit 0. |

## 3. Findings to apply

### 3.1 `netbox_test_connection`: drop `Option<bool>` arg (shrink)

`src-tauri/src/lib.rs:913` — `allow_invalid_certs: Option<bool>` then
`unwrap_or(false)`. The frontend (`tauri-api.ts:577`) passes a plain
`boolean`; Tauri serde deserializes Rust `bool` from JS `boolean` directly.
The `Option` adds nothing.

- Change the signature to `allow_invalid_certs: bool`.
- Drop the `.unwrap_or(false)` (net −2 lines).
- Update `src/lib/tauri-api.ts:573` call site only if the wrapper type
  changes — it already passes `boolean`, so no TS change needed.
- Check the `netbox_test_connection` test in `netbox.rs` tests (none call
  through the IPC command; the client tests pass `bool` already).

### 3.2 `ResolvedCredentials::none()` → derive `Default` (shrink)

`src-tauri/src/credentials.rs:47-52` — a named constructor used once
(`lib.rs:504`). Replace with a `derive(Default)` on the struct and call
`ResolvedCredentials::default()` at the one site.

- Add `Default` to the `#[derive(...)]` on `ResolvedCredentials`
  (`credentials.rs:40`). `AgentAuth::Off` needs `Default` too — derive it
  on `AgentAuth` (`credentials.rs:29`) returning `Off` (the natural
  default; matches the current `none()` body).
- Delete the `none()` method (net −6 lines incl. doc comment).
- Replace the one caller `ResolvedCredentials::none()` →
  `ResolvedCredentials::default()` (`lib.rs:504`).
- No test touches `none()` directly — verify with `cargo test`.

### 3.3 `slugify`: simplify to a stdlib one-liner (shrink)

`src-tauri/src/netbox.rs:277-289` — 13-line hand-rolled slug normalizer
(uppercase fold, separator collapse, trim). The plan §8.3 calls for
site/location slugs to be slug-safe before they land in synthetic group
ids; the function stays, but the separator-collapse and trim are
unnecessary — double dashes or a trailing dash in a synthetic group id
are harmless (the id is opaque, never parsed back).

- Replace the body with:
  ```rust
  fn slugify(s: &str) -> String {
      s.to_ascii_lowercase()
          .chars()
          .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
          .collect()
  }
  ```
- Net −7 lines.
- Update `test_slugify_and_name_caps` (`netbox.rs:1152-1161`): drop the
  `"--weird--" → "weird"` and `"a.b_c" → "a-b-c"` assertions (those tested
  the collapse/trim behavior being removed); keep `"Rack Row 1"` →
  `"rack-row-1"` and the `dc-01` case. Add an assertion that double dashes
  pass through (`"a--b" → "a--b"`) to lock the new contract.

## 4. Retracted findings (do NOT apply)

Documented so nobody re-proposes them.

| Finding | Why retracted |
|---|---|
| Merge `netboxTestOk` + `netboxTestLine` in `settings-screen.ts` | The two diverge: `netboxTestOk` means "test passed with a *new* token entered" (drives Save Connection highlight); `netboxTestLine.ok` means "test passed" (status text). Re-test with the stored token sets `ok=true` but `netboxTestOk=false` — a real, used distinction. |
| Inline `host_id()` helper (`netbox.rs:259`) | Used twice: `materialize_host` (L629) and `lib.rs:987` (`netbox::host_id(netbox_id)` for the keyring key). Two callers is not YAGNI. |
| `report.clone()` in `apply_sync` (`netbox.rs:404`) | The function stores the report in the cache AND returns it. One clone is unavoidable regardless of which copy is moved. |

## 5. Verification gates

After all three changes:

1. `cargo check` in `src-tauri/` — exit 0.
2. `cargo test` in `src-tauri/` — exit 0 (the `slugify` and credential
   tests are the only ones affected).
3. `npm run build` — exit 0 (no TS change expected, but confirms the IPC
   shape didn't drift).

## 6. Suggested order

Each is independent and small. Apply in the order §3.1 → §3.2 → §3.3,
running `cargo check` between each. Total expected net lines removable:
~15. Commit each as its own change (or all three together — they touch 3
files: `lib.rs`, `credentials.rs`, `netbox.rs`).