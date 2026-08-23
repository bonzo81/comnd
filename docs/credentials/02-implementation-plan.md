# Credential Integration — Implementation Plan

Master plan. Single source of truth for sequencing and chunk specs. Architecture and UI decisions live here per-chunk; provider capability details live in `01-provider-research.md`; decisions log in `00-overview.md`. Per-provider plan files (`plan-provider-*.md`) are created only when that provider is scheduled, expanding its chunk with command output shapes and test findings.

Chunk = PR-sized unit, independently verifiable, in dependency order. Numbers are stable — reference them in commits/PRs.

## Rust layout (introduced incrementally)

```
src-tauri/src/secrets/
  mod.rs          # SecretProvider trait, registry, provider config (chunk 6)
  agent.rs        # agent transport + named-pipe stream (chunk 3)
  providers/
    proton.rs     # chunk 8
    passbolt.rs   # chunk 11
    onepassword.rs# chunk 12
    bitwarden.rs  # chunk 13
    vault.rs      # chunk 14
```

No new crates. `russh` 0.46 (agent client), `reqwest` 0.12 (Vault), `keyring` 3 already in `Cargo.toml`.

---

## Phase 1 — Credential model + Rust-side resolution

### Chunk 1 — `CredentialSource` enum, hosts.json read-compat

**Goal:** host auth becomes data; old files load; new files carry the enum.

**Files:** `src-tauri/src/hosts.rs`

**Spec:**
- `pub enum CredentialSource` (serde `#[serde(tag = "type", rename_all = "snake_case")]`):
  - `Password` — keyring entry keyed by host_id (existing behavior)
  - `SshKey { key_path: String }` — absorbs legacy `ssh_key_path`
  - Variants `Agent`, `SecretRef` land in chunks 4 and 9 (add when used — serde stays backward compatible)
- `Host` gains `credential: Option<CredentialSource>`; legacy `auth_type`/`ssh_key_path` become `#[serde(default, skip_serializing)]` read-only fields
- On load: `credential` None → synthesize from `auth_type`/`ssh_key_path`. On save: only `credential` serializes
- Frontend `Host` type (`src/lib/tauri-api.ts` or host types) mirrors the union; host form still writes legacy-equivalent shape until chunk 9 (serialization stays compatible either way)

**Verification:** unit tests — old JSON (both auth_types) loads to correct variant; roundtrip writes enum only; `cargo check`; `npm run build`.

### Chunk 2 — `ssh_connect(host_id)`: resolution moves to Rust

**Goal:** secrets never enter webview JS. Prerequisite for all later phases.

**Files:** `src-tauri/src/lib.rs`, `src-tauri/src/ssh.rs` (minor), `src/lib/tauri-api.ts`, `src/components/terminal-view.ts`

**Spec:**
- `ssh_connect` drops `password`/`key_path` params, gains `host_id`; loads host from store, resolves `CredentialSource` (Password → existing `get_credential`, SshKey → key path) inside Rust
- `SshSession::connect` signature unchanged (still takes `Option<&str>` password + key path)
- Frontend: delete `getCredential` block in `terminal-view.ts` (~`terminal-view.ts:491-501`), progress text merges into "Connecting…" step
- `get_credential`/`save_credential` IPC stay (host form still uses them for Password)

**Verification:** `cargo check` + `npm run build`; manual smoke: password host + key host both connect to `test_server.rs`; no `password` field in IPC payloads (log check).

---

## Phase 2 — SSH agent auth

### Chunk 3 — Agent transport + `agent_list_identities` IPC

**Goal:** app can find and enumerate an SSH agent on all three OSes.

**Files:** `src-tauri/src/secrets/agent.rs`, `src-tauri/src/lib.rs`, `src/lib/tauri-api.ts`

**Spec:**
- `russh::keys::agent::client::AgentClient` — unix: `connect_env()` / `connect_uds(path)`; Windows: custom `AgentStream` over `tokio::net::windows::named_pipe` (`\\.\pipe\openssh-ssh-agent`), ~50 lines, same agent protocol
- IPC `agent_list_identities() -> Vec<{ fingerprint, algorithm, comment } | Error>` — empty + reason when no agent found
- Detection order: `SSH_AUTH_SOCK`/named pipe → Pageant (russh built-in) as Windows fallback

