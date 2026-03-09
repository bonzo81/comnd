# Stage 09 — Ghost Text Suggestions

**Goal:** Implement inline ghost text suggestions — as the user types, a semi-transparent completion appears after the cursor. Tab accepts the suggestion. This is the primary suggestion UX (dropdown is Stage 10).

**Spec refs:** `docs/05-suggestion-engine.md` (ghost text behaviour), `docs/03-ui-visual-design.md` (ghost text styling, match count badge), `docs/07-keyboard-shortcuts.md` (Tab context-sensitive)

---

## Why This Stage

Ghost text is the core differentiating feature. It builds directly on Stage 08 (shadow buffer + prompt detection) and the KB loader (Stage 02). The user sees command suggestions as they type, with Tab to accept — the fastest path from typing to completion.

---

## Steps

### 1. Create `src/lib/ghost-text.ts`

A new module to manage the ghost text overlay in xterm.js:

- **Rendering approach**: Use an absolutely-positioned DOM element overlaid on the terminal canvas. Position it at the cursor location using xterm.js cursor position APIs.
  - Get cursor position via `terminal.buffer.active.cursorX` and `terminal.buffer.active.cursorY`
  - Convert buffer position to pixel coordinates using the terminal's cell dimensions
  - Account for terminal container offset and scroll position
- Ghost text element: `<span class="ghost-text">{suggestion remainder}</span>`
- The "remainder" is the portion of the suggestion AFTER the user's typed prefix (e.g. user types `"show ip int"` → suggestion is `"show ip interface brief"` → ghost text shows `"erface brief"`)
- If the suggestion text would go past terminal width, truncate with `…`
- Show `(+N)` match count badge when there are multiple matches (positioned slightly right of the ghost text)

### 2. Implement ghost text positioning

- Create a function `getCursorPixelPosition(terminal: Terminal): { x: number, y: number }`
- Use `terminal._core` internal APIs or calculate from cell dimensions:
  - `x = cursorX * cellWidth + terminalOffset.left`
  - `y = cursorY * cellHeight + terminalOffset.top`
- The ghost text element is positioned with `position: absolute; left: {x}px; top: {y}px`
- Re-position when terminal scrolls or resizes
- Hide ghost text when cursor moves (until next keystroke triggers re-query)

### 3. Wire shadow buffer → suggestion query → ghost text

In `terminal-view.ts`, connect the pipeline:

- `shadowBuffer.onUpdate((text) => { ... })`:
  1. If `text` is empty → hide ghost text → return
  2. Call the frontend `SuggestionEngine.query(text, currentMode)` (from `src/lib/suggestion-engine.ts`) for instant results
  3. Also call `queryKb({ prefix: text, platform, mode: currentMode, version })` from Rust for potentially richer results (async)
  4. Use whichever returns results — frontend engine has the KB data loaded, so it should be near-instant
  5. If results: show ghost text for `topMatch()`, show `(+N)` if `results.length > 1`
  6. If no results: hide ghost text

### 4. Load KB data into the frontend suggestion engine

On connect (after `loadPlatformIndex` and successful SSH):

- Call `queryKb({ prefix: "", platform, mode: null })` to get ALL commands for the platform
- Feed them into the frontend `SuggestionEngine` (`src/lib/suggestion-engine.ts`)
- The frontend engine maintains an in-memory copy for zero-latency prefix matching
- The Rust `query_kb` serves as fallback / source of truth

### 5. Implement debouncing

- Debounce suggestion queries by 30-50ms to avoid excessive queries during fast typing
- Use a simple `setTimeout`/`clearTimeout` pattern
- Ghost text should appear within 50ms of the user pausing — this is the spec's performance target

### 6. Implement Tab to accept

Make Tab **context-sensitive** per `docs/07-keyboard-shortcuts.md`:

- In the `terminal.onData()` handler, intercept Tab (`\t`):
  - **If ghost text is visible**: Accept the suggestion
    - Send the remainder text to SSH: `sshSend({ data: remainder })`
    - Append the remainder to the shadow buffer: `shadowBuffer.append(remainder)` or reset and set to full suggestion
    - Hide ghost text
    - Prevent the Tab from going to the remote device
  - **If no ghost text**: Pass Tab through to the remote device (normal terminal tab completion)
