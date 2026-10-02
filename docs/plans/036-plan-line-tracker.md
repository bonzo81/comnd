# Plan: Line Tracker — Deepen Prompt Detection

Candidate 1 from the architecture review (September 2026). This plan is
self-contained; it does not depend on the review session.

## Problem

Two state machines consume every SSH output chunk and each independently
rebuild "the current line" from the same stream:

| Module | Lines | Line model | Job |
|---|---|---|---|
| `src/lib/prompt-detector.ts` | 125 | `pendingText` = text after last `\n` (no `\b`/`\r` handling) | idle window → prompt regex → mode change, shadow-buffer reset trigger, passthrough flag |
| `src/lib/echo-line.ts` (`EchoLineTracker`) | 87 | char walk: `\n`/`\r` line break, `\b` back-delete, control chars ignored | reconstruct the echoed input line for shadow-buffer re-sync, learn prompt prefix |

Both call `stripAnsi` on the same text (prompt-detector.ts:62,
echo-line.ts:27). They are wired together by `terminal-view.ts` acting as a
message bus: `handleSessionEvent` calls `promptDetector.feed(text)`
(terminal-view.ts:801) and then `controller.onOutput(text, { isPassthrough,
lastPrompt })` (terminal-view.ts:811–814), reading two getters off the
detector and hand-delivering them to the suggestion controller. The
controller owns the `EchoLineTracker` instance (suggestion-controller.ts:36)
and calls `contentAfter(pd.lastPrompt, ...)` for echo re-sync.

Neither module has a test. They are the stateful core of the output side of
the pipeline — AGENTS.md names prompt detection as a non-negotiable
architecture rule (rule 3), and it is completely untested.

The two line models also disagree today: prompt-detector ignores `\b`, so a
backspace echo (`\b \b`) leaves literal control bytes in `pendingText` and
breaks a prompt match; echo-line handles it correctly. And prompt-detector
splits only on `\n`, never `\r`.

## Solution

One deep module, `LineTracker` in `src/lib/line-tracker.ts`, with one
`feed(chunk)` interface. The implementation absorbs both state machines:

- ANSI strip happens **once** per chunk.
- One char-walk line model (echo-line's semantics — it is the more correct
  of the two): `\n`/`\r` break the line, `\b` deletes a char, control
  chars < space are ignored, everything else appends.
- Prompt matching, mode change, passthrough, idle/passthrough timers, prompt
  learning, and echo reconciliation all become internal implementation.

Deletion test: deleting `prompt-detector.ts` and `echo-line.ts` concentrates
their complexity in `LineTracker` instead of spreading it across two files
plus the view's bus wiring. That is the signal we want.

`src/lib/ansi.ts` (`stripAnsi`) is unchanged — it stays the shared strip
utility the tracker consumes.

## 1. The LineTracker interface

```ts
// src/lib/line-tracker.ts
export interface PromptPatterns { [mode: string]: string }

export class LineTracker {
  constructor(
    onModeChange: (mode: string) => void,
    onPromptDetected: () => void,
  );

  /** Load prompt patterns from platform index.yaml. */
  loadPatterns(patterns: PromptPatterns, defaultMode: string): void;

  /** Feed one SSH output chunk. Strips ANSI once, updates line state,
   *  re-arms idle/passthrough timers, matches prompt after idle. */
  feed(chunk: string): void;

  /** Reset all line + prompt state (new session, disconnect). */
  reset(): void;

  // ── Echo reconciliation (consumed by SuggestionController) ──

  /** Reconciled current input line, or null when it can't be trusted.
   *  Prompt priority is internal: detected prompt → learned prompt →
   *  consistency fallback. */
  contentAfter(expected: string): string | null;

  /** Learn the prompt prefix from a trusted EOL state (line = prompt +
   *  expected). Same gating semantics as EchoLineTracker.learnPrompt. */
  learnPromptFrom(expected: string): void;

  get mode(): string;
  get isPassthrough(): boolean;
  get lastPrompt(): string;
}
```

Internal state: `line`, `lastLineValue`, `learnedPrompt` (from
echo-line.ts:11–18), `patterns`, `currentMode`, `passthrough`, `lastPromptText`,
`idleTimer`, `noMatchTimer` (from prompt-detector.ts:15–27).

