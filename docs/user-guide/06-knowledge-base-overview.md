## What's Included

net.sh ships with four platform knowledge bases. Each KB is self-contained: commands are described in full for that platform, with no cross-references needed at runtime.

| Platform ID | Covers |
|---|---|
| `linux-bash` | General Linux/bash commands — networking, filesystem, process management, package tools |
| `cisco-iosxe` | Cisco IOS-XE — routers, Catalyst switches, ASR and ISR platforms |
| `cisco-nxos` | Cisco NX-OS — Nexus data centre switches |
| `f5-tmos` | F5 BIG-IP TMOS / tmsh — load balancers, application delivery controllers |

When you connect to a device, you select the platform in the host configuration. net.sh loads that platform's knowledge base and uses it for suggestion matching. If you change the platform assignment, the suggestion data changes immediately — no restart needed.

## How Version Filtering Works

Commands in the knowledge base carry version information: when they were introduced, and when they were deprecated (if ever). This lets net.sh filter suggestions to match the actual OS running on your device.

**When you set an OS version** in the host settings (for example, `17.6` or `9.3(5)`):
- Commands introduced *after* your version are hidden
- Commands deprecated *before* your version are hidden
- Only commands valid for your exact version appear in suggestions

**When no OS version is set**, all commands for the platform are shown, regardless of version constraints.

**Example:** A Cisco IOS-XE host set to OS version `17.6` will see commands introduced in 17.x and earlier that are still current. Commands exclusive to 18.x releases won't appear. Commands deprecated in 16.x releases also won't appear.

Version comparison uses the **major version number** (the integer before the first dot). For `17.6`, the major version is `17`. This keeps filtering simple and predictable.

Commands that carry version caveats — such as "changed behaviour in 17.3" or "requires 15.2 or later" — show a warning indicator (⚠️) in the suggestion list so you know to check compatibility details before trusting a stored description.

## How Mode-Aware Filtering Works

net.sh detects the current CLI mode from the device prompt. This determines which commands are suggested at any moment.

**How it works:**
- After each command completes, net.sh reads the prompt the device sends back
- It matches the prompt against mode patterns defined for the platform
- Only commands valid for the detected mode are shown in suggestions

**Example:** On a Cisco IOS-XE device:
- In `Router#` (privileged exec mode) → you see `show` commands, `ping`, `traceroute`
- In `Router(config)#` (global config mode) → you see config commands like `hostname`, `interface`, `ip route`
- In `Router(config-if)#` (interface config mode) → you see interface-specific config commands like `ip address`, `shutdown`

The current mode is displayed in the **status bar** at the bottom of the terminal view.

If net.sh can't determine the mode (for example, the prompt format is non-standard), it shows all commands for the platform — so you never lose access to suggestions.

## How Suggestions Are Matched

As you type in the terminal, net.sh looks through the knowledge base for matches. Here's what it checks:

1. **Command names** — the full command string (for example, `show ip interface brief`)
2. **Aliases** — common shorthand forms stored in the KB (for example, `sh ip int br`)

The search is **case-insensitive**, so typing `SH`, `sh`, or `Sh` all produce the same results.

**Example:** Typing `sh ip` on a Cisco IOS-XE device might match:
- `show ip interface brief` (via alias `sh ip int br`)
- `show ip route` (via command name prefix `show ip route`)
- `show ip bgp` (via command name prefix)

**How results are ordered:**
1. Exact name prefix matches appear first
2. Alias matches appear next
3. Within each group, commands are ordered by category relevance

For a deeper look at the full suggestion UI, see [Terminal & Suggestions](04-terminal-and-suggestions.md).

## Where the Knowledge Base Lives

The knowledge base is bundled with the app in the install directory. You can browse, edit, or extend it — all files are plain YAML (a human-readable data format, similar to a structured text file).

- **Viewing:** Open the `knowledge-base/` directory inside your net.sh installation
- **Editing:** You can modify command entries, add new commands, or create entirely new platform knowledge bases
- **Updating:** KB updates can be downloaded and installed independently of app updates, so command data stays current without waiting for a full release

For detailed instructions on editing and extending the KB, see [Customizing the Knowledge Base](11-customizing-knowledge-base.md).

## See Also

- [Connecting to Devices](03-connecting-to-devices.md) — setting the platform and OS version for a host
- [Terminal & Suggestions](04-terminal-and-suggestions.md) — the suggestion UI and how to interact with it
- [Customizing the Knowledge Base](11-customizing-knowledge-base.md) — editing, adding, and updating command data
- [Troubleshooting](10-troubleshooting.md) — what to check when suggestions aren't matching as expected
