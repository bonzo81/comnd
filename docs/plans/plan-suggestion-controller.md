# Plan: SuggestionController — Deepen the Keystroke Pipeline

Candidate 2 from the architecture review. The suggestion hot path — shadow
buffer mutation, echo re-sync, debounce, engine query, ghost/dropdown
dispatch — is currently choreographed by two closures inside a 2013-line DOM
class (`terminal-view.ts`). The most bug-prone logic in the app (comments at
871–963 document past bugs) has no test surface, and one piece of it
(`inputAfterPrefix`, 1546–1560) duplicates tested engine logic
(`stripPrefix`, suggestion-engine.ts:697).

This plan extracts the pipeline into `SuggestionController` in
`src/lib/suggestion-controller.ts`, plus a pure `routeKeystroke` helper it
calls. TerminalView keeps rendering and I/O only.

**Ordering:** land plan-session-channel.md first. It defines `ChannelState`
and the output event's `phase`, which this controller consumes; it also owns
the `state === "connected"` gate this plan's `keyIn` needs (the controller
takes state as a parameter rather than owning it — see §2).

---

## 1. What moves, exactly

### The keystroke dispatcher — `onData` closure (328–437)

Becomes a pure function, tested without xterm:

```ts
// src/lib/keystroke-router.ts (or inline in suggestion-controller.ts)
export interface RouteResult {
  send: string[];              // bytes resolved by the caller, sent in order
  shadowOps: Array<            // shadow buffer mutations, in order
    | { op: "append"; ch: string }
    | { op: "backspace" }
    | { op: "reset" }
    | { op: "setContent"; text: string }   // echo re-sync result
  >;
  cursorMoved: boolean;        // new value of the flag (false = cleared)
  hideGhost: boolean;
  hideDropdown: boolean;
  dismissSidebar: boolean;     // Escape with sidebar open
  toggleSuggestions: boolean;  // Ctrl+Space
  moveDropdown: "up" | "down" | null;      // arrows with dropdown open (376–377)
  rebuildGhost: boolean;       // re-render ghost from selection (syncDropdownToGhostText)
}
export function routeKeystroke(
  data: string,
  view: { dropdownVisible: boolean; ghostShowing: boolean; sidebarOpen: boolean; connected: boolean },
): RouteResult;
```

**Why `send` contains resolved strings but some ops are sentinels.** Three
accept-actions need live widget state the router deliberately doesn't see:
Tab-accept needs `ghostText.getCurrentRemainder()` (338), Alt+ArrowRight
needs `ghostText.acceptNextWord()` (383), dropdown-accept needs
`dropdown.getSelectedPayload()` (1588). The router returns sentinel markers
in `send` — `"\0accept-ghost"`, `"\0accept-next-word"`,
`"\0accept-dropdown"` (constants exported, never sent raw) — and the
caller resolves each sentinel through the widget before sending. The
branching logic (when does Tab accept vs pass through) stays pure and
tested; the value extraction stays with the widget that owns it. Dropdown
Up/Down (376–377) get `moveDropdown` + `rebuildGhost` — the caller runs
`dropdown.moveUp()` then `syncDropdownToGhostText()`.

TerminalView applies the result: resolves and sends each `send` chunk,
applies `shadowOps` to the buffer, shows/hides views. The
keyboard-semantics table (Tab accept, Escape cascade, Ctrl+Space,
Alt+ArrowRight word-accept, Enter/Ctrl+C/arrow resets, paste filtering)
becomes data — the exact artifact unit tests want. The `connected` input is
the channel's state (plan 1): the whole dispatcher is gated on it today
(329), so the router must see it to reproduce the gate.

### The output-side logic — `ssh-output` listener body (871–963)

Split by subject. The session-correlation half goes to SessionChannel (its
plan). The suggestion half moves into `SuggestionController.onOutput(...)`.
Echo re-sync (915–937) needs two prompt-detector values the controller
doesn't own — `isPassthrough` (919) and `lastPrompt` (921) — so they arrive
as parameters, not hidden deps:

```ts
onOutput(text: string, pd: { isPassthrough: boolean; lastPrompt: string | null }): void;
```

The moved logic: echo re-sync decision (`cursorMoved` →
`echoLine.contentAfter(pd.lastPrompt, ...)` → `setContent` → re-query, vs.
trusted-EOL `learnPrompt` path), ghost-cursor desync guard (908–913), and
the `receivingOutput` burst timer (945–961) with its 300ms re-trigger.
`echoLine.feed(text)` runs unconditionally (918) exactly as today.

Prompt-detector feeding stays in TerminalView (it also drives mode tint and
status bar — view concerns), but calls `controller.onPromptDetected()` — the
existing callback body at 220–228 moves there.

### The query pipeline — debounce through dropdown (1452–1614)

Moves wholesale: `debounceSuggestionQuery` (1452–1474) with the staleness
re-check, `showSuggestions` (1476–1506), `applyTopMatch`/`ghostPayloadForTop`
(1513–1543), `acceptDropdownSelection` (1585–1596), `syncDropdownToGhostText`
(1573–1578), `openDropdown`'s accept-callback wiring (1598–1614).

### What TerminalView keeps

- `sendData` (441–445) — I/O
- ghost/dropdown **creation and destruction** (connected-listener body
  985–1016) — DOM lifecycle
- `updateSidebarDetail`/`updateSidebarPlaceholder` (1618–1645) — view
- suggestion toggle UI (`syncSuggestions` 1836–1849) — view, calls
  `controller.refresh()`
