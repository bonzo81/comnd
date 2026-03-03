# Copilot Instructions — net.sh

## Project Overview

net.sh is a cross-platform desktop SSH client with context-aware command suggestions, built for network engineers. It targets Linux, macOS, and Windows.

**Tech stack:** Tauri v2 (Rust backend) + TypeScript/Vite frontend + xterm.js terminal

## Architecture — Read Before Coding

Full spec docs are in `docs/01` through `docs/08`. Read the relevant doc before implementing any feature:

| Area | Doc |
|---|---|
| Goals, scope, target platforms | `docs/01-overview-goals.md` |
| SSH, keystroke flow, prompt detection | `docs/02-technical-architecture.md` |
| UI layout, colours, typography, components | `docs/03-ui-visual-design.md` |
| Host list, empty state, forms | `docs/04-connection-manager.md` |
| Ghost text, dropdown, mode detection | `docs/05-suggestion-engine.md` |
| YAML schema, version filtering, matching | `docs/06-knowledge-base.md` |
| Shortcuts, keyboard-first design | `docs/07-keyboard-shortcuts.md` |
| Post-MVP backlog, decision log | `docs/08-future-open-questions.md` |

## Key Architecture Decisions

These are non-negotiable. Don't deviate without discussion.

1. **Shadow buffer model** — the app does NOT do local echo. All keystrokes go to the remote device in real time. The frontend maintains a shadow buffer that *observes* input for suggestion matching only. The remote handles echo.

2. **Input handling in frontend (JS/TS)** — keystrokes are handled in the xterm.js `onKey` handler. KB queries go async to Rust via Tauri IPC. Do NOT route keystrokes through Rust — the IPC round-trip adds perceptible latency.

3. **Prompt detection** — a state machine in the frontend: ANSI strip → idle detection (200ms) → regex match against platform prompt_patterns. This powers mode awareness and shadow buffer reset.

4. **Sidebar pushes terminal** — the side panel resizes the terminal, it does NOT overlay it. Terminal gets a PTY resize when sidebar opens/closes.

5. **Tab is context-sensitive** — accepts ghost suggestion when one is showing; passes through to remote device when no suggestion is visible. Never intercept Tab unconditionally.

6. **Keyboard-first** — the entire app must be navigable without a mouse. See `docs/07-keyboard-shortcuts.md` for the full shortcut table. `Ctrl+W` must pass through to remote (it's delete-word in shells).

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
- CSS custom properties for all colours (defined in `:root`)
- 4px spacing grid (`var(--spacing)`)
- Dark theme is primary — all colours in `src/styles/main.css`
- JetBrains Mono for terminal and code; system font stack for UI text

## Knowledge Base

- YAML files in `knowledge-base/<platform>/commands/<category>.yaml`
- Schema defined in `docs/06-knowledge-base.md` — follow it exactly
- Each platform is self-contained — duplication across platforms is intentional
- See `CONTRIBUTING.md` for the command entry format

## What NOT To Do

- Don't add AI/LLM features — that's post-MVP
- Don't implement multi-tab/multi-session — post-MVP
- Don't use `serde_yaml` — use `serde_yml`
- Don't overlay the sidebar on the terminal
- Don't use `Ctrl+W` for anything — it must pass through to remote
- Don't add local echo — shadow buffer observes only
- Don't put heavy logic in Rust that could be in the frontend (latency)
- Don't guess at the spec — read the relevant doc in `docs/`
