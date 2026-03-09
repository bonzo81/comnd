# Stage 01 — Project Foundation & Build Verification

**Goal:** Get the dev loop working — `cargo tauri dev` launches the app, the frontend renders, xterm.js initialises, and the Tauri backend compiles without errors.

**Spec refs:** `docs/02-technical-architecture.md` (process model), `docs/03-ui-visual-design.md` (theme), `docs/DEVELOPMENT.md` (setup)

---

## Why This Stage First

Nothing else can be tested until the app builds and runs. The scaffold exists but may have build issues, missing deps, or configuration gaps. This stage ensures every contributor starts from the same working baseline.

---

## Steps

### 1. Install dependencies and verify toolchain

- Run `npm install` in project root to install frontend deps (xterm.js, vite, typescript, @tauri-apps/cli, @tauri-apps/api)
- Run `cargo check` in `src-tauri/` to verify Rust deps compile — especially `russh 0.46`, `serde_yml 0.0.12`, `tauri 2`
- Ensure Tauri CLI is available: `npx tauri --version`

### 2. Fix any build errors in Rust backend

- `src-tauri/src/lib.rs` has 6 stub Tauri commands — verify they compile with correct `#[tauri::command]` signatures
- Ensure `mod ssh;` and `mod kb;` are declared and the modules compile (even if empty/stub)
- Verify `Cargo.toml` features are correct for `tauri` (specifically `tauri/devtools` for dev builds)

### 3. Fix any build errors in TypeScript frontend

- Verify `tsconfig.json` strict mode passes with current code
- Verify Vite builds successfully: `npx vite build`
- Fix any type errors in `src/main.ts`, `src/components/*.ts`, `src/lib/*.ts`

### 4. Verify `cargo tauri dev` launches

- Run `cargo tauri dev` from project root
- App window should open with the Tauri webview
- Console (DevTools) should show no critical JS errors

### 5. Verify xterm.js renders

- `src/components/terminal-view.ts` should initialise the terminal with the spec theme
- Confirm the terminal div renders with correct background (`#1e1e2e`) and font (JetBrains Mono)
- Verify the FitAddon works — terminal fills available space

### 6. Verify view switching

- `src/main.ts` has a view controller switching between connection-manager and terminal-view
- Confirm the connection manager empty state renders on launch
- Test that clicking the CTA (or triggering the callback) switches to terminal view
- Test the "Back" button returns to connection manager

### 7. Verify CSS custom properties

- Open DevTools → Elements → check `:root` variables match `docs/03-ui-visual-design.md` colours
- Verify correct fonts load (JetBrains Mono for terminal, system stack for UI)
- Check 4px grid spacing is applied

### 8. Add Tauri API frontend package wiring

- Ensure `@tauri-apps/api` is in `package.json` dependencies
- Create `src/lib/tauri-api.ts` — a thin typed wrapper module that will hold all `invoke()` calls
- For now, export placeholder functions matching the 6 Tauri commands: `queryKb()`, `sshConnect()`, `sshSend()`, `sshDisconnect()`, `getHosts()`, `saveHost()`
- Each function should call `invoke()` from `@tauri-apps/api/core` with the correct command name
- Type the parameters and return types based on the stub signatures in `src-tauri/src/lib.rs`

### 9. Verify Tauri IPC round-trip

- In the frontend, call one of the stub commands (e.g. `getHosts()`) on app start
- Confirm the stub response arrives in the frontend (check DevTools console)
- This validates the IPC bridge is working end-to-end

---

## Files Modified

| File | Changes |
|------|---------|
| `src-tauri/src/lib.rs` | Fix any compile errors in stub commands |
| `src-tauri/Cargo.toml` | Add/fix any missing dependency features |
| `src/main.ts` | Minor fixes if view switching has bugs |
| `src/components/terminal-view.ts` | Fix xterm.js init if needed |
| `src/styles/main.css` | Fix any missing styles for initial render |
| `package.json` | Ensure `@tauri-apps/api` is listed |

## Files Created

| File | Purpose |
|------|---------|
| `src/lib/tauri-api.ts` | Typed wrappers for all Tauri `invoke()` calls |

---

## Verification

1. `npm install` completes without errors
2. `cargo check` (in `src-tauri/`) completes without errors
3. `cargo tauri dev` opens the app window
4. Connection manager empty state visible on launch
5. Switching to terminal view shows xterm.js with dark theme
6. DevTools console shows successful IPC response from `getHosts()` stub
7. No TypeScript compilation errors (`npx tsc --noEmit`)
8. Terminal fills available space and uses JetBrains Mono font

---

## Definition of Done

The app launches with `cargo tauri dev`, both views render correctly, the Tauri IPC bridge works end-to-end with stub commands, and there are zero build errors in both TypeScript and Rust.
