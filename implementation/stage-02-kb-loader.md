# Stage 02 — Knowledge Base Loader (Rust)

**Goal:** Implement the Rust KB module — load YAML files from disk into an in-memory index, expose a working `query_kb` Tauri command that returns filtered, prefix-matched results.

**Spec refs:** `docs/06-knowledge-base.md` (schema, matching), `docs/02-technical-architecture.md` (performance targets), `docs/05-suggestion-engine.md` (filtering)

---

## Why This Stage

The suggestion engine needs KB data. The Rust loader needs to exist before the frontend can query it. This is a self-contained backend module with clear inputs (YAML files) and outputs (command results) — perfect for isolated testing.

---

## Steps

### 1. Complete KB struct definitions in `src-tauri/src/kb.rs`

The file already has partial structs (`PlatformIndex`, `Command`, `CommandExample`, `CommandVersions`). Complete them to match `docs/06-knowledge-base.md` schema exactly:

- `PlatformIndex`: `id`, `name`, `description`, `reference_url`, `versions` (vec of version range objects), `prompt_patterns` (map of mode→regex), `default_mode`
- `Command`: `name`, `syntax`, `description`, `category`, `mode`, `aliases` (optional vec), `examples` (optional vec), `versions` (optional struct), `tags` (optional vec)
- `CommandExample`: `command`, `description`
- `CommandVersions`: `introduced` (optional), `deprecated` (optional), `notes` (optional)
- All structs need `#[derive(Debug, Clone, Serialize, Deserialize)]` for serde + Tauri IPC
- Use `serde_yml` for deserialization (NOT `serde_yaml`)

### 2. Implement the KB file loader

Add a `load_platform(platform_id: &str, kb_path: &Path) -> Result<(PlatformIndex, Vec<Command>), String>` function:

- Read `{kb_path}/{platform_id}/index.yaml` → deserialize to `PlatformIndex`
- Scan `{kb_path}/{platform_id}/commands/` directory for `*.yaml` files
- Each YAML file contains a `commands:` key with a vec of `Command` structs
- Deserialize and collect all commands into a flat vec
- Return the platform index + all commands

### 3. Implement the in-memory KB store

Create a `KbStore` struct that holds the loaded data:

- `platform: PlatformIndex`
- `commands: Vec<Command>` — sorted alphabetically by `name` for binary search
- A method `query(&self, prefix: &str, mode: Option<&str>, version: Option<&str>) -> Vec<&Command>` that:
  - Prefix-matches against `name` and `aliases` (case-insensitive)
  - Filters by `mode` if provided
  - Filters by version if provided (major version comparison: `introduced <= version` and (`deprecated` is null or `> version`))
  - Returns name-matches before alias-matches (stable sort)
  - Caps results to a reasonable limit (e.g. 50)

### 4. Implement version filtering

Per `docs/06-knowledge-base.md`:

- Parse version strings — major version only for comparison (e.g. "16" from "16.9")
- A command is included if: `introduced` is null or `introduced.major <= host_version.major` AND `deprecated` is null or `deprecated.major > host_version.major`
- If host version is null/unknown, skip version filtering entirely

### 5. Wire up the `query_kb` Tauri command

In `src-tauri/src/lib.rs`:

- Replace the stub `query_kb` command with a real implementation
- Parameters: `prefix: String`, `platform: String`, `mode: Option<String>`, `version: Option<String>`
- On first call for a platform, load from YAML and cache in app state (use `tauri::State<Mutex<HashMap<String, KbStore>>>`)
- Call `KbStore::query()` and return results as JSON-serializable vec

### 6. Add a `load_platform_index` Tauri command

- New command that returns just the `PlatformIndex` for a given platform ID
- This is needed by the frontend for prompt patterns and version info
- Parameters: `platform: String`
- Returns: `PlatformIndex`

### 7. Determine KB file path

- Bundled KB: `knowledge-base/` directory relative to the app's resource directory (use `tauri::AppHandle::path()` API)
- For development, the path is relative to the project root
- Use the Tauri resource API to resolve the correct path at runtime
- Register `knowledge-base` as a Tauri resource in `tauri.conf.json` under `bundle.resources`

### 8. Write Rust unit tests

Add `#[cfg(test)]` module in `kb.rs`:

- Test loading the existing `cisco-iosxe` platform (reads real YAML files)
- Test prefix matching: `"show ip"` should match `show ip interface brief` and `show ip route`
- Test mode filtering: commands with `mode: "privileged_exec"` should not appear when querying mode `"user_exec"`
- Test version filtering with mock data
- Test empty prefix returns all commands (for initial load)
- Test case-insensitive matching

---

## Files Modified

| File | Changes |
|------|---------|
| `src-tauri/src/kb.rs` | Full implementation: structs, loader, KbStore, query, tests |
| `src-tauri/src/lib.rs` | Replace stub `query_kb`, add `load_platform_index`, add KB state management |
| `src-tauri/tauri.conf.json` | Add `knowledge-base` to `bundle.resources` |

## Files Created

None — all work is in existing files.

---

## Verification

1. `cargo test` in `src-tauri/` — all KB unit tests pass
2. `cargo tauri dev` — app launches without errors
3. Open DevTools console → manually invoke `queryKb({ prefix: "show", platform: "cisco-iosxe", mode: "privileged_exec" })` via the JS console
4. Verify response contains the 3 existing IOS-XE commands (`show ip interface brief`, `show ip route`, `show running-config`)
5. Test with a non-matching prefix → empty results
6. Test with mode filter → only commands matching that mode appear
7. `load_platform_index("cisco-iosxe")` returns the full platform index with prompt patterns
8. Query completes in under 50ms (check DevTools network/performance timing)

---

## Definition of Done

The Rust backend can load any platform's KB from YAML, cache it in memory, and serve prefix-matched, mode-filtered, version-filtered results via Tauri IPC in under 50ms.
