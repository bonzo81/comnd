# Accessibility (P3.5)

Conformance target: **WCAG 2.1 Level AA**. This document states what is
implemented, how to verify it, and what is known to be incomplete. Keep it
updated when interactive components change.

## Status (2026-08)

Implemented and verified by code review + build:

- ARIA roles on all interactive structures: dialogs (`role="dialog"`,
  `aria-modal`, `aria-labelledby`), context menus (`menu`/`menuitem` with
  full keyboard operation), list widgets (`listbox`/`option` with
  `aria-selected`), session tabs (`tablist`/`tab`), toolbar (`toolbar`),
  status regions (`role="status"`, `role="alert"`, `aria-live`).
- Toggle controls expose state: topbar toolbar buttons use `aria-pressed`;
  nav section headers use `aria-expanded`; the side panel button uses
  `aria-expanded` + `aria-controls`.
- Visible keyboard focus indicators on all controls: a global
  `*:focus-visible` outline (2px accent, see `src/styles/main.css`) plus
  component-specific focus styles for context-menu items, session tabs, KB
  command rows, host rows, and nav items. No control suppresses the outline
  without a replacement focus treatment. Native checkboxes and radios take the
  same ring on `:focus`, because WebKit paints those controls itself and does
  not report the `:focus-visible` outline for them.
- Keyboard operation: the nav panel has roving tabindex with
  Arrow/Enter/Left/Right tree navigation; host list and KB command list
  support Arrow/Enter; context menus open with Shift+F10 (host list) and
  support Arrow/Home/End/Enter/Escape/Tab; all modals close with Escape.
- Disabled controls are real `disabled` buttons (nav placeholder items), so
  they are skipped by assistive tech, matching the existing roving-tabindex
  behavior.
- The document language is set (`lang="en"` in `index.html`); all icons are
  decorative SVGs marked `aria-hidden="true"`; icon-only buttons carry
  `aria-label`.

## Automated checks in the smoke suite (2026-11)

`npm run smoke` asserts the keyboard and layout claims above against the real
app, and `npm run smoke -- --mutation=focus|name|layout` proves each category of
assertion still fails when that behaviour is deliberately broken. What the
suite covers:

- Keyboard reachability and a visible focus indicator on the connection
  manager, the terminal with the side panel open and closed, settings, and the
  duplicate-session, KB import, replay-save and NetBox-configure dialogs.
- Modal focus trapped while open and restored to the invoking element on close.
- An accessible name on every control that has no visible label, and error
  toasts announced rather than merely drawn: a polite live region, an `alert`
  role on the error toast, and a named dismiss button.
- The side panel resizing the terminal and driving the PTY size change, never
  overlaying it (ADR-003).
- Dark, light and solarized themes, Reading Comfort mode and enlarged text.
- Small windows, long host names, an expanded folder tree and a scrolling
  dialog, with no clipped or overlapping controls.

These are automated assertions, not an audit. They read computed styles, the
accessibility tree and layout geometry, and they only pass for the states they
visit. They are evidence towards WCAG 2.1 AA, not proof of conformance, and
they do not replace the manual screen reader checklist below.

The assertions found four real defects when they were written, all now fixed:
credential fields stayed focusable while collapsed on the host form (WCAG
2.4.7); the nav panel restored focus to a row after a context menu opened from
the keyboard; rows revealed by expanding a folder each became their own Tab
stop instead of joining the roving tabindex group; and a native checkbox
reported no focus ring under WebKitGTK.

## Manual verification checklist

Screen reader testing is manual. Run this checklist before claiming AA
conformance in release notes.

### NVDA (Windows)

1. Start NVDA, launch Comnd.
2. Host list: Tab reaches the list; items announce as "option, selected" with
   host name/user/host; Arrow keys move selection; Enter connects.
3. Nav panel: Tab reaches first section header; announce "expanded/collapsed";
   Arrow keys move through items; Enter activates.
