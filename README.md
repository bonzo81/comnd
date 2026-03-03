# net.sh

A cross-platform desktop SSH client with context-aware, platform-intelligent command suggestions.

Built for network engineers who work across multiple device types and OS dialects daily.

## What is this?

Unlike generic SSH clients, net.sh understands *what you're connected to* and surfaces relevant commands inline — from a structured, version-aware knowledge base.

## Target Platforms

**App:** Windows, macOS, Linux (built with Tauri v2)

**Device Knowledge Base:**
- Linux / bash
- Cisco IOS-XE
- Cisco NX-OS
- F5 BIG-IP TMOS

## Tech Stack

- **Backend:** Rust (Tauri v2, russh)
- **Frontend:** Web (xterm.js, TypeScript)
- **Knowledge Base:** YAML (self-contained per platform)

## Documentation

Full specification in [`docs/`](docs/):

1. [Overview & Goals](docs/01-overview-goals.md)
2. [Technical Architecture](docs/02-technical-architecture.md)
3. [UI & Visual Design](docs/03-ui-visual-design.md)
4. [Connection Manager](docs/04-connection-manager.md)
5. [Suggestion Engine](docs/05-suggestion-engine.md)
6. [Knowledge Base](docs/06-knowledge-base.md)
7. [Keyboard & Shortcuts](docs/07-keyboard-shortcuts.md)
8. [Future & Open Questions](docs/08-future-open-questions.md)

## Status

🟡 **Specification complete** — development not yet started.

## License

TBD
