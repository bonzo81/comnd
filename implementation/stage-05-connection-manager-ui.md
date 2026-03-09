# Stage 05 — Connection Manager UI

**Goal:** Build the full Connection Manager view — host list with search/filter, add/edit host forms, keyboard navigation, and empty state. Users can manage their host inventory entirely from the UI.

**Spec refs:** `docs/04-connection-manager.md` (full spec), `docs/03-ui-visual-design.md` (layout, colours), `docs/07-keyboard-shortcuts.md` (connection manager shortcuts)

---

## Why This Stage

This is the user's first interaction with the app. It depends on Stage 04 (host storage backend) and needs to be functional before SSH connections (Stage 06-07) so we have a way to configure and select hosts.

---

## Steps

### 1. Implement host list rendering in `src/components/connection-manager.ts`

Replace the current empty-state-only implementation with a full host list:

- On mount, call `getHosts()` from `tauri-api.ts`
- If no hosts → show empty state (already implemented, keep it)
- If hosts exist → render a scrollable list:
  - Each item: platform icon (left), display name (bold), hostname (muted, smaller), last connected time (right), connection status dot
  - Platform icons: use text/emoji indicators initially (e.g. `[IOS]`, `[NXOS]`, `[F5]`, `[BASH]`) — can be replaced with SVGs later
  - Sort by `sort_order` field
- Maintain a `selectedIndex` state for keyboard navigation
- Highlight the selected host with `var(--color-surface2)` background

### 2. Implement search/filter bar

- Add a search input at the top of the host list
- Placeholder text: "Search hosts… ( / )"
- Filter hosts in real time by matching against `display_name`, `hostname`, `username`, and `platform`
- Case-insensitive substring match
- Show result count: "N hosts" or "N of M hosts" when filtered
- Style per `docs/03-ui-visual-design.md`

### 3. Implement keyboard navigation

Per `docs/07-keyboard-shortcuts.md` Connection Manager section:

- `↑` / `↓` — move selection through host list
- `Enter` — connect to selected host (triggers connect callback — wires to terminal view in Stage 07)
- `/` — focus search bar (when not already in search)
- `Ctrl+N` — open "New Host" form
- `Delete` — delete selected host with confirmation dialog
- `Escape` — clear search, or if search empty, do nothing
- When search is focused, `↑`/`↓` should still navigate the list while keeping search focused

### 4. Build the host form (modal/slide-over)

Create the add/edit host form as a modal overlay:

- Field order per `docs/04-connection-manager.md`:
  1. Display name (text input, required)
  2. Hostname / IP (text input, required)
  3. Port (number input, default 22)
  4. Username (text input, required)
  5. Authentication type (radio: Password / SSH Key)
  6. Password field (shown when auth = Password, type=password)
  7. SSH key path (shown when auth = SSH Key, with browse button placeholder)
  8. Platform (dropdown: cisco-iosxe, cisco-nxos, f5-tmos, linux-bash with descriptions)
  9. OS Version (text input, optional)
  10. Notes (textarea, optional)
- Conditional field visibility: password/key fields toggle based on auth type
- Two action buttons: "Save" and "Save & Connect"
- Cancel button / Escape to close
- Form validation: required fields, port range (1-65535)
- On save: call `saveHost()` + `saveCredential()` (if password), refresh host list
- For edit: pre-fill all fields, load credential with `getCredential()`

### 5. Implement right-click context menu

- On right-click a host item: show context menu with:
  - Connect
  - Edit
  - Duplicate
  - Delete (with confirmation)
- Position the menu at cursor location
- Dismiss on click outside or Escape
- Keyboard: can also trigger via Shift+F10 or Menu key on selected item

### 6. Implement delete confirmation

- Inline confirmation: "Delete {hostname}? This cannot be undone." with Confirm/Cancel buttons
- Or a small modal/dialog
- On confirm: call `deleteHost()` from `tauri-api.ts`
- After delete: if the deleted host was selected, select the next host (or previous if it was last)

### 7. Add CSS for new components

Add styles to `src/styles/main.css`:

- `.host-list-item` — with hover state, selected state, platform icon area
- `.host-search` — input styling matching the dark theme
- `.host-form-modal` — modal backdrop + form panel
- `.host-form` — form fields, labels, inputs, selects, buttons, validation errors
- `.context-menu` — positioned absolutely, z-indexed above content
- `.host-count` — muted text below search
- Input styles: `var(--color-surface1)` background, `var(--color-text)` text, focus ring with `var(--color-accent)`

### 8. Wire connect action

- When user presses Enter or clicks Connect or chooses "Save & Connect":
  - Store the selected host data in a shared state or pass via callback
  - Switch to terminal view (call the `onConnect` callback already set up in `src/main.ts`)
  - The actual SSH connection will be implemented in Stage 07 — for now, just switch views and show the host info in the terminal top bar

---

## Files Modified

| File | Changes |
|------|---------|
| `src/components/connection-manager.ts` | Full rewrite: host list, search, keyboard nav, forms, context menu |
| `src/styles/main.css` | Add host list, search, form, modal, context menu styles |
| `src/main.ts` | Pass host data through view-switching callback |
| `src/lib/tauri-api.ts` | No changes if Stage 04 is complete; minor additions if needed |

## Files Created

None — all work is in existing files.

---

## Verification

1. `cargo tauri dev` — app launches showing connection manager
2. **Empty state**: With no hosts saved, the empty state CTA is visible
3. **Add host**: Click CTA or press `Ctrl+N` → form opens → fill fields → Save → host appears in list
4. **Host list**: Host shows display name (bold), hostname (muted), platform indicator
5. **Search**: Type in search bar → list filters in real time → `/` focuses search
6. **Keyboard nav**: `↑`/`↓` moves selection highlight → `Enter` switches to terminal view
7. **Edit host**: Right-click → Edit → form pre-fills with host data → save updates
8. **Delete host**: Select host → press `Delete` → confirmation appears → confirm → host removed
9. **Multiple hosts**: Add 3-4 hosts, verify list rendering, search, and navigation all work
10. **Form validation**: Try submitting with empty required fields → error indicators shown
11. **Auth type toggle**: Switch between Password/SSH Key → correct fields show/hide
12. **Persistence**: Restart app (`Ctrl+C` and `cargo tauri dev` again) → hosts still present

---

## Definition of Done

The Connection Manager is fully functional: users can add, edit, delete, and search hosts. Keyboard navigation works per the spec. Host data persists across restarts. Selecting a host and pressing Enter navigates to the terminal view with host context.
