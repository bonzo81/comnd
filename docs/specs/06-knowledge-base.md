# Knowledge Base

## Design Principles

* Human-readable and human-editable (YAML)
* Version-aware — commands carry version applicability metadata
* Platform-scoped — one file per platform
* Shipped with the app, updatable independently of app releases
* Community-extensible in future

## Design Decision: Self-Contained Platform Files

Each platform is fully self-contained. Command descriptions are duplicated across platforms as needed — this is a knowledge base, not a codebase. Duplication is intentional:

* No cross-references to resolve at runtime
* Each platform file is independently editable
* Easy for contributors to add new platforms without understanding shared structure
* Platform-specific wording can diverge without affecting others

## File Structure

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

## Platform Index Schema (`index.yaml`)

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
negation_prefix: "no "             # optional; see Negation below
```

`prompt_patterns` are matched against the **entire trailing line** of output (the detector wraps each pattern in `^(?:…)$`). A pattern must describe the prompt alone, with nothing after it — if it also matched prompt + typed characters (e.g. `Router#sh`), prompt detection would re-fire while the user types, resetting the shadow buffer and wiping the ghost-text suggestion.

`secret_prompt_patterns` is an optional list of regex strings matched against the **entire trailing line** after the same idle window. A match clears and suppresses the shadow buffer and suggestions until the next normal prompt. Use narrowly scoped patterns for secret-entry prompts only; indexes may omit this field.

```yaml
secret_prompt_patterns:
  - '^\[sudo\] [Pp]assword for [^:]+:\s*$'
  - '^[Pp]assword:\s*$'
```

The `reference_url` is shown in the sidebar as "📖 Official docs →" — one link per platform pointing to the official command reference.

## Command Schema

All description/helper text lives inline in the command entry. This is what populates the sidebar when a user selects a suggestion. Use YAML block scalars (`|`) for multiline text.

`syntax` is the **human-readable display string**. It is derived from `tokens` when `tokens` is present and is the only syntax field a reader needs to look at. `tokens` is the **machine-readable** form used by the suggestion engine and (in future) per-argument help, validation, and device-enumerable tab-completion. Both are kept in sync by the author; the `syntax` string is not parsed at runtime.

When `tokens` is absent (legacy entries), the engine falls back to the current `name.startsWith(input)` behaviour against `name`/`aliases` and `syntax` is display-only.

```yaml
commands:
  - name: show ip interface brief
    syntax: "show ip interface [brief | <interface-name>]"
    tokens:                         # see Token Schema below
      - lit: show ip interface
      - choice: [brief]
        optional: true
      - var: interface-name
        type: enumerable
        source: device
        optional: true
    description: |
      Displays IP address, status, and protocol state for interfaces.

      Use 'brief' for a compact summary of all interfaces.
      Omit 'brief' and specify an interface name for full detail.
    category: networking
    mode: privileged-exec          # see Canonical Mode Values below
    order: fixed                    # see Order Rules below (optional, default fixed)
    negatable: false                # see Negation below (optional, default false)
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

## Token Schema

`tokens` is an ordered list. Each entry is one of four token kinds. Every entry may carry `optional: true` (default `false`). Tokens are matched positionally in `fixed` and `flags-anywhere` order modes (see Order Rules).

### Token kinds

**`lit` — literal keyword(s).** Fixed text the user must type. May be multi-word (e.g. `show ip interface`); whitespace within is significant. The matcher treats a multi-word `lit` as a single positional token; the engine matches it token-by-token against the input buffer. `lit` is the only token kind that contributes to prefix matching for the command itself.

```yaml
- lit: show ip interface
```

**`choice` — enumerated choice.** One of a fixed set of keywords. Modelled as a YAML list of strings. Used for flags that take a known keyword set (`permit | deny`, `in | out`, `brief | detail`). A `choice` of one element is valid (a single optional keyword). May carry `descriptions` — a map of option → meaning, shown in the dropdown choice rows and the sidebar token breakdown. Display-only; the matcher ignores it.

```yaml
- choice: [permit, deny]
- choice: [in, out]
  optional: true
