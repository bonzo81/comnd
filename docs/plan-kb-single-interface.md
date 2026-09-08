# Plan: One Interface for the Knowledge Base — Fold User-KB Mutations into KbManager

Candidate 3 from the architecture review. The knowledge base currently has
two parallel interfaces to the same store: `KbManager` (kb.rs:501–688)
answers queries, but every mutation goes through free functions taking a raw
`user_kb_path: &Path` (kb.rs:874–1036), forcing callers to re-derive the path
from config and call `reload_all()` afterwards. lib.rs pays this tax for the
four viewer mutations (save/delete/disable/enable at 1305–1444) plus the
`get_disabled_commands` read (1446–1457) — five copies of lock-config →
get-path → op — and four of them add a full `reload_all()`. The
load-bearing merge/tombstone logic (where a data-loss bug would live) is
untestable at the mutation level. The import path (`commit_kb_import`,
1230–1263) is deliberately out of scope here — see §1.3 and the non-goals.

Precedent: docs/10-custom-knowledge-base.md is the domain spec this implements;
plan-kb-ignore-disable.md added disable, plan-kb-index-source-and-save-validation.md
added save validation. Each feature bolted another free function onto the same
pattern. This plan ends the pattern.

---

## 1. The change

### 1.1 Mutations become methods on KbManager

Move the five free functions (kb.rs:874–1036) onto `KbManager` as methods.
The manager already holds `user_kb_path` (kb.rs:506) — the parameter deletes
itself. Reload happens **inside** the mutation:

```rust
impl KbManager {
    // Nested Result preserved: outer = plumbing error, inner Ok(Err(issues)) =
    // validation issues for the UI. Matches the current lib.rs:1321 contract.
    pub fn save_user_command(&mut self, platform: &str, category: &str, command: &Command)
        -> Result<Result<(), Vec<KbValidationIssue>>, String>;
    pub fn delete_user_command(&mut self, platform: &str, category: &str, name: &str, overrides: bool) -> Result<(), String>;
    pub fn disable_command(&mut self, platform: &str, name: &str) -> Result<(), String>;
    pub fn enable_command(&mut self, platform: &str, name: &str) -> Result<(), String>;
    pub fn disabled_commands(&self, platform: &str) -> Vec<String>;
}
```

Reload granularity — lazy today (`reload_all` just clears the HashMap,
stores re-load on next query, kb.rs:620–623) — stays lazy. Each mutating
method ends with `self.stores.remove(platform);` instead of a full
`reload_all()`: strictly cheaper, same semantics, and it means the mutation
path and the query path agree on invalidation without a second lock round.

The free functions stay as the file-write internals they already are —
methods become 3-line wrappers (write + invalidate). import.rs keeps calling
them: it takes explicit paths by design (it runs before/without the manager's
state) and commits via lib.rs's reload. No change there.

### 1.2 Validation moves inside `save_user_command`

The error-severity filter block (lib.rs:1359–1365) is policy that belongs
with the model, not the command handler. It moves into the method:
`save_user_command` returns `Ok(Err(issues))` on error-severity issues
(nested result preserved — the frontend contract is unchanged) and writes
only when clean. lib.rs:1321–1376 collapses to lock → parse tokens →
construct Command → one call.

### 1.3 What lib.rs keeps

Handlers become what `#[tauri::command]` handlers should be: parse
parameters, call the manager, map errors. The five config-lock blocks for
the viewer mutations (1322, 1386, 1408, 1430, 1451 — save, delete, disable,
enable, get_disabled_commands) disappear — the manager owns the path. The
import handlers (import_from_url at 1148–1151, extract preview at
1194–1197, commit_kb_import at 1238–1241) keep their config reads: they
pass the path into import.rs, which doesn't change. Consequence: import
remains a second write path into the same store with its own
`reload_all()` invalidation idiom (1170, 1259). That's accepted here —
import.rs's decoupling is plan-import-pipeline-seams' territory, and
unifying commit flow through the manager belongs to whichever of those two
plans lands second.

### 1.4 Small deletions along the way

