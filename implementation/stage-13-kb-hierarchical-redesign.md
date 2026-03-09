# Stage 13 — Knowledge Base Hierarchical Redesign + Linux Bash Pilot

**Goal:** Redesign the KB schema from flat command entries to a hierarchical tree model with two-tier entries (ghost-only and full), then pilot the new schema with a Linux Bash knowledge base. Ghost text coverage is the priority — having every command name available for suggestions matters more than every command having a full description.

**Spec refs:** `docs/06-knowledge-base.md` (schema, matching), `docs/05-suggestion-engine.md` (ghost text, dropdown, sidebar), `docs/02-technical-architecture.md` (performance)

---

## Why This Stage

The current flat KB works for ~60 hand-authored IOS-XE commands but doesn't scale. Two problems:

1. **No command hierarchy.** Commands like `show interface` have many subcommands (`trunk`, `status`, `stats`, `etherchannel`, `counters`, ...) but the schema can't represent them. Ghost text can only suggest exact pre-authored strings — it can't guide the user through a command tree.

2. **Full entries are expensive to author.** Every command currently needs `name`, `syntax`, `description`, `examples`, `versions`, `tags`. For ghost text, only the command name and mode matter. We need a lightweight "ghost-only" tier to rapidly add hundreds of commands, then flesh out descriptions/examples incrementally.

Linux Bash is the pilot platform because it has a single mode (`shell`) which simplifies testing.

---

## Steps

### 1. Update schema documentation in `docs/06-knowledge-base.md`

Add a new **Command Children** section describing the hierarchical model:

- Any command entry can have an optional `children` list
- Each child has: `name` (required), `description` (optional), `syntax` (optional), `aliases` (optional), `children` (optional, recursive)
- Children inherit `mode` from their parent — no need to repeat it
- Max recommended depth: 2 levels (parent → child → grandchild) for MVP

Add a **Two-Tier Entries** section:

- **Ghost-only entry**: only `name` and `mode` are required. All other fields are optional. Sufficient for ghost text suggestions.
- **Full entry**: includes `syntax`, `description`, `examples`, and optionally `children`. Shows rich detail in sidebar.
- The system treats both identically for prefix matching — the only difference is what the sidebar can display.

Update the field table to mark `syntax`, `description`, `category`, `examples`, `versions`, `tags` as optional.

Provide examples of both tiers and of hierarchical entries for IOS-XE and Linux Bash.

### 2. Update `Command` struct in `src-tauri/src/kb.rs`

Make most fields optional and add children support:

```
Command {
    name: String,                          // required
    mode: String,                          // required
    syntax: Option<String>,                // optional (ghost-only entries omit)
    description: Option<String>,           // optional
    category: Option<String>,              // optional
    aliases: Vec<String>,                  // default empty
    examples: Vec<CommandExample>,         // default empty
    versions: CommandVersions,             // default all-None
    tags: Vec<String>,                     // default empty
    children: Vec<CommandChild>,           // default empty
}
```

Add a new `CommandChild` struct:

```
CommandChild {
    name: String,                          // required (the subcommand/flag text)
    description: Option<String>,           // optional
    syntax: Option<String>,                // optional
    aliases: Vec<String>,                  // default empty
    children: Vec<CommandChild>,           // default empty (recursive)
}
```

All existing `#[serde(default)]` patterns continue to work. Make `description`, `syntax`, and `category` use `Option<T>` with `#[serde(default)]` so YAML entries that omit them deserialise cleanly.

### 3. Update `KbStore::load()` to flatten children into searchable entries

After loading YAML commands, build a flat index that combines parent + child names for prefix matching:

- Parent `show interface` (mode: `privileged-exec`) + child `trunk` → flat entry with `full_name: "show interface trunk"`, `mode: "privileged-exec"`
- Parent `ls` (mode: `shell`) + child `-l` → flat entry with `full_name: "ls -l"`, `mode: "shell"`

Create a `FlatCommand` struct (internal to kb.rs, not serialised):

```
FlatCommand {
    full_name: String,          // "show interface trunk"
    display_name: String,       // "trunk" (the child part, for display)
    source: FlatCommandSource,  // enum: Root(usize) | Child { root_idx, depth, child_path }
    mode: String,
    syntax: Option<String>,
    description: Option<String>,
    aliases: Vec<String>,       // flattened: parent aliases × child aliases
}
```

The `KbStore` gains:
- `flat_commands: Vec<FlatCommand>` — the searchable flat list
- Original `commands: Vec<Command>` kept for sidebar detail / tree display

