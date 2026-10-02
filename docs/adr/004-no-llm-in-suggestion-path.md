# 004. No LLM in the suggestion/keystroke path

Date: 2026-10-02
Status: Accepted

## Context
The suggestion and keystroke paths are latency-critical and must stay deterministic (AGENTS.md "What NOT To Do"). The LLM client (`src-tauri/src/llm.rs`) is used only for offline KB import (`src-tauri/src/import.rs`).

## Options
- **LLM-driven suggestions / keystroke decisions.** Cost: latency + non-determinism on the critical path; can't meet real-time typing.
- **Deterministic KB matching in the frontend; LLM only for offline KB import.** Cost: suggestions bounded by KB contents; no free-form generation.

## Decision
No LLM in the suggestion/keystroke path. The LLM is used only for KB import (`src-tauri/src/import.rs`), because latency-critical paths must stay deterministic.

## Consequences
- Easier: keystroke/suggestion path is deterministic and latency-bounded; reproducible and testable.
- Harder: suggestion quality bounded by KB coverage; no creative/free-form completion.
- Rules out: any model call on the keystroke path; keeps the LLM confined to offline import.
