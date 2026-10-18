# 001. No local echo — shadow buffer is observe-only

Date: 2026-10-02
Status: Accepted

## Context
Comnd is a live SSH client: every keystroke must reach the remote device in real time (AGENTS.md rule 1). The frontend keeps a **shadow buffer** — an observation-only mirror of the input line used solely for suggestion matching (CONTEXT.md, `src/lib/shadow-buffer.ts`).

## Options
- **Local echo** — render each keystroke locally, then send. Cost: desyncs and double-renders when the remote echoes back; breaks the observe-only model.
- **No local echo / shadow buffer** — send all keystrokes to the remote; frontend mirrors input for matching only. Cost: no instant local feedback; depends on remote echo and must re-sync (line tracker).

## Decision
All keystrokes go to the remote device in real time; no local echo. The frontend keeps a shadow buffer that observes input for suggestion matching only.

## Consequences
- Easier: one source of truth for line state (the remote); clean mirror for matching; no double-render reconciliation.
- Harder: typing feedback depends on remote echo latency; shadow buffer must re-sync on prompt/echo (`src/lib/line-tracker.ts`).
- Rules out: type-ahead or optimistic local rendering of the input line.
