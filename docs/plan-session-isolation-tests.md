# Plan: Session Isolation Unit Tests

Adds automated tests for the SSH session-isolation behavior that broke in
`b_1715_9200` (Date.now() session_id collision + unguarded `ssh-connected`
listener). Both bugs shipped undetected because neither `ssh.rs` nor
`terminal-view.ts` had test coverage. This plan closes that gap with the
minimum tests that would have caught each bug.

Two layers, each lazy:

1. **Rust unit tests** (`#[test]` in `ssh.rs`) — cover the backend half
   (session map keyed by id; collisions overwrite; send/resize/disconnect
   route by id). Zero new deps. Run via `cargo test`.

2. **Frontend unit tests** (vitest + `@tauri-apps/api/mocks`) — cover the
   frontend half (session_id minted uniquely; listeners ignore foreign
   session_ids; tab switching doesn't cross streams). Reuses Tauri's own
   mock IPC. Run via `npm test` (new script).

Layer 2 needs a framework install; layer 1 does not. Build layer 1 first,
ship it, then add layer 2 only if the frontend logic grows.

---

## 1. Backend Rust unit tests — `src-tauri/src/ssh.rs`

Add a `#[cfg(test)] mod tests` block at the bottom of `ssh.rs`, mirroring the
style in `hosts.rs:279-340` (plain `assert!`, no helpers beyond what each
test needs).

### 1.1 `SshManager` map behavior — pure state, no I/O

`SshManager::{insert_session, get_session, take_session, is_connected}` operate
on a `HashMap<u64, SshSession>`. The challenge: `SshSession` holds a live
`russh::client::Handle<ClientHandler>` and `russh::Channel<client::Msg>`, which
can't be constructed without a real SSH server.

**Approach:** extract the session map into a thin testable type.

```rust
// In ssh.rs — refactor SshManager to delegate the map to a pure type:
pub struct SessionMap {
    sessions: HashMap<u64, SshSession>,
}
impl SessionMap {
    pub fn new() -> Self { Self { sessions: HashMap::new() } }
    pub fn insert(&mut self, s: SshSession) { self.sessions.insert(s.session_id, s); }
    pub fn get(&self, id: u64) -> Option<&SshSession> { self.sessions.get(&id) }
    pub fn take(&mut self, id: u64) -> Option<SshSession> { self.sessions.remove(&id) }
    pub fn is_empty(&self) -> bool { self.sessions.is_empty() }
    pub fn len(&self) -> usize { self.sessions.len() }
    pub fn contains(&self, id: u64) -> bool { self.sessions.contains_key(&id) }
}
// SshManager holds SessionMap + the cfg(debug) test_server_handle.
```

This is a pure data refactor — no behavior change. `SshManager` methods become
one-line delegations. The diff is small and pays for itself in testability.

**Why not test `SshManager` directly?** `SshSession`'s fields aren't
constructable in a unit test (russh handles need a TCP socket). Wrapping the
map in `SessionMap` lets us test it by inserting stub `SshSession` values via
a test-only constructor.

**Test-only stub:** Add a `#[cfg(test)]` constructor on `SshSession`:

```rust
#[cfg(test)]
impl SshSession {
    fn test_stub(session_id: u64) -> Self {
        // Construct with dummy fields — only session_id is read by the map.
        // The real fields are exercised only by the async connect() path,
        // which integration tests (layer 3 below) cover.
        // ponytail: stub via mem::zeroed is unsafe; instead we refactor the
        // map to hold a generic trait object so tests can insert a fake.
        // See alternative below — simpler: don't construct SshSession at all.
    }
}
```

**Simpler alternative (preferred):** make `SessionMap` generic over the
session type so tests use a trivial stand-in.

```rust
pub struct SessionMap<S> { sessions: HashMap<u64, S> }
impl<S> SessionMap<S> {
    pub fn insert_with(&mut self, id: u64, s: S) { self.sessions.insert(id, s); }
    pub fn get(&self, id: u64) -> Option<&S> { self.sessions.get(&id) }
    pub fn take(&mut self, id: u64) -> Option<S> { self.sessions.remove(&id) }
    pub fn contains(&self, id: u64) -> bool { self.sessions.contains_key(&id) }
    pub fn is_empty(&self) -> bool { self.sessions.is_empty() }
    pub fn len(&self) -> usize { self.sessions.len() }
}
```

Then `SshManager` is `SessionMap<SshSession>` and tests use
`SessionMap<DummySession>` where `struct DummySession;`. The map logic is
identical — tests cover it without touching russh.

### 1.2 Test cases — `ssh.rs` tests module

| # | Test name | Asserts | Bug it catches |
|---|---|---|---|
| T1 | `test_insert_and_get` | insert id=1, `get(1)` returns Some, `get(2)` returns None | basic map wiring |
| T2 | `test_take_removes` | insert id=1, `take(1)` returns Some, subsequent `get(1)` is None, `take(1)` is None | disconnect cleanup |
| T3 | `test_distinct_ids_coexist` | insert id=1 and id=2, both `get` return Some, `len()==2` | the original collision bug — two sessions must not stomp each other |
| T4 | `test_duplicate_id_overwrites` | insert id=1 (A), insert id=1 (B), `get(1)` returns B, `len()==1` | documents the collision behavior the frontend must prevent by minting unique ids; this test pins the contract so a future "reject duplicate" guard would fail loudly here |
| T5 | `test_is_empty` | new map `is_empty()==true`; insert id=1 → `false`; `take(1)` → `true` | `is_connected()` correctness |
| T6 | `test_send_routes_by_session_id` | (unit test on `ssh_send` command body — see 1.3) | the "wrong host gets keystrokes" symptom |
| T7 | `test_resize_unknown_id_errors` | (unit test on `ssh_resize` body) | unknown-id path returns Err |

### 1.3 Command handler tests — `lib.rs`

`ssh_send` / `ssh_resize` / `ssh_disconnect` are `#[tauri::command] async fn`
that lock `AppState.ssh` and call `get_session`/`take_session`. They take
`tauri::State<'_, AppState>` which can't be built without a Tauri runtime.

**Approach:** extract the lock-and-route logic into plain functions on
`SshManager` (or `SessionMap`), then have the `#[tauri::command]` be a thin
wrapper. The plain functions are testable without Tauri.

```rust
// In ssh.rs — new methods on SessionMap<S>:
impl<S> SessionMap<S> {
    pub fn route_send(&self, id: u64) -> Result<(), String> {
        if self.contains(id) { Ok(()) } else { Err("No such session".into()) }
    }
    pub fn route_resize(&self, id: u64, _cols: u32, _rows: u32) -> Result<(), String> {
        if self.contains(id) { Ok(()) } else { Err("No such session".into()) }
    }
    pub fn route_disconnect(&mut self, id: u64) -> Result<(), String> {
        // take() returns Option; we drop the session (real impl awaits disconnect).
        self.take(id).map(|_| ()).ok_or_else(|| "No such session".into())
    }
}
```

The real `ssh_send`/`ssh_resize`/`ssh_disconnect` Tauri commands then lock the
state and call these. Tests exercise the routing without IPC. T6/T7 above
test these functions. The actual `session.send()`/`session.resize()` call
happens in the Tauri command wrapper — covered by integration tests (layer 3).

### 1.4 File touched

- `src-tauri/src/ssh.rs` — refactor `SshManager` to hold `SessionMap<S>`; add `#[cfg(test)] mod tests` with T1–T7.
- `src-tauri/src/lib.rs` — `ssh_send`/`ssh_resize`/`ssh_disconnect` call `SessionMap::route_*` after locking. No new tests in this file (routing is tested via `SessionMap`).

### 1.5 Verification

```powershell
cd src-tauri
cargo test                 # all 24 existing + 7 new = 31 tests pass
cargo check                # exit 0
```

---

## 2. Frontend unit tests — vitest + Tauri mocks

### 2.1 Framework install

```powershell
npm i -D vitest @tauri-apps/api/mocks jsdom
```

Add to `package.json` scripts:
```json
"test": "vitest run",
"test:watch": "vitest"
```

Add `vitest.config.ts` at repo root:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
  },
});
```

`tests/setup.ts`:
```ts
import { randomFillSync } from "crypto";
// jsdom lacks WebCrypto — Tauri mocks need it.
Object.defineProperty(window, "crypto", {
  value: { getRandomValues: (b: Buffer) => randomFillSync(b) },
});
```

### 2.2 Module-level session id minting — `tests/session-id.test.ts`

Tests the `nextSessionId` counter added in the bug fix
(`terminal-view.ts:62`). The counter is module-private; we test it indirectly
by importing the module fresh and checking that two `TerminalView` instances
get distinct ids, OR we export a `__test_nextSessionId()` getter behind
`#[cfg(test)]`-equivalent (`import.meta.env.MODE === "test"`).

