# Plan: Strengthen the smoke mutation check (issue #61)

Status: Approved; implemented (issue #61). Strengthened by issue #78, which added the
activation signal described under Known gaps.
Spec: bonzo81/comnd#61. Task prompt: none yet.

## Goal

The runner can break one app behaviour from the app process's environment, and running the
mutation makes a named smoke scenario fail with a message that names what broke — instead of
the mock going quiet.

## Background

`npm run smoke:mutation` currently makes the mock host stop echoing (`muteOutput` in
`src-tauri/src/test_server.rs`). No application code is touched, so the check proves the runner
notices a silent mock, not that the suite would catch a broken app. Issue #61 records this as
the weakest of the #53 acceptance criteria.

## Not doing

- No new smoke scenarios; the mutation reuses `command-round-trip`.
- No change to how keystrokes reach the app in unmutated runs.
- No change to the mock's normal echo behaviour.

## Rules

- The switch is an env var, `COMND_SMOKE_MUTATION`, read from the app process only. The runner
  already spawns the driver that launches the app, so it sets the variable there.
- Debug builds only, gated like the existing smoke commands in `src-tauri/src/lib.rs`. A release
  build must have no mutation path.
- `npm run smoke:mutation` keeps its shape; the CLI does not change.
- Keystroke path stays in the frontend. The mutation may stop bytes at the Rust boundary; it
  must not move terminal logic into Rust.
- The `mutation-check` matcher changes with the mutation. Today it expects
  `/Command round-trip: expected remote echo exactly once/`, which comes from the mock going
  quiet. A zero-byte `ssh_send` run fails earlier, in `waitForBytes`, with
  `Command round-trip: Mock host did not receive <n> bytes`. The matcher must accept that
  failure and reject the old remote-echo-only one, so a passing unmutated run cannot satisfy it.

## Done looks like

- [ ] `COMND_SMOKE_MUTATION=ssh_send` forwards zero bytes for typed input — proof: the flag's
      diff sits in app code (`src-tauri/src/lib.rs` / `src-tauri/src/ssh.rs`), and `git diff`
      shows nothing changed in the mock's echo path to make the failure happen.
- [ ] `npm run smoke:mutation` exits 0 with one expected failure — proof: the matcher now names
      the zero-byte `command-round-trip` failure, and the output line is pasted into the PR.
- [ ] That failure names the behaviour, not just a byte count — proof: the pasted text names the
      scenario and the expectation, for example `Command round-trip: Mock host did not receive
      45 bytes; mock received 0 bytes`, so a reader knows which behaviour broke.
- [ ] Unmutated `npm run smoke` passes 10/10 on Windows and on Linux CI — proof: green run ids.
- [ ] No mutation in release — proof: the environment read, the mutation helper, and its call
      site all sit inside the same `#[cfg(debug_assertions)]` boundary, cited by file and line in
      the PR, or a release-build check proves `COMND_SMOKE_MUTATION` cannot change SSH input.

## Known gaps (handed over deliberately)

- **Resolved by issue #78.** Zero bytes at the mock no longer satisfies the check on its
  own: the debug-only `test_smoke_mutation_drops` command reports the bytes the drop
  discarded, and the runner requires a non-zero count in the expected failure.
- **Whether the existing mock-side `muteOutput` check stays.** It may run alongside the app-side
  mutation, or be replaced by it. Either is acceptable, as long as `npm run smoke:mutation`
  proves an app-side break.
- **The target is `ssh_send` byte forwarding**, option 1 in issue #61. The issue calls the
  command `ssh_input`, but the registered Tauri command is `ssh_send` (`src-tauri/src/ssh.rs`,
  registered in `src-tauri/src/lib.rs`), so that is the env value. If it turns out impractical,
  the implementer picks the next option and updates the env value, this checklist, and the
  matcher in the same PR, naming the option and the reason.

