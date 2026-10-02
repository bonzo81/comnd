# Plan: Test Harness — One Fake for the Tauri Seam

Deepen the frontend test infrastructure into one module — the **test harness**
(`CONTEXT.md`) — that stands in for everything the app talks to: the Tauri
IPC seam, shared wire fixtures, and DOM scaffolding. Standalone plan from the
Sep 2026 test-architecture review (candidate 1, "One fake for the Tauri
seam"); it is the prerequisite that makes the device scripts (review
candidate 3) and the screen lifecycle tests (candidate 4) cheap to add later.

## Why (problem being solved)

Four unrelated idioms fake the same Tauri IPC seam today, and none of them
share code:

1. Global in-memory event bus — `tests/setup.ts:30-54` — which answers
   **every unmocked command with `undefined`** (`setup.ts:54`), so a
   forgotten mock reads as success (a silent false-green).
2. Copy-pasted `vi.mock` of the `tauri-api` module —
   `tests/settings-log-file.test.ts:3-22`,
   `tests/log-status-toast.test.ts:5-11`.
3. Monkey-patching `__TAURI_INTERNALS__.invoke` per test with manual
   save/restore — `tests/nav-context-menu.test.ts:15-23,35`.
4. Fixture literals hand-rolled per file, drifting from the real
   interfaces: the `AppConfig` in `settings-log-file.test.ts:27-37`
   carries `ollama_*` keys that no longer exist on
   `src/lib/tauri-api.ts:311-324` (4 unknown keys, 9 missing), and
   `nav-context-menu.test.ts:5` casts partial hosts `as never`.

Compounding the drift: `tsconfig.json:19` is `include: ["src"]`, so the
eight root `tests/` files are never type-checked — vitest transpiles
without checking. The drift above survived because of it.

The review's principle: the interface is the test surface. One deep module
with a narrow interface concentrates all the faking; tests stop hand-rolling
plumbing, and the first test of any screen gets cheap (~7,600 screen lines
are currently untested largely because of that setup cost).

## Goals / non-goals

**Goals**

- One module, `tests/harness.ts`, owning: a typed strict IPC fake, shared
  fixture factories, a DOM mount helper, and the environment polyfills
  (absorbed from `setup.ts`).
- Strict by default: invoking a command the harness did not mock throws
  with the command name. The escape hatch is an explicit
  `mock(cmd, undefined)` — no passthrough verb, no permissive mode.
- Explicit per-test instances: `const h = createHarness()` swaps in a fresh
  strict dispatcher and auto-restores the baseline bus after the test.
  Mock state is born and dies with the test.