## 2. Behavior unification decisions

Each is a deliberate semantic choice, pinned by tests in step 1:

1. **Char-walk is the single line model.** prompt-detector's
   `lastIndexOf("\n")` slicing is deleted. Consequence: backspace echo now
   works for prompt matching (`Router#sh` + `\b \b` + idle → prompt matches
   `Router#`). Old behavior would not match — the new one is strictly more
   correct. Pin with a test.
2. **Prompt matching trims.** `checkPrompt` tests `line.trim()` against the
   patterns (prompt-detector.ts:90 keeps this). Echo reconciliation does NOT
   trim (echo-line's `contentAfter` semantics keep their
   `replace(/^\s+/, "")` handling, echo-line.ts:76–81).
3. **Prompt patterns keep the `^(?:...)$` full-line anchor** constructed in
   `loadPatterns` (prompt-detector.ts:47) — the comment there explains why
   the anchor is load-bearing; keep it.
4. **Passthrough arming rules stay as-is** (prompt-detector.ts:80–85): only
   armed when patterns exist AND the chunk contains a newline; cleared on
   prompt match and on `loadPatterns`. Keep the comment about linux-bash
   (`prompt_patterns: {}`) — it documents why the guard exists.
5. **`feed` is called once per chunk by the view** (terminal-view.ts:801).
   The controller's `echoLine.feed(text)` call (suggestion-controller.ts:110)
   is deleted — the tracker's line state updates in the view's single
   `feed` call. `feed` is also idempotent per chunk: both consumers of the
   old two feeds observe the same result.
6. **Prompt match resets echo state internally** (the tracker resets
   `line`/`lastLineValue`/`learnedPrompt` on a match). Today this is done by
   `SuggestionController.onPromptDetected` calling `echoLine.reset()`
   (suggestion-controller.ts:157) — that coordination becomes internal
   state transition, one less cross-module dependency.

## 3. Controller integration

`SuggestionController` (src/lib/suggestion-controller.ts):

- Delete the `echoLine` field and `EchoLineTracker` import.
- `ControllerDeps` gains `lineTracker: () => LineTracker` (accessor style,
  matching `ghost`/`dropdown` — the tracker is re-created per session).
- `onOutput(text: string, pd: { isPassthrough: boolean; lastPrompt:
  string | null })` becomes `onOutput(text: string)`:
  - `pd.isPassthrough` → `this.deps.lineTracker().isPassthrough`
  - `echoLine.feed(text)` → deleted (view feeds the tracker)
  - `echoLine.contentAfter(pd.lastPrompt ?? "", buffer)` →
    `tracker.contentAfter(this.shadowBuffer.content)` (prompt priority is
    now internal; `lastPrompt` stops crossing modules)
  - `echoLine.learnPrompt(buffer)` → `tracker.learnPromptFrom(buffer)`
- `onPromptDetected()` keeps `this.reset()` (shadow buffer + cursorMoved +
  receivingOutput + ghost hide) but drops its `echoLine.reset()` call.

`terminal-view.ts`:

- `new LineTracker(onModeChange, onPromptDetected)` replaces
  `new PromptDetector(...)`; `promptDetector` references become `lineTracker`.
- `handleSessionEvent` output path (terminal-view.ts:766–823):
  - `this.promptDetector.feed(text)` → `this.lineTracker.feed(text)` —
    called once, before `controller.onOutput(text)`.
  - The highlight gate reads `this.lineTracker.isPassthrough`
    (terminal-view.ts:784).
  - `controller.onOutput(text, {...})` → `controller.onOutput(text)`.
- Connect flow: `promptDetector.loadPatterns(...)` (terminal-view.ts:734)
  → `lineTracker.loadPatterns(...)`.
- The cursor-desync guard (terminal-view.ts:806–808) is unchanged — it
  reacts to raw ANSI cursor codes in the chunk, which the tracker strips
  before they reach line state. Orthogonal, stays in the view.
- `stripAnsi` for the connection-phase output pane (terminal-view.ts:817)
  is a different path and is unchanged.

## 4. Tests

