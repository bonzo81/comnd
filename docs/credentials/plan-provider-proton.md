# Proton Pass Provider — Implementation Notes + Verification Checklist

First real `SecretProvider` (chunk 8). Validates the trait against a live CLI.
Source: `src-tauri/src/secrets/providers/proton.rs`. Research: `01-provider-research.md` §Proton Pass.

## What's implemented

- **Binary:** `pass-cli` on PATH (official, protonpass.github.io/pass-cli; paid plans only).
- **Ref format:** `pass://<vault>/<item>/<field>` — validated by `parse_ref` before any spawn. Vault = Share ID or name; item = ID or title; field case-sensitive.
- **Auth:** PAT read from our keyring (`get_provider_secret("proton")`) and passed to the subprocess as env `PROTON_PASS_PERSONAL_ACCESS_TOKEN`. No PAT → rely on a persisted interactive session from `pass-cli login` (OS keyring). Secrets go via env, never argv.
- **Methods:** `status()`, `resolve()`, `test_reference()` (returns item name, never the secret), `list()`.

## Commands used (from research — confirm against a real install)

| Purpose | Invocation | Notes |
|---|---|---|
| status probe | `pass-cli vault list` | One call doubles as install + auth check: spawn failure = NotInstalled, non-zero exit = AuthExpired/Timeout. |
| resolve / test | `pass-cli item view "pass://<vault>/<item>/<field>"` | Full ref (with scheme) as a single arg. Raw stdout treated as the secret value. |
| list — vaults | `pass-cli vault list` | Each non-empty line → one vault, fed to `--share-id`. |
| list — items | `pass-cli item list --share-id <vault>` | Each non-empty line → one item title. |

## Assumptions to verify (real Proton account + installed pass-cli)

These are the load-bearing guesses. Confirm each; adjust `proton.rs` where wrong.

1. **Raw stdout = clean single value.** `item view` assumed to print just the field value. If it prints a label/header or JSON, switch to `--output json` and parse the documented schema. *Centralized in `item_view()` — one-line change.*
2. **`vault list` output shape.** Assumed one vault per line (ID or name). Confirm whether lines are IDs or names, and that they're accepted verbatim by `--share-id`. If names ≠ share-ids, a lookup step is needed.
3. **`item list --share-id <id>` output shape.** Assumed one item title per line. Confirm; `--output json` is the upgrade path if titles need disambiguation (duplicates resolve first-match-wins).
4. **Default field for browse refs.** `list()` builds refs with field `password` (`DEFAULT_FIELD`). Confirm `password` is the conventional login-password field name, or derive it from item JSON.
5. **status → AuthExpired mapping.** Any non-zero exit (bad PAT *and* expired session) maps to `AuthExpired { action: "Run pass-cli login ..." }`. Confirm a bad PAT doesn't return something we'd rather surface as a config error.
6. **Install URL in NotInstalled message.** Currently `https://proton.me/pass` (product page). Swap for the exact CLI install link if there's a dedicated one.
7. **PAT scope/expiry.** Confirm a stored PAT has read scope on `item view` / `vault list` / `item list`, and how expiry surfaces (exit code vs stderr text).

## Manual verification steps

```
# 1. Install pass-cli, confirm on PATH:
pass-cli --version

# 2. Auth (pick one):
pass-cli login                                   # interactive → OS keyring session
# or store a PAT in our keyring via the settings UI (chunk 7)

# 3. Probe each command and capture real output:
pass-cli vault list
pass-cli item list --share-id <id-from-above>
pass-cli item view "pass://<vault>/<item>/password"

# 4. Check each against the assumptions above; edit proton.rs where it diverges.
# 5. Re-run: cargo test (parse_ref unit tests) + cargo check.
```

## Out of scope here

- SSH agent integration (CLI loads Pass keys into an agent / acts as agent) — separate phase.
- `pass-cli run` secret masking — we read via `item view`, unaffected.
- TOTP field resolution (`?totp=code|uri`) — not wired; add when a host needs it.
