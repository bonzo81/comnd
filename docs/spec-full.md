# net.sh — Product Specification

**Version:** 0.1 (draft)
**Status:** In progress
**Author:** Andy Norwood (architect)
**Last updated:** 2026-03-03 (session 4 — UX/UI review pass)

---

## Overview

**net.sh** is a cross-platform desktop SSH client with context-aware, platform-intelligent command suggestions. It targets network engineers who work across multiple device types and OS dialects daily.

Unlike generic SSH clients, net.sh understands *what you're connected to* and surfaces relevant commands inline — from a structured, version-aware knowledge base. AI-assisted suggestions are a planned future enhancement; the MVP relies entirely on curated structured data.

---

## Goals

- Reduce time spent looking up syntax across platforms
- Work seamlessly across Linux, macOS, and Windows
- Be fast, offline-capable, and predictable (no AI dependency in MVP)
- Be extensible — new platforms and OS versions added without app changes
- Feel like a proper native desktop app, not a web tool

---

## Non-Goals (MVP)

- AI/LLM-powered suggestions (post-MVP)
- Auto-detection of platform from SSH banner (post-MVP)
- Multi-tab / multi-session (post-MVP)
- Mobile support (out of scope)
- Built-in file transfer (out of scope for now)

---

## Target Platforms (App)

| OS | Distribution format |
|---|---|
| Windows | `.msi` installer |
| macOS | `.dmg` / `.app` bundle |
| Linux | `.AppImage` / `.deb` / `.rpm` |

Built with **Tauri v2** (Rust backend + web frontend). Uses the OS native webview — no bundled browser. Small binary, native feel.

---

## Target Device Platforms (Knowledge Base)

| Platform ID | Description | Notes |
|---|---|---|
| `linux-bash` | Linux / Unix bash shell | General bash, common distros |
| `cisco-iosxe` | Cisco IOS-XE | Routers, Cat switches, ASR, ISR |
| `cisco-nxos` | Cisco NX-OS | Nexus data centre switches |
| `f5-tmos` | F5 BIG-IP TMOS / tmsh | Load balancers, application delivery |

Additional platforms added post-MVP (Junos, Palo Alto PAN-OS, Aruba, etc.)

---

## Technical Architecture

### Process Model

Tauri v2 runs two layers:
- **Rust backend** — manages SSH connections (byte pipe), credential access (OS keychain), KB loading/indexing, and file I/O. Exposes async Tauri commands for the frontend.
- **Web frontend** (rendered in OS webview) — terminal UI (xterm.js), input handling, shadow buffer, suggestion rendering, connection manager, sidebar

Communication between frontend and backend via Tauri v2's IPC command system (typed, async). Keystrokes are handled in the frontend for zero-latency input; KB queries go async to Rust.

### SSH Connection Management

- **Library:** `russh` (pure Rust SSH2 implementation) — no dependency on system `ssh` binary
- **YAML parsing:** `serde_yml` (successor to deprecated `serde_yaml`)
- **Platform paths:** `dirs` crate for resolving OS-appropriate config/data directories
- **Host key verification:** First-connect trust-on-first-use (TOFU) model. Known hosts stored in app data directory. User prompted on first connect and on key change (with clear MITM warning)
- **Authentication flow:**
  - Uses the method configured per saved host (password or SSH key)
  - **Keyboard-interactive auth** supported — many network devices (Cisco, F5) use this instead of simple password auth. The app handles challenge/response prompts and passes the stored password.
  - **Key formats:** OpenSSH and PEM (via `russh`). PKCS#8 support post-MVP if needed.
  - **Passphrase-protected keys:** user prompted at connect time. Passphrase optionally stored in OS keychain.
- **Connection lifecycle:**
  - Connect → authenticate → open PTY channel → begin streaming I/O
  - Heartbeat keepalive packets sent to prevent idle disconnects
  - On network drop: detect via read timeout, show "Disconnected" overlay with reconnect button
  - On intentional disconnect (user closes session or types `exit`): clean channel/session teardown
- **SSH agent forwarding:** Not in MVP. Post-MVP consideration.
- **Terminal size negotiation:** Initial terminal dimensions sent on channel open. On window resize (including sidebar open/close), a PTY resize request is sent to the remote host so output reformats correctly.

### Connection Error Handling

