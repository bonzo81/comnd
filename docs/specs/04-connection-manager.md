# Connection Manager

## Saved Host Fields

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| Display name | String | Yes      | Friendly label e.g. "Core Router - LON" |
| Hostname / IP | String | Yes      |       |
| Port  | Integer | No       | Default: 22 |
| Username | String | Yes      |       |
| Authentication | Enum | Yes      | Password / SSH key / SSH agent |
| Password / Key path / Agent identity | Secure | Yes      | Password stored in OS keychain; agent identity is a fingerprint (or null = offer all) |
| Platform | Enum | Yes      | Selected from supported platform list |
| OS Version | String | No       | e.g. "17.6", "15.1" — used for version-aware KB filtering |
| Notes | Text | No       | Free text |

## Connection Manager UX

**List view:**

* Each row shows: **platform icon** (visual indicator — Cisco, F5, Linux icons), **display name** (bold), hostname (muted), **last connected** timestamp, **connection status dot** (green = last connected OK, grey = never connected, red = last attempt failed)
* Search/filter bar at top — filters across display name, hostname, platform, and notes
* Right-click or `⋮` menu for edit / delete / duplicate
* **"+ New Connection" button** prominent at top
* Drag to reorder (manual ordering persists)

**Keyboard navigation:**

* `↑` / `↓` to navigate the host list
* `Enter` to connect to selected host
* `/` to focus the search bar
* `Ctrl+N` to open new connection form
* `Delete` or `Backspace` on selected host opens delete confirmation
* `Tab` / `Shift+Tab` to move between search bar, host list, and buttons

**Grouping (post-MVP, but UI should accommodate):**

* Collapsible groups by site, role, or custom tag (e.g. "DC Switches", "London Core", "F5 Prod")
* MVP: flat list with manual ordering. Design the row height and layout so groups can be added later without a redesign.

## Multiple Sessions to the Same Host

A host entry may have more than one live SSH session. Sessions are independent: each
has its own PTY, shadow buffer, suggestion/ghost-text state, and session log file.

**Tabs are keyed by session id, not host id.** Duplicate sessions to one host get
separate tabs, and both tabs show the same display name (no counter suffix). Closing
one tab disconnects only that session; the other stays connected and responsive.

**Connecting to an already-connected host** is governed by
`duplicate_session_policy` in `AppConfig` (Settings → General → "When connecting to a
host that is already connected"):

| Policy | Behaviour |
|---|---|
| `ask` (default) | Show the duplicate-session dialog |
| `allow` | Open another session immediately |
| `focus` | Switch to the running session immediately |

The dialog title names the device: "<display name> is already connected". Its actions
are **Open another session** (primary, focused first), **Go to existing session**, and
**Cancel**. `Esc` and a backdrop click both cancel, leaving the app untouched. A
"Remember my choice" checkbox persists the choice as the policy; cancelling is never
remembered.

**Session limit.** When `max_sessions` is reached (`0` means unlimited) the dialog does
not offer **Open another session**. It states that the limit is reached and offers only
**Go to existing session** and **Cancel**.

If the config read fails, the app does not know the limit, and an unknown limit is never
treated as unlimited. The dialog then states that the session limit could not be checked
(without naming a number) and likewise offers only **Go to existing session** and
**Cancel**, with the existing session focused first.

## Empty State (First Run)

The first thing every new user sees. This screen determines whether they continue or close the app.

```
┌──────────────────────────────────────────────────────┐
│                                                      │
│              🖥  Welcome to comnd                    │
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
│   and comnd will suggest completions inline.        │
│   Press Tab to accept, Ctrl+Space to browse.         │
│                                                      │
└──────────────────────────────────────────────────────┘
```

* Single prominent CTA: **Add your first host**
* Brief value proposition (one line)
* Supported platforms listed (sets expectations)
* Usage tip: teaches the core interaction before they even connect
* No feature tour, no multi-step wizard. One button, one tip. Get out of the way.

## New / Edit Host Form

Clean modal or slide-over panel. Fields in logical order:


1. **Display name** — with placeholder: "e.g. Core Router - LON"
2. **Hostname / IP** — with placeholder: "e.g. 192.168.1.1 or router.example.com"
3. **Port** — pre-filled with 22, editable
4. **Username**
5. **Platform** — dropdown with platform icons. On selection, show a brief description ("Cisco IOS-XE — routers, Cat switches, ASR, ISR")
6. **OS Version** — optional, with placeholder: "e.g. 17.6" and helper text: "Used to filter suggestions to your version. Leave blank to show all commands."
7. **Authentication** — radio: Password / SSH Key / SSH Agent. Conditionally shows password field, key file path, or agent identity picker. The identity picker is a native select (keyboard navigable) populated from the local SSH agent on form open; "Offer all identities" (empty value) means no specific key is pinned. If no agent is detected or it holds no keys, an inline hint explains what to start (`ssh-agent` / 1Password) — saving still works and connect will surface the agent error.
8. **Notes** — optional, collapsible/expandable

**Save** and **Save & Connect** buttons at bottom. Save & Connect is the primary action (accent colour).

## Host Sources (NetBox)

NetBox-sourced devices appear alongside user hosts, never mixed into them.

- **Opt-in**: disabled until enabled in Settings -> NetBox. Nothing touches the
  network until the user clicks Refresh.
- **Storage**: devices cache to `netbox-cache.json` in the app data dir. The
  sync NEVER writes to `hosts.json`; `get_hosts` merges user hosts + enabled
  NetBox devices at read time. Devices deleted in NetBox disappear on next sync.
- **Tree grouping**: mirrors the NetBox geography hierarchy — NetBox
  root -> region group (recursive; sites carry their region) -> site group
  -> location group (recursive; locations carry their parent). By default,
  only folders with an enabled host anywhere in their subtree appear.
  **Show empty folders** in Settings -> NetBox restores all cached
  regions/sites/locations, including empty branches. This setting saves
  automatically and refreshes the tree without syncing devices. The entire
  NetBox tree stays hidden when there are no enabled devices.
  Devices without a location sit directly under their site. Groups are
  synthetic (`__netbox__...` ids), not user-editable, and show NetBox
  names (not slugs) once geography is cached (cache v2).
- **Refresh**: manual only (Refresh Now in settings or the folder context
  menu). No background sync, no polling, no refresh-on-launch.
- **Sync filters**: status (default `active`), sites, roles, tags -
  comma-separated slugs passed as NetBox API query filters.
- **Platform mapping**: NetBox platform slug -> Comnd platform via a built-in
  table (cisco-ios, nx-os, f5-tmos, ubuntu, ...). Unknown slugs: skip
  (reported in the sync summary) or fallback platform, plus a slug=platform
  overrides list.
- **Credentials**: overlay model. Source-level defaults (username, port,
  auth method) set in Settings -> NetBox; per-device overrides (username,
  port, auth method, notes) via Configure on the device. All four auth
  methods (password / SSH key / agent / secret manager) are available.
  Passwords live in the OS keyring, the NetBox API token too.
- **Guards**: NetBox hosts cannot be edited, renamed, duplicated, deleted,
  or dragged. Grouping is fixed by the sync. Configure / Disable replace the
  usual host context-menu actions. The backend rejects these mutations even
  if the UI is bypassed.
- **Read-only API access**: Comnd never writes to the configured NetBox
  instance. Every request is a GET against a list endpoint, and the Rust
  client structurally exposes GET only (the `readonly_http` guard in
  `src-tauri/src/netbox.rs`, enforced by tests). The settings UI recommends
  provisioning a read-only API token.
