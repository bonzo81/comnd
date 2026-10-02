# Plan: Keystroke Single Entry — SuggestionController Absorbs the Router

Candidate 1 from the architecture review (September 2026). This plan is
self-contained; it does not depend on the review session. It builds on the
landed extractions from `plan-suggestion-controller.md` (commit 1006c68) and
`plan-keystroke-resolution.md` (commit b9daff6), which produced
`suggestion-controller.ts` and `keystroke-router.ts` in their current shape.

## Problem

The keystroke concept is still split across three files after those
extractions, and the seams between them are where the untested behavior
lives:

1. **The router returns a config object with as many knobs as the code it
   configures.** `RouteResult` has 10 optional fields
   (keystroke-router.ts:32–46), and its application is split across two
   consumers: `TerminalView` applies `hideGhost`/`hideDropdown`/
   `dismissSidebar`/`toggleSuggestions` (terminal-view.ts:304–307) while
   `SuggestionController` applies `shadowOps`/`moveDropdown`/`rebuildGhost`/
   `markCursorMoved` (suggestion-controller.ts:131–140). "What Tab does" is
   decided in the router, half-applied by the view, half by the controller.

2. **Sentinels exist only because the router can't see the widgets.**
   `S_ACCEPT_GHOST`/`S_ACCEPT_NEXTWORD`/`S_ACCEPT_DROPDOWN`
   (keystroke-router.ts:28–30) are strings the view/controller resolve back
   into widget calls — a string protocol between two halves of one decision.

3. **The view gathers routing state it doesn't own.** `RouteView`
   (terminal-view.ts:297–302) reads `channel.state`, `dropdown.isVisible()`,
   `ghostText.isShowing()`, and `sidePanelOpen` from four different owners.
   Three of the four are already visible to the controller
   (`this.connected`, `deps.dropdown()`, `deps.ghost()`); only the sidebar
   open state is genuinely view-private.

4. **Widget visibility has two independent writers.** The view hides
   ghost/dropdown from route flags (terminal-view.ts:304–305) while the
   controller hides them itself in `onOutput` (suggestion-controller.ts:197–198)
   and `debounceSuggestionQuery` (suggestion-controller.ts:236–238). Two
   modules drive the same widget state.

5. **Test fakes re-implement the real widgets.** `FakeGhost` in
   suggestion-controller.test.ts:10–24 duplicates
   ghost-text.ts:111–134 (`getCurrentRemainder`/`acceptNextWord` gating). If
   the real `acceptNextWord` breaks, the controller suite stays green —
   fake drift over a data-capable class.

Deletion test: deleting `keystroke-router.ts` moves the branch table into
`controller.keyIn` and concentrates it there; the sentinels, the `RouteView`
gathering, and the view's flag-application block all evaporate. Yes —
concentrates.

## Solution

Make `SuggestionController` the deep module for the whole keystroke path.
One public entry point, no string protocol, no split application:

```ts
keyIn(data: string): void;
```

`ControllerDeps` grows a small `ui` callbacks object for the only state the
controller cannot see:

```ts
export interface ControllerDeps {
  send: (data: string) => void;
  tracker: LineTracker;
  ghost: () => GhostText | null;
  dropdown: () => Dropdown | null;
  sidebar: { detail: (cmd: Command) => void; placeholder: () => void };
  // NEW — view-private chrome the routing table needs:
  ui: {
    isSidebarOpen: () => boolean;
    dismissSidebar: () => void;
    toggleSuggestions: () => void;
  };
}
```

`keyIn(data)` gathers the routing state itself (`this.connected`,
`deps.dropdown()?.isVisible()`, `deps.ghost()?.isShowing()`,
`ui.isSidebarOpen()`), runs the branch table, and applies everything:
sends, accept resolution, shadow ops, widget hides, sidebar dismissal,
suggestion toggle. TerminalView's `onData` becomes one line.

The branch table (`routeKeystroke` + `defaultRoute` + `LINE_EDIT` +
`ALT_ARROW_RIGHT`) moves into `suggestion-controller.ts` as a **private pure
function**. It keeps its current decision table byte-for-byte, but its
internal result type drops the sentinels — accepts become an action enum
resolved directly against the live widgets, no string round-trip:

```ts
type RouteAction = { kind: "send"; data: string }
                 | { kind: "acceptDropdown" }
                 | { kind: "acceptGhost" }
                 | { kind: "acceptNextWord"; fallback: string };
```

`keystroke-router.ts` and its exported types (`RouteView`, `RouteResult`,
`ShadowOp`, the `S_ACCEPT_*` constants) are deleted. Widget visibility
becomes single-writer: only the controller hides ghost/dropdown from
keystrokes and output; the view keeps only the toolbar-toggle and
reconnect-recreation paths.