**Verification:** `cargo check`; manual: with Windows OpenSSH agent service running + a key loaded via `ssh-add`, IPC returns the identity; without agent, clean error string.

### Chunk 4 — Agent auth in `SshSession` + `Agent` host variant

**Goal:** connect via agent-signed key; device auth-flood protection.

**Files:** `src-tauri/src/ssh.rs`, `src-tauri/src/hosts.rs`, `src-tauri/src/lib.rs`

**Spec:**
- `CredentialSource::Agent { identity: Option<String> }` — identity = fingerprint; `None` = offer all (documented risk on strict devices)
- Auth chain in `authenticate`: agent identity first (filter `request_identities` by fingerprint, offer only that one via `authenticate_publickey_with`) → existing key → password → keyboard-interactive fallbacks intact
- Agent socket opened per connect attempt, dropped after auth (no long-lived handle)

**Verification:** unit test for fingerprint filtering; manual: test_server or real device with agent key; wrong-fingerprint → falls through to next method or clean failure.

### Chunk 5 — Host form: agent method + identity picker

**Goal:** user picks agent auth and an identity per host.

**Files:** `src/components/host-screen.ts`, `src/lib/tauri-api.ts`, `src/styles/components/_forms` (or nearest existing form styles)

**Spec:**
- Auth method radio gains "SSH agent"
- Identity picker: dropdown populated from `agent_list_identities` (fingerprint short + comment), plus "Offer all identities" option; shows agent status inline ("No agent detected — start 1Password / ssh-agent")
- Keyboard-first: picker is a native select or existing dropdown component per `docs/07-keyboard-shortcuts.md`

**Verification:** `npm run build`; manual: select identity, save, connect; host list shows agent badge next to auth indicator if one exists.

---

## Phase 3 — Provider framework + Proton Pass (first provider)

### Chunk 6 — `SecretProvider` trait, registry, config storage, IPC

**Goal:** the abstraction all providers plug into; no provider yet.

**Files:** `src-tauri/src/secrets/mod.rs`, `src-tauri/src/config.rs`, `src-tauri/src/lib.rs`

**Spec:**
- Trait:
  ```rust
  #[async_trait::async_trait]
  pub trait SecretProvider: Send + Sync {
      fn id(&self) -> &'static str;
      async fn status(&self) -> ProviderStatus;   // Ready | NotInstalled(msg) | AuthExpired(action) | Error(msg)
      async fn resolve(&self, reference: &str) -> Result<String, String>;  // returns password/passphrase
      async fn list(&self) -> Result<Vec<CredentialItem>, String> { Err("not supported") } // default impl
  }
  ```
- Registry: `Vec<Box<dyn SecretProvider>>` in `AppState`, constructed at startup from config
- Provider config in `config.json`: `providers: { proton: { enabled: bool, ...fields }, ... }` — secrets (PATs, session keys) in keyring under `netsh_provider_<id>`, following the ollama-key pattern (`config.rs:82-101`)
- IPC: `list_providers() -> Vec<{ id, status }>`; `test_ref(provider, reference) -> { label } | Error` (resolve, read title, discard secret)
- All subprocess spawning: arg arrays, secrets via env (`Command::env`), never argv, never `sh -c`
- Unit-test mock provider (env-var-backed) exercises trait + registry without a real CLI

**Verification:** `cargo check`; unit tests with mock provider (status/resolve/list wiring, test_ref discards secret).

### Chunk 7 — Settings: Auth Integrations page

**Goal:** enable/config providers, see live status.

**Files:** `src/components/settings-screen.ts`, `src/components/nav-panel.ts` (settings items list), `src/lib/tauri-api.ts`, settings styles

