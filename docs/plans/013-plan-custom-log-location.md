# Plan: Custom Log File Location

**Status: done.** P1 (backend), P2 (frontend), P3 (docs) all implemented.
73 backend tests + 65 frontend tests pass; `cargo check` and `npm run build`
clean.

Let users override the log file path via Settings, with a toast when the
chosen location can't be written and a silent fallback to the default.

## Goal

| Item | Why |
|---|---|
| `log_file_path: Option<PathBuf>` in config, overridable from Settings | Some users want logs on a mounted volume for support / audit |
| Validate + fallback at startup; emit `log-location-warning` event if fallback used | UX: don't crash, tell the user |
| Settings UI: text field + "Browse..." button + "Reset to default" link | Keyboard-first: text field is primary; Browse is optional convenience |
| Toast on unreachable custom path | Per user request |

Non-goals: per-session log dirs, log rotation policy (out of scope in
`plan-logging-improvements.md` and `plan-local-storage-hardening.md`),
watching the dir for liveness (start-time check is enough).

## Current state (what we build on)

- **Default log path**: `paths::log_dir()` = `dirs::data_local_dir().join("com.comnd.app").join("logs").join("comnd.log")` (`paths.rs:28`). User-only perms (0o600 / 0o700) set at startup (`lib.rs:752-766`).
- **Logger init**: `lib.rs:737-776`. Runs **before** `tauri::Builder::default().setup`, no `AppHandle`. Config is read once via `ConfigStore::new(&data_dir)` at `lib.rs:738` so a new config field will be visible here.
- **Config shape**: `AppConfig` in `config.rs:11-27` already has `log_level` + `log_max_size_mb`; adding a field is mechanical. `ConfigStore` owns `save_*` helpers.
- **Settings UI**: `settings-screen.ts:137-160` renders the "Logging" section with two dropdowns. Adding a row means one more block in `renderGeneral()` + one listener in `attachListeners()`.
- **Toast**: `src/lib/toast.ts` — `showToast(msg, "error"|"success"|"info", duration)`. Already used across the app.
- **Event listen pattern**: `main.ts:174` already listens for `log-level-changed` and updates UI. Same pattern for a new `log-location-warning` event.
- **File picker**: No Tauri `dialog` plugin installed (`Cargo.toml` has only `tauri`, `capabilities/default.json` has no dialog permissions). Adding the plugin is one line each in Rust and JS + a capability grant — see P2 below.

## P1 — Backend: config field + startup validation + fallback

### 1.1 Config field

`config.rs`:
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    // ...existing fields...
    #[serde(default)]
    pub log_file_path: Option<String>,  // absolute path to comnd.log, or None for default
}
```

`Default` impl: `log_file_path: None`. No new `default_*` fn needed — `#[serde(default)]` + `Option` defaults to `None`.

Add `save_log_file_path`:
```rust
pub fn save_log_file_path(&mut self, path: Option<String>) -> Result<(), String> {
    self.config.log_file_path = path;
    self.persist()
}
```

Tests in `config.rs`:
- `test_default_config` — assert `log_file_path.is_none()`.
- `test_config_serialization_roundtrip` — round-trip a config with `Some("...")`.
- `test_log_file_path_persist_and_read` — write via `save_log_file_path`, construct a fresh `ConfigStore` on the same dir, assert field is `Some`.

### 1.2 Startup validation + fallback

`lib.rs` `run()` — extend the pre-logger config read (lines 737-746) to also pull `log_file_path`:

```rust
let (level, max_mb, custom_log_path) = match &data_dir {
    Ok(d) => ConfigStore::new(d)
        .map(|c| (
            c.get().log_level.clone(),
            c.get().log_max_size_mb,
            c.get().log_file_path.clone(),
        ))
        .unwrap_or_else(|e| {
            eprintln!("comnd: Failed to read config ({}). Using 'info'/10MB/default log path.", e);
            ("info".to_string(), 10, None)
        }),
    Err(_) => ("info".to_string(), 10, None),
};
```

