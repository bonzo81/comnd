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
```

`prompt_patterns` are matched against the **entire trailing line** of output (the detector wraps each pattern in `^(?:…)$`). A pattern must describe the prompt alone, with nothing after it — if it also matched prompt + typed characters (e.g. `Router#sh`), prompt detection would re-fire while the user types, resetting the shadow buffer and wiping the ghost-text suggestion.

The `reference_url` is shown in the sidebar as "📖 Official docs →" — one link per platform pointing to the official command reference.

## Command Schema

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
