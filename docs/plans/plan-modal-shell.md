# Plan: Modal Shell — One `openModal()` for Every Hand-Rolled Dialog

Candidate 2 from the architecture review (September 2026). This plan is
self-contained; it does not depend on the review session. It builds on
`plan-shared-ui-modules.md` (commit b42c6cc), which extracted
`confirm-dialog.ts` as the shared delete/confirm overlay.

## Problem

`confirmDialog` (src/lib/confirm-dialog.ts) solved the dialog shell once —
backdrop, `role="dialog" aria-modal`, Escape on capture with
`stopPropagation` (so Escape never reaches the xterm cascade), backdrop
click, cancel wiring, focus, cleanup-return. Nine other dialog sites
hand-rolled the same shell and drifted:

| Site | Shell code | Escape |
|---|---|---|
| main.ts:392, 747 (2 modals) | hand-rolled | global shortcut listener only |
| host-screen.ts:261 (host form) | hand-rolled | yes (526–534) |
| kb-import-dialog.ts:213 | hand-rolled | no — close button only |
| kb-viewer-dialog.ts:134, 149, 174 (3 modals) | hand-rolled | yes, via document keydown + `offsetParent === null` visibility hack (431–437) |
| netbox-configure-dialog.ts:68 | hand-rolled | **no** |
| replay-save-dialog.ts:76 | hand-rolled | **no** |
| terminal-view.ts:1346 (replay vars) | hand-rolled | **no** |
| settings-screen.ts:1357, 1441 (2 modals) | hand-rolled | **no** |

Counting confirm-dialog, that is 10 shells. Five of the nine hand-rolled
sites have **no Escape handling at all** — a user-visible a11y gap
(docs/accessibility.md targets WCAG 2.1 AA), not a deliberate difference.
Every site repeats ~30 lines: create `modal-backdrop` div, `role="dialog"
aria-modal="true"`, cancel/backdrop wiring, teardown.

Deletion test: deleting the nine hand-rolled shells and generalizing
confirm-dialog concentrates the shell in one module; each dialog's unique
content (import stage machine, replay segment model, credential fieldset)
stays put. Yes — concentrates.

## Solution

One deep module: `openModal()` in `src/lib/modal.ts`.

```ts
export interface ModalOptions {
  /** Panel CSS class (e.g. "modal-panel wide-form"). Required. */
  panelClass?: string;
  /** HTML for the modal panel's interior. Required. */
  content: string;
  /** Close on Escape (default true). */
  dismissOnEscape?: boolean;
  /** Close on backdrop click (default true). */
  dismissOnBackdrop?: boolean;
  /** Element to focus after mount (defaults to first button or the panel). */
  initialFocus?: string;             // CSS selector, else "first button, then panel"
  /** Called when dismissed without an explicit close (Esc/backdrop). */
  onDismiss?: () => void;
}

export interface ModalHandle {
  close(): void;                     // force-teardown; onDismiss NOT called
  readonly panel: HTMLElement;       // mount point for the caller's content
}

export function openModal(opts: ModalOptions): ModalHandle;
```

Semantics, all pinned by the existing confirm-dialog implementation:

- Escape handled on **window capture with `preventDefault` +
  `stopPropagation`** (confirm-dialog.ts:42–50) so it never cascades into
  xterm. This is the fix for the five missing-Escape sites.
- Dismiss flags default to `true`; opt-outs must be visible at the call
  site. The one known case: `kb-import-dialog` during a running import
  passes `dismissOnEscape: false` so a stray Escape can't kill a mid-stream
  LLM import — its own close button must gate on import state as it does
  today.
- `close()` is the caller's escape hatch for programmatic teardown (the
  confirm pattern's returned cleanup fn).
- No submit/validate logic lives in the shell — forms keep their own
  collect/validate code and their own `role="alert"` error line; only the
  shell (open/close/escape/focus) concentrates.

`confirmDialog` becomes a thin adapter over `openModal`: builds the two
buttons, routes ok/cancel, returns cleanup. Its public interface
(`ConfirmOptions`, return type) does not change — the five current callers
(main.ts:704, nav-panel.ts:888, host-screen.ts:801, kb-viewer-dialog.ts:494,
terminal-view.ts:887) are untouched.

