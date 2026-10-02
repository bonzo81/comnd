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
| Goals, scope, target platforms | `docs/specs/01-overview-goals.md` |
| SSH, keystroke flow, prompt detection | `docs/specs/02-technical-architecture.md` |
| UI layout, colors, typography, components | `docs/specs/03-ui-visual-design.md` |
| Host list, empty state, forms | `docs/specs/04-connection-manager.md` |
| Ghost text, dropdown, mode detection | `docs/specs/05-suggestion-engine.md` |
| YAML schema, version filtering, matching | `docs/specs/06-knowledge-base.md` |
| Shortcuts, keyboard-first design | `docs/specs/07-keyboard-shortcuts.md` |
| Post-MVP backlog, decision log | `docs/specs/08-future-open-questions.md` |
| Command Replay (user-saved commands, variables, playback) | `docs/specs/09-command-replay.md` |
| Custom KB (user-wins merge, provenance, import) | `docs/specs/10-custom-knowledge-base.md` |
| Shortcut customization (Planned) | `docs/specs/11-shortcut-customization.md` |
| Reading Comfort mode (dyslexia) | `docs/specs/12-dyslexia-mode.md` |
| Accessibility conformance target (WCAG 2.1 AA) | `docs/accessibility.md` |

Implementation plans live in `docs/plans/`. Read the plan document for a feature before you build it.

## Non-Negotiable Architecture Rules

1. **Shadow buffer model** — No local echo; keystrokes reach the remote in real time, and the frontend keeps an observe-only shadow buffer. See ADR-001.

2. **Input handling in frontend** — Keystrokes are handled in the xterm.js handler; never routed through Rust. See ADR-002.

3. **Prompt detection** — State machine in frontend: ANSI strip → idle detection (200ms) → regex match against platform `prompt_patterns`. This powers mode awareness and shadow buffer reset.

4. **Sidebar pushes terminal** — The side panel resizes (never overlays) the terminal; PTY resize on open/close. See ADR-003.

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
- Tokens only — no raw px font sizes, colors, or shadows in component CSS; use `--font-size-*`, `--color-*`, `--shadow-*`, `--radius-*`
- One input class: `.form-input` (+ `.form-input-sm` size modifier). Do not hand-roll new input/select styles; compose with layout-only classes
- No `var()` fallbacks for tokens — tokens are always defined
- No inline `style="..."` in TS markup except dynamic values (positions, indents); everything else gets a class
- 4px spacing grid (`var(--spacing)`)
- Multiple app themes (dark, light, solarized) — tokens in `tokens.css`, component styles in `src/styles/components/`
- JetBrains Mono for terminal and code; Inter for UI text (via `@fontsource`)

## Knowledge Base

- YAML files in `knowledge-base/<platform>/commands/<category>.yaml`
- Schema defined in `docs/specs/06-knowledge-base.md`
- Each platform is self-contained, because platforms name commands differently. Duplication across platforms is intentional.

## What NOT To Do

- No LLM in the suggestion/keystroke path; LLM only for KB import (`import.rs`). See ADR-004.
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
                        #   replay-screen, nav-panel, global-search,
                        #   kb-import-dialog, kb-viewer-dialog,
                        #   netbox-configure-dialog, replay-save-dialog)
  lib/                  # Utilities (one concern per file: suggestion-engine,
                        #   suggestion-controller, dropdown, shadow-buffer, line-tracker,
                        #   ghost-text, ansi, tokens, theme, a11y, platforms, replay,
                        #   tauri-api, modal, logger, toast, reading-comfort,
                        #   output-highlighter, ...)
  styles/
    tokens.css          # Design tokens (:root custom properties)
    base.css            # Base/reset styles
    main.css            # Global styles
    components/         # Per-component stylesheets (one _file per component)
  main.ts               # Entry point, view switching
                        #   (connections | terminal | knowledge-base | replay | settings)

src-tauri/              # Rust backend
  src/
    main.rs             # Binary entry point
    lib.rs              # Most Tauri command handlers
    state.rs            # Shared AppState (every handler locks its store here)
    ssh.rs              # SSH session (russh)
    hosts.rs            # Host storage
    credentials.rs      # Credential resolution + keyring helpers
    secrets/            # Secret providers (mod.rs + agent.rs for SSH agent;
                        #   providers/mod.rs + providers/proton.rs for Proton Pass)
    kb/                 # Knowledge base (mod.rs + schema, validate, store,
                        #   user_files, commands, test_util modules)
    import.rs           # KB import pipeline
    llm.rs              # LLM client (KB import only)
    netbox.rs           # NetBox host source
    platform.rs         # Platform registry (auto-discovers <platform>/index.yaml)
    config.rs           # App settings
    replay.rs           # Command Replay storage + its own command handlers
    session_log.rs      # Session logging
    transcript.rs       # Terminal output seam: session log + ssh-output fan-out
    paths/              # Data/log directory resolution (mod + commands)
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
- Frontend unit tests are co-located with source as `*.test.ts` files in the same directory (e.g., `src/lib/suggestion-engine.test.ts` tests `src/lib/suggestion-engine.ts`). Do not create a separate `tests/` directory for unit tests — the top-level `tests/` holds harness-based integration tests.
- Rust changes: run `cargo check --all-targets` in `src-tauri/`. It must exit 0.
- Make sure that agent results match the expected outcomes.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues (`bonzo81/netssh`) via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

Reviewed: 2026-10-02