**Spec:**
- New settings nav item "Auth Integrations" → provider cards (one per registered provider)
- Card: provider name/logo mark, status line (from `list_providers`, refresh on mount + manual refresh), enable toggle, per-provider config fields
- Proton card fields: Personal Access Token (password input → keyring), "Use interactive login session instead" note
- Card for each future provider renders as disabled/Coming soon until its chunk lands (registry knows who's registered)

**Verification:** `npm run build`; manual: toggle proton, save PAT, status reflects CLI-not-found vs ready.

### Chunk 8 — Proton Pass provider

**Goal:** first real provider; validates the trait with your account.

**Files:** `src-tauri/src/secrets/providers/proton.rs`, registered in `secrets/mod.rs`

**Spec:**
- CLI detect: `pass-cli --version` on PATH
- Status: not installed → install hint URL; PAT configured → try `pass-cli whoami`-equivalent (verify actual command during impl) or lightweight `vault list`; session issues → "Run `pass-cli login` in your terminal"
- Resolve: `pass-cli item view <ref> --output json` (or raw) with PAT via env `PROTON_PASS_PERSONAL_ACCESS_TOKEN` when configured; no PAT → rely on persisted session, map its failures to AuthExpired
- Ref format enforced: `pass://<vault>/<item>/<field>` (validate before spawn — reject malformed refs before any subprocess)
- List: `pass-cli vault list` + `pass-cli item list` → `CredentialItem { id, label, username? }` (JSON shapes confirmed during impl — record in `plan-provider-proton.md`)

**Verification:** `cargo check`; manual with real account: PAT status ready; `test_ref` on a real ref returns item title; bad field name → clean error; session expired → AuthExpired message.

### Chunk 9 — Host form: secret-ref source UI

**Goal:** host auth can be "Secret manager: Proton Pass, ref X".

**Files:** `src-tauri/src/hosts.rs` (`SecretRef` variant), `src/components/host-screen.ts`, `src/lib/tauri-api.ts`

**Spec:**
- `CredentialSource::SecretRef { provider: String, reference: String, label: Option<String> }` (label = cached non-secret display name)
- Auth method radio gains "Secret manager"; provider dropdown filtered to enabled + Ready providers; ref input (paste) + **Test** button (`test_ref` → shows label or error inline)
- Host list/cells display `label · provider` where they currently show auth type
- Keyboard-first: same select/dropdown patterns as chunk 5

**Verification:** `cargo check` + `npm run build`; manual: create host with proton ref, Test shows title, save, host list shows label.

### Chunk 10 — Connect-time secret resolution + failure UX

**Goal:** end-to-end: host with SecretRef connects; failures are actionable.

**Files:** `src-tauri/src/lib.rs` (connect flow), `src-tauri/src/secrets/mod.rs`, `src/components/terminal-view.ts` (error banner + retry)

**Spec:**
- `ssh_connect`: `SecretRef` → registry lookup → `resolve` → password into existing auth flow; resolved value dropped after auth attempt
- Error mapping: `AuthExpired` → "Proton Pass session expired — run `pass-cli login` in your terminal, then retry"; `NotInstalled` → install hint; resolve-failed → provider message + the ref
- Retry button on the connect-failed banner re-invokes connect (existing error UI gains retry affordance if not present)
- Progress text during resolve step: "Resolving credentials via Proton Pass…"

**Verification:** manual with real proton account: happy path connects; delete session/revoke PAT → actionable error; retry after fixing succeeds. `cargo check` + `npm run build`.

---

## Phase 4 — Passbolt

### Chunk 11 — Passbolt provider (+ UI registration)

**Goal:** second provider, heaviest auth model, you test it.

**Spec (expand into `plan-provider-passbolt.md` when scheduled):**
- CLI: `passbolt` (go-passbolt-cli) on PATH; auth = its own config file (we never store GPG key/passphrase — user configures the CLI once in their terminal, our status just probes it)
- Status: not installed → hint (`go install github.com/passbolt/go-passbolt-cli@latest`); configured → probe `passbolt list resource` or equivalent; TOTP MFA failures → "Run MFA login in your terminal"
- Resolve: `passbolt get resource --id <uuid>`; refs = `passbolt://<uuid>` (UUID-only, names not unique)
- Validate v5 encrypted-metadata reads work on your server before building (known risk — see research doc); record findings + JSON shapes in the plan file
- UI: settings card (enable toggle + status only — no credential fields), host form works via existing secret-ref UI (chunk 9 is provider-agnostic)

**Verification:** manual with real server: v5 resource resolve, MFA-expired path, test_ref.

---

## Phase 5 — 1Password

### Chunk 12 — 1Password provider

**Goal:** cheapest provider — zero auth babysitting.

**Spec (expand when scheduled):**
- CLI: `op` on PATH; status: not installed → hint (ships with 1Password desktop app); desktop integration not enabled → "Enable 'Integrate with 1Password CLI' in the desktop app"
- Resolve: `op read <ref>` (refs `op://vault/item/field`); env: none — desktop app handles auth/biometric
- List: `op item list --format json`
- Agent users already served by phase 2 — this chunk is passwords-in-vault only

**Verification:** manual (needs 1Password account — borrow/team account, or defer chunk until available; not blocking other chunks).

---

## Phase 6 — Bitwarden + Vault

### Chunk 13 — Bitwarden provider (session babysitting)

**Spec (expand when scheduled):**
- Resolve: `bw get password <id>` with `BW_SESSION` from our keyring
- Settings card gains "Unlock" flow: one-time `bw unlock` → we capture `BW_SESSION` (user pastes it, or we spawn `bw unlock` and read the session line — decide at impl) → keyring `netsh_provider_bitwarden`
- Status: session key present → probe `bw sync`/`bw list items --search x`; expired → "Vault locked — Unlock in Auth Integrations settings"
- List: `bw list items --search` filtered to logins

**Verification:** manual: unlock → resolve → lock vault in desktop → AuthExpired → re-unlock.

### Chunk 14 — Vault provider (direct HTTP)

**Spec (expand when scheduled):**
- Only provider not using a CLI: `GET {address}/v1/{mount}/data/{path}` with `X-Vault-Token` (`reqwest` 0.12, already a dep)
- Settings card fields: server address, token (keyring), KV mount (default `secret`), KV version (1/2 — v2 inserts `/data/`)
- Ref format: `<path>#<field>` (e.g. `netops/core-sw#password`)
- Status: token configured → `GET /v1/auth/token/lookup-self`
- KV v1/v2 path difference handled in one resolver fn

**Verification:** manual against dev Vault (`vault server -dev`); unit tests for v1/v2 path construction + ref parsing.

---

## Phase 7 — Credential browse UI

### Chunk 15 — Browse modal for list()-capable providers

**Goal:** replace paste-ref with picker where the provider can list.

**Spec:**
- "Browse…" button next to ref input (visible only when `list()` works for the selected provider)
- Modal: searchable list (label + username filter), select → writes ref + caches label; Escape/backdrop cancels; keyboard navigable (arrow keys + Enter) per `docs/07-keyboard-shortcuts.md`
- Proton, op, bw get Browse; passbolt (if list viable), Vault (`kv list` — needs folder traversal, assess lazily) maybe later; paste+Test remains the fallback for all

**Verification:** `npm run build`; manual: browse → select → Test → save → connect.

---

## Doc updates (ride along with the chunks that make them true)

| When | Doc | Change |
|---|---|---|
| Chunk 2 | `docs/02-technical-architecture.md` | Credential resolution now Rust-side; IPC signature |
| Chunk 5 | `docs/04-connection-manager.md`, `docs/07-keyboard-shortcuts.md` | Agent auth method + picker |
| Chunk 7 | `AGENTS.md` file map | `secrets/` module |
| Chunk 10 | `docs/user-guide/09-security.md`, `03-connecting-to-devices.md` | Provider resolution, error+retry behavior |
| Phase 3+ | `docs/08-future-open-questions.md` | Move credential integration out of backlog |

## Global verification gate (every chunk)

- `cargo check` in `src-tauri/` — exit 0
- `npm run build` — exit 0
- Chunk-listed unit tests green
- No secret ever: serialized to disk, logged, passed via argv, or returned over IPC except transiently where the host form needs it (existing `get_credential` for Password editing)

## Explicitly skipped (add when asked)

- In-app interactive re-auth dialogs (bw unlock, pass-cli login in-app) — v1 is error + fix-in-your-terminal + retry
- Vault SSH cert signing (`authenticate_openssh_cert`)
- Provider write/rotate operations
- Bundling any CLI
- Multi-instance providers (two Vault servers, two accounts) — single config per provider
