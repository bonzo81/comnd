# Plan: KB Ignore/Disable + Delete Semantics Fix

Spec: docs/specs/10-custom-knowledge-base.md (open question line 102), docs/specs/06-knowledge-base.md.
Related: docs/plans/plan-custom-knowledge-base.md (Part 4 — delete/tombstone).

Goal: fix the critical bug where deleting an override command also hides the
bundled version, and add a non-destructive ignore/disable mechanism so users
can hide commands without destroying data.

## Background — current state (file:line)

Three command classes exist after merge (`merge_from`, kb.rs:435-449):

| Class | `source` | `overrides` | User copy exists? | Bundled copy exists? |
|---|---|---|---|---|
| bundled-only | none | none | no | yes |
| user-only custom | `"custom"` | `false` | yes | no |
| user override | `"custom"` | `true` | yes | yes |

### Delete path (kb.rs:889-943)

`delete_kb_command` does two things unconditionally:
1. Removes the command from the user category YAML (kb.rs:898-928).
2. **Always** inserts the name into `_deleted.yaml` (kb.rs:931-939).

The loader filters by `_deleted.yaml` after merge (kb.rs:591-599):
```rust
let user_deleted = Self::load_deleted_names(&user_platform_dir);
store.commands.retain(|c| !user_deleted.contains(&c.name));
```

This is correct for bundled-only commands (tombstone hides the bundled copy)
but **wrong** for overrides: removing the user copy + tombstoning the name
hides *both* copies. The UI at kb-viewer-dialog.ts:232 says "Restore built-in
version" — the actual behaviour is "delete both".

### Save path (kb.rs:855-882)

`save_kb_command` already removes the name from `_deleted.yaml` on save
(kb.rs:871-878), so re-saving a deleted bundled command resurrects it. This
works but is incidental — there is no explicit "restore" action.

### No ignore/disable mechanism exists

The only way to hide a command today is delete (tombstone). There is no
`_disabled.yaml`, no "Ignored" section in the viewer, and no way to hide a
command without losing its data.

## The bug

**Scenario:** user overrides `show ip route` with a custom version, then clicks
"Restore built-in version".

1. `delete_kb_command` removes the user copy from the category YAML.
2. `delete_kb_command` inserts `"show ip route"` into `_deleted.yaml`.
3. Loader filters: bundled `show ip route` is in `_deleted.yaml` → removed.
4. Result: command is gone entirely. UI promised "Restore built-in version" —
   got "delete both".

**Root cause:** `delete_kb_command` does not distinguish between the three
command classes. It always tombstones, which is only correct for bundled-only.

## Design

### Delete semantics (class-aware)

| Class | Action on delete | `_deleted.yaml` | Result |
|---|---|---|---|
| bundled-only | (no user copy to remove) | add name | Bundled hidden (tombstone). Correct today. |
| user-only custom | remove user copy | **do not** add name | Command gone. No tombstone needed — nothing to hide. |
| user override | remove user copy | **remove** name if present | Bundled resurfaces. "Restore built-in version" works. |

Implementation: `delete_kb_command` needs to know whether the command is an
override or user-only. Two options:

- **Option A (preferred):** Pass `overrides: bool` from the frontend. The
  frontend already has this field on every command in the viewer. No extra
  backend lookup.
- **Option B:** Backend checks whether a bundled copy exists by loading the
  bundled store. Adds I/O and couples delete to bundled path resolution.

Going with Option A. The Tauri command signature gains one parameter:
```rust
#[tauri::command]
async fn delete_kb_command(
    app: AppHandle,
    platform: String,
    category: String,
    name: String,
    overrides: bool,  // new
) -> Result<(), String>
```

Logic in `kb::delete_kb_command`:
```rust
// after removing from user YAML:
if overrides {
    // Remove from _deleted.yaml (un-tombstone) so bundled resurfaces
    let mut names = read_deleted_list(&platform_dir);
    if names.remove(command_name) {
        write_deleted_list(&deleted_path, &names)?;
    }
} else if !user_copy_existed {
    // bundled-only: tombstone (existing behaviour)
    names.insert(command_name.to_string());
    write_deleted_list(&deleted_path, &names)?;
}
// user-only custom: do nothing to _deleted.yaml
```

`user_copy_existed` is already computed as `removed > 0` at kb.rs:907.

### Ignore/disable (non-destructive)

Separate `_disabled.yaml` in the platform dir, same format as `_deleted.yaml`:
```yaml
disabled:
  - command-name-1
  - command-name-2
```

Semantics:
- **Disable** a command: add name to `_disabled.yaml`. Command data stays
  intact (user copy or bundled). Command is hidden from suggestions and viewer.
- **Enable/restore** a command: remove name from `_disabled.yaml`.
- Disable works for all three classes uniformly — no class-aware logic needed.
- A command can be both disabled and deleted (edge case, disable wins for
  display purposes since delete already removes data).

Loader change (kb.rs:591-599): filter by **union** of deleted + disabled:
```rust
let user_deleted = Self::load_deleted_names(&user_platform_dir);
let user_disabled = Self::load_disabled_names(&user_platform_dir);  // new
let hidden: HashSet<&str> = user_deleted.iter()
    .chain(user_disabled.iter())
    .map(String::as_str)
    .collect();
store.commands.retain(|c| !hidden.contains(c.name.as_str()));
```

### New backend functions

Mirror the existing deleted-list pair (kb.rs:687-721):

```rust
fn read_disabled_list(platform_dir: &Path) -> HashSet<String>
fn write_disabled_list(disabled_path: &Path, names: &HashSet<String>) -> Result<(), String>
```