**Preferred:** extract the counter into a tiny pure function and test that.

```ts
// src/lib/session-id.ts (new, ~5 lines)
let next = 1;
export function mintSessionId(): number { return next++; }
export function __resetSessionId() { next = 1; } // test only
```

`terminal-view.ts` imports `mintSessionId()` instead of the inline counter.

| # | Test name | Asserts | Bug it catches |
|---|---|---|---|
| F1 | `test_mint_unique` | two calls return distinct values | Date.now() collision |
| F2 | `test_mint_monotonic` | second > first | ordering guarantee |
| F3 | `test_reset` | after `__resetSessionId()`, next mint is 1 | test isolation |

### 2.3 Stale event filtering — `tests/ssh-listener-filter.test.ts`

The core frontend bug: `ssh-connected` listener overwrote `sessionId`
without filtering. The fix added the filter. Test it by simulating two
`ssh-connected` events with different `session_id` and asserting only the
matching one transitions the view to "connected".

`TerminalView` is a class with DOM + xterm dependencies — too heavy to
instantiate in jsdom directly. **Extract the listener filter into a pure
function** and test that.

```ts
// src/lib/session-filter.ts (new, ~10 lines)
export function shouldAcceptEvent(
  eventSessionId: number,
  viewSessionId: number,
): boolean {
  return eventSessionId === viewSessionId;
}
```

