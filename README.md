# netssh — Smart SSH Client for Network Engineers

netssh is a desktop SSH client that shows you relevant commands as you type, based on what device you're connected to.

Instead of memorizing commands for different network devices, netssh suggests the right commands inline — like a smart autocomplete that understands networking equipment.

## Why netssh?

Network engineers typically work with multiple device types daily (Cisco routers, F5 load balancers, Linux servers, etc.). Each has its own command syntax and modes.

**netssh solves this by:**
- Automatically detecting what device you're connected to
- Showing relevant commands as you type (ghost text suggestions)
- Adapting suggestions based on the device's operating mode
- Supporting version-aware commands (commands change between software versions)

## Supported Devices

netssh includes built-in command knowledge for:
- **Linux / bash** — Standard Linux shell commands
- **Cisco IOS-XE** — Cisco enterprise routers and switches
- **Cisco NX-OS** — Cisco Nexus data center switches
- **F5 BIG-IP TMOS** — F5 load balancer operating system

## How It Works

1. **Connect** — Use the sidebar to manage your SSH connections
2. **Type** — Start typing commands in the terminal
3. **See suggestions** — Relevant commands appear as ghost text (like IDE autocomplete)
4. **Accept** — Press Tab to accept a suggestion, or keep typing

The suggestion engine runs locally on your machine — no cloud dependencies or AI models.

## Technology

netssh is built as a cross-platform desktop application:
- **Rust backend** — Handles SSH connections and command knowledge base
- **TypeScript frontend** — Terminal emulator and user interface
- **YAML knowledge base** — Human-readable command definitions per device type

Runs on Windows, macOS, and Linux.

## Documentation

For detailed specifications and implementation plans:
- [Overview & Goals](docs/01-overview-goals.md) — What netssh aims to achieve
- [Technical Architecture](docs/02-technical-architecture.md) — How SSH connections and suggestions work
- [Knowledge Base](docs/06-knowledge-base.md) — Command definition format and structure
- [Implementation Plan](implementation/README.md) — Development stages and progress

## Current Status

🟡 **Specification complete** — Development has not yet begun.

## License

TBD