4. Open the host form (Ctrl+N): NVDA announces the dialog; Tab order covers
   all fields; labels announce on each input; Escape closes.
5. Context menu (Shift+F10 on a host, or right-click): Arrow keys announce
   menu items; Enter activates; Escape closes and focus returns.
6. Terminal: connect to any host; confirm NVDA does not crash on the xterm
   canvas; confirm the connection status bar (`role="status"`) announces
   "connected".
7. Toasts announce politely (`aria-live="polite"` on the toast container).

### VoiceOver (macOS)

1. `VO+Right/Left` traverses the title bar, nav panel, content, status bar.
2. Host list items announce role "list box" with selected state.
3. Dialogs announce "dialog" on open; verify with the host form and the
   delete-confirmation modal.

## Reading Comfort mode

Reading Comfort (spec 12) is the dyslexia-support preset: persisted toggle in
the status bar (`aria-pressed`) + Settings pane, stamps typography defaults,
individual sliders underneath, OFF reverts typography only. It is a
presentation-layer feature — verify it works with `prefers-reduced-motion`
users too (no animation is introduced). The status bar toggle button joins the
ARIA inventory above.

## Shortcut customization (spec 11)

The status bar keyboard button (icon-only, `aria-label` "Keyboard
shortcuts (?)") opens the registry-driven help modal; its "Customize…"
link opens Settings → Shortcuts. The shortcuts pane joins the ARIA
inventory:

- **Live announcements.** The pane owns one polite live region
  (`#sc-live`): it announces the captured combination as the user
  presses keys, the reserved-key rejection text, and the conflict
  message ("<action>" and "<action>" would both use <combo> — pick a
  different combination). Rows currently under a warning set
  `aria-describedby="sc-live"`, so the reason is programmatically
  tied to the affected row.
- **Capture flow.** Clicking (or keying) **Change** enters capture; the
  live chip takes focus and is the only thing receiving keys — the
  capture listener runs at the document capture phase with
  `preventDefault` + `stopPropagation`, so no keystroke leaks to the
  global handler, xterm, or any widget. `Enter` confirms, `Escape`
  cancels; both are announced via the live region on the next render.
- **Locked row.** The pinned `Ctrl+Space` row carries its explanation
  twice: a `role="img"` lock with `aria-label`, and the same text as
  the `title` of a real `disabled` Change button (skipped by assistive
  tech, consistent with the roving-tabindex behavior above).
- **Keyboard-only walk.** Change / capture / Enter / Escape, per-row
  Reset, and Restore all defaults are all reachable and operable
  without a mouse; the modal opens from the status bar button and
  closes with Escape like every other dialog.

## Known gaps

- **Terminal content** — the terminal is an xterm.js canvas. Screen readers
  cannot read arbitrary scrollback. xterm.js offers `screenReaderMode: true`
  (DOM mirror with aria-live), which is OFF by default for performance; enable
  it per user preference in `TerminalView.initTerminal()` if needed. Suggestion
  dropdowns and ghost text are visual; the suggestion dropdown is exposed as a
  `listbox`, but focus never enters it (keystrokes go to the remote device by
  design — see the shadow-buffer rule in AGENTS.md).
- **Drag & drop** — the nav panel tree reordering is pointer-only. Keyboard
  alternatives exist for the same outcomes (context menu → Rename/Delete; hosts
  are assigned groups via the host form's Group field).
- **Screen reader pass** — the checklist above has not been run yet; treat AA
  as the target, not an audited claim.
- **Color contrast** — theme tokens in `src/styles/tokens.css` are guarded by a
  token-pair test (`src/lib/theme-contrast.test.ts`) that composites translucent
  surfaces over their opaque base and asserts 4.5:1 for the known text pairs and
  3:1 for the accent/border non-text pairs in the Light and Solarized Light
  themes, plus a Dark regression floor. The table only covers the pairs it
  names, so it is not a full-page scan and does not prove WCAG conformance — run
  an automated pass (axe or Lighthouse in the dev build) when the theme changes.
