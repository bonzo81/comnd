# Plan: Command Replay

Implements `docs/specs/09-command-replay.md`. User-saved commands with named variables, played into the terminal from the side panel.

Decisions:
- Variables stored as a template string with `{{name}}` markers — no offsets to maintain.
- Playback reuses the existing paste path (`sshSend` + `shadowBuffer.append`) — no auto-Enter.
- One JSON file in the app data dir, mirroring host storage patterns (`hosts.rs` / `paths.rs`).

## 1. Backend (`src-tauri/src/replay.rs` — new)

- Types:
  ```rust
  struct ReplayVariable { name: String, prompt: String }        // prompt defaults to name
  struct ReplayCommand {
      id: String,               // uuid
      command: String,          // template, e.g. "show running-config interface {{interface}}"
      variables: Vec<ReplayVariable>,
      platform: String,         // validated via hosts::is_valid_platform
      created_at: String,
      last_used: Option<String>,
  }
  ```
- Storage: `replay.json` in app data dir (same dir as hosts — use `paths.rs`). Read/rewrite whole file on each mutation (same as hosts; collection is small).
- Commands in `lib.rs`:
  - `replay_list() -> Vec<ReplayCommand>`
  - `replay_save(cmd) -> ReplayCommand` (validate: non-empty command, variable names unique + non-empty, platform valid)
  - `replay_delete(id)`
- Register in Tauri handler builder.

## 2. Frontend API (`src/lib/tauri-api.ts`)

- `ReplayCommand` / `ReplayVariable` interfaces + `replayList()`, `replaySave()`, `replayDelete()` invoke wrappers.

## 3. Save flow — variable-marking modal (`src/components/replay-save-dialog.ts` — new)

- Opened with the command text (from terminal selection or manual entry).
- Renders the command as a read-only styled preview; the user **selects a span of the preview text and clicks "Mark as variable"** → that span becomes a `{{varname}}` chip (prompted for a name; default `variable1`, incrementing). Clicking a chip un-marks it (variable text returns to plain, chip removed).
- Platform dropdown pre-filled with the active session's platform, always changeable (all four valid platforms).
- Save → `replaySave()`. Cancel / Escape / backdrop closes.
- Styles: reuse `.modal-backdrop` pattern (see `host-screen.ts:512-543`); new `_replay-dialogs.css` in `src/styles/components/`.

## 4. Terminal — "Add to Command Replay" (`src/components/terminal-view.ts`)

- Add item to `showContextMenu()` menu (after Copy/Paste): "Add to Command Replay", enabled when there is a selection.
- Action: capture `terminal.getSelection()`, clear selection, open `ReplaySaveDialog` with that text. Dialog is global (document body) — decouples it from the terminal instance.
- Empty/newline-only selection: item disabled.
- Trim trailing newline from selection before passing it.

## 5. Side panel — KB ⇄ Replay switch (`src/components/terminal-view.ts` + `src/lib/sidebar-content.ts`)

- Side panel header gets a two-state toggle: **Knowledge Base** | **Command Replay** (segmented control, styled per `tokens.css`). Default: Knowledge Base (unchanged behaviour).
- Replay view: list of saved commands filtered to the current session's platform (toggle "All platforms" checkbox if the filtered list is empty). Each row: command preview (variables rendered as chips), platform badge, ▶ Play button, delete (×, confirm modal).
- Empty state: "No saved commands yet. Select text in the terminal, right-click → Add to Command Replay." with a manual "Add command" button opening the save dialog with empty text.
- Play click:
  - No variables → substitute nothing, insert.
  - Has variables → small prompt dialog (one input per variable, name + prompt label, Enter = submit, Escape = cancel) → substitute values into template → insert.
  - Insert = existing `pasteClipboard` path: `sshSend(sessionId, command)` + shadow buffer append. No `\r` — user presses Enter themselves.
- Manual add button in Replay view header opens `ReplaySaveDialog` with empty text.

## 5b. Top-level nav + management view (user request)

- **Nav panel** (`nav-panel.ts`): new top-level section **Command Replay** (`NavSection` += `"replay"`), one item "Manage Commands" → `onOpenReplay()` callback.
- **`main.ts`**: `AppView` += `"replay"`; persistent wrapper; mount `ReplayScreen`; `showView` + statusbar label wiring.
- **`src/components/replay-screen.ts`** (new): full management view, mirrors KB screen layout — platform filter select, command list (template with variable chips, platform badge), Edit / Delete per row, "Add Command" button opening the save dialog. Edit = delete + re-save via `replaySave` with existing id.
- **`replay-save-dialog.ts`**: accepts an optional existing `ReplayCommand` — parses the `{{name}}` template back into segments and pre-fills the variable list; save keeps the id (update, not insert).

## 6. Docs

- `docs/specs/07-keyboard-shortcuts.md` — no new global shortcuts (all mouse/Enter driven in dialogs); verify no conflicts.
- `docs/specs/08-future-open-questions.md` — remove "command snippets" roadmap reference or point it at Command Replay.
- `AGENTS.md` file-locations: add `replay.rs` and `replay-save-dialog.ts`.

## 7. Verification

- `cargo check` + `cargo clippy` in `src-tauri`; `npm run build` (tsc) must exit 0.
- Unit: Rust `replay.rs` round-trip (save → list → template substitution helper); frontend substitution helper (`src/lib/replay.ts` — pure function, testable: `substitute(template, {interface: "Gi0/1"})`).
- Manual smoke: select text in terminal → right-click → save → mark variable → play → prompt → command appears at terminal prompt unexecuted; delete; manual add; platform filter.

## Skipped (add when asked)

- Editing existing replay items ~~(delete + re-add for now)~~ — done in §5b.
- Sequences / multi-command replay.
- Export/import of replay sets.
- Last-used timestamps shown in UI (stored but not surfaced).