The flattening logic:
- For each root command, emit one `FlatCommand` with `full_name = command.name`
- For each child, emit `FlatCommand` with `full_name = "{parent.name} {child.name}"`
- For grandchildren: `full_name = "{parent.name} {child.name} {grandchild.name}"`
- Aliases: for a parent with aliases `["sh int"]` and child `trunk`, also emit alias `"sh int trunk"`
- Sort all flat commands alphabetically by `full_name`

### 4. Update `KbStore::query()` to search flat commands

Replace the current query logic that searches `self.commands` with a search over `self.flat_commands`:

- Prefix match on `full_name` (name matches)
- Prefix match on `aliases` (alias matches)
- Mode and version filtering unchanged
- Return a new struct `QueryResult` (or adapt existing) that includes:
  - `full_name`, `display_name`, `mode`
  - `syntax`, `description` (may be None for ghost-only entries)
  - A flag or field indicating whether this is a root command or child

The return type for the Tauri IPC boundary should be a flat `Vec<QueryResultCommand>` that the frontend can consume directly.

### 5. Update Tauri command in `src-tauri/src/lib.rs`

Update the `query_kb` command handler to work with the new `KbStore::query()` signature. The Tauri IPC serialises `QueryResultCommand` structs to the frontend.

Also update `load_platform_index` if the `PlatformIndex` struct changed (it shouldn't for this stage).

### 6. Update `Command` interface in `src/lib/suggestion-engine.ts`

Match the new optional fields from Rust:

```typescript
interface Command {
    name: string;               // full_name from flat index
    syntax?: string;            // may be absent for ghost-only
    description?: string;       // may be absent for ghost-only
    category?: string;
    mode: string;
    aliases: string[];
    examples: { command: string; description: string }[];
    versions: { introduced: string; deprecated: string | null; notes: string | null };
    tags: string[];
    children?: CommandChild[];  // populated for root commands with children
}

interface CommandChild {
    name: string;
    description?: string;
    syntax?: string;
    aliases?: string[];
    children?: CommandChild[];
}
```

The `SuggestionEngine.query()` method needs no logic changes — it already does prefix matching on `name`. The flattened names from Rust include children, so `"show interface trunk"` is already in the list.

### 7. Update sidebar rendering in `src/lib/sidebar-content.ts`

Two changes:

**Graceful degradation for ghost-only entries:**
- If `description` is absent/empty → show `"No description available"` in muted text
- If `syntax` is absent → hide the syntax block
- If `examples` is empty → hide the examples section
- This lets ghost-only entries still appear in the sidebar without errors

**Children section for commands with children:**
- Below the existing detail, render a "Subcommands" or "Options" heading
- List each child as: `name` — `description` (or just `name` if no description)
- Children should be visually distinct: monospace for flags (`-l`, `--verbose`), normal text for keyword subcommands
- Clicking a child in the sidebar could send it to the terminal (stretch goal — wire in terminal-view.ts)

### 8. Update `loadKbCommands()` in `src/components/terminal-view.ts`

The mapping from `TauriCommand` to `SuggestionCommand` needs to handle optional fields:

- `syntax: c.syntax ?? ""` → `syntax: c.syntax ?? undefined`
- `description: c.description ?? ""` → `description: c.description ?? undefined`
- `category: c.category ?? undefined`
- Pass through `children` if present

No other wiring changes — ghost text, dropdown, and the suggestion pipeline all operate on the `name` field which is always present.

### 9. Populate `knowledge-base/linux-bash/index.yaml`

Fill in the platform metadata:

```yaml
id: linux-bash
name: Linux Bash
description: GNU Bash shell on Linux — core utilities, networking, system administration
reference_url: "https://www.gnu.org/software/bash/manual/"
versions: []
prompt_patterns:
  shell: '^\$|^.*[\$#]\s*$'
default_mode: shell
command_files:
  - filesystem.yaml
  - text-processing.yaml
  - networking.yaml
  - process.yaml
  - system.yaml
  - package.yaml
```

Note: `versions` stays empty — Linux commands don't have meaningful version filtering like Cisco IOS. `prompt_patterns` uses a basic `$` or `#` pattern (user-configurable PS1 makes this best-effort).

### 10. Create Linux Bash command YAML files

Create six files under `knowledge-base/linux-bash/commands/`. Use the two-tier approach: core commands get full entries with descriptions, examples, and flag children. Extended commands get ghost-only entries (name + mode).

**`commands/filesystem.yaml`** — ~20 commands
- **Full entries**: `ls`, `cd`, `cp`, `mv`, `rm`, `mkdir`, `find`, `chmod`, `chown`, `df`, `du`
  - `ls` has children: `-l`, `-a`, `-la`, `-lh`, `-R`, `-t`, `-S`, `--color`
  - `find` has children: `-name`, `-type`, `-mtime`, `-exec`, `-size`, `-maxdepth`
  - `chmod` has children: `+x`, `-R`, `u+rw`, `755`, `644`
- **Ghost-only entries**: `pwd`, `rmdir`, `ln`, `stat`, `file`, `touch`, `tree`, `locate`, `realpath`, `basename`, `dirname`

**`commands/text-processing.yaml`** — ~15 commands
- **Full entries**: `grep`, `awk`, `sed`, `cat`, `sort`, `head`, `tail`, `less`, `wc`, `diff`
  - `grep` has children: `-i`, `-r`, `-v`, `-n`, `-l`, `-c`, `-E`, `--color`
  - `awk` has children: `-F`, `'{print $1}'`
  - `sed` has children: `-i`, `-e`, `'s/old/new/g'`
- **Ghost-only entries**: `uniq`, `cut`, `tr`, `tee`, `more`, `fmt`, `paste`, `column`, `xargs`

**`commands/networking.yaml`** — ~15 commands
- **Full entries**: `ping`, `traceroute`, `ip`, `ss`, `curl`, `wget`, `dig`, `ssh`, `scp`, `rsync`, `tcpdump`
  - `ip` has children: `addr`, `route`, `link`, `neigh`, `netns`
  - `ss` has children: `-t`, `-u`, `-l`, `-n`, `-p`, `-a`
  - `curl` has children: `-X`, `-H`, `-d`, `-o`, `-s`, `-k`, `-v`
- **Ghost-only entries**: `nslookup`, `nc`, `nmap`, `host`, `ifconfig`, `route`, `arp`, `ethtool`, `mtr`

**`commands/process.yaml`** — ~12 commands
- **Full entries**: `ps`, `top`, `kill`, `systemctl`, `journalctl`, `jobs`, `bg`, `fg`
  - `ps` has children: `aux`, `ef`, `-ef`, `--forest`
  - `systemctl` has children: `start`, `stop`, `restart`, `status`, `enable`, `disable`, `list-units`, `daemon-reload`
  - `kill` has children: `-9`, `-15`, `-HUP`
- **Ghost-only entries**: `htop`, `killall`, `pkill`, `nohup`, `nice`, `renice`, `pgrep`, `lsof`, `strace`

**`commands/system.yaml`** — ~15 commands
- **Full entries**: `sudo`, `su`, `uname`, `hostname`, `uptime`, `date`, `whoami`, `id`, `env`, `export`, `alias`, `history`, `man`
  - `uname` has children: `-a`, `-r`, `-m`, `-s`
  - `sudo` has children: `-i`, `-u`, `-s`, `-l`
- **Ghost-only entries**: `which`, `type`, `printenv`, `set`, `unset`, `source`, `echo`, `printf`, `sleep`, `watch`, `time`, `cal`

**`commands/package.yaml`** — ~10 commands (mostly ghost-only)
- **Full entries**: `apt`, `yum`
  - `apt` has children: `install`, `remove`, `update`, `upgrade`, `search`, `list`, `autoremove`
  - `yum` has children: `install`, `remove`, `update`, `search`, `list`, `info`
- **Ghost-only entries**: `dnf`, `snap`, `pip`, `pip3`, `npm`, `cargo`, `brew`, `dpkg`, `rpm`, `flatpak`

Target totals: ~50 full entries, ~60 ghost-only entries, ~100+ flattened entries when children are counted.

### 11. Update existing IOS-XE YAML files with children (backward-compatible)

Add `children` to a few high-value existing entries as proof that the schema works for Cisco too:

- `show interfaces` in `networking.yaml` → add children: `status`, `trunk`, `description`, `counters`, `switchport`
- `show ip route` in `networking.yaml` → add children: `ospf`, `bgp`, `static`, `connected`, `summary`
- `show running-config` in `networking.yaml` → add children: `interface`, `section`, `| include`, `| begin`
- `systemctl` pattern already works for IOS-XE: `router ospf` → children could be `network`, `area`, `router-id` (stretch)

All existing entries without `children` continue to work unchanged (the field defaults to empty vec).

### 12. Extend Rust unit tests in `kb.rs`

Add test cases:

- **Ghost-only entry loads**: A command with only `name` and `mode` deserialises without error
- **Children flatten correctly**: A parent with 3 children produces 4 flat entries (1 parent + 3 children)
- **Child prefix match**: Searching `"show interface t"` matches `"show interface trunk"`
- **Alias × child combination**: Parent alias `"sh int"` + child `"trunk"` → `"sh int trunk"` is searchable
- **Existing IOS-XE tests still pass**: Run the full existing test suite to confirm backward compatibility
- **Linux Bash loads**: Load the `linux-bash` platform, verify command count matches expectations
- **Ghost-only sidebar**: A ghost-only entry returns `None` for description (frontend handles display)

---

## Files Modified

| File | Changes |
|------|---------|
| `docs/06-knowledge-base.md` | Add children schema, two-tier entries, updated field table |
| `src-tauri/src/kb.rs` | `Command` optional fields, `CommandChild` struct, `FlatCommand`, flattening in `load()`, `query()` rewrite |
| `src-tauri/src/lib.rs` | Update `query_kb` Tauri command return type |
| `src/lib/suggestion-engine.ts` | `Command` interface optional fields, `CommandChild` interface |
| `src/lib/sidebar-content.ts` | Graceful degradation, children/subcommands section |
| `src/components/terminal-view.ts` | `loadKbCommands()` handles optional fields |
| `knowledge-base/linux-bash/index.yaml` | Populated platform metadata |
| `knowledge-base/cisco-iosxe/commands/networking.yaml` | Add `children` to `show interfaces`, `show ip route`, `show running-config` |

## Files Created

| File | Purpose |
|------|---------|
| `knowledge-base/linux-bash/commands/filesystem.yaml` | File system commands (ls, cp, mv, find, chmod, ...) |
| `knowledge-base/linux-bash/commands/text-processing.yaml` | Text tools (grep, awk, sed, sort, ...) |
| `knowledge-base/linux-bash/commands/networking.yaml` | Network commands (ping, ip, ss, curl, ssh, ...) |
| `knowledge-base/linux-bash/commands/process.yaml` | Process management (ps, top, kill, systemctl, ...) |
| `knowledge-base/linux-bash/commands/system.yaml` | System utilities (sudo, uname, env, man, ...) |
| `knowledge-base/linux-bash/commands/package.yaml` | Package managers (apt, yum, dnf, pip, ...) |

---

## Verification

1. `cargo test` — all existing IOS-XE tests pass plus new tests for children, ghost-only entries, and Linux Bash loading
2. `npm run build` — TypeScript compiles cleanly with updated interfaces
3. `cargo tauri dev` → create a Linux Bash host → connect → verify:
   - Ghost text appears when typing `ls`, `grep`, `ssh`, `ping`, etc.
   - Typing `ls -` shows `-l` as ghost suggestion (first child)
   - Tab accepts the ghost suggestion and sends it to remote
   - Ctrl+Space opens dropdown showing all matching commands + children
   - Sidebar shows full detail for rich entries (description, examples, subcommands list)
   - Sidebar shows graceful placeholder for ghost-only entries
4. Connect to an IOS-XE device → verify:
   - Existing commands still suggest correctly
   - `show interface` now also suggests `show interface trunk`, `show interface status` etc. via children
   - All existing behaviour unchanged for commands without children
5. Check YAML parsing: deliberately create a ghost-only entry `{ name: test-cmd, mode: shell }` and verify it loads without error

---

## Technical Notes

- The flattening step happens once at load time, not per-query. This keeps query performance O(n) on the flat list, same as before.
- Children don't need their own `mode` — they inherit from the parent. This is safe because subcommands/flags are always valid in the same mode as the parent command.
- Alias expansion for children (parent alias × child) can generate many entries. For MVP, only combine parent aliases with direct children (depth 1), not grandchildren aliases. This keeps the index manageable.
- Linux Bash `prompt_patterns` regex is best-effort due to customisable PS1. The pattern `^\$|^.*[\$#]\s*$` catches common cases. Users on unusual prompts will still get suggestions — mode just won't filter (single `shell` mode anyway).

---

## Definition of Done

The KB schema supports hierarchical commands via `children` and ghost-only entries via optional fields. The Rust loader flattens children into searchable entries. Linux Bash has a fully populated KB (~110 entries across 6 files) with both full and ghost-only tiers. Ghost text suggests Linux commands including flag children. The sidebar gracefully handles missing descriptions. Existing IOS-XE functionality is unchanged. All tests pass.
