# Plan: Shared UI Micro-Modules — Kill the Copy-Paste Seams

Candidate 8 from the architecture review (September 2026). This plan is
self-contained; it does not depend on the review session.

## Problem

Four concepts are re-implemented privately across components, with
behavior that has already drifted between copies:

| Concept | Copies | Locations |
|---|---|---|
| HTML attribute escaping | 3 private + 2 hand-rolled | `escAttr` in kb-import-dialog.ts:842, kb-viewer-dialog.ts:683, settings-screen.ts:1597; raw `esc` helpers in main.ts:704, 763 — while `src/lib/format.ts:10` already exports the real `escAttr` (host-screen.ts:28 imports it) |
| Delete-confirm overlay | 4 | nav-panel.ts:726 (`renderDeleteConfirm`), host-screen.ts:443 (same name), kb-viewer-dialog.ts:306 (`renderDeleteOverlay`), main.ts:703 (`showCloseConfirm`) |
| Listbox keyboard navigation (ArrowUp/Down + Enter/Escape + selected index + scrollIntoView) | 6 | lib/dropdown.ts (the real one), global-search.ts:302, kb-viewer-dialog.ts:463 (`handleKey`), nav-panel.ts:1501 (`bindKeys`), settings-screen.ts:976–1046 (`ms-*` multi-select), host-screen.ts:597 secret-ref combobox (`handleComboKey`) |
| Credential radio group + conditional fields (auth_type / netbox_auth_type, both with visibility toggles) | 3 | host-screen.ts:305–351 + 568–578, settings-screen.ts:602–664 + `updateNetboxAuthVisibility` (1133–1144), netbox-configure-dialog.ts:92+ |

This is a security-relevant drift: `escAttr` copies that diverge on the
escaped character set are how attribute-injection bugs are born. The
confirm and listbox copies drift in focus handling and scroll behavior.

Deletion test: each shared module passes. Deleting the copies doesn't move
complexity around — it concentrates it in one implementation each.

## Solution

One deep module per concept. Existing modules win where they exist
(ladder rung 2: reuse before create):

- `escAttr`/`escHtml` — `src/lib/format.ts` is already the single home.
  Delete the private copies. No new module.
- `confirmDialog` — new `src/lib/confirm-dialog.ts`, one narrow interface.
- `listboxNav` — new `src/lib/listbox-nav.ts`: a pure key-handler factory
  that `Dropdown` also uses internally, so the dropdown and the five
  hand-rolled copies share one implementation.
- `credentialFieldset` — new `src/lib/credential-fieldset.ts`: renders
  the radio group + conditional inputs and exposes `collect()` /
  `setCredential()`. The three forms consume it.

Nothing here changes any component's visual output. Same markup classes,
same behavior — the markup just gets produced by one implementation
instead of four.

## 1. escAttr / escHtml — pure deletion (do first, smallest diff)

1. Compare each private copy against `format.ts`'s implementation
   (escHtml: `& < > "`; escAttr adds `'` → `&#39;`). kb-import-dialog.ts:842
   and settings-screen.ts:1597 match the escape set; kb-viewer-dialog.ts:683
   must be diffed line-by-line — if it escapes fewer characters, it's a
   bug the deletion fixes, not a regression.
2. Replace each `this.escAttr(` call with `escAttr(` (import from
   `../lib/format`). Same for the two `esc` copies in main.ts.
3. Delete the five private helpers. `grep -rn "private escAttr"` returns
   nothing.
4. One test addition in `src/lib/format.test.ts` (create if missing): pin
   the escaped character set `& < > ' "` with a table test, so future
   copies have a reference implementation to be diffed against.

## 2. confirmDialog

Today's four overlays differ in: title/message copy, confirm-button
label, destructive styling, and what happens on Escape/cancel. Shared
shape: backdrop + message + cancel/confirm buttons + Escape-to-cancel +
focus handling.

```ts
// src/lib/confirm-dialog.ts
export interface ConfirmOptions {
  title: string;
  message: string;          // may contain escHtml-escaped HTML (today's copies interpolate)
  confirmLabel: string;    // "Delete", "Disconnect", ...
  destructive?: boolean;   // red confirm button styling
  onConfirm: () => void;
  onCancel?: () => void;   // optional cleanup
}
export function confirmDialog(opts: ConfirmOptions): void;
// renders into a per-call overlay, wires Escape/cancel, removes itself.
```

Rollout:

1. Extract nav-panel's `renderDeleteConfirm` body first (it's the modal
   reference shape). Confirm class names and DOM structure match
   `_modals.css` / `_overlays.css` conventions — reuse the existing
   classes; do not invent new ones.
2. Point the other three at it: host-screen delete, kb-viewer delete,
   main.ts close-tab confirm. Each call site keeps its copy and labels;
   only the overlay plumbing dies.
