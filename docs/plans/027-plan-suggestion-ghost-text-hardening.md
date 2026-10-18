# Plan: Suggestion & Ghost Text Hardening

Phased implementation plan for robustness and UX fixes to the suggestion
pipeline (shadow buffer → suggestion engine → ghost text / dropdown), based on
a comparison against how fish, zsh-autosuggestions, PSReadLine, Fig/Amazon Q,
Warp, and Copilot CLI implement inline suggestions.

**Findings that motivated this plan** (research summary, 2026-09):

Every mature implementation shares four guard rails comnd lacks:

1. **Suppress when the cursor is not at end-of-line** — fish, zsh, PSReadLine,
   and Fig all gate suggestions on cursor-at-EOL. comnd's shadow buffer
   assumes end-of-line and has no guard at all.
2. **Cap buffer length** — zsh's `ZSH_AUTOSUGGEST_BUFFER_MAX_SIZE` protects
   against paste storms flooding the matcher. comnd queries on any buffer.
3. **Cancel stale in-flight queries** — Copilot CLI and Fig drop results that
   arrive after the buffer changed. comnd renders whatever comes back.
4. **Partial acceptance** — fish's Ctrl-→ / Alt-→ ("accept next word") is the
   most-copied UX in this space. comnd only has Tab-all-accept.

Plus two comnd-specific defects found in the code: the ghost overlay does not
reposition on terminal scroll, and the remote can flip cursor visibility
(`\x1b[?25h`) while comnd has hidden it, leaving the cursor stuck hidden.

## Scope boundaries

In scope:
- Cursor-position guard + buffer-length cap (Phase 1)
- Staleness check for in-flight suggestion results (Phase 2)
- Ghost/dropdown reposition on terminal scroll (Phase 3)
- Remote cursor-escape desync guard (Phase 3)
- Word-partial accept (`Alt+→`) (Phase 4)
- Shadow buffer re-sync from echoed terminal content (Phase 5)

Out of scope (deferred, tracked in Phase 5 "follow-ups"):
- Per-host command history as a suggestion source (docs/08 backlog; needs
  history capture + PSReadLine-style secret scrubbing first)
- Migrating ghost text from DOM overlay to xterm.js decorations API — the
  DOM overlay is the same technique Fig/Amazon Q proved; revisit only if the
  DECTCEM cursor-hide hack causes real problems
- Buffer re-sync for remote-side tab-completion echo (Phase 5 covers the
  general mechanism; remote tab completion re-sync is a special case)
- AI/LLM suggestion layer (docs/08, post-MVP)

## Phase ordering

Each phase ships a verifiable state on its own. Phases 1–3 are pure hardening
(no new behaviour); Phase 4 adds a keybinding; Phase 5 is the only
architectural change.

| Phase | Ships | Depends on |
|---|---|---|
| 1 | EOL guard + buffer cap | — |
| 2 | Staleness check on suggestion results | — |
| 3 | Scroll reposition + cursor-escape guard | — |
| 4 | `Alt+→` word-partial accept | — |
| 5 | Shadow buffer re-sync from echo | — |

---

## Phase 1 — Cursor guard + buffer cap

Goal: suggestions only appear when the shadow buffer is trustworthy. Smallest
diff, kills the two most common garbage-suggestion causes.

### 1.1 Track line-editing keystrokes

`terminal-view.ts` `onData` handler (src/components/terminal-view.ts:310).
Currently arrow-left/right and Ctrl-line-edits fall into the "let all other
keys through" path and the buffer keeps growing.

- `Arrow Left` (`\x1b[D`) / `Arrow Right` (`\x1b[C`), `Home` (`\x1b[H` or
  `\x1b[1~`), `End`, `Ctrl+A`, `Ctrl+E` → set a `cursorMoved` flag (one
  boolean, reset on Enter/Ctrl+C/prompt-detect — same reset points as the
  shadow buffer).
- `Ctrl+U` / `Ctrl+W` (line/word kill) → also set `cursorMoved`; the buffer
  content after a kill is unknowable without echo parsing (Phase 5 fixes
  this properly — the flag is the interim guard).
- `Ctrl+D` (EOF/delete) → flag (it may or may not edit, conservative).

### 1.2 Suppress suggestions when flagged

`debounceSuggestionQuery` (src/components/terminal-view.ts:1378): add
`this.cursorMoved` to the early-return condition alongside
`receivingOutput`. Ghost hidden; dropdown cleared. On Enter/Ctrl+C reset,
clear the flag so the next prompt line gets suggestions again.

### 1.3 Buffer-length cap

