# CONTEXT.md — Comnd domain glossary

Vocabulary for the Comnd codebase. AI agents and architecture reviews use these
terms; keep them current as concepts crystallize.

## Suggestion pipeline

- **Shadow buffer** — frontend's observed mirror of the input line. Never echoed;
  exists only for suggestion matching. No local echo (docs/adr/001).
- **Ghost text** — inline completion overlay at the xterm cursor. Payload is
  token-aware (`text` | `literal` | `choice` | `variable`); `variable` is a
  hint, not completable.
- **Keystroke routing** — deciding what one xterm `onData` string does (Tab accept
  vs pass-through, Escape close order, buffer ops). Decision table lives inside
  SuggestionController as a private pure function; the module's interface is
  `keyIn(data)`.
- **SuggestionController** — the deep keystroke module. Owns routing decision,
  sentinel-free accept resolution (ghost/dropdown/sidebar), and the shadow
  buffer mutations. TerminalView calls one method.
- **Line tracker** — merged prompt detector + echo line tracker feeding mode
  awareness and echo re-sync.
- **SuggestionUi** — ghost + dropdown + sidebar detail rendered around a
  terminal; widgets re-created per reconnect, so the controller holds them as
  accessors. UI-only chrome (sidebar open state, suggestion toggle) reaches the
  controller as a `ui` callbacks dep.

## Reading Comfort

- **Reading Comfort mode** — user-facing preset for dyslexic readers. Turning it
  on stamps typography defaults (text size, line height, letter spacing,
  high-contrast suggestions) and a recommended theme, then exposes each as an
  individual control. Internal specs call it "dyslexia mode". It never forks
  the colour palette — the recommended themes stay ordinary entries in the
  theme list, and OFF reverts typography only, leaving theme choice alone.

## Dialogs

- **Modal shell** — shared dialog plumbing owned by `openModal()` in
  `src/lib/modal.ts`: backdrop, `role="dialog"`, Escape (capture +
  stopPropagation), backdrop click, focus, cleanup. Returns `{ close, panel }`.
- **Dismiss flags** — `dismissOnEscape` / `dismissOnBackdrop`, both default
  `true`. Opt-outs must be visible at the call site (e.g. import in progress).
- **Confirm adapter** — `confirmDialog()` is a thin variant over the modal
  shell; it is not the shell itself.

## Testing

- **Test harness** — the single test-owned module that stands in for everything
  the app talks to — the Tauri IPC seam, shared wire fixtures, and DOM
  scaffolding — behind one narrow interface (`tests/harness.ts`,
  `docs/plans/054-plan-test-harness.md`). Its fixture factories are exported on
  their own, so a test can take a `Command` or a `Host` without swapping the IPC
  dispatcher. Strict by default: an unmocked IPC command throws. Not "test
  utils", "testkit", or a "fake backend".
- **Terminal fake** — the single test-owned stand-in for xterm's `Terminal`: the
  members the app actually uses, plus the geometry the ghost text and timestamps
  read. It is the second adapter for the terminal seam (xterm is the first) and
  holds the module's one `as unknown as Terminal` cast, so a screen can be
  driven in a test without booting the app.
- **Rust fixture module** — the crate-level `#[cfg(test)]` counterpart of the
  test harness (`src-tauri/src/fixtures.rs`): a temp-directory guard that
  removes its tree on drop, and builders for the structs tests construct, so a
  schema change fails in one place instead of fifteen. Not "test utils", not a
  "mock backend".
- **AppState test constructor** — the one function that assembles every store
  over a temp directory (`AppState::for_test` in `src-tauri/src/state.rs`), so
  a Rust handler test can call a handler's `_impl` with a plain `&AppState`
  instead of a Tauri app handle. The Rust counterpart of the test harness; it
  is what makes the command layer's wiring — read order, guards, lock order —
  reachable from a `#[test]`.

## Rust command layer

- **Command adapter** — a `#[tauri::command]` that is a three-line delegate
  over a real function in its parent module (the shape `paths/commands.rs`
  established and the rest of the layer now follows): `foo_impl(&state, …)`.
  The impl owns the wiring and takes `&AppState`, so it is callable from a
  `#[test]`; the adapter exists only to unwrap `State`/`AppHandle` and convert
  argument types. When a command starts holding logic again, the fix is to
  move it back into the impl rather than to test the adapter.
