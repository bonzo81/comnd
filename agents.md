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
| Accessibility conformance target (WCAG 2.1 AA) | `docs/accessibility.md` |

Implementation plans live in `docs/plan-*.md` and `docs/*-plan-*.md`. The roadmap is `docs/roadmap.md`. Read the plan document for a feature before you build it.

## Non-Negotiable Architecture Rules

1. **Shadow buffer model** — No local echo. All keystrokes go to the remote device in real time. The frontend maintains a shadow buffer that *observes* input for suggestion matching only.

2. **Input handling in frontend** — Keystrokes are handled in the xterm.js `onKey` handler. KB queries go async to Rust via Tauri IPC. Never route keystrokes through Rust, because IPC latency is perceptible.

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
- `russh` for SSH, `serde_yml` for YAML (NOT `serde_yaml` — it is deprecated)
- `dirs` crate for platform-appropriate data paths
- Tauri v2 command handlers are `async fn` with `#[tauri::command]`
- Error handling: return `Result<T, String>` from Tauri commands

### CSS

- CSS custom properties for all colors (defined in `:root` in `src/styles/tokens.css`)
- 4px spacing grid (`var(--spacing)`)
- Multiple app themes (dark, light, solarized) — tokens in `tokens.css`, component styles in `src/styles/components/`
- JetBrains Mono for terminal and code; Inter for UI text (via `@fontsource`)

## Knowledge Base

- YAML files in `knowledge-base/<platform>/commands/<category>.yaml`
- Schema defined in `docs/06-knowledge-base.md`
- Each platform is self-contained, because platforms name commands differently. Duplication across platforms is intentional.

## What NOT To Do

- No LLM in the suggestion/keystroke path. The LLM is used ONLY for KB import (`import.rs`), because latency-critical paths must stay deterministic.
- No `serde_yaml` — use `serde_yml`
- No sidebar overlay on terminal
- No `Ctrl+W` interception — must pass through to remote
- No local echo — shadow buffer observes only
- No heavy logic in Rust that could run in the frontend. IPC latency harms the terminal.

## File Locations

```
src/                    # TypeScript frontend (strict mode, ES modules)
  components/           # Screens & UI (one class per screen: host-screen,
                        #   terminal-view, kb-screen, settings-screen,
                        #   replay-screen, nav-panel, global-search, dialogs)
  lib/                  # Utilities (one concern per file: suggestion-engine,
                        #   shadow-buffer, prompt-detector, ghost-text, tokens,
                        #   theme, a11y, replay, tauri-api, ...)
  styles/
    tokens.css          # Design tokens (:root custom properties)
    base.css            # Base/reset styles
    main.css            # Global styles
    components/         # Per-component stylesheets (one _file per component)
  main.ts               # Entry point, view switching
                        #   (connections | terminal | knowledge-base | replay | settings)

src-tauri/              # Rust backend
  src/
    lib.rs              # Most Tauri command handlers
    ssh.rs              # SSH session (russh)
    hosts.rs            # Host storage
    credentials.rs      # Credential resolution + keyring helpers
    secrets/            # Secret providers (e.g. Proton Pass)
    kb.rs               # Knowledge base queries
    import.rs           # KB import pipeline
    llm.rs              # LLM client (KB import only)
    netbox.rs           # NetBox host source
    config.rs           # App settings
    replay.rs           # Command Replay storage + its own command handlers
    session_log.rs      # Session logging
    paths.rs            # Data/log directory resolution
    test_server.rs      # Mock SSH server for testing
  Cargo.toml            # Rust dependencies
  tauri.conf.json       # Tauri configuration

docs/                   # Specification documents, implementation plans, roadmap

knowledge-base/         # YAML knowledge bases per platform
  cisco-iosxe/          # index.yaml + commands/<category>.yaml
  cisco-nxos/           # same layout
  f5-tmos/              # same layout
  linux-bash/           # same layout
```

## Verification Requirements

Before marking a task complete:
- Frontend changes: run `npm run build`. It runs `tsc`. The command must exit 0.
- Frontend logic with test files: run `npm run test` (vitest). It must exit 0.
- Rust changes: run `cargo check` in `src-tauri/`. It must exit 0.
- Make sure that agent results match the expected outcomes.