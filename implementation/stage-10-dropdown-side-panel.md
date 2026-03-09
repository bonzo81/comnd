# Stage 10 — Dropdown & Side Panel

**Goal:** Implement the Ctrl+Space suggestion dropdown (browse all matches, navigate with arrows, select with Enter) and the side panel that shows detailed command documentation for the highlighted suggestion.

**Spec refs:** `docs/05-suggestion-engine.md` (dropdown behaviour), `docs/03-ui-visual-design.md` (dropdown styling, side panel content), `docs/07-keyboard-shortcuts.md` (dropdown navigation)

---

## Why This Stage

Ghost text (Stage 09) shows the top match. The dropdown lets users browse all matches and discover commands they didn't know about. The side panel provides syntax, examples, and documentation — the "learning" aspect of the tool. Together, these complete the suggestion experience.

---

## Steps

### 1. Create `src/lib/dropdown.ts`

A new module for the suggestion dropdown:

- Renders a positioned list of suggestion items below/above the terminal cursor
- **Max 8 visible items** (per spec), with scroll indicator if more matches
- Each item shows:
  - Command name (left) with the typed prefix **bolded**
  - Category label (right-aligned, muted)
- Selected item has highlight background (`var(--color-surface2)`)
- Position: below the cursor line if space available, above if near terminal bottom
- Width: auto-sized to longest item, min 300px, max 500px
- Z-index above terminal and ghost text, below modals

### 2. Implement dropdown activation

Per `docs/07-keyboard-shortcuts.md`:

- **Ctrl+Space**: Toggle dropdown open/closed
  - If closed and shadow buffer has text: open dropdown with filtered matches
  - If closed and shadow buffer is empty: open dropdown with ALL commands for current mode (browsable command palette)
  - If already open: close dropdown
- When dropdown opens:
  - Query suggestion engine for matches
  - Render the dropdown
  - Select the first item
  - Update side panel with first item's detail
  - Ghost text remains visible (for the selected item)

### 3. Implement dropdown keyboard navigation

While dropdown is open:

- **↑ / ↓**: Move selection through the list. Wrap around at edges.
- **Enter**: Accept the selected command
  - Send the remainder to SSH (same as Tab-accept in Stage 09)
  - Close dropdown
  - Hide ghost text
- **Escape**: Close dropdown without accepting
- **Tab**: Accept the selected command (same as Enter)
- **Typing**: Continue typing narrows the dropdown filter in real time. If no matches remain, close dropdown.
- **Backspace**: Re-filter. If prefix becomes empty, show all commands for current mode.

### 4. Wire dropdown selection → ghost text update

When the user navigates the dropdown with ↑/↓:

- Update ghost text to show the remainder of the currently highlighted item (not just the top match)
- This gives a preview of what Tab/Enter would insert

### 5. Create `src/lib/sidebar-content.ts`

A new module for rendering the side panel's command detail:

- **Content layout** per `docs/03-ui-visual-design.md` side panel spec:
  1. **Command name** (header, bold)
  2. **Syntax block** — formatted with colour coding:
     - Command keywords: `var(--color-text)` (white)
     - Required parameters: `var(--color-accent)` (blue)
     - Optional parameters: `var(--color-yellow)` or muted
     - Variables/placeholders: italic
  3. **Description** (paragraph text)
  4. **Examples** — clickable (clicking inserts the example command into the terminal)
     - Each example: command string (mono) + description (muted)
  5. **Metadata**: mode, category, version info, tags
  6. **Tags** as pills/badges
  7. **Official docs link** (if `reference_url` in platform index + possible command-specific path)

### 6. Wire side panel to suggestion state