`terminal-view.ts`'s six listeners each call `shouldAcceptEvent(payload.session_id, this.sessionId)`. One pure function, six call sites, one test.

| # | Test name | Asserts | Bug it catches |
|---|---|---|---|
| F4 | `test_accept_matching` | `shouldAcceptEvent(5, 5)` → true | baseline |
| F5 | `test_reject_foreign` | `shouldAcceptEvent(6, 5)` → false | the original bug — host2's connected event must not overwrite host1's state |
| F6 | `test_reject_zero_when_view_unset` | `shouldAcceptEvent(0, 0)` → true (or false per desired semantics) | pins the "unset" edge case |

### 2.4 Tab manager state — `tests/tab-manager.test.ts`

`main.ts` `App` class manages `tabs: Map<hostId, SessionTab>`. The tab
switching bug ("both tabs show host2") was a symptom of the session_id bug,
not a tab-manager bug — but tab activation logic should still be covered.

Extract tab logic into a pure reducer to make it testable without DOM:

```ts
// src/lib/tab-state.ts (new)
export interface TabState { hostId: string; active: boolean; }
export function activateTab(tabs: TabState[], hostId: string): TabState[] {
  return tabs.map(t => ({ ...t, active: t.hostId === hostId }));
}
export function closeTab(tabs: TabState[], hostId: string): TabState[] {
  const next = tabs.filter(t => t.hostId !== hostId);
  if (next.length === 0) return next;
  // activate last remaining
  return next.map((t, i) => ({ ...t, active: i === next.length - 1 }));
}
```

