# Connection Manager

## Saved Host Fields

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| Display name | String | Yes      | Friendly label e.g. "Core Router - LON" |
| Hostname / IP | String | Yes      |       |
| Port  | Integer | No       | Default: 22 |
| Username | String | Yes      |       |
| Authentication | Enum | Yes      | Password / SSH key |
| Password / Key path | Secure | Yes      | Stored in OS keychain |
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

## Empty State (First Run)

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
7. **Authentication** — radio: Password / SSH Key. Conditionally shows password field or key file picker.
8. **Notes** — optional, collapsible/expandable

**Save** and **Save & Connect** buttons at bottom. Save & Connect is the primary action (accent colour).