Same early-return: if `text.length > MAX_SHADOW_LEN` (128 — longer than any
KB command prefix but short enough to reject pastes), hide and return. Add
the constant to `shadow-buffer.ts` next to the class. zsh uses 1024 for full
shell buffers; comnd suggestions are command-shaped, 128 is generous.

**Verify:** type `sh`, press left-arrow, type `o` → no ghost appears. Type a
128+ char paste → no ghost, no query spam in logs. Normal typing unaffected.

---

## Phase 2 — Staleness check

Goal: an in-flight suggestion result that lands after the buffer changed is
dropped. Copilot/Fig model. Cheap because the query text travels with the
closure.

`showSuggestions(text)` (src/components/terminal-view.ts:1393): the call site
is already inside the 40ms debounce timer, so staleness window is small — but
`query()` is synchronous, so the real staleness risk is the timer itself.

Change: inside the timer callback, re-read `this.shadowBuffer.content` and
compare to the captured `text`. Mismatch (user typed/backspaced since the
timer was scheduled — possible when the timer fires during rapid typing
before the next debounce resets it... debounce already clears, so the actual
window is the 40ms of the timer plus the synchronous query) → re-schedule
with the new text instead of rendering stale.

Also apply to the output-timer re-trigger at
src/components/terminal-view.ts:881: it calls
`showSuggestions(this.currentInput)` — capture `currentInput` at schedule
time and re-read it at fire time; if changed, re-debounce rather than render.

**Verify:** rapid typing + output bursts → no ghost flicker showing text that
does not match the visible input line. Log one `LogTag.Suggest` debug line
when a stale result is dropped (cheap observability).

---

## Phase 3 — Overlay reposition + cursor-escape guard

Goal: ghost text never floats at stale coordinates; cursor never stuck
hidden.

### 3.1 Scroll listener

`GhostText.reposition()` exists (src/lib/ghost-text.ts:123) but is only wired
to sidebar resize / window resize
(src/components/terminal-view.ts:1217, :1252). Wire it to terminal scroll:
xterm's `onScroll` fires on buffer scroll, and the viewport scrollbar drag
needs a `scroll` event listener on the `.xterm-viewport` element (query for
it in the container). Also reposition the dropdown — same anchor math lives
with the dropdown open logic; call `dropdown.reposition()` if the dropdown
has one, otherwise hide dropdown on scroll (simpler: PSReadLine's ListView
scrolls with the line; hiding on scroll is acceptable and one line).

Decision: **hide dropdown on scroll, reposition ghost on scroll.** Dropdown
is transient UI; ghost is anchored to the cursor.

### 3.2 Cursor-escape desync guard

`GhostText` writes `\x1b[?25l` on show and `\x1b[?25h` on hide
(src/lib/ghost-text.ts:73, :95). If the remote emits `\x1b[?25h` (TUI apps,
`clear` on some devices) while ghost is visible, xterm shows the cursor and
comnd's `cursorHidden` bookkeeping still says hidden — later `hide()` writes
a redundant show, but if remote emitted hide after that, cursor can end up
stuck hidden.

Minimal fix: in the SSH data handler
(src/components/terminal-view.ts:833), detect `?25h` in incoming text while
`ghostText.isShowing()` → call `ghostText.notifyCursorShown()` (new one-line
method setting `cursorHidden = false`). Additionally, on `onPromptDetected`
(prompt-detector callback, terminal-view.ts:208) force-show the cursor via
`ghostText.hide()` — a fresh prompt always wants a visible cursor.

**Verify:** run `top` then `q`, then type → ghost positions correctly after
scroll; cursor visible after any command whose output includes DECTCEM show.

---

## Phase 4 — Word-partial accept (`Alt+→`)

Goal: fish's "accept next word" grammar. This is the highest-value UX add and
the reason Phase 4 exists.

### 4.1 Accept-word helper

In `ghost-text.ts`: `acceptNextWord(): string | null` — returns the next
whitespace-delimited chunk of `currentRemainder` (including one trailing
space if more remainder follows, so words stay separated remotely). Returns
null for variable payloads (same rule as Tab — a `<placeholder>` is not
completable text) and null when remainder is empty.

### 4.2 Keybinding

