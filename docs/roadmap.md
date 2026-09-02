# Roadmap

Status: ✅ Done · 🟡 Partial · ⬜ Not started
Living document — update as work lands. Check off items and note the PR/plan doc that delivered them.

Legend for phase ordering: features listed top-down within each phase are roughly in priority order. Phases build on each other — later phases depend on earlier ones.

---

## Phase 0 — Foundation (shipped)

| Feature | Status | Notes |
|---|---|---|
| SSH session to a single device, rendered in-app | ✅ | `ssh.rs` (russh), `terminal-view.ts` (xterm.js + WebGL) |
| Saved device list (manual entry) | ✅ | `hosts.rs` (HostStore + HostGroupStore), `host-screen.ts`, `nav-panel.ts` tree |

Core differentiators also shipped: KB suggestions (ghost text, dropdown), prompt detection, shadow buffer, per-platform highlighting, global search, NetBox host source, session tabs.

---

## Phase 1 — Session management (fill the gaps)

The highest-value unshipped features. Logging is the prerequisite for the stretch agent layer.

| Feature | Status | Notes |
|---|---|---|
| Per-session logging to file, timestamped | ✅ | Shipped — raw I/O captured in Rust at the SSH stream (`session_log.rs`), per-session files under `<data_dir>/session-logs/`, optional `[HH:MM:SS]` stamps. Settings toggles + "Open log folder" in General → Session Logging. Enables audit + future agent layer. Backlog: docs/08 |
| Auto-reconnect on drop | 🟡 | Manual reconnect banner exists (`terminal-view.ts`). Add retry loop w/ backoff + cap |
| Scrollback search | ⬜ | Add `@xterm/addon-search`; wire Ctrl+Shift+F, keyboard-first |
| Multiple tabs/panes | 🟡 | Tabs done (`tab-state.ts`). Split panes not started — decide if tabs suffice (YAGNI candidate) |

---

## Phase 2 — Output usability (polish)

| Feature | Status | Notes |
|---|---|---|
| Vendor-aware keyword highlighting | ✅ | `output-highlighter.ts`, `highlight-rules.ts` per platform. Add schemes for new platforms (EOS, JunOS, PAN-OS) as KBs land |
| True color / ANSI rendering | ✅ | xterm WebGL renderer passes 24-bit color through |

Mostly done. New vendor schemes ride along with new platform KBs.

---

## Phase 3 — Bulk operations

| Feature | Status | Notes |
|---|---|---|
| Command snippets / button bar (per-vendor) | 🟡 | Sidebar has clickable examples (`sidebar-content.ts`). Build a persistent snippet store + UI |
| Broadcast typed input to multiple sessions | ⬜ | Needs care: Tab accepts ghost text, Ctrl+W passes through — broadcast must respect per-session keystroke rules |
| Basic scripting hook (saved command sequence per session) | ⬜ | Reuse snippet store; sequence = ordered snippets + delays. Needs session logging (Phase 1) for safety/audit |

---

## Phase 4 — Access and auth

| Feature | Status | Notes |
|---|---|---|
| SSH key management | 🟡 | Key auth works (`ssh.rs`); no gen/browse/manage UI. `secrets/` provider framework exists (incl. Proton) |
| Jump host / bastion proxying | ⬜ | Backlog docs/08. russh supports ProxyJump-style channels |
| Serial/console support | ⬜ | New transport layer alongside SSH. Rust side only (serialport crate); frontend unchanged. Never in original docs — needs a plan doc first |

---

## Phase 5 — Collaboration (later)

| Feature | Status | Notes |
|---|---|---|
| Shareable/exportable session lists | 🟡 | Full data export exists (`export_data`). Add host-list-only JSON export/import (subset) |
| Shareable highlight schemes | ⬜ | Rules currently built-in (`highlight-rules.ts`). Extract to files → importable |

---

## Phase 6 — Stretch (last, deliberately)

| Feature | Status | Notes |
|---|---|---|
| Agent layer: anomaly flagging / cross-device summaries from logs | ⬜ | Depends entirely on session logging (Phase 1). Ollama already integrated but KB-import-only by rule — keep inference out of keystroke path; run against logs offline. Backlog: docs/08 "AI suggestion layer" |

Only worth building once session logging is solid and logs accumulate real data.

---

## Maintenance notes

- NetBox platform field already flows through (`netbox.rs`, `__netbox__` group) — vendor behavior keys off it automatically as schemes/KBs are added.
- Session search/filter: done (groups, tags, `host-filters.ts`, global search).
- New platforms (EOS, JunOS, PAN-OS): add KB YAML + highlight rules; app picks up automatically.