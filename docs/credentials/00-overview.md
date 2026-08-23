# Credential Integration — Overview

External secret/credential providers (1Password, Bitwarden, Passbolt, Proton Pass, HashiCorp Vault) as auth sources for saved hosts, alongside the existing OS keychain and SSH key file paths.

## Document index

| Doc | Contents | Status |
|---|---|---|
| `00-overview.md` | Goals, scope, decision log, phases (this file) | Current |
| `01-provider-research.md` | Per-provider capabilities, auth models, CLI refs | Current |
| `02-implementation-plan.md` | Master plan: 15 PR-sized chunks across 7 phases; architecture + UI specs live per-chunk | Current |
| `plan-provider-<name>.md` | Per-provider expansion (CLI output shapes, test findings) | Created when provider is scheduled |

Related existing docs: `docs/02-technical-architecture.md` (keystroke/auth flow), `docs/04-connection-manager.md` (host form), `docs/user-guide/09-security.md` (keychain behavior).

## Goals

- Host auth via external provider secret references, resolved at connect time, never persisted
- SSH agent auth (1Password, Bitwarden desktop, Proton Pass agent, OpenSSH agent) — zero secret plumbing
- Credential resolution moves into Rust so secrets never enter webview JS memory
- Per-provider status surfacing (installed? authenticated?) in settings and host form
- Keyboard-first UX unchanged; host form gains auth source selection

## Non-goals

- Writing/rotating secrets in providers (read-only resolution)
- Bundling provider CLIs with the app (user-installed, detected on PATH)
- Proton Pass free tier (CLI is paid-plan only), Vault SSH cert signing engine (post-MVP)
- New cloud services — all resolution is local subprocess/agent/HTTP to user's own infrastructure

## Decision log (user-confirmed)

1. **Two integration models, both first-class:** secret fetch (resolve ref → password/passphrase → existing auth flow) and agent auth (russh agent client signs; secret never retrieved). Agents are not "providers" in the UI — they are a third auth method.
2. **CLI subprocess for all password managers; direct HTTP only for Vault.** E2E vaults make the CLI the crypto client — reimplementing client crypto per provider is a non-starter. Vault has no client crypto (token + JSON over TLS), so it uses direct HTTP. Hybrid escape: any provider can flip transport behind the same trait.
3. **User-installed CLIs, never bundled.** Licensing (GPL `bw`), security/update ownership (we'd become a binary distributor), size, and vendors ship CLIs with their desktop apps anyway. Detect on PATH; status UI links install guides. Exception: agent path needs no CLI — ships with the desktop app the user already runs.
4. **Store references, not secrets.** `hosts.json` holds `{provider, native_ref}` (`op://`, `pass://`, `passbolt://<uuid>`, Vault path) + cached non-secret display label. Resolved values live only in memory during connect.
5. **Resolution in Rust, at connect time.** `ssh_connect(host_id)` loads host, resolves credential source, authenticates. Removes password from IPC and webview. Prerequisite refactor before any provider exists.
6. **Secrets to subprocesses via env, never argv** (visible in `ps`/procmon). Arg arrays only — never `sh -c`.
7. **Settings → Auth Integrations page:** enable/config per provider, live status. Per-provider config structs; secrets (PATs, session keys) in OS keyring following the ollama-key pattern (`config.rs:84-101`).
8. **Credential picker is a per-provider capability:** optional `list()` on the trait. Providers that list → browse modal (searchable). Providers that can't (or v1) → paste ref + Test button (resolve, show item title or error, discard).
9. **Host model migration: clean cut, read-compat only.** Old `auth_type`/`ssh_key_path` load via serde defaults, migrate in-memory, write `CredentialSource` enum shape only. No dual-write.
10. **Agent identities: per-host picker.** Some devices drop connections after N failed publickey attempts; hosts store a fingerprint (or "offer all" with documented risk).
11. **Session failures: actionable error + Retry.** No in-app interactive re-auth v1 — user fixes auth in their own terminal, hits Retry.
12. **Plan structure: single master plan** (`02-implementation-plan.md`, 15 chunks), not per-phase or per-provider plan files (provider files only expand a chunk when scheduled).
13. **First provider: Proton Pass** (`pass-cli`) — real account for end-to-end testing, exercises keyring-stored PAT. Passbolt second, 1Password/Bitwarden/Vault follow.

## Phases

| Phase | Chunks | Scope |
|---|---|---|
| 1 | 1-2 | `CredentialSource` model + Rust-side resolution (`ssh_connect(host_id)`) |
| 2 | 3-5 | SSH agent auth: transport, `SshSession` auth path, host form picker |
| 3 | 6-10 | `SecretProvider` trait, Auth Integrations settings page, Proton Pass, host form secret-ref UI, connect-time resolution + failure UX |
| 4 | 11 | Passbolt |
| 5 | 12 | 1Password |
| 6 | 13-14 | Bitwarden (session babysitting), Vault (direct HTTP) |
| 7 | 15 | Credential browse modal for `list()`-capable providers |

## Testing notes

Passbolt + Proton Pass have real accounts for testing. Validation checklist (see research doc): Passbolt v5 encrypted-metadata support in `go-passbolt-cli`, TOTP MFA interactivity, `pass-cli` session persistence across restarts, PAT expiry, JSON output shapes for `list`.
