# Future Features & Open Questions

## Post-MVP Backlog

| Feature | Notes |
|---------|-------|
| Host sidebar layout | Replace full-screen connection manager with a collapsible left sidebar showing hosts & search, always accessible alongside terminal tabs |
| Platform auto-detection | Parse SSH banner + prompt to suggest platform |
| Command history per host | Personalised suggestions based on past usage |
| AI suggestion layer | Optional LLM enhancement, user-enabled |
| KB community updates | Pull platform updates from a hosted registry |
| Jump host / bastion support | SSH proxy/jump configuration |
| Additional platforms | Junos, PAN-OS, Aruba AOS, EOS, etc. |
| Session recording | Audit log of commands run |
| Themes  | Light/dark/custom terminal themes |
| Plugin system | Third-party KB extensions |
| Host import/export | Share device lists across machines and teams |
| Connection groups | Collapsible groups by site, role, or custom tag |

## Open Questions


1. **KB update mechanism** — ship updates via GitHub releases? In-app updater? Separate from app updates?
2. **First KB content** — hand-crafted vs CrewAI-generated then reviewed by Andy?
3. **Quick Connect** — should MVP include a connection bar for ad-hoc `user@host` connections (without saving), or is that post-MVP?

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-03 | Tauri chosen as app framework | Native cross-platform, small binary, no bundled browser |
| 2026-03-03 | Self-contained platform KB files | Simpler structure, easier contribution, intentional duplication |
| 2026-03-03 | Descriptions inline in command YAML | Single source of truth per command, sidebar renders directly |
| 2026-03-03 | Sidebar hidden by default | Primary UX is inline suggestions; sidebar is on-demand detail |
| 2026-03-03 | Mode detection in MVP | Low effort, high value — filters suggestions to valid context |
| 2026-03-03 | Reference URL per platform (not per command) | One official docs link per platform, shown in sidebar footer |
| 2026-03-03 | Both ghost text + dropdown for suggestions | Ghost text for speed, Ctrl+Space dropdown for browsing — same as VS Code |
| 2026-03-03 | Tab is context-sensitive | Accepts ghost suggestion when one is showing; passes through to remote device when no suggestion visible |
| 2026-03-03 | Linux bash: single mode, no sub-mode detection | Bash prompts are user-configurable — reliable mode detection not feasible in MVP |
| 2026-03-03 | KB files grouped by functional category | Engineers think in categories (routing, switching, security), not command roots |
| 2026-03-03 | Shadow buffer model (not local echo) | Remote device handles all echo. Local shadow buffer observes input for suggestion matching only. Avoids double-echo and preserves remote editing/history. |
| 2026-03-03 | Input handling in frontend (JS), KB queries to Rust | Zero-latency keystroke handling. IPC round-trip for every keypress would add perceptible lag. |
| 2026-03-03 | Prompt detection via ANSI-strip + idle + regex | Raw SSH output requires state machine approach, not simple line parsing |
| 2026-03-03 | Major version matching only for MVP | Cross-platform version string formats are inconsistent. Major version is sufficient and avoids complexity. |
| 2026-03-03 | Keyboard-interactive auth supported | Many network devices use this instead of simple password auth. Essential for Cisco/F5. |
| 2026-03-03 | `Ctrl+Shift+W` for disconnect (not `Ctrl+W`) | `Ctrl+W` is delete-previous-word in most shells — must pass through to remote |
| 2026-03-03 | Tauri v2 (not v1) | v2 is current stable, different IPC system, better plugin API |
| 2026-03-03 | Dark-first theme, follow OS preference | Terminal apps are almost always dark. Match OS setting by default, allow override. |
| 2026-03-03 | JetBrains Mono as bundled terminal font | High-quality monospace, ligature support, user-configurable |
| 2026-03-03 | Status bar always visible in terminal view | Immediate context: host, platform, mode, connection state. Core to the value proposition. |
| 2026-03-03 | Side panel pushes terminal (not overlay) | Overlay would obscure terminal output — unacceptable for SSH work |
| 2026-03-03 | Sidebar examples are clickable (insert to terminal) | Reduces friction from "reading about a command" to "using it" |
| 2026-03-03 | Ghost text shows match count badge `(+N)` | Teaches dropdown feature organically without onboarding |
| 2026-03-03 | Keyboard-first design | Entire app navigable without mouse. Network engineers are keyboard-heavy users. |
| 2026-03-03 | Empty state with single CTA + tip | First-run experience must be frictionless. One button, one tip, no wizard. |
| 2026-03-03 | Platform icons in connection manager | Visual scanning is faster than reading text labels for device type |
| 2026-03-03 | Escape cascades: dropdown → panel → connection manager | Consistent "back out" behaviour across all contexts |
| 2026-08-24 | Suggestion dropdown auto-show is a persisted toggle (off by default) | Toolbar lightbulb button + `Ctrl+Space` flip the same state; ghost text stays always-on. Resolves the open "dropdown mode" question. |
| 2026-08-28 | Host sources use a generic `host_sources` config map (keyed by source id) | LibreNMS becomes a second instance (`librenms.rs`, own cache + keyring prefix), not a refactor |
| 2026-08-28 | NetBox sync caches to a separate `netbox-cache.json`; merge at read time | `hosts.json` stays a pure user-owned store; NetBox deletions propagate on next sync |
| 2026-08-28 | NetBox refresh is manual-only (button, no interval task) | Host list must never block on or poll a remote API; cache loads instantly from disk |
| 2026-08-28 | LibreNMS host source deferred (design hook only) | Same shape as NetBox (config map entry, `librenms-cache.json`, `comnd_source_librenms_*` keyring keys, own platform table); build after NetBox proves the pattern |
