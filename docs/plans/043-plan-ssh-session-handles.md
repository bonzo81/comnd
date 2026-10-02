# Plan: Session Handles — No Global Lock on the Keystroke Path

Candidate from the architecture review (September 2026). This plan is
self-contained; it does not depend on the review session.

## Problem

All SSH sessions live behind one `tokio::sync::Mutex<SshManager>`
(`src-tauri/src/state.rs:22`), and the hot-path commands hold that lock
**across network awaits**:

- `ssh_send` (`src-tauri/src/ssh.rs:1037–1047`) — locks, `route_send`,
  `get_session`, then `session.send().await` with the guard held.
- `ssh_resize` (`ssh.rs:1062–1073`) — same shape, `session.resize().await`.
- `ssh_disconnect` (`ssh.rs:1050–1059`) — takes the session out of the map,
  then awaits `session.disconnect()` with the guard held.

Consequences:

1. **Every keystroke from every terminal serializes through one lock.**
   If one session stalls on TCP backpressure (`channel.data` blocks), all
   terminals in the app freeze — their sends, resizes, and disconnects all
   queue behind the same mutex. AGENTS.md's core constraint is keystroke
   latency; this is the biggest latency hazard in the backend.
2. **Remote-closed sessions are never evicted.** `channel_close`,
   `channel_eof`, and `disconnected` (`ssh.rs:293–332`) emit
   `ssh-disconnected` events but leave the session in the map. Cleanup is
   entirely on the frontend calling `ssh_disconnect`. Until then,
   `session_count()` overstates live sessions, which feeds the
   `max_sessions` check in `ssh_connect` (`ssh.rs:986–995`).
3. `SessionMap::route_send` / `route_resize` (`ssh.rs:718–724`) are guards
   that duplicate what `get_session`'s `Option` already expresses — dead
   interface surface that the commands must call before the real lookup.

Deletion test: the lock is not the interface — the *session* is. Storing
owned handles behind the map lookup keeps `SessionMap` (its test seam is
real: tests insert `DummySession` without a TCP connection) and deletes
the "one lock serializes everything" property. Concentrates.

## Solution

Store sessions as `Arc<SshSession>` in the map. Commands take the lock
only to look a session up, clone the handle, **drop the guard, then await
on the handle**. Remote-close events evict the dead session. No frontend
change — `sshSend` / `sshResize` / `sshDisconnect` IPC signatures are
identical.

Why `Arc` is sufficient (no per-session Mutex): `SshSession::send` and
`resize` take `&self` (`ssh.rs:657–670`) because russh's
`Channel::data` / `Channel::window_change` are `&self` and internally
synchronized. Concurrent send + resize on one session is already safe
today; the only thing the global lock added was cross-session
serialization.

## 1. Handles in `SessionMap` (mechanics, no command moves yet)

1. `SshSession::disconnect` (`ssh.rs:672–678`): change `disconnect(self)`
   → `disconnect(&self)`. russh's `client::Handle::disconnect` takes
   `&self`, so consuming the struct is unnecessary. (If the compiler
   disagrees with this claim for the pinned russh version:
   `client::Handle` is `Clone` — clone it and disconnect through the
   clone. One line either way.)
2. `SessionMap` (`ssh.rs:686–725`): store `HashMap<u64, Arc<S>>`.
   - `insert_with(&mut self, id: u64, s: S)` wraps: `Arc::new(s)`.
   - `get(&self, id: u64) -> Option<Arc<S>>` clones the Arc out.
   - `take(&mut self, id: u64) -> Option<Arc<S>>` — unchanged semantics,
     now returns the handle.
   - Delete `route_send` / `route_resize` and the `SshManager`
     delegations of the same names (`ssh.rs:761–767`). `get_session`'s
     `Option` replaces the guard.
3. Existing tests (`ssh.rs:783–859`) keep compiling unchanged except:
   - delete `test_route_send_by_session_id` and
     `test_route_resize_unknown_id_errors` (they pin deleted surface);
   - add `test_get_returns_shared_handles`: two `get(id)` results satisfy
     `Arc::ptr_eq` — pins the handle semantics.
4. `cargo check` + `cargo test` green before touching any command.

## 2. Commands drop the guard before the await

New bodies (the lock scope ends at the `}` — before the network await):

