# net.sh — Overview & Goals

**Version:** 0.1 (draft) **Status:** In progress **Author:** Andy Norwood (architect) **Last updated:** 2026-03-03


---

## Overview

**net.sh** is a cross-platform desktop SSH client with context-aware, platform-intelligent command suggestions. It targets network engineers who work across multiple device types and OS dialects daily.

Unlike generic SSH clients, net.sh understands *what you're connected to* and surfaces relevant commands inline — from a structured, version-aware knowledge base. AI-assisted suggestions are a planned future enhancement; the MVP relies entirely on curated structured data.


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
* Multi-tab / multi-session (post-MVP)
* Mobile support (out of scope)
* Built-in file transfer (out of scope for now)


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
