# Plan: Keystroke Resolution — Move It Behind the Suggestion Controller

Candidate 2 from the architecture review (September 2026). This plan is
self-contained; it does not depend on the review session. It builds on the
extraction work already landed in commits 1006c68 and 9d9c9cf, which
produced `keystroke-router.ts`, `suggestion-controller.ts`, and
`session-channel.ts`.

## Problem

Three related leaks keep the keystroke path shallow after those
extractions:

1. **TerminalView interprets routing results it shouldn't understand.**
   `applyRoute` (terminal-view.ts:319–357) resolves the router's sentinel
   constants (`S_ACCEPT_GHOST`, `S_ACCEPT_NEXTWORD`, `S_ACCEPT_DROPDOWN`)
   through live widgets, then reaches into `this.controller.buffer.append/
   backspace` (terminal-view.ts:334, 343–346) to apply the router's
   `shadowOps`. `ShadowOp` is a controller-level concept; the view both
   interprets it and duplicates the append-all-printable walk for
   word-accept (terminal-view.ts:334 loops `for (const ch of word)`).
   `applyRoute` is the hardest logic left in the view and has zero tests.

2. **Accept semantics are split across three files.** Ghost payload
   derivation lives in the engine (`ghostPayloadFor`), the controller
   (`ghostPayloadForTop`, `remainderFor`, suggestion-controller.ts:247–273),
   and ghost-text (`ghostPayloadAcceptText`). Accept paths: Tab-accept is
   resolved in the view (terminal-view.ts:323–329), dropdown-accept in the
   controller (`acceptDropdownSelection`, suggestion-controller.ts:288),
   word-accept in the view + controller buffer (terminal-view.ts:330–337).

3. **Two dropdown-accept methods duplicate each other.**
   `acceptDropdownSelection()` (suggestion-controller.ts:288–301) and
   `acceptFromDropdown(cmd, payload)` (suggestion-controller.ts:308–317)
   have the same body shape — fetch payload, send
   `ghostPayloadAcceptText(payload)` or name remainder, reset, hide
   widgets. One is a wrapper of the other in all but name.

Deletion test: deleting `applyRoute` and the duplicated accept method
concentrates their logic in the controller; the view keeps only
widget-visibility calls. Yes — concentrates.

## Solution

Make `SuggestionController` the deep module for the whole keystroke path.
The router stays pure (it is well-tested and stays as-is). The controller
grows one public entry point:

```ts
keyIn(data: string, view: RouteView): void;
```

