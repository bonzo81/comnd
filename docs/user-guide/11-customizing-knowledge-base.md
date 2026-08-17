## Where the Knowledge Base Lives

net.sh ships with a built-in knowledge base inside the app install directory under `knowledge-base/`. The app also creates an editable copy in your app data directory:

| OS | Path |
|---|---|
| Windows | `%APPDATA%\net.sh\knowledge-base\` |
| macOS | `~/Library/Application Support/net.sh/knowledge-base/` |
| Linux | `~/.config/net.sh/knowledge-base/` |

On startup, net.sh checks for the user copy. If it exists, that copy is used. If not, the app falls back to the built-in copy. This means you can modify your knowledge base without touching the app install, and your changes won't be lost when the app updates.

The file structure mirrors the built-in layout:

```
knowledge-base/
  cisco-iosxe/
    index.yaml
    commands/
      networking.yaml
      routing.yaml
      system.yaml
      security.yaml
      monitoring.yaml
  cisco-nxos/
  f5-tmos/
  linux-bash/
```

Each platform is self-contained. Command files live under `commands/` and are grouped by topic — networking, routing, system, etc. The app discovers them automatically, no registration needed.

## Platform Index (`index.yaml`)

Each platform directory contains an `index.yaml` with metadata, supported versions, and prompt detection patterns:

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
  privileged-exec: '^[\w\-]+#'
  global-config: '^[\w\-]+\(config\)#'
  # ... additional modes
command_files:
  - commands/networking.yaml
  - commands/routing.yaml
```

You generally don't need to edit this file unless you're adding a new platform or changing version ranges. If you modify `prompt_patterns`, the app picks them up on the next connection. If you add a new category file, add its path to `command_files`.

For more on how the knowledge base works, see [Knowledge Base Overview](06-knowledge-base-overview.md).

## Adding a Command

Open the relevant category file under `knowledge-base/<platform>/commands/`. Add a new entry to the `commands` list. Order doesn't matter — entries are found by name.

Here's a minimal working entry:

```yaml
commands:
  # ... existing entries ...
  - name: show ip ospf neighbor
    syntax: "show ip ospf [<process-id>] neighbor [detail]"
    description: |
      Displays OSPF neighbor adjacency information.
      Shows neighbor state, priority, dead time, and interface.
    category: routing
    mode: privileged-exec
    aliases:
      - sh ip ospf nei
    examples:
      - command: show ip ospf neighbor
        description: All OSPF neighbors
      - command: show ip ospf neighbor detail
        description: Per-neighbor state, DR/BDR, and timers
    versions:
      introduced: "12.0"
    tags:
      - ospf
      - routing
```

### Required Fields

**`name`** — The full command string. Used for matching as the user types.

**`syntax`** — The command with placeholders. Use `<placeholder>` for required parameters and `[optional]` for optional ones. This is displayed in the side panel.

**`description`** — What the command does and when to use it. This is the main text shown in the side panel. Use a YAML block scalar (the `|` symbol) for descriptions that span multiple lines — it keeps the text readable in the file.

**`category`** — Logical grouping: `networking`, `routing`, `system`, `security`, `monitoring`, and so on. Must match an existing category used in other entries.

**`mode`** — Which CLI mode the command is valid in. The mode must be one defined in the platform's `index.yaml` prompt patterns. Common values for Cisco platforms: `user-exec`, `privileged-exec`, `global-config`, `interface-config`, `routing-config`. For F5: `tmsh-root`, `ltm`, `net`, `sys`. For Linux: `shell`.

**`examples`** — At least one example with a `command` and `description`. These appear as clickable entries in the side panel for quick reference.

### Optional Fields

**`aliases`** — Common abbreviations engineers actually type. Aliases are matched just like the command name. For example, the alias `sh ip ospf nei` means typing `sh ip o` will match `show ip ospf neighbor`.

**`versions.deprecated`** — Set to a version string if the command was removed. Commands with `deprecated` set are hidden on devices running that version or later.

**`versions.notes`** — Free-form text for version caveats. Displayed with a warning indicator in the side panel.

**`tags`** — Search keywords that help surface the command even when the typed prefix doesn't match. Use lowercase, keep consistent with existing entries.

**`submode`** — If the command enters a sub-configuration mode (like `router ospf`), specify it here. The app uses this to update mode detection context.

**`see_also`** — List of related command names. Displayed as cross-references in the side panel.

## Editing an Existing Command

Find the entry in the relevant category file and modify any field. Changes take effect on the next connection. No restart required.

Common edits:

- Fix a description that is unclear or inaccurate
- Add missing aliases
- Update version info (`introduced`, `deprecated`)
- Add or correct examples
- Add `see_also` links to related commands

## Adding a New Category File

Create a new `.yaml` file in the platform's `commands/` directory. The filename becomes the category identifier. Structure it like any other category file:

```yaml
commands:
  - name: show spanning-tree
    syntax: "show spanning-tree [vlan <vlan-id>]"
    description: |
      Displays spanning-tree protocol state and topology.
    category: switching
    mode: privileged-exec
    examples:
      - command: show spanning-tree
        description: Full STP topology
    versions:
      introduced: "12.0"
    tags:
      - stp
      - switching
```

Then add the new file to `command_files` in `index.yaml`. The app picks it up on the next connection.

Categories map to functional areas. Not all platforms need the same set. Add only the files relevant to the platform you're working with.

## Best Practices

**Include the aliases people actually use.** Engineers rarely type full commands. `sh ip int br` is more common than `show ip interface brief`. Add both.

**Write practical descriptions.** Don't just repeat what the command does. Say when an engineer would reach for it and what output to expect.

**Use block scalars for descriptions.** The `|` symbol preserves line breaks and makes multi-line text readable in the YAML source.

**Keep tags lowercase and consistent.** If existing entries tag OSPF commands as `ospf`, don't introduce `OSPF` or `ospf-routing`.

**Test your changes.** Connect to a device of that platform after editing. Type a prefix that should match your new or modified command and confirm it appears in suggestions. Check the side panel shows correct information.

## Next Steps

- [Terminal & Suggestions](04-terminal-and-suggestions.md) — how your custom commands appear to users
- [Installation](01-installation.md) — where the bundled and user knowledge bases live on each OS