- choice: ["-l", "-a", "-h"]
  optional: true
  repeatable: true
  descriptions:
    "-l": Long listing
    "-a": Include hidden files
    "-h": Human-readable sizes
```

**`var` — variable slot.** A free-form or device-enumerable placeholder. Carries `type` and `source`, and an optional `description` (display-only help text for the slot, e.g. "Interface, prefix, or route to show"):

```yaml
- var: interface-name
  type: enumerable      # enumerable | free | numeric | choice
  source: device        # device | kb | none     (only meaningful when type: enumerable)
  optional: true
```

| `type` | Meaning | Example variables |
|---|---|---|
| `enumerable` | A bounded set the device (or KB) can list | interface names, VLAN IDs, ACL names, route-map names |
| `free` | Unbounded free-form text | description text, route-map name being created, hostname |
| `numeric` | Numeric value, optionally bounded via `min`/`max` | OSPF process-id, BGP AS number, ping repeat count, VLAN ID when typed as a number |
| `choice` | Choice drawn from a dynamic list (e.g. known interface types) — rare; prefer `choice` token for static sets | — |

| `source` | Meaning |
|---|---|
| `device` | The live device knows the set (e.g. `show interfaces` lists interface names). Future hook for device tab-completion. MVP: ghost text shows the placeholder only. |
| `kb` | The KB carries a static example list via `values:` on the token (e.g. common interface type prefixes). |
| `none` | Not enumerable. Treated as `free` for matching purposes. |

A `var` may carry `values: [...]` for `source: kb` static lists, and `min`/`max` for `type: numeric`:

```yaml
- var: as-number
  type: numeric
  min: 1
  max: 4294967295
- var: interface-type
  type: enumerable
  source: kb
  values: [GigabitEthernet, TenGigE, Loopback, Vlan, Tunnel]
```

**`pipe` — pipe / filter separator.** First-class modelling of `|` (Cisco `| section`, `| include`, `| begin`, bash `|`). Followed by a `lit` or `var` naming the filter subcommand and a `var` for the filter argument. A command may declare `pipe` once at the end of its `tokens` to opt into pipe suggestions; absence means the command does not accept a pipe.

```yaml
- pipe: true                  # marks that a pipe is accepted here
  filters:                    # one entry per supported filter subcommand
    - lit: section
      var: regex
      type: free
    - lit: include
      var: regex
      type: free
    - lit: begin
      var: regex
      type: free
  optional: true
  repeatable: true            # pipes may chain (| include x | section y)
```

For bash pipelines (`cmd | grep ... | awk ...`), the same `pipe` token kind is used; the command's own `pipe.filters` list is empty or omitted (the post-pipe command is arbitrary), and the engine falls back to platform-level pipe-completion behaviour defined in `index.yaml` (post-MVP). MVP scope: model the token so the schema is not blocked; engine need not act on `pipe` beyond recognising it.

### Order Rules

The `order` field on the command controls how tokens are matched against the input buffer:

| `order` | Meaning | Typical platforms |
|---|---|---|
| `fixed` (default) | Tokens appear in the declared order. Optional tokens may be omitted but not reordered relative to required tokens. | Cisco IOS-XE, NX-OS, Arista EOS, F5 tmsh |
| `flags-anywhere` | Required positional tokens (`lit`, required `var`) keep their order; `choice` and optional `var` tokens may appear in any order after the last required token. | Linux bash (getopt-style), some NX-OS show filters |
| `free` | All tokens after the command stem may appear in any order. Rare; used for commands whose arguments are pure key/value filters (e.g. `show mac address-table` filters). | Cisco `show ...` filter chains |

If `order` is omitted it defaults to `fixed`.

### Negation

`negatable: true` declares that the platform's negation prefix may be applied to this command. The prefix itself is platform-defined in `index.yaml` (see Platform Index Schema below). MVP: the engine treats `no <name>` (Cisco) / `--no-<flag>` (linux) as a match on the same KB entry; a single `negatable` flag avoids duplicating `no shutdown`, `no ip route ...` etc. as separate commands.

```yaml
# cisco-iosxe/index.yaml
negation_prefix: "no "
```

```yaml
# the command
- name: shutdown
  negatable: true
  tokens:
    - lit: shutdown
  ...