The view's `onData` becomes three lines: route, `controller.keyIn(data,
routeResult)`, apply the few remaining view-only flags. Sentinel
resolution, ShadowOp application, accept paths, and payload derivation all
move inside the controller, where the existing fake-deps test suite
already exercises them.

## 1. What moves into the controller

### `keyIn(data, route)` — absorbs `applyRoute` (terminal-view.ts:319–357)

```ts
keyIn(data: string, r: RouteResult): void {
  for (const s of r.send) {
    if (s === S_ACCEPT_DROPDOWN) this.acceptDropdownSelection();
    else if (s === S_ACCEPT_GHOST) this.acceptGhost();
    else if (s === S_ACCEPT_NEXTWORD) this.acceptNextWord();  // falls back to send(data)
    else this.deps.send(s);
  }
  this.applyShadowOps(r.shadowOps);
  if (r.markCursorMoved) this.cursorMoved = true;   // replaces public markCursorMoved
  if (r.toggleSuggestions) this.toggleSuggestions(); // private now
  if (r.moveDropdown) this.moveDropdown(r.moveDropdown);
  if (r.rebuildGhost) this.syncDropdownToGhostText();
}
```

Private bodies, moved from the view:

- `acceptGhost()` — terminal-view.ts:323–329: `ghost.getCurrentRemainder()`
  → `deps.send(rem)` → `this.reset()` → `ghost.hide()`. The controller
  already owns `reset()`; nothing here is view logic.
- `acceptNextWord(data)` — terminal-view.ts:330–337: word-accept via
  `ghost.acceptNextWord()`, else fall back to `deps.send(data)`. The
  accepted word is appended through `this.shadowBuffer.appendAll(word)`
  (deleting the view's manual char loop; `appendAll` already exists,
  shadow-buffer.ts:45–49, same ≥32 filter).
- `applyShadowOps(ops)` — terminal-view.ts:343–346: append/backspace/reset
  against `this.shadowBuffer` + `this.reset()` for the `reset` op. The
  public `buffer` getter and `markCursorMoved()` go private or disappear.

**What stays in the view (view-only flags):**

```ts
this.terminal.onData((data) => {
  const r = routeKeystroke(data, { connected: ..., dropdownVisible: ...,
                                   ghostShowing: ..., sidebarOpen: ... });
  this.controller.keyIn(data, r);
  if (r.hideGhost) this.ghostText?.hide();        // widget visibility
  if (r.hideDropdown) this.dropdown?.hide();
  if (r.dismissSidebar) this.toggleSidebar();
});
```

Sentinels and `ShadowOp` remain exported types of keystroke-router.ts —
they are the router→controller contract. The router itself is unchanged:
its tests (192 lines) pin the branching; only the consumer changes.

### `pasteClipboard` — the untested desync (terminal-view.ts:380–387)

Paste sends raw text (multi-line included) but only filters printable chars
into the shadow buffer, so a multi-line paste desyncs the buffer until the
next prompt reset. Move the send+append into the controller:

```ts
paste(text: string): void {   // controller
  if (!this.connected || !text) return;
  this.deps.send(text);
  this.shadowBuffer.appendAll(text);   // buffer.appendAll keeps its ≥32 filter
}
```

The view keeps only the clipboard read: `navigator.clipboard.readText()
  .then(t => this.controller.paste(t))`. Pin with a controller test:
multi-line paste sets the buffer to the printable residue — same behavior
as today, now tested instead of accidental. (Buffer reset on `\n` is a
separate, deliberately unchanged behavior — see non-goals.)

### Accept dedup

`acceptDropdownSelection()` becomes: fetch selection, delegate to
`acceptFromDropdown(selected.command, dd?.getSelectedPayload() ??
this.ghostPayloadForTop(selected, buffer))`, then hide the dropdown. One
body remains.

### Unify payload derivation (small)

`acceptGhost` uses `ghost.getCurrentRemainder()` — the widget's live
remainder — not `ghostPayloadForTop`. Keep that: the ghost widget owns the
on-screen payload, and re-deriving could disagree with what's rendered.
Derivation stays split only where the ownership is real (widget vs engine);
this plan does not force a fake unification.

## 2. Controller interface after the change

```ts
export class SuggestionController {
  // existing: loadCommands, setPlatformIndex, setMode, setConnected,
  //           setSuggestionsEnabled, refresh, dispose, onOutput, onPromptDetected,
  //           remainderFor, syncDropdownToGhostText
  keyIn(data: string, r: RouteResult): void;    // NEW — absorbs applyRoute
  paste(text: string): void;                    // NEW — from pasteClipboard
  get input(): string;
  get isReceivingOutput(): boolean;
  // DELETED from public: buffer getter, markCursorMoved(), reset(),
  //                      acceptDropdownSelection stays private-ward but is
  //                      still called internally; external callers were only
  //                      applyRoute (view).
}
```

Check external callers before deleting: grep `controller.buffer`,
`controller.markCursorMoved`, `controller.reset` — all current call sites
are inside terminal-view's `applyRoute`/`onKey` handling and move into the
controller. `toggleSuggestions` (Ctrl+Space, router flag) calls
`setSuggestionsEnabled(!this.suggestionsEnabled)` internally; the view's
separate `setSuggestionsEnabled`/`getSuggestionsEnabled` localStorage
module (terminal-view.ts:105–114) stays — the view still owns the toolbar
toggle UI and calls `controller.setSuggestionsEnabled`.

## 3. Tests

Extend `suggestion-controller.test.ts` (it already has fake ghost /
dropdown / sidebar deps and fake timers):

- `keyIn` sentinel resolution: Tab with dropdown visible → dropdown accept
  path (send called with remainder, reset, hide); Tab with ghost showing →
  ghost accept; word-accept appends the word to the buffer via
  `appendAll`; word-accept fallback forwards raw data.
- `keyIn` shadowOps: append, backspace, reset ops mutate the buffer; the
  reset op also clears cursorMoved.
- `paste`: connected → send called with the raw text and buffer holds
  printable residue only; not connected → no send.
- Accept dedup: `acceptFromDropdown` with payload and without payload
  (name remainder path) — the `acceptDropdownSelection` delegation test
  covers the wrapper.
- Ghost accept with a null remainder: nothing sent, ghost still hidden.

Existing keystroke-router tests must stay green untouched — the router
contract does not change.

## 4. Steps

1. **Dedup accepts** inside the controller (acceptDropdownSelection →
   acceptFromDropdown delegation). Controller tests for both paths. Build
   + test.
2. **Add `keyIn`** to the controller with private `applyShadowOps`,
   `acceptGhost`, `acceptNextWord`; port bodies from terminal-view
   `applyRoute`. Tests (§3). Do NOT rewire the view yet. Build + test.
3. **Add `paste`** + test. Build + test.
4. **Rewire terminal-view**: `onData` → route + `controller.keyIn` + the
   four view-only flags; `pasteClipboard` shrinks to the clipboard read;
   delete `applyRoute`. Delete now-dead public members (`buffer` getter,
   `markCursorMoved`, `reset` if external callers are gone). Build + test.
5. **Manual regression** on a debug build against the test server:
   Tab-accept ghost, Tab-accept dropdown selection, Alt+ArrowRight
   word-accept then continued typing, Enter/Ctrl+C reset, Ctrl+Space
   toggle, multi-line paste then suggestion behavior, Escape cascade
   (dropdown → sidebar → ghost).

## Verification

- `npm run build` (tsc strict) exits 0 after every step.
- `npm test` exits 0; router suite untouched; controller suite grows.
- No backend change — `cargo check` not required.

## Deliberate non-goals

- No change to routing semantics — `routeKeystroke` is untouched.
- No change to the shadow-buffer model (AGENTS.md rule 1): the controller
  still only observes; `paste`'s printable filter is preserved as-is.
- No buffer reset on paste newlines (today's behavior kept; the echo re-sync
  path is the correct future fix and belongs to the line-tracker work).
- No unification of `getCurrentRemainder` with `ghostPayloadForTop` — the
  widget owns the rendered payload.
- terminal-view's toolbar/search/sidebar/replay chrome is not touched —
  that is a separate plan (god-module split, review candidate 6).