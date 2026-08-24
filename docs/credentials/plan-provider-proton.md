# Proton Pass Provider — Implementation Notes + Verification Checklist

First real `SecretProvider` (chunk 8). Validates the trait against a live CLI.
Source: `src-tauri/src/secrets/providers/proton.rs`. Research: `01-provider-research.md` §Proton Pass.

## What's implemented

- **Binary:** `pass-cli` on PATH (official, protonpass.github.io/pass-cli; paid plans only).
- **Ref format:** `pass://<vault>/<item>/<field>` — validated by `parse_ref` before any spawn. Vault = Share ID or name; item = ID or title; field case-sensitive.
- **Auth:** PAT read from our keyring (`get_provider_secret("proton")`) and passed to the subprocess as env `PROTON_PASS_PERSONAL_ACCESS_TOKEN`. No PAT → rely on a persisted interactive session from `pass-cli login` (OS keyring). Secrets go via env, never argv.
- **Methods:** `status()`, `resolve()`, `test_reference()` (returns item name, never the secret), `list()`.

## Commands used (confirmed against a real install, 2026-08-24)

Tested with the Windows Proton Pass app's bundled CLI (`%LOCALAPPDATA%\Programs\ProtonPass\pass-cli.exe`) and a live account.

| Purpose | Invocation | Confirmed output shape |
|---|---|---|
| status probe | `pass-cli vault list` | One call doubles as install + auth check: spawn failure = NotInstalled, non-zero exit = AuthExpired/Timeout. |
| resolve | `pass-cli item view "pass://<vault>/<item>/<field>"` | Raw stdout is the clean field value (verified). Field view with `--output json` still prints the raw value, not JSON. |
| test label | `pass-cli item view "pass://<vault>/<item>" --output json` | View **without** a field → full item JSON; label = `item.content.title`. |
| list — vaults | `pass-cli vault list` | Lines: `- [<share_id>]: <name>` — parse the ID, never pass the line verbatim (leading `-` makes clap reject it as a flag). |
| list — items | `pass-cli item list --share-id <id> --output json` | `{"items": [{"id", "title", "item_type", "state", ...}]}`. Also accepts `--vault-name <name>`; other options: `--filter-type`, `--filter-state`, `--sort-by`. |

Ref resolution facts (verified):

- `item view` accepts **name or ID** for both vault and item — both tested, same result.
- Item **titles can duplicate** (two `logmein.com` in one vault) → browse-generated refs use opaque IDs: `pass://<share_id>/<item_id>/password`.
- Login item fields: `email`, `username`, `password`, `urls`, `totp_uri`, `passkeys` → `DEFAULT_FIELD = "password"` is correct.

## Still unverified

1. **status → AuthExpired mapping.** Any non-zero exit (bad PAT *and* expired session) maps to `AuthExpired { action: "Run pass-cli login ..." }`. Confirm a bad PAT doesn't return something we'd rather surface as a config error.
2. **Install URL in NotInstalled message.** Currently `https://proton.me/pass` (product page). The Windows app bundles the CLI at `%LOCALAPPDATA%\Programs\ProtonPass\pass-cli.exe`; swap for the exact CLI install link if there's a dedicated one.
3. **PAT scope/expiry.** Confirm a stored PAT has read scope on `item view` / `vault list` / `item list`, and how expiry surfaces (exit code vs stderr text).

## Manual verification steps

```
# 1. Install pass-cli, confirm on PATH:
pass-cli --version

# 2. Auth (pick one):
pass-cli login                                   # interactive → OS keyring session
# or store a PAT in our keyring via the settings UI (chunk 7)

# 3. Probe each command and capture real output (shapes now confirmed — see table above):
pass-cli vault list
pass-cli item list --share-id <id-from-above> --output json
pass-cli item view "pass://<vault>/<item>/password"

# 4. Check against the confirmed shapes; edit proton.rs where it diverges.
# 5. Re-run: cargo test (parse_ref + parse_vault_line unit tests) + cargo check.
```

## Out of scope here

- SSH agent integration (CLI loads Pass keys into an agent / acts as agent) — separate phase.
- `pass-cli run` secret masking — we read via `item view`, unaffected.
- TOTP field resolution (`?totp=code|uri`) — not wired; add when a host needs it.