```

Negation is opt-in per command. Not every command can be negated (e.g. `show` commands cannot).

### Prefix Commands

Some platforms have commands that can precede other commands: linux `sudo <cmd>`, F5 bash `tmsh <cmd>`. These are declared in `index.yaml`:

```yaml
# linux-bash
prefix_commands:
  sudo:
    unlocks: [shell]           # modes whose commands match after the prefix
    skip_flag_value: ["-u"]   # flag+value pairs skipped before the inner command

# f5-tmos
prefix_commands:
  tmsh:
    unlocks: [tmsh]
```

The engine detects `<prefix><space>` at input start, strips the prefix (and `skip_flag_value` pairs like `sudo -u root`), then matches the remainder against commands in the `unlocks` modes — regardless of the current prompt mode (so `tmsh list ltm virtual` works from bash). If the inner text matches nothing, matching falls back to normal behaviour so the prefix command's own KB entry (e.g. `sudo` with its `-u` flag, `tmsh` doc entry) still suggests. The prefix command should also have its own command entry (for its flags/description); inner commands are plain entries in their native mode — `tmsh list ltm virtual` is stored as `list ltm virtual` with `mode: tmsh`.

### Sub-mode context

The existing `mode` field already gates which commands appear in which prompt context. No new field is needed: a command like `ip address` carries `mode: interface-config`, and the prompt detector's mode state already filters it. The relationship to a parent command (e.g. `interface` enters `interface-config` where `ip address` applies) is implicit in the mode chain and does not need to be modelled in tokens. This is deliberate — the prompt is the source of truth for current mode, not the command history.

## Canonical Mode Values

Each platform defines its own mode values. Commands use these in the `mode` field.

**Cisco IOS-XE / NX-OS:** `user-exec`, `privileged-exec`, `global-config`, `interface-config`, `routing-config`, `line-config`

**F5 TMOS:** `tmsh-root`, `ltm`, `net`, `sys`, `bash`

**Linux bash:** `shell` (single mode — no sub-modes in MVP)

## Alias & Prefix Matching

Both the command `name` and all `aliases` are prefix-matched against the user's input buffer. For example, typing `sh ip` would match:

* `show ip interface brief` (via alias `sh ip int br`)
* `show ip route` (via name prefix)
* `show ip bgp summary` (via name prefix)

Matching is case-insensitive. Results ranked by: exact prefix match on name first, then alias matches, then by category relevance.

## KB File Organisation

Command YAML files within each platform are grouped by **command category** (not by command root). Categories map to functional areas a network engineer thinks in:

* `networking.yaml` — interfaces, IP, ARP, MAC tables
* `routing.yaml` — static routes, OSPF, BGP, EIGRP
* `switching.yaml` — VLANs, STP, port-channels
* `system.yaml` — hostname, NTP, logging, users
* `security.yaml` — ACLs, AAA, crypto
* `monitoring.yaml` — show commands for status, counters, logging

Each platform uses whatever categories make sense for it. Not all platforms need the same files.

## Version Filtering Logic

* If host has no OS version set in saved host settings → show all commands for that platform
* If host has OS version set → show commands where `introduced <= host_version` and `deprecated` is null or `deprecated > host_version`
* Commands with version caveats shown with a ⚠️ indicator

**Version comparison (MVP): major version matching.** The user enters a version string (e.g. `"17.6"`, `"16.12.4a"`) in the saved host settings. For comparison purposes, only the **major version** is used (first numeric segment): `"17.6"` → major `17`, `"16.12.4a"` → major `16`. Command `introduced: "16.0"` → major `16`.

A command is shown if its `introduced` major version ≤ host major version, and its `deprecated` major version (if set) > host major version.

This avoids the rabbit hole of cross-platform version string semantics (Cisco, F5, and Linux all use different formats). Granular sub-version filtering is a post-MVP enhancement if needed.