New Tauri commands:
```rust
#[tauri::command]
async fn disable_kb_command(app: AppHandle, platform: String, name: String) -> Result<(), String>
#[tauri::command]
async fn enable_kb_command(app: AppHandle, platform: String, name: String) -> Result<(), String>
```

`disable_kb_command`: add name to `_disabled.yaml`. No category param needed —
disable is by name only (same as delete's tombstone path).

`enable_kb_command`: remove name from `_disabled.yaml`. Also remove from
`_deleted.yaml` if present (restore a deleted bundled command = same as save
without data, since the bundled copy still exists in resources).

### Viewer changes

1. **Detail panel button** (kb-viewer-dialog.ts:230-233):
   - Override: "Restore built-in version" (delete → un-tombstone) + new "Ignore" button.
   - Bundled-only: "Delete" (tombstone) + new "Ignore" button.
   - User-only: "Delete" (remove copy, no tombstone) + new "Ignore" button.

2. **Ignored section** in the viewer list:
   - New backend call `get_disabled_commands(platform)` returns names from
     `_disabled.yaml` (or raw commands if we want to show them greyed out).
   - Simplest: return `Vec<String>` of disabled names. Frontend shows a
     collapsible "Ignored (N)" section with the names and an "Enable" button
     per entry. No need to load full command data for ignored items.

3. **Suggestion engine:** no change. Disabled commands are filtered at load
   time in Rust, so they never reach the frontend suggestion path.

### Frontend API (tauri-api.ts)

```typescript
export async function disableKbCommand(platform: string, name: string): Promise<void>
export async function enableKbCommand(platform: string, name: string): Promise<void>
export async function getDisabledCommands(platform: string): Promise<string[]>
```

`deleteKbCommand` gains `overrides: boolean` parameter.

## Phases

### Phase 1 — Fix delete semantics (the bug)

- [ ] Add `overrides: bool` param to `kb::delete_kb_command` (kb.rs:889).
- [ ] Branch on class: override → un-tombstone; bundled-only → tombstone;
      user-only → no tombstone.
- [ ] Update Tauri command handler in lib.rs to pass through `overrides`.
- [ ] Update `deleteKbCommand` in tauri-api.ts to accept and pass `overrides`.
- [ ] Update kb-viewer-dialog.ts delete handler to pass `cmd.overrides`.
- [ ] Add Rust unit tests: delete override → bundled resurfaces; delete
      user-only → no tombstone entry; delete bundled-only → tombstone entry.

### Phase 2 — Ignore/disable mechanism

- [ ] Add `read_disabled_list` / `write_disabled_list` (kb.rs, mirror lines
      687-721).
- [ ] Add `load_disabled_names` to `KbStore` (mirror line 519).
- [ ] Update loader filter (kb.rs:591-599) to union deleted + disabled.
- [ ] Add `disable_kb_command` / `enable_kb_command` Tauri commands.
- [ ] Add `get_disabled_commands` Tauri command (returns `Vec<String>`).
- [ ] Add frontend API wrappers in tauri-api.ts.
- [ ] Add "Ignore" button to viewer detail panel.
- [ ] Add "Ignored" section to viewer list with enable buttons.
- [ ] Add Rust unit tests: disable → command filtered; enable → command
      resurfaces; disable + delete interaction.

### Phase 3 — Cleanup (optional, can defer)

- [ ] Update docs/plans/plan-custom-knowledge-base.md line 124 to correct the
      tombstone claim for overrides.
- [ ] Update docs/specs/10-custom-knowledge-base.md open question (line 102) —
      resolved by this plan.

## Data format

`_disabled.yaml` (new file, same location as `_deleted.yaml`):
```yaml
disabled:
  - show ip route
  - interface gigabitethernet 0/1
```

No migration needed — the file is created on first disable. Absence = empty
set (same pattern as `_deleted.yaml`).

## Tests

Rust unit tests in `kb.rs` test module:

1. **Delete override:** create bundled + user copy, delete with
   `overrides=true`, assert name NOT in `_deleted.yaml`, assert command still
   in loaded store (bundled version).
2. **Delete user-only:** create user-only command, delete with
   `overrides=false`, assert name NOT in `_deleted.yaml`, assert command gone
   from store.
3. **Delete bundled-only:** no user copy, delete with `overrides=false`,
   assert name IS in `_deleted.yaml`, assert command gone from store.
4. **Disable:** create command, disable, assert filtered from loaded store.
5. **Enable after disable:** disable then enable, assert command resurfaces.
6. **Disable + delete:** disable a bundled-only command, then delete it.
   Assert name in both lists. Enable → still gone (deleted wins for data,
   but name removed from disabled).

Frontend: manual verification via `npm run build` + app testing.

## Verification

- `cargo test` in `src-tauri/` — all new tests pass.
- `npm run build` — TypeScript compiles clean.
- Manual: override a bundled command, click "Restore built-in version",
  verify bundled version appears (not gone).
- Manual: disable a command, verify it disappears from suggestions and viewer;
  enable it, verify it returns.

## Open questions

1. Should "Ignored" commands be visible in the viewer list (greyed out) or
   fully hidden with only a count badge? Plan assumes greyed-out section —
   easier to discover and re-enable.
2. Should disable persist across app updates? Yes — it's in the user KB path,
   same as delete. No action needed.
3. Should `enable_kb_command` also remove from `_deleted.yaml`? Plan says yes
   (restore = full un-hide). Alternative: keep them independent and require
   separate "undelete" action. Simpler to unify for now.