| Scenario | User experience |
|---|---|
| Auth failure (wrong password / rejected key) | Error banner with reason. "Retry" button. Connection manager stays accessible. |
| Host unreachable (timeout) | "Connection timed out" overlay after configurable timeout (default 10s). Retry button. |
| Host key changed (potential MITM) | **Blocking warning** — "Host key has changed. This could indicate a man-in-the-middle attack." User must explicitly accept the new key or abort. Old key shown for comparison. |
| Connection drops mid-session | "Disconnected" overlay with reconnect button. Terminal frozen (no input accepted). Last output preserved. |
| Keyboard-interactive challenge unrecognised | Fall back to prompting user for input in a dialog box. |

### Keystroke Flow & Input Interception

This is the core technical challenge. The app must observe user input to power suggestions while the remote device handles all actual echo and editing.

**Key principle: shadow buffer model.** The app does NOT do local echo. All keystrokes are sent to the remote device in real time — the remote handles echo, line editing, and history. The frontend maintains a **shadow buffer** that mirrors what the user is typing, used solely for suggestion matching. The ghost text is an overlay rendered on top of the remote echo.

**Architecture:**

```
┌──────────────────────────────────────────────────────┐
│  Frontend (xterm.js + JavaScript)                    │
│                                                      │
│  xterm.js onKey                                      │
│    ├→ update shadow buffer (local, for suggestions)  │
│    ├→ send keystroke to Rust backend (IPC) → SSH     │
│    └→ query KB via Rust (async) → render ghost text  │
│                                                      │
│  xterm.js onData (from SSH)                          │
│    ├→ write to terminal (remote echo + output)       │
│    └→ prompt detector (ANSI-strip → idle → regex)    │
│           └→ updates current mode                    │
└──────────────┬───────────────────────────────────────┘
               │ IPC (Tauri commands)
┌──────────────▼───────────────────────────────────────┐
│  Rust Backend                                        │
│                                                      │
│  SSH channel (russh) ←→ raw byte stream              │
│  KB index (in-memory, loaded per platform on connect)│
│  KB query API → returns matches for shadow buffer    │
│  Credential manager (OS keychain via platform APIs)  │
│  Config / host storage (JSON in app data dir)        │
└──────────────────────────────────────────────────────┘
```

**How it works:**

1. **xterm.js captures all keystrokes** via `onKey` handler. Each keystroke is:
   - Added to the local shadow buffer (JavaScript, zero latency)
   - Forwarded to the Rust backend via IPC, which writes it to the SSH channel immediately
   - The remote device echoes the character back — xterm.js displays the echo as normal

2. **The shadow buffer** tracks the current input line as the user types. It:
   - Appends printable characters
   - Handles backspace/delete (mirrors what the remote will do)
   - Resets on Enter (new command line)
   - Resets when a new prompt is detected (output from remote command has finished)

3. **On each shadow buffer change**, the KB is queried asynchronously via a Tauri command:
   - Buffer contents matched against KB for current platform + version + mode
   - Top match returned → rendered as ghost text overlay in xterm.js (dimmed, after cursor)
   - Full match list cached for Ctrl+Space dropdown

4. **On Tab (suggestion accept)**: if ghost text is showing, the ghost text completion is:
   - Written to the shadow buffer
   - Sent to the SSH channel as a string (as if the user typed it rapidly)
   - The remote device echoes it — xterm.js displays the completed command
   - If NO ghost text is showing, Tab is passed through to the remote device for native tab-completion

5. **On Enter**: keystroke sent to remote, shadow buffer reset. Remote executes the command and sends output.