- This is the #1 most important keyboard interaction to get right

### 7. Add ghost text CSS

Add to `src/styles/main.css`:

- `.ghost-text` — `color: var(--color-overlay0)`, `opacity: 0.5`, `pointer-events: none`, `position: absolute`, `font-family: 'JetBrains Mono'`, `font-size` matching terminal, `white-space: pre`, `z-index: 10`
- `.match-count-badge` — small pill positioned after ghost text, same muted colour, smaller font size
- No animations (spec: instant on/off)

### 8. Handle ghost text lifecycle

- **Show**: When suggestion engine returns results and user has typed ≥1 character
- **Hide**: When user presses Enter, Ctrl+C, Escape, or when shadow buffer is empty
- **Update**: On every shadow buffer change (re-query, re-render)
- **Hide on scroll**: If terminal scrolls (e.g. output pushes cursor), hide ghost text to avoid misalignment
- **Hide during output**: While SSH output is being received (detected by data events), suppress ghost text — the terminal is in output mode, not input mode. Re-enable when prompt detection fires.

### 9. Handle edge cases

- **No match**: Ghost text hidden, no badge
- **Exact match**: User has typed the full command name → ghost text hidden (nothing to complete)
- **Single match**: Ghost text shown, no `(+N)` badge
- **Multiple matches**: Ghost text shows top match, `(+N-1)` badge (e.g. 5 matches → `(+4)`)
- **Prefix is subcommand**: e.g. typing `"show ip"` should show the top-ranking "show ip..." command, not just "show"
- **Mode filtering active**: Only commands valid in current CLI mode appear

---

## Files Modified

| File | Changes |
|------|---------|
| `src/components/terminal-view.ts` | Wire suggestion pipeline (shadow buffer → query → ghost text → Tab accept) |
| `src/lib/suggestion-engine.ts` | Add method to bulk-load commands, possibly add `matchCount()` method |
| `src/styles/main.css` | Ghost text and badge styles |

## Files Created

| File | Purpose |
|------|---------|
| `src/lib/ghost-text.ts` | Ghost text rendering, positioning, show/hide lifecycle |

---

## Verification

1. `cargo tauri dev` → connect to IOS-XE device → reach `privileged_exec` prompt
2. **Ghost text appears**: Type `"show"` → ghost text shows remainder of top match (e.g. `" ip interface brief"` or `" version"` depending on sort)
3. **Updates on typing**: Continue typing `"show ip"` → ghost text updates to match narrower prefix
4. **Tab accepts**: Press Tab → remainder is sent to device → command completes on remote
5. **Tab pass-through**: At empty prompt, press Tab → Tab goes to remote (device's tab completion)
6. **Match count**: Type `"show"` (many matches) → `(+N)` badge shows
7. **Single match**: Type a unique prefix → no badge, just ghost text
8. **No match**: Type gibberish → no ghost text
9. **Mode filtering**: In `global_config` mode, type `"show"` → only config-mode-valid show commands appear (different set than `privileged_exec`)
10. **Enter clears**: Accept ghost text with Tab → type `\r` → ghost text hidden → command executes
11. **Ctrl+C clears**: Start typing → Ctrl+C → ghost text disappears
12. **Escape clears**: Start typing with ghost text → Escape → ghost text disappears
13. **Performance**: Ghost text appears within ~50ms of typing (visually instant)
14. **Resize**: Resize terminal → ghost text repositions correctly
15. **Output suppression**: While command output is streaming, no ghost text flickers

---

## Technical Notes

- xterm.js doesn't have a native ghost text API. The overlay approach (positioned `<span>`) is the most practical. It requires careful coordinate math but avoids modifying xterm.js internals.
- An alternative is to use `xterm.js` `registerDecoration()` which places DOM elements at buffer positions — this handles scrolling automatically but has limited styling control. Worth prototyping both approaches.
- The `_core` internal API access for cell dimensions is unofficial but widely used. If it breaks in an xterm.js update, the calculation can be done from CSS computed styles instead.

---

## Definition of Done

Inline ghost text appears as the user types, showing the best matching command's remainder. Tab accepts the suggestion and sends it to the remote device. Tab passes through when no suggestion is visible. The match count badge shows when multiple matches exist. Ghost text hides appropriately on Enter, Ctrl+C, Escape, and during command output.
