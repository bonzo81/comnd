# netssh — Implementation Plan

Staged build plan for the netssh Tauri v2 SSH client. Each stage ends with a local test checkpoint (`cargo tauri dev`). Stages are ordered by dependency chain — later stages depend on earlier ones.

## Stages Overview

| # | Stage | Focus | Key Deliverable |
|---|-------|-------|-----------------|
| 01 | [Project Foundation](stage-01-project-foundation.md) | Build & dev loop | App launches, xterm.js renders |
| 02 | [KB Loader (Rust)](stage-02-kb-loader.md) | Backend | YAML → in-memory index, `query_kb` works |
| 03 | [IOS-XE Pilot KB](stage-03-iosxe-pilot-kb.md) | Content | Comprehensive IOS-XE command set |
| 04 | [Host Storage (Rust)](stage-04-host-storage.md) | Backend | JSON CRUD + OS keychain for credentials |
| 05 | [Connection Manager UI](stage-05-connection-manager-ui.md) | Frontend | Host list, forms, search, keyboard nav |
| 06 | [SSH Connection (Rust)](stage-06-ssh-connection.md) | Backend | `russh` lifecycle, auth, PTY, streaming |
| 07 | [Terminal ↔ SSH Integration](stage-07-terminal-ssh-integration.md) | Frontend + Backend | Live SSH session in xterm.js |
| 08 | [Prompt Detection & Shadow Buffer](stage-08-prompt-shadow-buffer.md) | Frontend | Mode detection, input observation |
| 09 | [Ghost Text Suggestions](stage-09-ghost-text.md) | Frontend | Inline suggestion overlay, Tab accept |
| 10 | [Dropdown & Side Panel](stage-10-dropdown-side-panel.md) | Frontend | Ctrl+Space dropdown, command detail panel |
| 11 | [Keyboard Shortcuts & Polish](stage-11-keyboard-shortcuts-polish.md) | Frontend | Full shortcut table, escape cascade, status bar |
| 12 | [Integration & Cross-Platform](stage-12-integration-cross-platform.md) | Full stack | End-to-end testing, builds for all platforms |

## Dependency Graph

```
Stage 01 (Foundation)
  ├── Stage 02 (KB Loader)
  │     └── Stage 03 (IOS-XE KB Content)
  ├── Stage 04 (Host Storage)
  │     └── Stage 05 (Connection Manager UI)
  └── Stage 06 (SSH Connection)
        └── Stage 07 (Terminal ↔ SSH)
              └── Stage 08 (Prompt + Shadow Buffer)
                    └── Stage 09 (Ghost Text)
                          └── Stage 10 (Dropdown + Side Panel)
                                └── Stage 11 (Shortcuts + Polish)
                                      └── Stage 12 (Integration)
```

Stages 02, 04, and 06 can be worked in parallel after Stage 01.  
Stages 03 and 05 can be worked in parallel.

## Spec Reference

All implementation must conform to `docs/01` through `docs/08`. When in doubt, the spec is authoritative.

## Testing Approach

Each stage has a **Verification** section with concrete test steps using real SSH devices (IOS-XE routers).
