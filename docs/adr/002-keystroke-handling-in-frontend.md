# 002. Keystroke handling lives in the frontend, never via Rust IPC

Date: 2026-10-02
Status: Accepted

## Context
The keystroke path is latency-critical — a round-trip per key is perceptible (AGENTS.md rule 2). Routing and shadow-buffer mutations live in the **SuggestionController** (`src/lib/suggestion-controller.ts`); KB lookups go async to Rust via Tauri IPC.

## Options
- **Route keystrokes through Rust.** Cost: an IPC round-trip on every key → laggy, non-deterministic typing.
- **Handle keystrokes in the frontend** (xterm `onKey`/`onData`); only async KB queries cross to Rust. Cost: more logic in the frontend; must stay synchronous and fast.

## Decision
Keystrokes are handled in the xterm.js handler in the frontend. KB queries go async to Rust via Tauri IPC. Keystrokes are never routed through Rust.

## Consequences
- Easier: zero IPC on the keystroke path → responsive typing; deterministic and testable in the browser.
- Harder: input logic concentrates in the frontend (`SuggestionController`); can't lean on the backend for routing.
- Rules out: centralizing input handling in Rust; any per-keystroke server round-trip.
