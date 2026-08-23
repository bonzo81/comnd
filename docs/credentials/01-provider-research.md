# Provider Research — Credential Integration

Findings per provider, gathered 2026-08. Feeds `02-architecture.md` and per-provider plans.

## Summary matrix

| Provider | Ref syntax | Transport | Listing | Auth burden | SSH agent | First wave? |
|---|---|---|---|---|---|---|
| 1Password | `op://vault/item/field` | CLI (`op`) | `op item list` | None (desktop app delegates, biometric) | Yes (desktop app, named pipe/socket) | Phase 3 |
| Bitwarden | item id | CLI (`bw`) | `bw list items` | `BW_SESSION` session key we babysit | Desktop app only (not CLI) | Phase 5 |
| Passbolt | `passbolt://<resource-uuid>` | CLI (`passbolt`, go-passbolt-cli) | `passbolt list resource` | GPG key + passphrase in CLI's own config; TOTP-only MFA | No | Phase 4 (testable) |
| Proton Pass | `pass://vault/item/field` | CLI (`pass-cli`) | `pass-cli item list` | Interactive login (keyring-persisted session) or PAT | Yes (CLI loads keys into agent, or acts as agent) | Phase 4 (testable) |
| HashiCorp Vault | kv path + `-field=` | **Direct HTTP** | `kv list` (or API LIST) | `VAULT_TOKEN` env | N/A (SSH cert engine is separate, post-MVP) | Phase 5 |

## 1Password

- CLI: `op read "op://app-prod/db/password"` — secret references are first-class. Query params: `?attribute=otp`, `?ssh-format=openssh` (materializes SSH keys, but prefer agent).
- Auth: desktop app integration — `op` delegates to the desktop app; user confirms via Windows Hello/Touch ID. **Zero credentials for us to store.** Service accounts exist for headless (`OP_SERVICE_ACCOUNT_TOKEN`); Connect server for infra. v1 = desktop integration only.
- Listing: `op item list --categories Login` (+ `--format json`).
- Feb 2026: SDK desktop auth GA — 10-minute-bound user-authenticated sessions. Confirms vendor blesses this integration pattern for desktop tools.
- SSH agent: desktop app exposes standard OpenSSH agent. Windows: `\\.\pipe\openssh-ssh-agent`. Unix: socket.

## Bitwarden

- CLI: `bw get password <id>` (id or unique search string), `bw list items --search x --folderid <id>` → JSON. SSH key items are type 5 (`.sshKey.privateKey` field).
- Auth wrinkle: `bw unlock` produces a `BW_SESSION` session key required on every subsequent command (`--session` or env). No desktop↔CLI session sharing. Provider must store `BW_SESSION` in our keyring after a one-time unlock, and detect/re-prompt on expiry.
- SSH agent: desktop app only (user request for CLI agent open, not shipped). Agent path connects to desktop app's socket.
- Secrets Manager (`bws`, machine accounts) is a separate product — out of scope v1.

## Passbolt

- CLI: `go-passbolt-cli` (binary `passbolt`), community-maintained under passbolt's GitHub org. `go install github.com/passbolt/go-passbolt-cli@latest`.
- One-time config in the CLI's own file: `passbolt configure --serverAddress https://... --userPrivateKeyFile key.asc --userPassword '...'`. Passwordless private keys unsupported.
- Reads: `passbolt get resource --id <uuid>`; listing: `passbolt list resource`. Refs are UUID-addressed — names are not unique, prefer UUIDs.
- MFA: TOTP only (`none` / `interactive-totp` / `noninteractive-totp` with stored TOTP secret). Duo/YubiKey MFA accounts **cannot** authenticate via CLI.
- v5 gotcha: metadata encryption (personal + shared keys) is the new default. Verify go-passbolt-cli reads v5 resources on our server — the new official Ansible plugin (account-kit based, rewritten for v5) suggests ecosystem v5 support has lagged. New official plugin is read-only lookup by UUID; SDK building blocks signaled but not shipped.
- `passbolt exec` resolves `passbolt://` refs for subprocess env — confirms ref model viability.

## Proton Pass

- CLI: `pass-cli`, official (protonpass.github.io/pass-cli), launched Nov 2025, active releases (2.1.4+). **Paid plans only** (Pass Plus and up).
- Refs: `pass://<vault>/<item>/<field>` — vault by Share ID or name, item by ID or title, field case-sensitive. Names resolve to IDs; first match wins on duplicates. TOTP fields resolvable (`?totp=code|uri`).
- Reads: `pass-cli item view "pass://..."`; listing: `pass-cli vault list`, `pass-cli item list --share-id <id>`; `--output json` available.
- Auth: `pass-cli login` interactive → session encrypted with key stored in OS keyring by default (kernel keyring on Linux, Credential Manager on Windows, Keychain on macOS). Headless: Personal Access Token (`pass-cli login --personal-token`, env `PROTON_PASS_PERSONAL_ACCESS_TOKEN`) — PAT is the clean path for us: store in our keyring, pass via env to subprocess.
- SSH: CLI can load Pass-stored SSH keys into an existing agent, or run as an SSH agent itself.
- Note: `pass-cli run` masks secrets in child stdout by default — we read via `item view`, unaffected.

## HashiCorp Vault

- Direct HTTP: `GET /v1/<mount>/data/<path>` (KV v2) with `X-Vault-Token` header → JSON. No client crypto. `reqwest` in our Rust; no CLI dependency for the token-auth case.
- CLI fallback exists (`vault kv get -field=X -mount=secret path`) for fancier auth (LDAP/OIDC login flows) if ever needed — trait absorbs either transport.
- SSH secrets engine (signed certificates, OTP) is a different value prop — short-lived certs via `authenticate_openssh_cert` (russh supports). Post-MVP.

## russh agent client (phase 2 primitive)

- `russh::keys::agent::client::AgentClient`: `connect_env()` (unix `SSH_AUTH_SOCK`), `connect_uds(path)`, `request_identities()`, sign via `authenticate_publickey_with(signer)`. Built-in, documented.
- Windows gap: built-in Windows stream speaks Pageant protocol. 1Password/OpenSSH-style named-pipe agents need a custom `AgentStream` impl over `tokio::net::windows::named_pipe` (~50 lines — same agent protocol, different transport).
- Fallback chain (key → password → keyboard-interactive) in `ssh.rs` stays intact; agent offered first when configured.

## Cross-cutting rules (from research)

1. All five providers have resolve-by-ref; four of five can list → optional `list()` on the trait is justified.
2. Ref syntaxes converge on `<scheme>://...` but stay provider-native — store `{provider, native_ref}`, don't normalize.
3. Auth models diverge completely (delegated / session key / GPG+TOTP / PAT / token) → per-provider config struct + mandatory `status()` is load-bearing, not polish.
4. Secrets to subprocesses via env, never argv (argv visible in `ps`/procmon). Arg arrays only; never `sh -c`.
5. CLI spawn latency (~100-300ms) is once per connect, outside keystroke path — non-issue.

## Test checklist (real accounts: Passbolt, Proton Pass)

- Passbolt: does `go-passbolt-cli` read v5 encrypted-metadata resources on our server? Is our MFA TOTP? `passbolt list resource` JSON shape. Named vs UUID addressing.
- Proton: does `pass-cli` login session survive app restarts (keyring persistence)? PAT expiry/permission scope. `pass-cli item list --output json` shape. Windows Credential Manager behavior.