New `src/lib/line-tracker.test.ts` (fake timers, same style as
suggestion-controller.test.ts). Both halves plus the unified semantics:

- Prompt match after 200ms idle; mode-change callback fires only on change;
  `onPromptDetected` fires on every match.
- Anchored matching: prompt + typed input (`Router#sh`) does NOT match mid-
  command (pin prompt-detector.ts:45–46's invariant).
- Passthrough: arms after 2s of newline-bearing output without a match;
  clears on match; never arms when `loadPatterns({})` (linux-bash pin).
- Backspace echo: `Router#sh` + `\b \b` + idle → prompt matches (new
  behavior, pin it).
- `\r` as a line break (unified model).
- `contentAfter` priority chain (echo-line.ts:66–86, currently untested):
  detected prompt → learned prompt → CRLF-prompt case (`lastLineValue`) →
  consistency fallback (echo ends with expected) → null.
- `learnPromptFrom`: learns only when line ends with expected and both
  parts non-empty.
- `reset()` clears line, learned prompt, timers; `loadPatterns` clears
  passthrough and the no-match timer.

Update `suggestion-controller.test.ts`: replace the real `EchoLineTracker`
and the `pd` argument with a fake `lineTracker` accessor.

## 5. Steps

1. **Create `line-tracker.ts`** uniting both machines (§2 decisions), port
   all behavior. Write `line-tracker.test.ts`. Nothing imports it yet.
   `npm run build` + `npm test` — old modules still in place, both suites
   green.
2. **Switch SuggestionController** to the tracker accessor (§3): delete
   `echoLine`, change `onOutput` signature. Update
   suggestion-controller.test.ts. Build + test.
3. **Switch terminal-view.ts**: replace `promptDetector` with `lineTracker`,
   single-feed wiring, drop the `pd` object at the call site (§3). Build +
   test.
4. **Delete `prompt-detector.ts` and `echo-line.ts`** and their now-dead
   exports. Grep for stale imports. Build + test.
5. **Extend `test_server.rs`** so manual regression is runnable offline
   (debug-only, gated behind `test_mock_server`). The mock keeps per-connection
   shell state (`ConnState`) and drives an interactive shell in `data()`:
   - Persona by username: `cisco` → Cisco IOS-XE (`Router>` / `Router#`,
     `enable`/`disable`); anything else → bash (`user@host:~$ `, no prompt
     patterns, so the learned-prompt path is exercised).
   - Line editing repaints the whole line on backspace, Ctrl+W, and every
     arrow/home/end/ins/del sequence: `\r\x1b[K` + prompt + current input.
     Full-line redraw (not single-char erase) is a deliberate simplification —
     it lets the frontend reconcile via `contentAfter()` without per-cell
     cursor math, and end-anchored prompt regexes keep a mid-line redraw safe
     (it never matches as a fresh prompt).
   - `top` emits a ~30-line prompt-less burst (drives LineTracker passthrough);
     while in it only `q` is honored, which re-prompts.

   Unit tests `mock_shell_line_editing_redraws` and
   `mock_shell_top_burst_and_quit` pin the byte-level behavior. Manual
   regression (debug build → `test_mock_server`): connect as `cisco` (mode tint
   + shadow reset per prompt; backspace/arrow edits stay in sync with ghost
   text); connect as anything else (bash — suggestions work with no KB
   patterns, arrow-key edit re-sync reconciles); run `top` (highlighting
   suppressed during the burst, `q` returns the prompt and resumes it).

## Verification

- `npm run build` (tsc strict) exits 0 after every step.
- `npm test` exits 0: new line-tracker suite + updated controller suite +
   existing engine/router/channel suites untouched.
- Backend: `test_server.rs` extended (debug-only). `cargo check` and
  `cargo test test_server` exit 0.

## Deliberate non-goals

- No suggestion-matching changes; the engine is untouched.
- No change to the keystroke side — that is
  plan-keystroke-resolution.md.
- The cursor-desync guard stays in terminal-view (it watches raw ANSI
  escapes, not line state).
- `SessionChannel`, `ansi.ts`, and the shadow-buffer model are untouched
  (AGENTS.md rules 1–3 all preserved: no local echo, feed stays in the
  frontend, detection stays a frontend state machine).