# Comnd — Smart SSH Client for Network Engineers

Comnd is a desktop SSH client that shows you relevant commands as you type, based on what device you're connected to.

Instead of memorizing commands for different network devices, Comnd suggests the right commands inline — like a smart autocomplete that understands networking equipment.

## Why Comnd?

Network engineers typically work with multiple device types daily (Cisco routers, F5 load balancers, Linux servers, etc.). Each has its own command syntax and modes.

**Comnd solves this by:**
- Automatically detecting what device you're connected to
- Showing relevant commands as you type (ghost text suggestions)
- Adapting suggestions based on the device's operating mode
- Supporting version-aware commands (commands change between software versions)

## Supported Devices

Comnd includes built-in command knowledge for:
- **Linux / bash** — Standard Linux shell commands
- **Cisco IOS-XE** — Cisco enterprise routers and switches
- **Cisco NX-OS** — Cisco Nexus data center switches
- **F5 BIG-IP TMOS** — F5 load balancer operating system

## How It Works

1. **Connect** — Use the sidebar to manage your SSH connections
2. **Type** — Start typing commands in the terminal
3. **See suggestions** — Relevant commands appear as ghost text (like IDE autocomplete)
4. **Accept** — Press Tab to accept a suggestion, or keep typing

The suggestion engine runs locally on your machine — no cloud or network dependency. Suggestions are matched against a per-device command knowledge base and never leave your computer.

## Getting Started

Prebuilt binaries for Windows, macOS, and Linux are published as [GitHub Releases](https://github.com/bonzo81/comnd/releases). Download the latest release for your platform. The [installation guide](docs/user-guide/01-installation.md) has per-platform steps.

> **Note:** Builds are currently **unsigned drafts** — expect SmartScreen (Windows) or Gatekeeper (macOS) warnings on first launch. See [CI/CD install notes](docs/plans/plan-ci-cd.md) for how to proceed safely.

Want to build from source instead? See [Development setup](docs/DEVELOPMENT.md).

Once you're up and running, the [user guide](docs/user-guide/02-getting-started.md) walks you through your first session.

## Technology

Comnd is built as a cross-platform desktop application:
- **Rust backend** — Handles SSH connections and command knowledge base
- **TypeScript frontend** — Terminal emulator and user interface
- **YAML knowledge base** — Human-readable command definitions per device type

Targets Windows, macOS, and Linux.

## Documentation

For detailed specifications and implementation plans:
- [Overview & Goals](docs/specs/01-overview-goals.md) — What Comnd aims to achieve
- [Technical Architecture](docs/specs/02-technical-architecture.md) — How SSH connections and suggestions work
- [Knowledge Base](docs/specs/06-knowledge-base.md) — Command definition format and structure

To contribute — for example, by adding commands to the knowledge base — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

TBD
