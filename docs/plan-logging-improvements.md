# Plan: Logging Improvements (P1–P3)

**Status: P1.1–P3.3 done.**
Implementation notes: `env_logger` replaced by `simplelog` (P3.2) — runtime
level changes work live both up and down via `log::set_max_level`. P3.1
forwards prod logs to Rust via `log_frontend` command (dev stays console-only).
Log file: default `dirs::data_dir()/netsh/logs/netsh.log`, release builds
only, no rotation (`ponytail:` comment in `lib.rs`). The path is now
user-configurable via Settings → General → "Log file location" (see
`plan-custom-log-location.md`); a custom path that can't be opened at startup
falls back to the default with a toast warning.

Implementation plan for logging hardening. Derived from review of
`src/lib/logger.ts` (frontend) + Rust `log` crate usage across `src-tauri/`.

P0 bugs (kb.rs dead branch, kb-import-dialog wrong arg shape) already fixed
separately — not in scope here.

## Goals

| Priority | Item | Why |
|---|---|---|
| P1 | Runtime log-level control via config | Debug prod without restart + env var |
| P1 | Frontend timestamps | Correlate with Rust stderr |
| P2 | Secret-redaction audit | Prevent cred leak before it happens |
| P2 | Dedup connect log | One source per flow |
| P2 | Wire `debug` calls to config level | Make `log.debug` reachable in prod |
| P3 | Unified log stream (frontend → Rust) | Single sink for support |
| P3 | Log file output | Persist across app restart |
| P3 | Tag registry (const enum) | Prevent typo drift, optional |

Non-goals: structured JSON logging, log aggregation, per-module filters.
YAGNI until shipped log analysis.

## P1.1 — Runtime log-level control

### Backend

`config.rs`:
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    // ...existing fields...
    #[serde(default = "default_log_level")]
    pub log_level: String,   // "debug"|"info"|"warn"|"error"
}

fn default_log_level() -> String { "info".to_string() }
```
Update `Default` impl + test_default_config assertion.

`lib.rs` `run()`:
```rust
let config = ConfigStore::new()
    .unwrap_or_else(|e| { /* fallback as today */ });
let level = config.get().log_level.clone();
env_logger::Builder::from_env(env_logger::Env::default().default_filter_or(&level))
    .filter_level(parse_level(&level))   // belt + braces
    .init();
