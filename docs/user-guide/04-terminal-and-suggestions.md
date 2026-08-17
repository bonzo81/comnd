## Terminal View Layout

Once you connect to a device, the terminal view has four zones. For a walkthrough of connecting to a device, see [Getting Started](02-getting-started.md).

**Top bar** — A back button (returns to the connection manager), the host name and platform, and a toggle for the side panel.

**Terminal area** — Your SSH session. Remote output appears here, and this is where you type commands. It behaves like any terminal you already use: keystrokes go straight to the remote device. URLs in terminal output are clickable — click opens the link in your system browser.

**Status bar** — A thin strip at the bottom showing at a glance what you are connected to and what mode you are in. It displays a connection indicator (green, yellow, or red dot), the host name, platform and version, the current CLI mode, and round-trip latency.

**Side panel** — Hidden by default. When open, it shows detailed information about the currently highlighted suggestion. Covered in full in [Side Panel](05-side-panel.md).

## How Suggestions Work

As you type a command, net.sh looks up matching commands from its knowledge base for the device you are connected to. The matching is simple and predictable:

- It matches what you've typed against the start of command names and aliases (it doesn't care about capital letters)
- It filters results to your device platform and OS version
- It filters results to your current CLI mode, so you only see commands that work in your context

The top match appears as **ghost text** inline, right after your cursor. If more matches exist, a subtle `(+N)` badge tells you there's a dropdown worth opening.

## Ghost Text (Primary Suggestion)

Ghost text is the greyed-out completion that appears after your cursor while you type. It shows the best match for what you have typed so far.

- Appears automatically as you type a recognised command prefix
- Disappears the instant you type something that no longer matches
- **Press `Tab` to accept** — the ghost text is entered into your command line
- If no ghost text is showing, `Tab` passes through to the remote device for native tab-completion

Ghost text is designed to stay out of your way. It's shown at reduced opacity so there's never any confusion between what you typed and what's suggested. It disappears instantly when you type a non-matching character — no animation, no delay.

**Important:** `Tab` is context-sensitive. When ghost text is showing, `Tab` accepts the suggestion. When no ghost text is visible, `Tab` passes through to the remote device unchanged. This means the normal tab-completion on your remote shell still works as expected.

## Suggestion Dropdown (On-Demand)

When you want to see more than the top match, open the dropdown.

- **Press `Ctrl+Space`** to open it
- The dropdown appears as a list below your cursor (or above if there isn't enough room)
- Navigate with `↑` and `↓`
- Accept with `Enter` or `Tab`
- Dismiss with `Escape`

Each item in the dropdown shows the **matched prefix in bold**, the full command, and its category in muted text. A maximum of 8 items are visible at once; scroll if there are more.

## Side Panel Integration

Open the side panel with `Ctrl+\`` to see full details of the currently highlighted suggestion, whether it's the ghost text or a selected dropdown item. The panel updates in real time as you type and as your selection changes.

See [Side Panel](05-side-panel.md) for the full panel layout and what it shows.

## CLI Mode Awareness

net.sh detects your current CLI mode from the device prompt. For example, on a Cisco router:

- `>` means user mode (limited commands)
- `#` means privileged mode (full exec access)
- `(config)#` means global configuration mode (changing device settings)

Suggestions are filtered to commands that are valid in your current mode. The detected mode is always visible in the status bar. For a full list of modes per platform, see [Knowledge Base](06-knowledge-base-overview.md).

## What Happens Under the Hood

All keystrokes go directly to the remote device. net.sh does not intercept or hold back your input — there's no "local echo" where the app tries to mirror what you type. The remote device handles all of that: showing what you type, letting you edit it, and keeping command history exactly as it normally does.

net.sh watches what you type in order to offer suggestions, but the terminal remains a regular SSH session. This is why the terminal feels responsive and behaves the way you expect: your keystrokes reach the device with no added delay, and the remote display stays accurate even inside interactive programs.

If you run into issues with suggestions not appearing or mode detection being wrong, see [Troubleshooting](10-troubleshooting.md).

For a complete list of keyboard shortcuts — including how to navigate the terminal, panel, and dropdown without touching the mouse — see [Keyboard Shortcuts](07-keyboard-shortcuts.md).