## Controller interface after the change

```ts
export class SuggestionController {
  keyIn(data: string): void;                       // REPLACES keyIn(data, route)
  paste(text: string): void;                       // unchanged
  // unchanged: loadCommands, setPlatformIndex, setMode, setConnected,
  //           setSuggestionsEnabled, refresh, dispose, onOutput,
  //           onPromptDetected, remainderFor, syncDropdownToGhostText,
  //           get input, get isReceivingOutput
}
```

The view keeps: `getSuggestionsEnabled`/`setSuggestionsEnabled` localStorage
module (terminal-view.ts:101–110), toolbar toggle UI, and the
`ui.toggleSuggestions` callback — which flips the localStorage pref and
calls `controller.setSuggestionsEnabled`. The view also keeps widget
re-creation on reconnect (`ghost`/`dropdown` accessors stay).

## Tests

The 30 tests in `keystroke-router.test.ts` assert on `RouteResult` fields;
they port to behavior tests at the `keyIn` level, and the widget fakes die:

- **Real widgets in jsdom.** `tests/timestamp-gutter.test.ts` proves xterm.js
  opens headless (with the `matchMedia` polyfill in tests/setup.ts:70–82 and
  the Tauri IPC mock bus in tests/setup.ts:58–67). Construct a real
  `Terminal`, container `div`, real `GhostText`, real `Dropdown`; `send` is
  still a spy. The fake-drift gap closes: `acceptNextWord` word splitting,
  variable-payload Tab pass-through, and the dropdown
  `getSelected`/`getSelectedPayload` two-call protocol
  (dropdown.ts:111–137) get tested for real.
- **Ported behavior tests** (examples): Tab with dropdown visible → accept
  sends remainder + resets + hides; Tab with ghost showing → ghost accept;
  Tab bare → sends `\t` + buffer reset; Escape cascade dropdown → sidebar →
  ghost; arrows with open dropdown move selection + re-sync ghost;
  Alt+→ accepts one word, else forwards raw; Enter/Ctrl+C reset + hide;
  line-edit keys set the untrustworthy state; disconnected → nothing sent.
- **Order-of-application pins:** route-driven hides happen after sends and
  shadow ops (current order, terminal-view.ts:303–307) — assert via spy call
  order.
- **Out of scope in jsdom:** pixel positioning (`positionAtCursor` reads
  zero-size `getBoundingClientRect` in jsdom). Assert show/hide/selection
  state, not placement.
- Existing controller tests (`onOutput`, echo re-sync, paste, refresh,
  debounce) stay; only `ControllerDeps` gains the `ui` object (tests pass a
  stub with three spies).

## Steps

1. **Move the branch table** into `suggestion-controller.ts` as a private
   pure `route(data, view)` returning the internal action-based result.
   Add the `ui` dep to `ControllerDeps` (stub it in the existing test
   suite). Add `keyIn(data)` gathering state + applying everything. Do NOT
   rewire the view yet. Port the 30 router tests to `keyIn` behavior tests
   with real widgets. Build + test.
2. **Rewire terminal-view.ts**: `onData` → `this.controller.keyIn(data)`;
   delete the `RouteView` gathering, flag application, and the router
   import; pass `ui` callbacks in `ControllerDeps` construction. Build + test.
3. **Delete** `keystroke-router.ts` and `keystroke-router.test.ts`; grep for
   stragglers (`S_ACCEPT`, `RouteResult`, `routeKeystroke`). Build + test.
4. **Manual regression** on a debug build against the test server: Tab
   cascade (dropdown accept → ghost accept → passthrough), Escape cascade
   (dropdown → sidebar → ghost), Alt+→ word accept then continued typing,
   Enter/Ctrl+C reset, Ctrl+Space toggle + toolbar sync, arrows with open
   dropdown, line-edit keys then echo re-sync, disconnect → keystrokes
   dropped.

## Verification

- `npm run build` (tsc strict) exits 0 after every step.
- `npm run test` exits 0; router suite replaced by behavior suite; controller
  suite grows real-widget describes.
- No backend change — `cargo check` not required.

## Deliberate non-goals

- No change to routing semantics — every branch decision identical.
- No SuggestionUi extraction (widget rebirth on reconnect stays with the
  view; `ghost`/`dropdown` accessors remain). Revisit when a second
  terminal consumer or a second widget owner appears.
- No SessionChannel widening (direct invoke calls and connection-state
  guards around the channel are a separate plan).
- No shadow-buffer model changes (AGENTS.md rule 1) — the controller still
  only observes input.
- No controller ownership of the suggestions localStorage pref — the view's
  `ui.toggleSuggestions` callback keeps it.