# Chunk 4 Learnings — russh Send failure + 0.46→0.49 migration

What bit us, what didn't work, what to remember. Written after chunk 4 (agent
auth) took a multi-hour detour. Read before touching the auth chain or russh.

## The bug that cost the most time

Adding an `authenticate_future` call inside `SshSession::authenticate` broke
compilation of the whole lib with:

```
error: implementation of `std::marker::Send` is not general enough
  --> src\lib.rs:325:1  #[tauri::command]
  = note: `Send` would have to be implemented for the type `&Arc<AtomicBool>`
  = note: ...but `Send` is actually implemented for the type `&'0 Arc<AtomicBool>`,
          for some specific lifetime `'0`
```

### Root cause (two layers)

1. **russh 0.46's `authenticate_future<U, S: Signer>` held the signer `S` across
   await points, and `Signer` has no `Send` bound.** Rust infers auto traits
   (Send) for an async fn's opaque future at *definition site*, for all generic
   instantiations. Since `S: Send` can't be proven there, the future is not
   Send for ANY instantiation — even when every concrete type involved is Send.

2. **Tauri commands require higher-ranked Send** (Send for ALL lifetimes), not
   just Send for one lifetime. The misleading `&Arc<AtomicBool>` note (the type
   changes per edit — `&str`, `&AppState` all appeared) is a symptom: any borrow
   held across the bad await poisons the whole command future.

### The tell to remember

The error points at a *type that is obviously Send* (`&Arc<AtomicBool>`). When
"Send is not general enough" names an innocent type inside a `#[tauri::command]`,
the real culprit is usually a generic async fn (foreign or local) being awaited
somewhere in the call tree whose future can't satisfy the higher-ranked bound.
The flagged type is noise.

## What didn't work (all attempted, all failed)

- Passing owned `String` instead of `&str` to the generic `U` param
- Non-generic wrapper fn around the call
- `Box::pin` the call into `Pin<Box<dyn Future + Send>>` — boxing can't add a
  Send impl that doesn't exist on the inner opaque type
- Upgrading to russh 0.49.2 and calling the renamed `authenticate_publickey_with`
  directly (probe crate proved the shape is Send for a *specific* instantiation;
  still failed the higher-ranked requirement in the tauri macro)

Also considered and rejected:
- `spawn_blocking` + fresh current-thread runtime — can't move `&mut Handle`
  (not `'static`) into the closure
- `LocalSet` — can't hold a `!Send` LocalSet inside a Send task's future
- Forking/patching russh to add `S: Send` — would work, but a forked dep is a
  permanent maintenance burden for a 4-line alternative

## What worked

**russh 0.49.2 + `tokio::task::block_in_place` + `Handle::current().block_on`:**

```rust
let result = tokio::task::block_in_place(|| {
    tokio::runtime::Handle::current().block_on(
        session.authenticate_publickey_with(username, key, &mut client),
    )
})
.map_err(|e| e.to_string());
```

Why it's sound: `block_on` runs the future *synchronously* on the current
worker thread — the borrows (`&mut Handle`, `&mut DynAgent`) never become
captures of an outer async state machine, so no Send proof is ever demanded.
`block_in_place` converts the worker thread to a blocking-safe state first so
the runtime doesn't starve. Constraint: **requires a multi-threaded runtime**
(tauri's default). Marked with a `ponytail:` comment in ssh.rs.

## russh 0.46 → 0.49 migration notes

| 0.46 | 0.49 |
|---|---|
| `russh::keys::key::PublicKey` | `russh::keys::PublicKey` (now `ssh_key::PublicKey`) |
| `russh_keys` direct dep | drop it — use `russh::keys` re-export |
| `authenticate_future(user, key, signer)` consumes+returns signer | `authenticate_publickey_with(user, key, &mut signer)` borrows |
| `KeyPair::generate_ed25519()` | `PrivateKey::random(&mut safe_rng(), Algorithm::Ed25519)` (returns Result) |
| `authenticate_publickey(u, Arc<KeyPair>)` | `authenticate_publickey(u, PrivateKeyWithHashAlg)` |
| `key.fingerprint()` → bare base64, no prefix | `key.fingerprint(HashAlg::Sha256)` Display → `SHA256:` prefix |
| `key.public_key_base64()` (PublicKeyBase64 trait) | `key.to_bytes()` + base64 crate |
| `key.name()` | `key.algorithm().as_str()` (NOT `&'static` — `.to_string()` it) |
| server `Session::channel_success/data` returned `()` | now return `Result` — add `?` |
| server `Config.keys: Vec<KeyPair>` | `Vec<PrivateKey>` |

Handler traits (`client::Handler`, `server::Handler`) are still `#[async_trait]`
in 0.49 — existing `#[async_trait]` impls port over unchanged.

## Data compat traps

1. **Fingerprints in hosts.json are 0.46-format**: bare base64-nopad, 43 chars,
   NO `SHA256:` prefix. ssh-key's Display emits the prefix. `secrets::agent::
   fingerprint_b64()` strips it. Pinned by
   `test_fingerprint_b64_matches_russh046_format`. If you ever compare
   fingerprints against ssh-key output directly, remember the prefix.
2. **known_hosts key_base64**: SSH wire bytes, base64 WITH padding, STANDARD
   engine. `key.to_bytes()` produces identical bytes — verified by keeping the
   same encode path.
3. `PrivateKeyWithHashAlg::new` returns `russh_keys::Error`, NOT
   `ssh_key::Error` — `.map_err(|e| e.to_string())` before combining Results.
   Cost us one compile round.
4. RSA keys need explicit `Some(HashAlg::Sha256)` in `PrivateKeyWithHashAlg`;
   non-RSA take `None`.

## Process lessons

- **Bisect first, theorize second.** The stub-with-yield_now probe (hold the
  value across `yield_now().await`, `drop`, `cargo check`) proved `DynAgent` is
  Send in 30 seconds, after an hour of wrong theories about DynAgent's
  Send-ness. Note: make sure the value is actually *live across the await*
  (an earlier "proof" was invalid because `_client` dropped before the yield).
- **A scratch crate reproduces foreign-generic bugs fast.** Replicating russh
  0.49's exact fn shape in a zero-dep crate answered "is the 0.49 shape Send?"
  in minutes, before touching Cargo.toml.
- **Read the whole error, especially `= note:` lines.** "for some specific
  lifetime `'0`" was the higher-ranked-Send smoking gun; the flagged type was
  a red herring that changed on every edit.
- **Upgrade path check is cheap.** Downloading the .crate from
  static.crates.io, `tar -xf`, and grepping the source settled "is it fixed
  upstream" without any Cargo.toml churn. (Expand-Archive can't open .crate
  files — rename/copy to .zip first, or use tar.)