Then replace the log-path resolution at `lib.rs:751-771` with a helper that tries the custom path, falls back on any error, and records whether it fell back:

```rust
// Release-only file logging (same gate as today: !cfg!(debug_assertions)).
let mut log_fallback_reason: Option<String> = None;
if !cfg!(debug_assertions) {
    let resolved = resolve_log_path(custom_log_path.as_deref());
    match &resolved {
        Ok((path, is_custom)) => {
            let dir = path.parent().unwrap_or(std::path::Path::new("."));
            if crate::paths::ensure_data_dir(dir).is_ok() {
                match std::fs::OpenOptions::new().create(true).append(true).open(path) {
                    Ok(file) => {
                        #[cfg(unix)]
                        {
                            use std::os::unix::fs::PermissionsExt;
                            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
                            let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
                        }
                        let cap_bytes = if max_mb == 0 { u64::MAX } else { max_mb as u64 * 1024 * 1024 };
                        writers.push(Box::new(SizeCapWriter::new(file, path.clone(), cap_bytes)));
                    }
                    Err(e) => {
                        log_fallback_reason = Some(format!(
                            "Could not open log file {} ({}). Logging to stderr only.",
                            path.display(), e
                        ));
                    }
                }
            } else {
                log_fallback_reason = Some(format!(
                    "Could not create log directory for {}. Logging to stderr only.",
                    dir.display()
                ));
            }
            let _ = is_custom;  // reserved for future telemetry
        }
        Err(reason) => {
            // resolve_log_path already fell back to default; reason describes the custom-path failure.
            log_fallback_reason = Some(reason);
        }
    }
}
```

`resolve_log_path`:
```rust
/// Resolve the log file path. If the user supplied a custom path, try it;
/// on any error (empty, non-absolute, parent missing and can't be created,
/// permission denied) fall back to the default `paths::log_dir()` and return
/// a human-readable reason in the `Err` arm.
fn resolve_log_path(custom: Option<&str>) -> Result<(std::path::PathBuf, bool), String> {
    let Some(p) = custom.map(str::trim).filter(|s| !s.is_empty()) else {
        // No custom path → default
        return paths::log_dir().map(|d| (d.join("comnd.log"), false))
            .ok_or_else(|| "Default log dir could not be resolved".to_string());
    };
    let path = std::path::PathBuf::from(p);
    if !path.is_absolute() {
        // Reject relative paths — logger runs before CWD stabilizes
        return paths::log_dir().map(|d| (d.join("comnd.log"), false))
            .ok_or_else(|| format!("Custom log path '{}' is not absolute; using default", p));
    }
    // Defer file-open failure to the caller; we only validate shape here.
    Ok((path, true))
}
```

The bool (`is_custom`) is kept for future telemetry / "Reset to default" UI state but isn't required for the toast path. If it adds noise, drop it and return just `PathBuf`.

**Why validation here, not in the setter**: the user might set a path for a volume that isn't mounted yet. The setter can't meaningfully validate — the filesystem state at next startup is what matters. Validate at startup, fall back, and surface the failure via event + toast.

### 1.3 Emit warning event for the frontend

Still inside `run()`, **after** `tauri::Builder::default().setup` starts (so `app_handle` exists), emit the fallback reason if present:

```rust
.setup(move |app| {
    // ...existing setup code...
    if let Some(reason) = log_fallback_reason.take() {
        log::warn!("{}", reason);
        // Emit after the frontend has had a chance to register its listener.
        // Tauri holds events emitted before a listener exists? No — events are
        // fire-and-forget. So queue and emit from a one-shot timer, or emit
        // from the first `tauri::async_runtime::spawn` after the webview loads.
        // Simplest: emit on a 500ms delay via tauri::async_runtime.
        let app_handle = app.handle().clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            let _ = app_handle.emit("log-location-warning", &reason);
        });
    }
    // ...rest of setup...
})
```

The delay is a `ponytail:` — races the frontend listener registration. Upgrade path: emit from a `tauri::Listen`-style "ready" hook if Tauri grows one, or have the frontend request the current warning state on mount via a new `get_log_status` command (pull model, no race).