3. Tests (`src/lib/confirm-dialog.test.ts`, jsdom): renders message;
   confirm calls back and removes overlay; cancel + Escape call onCancel
   and remove; focus lands on confirm for destructive dialogs (match
   today's behavior — diff each old copy's focus handling first and
   keep the majority behavior).

Component-specific overlays (the variables modal, replay panel) are NOT
confirm dialogs and stay put.

## 3. listboxNav

The six copies share the same contract: a list of focusable/selected
items, ArrowUp/Down to move the selected index (wrapping per current
behavior — diff first; dropdown.ts wraps, verify the others), Enter to
accept, Escape to dismiss, and scrollIntoView on move.

```ts
// src/lib/listbox-nav.ts
export interface ListboxNavOptions {
  count: () => number;             // dynamic — lists filter as you type
  selected: () => number;
  setSelected: (i: number) => void;
  onAccept: (i: number) => void;  // Enter
  onDismiss: () => void;          // Escape
  wrap?: boolean;                 // default true, matching Dropdown
}
/** Returns a keydown handler; caller binds/unbinds and calls e.preventDefault() per the returned action. */
export function listboxNav(opts: ListboxNavOptions): (e: KeyboardEvent) => void;
```

Rollout:

1. Extract the pure decision (key → move/accept/dismiss, with wrap) and
   unit-test it: up/down at ends with and without wrap, Enter, Escape,
   non-listbox keys ignored.
2. Refactor `Dropdown` (src/lib/dropdown.ts:88 `moveUp`) to use it
   internally — the highest-traffic consumer validates the contract.
3. Migrate the other five one at a time, preserving each copy's quirks
   where they're load-bearing (kb-viewer's containment guard at
   kb-viewer-dialog.ts:467–469 stays; it's about when to react, not how).
   The settings multi-select and the host-screen combobox keep their
   rendering; only the key dispatch converges.

Non-goal: a generic virtual-list abstraction. This is only the keyboard
decision + callbacks.

## 4. credentialFieldset

The three copies render the same radio set — password / SSH key / SSH
agent / secret-ref — with conditional inputs and a visibility toggle for
password fields. The `CredentialSource` union (`tauri-api.ts`) is already
the shared type; the forms differ only in radio name attribute
(`auth_type` vs `netbox_auth_type`) and which platform presets are
offered for secret-ref providers.

```ts
// src/lib/credential-fieldset.ts
export interface CredentialFieldsetOptions {
  name: string;                        // radio name attr: "auth_type" | "netbox_auth_type"
  credential: CredentialSource | null; // prefill
  providers: string[];                 // enabled secret-ref provider ids
  onChange?: () => void;               // visibility toggle re-render hook
}
export function renderCredentialFieldset(o: CredentialFieldsetOptions): string;
export function collectCredential(name: string, fd: FormData): CredentialSource | null;
```

Rollout:

1. Extract from host-screen's form (the richest copy — agent identities,
   secret-ref combobox). Unit-test `collectCredential` against the
   FormData shapes all three sites produce: password, ssh_key path,
   agent fingerprint, secret_ref provider+reference, empty → null.
2. Migrate settings-screen's NetBox auth section (drop
   `updateNetboxAuthVisibility` in favor of the fieldset's own toggle).
3. Migrate netbox-configure-dialog (the "inherit" option is dialog-level:
   keep it as a radio the dialog renders before the fieldset).

Non-goal: form validation beyond today's. The fieldset mirrors current
markup/classes exactly.

## 5. Steps

1. escAttr deletion (§1). `npm run build` + `npm test`.
2. confirmDialog extraction + tests + 3 migrations (§2). Build + test.
3. listboxNav extraction + tests + Dropdown refactor (§3). Build + test +
   manual dropdown check in the terminal (suggestion dropdown is the
   highest-traffic listbox in the app).
4. Remaining listbox migrations, one per commit (§3). Build + test.
5. credentialFieldset extraction + tests + 3 migrations (§4). Build +
   test.
6. Manual regression pass: host form save with each credential type,
   NetBox settings save, kb delete, nav delete, tab close confirm,
   global-search arrow keys, settings multi-select, secret-ref combobox.

Each step is independently shippable; steps 2–4 can interleave.

## Verification

- `npm run build` (tsc strict) exits 0 after every step.
- `npm test` exits 0; new suites for confirm-dialog, listbox-nav,
  credential-fieldset, and the format escape-set pin.
- `grep -rn "private escAttr" src` returns nothing after step 1.
- Manual list in step 6.

## Deliberate non-goals

- No rendering-model change (no virtual DOM, no incremental render) — the
  full-innerHTML re-render pattern stays; that's a separate review
  candidate.
- No styling changes — all markup keeps existing classes and tokens.
- No new dependencies.
- The listbox copies' containment guards (when to react) stay at their
  call sites; only the key decision converges.