## 1. Build the shell (do first, no callers move)

1. Create `src/lib/modal.ts` with `openModal`/`ModalHandle`. Port the
   lifecycle mechanics from confirm-dialog.ts (backdrop creation,
   `modal-backdrop` + `modal-panel` classes, capture-phase Escape, backdrop
   click test `e.target === backdrop`, focus + restore, `document.body`
   append/remove).
2. Rewrite `confirm-dialog.ts` as the adapter over `openModal`; delete its
   inline lifecycle. `npm run build` + `npm run test` —
   `confirm-dialog.test.ts` must stay green unchanged (it is the first
   regression pin for the shell's Escape/backdrop/focus behavior).
3. Add `modal.test.ts`: open → panel in DOM + `role="dialog"`; Escape →
   dismiss + `onDismiss` called + listener removed; Escape with
   `dismissOnEscape: false` → not dismissed and not propagated; backdrop
   click paths; `close()` → teardown without `onDismiss`;
    `initialFocus`/restore behavior.

## 2. Migrate the ten sites — one sweep

All nine hand-rolled shells migrate in one diff so the shell semantics are
uniform everywhere and the five Escape gaps close together. Per site the
change is mechanical: replace the shell lines with an `openModal` call,
move the site's HTML into `content`, wire its buttons on `handle.panel`,
and delete the site's own backdrop/escape/teardown code.

Migration notes:

- **main.ts (2)**: shortcuts modal and the close-confirm — both keep their
  content; the shortcuts modal keeps its Escape-through-global-listener
  effect but should pass `dismissOnEscape: true` and drop the global
  listener (single owner of Escape).
- **host-screen.ts (1)**: the host form — large content, cancel button
  becomes a `handle.close()` wiring; validation errors stay on the site's
  own alert line.
- **kb-import-dialog.ts (1)**: progress modal + paste mode — pass
  `dismissOnEscape: false` while an import is streaming (gate dynamically:
  re-open semantics unchanged, close button already guards).
- **kb-viewer-dialog.ts (3)**: view + edit + delete-confirm modals — delete
  the `offsetParent === null` visibility hack; the shell owns Escape.
- **netbox-configure-dialog.ts (1)**: gains Escape handling (behavior fix).
- **replay-save-dialog.ts (1)**: gains Escape handling (behavior fix).
- **terminal-view.ts (1)**: replay-variables modal — gains Escape handling;
  keep the xterm-cascade isolation the capture phase already provides.
- **settings-screen.ts (2)**: import-mode + merge-conflict modals — gain
  Escape handling.

Two-call protocol guard: several dialogs open with `.open()` methods and
close via stored handles. Keep each dialog's public class interface
(`open()`, callbacks) unchanged — only the interior implementation swaps.

## 3. Steps

1. Create `modal.ts`; adapt `confirm-dialog.ts` onto it (§1.1–1.2). Build +
   test green.
2. Add `modal.test.ts` (§1.3). Build + test green.
3. Migrate all nine sites in one pass (§2 table). After each file:
   `npm run build`; after all: `npm run test`.
4. Grep for stragglers: `modal-backdrop` creation outside `modal.ts` /
   `confirm-dialog.ts` must be zero; `offsetParent` visibility hack gone.
5. **Manual regression** on a debug build: every migrated dialog opens,
   Escape dismisses it (except kb-import mid-import), backdrop click
   dismisses, cancel buttons work, form validation errors show, focus lands
   in the panel and restores to the trigger on close, and Escape inside the
   terminal-side replay-variables modal does
   NOT leak into the xterm terminal.

## Verification

- `npm run build` exits 0 after every step.
- `npm run test` exits 0; `confirm-dialog.test.ts` unchanged and green;
  `modal.test.ts` green.
- No backend change — `cargo check` not required.

## Deliberate non-goals

- No visual changes — same `modal-backdrop`/`modal-panel` CSS, same markup
  structure. The shell adds no new classes beyond what exists.
- No form validation sharing — the duplicated port-range/secret-ref checks
  in host-screen vs netbox-configure are a separate concern.
- No dialog content refactor — stage machines, segment models, credential
  fieldsets stay exactly where they are.
- The dead test-server TS wrappers and any other cleanup are out of scope.