**Pull model (recommended, no delay)**: add a `get_log_status` command that returns the current `log_fallback_reason` from state. Frontend calls it on Settings mount. Event is a bonus for live changes (rare — path only changes on restart). Do both if cheap; otherwise just the pull:

```rust
#[tauri::command]
async fn get_log_status(state: tauri::State<'_, AppState>) -> Result<Option<String>, String> {
    Ok(state.log_status.lock().map_err(|e| e.to_string())?.clone())
}
```

Store `log_status: Mutex<Option<String>>` on `AppState` (set during setup). This avoids the emit race entirely.

### 1.4 New Tauri command: `set_log_file_path`

```rust
#[tauri::command]
async fn set_log_file_path(
    path: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.save_log_file_path(path)?;
    log::info!(
        "Log file path set to {} (takes effect on next app start)",
        path.as_deref().unwrap_or("<default>")
    );
    Ok(())
}
```

Register in `invoke_handler` (after `set_log_max_size`).

**Takes effect on next app start** — the logger is initialized once at startup with a fixed file handle. Changing the path live would require re-initializing `simplelog::WriteLogger`, which means swapping the global `log` logger atomically. YAGNI; document the restart requirement in the Settings hint, same as `log_max_size_mb` does today (`settings-screen.ts:159`).

### 1.5 Tests (backend)

- `config.rs` tests per 1.1.
- `lib.rs` unit test for `resolve_log_path`:
  - `None` → default path, `is_custom == false`.
  - `Some("relative/path")` → default path, `Err` reason mentions "not absolute".
  - `Some("/tmp/abs/path")` → that path, `is_custom == true`.
  - `Some("")` and `Some("   ")` → default path (trim handles whitespace).
- `lib.rs` test that `log_fallback_reason` is `Some` when the custom path's parent can't be created. Use a path under a nonexistent read-only dir — best-effort, skip if hard to mock.

## P2 — Frontend: Settings UI + toast + event listener

### 2.1 Settings UI row

`settings-screen.ts` `renderGeneral()` — insert a third Logging row after "Log file size cap" (line 159):

```html
<div class="import-field">
  <label for="log-file-path">Log file location</label>
  <div class="log-file-row">
    <input type="text" id="log-file-path"
      value="${escHtml(this.config?.log_file_path ?? "")}"
      placeholder="Default: app data dir"
      spellcheck="false" autocomplete="off" />
    <button type="button" id="log-file-browse" class="btn-secondary">Browse...</button>
    <button type="button" id="log-file-reset" class="btn-link">Reset</button>
  </div>
  <span class="import-hint">Applies on next app start. Leave blank for the default location.</span>
</div>
```

No new CSS class beyond `log-file-row` (a simple flex inline) if existing `.import-field` styling doesn't cover it. Check `src/styles/components/_dialogs.css` or wherever `.import-field` is defined — if a flex row already exists (e.g. the Ollama URL + Test button row), reuse that class.

### 2.2 Listeners

`settings-screen.ts` `attachListeners()` — after the `#log-max-size` listener (line 233):

```ts
this.container?.querySelector<HTMLInputElement>("#log-file-path")
  ?.addEventListener("change", (e) => {
    const v = (e.target as HTMLInputElement).value.trim();
    void setLogFilePath(v || null);
  });

this.container?.querySelector<HTMLButtonElement>("#log-file-reset")
  ?.addEventListener("click", () => {
    const input = this.container?.querySelector<HTMLInputElement>("#log-file-path");
    if (input) input.value = "";
    void setLogFilePath(null);
  });

// Browse — uses @tauri-apps/plugin-dialog (see P2.3).
this.container?.querySelector<HTMLButtonElement>("#log-file-browse")
  ?.addEventListener("click", () => void this.browseLogFile());

this.container?.querySelector<HTMLButtonElement>("#log-file-browse")
  ?.addEventListener("keydown", (e) => {
    // Ctrl+Enter on the text field also triggers Browse (keyboard-first).
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void this.browseLogFile();
  });
```

