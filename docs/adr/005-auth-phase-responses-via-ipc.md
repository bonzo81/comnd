# 005. Auth-phase prompt responses travel via Rust IPC (bounded exception to 002)

Date: 2026-10-17
Status: Proposed

## Context
Issue 12: connecting to a host saved with password auth and no stored password shows a non-interactive connect overlay — the user never sees the device's `Password:` prompt and cannot complete the connection. The decided fix (issue 12) is to show the real terminal interactively during connect so the user types the answer directly, with native SSH output visible.

The visible `Password:` prompt is a keyboard-interactive round answered programmatically inside `connect()` in `src-tauri/src/ssh.rs` (`responses_for_round` + the round loop that calls `authenticate_keyboard_interactive_respond()`). No SSH channel exists yet — the channel opens only after auth succeeds — so typed characters cannot travel the normal channel `send()` path. An SSH transport connection does exist during auth — key exchange is already complete; connection and channel are different layers. The `Password:` round travels as USERAUTH messages over that connection, not as channel data, so the answer can enter the backend only through the `authenticate_keyboard_interactive_respond()` call. The typed characters live in the frontend (xterm.js), whose only road to that call is Tauri IPC. ADR-002 keeps keystrokes out of Rust because the post-connect path is latency-critical (a per-key IPC round-trip is laggy); the auth phase is a different situation: a handful of characters over seconds, and the pending auth round lives only in the backend.

## Options
- **Pre-connect password dialog** — frontend collects the password in a modal before connecting and passes it as a one-shot credential. Cost: deviates from issue 12's decided UX (type at the real terminal with native SSH output visible); adds a second credential UI; cannot handle multi-round or unexpected prompts.
- **Auth-phase responses via IPC** — backend emits the auth prompts to the frontend; the terminal shows them; typed input crosses via one dedicated Tauri command that answers the pending round and resumes auth. Cost: an exception to ADR-002's letter — a new user-input IPC path that must stay strictly bounded to the auth phase.

## Decision
Auth-phase prompt responses travel via one dedicated Tauri IPC command, during connect only. The backend owns the pending keyboard-interactive round; the frontend shows its prompts in the real terminal and returns the typed answer line-buffered on Enter. Post-connect keystroke routing stays in the frontend (ADR-002). The path is gated to password-auth hosts with no stored password; typed responses are never logged or transcripted.

## Consequences
- Easier: password-auth hosts with no stored password become usable (issue 12); one bounded mechanism covers regular and NetBox hosts; the web-auth flow is untouched (URL rounds never become interactive).
- Harder: a second input path exists — it must be gated to the auth phase (password-auth host, no stored password, credential round, no channel yet) so it never leaks into post-connect typing; cancellation and the 120s connect timeout must abort a pending round cleanly; typed responses must never be logged or transcripted.
- Rules out: reading ADR-002 as absolute; collecting auth answers anywhere but the terminal.