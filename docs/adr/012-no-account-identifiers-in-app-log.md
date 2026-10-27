# 012. The app log carries no account identifiers

Date: 2026-10-27
Status: Accepted

## Context

Comnd writes two unrelated kinds of log, and only one of them had a stated
privacy rule.

`comnd.log` is the application log: `simplelog` plus a `MultiWriter` built in
`src-tauri/src/lib.rs` (`open_log_file` at line 203, logger at line 318),
writing to `paths::log_dir()/comnd.log` or a user-set path, with file mode
`0o600` and directory `0o700` on unix (lines 223-224). It runs in release as
well as dev, defaults to `info`, and is the file users are asked to attach to
bug reports. It carried the SSH username in cleartext at four sites:
`ssh.rs:493`, `ssh.rs:549`, `ssh.rs:553` and `hosts.rs:245`.

`session_log.rs` is the per-session transcript: raw terminal bytes, opt-in, one
file per connection, named from host:port and session id. Its raw-output nature
is documented in `docs/specs/02-technical-architecture.md:144`. It does contain
the username when the client-side password prompt fires, because `ssh.rs:877`
writes `user@host's password:` into the transcript like any device prompt, and
it is deliberately not redacted.

The two had drifted together in practice: the 11 `rust/cleartext-logging`
code-scanning alerts did not say which log they meant, and the answer was "the
one that is always on and gets emailed to the maintainer". A second, non-obvious
path leaked the username too. `ssh.rs:545` builds an auth-timeout error string
containing it; the frontend surfaces that string, and `src/main.ts:809` logs it
through the forward sink in `src/lib/logger.ts` — production only, straight to
`comnd.log`. Redacting the `log::` call sites alone would have left that path
open.

## Options

- **Redact usernames from `comnd.log`, keep host:port.** Cost: a support log no
  longer shows which account failed auth on a multi-account host.
- **Keep logging usernames, rely on file permissions.** Cost: `0o600` protects
  against other local users, not against the file being attached to a public
  issue, and leaves all 11 alerts open.
- **Drop host:port as well, log session id only.** Cost: the log stops being
  useful for diagnosing a connection, which is its main job.
- **Allow usernames behind a debug level or opt-in flag.** Cost: a second
  logging behaviour to maintain and document, and the flag will be left on in
  the one bug report that matters.

## Decision

Redact usernames from the app log and keep host:port. Usernames are not logged
at any level, in any build, with no opt-in escape hatch. Host display names
stay, because they are a label the user chose rather than an identity. Local
file paths are identifiers too: the key-auth log lines record the private-key
file name only, because the full path carries the account name in the home
directory. Session id is logged alongside host:port, since it is what
distinguishes two overlapping attempts on the same host. Session logs are
unchanged: they record the raw terminal stream by design, can contain the
username, and remain opt-in.

Implemented in PR #65.

## Consequences

- Easier: `comnd.log` can be attached to a public issue without redaction; the
  cleartext-logging alerts close; one rule now covers both the direct `log::`
  path and the frontend forward sink.
- Harder: diagnosing "which account failed" on a host with several saved
  accounts needs the session id or the user's own knowledge, not the log.
- Rules out: a future verbose mode that logs usernames. Adding one supersedes
  this ADR.
- Not covered: the log still records hostnames, ports and host display names. A
  hostname can be identifying in some environments; this ADR accepts that.
- Lesson from the work: an error string returned to the frontend is a logging
  path. Redaction belongs where the string is built, not only where `log::` is
  called.