- The lenient baseline bus (today's `setup.ts` behavior) remains for the 18
  test files that do not create a harness — they stay untouched and green.
- Mock by **wire name** (`"get_app_config"`), not by wrapper function — the
  wire is the seam; one fake covers `tauri-api` wrappers, the event plugin,
  and dialog plugin alike.
- Fixture factories typed against the real interfaces in `tauri-api.ts`
  (`Host`, `HostGroup`, `Command`, `AppConfig`) with realistic defaults, so
  any schema change fails `tsc` in the tests that use them.
- `tests/` brought under `tsc` (`include: ["src", "tests"]`); the fallout
  (the stale `AppConfig`) is fixed, not silenced.
- Migrate the three IPC-idiom files to the harness and delete their
  plumbing: `settings-log-file`, `log-status-toast`, `nav-context-menu`.
- The harness gets its own test file (`tests/harness.test.ts`) pinning its
  guarantees: strict throw, mock results, impl fallback, call log, event
  dispatch through the real `listen`, auto-restore, auto-removed mounts.

**Non-goals**

- No screen lifecycle changes (`mount(el)`/`destroy()` on components) —
  that is review candidate 4; `log-status-toast` keeps its test-local copy
  of `App.syncLogStatus` until then (known limitation, recorded here).
- No device transport work (`SessionTransport` adapters) — review
  candidate 3. `session-channel.test.ts`'s `InMemoryTransport` stays.
- No fixture-contract extension across Rust↔TS schemas — review candidate
  2. `suggestion-controller.test.ts`'s fake `Command` factory stays.
- No migration of the other 18 test files; they keep the baseline bus until
  they are touched.
- No `vitest.config.ts` changes (`setupFiles` still points at
  `tests/setup.ts`, which becomes a two-line entry).

## Detailed design

### Interface

```
install()                 // called once from tests/setup.ts
createHarness()           // per test; auto-restored via global afterEach
  h.ipc.mock(cmd, result)        // static result; `undefined` = "returns nothing"
  h.ipc.mockImpl(cmd, impl)      // dynamic: (args) => result | Promise<result>
  h.ipc.calls(cmd)               // recorded args list, in invoke order
  h.emit(event, payload)         // dispatch to listeners registered via real listen()
  h.mount()                      // <div> appended to body, removed after test
  h.fixtures.host(partial?)      // real Host defaults (id "h-1", bash platform, …)
  h.fixtures.hostGroup(partial?)
  h.fixtures.command(name, partial?)
  h.fixtures.appConfig(partial?) // current AppConfig shape (llm_*, log_*, session_*)
```

### Dispatchers

- `install()` installs today's event-bus behavior as the **baseline
  dispatcher** (lenient: `plugin:event|listen/unlisten/emit` handled,
  everything else resolves `undefined`) plus the crypto/matchMedia polyfills,
  and registers a global `afterEach` that restores any active harness.
- `createHarness()` swaps `__TAURI_INTERNALS__.invoke` to a **strict
  dispatcher** scoped to that harness: same three event commands (routed to
  a harness-scoped listener registry), mocked commands resolved from the
  registry, and anything else:

  ```
  harness: unmocked IPC command "get_app_config"
  ```

  `@tauri-apps/api` reads `invoke` at call time, so the swap works mid-test
  (`nav-context-menu.test.ts` already proves the mechanism).
- Harnesses stack; the global `afterEach` in `install()` pops and restores
  each one, so a test cannot leak a strict dispatcher into the next test.

### Fixture defaults

One canonical realistic set, not shortest-legal values: a linux-bash host,
an IOS-XE-style `Command` mirroring `suggestion-engine.test.ts`'s `mkCmd`
shape, and the **current** `AppConfig` (post-`llm_*` rename). Tests pass
only the fields they are *about*.

### Migrations

- `settings-log-file.test.ts` — delete both `vi.mock` blocks (tauri-api and
  plugin-dialog; no test exercises the dialog). `h.ipc.mock("get_app_config",
  h.fixtures.appConfig({ log_file_path }))`; assert `set_log_file_path` via
  `h.ipc.calls(...)`. The stale `ollama_*` config dies with `vi.mock`.
- `log-status-toast.test.ts` — delete the `vi.mock`; the test-local
  `syncLogStatus` copy now calls the real `getLogStatus` through the
  harness (`h.ipc.mock("get_log_status", …)`). Add a third case exercising
  the `log-location-warning` event through real `listen` + `h.emit` — a
  branch that has never been tested.
- `nav-context-menu.test.ts` — delete the invoke monkey-patch and its
  save/restore; `h.ipc.mock("get_hosts", [h.fixtures.host({...})])`,
  `h.ipc.mock("get_host_groups", [])`; `h.mount()` replaces manual container
  cleanup; the `as never` host cast becomes a real `Host`.

### Type-checking

`tsconfig.json` → `include: ["src", "tests"]`. Every root test file imports
its vitest globals explicitly from `"vitest"` (repo style anyway) so no
`types` entry is needed. The node `crypto` import in `setup.ts:1` is
replaced by a local `Math.random`-based `getRandomValues` polyfill so
`tsc` needs no `@types/node`.

## Tasks / checklist

- [x] `tests/harness.ts` — `install()`, `createHarness()`, strict
      dispatcher, fixture factories, mount helper
- [x] `tests/setup.ts` → thin `install()` entry (node crypto import gone)
- [x] `tsconfig.json` → `include: ["src", "tests"]`
- [x] Migrate `tests/settings-log-file.test.ts` (real `AppConfig` fixture)
- [x] Migrate `tests/log-status-toast.test.ts` (+ event-driven case)
- [x] Migrate `tests/nav-context-menu.test.ts` (real `Host` fixtures)
- [x] `tests/harness.test.ts` pinning the harness guarantees
- [x] Fix any remaining `tsc` fallout in `tests/` (none beyond the stale
      `AppConfig`, fixed by the migration)
- [x] `npm run build` exits 0
- [x] `npm run test` exits 0

## Verification

- `npm run build` and `npm run test` both exit 0 (AGENTS.md gate).
- Mutation check (do once, then revert): delete the `get_app_config` mock
  from a migrated test — the strict error must fail that test by name, not
  pass silently. This proves the false-green class is dead.
- Schema-drift check: add a field to `AppConfig` in `tauri-api.ts` — `tsc`
  must fail in `tests/` (proving the compiler now maintains fixtures).

## Risks / open questions

- **Dialog plugin wire name**: `settings-screen.ts` calls
  `save()`/`open()` from `@tauri-apps/plugin-dialog`; the harness fakes at
  the internals level, so the dialog is covered by the same seam when a
  test needs it (`"plugin:dialog|save"` — verify the exact command string
  from the plugin source at implementation time). No current test needs it.
- **Baseline leniency is intentional** for the 18 untouched files; strictness
  is a property of creating a harness. A future plan can migrate the rest
  opportunistically.
- **`log-status-toast` copy**: until candidate 4 gives screens a lifecycle
  interface, this test still pins a copy of `syncLogStatus`; the harness
  migration narrows the copy to the real `getLogStatus` call but cannot
  delete it.