- `load_deleted_names` (kb.rs:520–537) is a hand-rolled duplicate of
  `read_name_list` (694–706) — same file, same key. Replace its body with a
  call to `read_name_list(platform_dir, "_deleted.yaml", "deleted")`.
- `write_commands_to_yaml`'s `_category` param (kb.rs:776) is unused — drop
  it. Call sites: kb.rs:888, import.rs:405, and two test sites inside kb.rs
  (~1579, ~1600) — update all four or the tests won't compile.
- `KbManager.setVersion`/`_version` is Rust-side dead too? No — that was the
  frontend engine. Rust-side dead weight is only the two items above.

## 2. What this buys

- **One interface:** `query / get_all_commands / get_platform_index /
  list_platforms / save_user_command / delete_user_command /
  disable_command / enable_command / disabled_commands`. A future contributor
  (or AI agent) asks the manager, not the config-lock dance.
- **Leverage:** four call sites in lib.rs collapse; the next KB mutation
  (e.g. bulk enable) inherits reload-invalidation for free.
- **Locality:** mutation + invalidation in one method — the "forgot to
  reload" bug class becomes impossible *for the viewer mutation path* (the
  import path keeps its own idiom until plan-import-pipeline-seams unifies
  it).
- **Testability (the real win):** the merge logic in `write_commands_to_yaml`
  (field-preservation rules, kb.rs:799–843) and the 3-way tombstone
  branching in `delete_user_command` (overrides / user-only / bundled-only,
  957–987) are pure fs+YAML operations on paths. They're already testable —
  what's missing is the tests. Step 2 adds them.

## 3. Locking note

`AppState.kb` is a std `Mutex<KbManager>`; handlers currently take config
lock and kb lock sequentially (never nested — stated rule at lib.rs:438–439).
After this change the mutation handlers take only the kb lock. The config
lock disappears from the five handlers, which *reduces* lock traffic; no
ordering change, no new hazard. The pre-existing nested-lock inconsistency
in `netbox_get_status` (1112–1130) is out of scope here — candidate 5's
territory.

## 4. Steps

1. **Method-ify:** move the five free functions onto KbManager per §1.1,
   move the validation filter per §1.2, update the five lib.rs handlers.
   `cargo check` + `cargo test` (existing 42 kb tests must pass unchanged —
   they test the free functions, which stay).
2. **Tests:** new `#[cfg(test)]` cases in kb.rs exercising the *mutation*
   layer through KbManager with temp dirs (`KbManager::with_user_path` takes
   paths already — the seam exists; only tests are missing):
   - save → create / save → update-by-name merge (richer-field rules)
   - delete: overrides=true un-tombstones; user-only delete leaves no
     tombstone; bundled-only delete tombstones
   - disable/enable round-trip; hidden-filter union in `get_or_load`
   - save clears only that platform's cached store (mutation → next query
     sees it)
3. **Cleanup:** apply §1.4 deletions. `cargo test` green.

**Ordering note for plan-platform-registry:** it hooks `registry.rescan()`
onto the `reload_all()` sites this plan deletes (four of the six).
If that plan lands after this one, its rescan calls go inside these new
mutation methods (or take the registry as a param) — not the old lib.rs
sites. If it lands first, this plan's step 1 must move its rescan calls
into the methods.

## 5. Verification

- `cargo check` and `cargo test` in src-tauri/ after each step — existing
  42 kb tests untouched and passing.
- New tests per §4.2 (target: the tombstone trio + merge rules, ~8 cases).
- Manual: save/edit/delete/disable a command in the KB viewer against
  linux-bash; confirm suggestions update without app restart (the reload
  path the refactor must not regress).

## 6. Deliberate non-goals

- No kb.rs file split (model/store/user_kb modules) — the review suggested
  it, but with mutations folded in, the file is cohesive enough; split only
  if a future feature forces it.
- No change to import.rs's path-taking style — separate plan
  (plan-import-pipeline-seams). After both land, commit flow may still
  bypass the manager; unifying it is follow-up work neither plan owns yet.
- No frontend changes — IPC contract (params, nested Result) unchanged.