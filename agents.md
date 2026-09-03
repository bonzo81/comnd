# Agents.md — netssh

AI agent behavior and conventions for the netssh project.

## Project Context

netssh is a cross-platform desktop SSH client with context-aware command suggestions for network engineers.

**Stack:** Tauri v2 (Rust) + TypeScript/Vite frontend + xterm.js terminal emulator

**Target platforms:** Windows, macOS, Linux desktop app; network devices (Linux/bash, Cisco IOS-XE, Cisco NX-OS, F5 BIG-IP TMOS)

## Documentation Hierarchy

Read these docs before implementing anything in their domain:

| Domain | Doc |
|---|---|
| Goals, scope, target platforms | `docs/01-overview-goals.md` |
| SSH, keystroke flow, prompt detection | `docs/02-technical-architecture.md` |
| UI layout, colors, typography, components | `docs/03-ui-visual-design.md` |
| Host list, empty state, forms | `docs/04-connection-manager.md` |
| Ghost text, dropdown, mode detection | `docs/05-suggestion-engine.md` |
| YAML schema, version filtering, matching | `docs/06-knowledge-base.md` |
| Shortcuts, keyboard-first design | `docs/07-keyboard-shortcuts.md` |
| Post-MVP backlog, decision log | `docs/08-future-open-questions.md` |
| Command Replay (user-saved commands, variables, playback) | `docs/09-command-replay.md` |

## Non-Negotiable Architecture Rules

1. **Shadow buffer model** — No local echo. All keystrokes go to the remote device in real time. The frontend maintains a shadow buffer that *observes* input for suggestion matching only.

2. **Input handling in frontend** — Keystrokes are handled in the xterm.js `onKey` handler. KB queries go async to Rust via Tauri IPC. Never route keystrokes through Rust — IPC latency is perceptible.

3. **Prompt detection** — State machine in frontend: ANSI strip → idle detection (200ms) → regex match against platform `prompt_patterns`. This powers mode awareness and shadow buffer reset.

4. **Sidebar pushes terminal** — Side panel resizes the terminal; it does NOT overlay it. Terminal gets a PTY resize when sidebar opens/closes.

5. **Tab is context-sensitive** — Accepts ghost suggestion when one is showing; passes through to remote when no suggestion is visible.

6. **Keyboard-first** — Entire app must be navigable without a mouse. `Ctrl+W` must pass through to remote (delete-word in shells).

## Code Style

### TypeScript (Frontend)

- Strict mode enabled
- ES modules (`import`/`export`)
- Classes for stateful components, functions for utilities
- No React/Vue/Svelte — vanilla TypeScript with DOM manipulation
- xterm.js v5 (`@xterm/xterm`)

### Rust (Backend)

- Edition 2021
- Async everywhere (tokio runtime)
- `russh` for SSH, `serde_yml` for YAML (NOT `serde_yaml` — it's deprecated)
- `dirs` crate for platform-appropriate data paths
- Tauri v2 command handlers are `async fn` with `#[tauri::command]`
- Error handling: return `Result<T, String>` from Tauri commands

### CSS

- CSS custom properties for all colors (defined in `:root` in `src/styles/tokens.css`)
- 4px spacing grid (`var(--spacing)`)
- Dark theme is primary — tokens in `tokens.css`, component styles in `src/styles/components/`
- JetBrains Mono for terminal and code; Inter for UI text (via `@fontsource`)

## Knowledge Base

- YAML files in `knowledge-base/<platform>/commands/<category>.yaml`
- Schema defined in `docs/06-knowledge-base.md`
- Each platform is self-contained — duplication across platforms is intentional

## What NOT To Do

- No LLM in the suggestion/keystroke path — LLM is used ONLY for KB import (`import.rs`); latency-critical paths stay deterministic
- No `serde_yaml` — use `serde_yml`
- No sidebar overlay on terminal
- No `Ctrl+W` interception — must pass through to remote
- No local echo — shadow buffer observes only
- No heavy logic in Rust that could be in frontend (latency concern)

## File Locations

```
src/                    # TypeScript frontend
  components/           # Screens & UI (host-screen, terminal-view, kb-screen,
                        #   command-palette, kb-import-dialog, kb-viewer-dialog)
  lib/                  # Utilities (tauri-api, suggestion-engine, shadow-buffer,
                        #   prompt-detector, ghost-text, dropdown, ansi, format,
                        #   platforms, logger, sidebar-content)
  styles/
    tokens.css          # Design tokens (:root custom properties)
    base.css            # Base/reset styles
    main.css            # Global styles
    components/         # Per-component stylesheets (_buttons, _dialogs, etc.)
  main.ts               # Entry point, view switching (connections | terminal | knowledge-base)

src-tauri/              # Rust backend
  src/
    lib.rs              # Tauri command handlers
    ssh.rs              # SSH session (russh)
    hosts.rs            # Host storage + keyring credentials
    kb.rs               # Knowledge base queries
    import.rs           # KB import pipeline
    llm.rs              # LLM client (OpenAI-compatible / Anthropic formats, KB import only)
    config.rs           # App settings
    test_server.rs      # Mock SSH server for testing
  Cargo.toml            # Rust dependencies
  tauri.conf.json       # Tauri configuration

docs/                   # Full specification documents (+ implementation plans)

knowledge-base/         # YAML knowledge bases per platform
  cisco-iosxe/          # commands/<category>.yaml (populated)
  cisco-nxos/
  f5-tmos/
  linux-bash/
```

## Session Behavior

- When resuming a subagent task, pass its `task_id` to the Task tool to continue that session
- Always store `task_id` from task outputs for potential continuation
- For multi-turn work with the same subagent, reuse `task_id` instead of starting fresh

## Verification Requirements

Before marking a task complete:
- Frontend changes: `npm run build` (runs `tsc`) — must exit 0
- Rust changes: `cargo check` (or `cargo build`) in `src-tauri/` — must exit 0
- Agent results must be verified against expected outcomes