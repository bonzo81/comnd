# Stage 03 — IOS-XE Pilot Knowledge Base

**Goal:** Build out a comprehensive Cisco IOS-XE command set as the pilot KB — enough to demonstrate the full suggestion experience across multiple modes and categories.

**Spec refs:** `docs/06-knowledge-base.md` (schema, categories), `knowledge-base/cisco-iosxe/index.yaml` (existing platform index), `CONTRIBUTING.md` (entry format)

---

## Why This Stage

The suggestion engine needs real data to be useful. IOS-XE is the pilot platform — the existing `index.yaml` is already complete with prompt patterns and versions. The `commands/networking.yaml` has 3 entries as templates. This stage fills out enough commands that we can test every suggestion feature end-to-end against a real IOS-XE device.

---

## Steps

### 1. Complete `knowledge-base/cisco-iosxe/commands/networking.yaml`

Expand from the current 3 commands to cover key networking commands in each mode. Target: **15-20 commands.** Include:

- **User exec mode**: `show version`, `show clock`, `show users`, `ping`, `traceroute`
- **Privileged exec mode**: `show ip interface brief`, `show ip route`, `show running-config` (existing), plus `show interfaces`, `show ip arp`, `show ip protocols`, `show ip bgp summary`, `show cdp neighbors`, `show mac address-table`, `show vlan brief`
- Include aliases where they exist (e.g. `sh` for `show`, `sh ip int br` for `show ip interface brief`)
- Include 1-2 examples per command with descriptions
- Set version `introduced` and `tags` per the schema
- Follow the exact YAML schema in `docs/06-knowledge-base.md`

### 2. Create `knowledge-base/cisco-iosxe/commands/routing.yaml`

Target: **10-12 commands.** Focus on configuration mode:

- **Global config mode**: `router ospf`, `router bgp`, `ip route` (static), `ip routing`
- **Router config mode**: `network`, `neighbor`, `redistribute`, `area`
- **Interface config mode**: `ip address`, `ip ospf`, `shutdown`, `no shutdown`
- Include `mode` field accurately per command context
- Include examples showing typical configuration sequences

### 3. Create `knowledge-base/cisco-iosxe/commands/system.yaml`

Target: **10-12 commands.** Mix of exec and config:

- **Privileged exec**: `copy running-config startup-config`, `write memory`, `reload`, `debug`, `undebug all`, `terminal length`
- **Global config**: `hostname`, `enable secret`, `service timestamps`, `logging`, `ntp server`, `banner motd`
- Include aliases (`wr` for `write memory`, `copy run start` for `copy running-config startup-config`)

### 4. Create `knowledge-base/cisco-iosxe/commands/security.yaml`

Target: **8-10 commands:**

- **Global config**: `access-list`, `ip access-list`, `username`, `enable secret`, `crypto key generate rsa`, `line vty`, `transport input`
- **ACL config mode**: `permit`, `deny`
- Include examples showing typical security configurations

### 5. Create `knowledge-base/cisco-iosxe/commands/monitoring.yaml`

Target: **8-10 commands:**

- **Privileged exec**: `show logging`, `show processes cpu`, `show memory`, `show environment`, `show inventory`
- **Global config**: `snmp-server community`, `snmp-server host`, `logging buffered`, `logging host`

### 6. Validate YAML schema compliance

- Every command entry must have: `name`, `syntax`, `description`, `category`, `mode`
- Optional fields: `aliases`, `examples`, `versions`, `tags`
- Mode values must match prompt pattern keys in `index.yaml`: `user_exec`, `privileged_exec`, `global_config`, `interface_config`, `router_config`, `line_config`
- Category must match the filename (e.g. `networking` for commands in `networking.yaml`)

### 7. Test KB loads correctly

After creating all files, verify:

- Each YAML file parses without errors (use the Stage 02 Rust loader)
- All commands are queryable via `query_kb`
- Mode filtering works correctly across the new command set
- Prefix matching finds commands across all category files

---

## Files Modified

| File | Changes |
|------|---------|
| `knowledge-base/cisco-iosxe/commands/networking.yaml` | Expand from 3 to 15-20 commands |

## Files Created

| File | Purpose |
|------|---------|
| `knowledge-base/cisco-iosxe/commands/routing.yaml` | Routing protocol commands (OSPF, BGP, static) |
| `knowledge-base/cisco-iosxe/commands/system.yaml` | System admin commands (reload, copy, hostname) |
| `knowledge-base/cisco-iosxe/commands/security.yaml` | Security commands (ACLs, auth, crypto) |
| `knowledge-base/cisco-iosxe/commands/monitoring.yaml` | Monitoring commands (show logging, SNMP) |

---

## Verification

1. `cargo test` passes — KB loader reads all new files successfully
2. `cargo tauri dev` → DevTools console → `queryKb({ prefix: "", platform: "cisco-iosxe" })` returns 50+ commands
3. `queryKb({ prefix: "show", platform: "cisco-iosxe", mode: "privileged_exec" })` returns a rich set of show commands
4. `queryKb({ prefix: "ip", platform: "cisco-iosxe", mode: "global_config" })` returns config-mode commands
5. `queryKb({ prefix: "router", platform: "cisco-iosxe", mode: "global_config" })` returns routing commands
6. Mode filtering: querying `user_exec` mode should NOT return `global_config` commands
7. Alias matching: querying `"sh ip int"` should match `show ip interface brief`
8. YAML validation: no parse errors in any file

---

## Definition of Done

The IOS-XE KB has 50+ commands across 5 category files covering networking, routing, system, security, and monitoring. All commands follow the schema, have accurate mode assignments, and are queryable with correct filtering.
