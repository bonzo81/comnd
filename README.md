# Comnd

Comnd ("command") is a multi-platform desktop SSH client for network engineers.

- **Knowledge base**: commands for Linux bash, Cisco IOS-XE, Cisco NX-OS and F5 TMOS, with syntax, parameters and examples. Shipped with the app and yours to extend.
- **Command suggestions**: ghost text as you type and a dropdown of every match, based on the device platform, CLI mode and software version.
- **Command Replay**: save the commands you run often, with named variables, and send them again from the side panel.
- **Terminal and sessions**: a normal SSH terminal with tabs, coloured output, session logs and a side panel.
- **Hosts and credentials**: hosts synced from NetBox, and secrets that stay in your keychain, SSH agent or Proton Pass.

![Comnd terminal with `ip ` typed at the prompt: the ghost-text completion `addr` follows the cursor, and the side panel shows the syntax for `ip`](docs/images/readme-terminal-suggestions.png)

[**Download Comnd**](https://github.com/bonzo81/comnd/releases/latest) · [Installation](docs/user-guide/01-installation.md) · [Documentation](#documentation) · [Contribute](CONTRIBUTING.md)

> **Development status:** Comnd is pre-1.0 and still in development.
>
> - Features may change, and it is not ready for production use.
> - Builds are unsigned, so Windows or macOS may show first-launch security warnings.
> - Review suggestions before you use them on important systems.

## Features

### Knowledge base

The command data ships with the app, and it is yours to extend.

- Browse and search built-in commands for every device platform listed under [Supported platforms](#supported-platforms).
- Add your own commands in YAML, or import them from vendor documentation with an LLM that you configure.
- Edit or disable entries without touching the built-in data.
- No AI service is used for suggestions. Your commands stay local.

### Command suggestions

Comnd show you suggestion baed on the host OS while you type.

- Matches on platform, CLI mode (`enable`/`config` on Cisco, `tmsh`/bash on F5) and software version.
- Ghost text completes inline as you type. Press **Tab** to accept it.
- **Ctrl+Space** opens a dropdown of every match.
- The side panel shows the full syntax, parameters and examples for the highlighted command.

### Command Replay

Save the commands you use often, or the long ones with too many flags to retype.

- Save a command from the terminal or type it in, then mark the parts that change as named variables.
- Play it back from the side panel. Playing inserts the command without running it, so you can check it before pressing Enter.

### Terminal and sessions

Enhance the terminal as you want it.

- Timestamp the terminal 
- Command suggestion on/off.
- Multiple sessions.
- Output highlighting recolours IP addresses, interface names and status keywords. 
- Session logging, with timestamps.
- Fully keyboard-driven
-  **Reading Comfort** preset for dyslexic readers.

### NetBox hosts

Don't duplicate your hosts. Sync from your source of truth.

- Use NetBox as the source of your host list and connect without re-entering anything.
- The integration is read-only.

### Integrations

Don't duplicate your secrets. Sync from your password managers

- Assign a secret from you password manager to a host. No password is copied into the app.
- Currently supports ProtonPass (protonpass cli)
- Or keep credentials in your operating system keychain, an SSH agent 
## Screenshots

| Connection manager | Command Replay |
|---|---|
| ![Host list with folders and recent sessions](docs/images/readme-connections.png) | ![Saved commands across three platforms, one containing a variable](docs/images/readme-replay.png) |

## Supported platforms

### Run Comnd on

| Operating system | Package |
|---|---|
| **Windows** | NSIS installer (`-setup.exe`) |
| **macOS** | `.dmg` / `.app` bundle |
| **Linux** | `.AppImage`, `.deb`, `.rpm` |

See the [installation guide](docs/user-guide/01-installation.md) for requirements and steps.

### Connect to (command suggestions)

| Device platform | Typical devices |
|---|---|
| **Linux / bash** | Servers, VMs, Raspberry Pi, containers |
| **Cisco IOS-XE** | Routers, Catalyst switches, ASR, ISR |
| **Cisco NX-OS** | Nexus switches (3K/5K/7K/9K) |
| **F5 BIG-IP TMOS** | BIG-IP appliances and virtual editions |

Suggestions are available for the platforms above.

## Get started

1. [Download the latest release](https://github.com/bonzo81/comnd/releases/latest) and follow the [installation guide](docs/user-guide/01-installation.md).
2. [Add your first host](docs/user-guide/02-getting-started.md). Enter the hostname and a username, then choose the platform — this field decides which commands you are offered.
3. Start typing. Press **Tab** to accept a suggestion, or keep typing to send your own command. [Terminal and Suggestions](docs/user-guide/04-terminal-and-suggestions.md) explains the matching rules.

## Documentation

| I want to… | Read |
|---|---|
| Install the app and connect to a device | [Install Comnd](docs/user-guide/01-installation.md) · [Getting Started](docs/user-guide/02-getting-started.md) · [Connecting to Devices](docs/user-guide/03-connecting-to-devices.md) |
| Use the terminal and the suggestion system | [Terminal and Suggestions](docs/user-guide/04-terminal-and-suggestions.md) · [Side Panel](docs/user-guide/05-side-panel.md) |
| Learn the keyboard shortcuts | [Keyboard Shortcuts](docs/user-guide/07-keyboard-shortcuts.md) · rebinding is in [Settings](docs/user-guide/08-settings.md) |
| Reuse saved commands | [Command Replay](docs/specs/09-command-replay.md) |
| Understand the knowledge base | [Knowledge Base Overview](docs/user-guide/06-knowledge-base-overview.md) · [Customizing the Knowledge Base](docs/user-guide/11-customizing-knowledge-base.md) · [schema and import](docs/specs/06-knowledge-base.md) · [custom KB design](docs/specs/10-custom-knowledge-base.md) |
| Check how credentials are stored | [Security](docs/user-guide/09-security.md) |
| Fix a problem | [Troubleshooting](docs/user-guide/10-troubleshooting.md) |
| See what is planned next | [Future and open questions](docs/specs/08-future-open-questions.md) |
| Build from source or run the test suites | [Development Setup](docs/DEVELOPMENT.md) · [manual test matrix](docs/testing/manual-matrix.md) |
| Contribute commands or code | [Contributing](CONTRIBUTING.md) |
| Understand the design | [Overview and goals](docs/specs/01-overview-goals.md) · [architecture](docs/specs/02-technical-architecture.md) · [decision records](docs/adr/) |
| Work on the code with an AI agent | [AGENTS.md](AGENTS.md) · [CONTEXT.md](CONTEXT.md) |

## Development

Comnd is written in Rust and TypeScript, built with Tauri v2, and renders the terminal with xterm.js. [Development Setup](docs/DEVELOPMENT.md) covers the prerequisites for each platform, the `cargo tauri dev` workflow, and the project layout.

## License

[MIT](LICENSE) — Copyright (c) 2026 Andy Norwood.
