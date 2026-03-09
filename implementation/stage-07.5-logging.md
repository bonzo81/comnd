# Stage 07.5 — Logging & Diagnostics

**Goal:** Add structured logging to both the Rust backend and TypeScript frontend so that connection issues, auth failures, data flow problems, and KB queries can be diagnosed during development and in production.

**Spec refs:** None — this is a build-quality improvement that supports all subsequent stages.

---

## Why This Stage

Stages 08–12 build on a working SSH connection with prompt detection, suggestions, and keyboard shortcuts. Debugging these features without logs is painful — you can't see what the prompt detector matched, what the shadow buffer contains, or why a KB query returned nothing. Logging now pays dividends immediately.

---

## Steps

### 1. Add Rust log backend (`env_logger`)

- Add `env_logger` crate to `Cargo.toml`
- Initialize `env_logger` in `lib.rs` `run()` before Tauri builder
- Default log level: `info` (configurable via `RUST_LOG` env var)
- In dev mode, logs go to stdout/stderr (visible in `cargo tauri dev` terminal)

### 2. Add structured log calls across Rust backend

**ssh.rs:**
- `info!` on connect attempt (hostname, port, username — NOT password)
- `info!` on auth method attempted (password / key)
- `info!` on auth success
- `warn!` on auth failure
- `info!` on channel open, PTY allocate, shell request
- `info!` on disconnect (reason)
- `debug!` on data send/receive (byte count only, NOT content)
- `warn!` on host key mismatch
- `info!` on TOFU accept

**kb.rs:**
- `info!` on platform load (platform id, command count)
- `debug!` on query (prefix, platform, result count)

**hosts.rs:**
- `info!` on host create/update/delete
- `warn!` on parse errors (replace `eprintln!`)

**lib.rs:**
- `info!` on app startup (KB path, data dir)
- `warn!` on host store fallback
- Replace all `eprintln!` with proper log macros

### 3. Add frontend logger utility

Create `src/lib/logger.ts`:
- Simple level-based logger (debug, info, warn, error)
- Each log call prefixed with `[net.sh]` and component tag
- Uses `console.debug/log/warn/error` under the hood
- Log level configurable (default: `info` in prod, `debug` in dev)

### 4. Add frontend log calls

**terminal-view.ts:**
- Log connection start, credential retrieval, SSH connect call, events received
- Log errors with full context

**connection-manager.ts:**
- Log host list load, form submit, connect initiation

**main.ts:**
- Log app init, view transitions

---

## Files Modified

| File | Changes |
|------|---------|
| `src-tauri/Cargo.toml` | Add `env_logger` dependency |
| `src-tauri/src/lib.rs` | Init logger, add log calls, replace `eprintln!` |
| `src-tauri/src/ssh.rs` | Add log calls at all lifecycle points |
| `src-tauri/src/kb.rs` | Add log calls for load and query |
| `src-tauri/src/hosts.rs` | Replace `eprintln!` with `log::warn!`, add log calls |
| `src/main.ts` | Add logger calls for app lifecycle |
| `src/components/terminal-view.ts` | Add logger calls for SSH flow |
| `src/components/connection-manager.ts` | Add logger calls for host operations |

## Files Created

| File | Description |
|------|-------------|
| `src/lib/logger.ts` | Frontend logging utility |

---

## Verification

1. `cargo tauri dev` — logs visible in terminal: startup, KB path, host store init
2. Connect to a host — see: connect attempt, auth method, auth result, channel open, data flow
3. Disconnect — see: disconnect reason logged
4. Open DevTools console — see: `[net.sh]` prefixed frontend logs with component tags
5. `RUST_LOG=debug cargo tauri dev` — see debug-level logs (data byte counts, KB queries)
6. Auth failure — see: warning logged with details (no credentials leaked)

---

## Security Notes

- NEVER log passwords, credentials, or SSH key contents
- Data payload logging is byte-count only at `debug` level — no content
- Host key fingerprints may be logged (they are public information)

---

## Definition of Done

All existing `eprintln!` calls replaced with proper `log::` macros. Every significant event in the SSH lifecycle, KB loading, and host management produces a log line. Frontend logs are structured and filterable. A developer running `cargo tauri dev` can diagnose connection issues, auth failures, and data flow problems from the terminal output alone.