6. **Pass-through keys**: these go straight to the SSH channel and update the shadow buffer as appropriate:
   - `Ctrl+C` (interrupt) — also clears shadow buffer
   - `Ctrl+Z` (suspend) — clears shadow buffer
   - `Ctrl+D` (EOF)
   - Arrow keys when dropdown is NOT open (remote history navigation — shadow buffer resets since we can't track remote history)

7. **Paste handling**: pasted text is sent to the SSH channel and added to shadow buffer in full. Suggestion engine runs against the final buffer state.

**Edge cases:**
- **Interactive commands** (e.g. `more`, `vi`, `top`): When the prompt detector identifies a non-prompt interactive context (rapid output with no idle gap, or unrecognised output patterns), the app enters **raw pass-through mode** — shadow buffer and suggestions disabled until next prompt is detected
- **Remote tab-completion output**: When the remote device responds to Tab with completion options (multi-line output), the prompt detector treats this as command output. Shadow buffer resets on next detected prompt.
- **Multi-line input**: Not supported in MVP — shadow buffer is single-line, reset on Enter
- **Cisco `?` key**: Sends `?` to remote immediately (pass-through), remote displays help. Shadow buffer keeps the text before `?` so suggestions resume after help output.

### Prompt Detection

Prompt detection powers both mode awareness and the shadow buffer reset. It operates on the SSH output stream using a state machine:

1. **ANSI stripping** — all escape sequences are stripped from the output stream before analysis
2. **Idle detection** — a prompt is characterised by output that ends without a newline, followed by an idle gap (no new bytes for 200ms). This distinguishes a prompt from mid-output pauses.
3. **Regex matching** — the idle trailing text is matched against `prompt_patterns` from the active platform's `index.yaml`
4. **Mode update** — if a pattern matches, the current mode is updated and the shadow buffer is reset (ready for new input)

If no pattern matches after an idle gap, mode remains unchanged (assumed same context). If no prompt is detected for an extended period (e.g. during `vi` or `more`), raw pass-through mode is activated.

### KB Loading & Performance

- The KB for the active platform is loaded into an in-memory index when a connection is established (not per-keystroke)
- YAML files are parsed once via `serde_yml` into Rust structs, then indexed for prefix matching
- For 4 platforms × ~500 commands each, initial load is sub-50ms — not a concern
- The in-memory index supports fast prefix search (trie or sorted vec with binary search — implementation detail)

### Data Storage

| Data | Location | Format |
|---|---|---|
| Saved hosts (non-secret fields) | App data directory (`~/.config/netsh/` on Linux, `%APPDATA%\netsh\` on Windows, `~/Library/Application Support/netsh/` on macOS) | JSON |
| Credentials (passwords, key passphrases) | OS keychain (libsecret on Linux, Keychain on macOS, Credential Manager on Windows) | Managed by OS |
| SSH private keys | User's filesystem — referenced by path only | Not copied |
| Known hosts | App data directory | JSON |
| Knowledge base | Bundled with app in install directory, user-editable copy in app data directory | YAML |
| User preferences | App data directory | JSON |

### Keyboard Shortcuts

| Shortcut | Action | Context |
|---|---|---|
| `Tab` | Accept ghost text suggestion (if showing) / pass through to remote (if no suggestion) | Terminal |
| `Ctrl+Space` | Open suggestion dropdown | Terminal |
| `Escape` | Dismiss dropdown / dismiss side panel | Dropdown or panel open |
| `↑` / `↓` | Navigate dropdown (if open) / pass through to remote (if closed) | Terminal |
| `Enter` | Select dropdown item (if open) / send command to remote (if closed) | Terminal |
| `Ctrl+\`` (backtick) | Toggle side panel | Terminal |
| `Ctrl+N` | New connection | Any |
| `Ctrl+Shift+W` | Disconnect current session | Terminal |

**Note:** `Ctrl+W` is NOT used — it is "delete previous word" in most shells and must pass through to the remote device.

### Keyboard-First Design

The entire app must be navigable without a mouse. Network engineers work keyboard-first — mouse interaction is available but never required.

| Screen | Key | Action |
|---|---|---|
| Connection Manager | `↑` / `↓` | Navigate host list |
| Connection Manager | `Enter` | Connect to selected host |
| Connection Manager | `/` | Focus search bar |
| Connection Manager | `Ctrl+N` | New connection |
| Connection Manager | `Delete` | Delete selected host (with confirmation) |
| Terminal | `Tab` | Accept suggestion / pass to remote |
| Terminal | `Ctrl+Space` | Open dropdown |
| Terminal | `Ctrl+\`` | Toggle side panel |
| Terminal | `Ctrl+Shift+W` | Disconnect |
| Terminal | `Escape` | Dismiss dropdown → dismiss panel → return to connection manager (cascade) |
| Terminal | `Ctrl++` / `Ctrl+-` | Zoom terminal font |
| Side Panel | `↑` / `↓` | Scroll content (when panel is focused) |
| Global | `Tab` / `Shift+Tab` | Move focus between panels/elements |
| Global | `Ctrl+,` | Open settings |

---

## Visual Design

### Design Language

net.sh is a professional tool for network engineers. The visual design should be clean, information-dense, and distraction-free. No decorative elements. Every pixel earns its place.

### Theme

- **Default:** Dark theme, following OS-level dark/light preference (Tauri detects this automatically). Manual override in settings.
- **Dark palette (primary):**

| Element | Colour | Notes |
|---|---|---|
| Terminal background | `#1e1e2e` | Deep blue-grey, easy on the eyes for long sessions |
| Terminal foreground | `#cdd6f4` | Warm off-white |
| UI chrome (sidebar, connection manager) | `#181825` | Slightly darker than terminal to differentiate |
| Borders / dividers | `#313244` | Subtle, not prominent |
| Accent / interactive | `#89b4fa` | Blue — links, selected items, focus indicators |
| Ghost text (suggestions) | `#6c7086` at 50% opacity | Must be clearly distinguishable from real text and cursor. No ambiguity. |
| Dropdown selected item | `#313244` background | Highlighted row |
| Error / warning | `#f38ba8` / `#fab387` | Red / orange |
| Success / connected | `#a6e3a1` | Green |
| Muted metadata | `#585b70` | Version, mode, tags in sidebar |

- **Light palette:** Post-MVP. Design dark-first, derive light later.

### Typography

| Context | Font | Size | Notes |
|---|---|---|---|
| Terminal | JetBrains Mono | 14px default | Bundled with app. User-configurable in settings. |
| UI text (labels, sidebar, connection manager) | System font stack (Inter as fallback) | 13px body, 12px metadata | Native feel per OS |
| Sidebar command name (heading) | JetBrains Mono, bold | 16px | Monospace to match terminal context |
| Sidebar code blocks / syntax | JetBrains Mono | 13px | Syntax colouring for optional vs required params |

**Terminal font size:** adjustable via `Ctrl++` / `Ctrl+-` (zoom). Persisted in user preferences.

### Spacing & Layout

- **Base unit:** 4px grid. All spacing is a multiple of 4.
- **Connection manager list items:** 48px row height (comfortable click/touch target)
- **Sidebar default width:** 320px
- **Sidebar min width:** 240px (collapses if dragged smaller)
- **Sidebar resizable:** yes — drag the divider between terminal and sidebar
- **Sidebar mode:** push (resizes the terminal, does NOT overlay it)
- **Dropdown max height:** 8 visible items, scrollable if more
- **Dropdown item height:** 28px

---

## Application Structure

### Screens / Views

1. **Connection Manager** — Home screen. Lists saved hosts. Add / edit / delete.
2. **Terminal View** — Active SSH session. Terminal + suggestion UI.
3. **Settings** — App preferences, KB update channel, theme.

### Terminal View Layout

```
┌──────────────────────────────────────────────────────────────┐
│ [← Back]  core-rtr-lon01 (IOS-XE 17.6)           [≡ Panel] │  ← Top bar
├─────────────────────────────────┬────────────────────────────┤
│                                 │                            │
│     SSH Terminal                │  show ip interface brief   │
│     (xterm.js)                  │  ━━━━━━━━━━━━━━━━━━━━━━━   │
│                                 │                            │
│                                 │  Syntax                    │
│                                 │  ┌────────────────────┐    │
│                                 │  │ show ip interface   │    │
│                                 │  │ [brief | <name>]   │    │
│                                 │  └────────────────────┘    │
│                                 │                            │
│  router# show ip int            │  Description               │
│    ░░░░erface brief (+4)        │  Displays IP address,      │
│                                 │  status, and protocol      │
│                                 │  state for interfaces.     │
│                                 │                            │
│                                 │  Examples                  │
│                                 │  ▸ show ip int brief       │
│                                 │  ▸ show ip int Gi0/0/0     │
│                                 │                            │
│                                 │  ─────────────────────     │
│                                 │  IOS-XE · ≥12.0 · exec    │
│                                 │  🏷 interfaces networking  │
│                                 │  📖 Official docs →        │
├─────────────────────────────────┴────────────────────────────┤
│ 🟢 core-rtr-lon01 │ IOS-XE 17.6 │ privileged-exec │ 12ms   │  ← Status bar
└──────────────────────────────────────────────────────────────┘
```

### Top Bar
- **← Back** — returns to connection manager (keyboard: `Escape` when no dropdown/panel open)
- **Host name + platform** — always visible context
- **≡ Panel button** — toggles side panel (keyboard: Ctrl+`)

### Status Bar

Thin bar at the bottom of the terminal view. Always visible. Shows at a glance:

| Element | Description |
|---|---|
| Connection indicator | 🟢 green = connected, 🔴 red = disconnected, 🟡 yellow = connecting |
| Host display name | Which device am I on? |
| Platform + version | What OS is this? |
| Current mode | Updated in real time by prompt detection — confirms the app is tracking correctly |
| Latency (optional) | Round-trip time if measurable. Helps diagnose slow sessions. |

### Side Panel

Hidden by default. Toggled via `Ctrl+\`` or the panel button. Pushes terminal (does not overlay). Resizable by dragging the divider. Default 320px, minimum 240px.

**Visual hierarchy (top to bottom):**

1. **Command name** — large, bold, monospace. The heading.
2. **Syntax block** — monospace code block with colour highlighting:
   - Required params in foreground colour
   - Optional params (`[...]`) in accent colour
   - Placeholder params (`<name>`) in italic
3. **Description** — body text. Plain language explanation.
4. **Examples** — each in a monospace code block. **Clickable** — clicking an example inserts it into the terminal input (writes to shadow buffer + sends to SSH channel). Hover state indicates interactivity.
5. **Divider**
6. **Metadata row** (muted) — platform · version introduced · mode. De-emphasised, does not compete with description.
7. **Tags** — shown as pills/chips (e.g. `interfaces` `networking` `troubleshooting`). Post-MVP: clickable to filter related commands.
8. **📖 Official docs →** — link to platform reference URL. Opens in default browser.

### Ghost Text Rendering

- Appears immediately after the last typed character (not after the cursor block)
- Same terminal row, inline
- Rendered at 50% opacity of foreground colour — clearly distinct from real text
- **Truncates with `…`** if it would wrap to the next line
- **Instant on/off** — no animation, no fade. Any delay feels laggy in a terminal.
- **Match count badge** — when ghost text is showing, a subtle `(+N)` after the ghost text indicates more matches available via `Ctrl+Space`. Teaches the dropdown feature organically.
- Disappears instantly when user types a character that no longer matches

### Dropdown Rendering

- Appears below the cursor. If insufficient room below, appears above.
- **Never** obscures the current input line
- Maximum 8 visible items, scroll indicator if more
- Each item: matched prefix shown in **bold** (e.g. **show ip** interface brief)
- Selected item has highlighted background (`#313244`)
- Category shown as muted text right-aligned in each row (e.g. `networking`)
- Dismissed on `Escape`, typing a non-matching character, or clicking outside

### Connecting State

When a user clicks Connect, the terminal view shows a connection progress sequence:

```
┌──────────────────────────────────────────┐
│                                          │
│        Connecting to core-rtr-lon01      │
│        ━━━━━━━━━━━━━━━━░░░░░░░░░░       │
│                                          │
│        Authenticating...                 │
│                                          │
│                          [Cancel]        │
│                                          │
└──────────────────────────────────────────┘
```

Progress stages shown sequentially:
1. "Connecting..." (TCP handshake)
2. "Verifying host key..." (TOFU check)
3. "Authenticating..." (password/key/keyboard-interactive)
4. "Opening session..." (PTY channel)
5. → Terminal view (connected)

Cancel button available at all stages. On failure, error overlay with retry button (see Connection Error Handling).

---

## Connection Manager

### Saved Host Fields

| Field | Type | Required | Notes |
|---|---|---|---|
| Display name | String | Yes | Friendly label e.g. "Core Router - LON" |
| Hostname / IP | String | Yes | |
| Port | Integer | No | Default: 22 |
| Username | String | Yes | |
| Authentication | Enum | Yes | Password / SSH key |
| Password / Key path | Secure | Yes | Stored in OS keychain |
| Platform | Enum | Yes | Selected from supported platform list |
| OS Version | String | No | e.g. "17.6", "15.1" — used for version-aware KB filtering |
| Notes | Text | No | Free text |

### Connection Manager UX

**List view:**
- Each row shows: **platform icon** (visual indicator — Cisco, F5, Linux icons), **display name** (bold), hostname (muted), **last connected** timestamp, **connection status dot** (green = last connected OK, grey = never connected, red = last attempt failed)
- Search/filter bar at top — filters across display name, hostname, platform, and notes
- Right-click or `⋮` menu for edit / delete / duplicate
- **"+ New Connection" button** prominent at top
- Drag to reorder (manual ordering persists)

**Keyboard navigation:**
- `↑` / `↓` to navigate the host list
- `Enter` to connect to selected host
- `/` to focus the search bar
- `Ctrl+N` to open new connection form
- `Delete` or `Backspace` on selected host opens delete confirmation
- `Tab` / `Shift+Tab` to move between search bar, host list, and buttons

**Grouping (post-MVP, but UI should accommodate):**
- Collapsible groups by site, role, or custom tag (e.g. "DC Switches", "London Core", "F5 Prod")
- MVP: flat list with manual ordering. Design the row height and layout so groups can be added later without a redesign.

### Empty State (First Run)

The first thing every new user sees. This screen determines whether they continue or close the app.

```
┌──────────────────────────────────────────────────────┐
│                                                      │
│              🖥  Welcome to net.sh                    │
│                                                      │
│   A smarter SSH client for network engineers.        │
│   Connect to your devices with context-aware         │
│   command suggestions built in.                      │
│                                                      │
│         ┌──────────────────────────┐                 │
│         │  + Add your first host   │                 │
│         └──────────────────────────┘                 │
│                                                      │
│   Supports: Cisco IOS-XE · NX-OS · F5 TMOS · Linux  │
│                                                      │
│   ─────────────────────────────────────              │
│                                                      │
│   💡 Tip: After connecting, start typing a command   │
│   and net.sh will suggest completions inline.        │
│   Press Tab to accept, Ctrl+Space to browse.         │
│                                                      │
└──────────────────────────────────────────────────────┘
```

- Single prominent CTA: **Add your first host**
- Brief value proposition (one line)
- Supported platforms listed (sets expectations)
- Usage tip: teaches the core interaction before they even connect
- No feature tour, no multi-step wizard. One button, one tip. Get out of the way.

### New / Edit Host Form

Clean modal or slide-over panel. Fields in logical order:

1. **Display name** — with placeholder: "e.g. Core Router - LON"
2. **Hostname / IP** — with placeholder: "e.g. 192.168.1.1 or router.example.com"
3. **Port** — pre-filled with 22, editable
4. **Username**
5. **Platform** — dropdown with platform icons. On selection, show a brief description ("Cisco IOS-XE — routers, Cat switches, ASR, ISR")
6. **OS Version** — optional, with placeholder: "e.g. 17.6" and helper text: "Used to filter suggestions to your version. Leave blank to show all commands."
7. **Authentication** — radio: Password / SSH Key. Conditionally shows password field or key file picker.
8. **Notes** — optional, collapsible/expandable

**Save** and **Save & Connect** buttons at bottom. Save & Connect is the primary action (accent colour).

---

## Inline Suggestion Engine

### Behaviour
- Triggers as user types in the terminal input line
- Queries the local knowledge base filtered by: platform ID + OS version + **current CLI mode**
- Shows top N matching commands as ghost text (accept with Tab) or dropdown (navigate with arrow keys)
- Side panel (when open) updates in real time to show detail of the highlighted suggestion
- Suggestions are prefix-matched and ranked by frequency/relevance (simple scoring, no ML)

### Mode Detection (MVP)

The terminal monitors each line of output and parses the prompt to determine current CLI mode. Mode is used to filter suggestions to only those valid for the current context.

**Cisco IOS / IOS-XE prompt patterns:**

| Prompt pattern | Mode |
|---|---|
| `hostname>` | user-exec |
| `hostname#` | privileged-exec |
| `hostname(config)#` | global-config |
| `hostname(config-if)#` | interface-config |
| `hostname(config-router)#` | routing-config |
| `hostname(config-line)#` | line-config |

**Cisco NX-OS prompt patterns:**

| Prompt pattern | Mode |
|---|---|
| `hostname#` | privileged-exec |
| `hostname(config)#` | global-config |
| `hostname(config-if)#` | interface-config |
| `hostname(config-router)#` | routing-config |

**F5 BIG-IP TMOS prompt patterns:**

| Prompt pattern | Mode |
|---|---|
| `user@(hostname)(cfg-sync ...)(/partition)(tmos)#` | tmsh root |
| `user@(hostname)(cfg-sync ...)(tmos.ltm)#` | ltm context |
| `user@(hostname)(cfg-sync ...)(tmos.net)#` | net context |
| `user@(hostname)(cfg-sync ...)(tmos.sys)#` | sys context |
| `hostname:~$` or `[user@hostname:Active:...]` | bash shell |

F5 prompt parsing is more complex — the prompt contains cluster sync state, partition, and context path. MVP approach: match on the `(tmos` substring to detect tmsh vs bash, and extract the context path (e.g. `.ltm`, `.net`) for mode filtering. Exact regex defined in `index.yaml`.

**Linux bash:**

Bash prompts are user-configurable (`PS1`) and cannot be reliably parsed for mode. MVP approach:
- Default mode: `shell` (all commands shown)
- No sub-mode detection (e.g. inside vim, python REPL, etc.)
- If the app detects a non-prompt interactive context (rapid output, no recognisable prompt), suggestions are disabled (raw pass-through mode)

Other platforms define their own prompt patterns in `index.yaml`. If mode cannot be determined, suggestions default to showing all commands for the platform (unfiltered).

### Suggestion UI

Two complementary suggestion modes, matching modern IDE behaviour (e.g. VS Code):

**Ghost text (primary)**
- Top matching command appears as greyed-out text inline after the cursor
- Accept with `Tab`
- Always visible while typing — zero disruption

**Dropdown (on demand)**
- Triggered by `Ctrl+Space`
- Shows top N matches as a popup list below the cursor
- Navigate with arrow keys, accept with `Enter` or `Tab`
- Dismiss with `Escape`

Both update in real time as the user types, filtered by platform + version + current mode.

### Suggestion Sources (MVP)
- Local knowledge base only
- Filtered by: platform ID + OS version (or all versions if unspecified)

### Suggestion Sources (Post-MVP)
- Command history (per host)
- AI/LLM layer (optional, user-enabled)

---

## Knowledge Base

### Design Principles
- Human-readable and human-editable (YAML)
- Version-aware — commands carry version applicability metadata
- Platform-scoped — one file per platform
- Shipped with the app, updatable independently of app releases
- Community-extensible in future

### Design Decision: Self-Contained Platform Files

Each platform is fully self-contained. Command descriptions are duplicated across platforms as needed — this is a knowledge base, not a codebase. Duplication is intentional:

- No cross-references to resolve at runtime
- Each platform file is independently editable
- Easy for contributors to add new platforms without understanding shared structure
- Platform-specific wording can diverge without affecting others

### File Structure

```
knowledge-base/
  linux-bash/
    index.yaml          # platform metadata
    commands/
      networking.yaml
      filesystem.yaml
      process.yaml
      ...
  cisco-iosxe/
    index.yaml
    commands/
      show.yaml
      interface.yaml
      routing.yaml
      bgp.yaml
      ...
  cisco-nxos/
    index.yaml
    commands/
      ...
  f5-tmos/
    index.yaml
    commands/
      ...
```

### Platform Index Schema (`index.yaml`)

```yaml
id: cisco-iosxe
name: Cisco IOS-XE
description: Cisco IOS-XE for routers and enterprise switches
reference_url: "https://www.cisco.com/c/en/us/support/ios-nx-os-software/ios-xe-17/series.html"
versions:
  - "15.x"
  - "16.x"
  - "17.x"
prompt_patterns:
  user-exec: '^[\w\-]+>'
  privileged-exec: '^[\w\-]+#'
  global-config: '^[\w\-]+\(config\)#'
  interface-config: '^[\w\-]+\(config-if\)#'
  routing-config: '^[\w\-]+\(config-router\)#'
  line-config: '^[\w\-]+\(config-line\)#'
default_mode: privileged-exec
```

The `reference_url` is shown in the sidebar as "📖 Official docs →" — one link per platform pointing to the official command reference.

### Command Schema

All description/helper text lives inline in the command entry. This is what populates the sidebar when a user selects a suggestion. Use YAML block scalars (`|`) for multiline text.

```yaml
commands:
  - name: show ip interface brief
    syntax: "show ip interface [brief | <interface-name>]"
    description: |
      Displays IP address, status, and protocol state for interfaces.

      Use 'brief' for a compact summary of all interfaces.
      Omit 'brief' and specify an interface name for full detail.
    category: networking
    mode: privileged-exec          # see Canonical Mode Values below
    aliases:                         # alternative ways to type this command
      - sh ip int br                 # aliases are prefix-matched like the command name
      - show ip int brief
    examples:
      - command: show ip interface brief
        description: Summary of all interfaces
      - command: show ip interface GigabitEthernet0/0/0
        description: Full detail for a specific interface
    versions:
      introduced: "12.0"
      deprecated: null
      notes: null
    tags:
      - interfaces
      - networking
      - troubleshooting
```

### Canonical Mode Values

Each platform defines its own mode values. Commands use these in the `mode` field.

**Cisco IOS-XE / NX-OS:**
`user-exec`, `privileged-exec`, `global-config`, `interface-config`, `routing-config`, `line-config`

**F5 TMOS:**
`tmsh-root`, `ltm`, `net`, `sys`, `bash`

**Linux bash:**
`shell` (single mode — no sub-modes in MVP)

### Alias & Prefix Matching

Both the command `name` and all `aliases` are prefix-matched against the user's input buffer. For example, typing `sh ip` would match:
- `show ip interface brief` (via alias `sh ip int br`)
- `show ip route` (via name prefix)
- `show ip bgp summary` (via name prefix)

Matching is case-insensitive. Results ranked by: exact prefix match on name first, then alias matches, then by category relevance.

### KB File Organisation

Command YAML files within each platform are grouped by **command category** (not by command root). Categories map to functional areas a network engineer thinks in:

- `networking.yaml` — interfaces, IP, ARP, MAC tables
- `routing.yaml` — static routes, OSPF, BGP, EIGRP
- `switching.yaml` — VLANs, STP, port-channels
- `system.yaml` — hostname, NTP, logging, users
- `security.yaml` — ACLs, AAA, crypto
- `monitoring.yaml` — show commands for status, counters, logging

Each platform uses whatever categories make sense for it. Not all platforms need the same files.

### Version Filtering Logic

- If host has no OS version set in saved host settings → show all commands for that platform
- If host has OS version set → show commands where `introduced <= host_version` and `deprecated` is null or `deprecated > host_version`
- Commands with version caveats shown with a ⚠️ indicator

**Version comparison (MVP): major version matching.** The user enters a version string (e.g. `"17.6"`, `"16.12.4a"`) in the saved host settings. For comparison purposes, only the **major version** is used (first numeric segment): `"17.6"` → major `17`, `"16.12.4a"` → major `16`. Command `introduced: "16.0"` → major `16`.

A command is shown if its `introduced` major version ≤ host major version, and its `deprecated` major version (if set) > host major version.

This avoids the rabbit hole of cross-platform version string semantics (Cisco, F5, and Linux all use different formats). Granular sub-version filtering is a post-MVP enhancement if needed.

---

## Security Considerations

- Credentials stored in OS keychain (not in app config files)
- SSH private keys referenced by path — never copied or stored by the app
- No telemetry, no cloud sync in MVP
- KB updates verified by checksum before applying

---

## Future Features (Post-MVP Backlog)

| Feature | Notes |
|---|---|
| Tabbed / multi-session | Multiple concurrent SSH sessions |
| Platform auto-detection | Parse SSH banner + prompt to suggest platform |
| Command history per host | Personalised suggestions based on past usage |
| AI suggestion layer | Optional LLM enhancement, user-enabled |
| KB community updates | Pull platform updates from a hosted registry |
| Jump host / bastion support | SSH proxy/jump configuration |
| Additional platforms | Junos, PAN-OS, Aruba AOS, EOS, etc. |
| Session recording | Audit log of commands run |
| Themes | Light/dark/custom terminal themes |
| Plugin system | Third-party KB extensions |

---

## Open Questions

1. **KB update mechanism** — ship updates via GitHub releases? In-app updater? Separate from app updates?
2. **First KB content** — hand-crafted vs CrewAI-generated then reviewed by Andy?
3. **Quick Connect** — should MVP include a connection bar for ad-hoc `user@host` connections (without saving), or is that post-MVP?

---

## Decision Log

| Date | Decision | Rationale |
|---|---|---|
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

---

*This document is the source of truth for net.sh scope and design. Update as decisions are made.*
