# Terminal and Suggestions

## Terminal View Layout

Once you connect to a device, the terminal view has four zones. For a walkthrough of connecting to a device, see [Getting Started](02-getting-started.md).

**Session tab bar** — One tab per live session, with the device facts on each tab's tooltip and the controls menu and side-panel button at the right end.

**Terminal area** — Your SSH session. Remote output appears here, and this is where you type commands. It behaves like any terminal you already use. Keystrokes go straight to the remote device. URLs in terminal output are clickable — click opens the link in your system browser.

**Controls menu** — The slider button at the right end of the session tab bar opens the terminal controls: line timestamps, command suggestions, auto-copy on selection, output highlighting, terminal theme and scrollback search.

**Side panel** — Hidden by default. When open, it shows detailed information about the currently highlighted suggestion. Covered in full in [Side Panel](05-side-panel.md).

## How Suggestions Work

As you type a command, Comnd looks up matching commands from its knowledge base for the device you are connected to. The matching is simple and predictable:

- It matches what you type against the start of command names and aliases. Matching ignores capital letters.
- It filters results to your device platform and OS version.
- It filters results to your current CLI mode, so you only see commands that work in your context.

The top match appears as **ghost text** inline, right after your cursor. If more matches exist, a small `(+N)` badge shows that the dropdown has more items.

## Ghost Text (Primary Suggestion)

Ghost text is the greyed-out completion that appears after your cursor while you type. It shows the best match for what you have typed so far.

- Appears automatically as you type a recognized command prefix
- Disappears the instant you type something that no longer matches
- **Press `Tab` to accept** — the ghost text is entered into your command line
- If no ghost text is showing, `Tab` passes through to the remote device for native tab-completion

Ghost text is designed to stay out of your way. The app shows it at reduced opacity. This keeps a clear separation between what you type and the suggestion. It fades in briefly when it appears. It disappears instantly when you type a non-matching character — no delay.

**Important:** `Tab` is context-sensitive. When ghost text is showing, `Tab` accepts the suggestion. When no ghost text is visible, `Tab` passes through to the remote device unchanged. This means the normal tab-completion on your remote shell still works as expected.

## Suggestion Dropdown (Auto-Show Toggle)

The dropdown is off by default. Turn it on to see every match while you type.

- **Press `Ctrl+Space`** or choose **Command suggestions** from the controls menu to toggle it (the setting persists between sessions)
- When enabled, the dropdown appears as soon as you type a recognized prefix. The list shows below your cursor, or above it if there is not enough room.
- Navigate with `↑` and `↓`
- Accept with `Tab` (`Enter` always submits the typed command to the device)
- Dismiss with `Escape`

Each item in the dropdown shows the **matched prefix in bold**, the full command, and its category in muted text. At most 8 items are visible at a time. Scroll to see more.

## Side Panel Integration

Open the side panel with the **≡** button in the session tab bar to see full details of the highlighted suggestion. The highlight can be the ghost text or a selected dropdown item. The panel updates in real time as you type and as your selection changes.

See [Side Panel](05-side-panel.md) for the full panel layout and what it shows.

## CLI Mode Awareness

Comnd detects your current CLI mode from the device prompt. For example, on a Cisco router:

- `>` means user mode (limited commands)
- `#` means privileged mode (full exec access)
- `(config)#` means global configuration mode (changing device settings)

Comnd filters suggestions to commands that are valid in the current mode. The detected mode is shown on the session tab's tooltip. For a full list of modes per platform, see [Knowledge Base](06-knowledge-base-overview.md).

## How Input Works

All keystrokes go directly to the remote device. Comnd does not intercept or hold back your input. There is no local echo: the app never mirrors your typing on screen. The remote device shows what you type, lets you edit it, and keeps command history as normal.

Comnd watches what you type in order to offer suggestions, but the terminal remains a regular SSH session. The terminal feels responsive because your keystrokes reach the device with no added delay. The remote display stays accurate even inside interactive programs.

If suggestions do not appear or the detected mode is wrong, see [Troubleshooting](10-troubleshooting.md).

For a complete list of keyboard shortcuts — including how to navigate the terminal, panel, and dropdown without touching the mouse — see [Keyboard Shortcuts](07-keyboard-shortcuts.md).