`main.ts` `App.activateTab`/`closeTab` delegate to these. DOM side effects
(wrapper display, fit, focus) stay in `main.ts`; pure transitions move out.

| # | Test name | Asserts | Bug it catches |
|---|---|---|---|
| F7 | `test_activate_marks_one_active` | 3 tabs, activate middle → only middle `active==true` | regression: two tabs active |
| F8 | `test_close_activates_neighbor` | 3 tabs [a,b,c], close b → c active | the "switch to last remaining" path |
| F9 | `test_close_last_returns_empty` | 1 tab, close it → empty array | the "no tabs left → connections view" trigger |
| F10 | `test_close_nonexistent_noop` | close unknown id → unchanged | defensive |

### 2.5 Files touched / created

```
package.json                    — add vitest + jsdom devDeps; add test scripts
vitest.config.ts                — new
tests/setup.ts                  — new (crypto polyfill)
tests/session-id.test.ts        — new (F1–F3)
tests/ssh-listener-filter.test.ts — new (F4–F6)
tests/tab-state.test.ts         — new (F7–F10)
src/lib/session-id.ts           — new (extracted from terminal-view.ts)
src/lib/session-filter.ts       — new (extracted from terminal-view.ts)
src/lib/tab-state.ts            — new (extracted from main.ts)
src/components/terminal-view.ts — import the 3 extracted modules; delete inline counter + inline filter checks
src/main.ts                     — delegate activateTab/closeTab pure logic to tab-state.ts
```

### 2.6 Verification

```powershell
npm test          # F1–F10 pass
npm run build     # tsc + vite — exit 0
```

---

## 3. Skipped (add when asked)

- **Integration test against `test_server.rs`** — spin up the mock SSH server, open two real `SshSession`s, assert their `session_id`s differ and outputs don't cross. This needs a tokio runtime + the mock server already wired in `test_server.rs`. Adds ~1 test, ~40 lines. Skipped because layer 1 (unit tests on `SessionMap`) already catches the collision at the data layer; the integration test would be redundant until the connect path itself changes.
- **Frontend e2e via WebDriver** — Tauri's [WebDriver testing](https://v2.tauri.app/develop/tests/webdriver/) (Selenium/WebdriverIO). Big lift, separate session. Not needed to catch this class of bug.
- **Testing `extract_https_url` / `try_open_auth_url`** — pure functions in `ssh.rs:67-94`, easy to unit test, but out of scope for "session isolation." Add when auth-URL logic changes.

---

## 4. Order of work

1. Layer 1 (Rust `SessionMap` refactor + T1–T7). Run `cargo test`. Commit.
2. Layer 2 (vitest install + 3 extracted modules + F1–F10). Run `npm test` + `npm run build`. Commit.

Each layer ships independently and is verifiable. Layer 1 alone catches the
backend half of both bugs. Layer 2 catches the frontend half (the
`ssh-connected` filter regression) and tab switching.

---

## 5. What these tests would have caught

| Bug | Layer that catches it | Test |
|---|---|---|
| `Date.now()` collision (two tabs same session_id) | Layer 2 | F1, F2 — mint is unique+monotonic |
| Backend overwrites first session on duplicate id | Layer 1 | T3, T4 — distinct ids coexist; duplicate pins the contract |
| `ssh-connected` listener missing filter → both tabs show host2 | Layer 2 | F5 — foreign session_id rejected |
| `ssh_send` routes to wrong session after collision | Layer 1 | T6, T7 — routing keyed by id |
| Tab activation leaves two tabs active | Layer 2 | F7 — exactly one active |
| Close-tab doesn't activate neighbor | Layer 2 | F8, F9 |

Both shipped bugs (session_id collision + unguarded listener) would have
been caught by layer 2 before the user saw them.