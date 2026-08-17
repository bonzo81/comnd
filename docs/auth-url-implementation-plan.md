# Auth URL Detection — Implementation Plan

Detect Tailscale-style browser-auth URLs during SSH connection, open the system browser, and surface the URL in the connect overlay.

## Background

Tailscale SSH (check mode) and similar gateways require browser re-authentication. The server delivers the auth URL via SSH auth banner or keyboard-interactive instructions. Stock OpenSSH prints the URL and fails; user opens browser, authenticates, retries.

**Already in place:**
- `src-tauri/src/ssh.rs` — `auth_banner` handler forwards banner as `ssh-output` → overlay output pane shows it during connect.
- `src-tauri/src/ssh.rs` `authenticate()` — keyboard-interactive `InfoRequest` instructions/prompts forwarded the same way.
- `src-tauri/src/test_server.rs` — mock server sends `https://login.tailscale.com/a/test123` banner. QA path ready.
- `src/components/terminal-view.ts` — overlay output pane renders pre-connect output; error overlay has Retry button.

**Gap:** no URL extraction, no browser open, no explicit auth-required affordance.

## Changes (4 files + doc, ~85 lines, zero new deps)

### 1. `src-tauri/src/lib.rs` — open browser (~20 lines)

- `pub fn open_url(url: &str)` via `std::process::Command` per-OS:
  - Windows: `cmd /C start "" <url>`
  - macOS: `open <url>`
  - Linux: `xdg-open <url>`
- `#[tauri::command] async fn open_url_cmd(url: String) -> Result<(), String>` for frontend re-open. Reject URLs not starting with `https://`. Register in `invoke_handler`.

No `tauri-plugin-opener` — stdlib covers all three target OSes.

### 2. `src-tauri/src/ssh.rs` — detect + emit (~30 lines)

- `fn extract_https_url(text: &str) -> Option<String>`:
  `text.split_whitespace().find(|w| w.starts_with("https://"))`, trim trailing `.,)>;"'`.
  No regex crate.
  `// ponytail: first https token wins; upgrade to regex if gateways wrap URLs oddly`
- `Arc<AtomicBool>` (`auth_url_opened`) shared between `ClientHandler` and the authenticate flow → browser opens once per connection attempt (banner + KI may both carry the URL).
- Helper: on URL found → set flag, emit `ssh-auth-url { url, session_id }`, call `crate::open_url`.
- Hook sites:
  - `ClientHandler::auth_banner` (ssh.rs:164)
  - `SshSession::authenticate` KI `InfoRequest` branch (ssh.rs:388) — check instructions + each prompt

### 3. `src/lib/tauri-api.ts` (~6 lines)

- `export async function openUrl(url: string): Promise<void>` → `invoke("open_url_cmd", { url })`

### 4. `src/components/terminal-view.ts` (~30 lines)

- New listener `ssh-auth-url` in `registerSshListeners()`, session-correlated like the others; unregistered in `unregisterSshListeners()`.
- On event (connecting phase):
  - Overlay stage text: `Authentication required — opened <url> in browser`
  - Add "Open again" button in `overlay-actions` next to Cancel → `openUrl(url)`
- Output pane untouched — raw banner/instructions text already renders there.

### 5. `docs/user-guide/03-connecting-to-devices.md`

Short paragraph: hosts behind Tailscale-style auth → URL auto-opens in browser, overlay shows it, Retry after authenticating.

## Security

URL arrives **pre-auth** from unauthenticated server text. Auto-opening a server-supplied URL is a phishing vector if the server is hostile — same tradeoff `tailscale ssh` CLI makes. Mitigations:

- `https://` only (no `http://`)
- Once per connection attempt (AtomicBool)
- URL displayed verbatim in overlay stage + output pane — user sees exactly what was opened

## Deliberately skipped (ponytail)

| Skip | Why | Add when |
|---|---|---|
| `tauri-plugin-opener` dep | `std::process::Command` covers Win/mac/Linux | Plugin proves more reliable across distros |
| Regex URL extraction | Whitespace-token scan is 1 line | Gateways wrap URLs in markup |
| Auto-retry after browser auth | Retry button exists; matches stock OpenSSH+Tailscale flow | Retry friction annoys |
| Post-connect URL detection / clickable terminal links (`@xterm/addon-web-links`) | Separate feature, needs opener integration | Users run `tailscale up` on remotes often |
| ~~Extending 20s auth timeout~~ | **Done** — raised to 120s. Confirmed in testing: Tailscale holds auth open while user authenticates in browser (observed 11s) | — |

## Verification

1. `cargo check` (src-tauri) — clean.
2. Frontend `tsc` build — clean.
3. Dev-build QA: `testStartMockServer()` → connect to `127.0.0.1:<port>` with any user/pass →
   - Browser opens to `https://login.tailscale.com/a/test123`
   - Overlay stage shows auth-required message + "Open again" button
   - Banner text visible in output pane
   - Mock accepts password → session connects normally (regression check)
4. `lsp_diagnostics` on all changed files — clean.
