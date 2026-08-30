# Side Panel

## Opening and Closing

The side panel starts hidden. You open it only when you want to inspect a command in detail. There are three ways to toggle it:

- Press **Ctrl+`** (backtick) from anywhere inside the terminal view.
- Click the **≡** button on the right side of the top bar.
- Press **Escape** — the behavior depends on what is open. If a suggestion dropdown is open, the first Escape closes the dropdown. A second Escape closes the panel. If no dropdown is showing, Escape closes the panel immediately.

To reopen, use Ctrl+` or the ≡ button again. The panel remembers whether it was open or closed for the current session.

## Layout and Resizing

The panel sits to the right of the terminal. It **pushes** the terminal sideways rather than covering it. You keep sight of your command line and output at all times. When the panel opens or closes, the terminal resizes to fit the new width and output reflows automatically.

- **Default width:** 320px
- **Minimum width:** 240px
- **Resize:** Drag the vertical divider between the terminal and panel left or right.

You cannot make the panel narrower than 240px. If you drag past that limit, it snaps to the minimum. The panel has no fixed maximum width. Dragging too far right can make the terminal too narrow to use.

## Panel Contents

When a suggestion is highlighted (ghost text or dropdown selection), the panel shows everything known about that command. The layout is stacked vertically in a fixed order.

### Command Name

Large, bold, monospace text at the top. Matches the command exactly as you type it on the remote device.

### Syntax

A monospace block that shows the command structure with visual cues:

- **Required parameters** in the normal foreground color. You must type these for the command to work.
- **Optional parameters** (`[...]`) highlighted in the accent color. You can include them to change behavior but the command runs without them.
- **Placeholders** (`<name>`) in italic, marking spots where you substitute real values like interface names or IP addresses.

### Description

Plain language explanation of what the command does. Short commands get a single paragraph. More complex commands include notes about behavior, prerequisites, or things to watch for when the output is large.

### Examples

A list of concrete, runnable command examples, each in a monospace block. Every example is **clickable**. Clicking one writes the full command into your terminal input. The app sends it to the remote device as if you had typed it yourself.

Hover over an example to see the cursor change, confirming the row is interactive.

### Metadata

A muted row below a thin horizontal divider showing three fields:

- **Platform** — which OS the command belongs to (for example, IOS-XE, NX-OS, TMOS, Linux).
- **Version introduced** — the earliest OS version that supports this command.
- **Required CLI mode** — the mode you must be in for the command to work (for example, privileged-exec, global-config).

This row is intentionally de-emphasized. It answers the "can I run this right now?" question without competing with the description for attention.

### Tags

Topic labels such as `interfaces`, `routing`, `troubleshooting` that describe the functional area of the command. These help you scan for related commands at a glance. Tag-based filtering is planned for a future release.

### Official Docs

A link labeled **Official docs →** at the bottom of the panel. Clicking it opens the command reference page for the platform in your default browser. This is the official source documentation. Use it when you need more detail than the panel provides.

## Real-Time Updates

You do not need to close and reopen the panel to see different commands. The panel updates automatically as you type and navigate suggestions. Whichever suggestion is currently highlighted (ghost text or dropdown row) is the one whose details the panel displays.

For example, you start typing `show ip int`. The ghost text completes to `show ip interface brief` and the panel shows its details. You press **Tab** to cycle to the next match, or **Ctrl+Space** to open the dropdown. The panel switches instantly to the newly highlighted command.

The panel stays open and in sync the entire time. Nothing to manage.

## When to Use the Panel

| Situation | What the panel gives you |
|---|---|
| You are learning a command that you have never used before. | Syntax structure, plain-language description, and concrete examples you can click to run. |
| You recognize a command name but want to make sure that it is the right one. | Description and required mode let you check before you send anything to the device. |
| You need to run a command fast without typing it out. | Click any example and it executes immediately on the remote. |
| You want to check OS version compatibility. | The metadata row shows the minimum version so you do not run a command that does not exist on the target. |
| You need the official reference docs for a command. | The official docs link takes you straight to the correct page for that platform. |

## Related

- [Terminal & Suggestions](04-terminal-and-suggestions.md) — how ghost text and the dropdown work together.
- [Knowledge Base Overview](06-knowledge-base-overview.md) — where panel content comes from and how it stays up to date.
- [Keyboard Shortcuts](07-keyboard-shortcuts.md) — full shortcut reference including panel toggle and Escape behavior.
