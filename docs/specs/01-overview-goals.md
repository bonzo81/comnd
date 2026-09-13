# netssh — Overview & Goals

**Version:** 0.1 (draft) **Status:** In progress **Author:** Andy Norwood (architect) **Last updated:** 2026-03-03


---

## Overview

**netssh** is a cross-platform desktop SSH client with context-aware, platform-intelligent command suggestions. It targets network engineers who work across multiple device types and OS dialects daily.

Unlike generic SSH clients, netssh understands *what you're connected to* and surfaces relevant commands inline — from a structured, version-aware knowledge base. AI-assisted suggestions are a planned future enhancement; the MVP relies entirely on curated structured data.


---

## Goals

* Reduce time spent looking up syntax across platforms
* Work seamlessly across Linux, macOS, and Windows
* Be fast, offline-capable, and predictable (no AI dependency in MVP)
* Be extensible — new platforms and OS versions added without app changes
* Feel like a proper native desktop app, not a web tool


---

## Non-Goals (MVP)

* AI/LLM-powered suggestions (post-MVP)
* Auto-detection of platform from SSH banner (post-MVP)
* Mobile support (out of scope)
* Built-in file transfer (out of scope for now)


### Two Command Stores

netssh distinguishes two sources of commands surfaced into the terminal:

- **Knowledge Base** — curated, app-authored reference of valid syntax per platform. Shipped with install, read-only, used for ghost text suggestions. *Teaches.*
- **Command Replay** — the user's own saved commands, captured from the terminal or entered manually, with named variables and platform assignment. Played back into the terminal via the side panel. Empty until the user fills it. *Remembers.*

See `docs/specs/09-command-replay.md`.


---

## Target Platforms (App)

| OS  | Distribution format |
|-----|---------------------|
| Windows | `.msi` installer    |
| macOS | `.dmg` / `.app` bundle |
| Linux | `.AppImage` / `.deb` / `.rpm` |

Built with **Tauri v2** (Rust backend + web frontend). Uses the OS native webview — no bundled browser. Small binary, native feel.


---

## Target Device Platforms (Knowledge Base)

| Platform ID | Description | Notes |
|-------------|-------------|-------|
| `linux-bash` | Linux / Unix bash shell | General bash, common distros |
| `cisco-iosxe` | Cisco IOS-XE | Routers, Cat switches, ASR, ISR |
| `cisco-nxos` | Cisco NX-OS | Nexus data centre switches |
| `f5-tmos`   | F5 BIG-IP TMOS / tmsh | Load balancers, application delivery |

Additional platforms added post-MVP (Junos, Palo Alto PAN-OS, Aruba, etc.)


---

## Security Considerations

* Credentials stored in OS keychain (not in app config files)
* SSH private keys referenced by path — never copied or stored by the app
* No telemetry, no cloud sync in MVP
* KB updates verified by checksum before applying