```
Add `get_log_level` + `set_log_level` Tauri commands in `lib.rs`. `set`
persists via `config_store.save_log_level(level)` + emits an event
`log-level-changed` so frontend syncs. Note: `env_logger` global filter is
set at init — runtime bump needs `log::set_max_level()` + a custom filter,
or accept "restart to fully lower". Simplest: set_max_level on change,
keep builder default. Document the limitation.

### Frontend

`logger.ts`:
```ts
let minLevel: LogLevel = isDev ? "debug" : "info";

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}
```
Add `get_log_level` Tauri command call at boot in `main.ts` after
`log.info("app", "Initialized")`:
```ts
const level = await getLogLevel().catch(() => "info");
setLogLevel(level as LogLevel);
```
Listen for `log-level-changed` event → `setLogLevel`.

Settings UI: add "Log level" dropdown to settings screen (when it exists).
Until settings screen lands, expose via command palette entry or dev
console only. No UI = no P1 block.

### Verify

- `cargo check` in `src-tauri/`
- `npm run build`
- Manual: set `log_level:"debug"` in config.json, restart, confirm
  `ssh.rs:504` PTY resize debug line appears in stderr.

## P1.2 — Frontend timestamps

`logger.ts` `format`:
```ts
function format(level: LogLevel, tag: string, msg: string): string {
  const ts = new Date().toISOString();
  return `[net.sh:${tag}] ${ts} ${level.toUpperCase()} ${msg}`;
}
```
ISO 8601 matches `env_logger` default. No deps. Done.

### Verify

`npm run build`. Eyeball console: every line prefixed with timestamp.

## P2.1 — Secret-redaction audit

No code change yet. Audit pass only — no cred logging found in review.

Add a denylist guard in `logger.ts` for future-proofing:
```ts
const SECRET_PATTERNS = [/password\s*[:=]\s*\S+/i, /api[_-]?key\s*[:=]\s*\S+/i];
function redact(s: string): string {
  return SECRET_PATTERNS.reduce((acc, p) => acc.replace(p, "$0[REDACTED]"), s);
}
```
Apply in `format` to `msg` only (not tag). Cheap, catches accidental cred
in interpolated strings. Skip `...args` — objects with secrets are
caller's responsibility; document in logger header.

`ponytail:` comment in logger noting the ceiling: regex on msg string,
not recursive over args. Upgrade path: structured fields with explicit
secret flag.

## P2.2 — Dedup connect log

`main.ts:246` and `host-screen.ts:564` both log "Connecting to '...'".

`host-screen.ts` owns connect flow (calls `sshConnect`). Delete
`main.ts:246`. Keep `host-screen.ts:564`.

Single-line delete. Verify by grepping for the duplicated string — only
one hit remains.

## P2.3 — Wire debug calls to config level

Depends on P1.1. Once `setLogLevel("debug")` reachable at runtime, the 4
`log.debug` calls in `terminal-view.ts` fire automatically. No code
change beyond P1.1.

If P1.1 blocked (settings UI not ready), document the debug calls as
"dev-only until config exposes level". No separate work.

## P3.1 — Unified log stream (frontend → Rust)

New Tauri command in `lib.rs`:
```rust
#[tauri::command]
async fn log_frontend(level: String, tag: String, msg: String) -> Result<(), String> {
    match level.as_str() {
        "debug" => log::debug!("[fe:{}] {}", tag, msg),
        "info"  => log::info!("[fe:{}] {}", tag, msg),
        "warn"  => log::warn!("[fe:{}] {}", tag, msg),
        "error" => log::error!("[fe:{}] {}", tag, msg),
        _ => return Err("invalid level".into()),
    }
    Ok(())
}
```
Register in `invoke_handler`.

`logger.ts`: after console emit, fire-and-forget Tauri call:
```ts
import { invoke } from '@tauri-apps/api/core';
// in each level fn:
if (!isDev) invoke('log_frontend', { level, tag, msg }).catch(() => {});
```
Dev keeps console-only (faster, no IPC latency in hot path). Prod forwards.
Wrap in feature flag if prod latency concern — but `log.debug` already
short-circuits, so only info+ flows to Rust. Acceptable.

Fallback: if Tauri not present (unit test), `invoke` rejects, `.catch`
swallows. No crash.

### Why P3 not P1

Two sinks (console + Rust) until file output (P3.2) lands = limited win.
Real value emerges when Rust writes to file. Ship P3.1 + P3.2 together
or skip both. Recommend: defer until support need.

## P3.2 — Log file output

Rust only. Add `simplelog` or manual file appender to `lib.rs` `run()`:
```toml
# Cargo.toml
simplelog = "0.12"
```
```rust
use simplelog::{WriteLogger, Config, LevelFilter};
let log_path = dirs::data_dir().unwrap().join("netsh").join("logs").join("netsh.log");
std::fs::create_dir_all(log_path.parent().unwrap()).ok();
let file = std::fs::OpenOptions::new().create(true).append(true).open(&log_path).unwrap();
WriteLogger::init(LevelFilter::Info, Config::default(), file).ok();
```
Replaces `env_logger::init()`. Loses env var override — combine with
P1.1 level: pass `parse_level(config.log_level)` as `LevelFilter`.

Rotation: not in scope. `netsh.log` grows unbounded. `ponytail:` comment
naming ceiling: manual truncate or rotate when size > 10MB. Upgrade
path: `simplelog::RollingFileAppender`.

Pair with P3.1 so frontend logs land in same file. Without P3.1, file
has Rust logs only — still useful for SSH/KB debugging.

### Verify

- `cargo check`
- Manual: run app, tail `netsh.log`, confirm SSH connect line written.
- Check file not created in dev unless config flag set (avoid noise in
  dev — add `if !isDev` equivalent on Rust side via `cfg!(debug_assertions)`).

## P3.3 — Tag registry

`logger.ts`:
```ts
export const LogTag = {
  App: "app",
  Ssh: "ssh",
  Terminal: "terminal",
  Prompt: "prompt",
  Suggest: "suggest",
  Kb: "kb",
  KbImport: "kb-import",
  HostScreen: "host-screen",
  NavPanel: "nav-panel",
} as const;
export type LogTag = typeof LogTag[keyof typeof LogTag];
```
Update `log` signature: `tag: LogTag`. Migrate call sites mechanically
(`"ssh"` → `LogTag.Ssh`). Rust tags stay strings (no shared type across
boundary).

Low payoff. Do only if a typo bug hits. Skip until then.

## Execution order

1. P1.1 (config + level plumbing) — unblocks P2.3
2. P1.2 (timestamps) — one-line change
3. P2.2 (dedup connect log) — one-line delete
4. P2.1 (redaction guard) — small, defensive
5. P3.2 (file output, Rust-only) — immediate debug value
6. P3.1 (frontend forwarding) — ship with or after P3.2
7. P3.3 (tag registry) — optional, last

P0 bug fixes (already done) precede all of the above.

## Open questions (resolved)

- ~~Settings UI for log level~~ — done. Dropdown in General settings
  (`settings-screen.ts`), calls `set_log_level`, fires `log-level-changed`.
- ~~Log rotation policy~~ — size cap. `log_max_size_mb` in config (default 10,
  0 = off), `SizeCapWriter` in `lib.rs` truncates file when cap hit. Setting in
  General settings, applies on next app start.
- ~~Serialize `...args` to Rust~~ — done. `serializeArgs()` in `logger.ts`
  JSON-encodes args (circular-safe, Error → name: message), appended to msg in
  `log_frontend`.