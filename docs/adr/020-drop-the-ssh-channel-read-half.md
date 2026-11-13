# 020. The SSH channel's read half is dropped so inbound data cannot park the session loop

Date: 2026-11-12
Status: Accepted

## Context

Issue #136 records a live defect: after roughly one line of input, terminal
output and `ssh_send` both stop while the suggestion engine keeps working. The
cause is in russh, not in Comnd.

**The blocking send.** `russh 0.65.1` handles inbound channel data in
`client/encrypted.rs`, `CHANNEL_DATA` at line 611 and `CHANNEL_EXTENDED_DATA` at
line 639:

```rust
if let Some(chan) = self.channels.get(&channel_num) {
    let _ = chan.send(ChannelMsg::Data { data }).await;
}
```

`self.channels` is `Encrypted::channels: HashMap<ChannelId, ChannelRef>`, and
`ChannelRef.sender` is the bounded mpsc created in `Channel::new`
(`channels/mod.rs:471`) with `config.channel_buffer_size`, default **100**
(`client/mod.rs:2763`). Its receiver is `ChannelReadHalf`
(`channels/mod.rs:146`), which lives in the `Channel` handle Comnd holds.

**Why the queue never drains.** Comnd never calls `ChannelReadHalf::wait()` or
`make_reader()`, so nothing consumes from that mpsc. At the 101st inbound packet
`send().await` never resolves, which parks `process_packet` →
`client_read_encrypted` → `run_inner`. The loop then stops reading the socket,
stops draining `self.receiver`, and stops writing output. `Channel::data()` in
turn blocks forever on the full 100-capacity outbound `Sender<Msg>`, so every
keystroke after that stays pending. Nothing bounds it: `SshSession::send`
(`ssh.rs:1014`) awaits `channel.data()` directly, and neither the Tauri command
nor the frontend wraps it in a timeout.

**Reproduced, not inferred.** A probe against the mock host sending 300
single-byte writes wedges at send **#138**, matching ~101 inbound packets. The
wedge reproduces across chunk sizes 1, 2, 8, 64 and 1024, and `resize` hangs
during it too. The symptom is a consequence of the protocol library's flow
control, not of Comnd's send path — the suggestion engine keeps working
throughout precisely because it never touches the socket.

## Options

- **Drain the read half in a background task.** Loop on `ChannelReadHalf::wait()`
  and discard the messages. Correct, and a `wait()` loop can also observe
  `ChannelMsg::ExitStatus` and `ChannelMsg::ExitSignal`. Cost: a spawned task per
  session, a second owner of the channel, and the drain task must be cancelled
  correctly on disconnect or it leaks. `make_reader()` is not an alternative: it
  returns an `AsyncRead` over `Data` and `ExtendedData` bytes, so it drains the
  queue but never yields the control messages. Either way it fixes the symptom by
  making Comnd responsible for a queue it did not create and does not want.
- **Raise `channel_buffer_size`.** Cost: moves the wedge to packet N+1 and hides
  the design bug behind a bigger number. Not a fix.
- **Patch russh to `try_send` via `[patch.crates-io]`.** This is what upstream
  did for `WindowAdjusted` (see below). Cost: a vendored fork of an SSH
  implementation, carried indefinitely, on the security-critical path.
- **Split the channel and drop the read half.** Tokio's `mpsc::send` returns an
  error promptly when the receiver is dropped, so every blocking `chan.send()`
  in `encrypted.rs` fails immediately and the event loop never parks.
- **Do nothing; wait for upstream.** Cost: the app is unusable on a long-lived
  session until a full russh release lands, and upstream has already closed this
  class of bug once without fixing the `Data` branch.

## Decision

After the PTY and shell are established, split the channel and drop the read
half (`src-tauri/src/ssh.rs:684-685`):

```rust
let (read_half, channel) = channel.split();
drop(read_half);
```

The write half becomes `ChannelWriteHalf<client::Msg>` and keeps `data()` and
`window_change()`, so `SshSession::send` and `SshSession::resize` compile
unchanged (PR #137, merged 2026-11-12).

**Flow control still works.** Window adjust is driven by the client receive
path (`enc.adjust_window_size` and `client.adjust_window` in `encrypted.rs`
~599-632), which is independent of the read half. Output keeps flowing across a
whole session after the fix; the regression test asserts exactly that.

**This is a workaround with a known exit, not a permanent design.** Upstream
`Eugeny/russh#571` was closed as "completed" on 2026-02-05 by commit `8717093d`
(PR #630, "prevent deadlock when using make_writer for large transfers"), but
that commit changed only the `WindowAdjusted` branch in `client/encrypted.rs`
(~551) and `server/encrypted.rs` (~668). `russh 0.65.1`, released 2026-11-03,
still uses `send().await` on the `Data`, `ExtendedData`, `Close`, `Eof`,
`XonXoff`, `ExitStatus`, `Success` and `Failure` branches (lines 541, 554, 611,
639, 663, 672, 822, 833). The workaround therefore cannot be retired by bumping
the version. It is retired only when **every** inbound queue send is
nonblocking, not when `Data` alone is fixed — `ExtendedData` reaches the same
bounded queue, so an undrained read half stays wedged under sustained stderr
output even after the `Data` branch is patched.

## Consequences

- Easier: a long-lived session is stable regardless of how much output the
  remote produces. The 100-packet queue no longer bounds session life.
- Harder: `ChannelMsg::ExitStatus` and `ChannelMsg::ExitSignal` never reach the
  channel queue, so anything reading it via `wait()` or `make_reader()` would not
  see them. This does not block exit-status handling, though: russh calls
  `Handler::exit_status` and `Handler::exit_signal` *after* the queue send,
  including on the failed path (`encrypted.rs:674` and `:695`), so
  `ClientHandler` can implement those callbacks while keeping the drop. Neither
  is implemented today, and that is deferred by choice rather than forced by this
  decision — it is also not a regression, since both were already unconsumed.
- Accepted, deferred: no heartbeat or timeout around `ssh_send`. A wedged send
  stays pending indefinitely rather than failing, so the terminal appears to
  accept keystrokes that never leave the machine. Bounding it is a separate
  change.
- Rules out: raising `channel_buffer_size` as the remedy, and any `[patch]` fork
  of russh for this issue. Either supersedes this ADR.
- Guarded: a regression test sends 300 single-byte writes through the mock host
  and asserts output keeps flowing, which fails if the read half is ever restored
  without draining it.
- Revisit when russh makes **all** inbound channel sends nonblocking — `Data` and
  `ExtendedData` at minimum, since either can fill the same 100-capacity queue.
  The options then are keeping `drop(read_half)`, or taking the read half back
  and draining it with a `wait()` loop. Taking it back is safe only under that
  same condition: restoring it while any inbound send still blocks would
  reintroduce the wedge. Adopting exit-status handling is deferred by choice,
  not planned, and no longer depends on the read half.
- Related: ADR 008 covers the russh *crypto backend*. It does not cover channel
  handling and is unaffected by this decision.
