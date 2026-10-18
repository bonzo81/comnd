# Plan: Suppress Shadow Buffer at Secret Prompts

Issue #18 — keep typed secrets out of the frontend shadow buffer and suggestion
UI while preserving the existing remote input path.

## Problem

`SuggestionController` mirrors typed and pasted text into the shadow buffer.
`LineTracker` detects ordinary prompts, but neither currently recognizes secret
prompts. Password and sudo input can therefore accumulate in the buffer and
drive suggestions.

## Solution

Add optional platform-specific secret prompt regexes to each `index.yaml` and
detect them in the frontend line tracker. On a match, clear the shadow buffer,
hide ghost text and the dropdown, and suppress future buffer updates until a
normal prompt is detected.

All input continues through the existing frontend-to-SSH path. Secret mode
changes only what the shadow buffer observes; it does not add local echo or
route keystrokes through Rust.

## Platform-index schema

Add optional `secret_prompt_patterns: string[]` to the Rust and TypeScript
`PlatformIndex` types. Each entry is a regex string matched against the entire
trimmed trailing line as output arrives, before the normal prompt idle window.
Indexes that omit the field remain valid; Rust deserialization defaults it to
an empty list.

Document the field in `docs/specs/06-knowledge-base.md` and define narrowly
scoped patterns in the four bundled indexes:

- `linux-bash`: sudo password prompts.
- `cisco-iosxe` and `cisco-nxos`: enable/password prompts.
- `f5-tmos`: password prompts relevant to TMOS and its shell.

Patterns must match prompt lines, not ordinary command prompts or output.

## Frontend behavior

1. Extend `LineTracker` to load secret patterns and report a secret-prompt
   match separately from an ordinary prompt match. Preserve its existing ANSI
   stripping, full-line matching, and 200 ms idle detection.
2. Wire the patterns from `terminal-view.ts` when the platform index loads.
3. On secret-prompt detection, `SuggestionController` clears the buffer,
   cancels pending suggestion work, hides the ghost and dropdown, and enters
   secret-input mode.
4. While secret-input mode is active, `keyIn` and paste still send exactly as
   they do now, but do not append or otherwise reconcile input into the shadow
   buffer. Suggestions remain hidden, including on refresh or delayed queries.
5. On the next ordinary prompt, clear secret-input mode and retain the current
   prompt-reset behavior so later command input produces suggestions normally.

Linux Bash ships with no ordinary `prompt_patterns` because its prompt is
user-configurable. Use the learned/last detected prompt first, then narrowly
recognize conventional and bracketed shell prompts while recovering. This lets
`sudo -i` change the prompt without leaving secret mode stuck. Cover changed
and repeated Bash prompt transitions in tests.

## Tests

- `line-tracker.test.ts`: secret patterns match only the full prompt line;
  ordinary prompts and similar output do not trigger secret mode; later
  ordinary prompts are still detected.
- `suggestion-controller.test.ts`: a secret prompt clears existing buffer
  content and hides ghost/dropdown; typed and pasted secret text reaches the
  send function but leaves the buffer empty; suggestions resume after a normal
  prompt. Keep existing normal-prompt and keystroke-routing tests passing.
- Rust schema test: indexes with the new field deserialize, and indexes
  without it remain valid.
- Verify bundled patterns against representative secret and normal prompt
  lines for all four platforms.

## Steps

1. Extend the Rust/TypeScript index types and update Rust `PlatformIndex`
   constructors and compatibility tests.
2. Document the field and add prompt patterns to all four bundled indexes.
3. Implement secret-prompt detection and test it in `LineTracker`.
4. Wire detection into `terminal-view.ts`; implement suppression and resumption
   in `SuggestionController` with focused tests.
5. Run `npm run test` and `npm run build` from the repository root.

## Verification

- `npm run test` exits 0.
- `npm run build` exits 0.
- Tests prove that secret input is forwarded but never accumulates in the
  shadow buffer, suggestions stay hidden while secret mode is active, the
  buffer clears at detection, and suggestions resume at the next normal prompt.
- Existing normal-prompt and suggestion tests pass.

## Deliberate non-goals

- No changes to SSH authentication or credential handling.
- No changes to local echo, the Rust keystroke path, or suggestion matching.
- No new dependencies or unrelated platform-index changes.