`browseLogFile()` method on the SettingsScreen class:
```ts
private async browseLogFile(): Promise<void> {
  try {
    const selected = await save({
      defaultPath: "comnd.log",
      filters: [{ name: "Log files", extensions: ["log"] }],
    });
    if (selected) {
      const input = this.container?.querySelector<HTMLInputElement>("#log-file-path");
      if (input) input.value = selected;
      await setLogFilePath(selected);
    }
  } catch {
    // User cancelled — no-op.
  }
}
```

### 2.3 Tauri dialog plugin (Browse button — in scope)

**Rust** `Cargo.toml`:
```toml
tauri-plugin-dialog = "2"
```

**Rust** `lib.rs` — register the plugin in the builder chain (between `.default()` and `.setup`):
```rust
tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .setup(move |app| { ... })
```

**Capability** `capabilities/default.json` — add permissions:
```json
"permissions": [
  ...,
  "dialog:allow-save",
  "dialog:default"
]
```

**Frontend** `package.json`:
```bash
npm install @tauri-apps/plugin-dialog
```

Import in `settings-screen.ts`:
```ts
import { save } from "@tauri-apps/plugin-dialog";
```

### 2.4 tauri-api.ts

Add to the `AppConfig` interface:
```ts
export interface AppConfig {
  // ...existing fields...
  log_file_path: string | null;
}
```

Add the command wrapper:
```ts
export async function setLogFilePath(path: string | null): Promise<void> {
  return invoke<void>("set_log_file_path", { path });
}

export async function getLogStatus(): Promise<string | null> {
  return invoke<string | null>("get_log_status");
}
```

### 2.5 Toast on unreachable custom path

`main.ts` `syncLogLevel()` (line 168) — rename or add a sibling `syncLogStatus()` that pulls once and listens:

```ts
private async syncLogStatus() {
  const status = await getLogStatus().catch(() => null);
  if (status) {
    showToast(status, "error", 8000);
  }
  try {
    await listen<string>("log-location-warning", (event) => {
      showToast(event.payload, "error", 8000);
    });
  } catch {
    // Tauri not running (unit test) — ignore
  }
}
```

Call `this.syncLogStatus()` after `this.syncLogLevel()` in `mount()` (around line 163). Import `showToast` from `./lib/toast` and `getLogStatus` + `setLogFilePath` from `./lib/tauri-api`.

The pull-on-mount avoids the emit race described in P1.3. The event listener is for future cases where the path might fail mid-session (e.g. removable media ejected) — currently the file is opened once at startup so this won't fire, but wiring it is cheap and forward-compatible.

### 2.6 Tests (frontend)

Existing test setup (`tests/setup.ts`) mocks the Tauri IPC bridge. Add:
- `tests/settings-log-file.test.ts` — render `SettingsScreen`, type a path in `#log-file-path`, dispatch `change`, assert `setLogFilePath` was invoked with the typed value.
- Same test, click `#log-file-reset`, assert `setLogFilePath(null)` and input cleared.
- `tests/log-status-toast.test.ts` — mock `getLogStatus` to return a string, mount the app, assert toast container has a `.toast-error` with the message.

Skip the Browse button test unless the dialog plugin is mockable — it's a convenience, not the primary path.

## P3 — Docs + plan-logging sync

Update `docs/plans/plan-logging-improvements.md` status header (lines 1-8): the log path is no longer only the default; mention the custom-path feature with a backlink to this plan.

Update `docs/plans/plan-local-storage-hardening.md` P3.3: the `comnd.log` path is now configurable; the perms treatment (0o600 / 0o700) applies to whichever path is used. Add a note that **custom paths outside `app_local_data_dir` may inherit lax ACLs from their parent dir** — we chmod on unix but Windows users pointing at a shared drive may expose hostnames to other users. Document the risk in the Settings hint: "Custom locations may have different access permissions. Prefer the default for privacy."