```rust
#[tauri::command]
pub async fn ssh_send(
    session_id: u64,
    data: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let session = {
        let mgr = state.ssh.lock().await;
        mgr.get_session(session_id)
            .ok_or_else(|| "Session not found".to_string())?
    };
    session.send(data.as_bytes()).await
}
```

- `ssh_resize`: same shape, `session.resize(cols, rows).await`.
- `ssh_disconnect`: `take_session` inside the scope, `disconnect().await`
  outside it. `None => Ok(())` — unchanged, and it already tolerates the
  eviction race (§3).
- `ssh_connect` (`ssh.rs:933–1034`): the insert stays
  `mgr.insert_session(session)` (`insert_with` wraps in the Arc now).
  Add a `# ponytail:` comment on the max-sessions check naming the
  check-then-act ceiling:
  `// ponytail: max-sessions check races concurrent connects (over-limit by at most the burst size); reserve a map slot at check time if it ever matters`

## 3. Evict on remote close

In `ClientHandler` (`ssh.rs:158+`), add one private helper and call it
from the three close paths after their `ssh-disconnected` emits
(`ssh.rs:293–332`):

```rust
/// Remove a dead session from the map so session_count stays honest.
/// Idempotent: close/eof/disconnect can all fire for one session.
async fn evict(app_handle: &tauri::AppHandle, session_id: u64) {
    use tauri::Manager;
    let state = app_handle.state::<AppState>();
    let mut mgr = state.ssh.lock().await;
    if mgr.take_session(session_id).is_some() {
        log::debug!("Evicted session {} after remote close", session_id);
    }
}
```

Notes:

- `AppState` is Tauri-managed (commands receive it as
  `tauri::State<'_, AppState>`), so `app_handle.state::<AppState>()` is
  the same store the commands use. No new state plumbing.
- The eviction lock is held only across `take_session` — no await inside
  the scope — so it does not reintroduce the hold-across-await problem.
  Keep it that way.
- Eviction makes `session_count()` honest for the `max_sessions` gate
  and means a user-initiated `ssh_disconnect` after a remote close is a
  no-op (`None => Ok(())`), which the code already handles.
- Add a map-level test pinning idempotence:
  `test_take_twice_is_none` — `take(id)` twice; second is `None`
  (covers the close+eof double-fire path through `take`).

## 4. What does NOT change

- Frontend: zero changes. `src/lib/tauri-api.ts` command names, args, and
  payloads are identical; `src/lib/session-channel.ts` event handling is
  identical (eviction never changes what events fire or when).
- TOFU flow (`pending_tofu` map, `check_server_key`, `tofu_respond`) —
  untouched. It already uses its own oneshot map outside `SshManager`.
- `test_server.rs` (debug mock SSH server) — untouched.
- Session id minting stays frontend-side (`src/lib/session-id.ts`);
  duplicate-id-overwrite semantics stay pinned by
  `test_duplicate_id_overwrites`.

## Steps

1. §1 handle mechanics + test updates. `cargo check` + `cargo test` green.
2. §2 command bodies. `cargo check` + `cargo test` green.
3. §3 eviction helper + three call sites + idempotence test.
   `cargo check` + `cargo test` green.
4. Grep sweep: `route_send` / `route_resize` have zero references
   (commands, manager, tests).

## Verification

- `cargo check` exits 0 (AGENTS.md requirement for Rust changes).
- `cargo test` exits 0 in `src-tauri/`.
- No frontend files changed → `npm run build` not required. If any file
  under `src/` was touched anyway, run it and exit 0.
- **Manual regression** on a debug build (mock SSH server from
  `test_server.rs` is available): connect two sessions; type in terminal
  A, disconnect B, keep typing in A — A must not stall. Resize A's
  window after B disconnects. TOFU dialog on first connect still
  answers (the evict lock is not held during the 60s TOFU park — the
  park is inside `check_server_key`, before the session is inserted).

## Deliberate non-goals

- No per-session mutexes or lock sharding — `Arc` + `&self` russh calls
  make them unnecessary.
- No reconnect logic, no max-sessions slot reservation (commented
  ceiling instead).
- No change to `ssh_connect`'s resolution orchestration (stores cloning,
  credential resolution) — that is handler-honest logic with no other
  home; it already drops every std-Mutex guard before awaits.
- The 81× `lock().map_err(...)` std-Mutex idiom across handlers is a
  separate concern; not in this plan.