- When ghost text updates (top match changes) → update side panel with that command's detail
- When dropdown opens and user navigates → update side panel with highlighted command's detail
- When dropdown closes → keep last shown command detail (don't clear panel)
- When shadow buffer is empty → show a placeholder: "Start typing to see suggestions" or platform-specific tips

### 7. Wire clickable examples

When a user clicks an example command in the side panel:

- Insert the example command text into the terminal: `sshSend({ data: exampleCommand + "\r" })`
- This sends the command to the remote device immediately (with Enter)
- Focus returns to the terminal after click

### 8. Update sidebar toggle behaviour

Already partially implemented — ensure:

- Sidebar default width: 320px (per spec)
- Sidebar min width: 240px
- Resizable via drag handle (stretch goal — can be post-MVP if complex)
- Sidebar opens with `Ctrl+\`` toggle
- When sidebar opens: terminal resizes (PTY resize signal sent)
- When sidebar closes: terminal expands back (PTY resize signal sent)
- Sidebar pushes terminal content, does NOT overlay

### 9. Add dropdown CSS

Add to `src/styles/main.css`:

- `.suggestion-dropdown` — positioned, dark bg (`var(--color-surface0)`), border, border-radius, shadow, max-height for 8 items, overflow hidden
- `.suggestion-item` — padding, flex layout (name left, category right)
- `.suggestion-item.selected` — highlighted bg
- `.suggestion-item .prefix-match` — bold text (the matched prefix portion)
- `.suggestion-item .category` — muted, smaller font, right-aligned
- `.scroll-indicator` — top/bottom gradient indicating more items above/below

### 10. Add side panel CSS refinements

Styles for the command detail content:

- `.command-name` — large, bold header
- `.syntax-block` — monospace, padded, `var(--color-surface1)` background, colour-coded spans
- `.command-description` — normal paragraph text
- `.example-item` — clickable, hover state, monospace command, muted description
- `.tag-badge` — pill style, muted bg, small text
- `.meta-row` — label/value pairs for mode, category, version

---

## Files Modified

| File | Changes |
|------|---------|
| `src/components/terminal-view.ts` | Wire dropdown + side panel to suggestion pipeline, handle dropdown keyboard events |
| `src/lib/ghost-text.ts` | Update ghost text when dropdown selection changes |
| `src/lib/suggestion-engine.ts` | Possibly add richer result objects (with highlight ranges) |
| `src/styles/main.css` | Dropdown, side panel detail, syntax block, examples, tags styles |

## Files Created

| File | Purpose |
|------|---------|
| `src/lib/dropdown.ts` | Suggestion dropdown: render, position, navigate, select |
| `src/lib/sidebar-content.ts` | Side panel command detail renderer |

---

## Verification

1. `cargo tauri dev` → connect to IOS-XE device → `privileged_exec` mode
2. **Ctrl+Space opens dropdown**: With empty prompt → shows all privileged_exec commands (up to 8 visible)
3. **Filtered dropdown**: Type `"show"` → Ctrl+Space → dropdown shows only `show *` commands
4. **Arrow navigation**: ↓/↑ moves selection through dropdown items → ghost text updates to match selection
5. **Enter accepts**: Navigate to a command → Enter → command sent to remote → dropdown closes
6. **Tab accepts from dropdown**: Same as Enter
7. **Escape closes**: Dropdown disappears, ghost text returns to top match
8. **Typing narrows**: With dropdown open, type more characters → list filters in real time
9. **Backspace widens**: Delete characters → list shows more matches
10. **Side panel updates**: Open sidebar (Ctrl+`) → open dropdown → navigate → side panel shows detail for each highlighted command
11. **Syntax colouring**: Keywords, parameters, and placeholders have distinct colours in the syntax block
12. **Examples clickable**: Click an example → command executes on remote device
13. **Scroll indicator**: If more than 8 matches → scroll indicator visible at bottom
14. **Multiple matches badge**: With dropdown closed, ghost text still shows `(+N)` badge
15. **Sidebar resize**: Toggle sidebar → terminal resizes correctly → dropdown repositions if open
16. **Empty state**: Sidebar shows placeholder text when no suggestion is active

---

## Definition of Done

Ctrl+Space opens a browsable command dropdown with keyboard navigation. The side panel shows rich documentation for the highlighted command, including colour-coded syntax, clickable examples, and metadata. Dropdown selection updates ghost text in real time. All interaction paths (accept, dismiss, filter, browse) work correctly.