## Open questions

1. **Pull vs push for the warning** — recommendation is pull (`get_log_status` on mount) + listen for completeness. If you prefer emit-only, P1.3 has the delay-based approach.
2. **Should `set_log_file_path` validate the path?** Recommendation: no — the user might be configuring for a volume that will be mounted at next boot. Validate at startup only.
3. **Windows ACL concern** — outside the app data dir, custom log paths inherit the parent's ACL. We can chmod on unix but not easily on Windows without the `windows` crate. Acceptable risk + document in hint, or block non-app-data-dir paths on Windows? Recommendation: document, don't block.

## Implementation order

1. **P1.1 + P1.4 + P1.5** — config field, setter command, tests. Standalone.
2. **P1.2 + P1.3** — startup validation, fallback, `get_log_status` command. Depends on 1.
3. **P2.4 + P2.5** — tauri-api wrappers + toast wiring. Depends on 2.
4. **P2.1 + P2.2 + P2.3** — Settings UI + listeners + dialog plugin + Browse button. Depends on 3.
5. **P3** — docs sync.

Each step compiles and passes `cargo check` + `npm run build` independently.

## Verification

- `cargo check` in `src-tauri/` — exit 0 after each P1 step.
- `cargo test` — new tests pass; existing 68 tests unchanged.
- `npm run build` — exit 0 after each P2 step.
- Manual: set a custom log path in Settings, restart, confirm `comnd.log` appears at the custom location with 0o600 perms (`ls -l` on unix).
- Manual: set a custom path to `/nonexistent/vol/comnd.log`, restart, confirm toast appears and logs go to stderr only (no crash).
- Manual: set custom path blank, restart, confirm logs go to the default location.
- Manual (Windows): set a custom path under `%USERPROFILE%\Documents`, restart, confirm `icacls` shows the file is user-only (or document if it isn't — see Open Question 4).

## Files touched

| File | Change |
|---|---|
| `src-tauri/src/config.rs` | Add `log_file_path: Option<String>` field, `save_log_file_path`, tests |
| `src-tauri/src/lib.rs` | Read custom path at startup; `resolve_log_path` helper; validate + fallback + perms; `log_status` on `AppState`; `set_log_file_path` + `get_log_status` commands; register commands; (optional) dialog plugin init |
| `src-tauri/Cargo.toml` | `tauri-plugin-dialog = "2"` |
| `src-tauri/capabilities/default.json` | `dialog:allow-save`, `dialog:default` |
| `package.json` | `@tauri-apps/plugin-dialog` |
| `src/lib/tauri-api.ts` | Add `log_file_path` to `AppConfig`; `setLogFilePath` + `getLogStatus` wrappers |
| `src/components/settings-screen.ts` | New "Log file location" row in `renderGeneral`; listeners + `browseLogFile` in `attachListeners`; `save` import from plugin-dialog |
| `src/main.ts` | `syncLogStatus()` + call from `mount`; listen for `log-location-warning` |
| `src/styles/components/_dialogs.css` (or equivalent) | `.log-file-row` flex layout if no existing class fits |
| `tests/settings-log-file.test.ts` | **New** — field + reset button |
| `tests/log-status-toast.test.ts` | **New** — toast on warning |
| `docs/plans/plan-logging-improvements.md` | Status header update |
| `docs/plans/plan-local-storage-hardening.md` | P3.3 note: custom paths + ACL caveat |

## Out of scope / future

- **Live log path switching**: requires swapping the global `simplelog` logger at runtime. Doable but niche. Restart is fine for v1.
- **Log rotation to the custom path**: covered by the existing `ponytail:` comment in `lib.rs`. Rotation is a separate task.
- **Directory picker (vs file picker)**: `save` returns a file path, which is what we want. A directory picker would let the user choose a folder and we'd auto-append `comnd.log` — marginally nicer but more code. Skip.
- **Windows ACL tightening on custom paths**: would need the `windows` crate to set explicit user-only ACL. Document the caveat for now; revisit if a user reports exposure on a shared system.