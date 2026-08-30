# Settings

## Opening Settings

Press `Ctrl+,` (comma) or click **File → Settings** in the menu bar.

The settings panel slides open from the right side of the window. It pushes the terminal — it does not overlay it. Press `Escape` to close.

## Available Settings

The settings screen is deliberately minimal. Here is what you can configure:

### Terminal font size

Default is `14px`. You can adjust it two ways:

- **In-session:** `Ctrl++` to increase, `Ctrl+-` to decrease. The change applies immediately.
- **In settings:** type a value or use the stepper control.

Your chosen size persists across sessions. The app saves the size to the settings file and restores it on the next launch.

### Theme

By default, the theme follows your OS light/dark preference automatically.

Switch to the **Appearance** section to override:

- **Follow system** — the default. Picks up your OS setting without any input from you.
- **Dark** — force dark theme regardless of OS preference.
- **Light** — force light theme regardless of OS preference.

The change takes effect immediately. No restart needed.

### Knowledge base update channel

This setting controls how command-suggestion data is updated. It is currently a placeholder and not yet implemented.

- **Auto (recommended)** — download and apply KB updates in the background as they are released.
- **Manual confirmation** — notify when an update is available but wait for your approval.

When this feature ships, you will find it in the settings panel. For now, the knowledge base is distributed with the app and updated through normal app releases.

## Keyboard Shortcuts Reference

For the full shortcut table, see [Keyboard Shortcuts](07-keyboard-shortcuts.md) — including the ones that work inside an active terminal session.

## Next Steps

- [Terminal & Suggestions](04-terminal-and-suggestions.md) — how input handling and ghost text work
- [Getting Started](02-getting-started.md) — first session walkthrough if you have not read it yet