- `loadKbCommands` (1432–1448) — calls `controller.loadCommands(...)`
- `getCommandRemainder` (1562–1571) — moves **into the controller** (it's
  called by three moved functions: `acceptDropdownSelection` 1589,
  `openDropdown` cb 1604, and the connected-listener dropdown cb 996; the
  last becomes a `controller.remainderFor(name, input)` call)
- `inputAfterPrefix` (1546–1560) — **deleted**, replaced by the engine's
  `stripPrefix` (see §3)

## 2. The controller interface

```ts
export class SuggestionController {
  constructor(deps: {
    send: (data: string) => void;              // sendData
    ghost: () => GhostText | null;             // accessors, not fields —
    dropdown: () => Dropdown | null;           //   widgets are re-created on reconnect
    sidebar: { detail(cmd: Command): void; placeholder(): void };
  });

  loadCommands(commands: Command[], platform: string, negationPrefix: string | null,
               prefixCommands?: Record<string, PrefixCommandDef>): void;  // 1432–1447 body
  setPlatformIndex(idx: PlatformIndex | null): void;   // for prefixCommands skip lists
  setMode(mode: string): void;                         // from prompt detector

  keyIn(data: string, view: { dropdownVisible: boolean; ghostShowing: boolean;
                              sidebarOpen: boolean; connected: boolean }): void;
  onOutput(text: string, pd: { isPassthrough: boolean; lastPrompt: string | null }): void;
  onPromptDetected(): void;
  remainderFor(commandName: string, input: string): string | null;  // getCommandRemainder
  refresh(): void;            // toolbar toggle re-query (1845–1848)
  dispose(): void;            // clears debounce + burst timers
}
```

`currentInput`, `cursorMoved`, `receivingOutput`, the echo tracker, the
engine, and both timers move inside. `shadowBuffer` moves too — its
`onUpdate` callback (230–233) becomes the controller's own debounce trigger,
killing the `currentInput` mirror field. `connected` is a parameter on
`keyIn`, not controller state: connection state lives in the SessionChannel
(plan 1); the controller receives it per keystroke and `refresh()`/`onOutput`
take it as a param too (add `connected: boolean` to both when plan 1 has
landed).

Dependencies arrive as accessor functions for the widgets (they're
re-created on every reconnect — the connected-listener body at 988–990
destroys and rebuilds them) and plain functions for send/sidebar. No new
interfaces beyond that — matching how dropdown/ghost already take callbacks.
The dual `prefixCommands` path (via `loadCommands` and `setPlatformIndex`)
is collapsed: `loadCommands` stops taking it; `setPlatformIndex` is its only
source.

## 3. Kill the duplication first (step 1 of the ladder)

`inputAfterPrefix` (terminal-view.ts:1546–1560) and `stripPrefix`
(suggestion-engine.ts:697–722) implement the same skip-flag walk. A design
review traced both for behavioral divergence (e.g. `sudo -u root` at
end-of-string) and found them **equivalent** — the differences are stylistic.
So this is pure dedup, not a bug fix: delete the untested copy, don't
"fix" anything. Export a wrapper from suggestion-engine.ts

```ts
export function effectiveInputAfterPrefix(input: string, prefix: string,
  prefixCommands: Record<string, PrefixCommandDef>): string
```

that reuses `stripPrefix` internally, and have `ghostPayloadForTop` /
`getCommandRemainder` callers use it. Delete the view copy. The engine test
suite (494 lines) covers the walk indirectly through `query`; add one direct
test pinning the end-of-string case (`sudo -u root` → remainder `""`) so the
unified behavior stays pinned.

## 4. Steps

1. **Dedup:** add `effectiveInputAfterPrefix` to suggestion-engine.ts (§3),
   point both call sites at it, delete `inputAfterPrefix`. One direct test
   in suggestion-engine.test.ts. `npm run build` + `npm test`.
2. **Extract keystroke router:** write `routeKeystroke` as a pure function,
   unit-test it against the semantics table today (Tab accept/pass-through/
   dropdown-accept, Escape cascade ×3, Ctrl+Space, Alt+ArrowRight with and
   without a visible ghost — using the three escape variants the code pins
   at 382 — Enter/backspace/arrows/paste, dropdown Up/Down) — one test case
   each, plus the sentinel-resolution contract. Then replace the `onData`
   body with route+apply. Build.
3. **Extract controller:** move the query pipeline and output-side logic
   into `SuggestionController`; TerminalView subscribes. Move
   `setMode`/`onPromptDetected`/`getCommandRemainder` wiring. Build.
4. Rebase the output-listener split onto plan-session-channel's output
   events (channel emits decoded output + phase; controller consumes). If
   that plan hasn't landed, stop and land it first — the ordering is now
   mandatory, not optional.
5. Manual regression: suggestions on iosxe/linux-bash against test_server,
   echo re-sync after arrow-key edit, paste >128 chars (suppression),
   Ctrl+Space toggle, dropdown accept with prefix command (`sudo ...`),
   dropdown arrow navigation with ghost re-sync.

## 5. Verification

- `npm run build` (tsc strict) exits 0 after every step.
- `npm test` — existing 494-line engine suite untouched and passing, plus
  new router tests (~18 cases) and the stripPrefix direct test.
- Manual list in §4.5. `cargo check` not needed — no backend change.

## 6. Deliberate non-goals

- No change to matching semantics — route/table shapes mirror today's
  behavior exactly; tests pin it.
- No `matchFixed`/`matchUnordered` lit-walk unification (review noted it;
  separate, riskier change).
- No dropdown/ghost rendering changes; they stay as-is behind callbacks.