In `onData` (terminal-view.ts:310): intercept `Alt+ArrowRight` — xterm
delivers it as `\x1b\x1b[C` (ESC ESC [ C) or `\x1b[1;3C` depending on
terminal; handle both sequences. When ghost is showing:

- `const word = ghostText.acceptNextWord()`
- if word → `sendData(word)`, update shadow buffer by appending the word
  (do NOT reset — the suggestion continues for the next word), let the
  normal onUpdate → debounce flow refresh ghost for the next token.
- if null → pass through to remote (fish behaviour: partial-accept keys fall
  through when nothing to accept).

`Alt+ArrowLeft` is not intercepted (no equivalent need; passes through as
today).

### 4.3 Docs

Update docs/specs/07-keyboard-shortcuts.md terminal table: `Alt+→` — accept next
word of ghost suggestion (when ghost visible) / pass through. Note in
docs/specs/05-suggestion-engine.md § Suggestion UI: ghost accepts Tab (whole) or
Alt+→ (word).

**Verify:** type `sh` with ghost `how run` → Alt+→ sends `how ` (buffer
`show `), ghost now suggests next token; second Alt+→ accepts it. With a
variable payload showing, Alt+→ passes through to remote.

---

## Phase 5 — Shadow buffer re-sync from echo

Goal: fix the root cause Phase 1 only guarded against. The remote echoes
every keystroke and every line-edit result (Ctrl+W, Ctrl+U, arrow-key
history recall all repaint the line). The shadow buffer can be rebuilt from
that echo instead of being simulated.

### 5.1 Echo-line tracker

New small class `src/lib/echo-line.ts` (~60 lines) fed the same decoded SSH
text the prompt detector receives:

- Maintain the current echoed line: strip ANSI (reuse `src/lib/ansi.ts`
  `stripAnsi`), split on `\n`/`\r`, track the last partial line and whether
  a `\r` (carriage return — line repaint) arrived.
- Handle backspace echo (`\b \b` sequences → delete last char) and
  backspace-kill (`\x1b[K` clear-to-EOL, or `\b \b` runs) so line-edit
  repaints produce the *final* line content, not concatenated garbage.
- Expose `currentLine: string`.

### 5.2 Buffer reconciliation

In `terminal-view.ts`: on every SSH data event (when connected and NOT in
`receivingOutput` and prompt detector is not in passthrough), if
`echoLine.currentLine` starts with or equals the expected echo of the shadow
buffer (or differs due to line editing), set
`shadowBuffer.setContent(echoLine.currentLine)` — new method that sets
`buffer` and fires `onUpdate` only when content actually changed (avoids
per-chunk query spam; the debounce absorbs the rest).

Guard rails: reconciliation is skipped while `receivingOutput` is true (the
echo-line tracker is fed regardless, so it converges during output), and the
prompt-detected callback (already resets the shadow buffer at
terminal-view.ts:209) clears the echo tracker too.

### 5.3 Retirement of the cursorMoved guard (Phase 1)

Once reconciliation works, the `cursorMoved` flag from Phase 1.1 becomes
unnecessary for Ctrl+W/Ctrl+U/arrows — the buffer self-heals. Keep the flag
as a belt-and-braces suppression for the single keystroke where the echo
hasn't arrived yet, or remove it if testing shows reconciliation converges
fast enough. Decide during implementation; prefer removal (deletion over
addition).

**Verify:** unit tests for `echo-line.ts` (plain echo, backspace echo, `\r`
repaint, ANSI-wrapped echo, Ctrl+W repaint). Manual: type `sh`, Ctrl+W,
type `r` → ghost suggests from `r`, not garbage. Arrow-up recall then edit →
suggestions match the recalled line. `npm run build` + `cargo check` green.

---

## Follow-ups (not scheduled)

- **Per-host command history source** — prefix-match history above KB
  suggestions (fish/PSReadLine model), recent-first, with secret scrubbing.
  Requires command capture (hook the Enter path — the shadow buffer content
  at Enter time is the command) and storage; design in a separate plan when
  picked up from docs/08.
- **Dropdown-on-scroll reposition** instead of hide, if hiding annoys users.
- **ANSI strip completeness** — `src/lib/ansi.ts` strips CSI/OSC only; DCS/
  APC sequences pass through to the prompt detector. Only fix if a real
  device's prompts misparse.
- **`matchUnordered` repeatable-pipe consumption** review
  (suggestion-engine.ts:508) — flagged during code exploration, low
  frequency, verify against real KB entries before touching.

## Research sources

- fish autosuggestions: https://fishshell.com/docs/current/interactive.html#autosuggestions
- zsh-autosuggestions: https://github.com/zsh-users/zsh-autosuggestions
- PSReadLine Predictive IntelliSense: https://learn.microsoft.com/en-us/powershell/module/psreadline/about/about_psreadline
- Warp architecture: https://www.warp.dev/blog/how-warp-works
- Fig/Amazon Q (overlay-over-terminal technique): https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/command-line-integration.html
- Copilot CLI: https://docs.github.com/en/copilot/github-copilot-in-the-cli