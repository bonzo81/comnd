# Comnd

### SSH command suggestions for network engineers

Comnd (pronounced “command”) is a desktop SSH client that suggests relevant commands as you type, based on the device you're connected to and its current mode. Suggestions run locally and work without a cloud service.

[Download Comnd](https://github.com/bonzo81/comnd/releases/latest) · [Get started](docs/user-guide/02-getting-started.md) · [Supported devices](#supported-devices) · [Contribute](CONTRIBUTING.md)

> **Development status:** Comnd is an early-stage app (pre-1.0) that is still being developed. Public releases are available to try, but features may change; it is not ready for production use. Builds are unsigned, so Windows or macOS may show first-launch security warnings. Review suggestions before using them on important systems.

## What it does

- Built-in Command Knowledge Base for Cisco, Juniper, F5 and linux
- Integrate with NetBox; pull host list from NetBox and connect
- Suggests commands for the device you're connected to.
- No AI calls, built in privacy.
- Integrate with password and secret managers; associate records with hosts. No duplicate credential storage
- Adapts to the device's operating mode (enable/config, bash/tmsh) and software version.
- Sends your keystrokes directly to the remote device; suggestions never replace or delay your input.
- In line terminal timestamp
- Session Logging
- Syntax Highlighting

## Supported devices

Comnd runs on Windows, macOS, and Linux. Its built-in command knowledge covers:

- Linux / bash
- Cisco IOS-XE
- Cisco NX-OS
- F5 BIG-IP TMOS

## Get started

1. [Download the latest release](https://github.com/bonzo81/comnd/releases/latest) for your computer.
2. Follow the [installation guide](docs/user-guide/01-installation.md), then add an SSH connection.
3. Start typing in the terminal. Press **Tab** to accept a suggestion, or keep typing to send your own command.

## Learn more

- [Getting started](docs/user-guide/02-getting-started.md)
- [Knowledge base and command format](docs/specs/06-knowledge-base.md)
- [Development setup](docs/DEVELOPMENT.md)
- [Contributing](CONTRIBUTING.md)

Comnd is built with Rust, TypeScript, Tauri, and xterm.js.

## License

[MIT](LICENSE) — Copyright (c) 2026 Andy Norwood.
