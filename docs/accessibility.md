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
  without a replacement focus treatment.
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

## Manual verification checklist

Screen reader testing is manual. Run this checklist before claiming AA
conformance in release notes.

### NVDA (Windows)

1. Start NVDA, launch net.sh.
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
- **Color contrast** — theme tokens in `src/styles/tokens.css` were chosen for
  contrast but not audited with a tool. Run an automated pass (axe or Lighthouse
  in the dev build) when the theme changes.
