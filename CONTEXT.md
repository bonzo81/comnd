# CONTEXT.md — netssh domain glossary

Vocabulary for the netssh codebase. AI agents and architecture reviews use these
terms; keep them current as concepts crystallize.

## Suggestion pipeline

- **Shadow buffer** — frontend's observed mirror of the input line. Never echoed;
  exists only for suggestion matching. No local echo (AGENTS.md rule 1).
- **Ghost text** — inline completion overlay at the xterm cursor. Payload is
  token-aware (`text` | `literal` | `choice` | `variable`); `variable` is a
  hint, not completable.
- **Keystroke routing** — deciding what one xterm `onData` string does (Tab accept
  vs pass-through, Escape close order, buffer ops). Decision table lives inside
  SuggestionController as a private pure function; the module's interface is
  `keyIn(data)`.
- **SuggestionController** — the deep keystroke module. Owns routing decision,
  sentinel-free accept resolution (ghost/dropdown/sidebar), and the shadow
  buffer mutations. TerminalView calls one method.
- **Line tracker** — merged prompt detector + echo line tracker feeding mode
  awareness and echo re-sync.
- **SuggestionUi** — ghost + dropdown + sidebar detail rendered around a
  terminal; widgets re-created per reconnect, so the controller holds them as
  accessors. UI-only chrome (sidebar open state, suggestion toggle) reaches the
  controller as a `ui` callbacks dep.

## Reading Comfort

- **Reading Comfort mode** — user-facing preset for dyslexic readers. Turning it
  on stamps typography defaults (text size, line height, letter spacing,
  high-contrast suggestions) and a recommended theme, then exposes each as an
  individual control. Internal specs call it "dyslexia mode". It never forks
  the colour palette — the recommended themes stay ordinary entries in the
  theme list, and OFF reverts typography only, leaving theme choice alone.

## Dialogs

- **Modal shell** — shared dialog plumbing owned by `openModal()` in
  `src/lib/modal.ts`: backdrop, `role="dialog"`, Escape (capture +
  stopPropagation), backdrop click, focus, cleanup. Returns `{ close, panel }`.
- **Dismiss flags** — `dismissOnEscape` / `dismissOnBackdrop`, both default
  `true`. Opt-outs must be visible at the call site (e.g. import in progress).
- **Confirm adapter** — `confirmDialog()` is a thin variant over the modal
  shell; it is not the shell itself.