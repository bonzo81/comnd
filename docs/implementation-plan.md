# Implementation Plan: net.sh → Linear-Inspired Redesign

**Goal**: Redesign net.sh's visual design to Linear.app aesthetic — clean, dark, precision — without breaking functionality.

**Stack**: Tauri v2, Vanilla TypeScript, xterm.js v5, monolithic 2072-line CSS.
**Key constraint**: Shadow buffer model, keyboard-first, sidebar pushes terminal (no overlay).

---

## Phase 1: Design Token System (Foundation)

**Outcome**: New CSS custom properties with Linear-inspired values, layered structure, zero visual change yet.

### 1.1 Create tokens.css

Create `src/styles/tokens.css` with the new design token system:

```css
/* ─── Surface colors (Linear-inspired neutral grays) ─── */
:root {
  --color-surface-primary: #212225;    /* Main app background */
  --color-surface-secondary: #1A1B1D;  /* Chrome: topbar, sidebar, statusbar */
  --color-surface-elevated: #2A2B2D;  /* Cards, modals, dropdown, inputs */
  --color-surface-hover: rgba(255,255,255,0.04);
  --color-surface-selected: rgba(94,106,210,0.12);

  /* Text */
  --color-text-primary: #E4E5E7;
  --color-text-secondary: #888A8D;
  --color-text-tertiary: #66676A;

  /* Accent & semantic */
  --color-accent: #5E6AD2;
  --color-accent-hover: #6B75D9;
  --color-success: #8CE6B3;
  --color-warning: #FFA04A;
  --color-error: #F2726B;

  /* Borders — Linear-style subtle */
  --color-border: rgba(255,255,255,0.06);
  --color-border-hover: rgba(255,255,255,0.12);

  /* Spacing (8px grid) */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-8: 32px;

  /* Backward compat alias */
  --spacing: 4px;

  /* Radius */
  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 8px;

  /* Shadows */
  --shadow-sm: 0 1px 2px rgba(0,0,0,0.3);
  --shadow-md: 0 4px 12px rgba(0,0,0,0.4);
  --shadow-lg: 0 8px 24px rgba(0,0,0,0.5);

  /* Typography */
  --font-ui: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --font-mono: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace;
  --font-size-xs: 11px;
  --font-size-sm: 12px;
  --font-size-base: 13px;
  --font-size-lg: 14px;
  --font-size-xl: 16px;
  --font-size-2xl: 20px;
}
```

### 1.2 Add tokens.css to main.ts import

In `src/main.ts`, add before the existing `./styles/main.css` import:
```typescript
import "./styles/tokens.css";
```

### 1.3 Verify
- Run `npm run build` or `npm run dev` — zero visual change, no diagnostics errors.

**Verification gate**: Build passes, no TypeScript/lint errors, app loads normally.

---

## Phase 2: CSS Layer Architecture

**Outcome**: Monolithic main.css wrapped in `@layer`, component structure prepared for splitting.

### 2.1 Wrap main.css in layer

Prepend to `src/styles/main.css`:
```css
@layer tokens {
  /* tokens.css is loaded separately, this layer is for backward-compat variables */
}

@layer base {
  *, body, #app structure
}

@layer components {
  /* all existing component styles */
}

@layer utilities {
  /* hover, focus, animation utilities */
}
```

### 2.2 Create component CSS stub files

Create directory structure:
```
src/styles/components/
  _connection-manager.css   (empty, imported by main.css)
  _terminal-view.css       (empty)
  _host-screen.css         (empty)
  _modals.css              (empty)
  _dialogs.css             (empty)
  _buttons.css             (empty)
  _overlays.css            (empty)
  _suggestion.css          (empty)
```

Import them at top of main.css (inside `@layer components {}`).

### 2.3 Verify
- Build still passes, no visual change.

---

## Phase 3: Color Variable Migration

**Outcome**: App starts using new `--color-*` tokens, visual appearance shifts to Linear palette.

### 3.1 Update `:root` variables in main.css

Replace the current `:root` block with mappings to new tokens:

```css
:root {
  /* Map old names to new tokens for backward compat during migration */
  --bg-terminal: var(--color-surface-primary);
  --bg-chrome: var(--color-surface-secondary);
  --fg-primary: var(--color-text-primary);
  --fg-muted: var(--color-text-secondary);
  --border: var(--color-border);
  --accent: var(--color-accent);
  --ghost: var(--color-text-secondary);
  --success: var(--color-success);
  --warning: var(--color-warning);
  --error: var(--color-error);
  --dropdown-selected: var(--color-surface-selected);
  --font-mono: var(--font-mono);
  --font-ui: var(--font-ui);
  --spacing: var(--space-1);
}
```

### 3.2 Update xterm.js theme in terminal-view.ts

In `src/components/terminal-view.ts`, update the Terminal constructor theme:

```typescript
theme: {
  background: "#212225",    // was #1e1e2e
  foreground: "#E4E5E7",    // was #cdd6f4
  cursor: "#F2726B",        // was #f5e0dc
  selectionBackground: "#3A3B3D",  // was #585b70 — adjusted for new palette
}
```

### 3.3 Key visual changes (this phase):
- Terminal background shifts from blue-grey #1e1e2e to neutral #212225
- Text shifts from warm off-white to neutral white
- All borders become extremely subtle (barely visible)
- Status bar, top bar lose heavy borders

### 3.4 Verify
- App loads, connect to a host (even without real SSH), observe:
  - Terminal background is neutral gray, not blue-grey
  - Borders are extremely subtle
  - No new errors in console

---

## Phase 4: Component Visual Migration

**Outcome**: Each UI component redesigned to Linear style — subtle borders, better spacing, cleaner hierarchy.

### 4.1 Connection Manager Header (`.cm-header`)
```css
.cm-header {
  padding: var(--space-4) var(--space-6);  /* was 16px 24px */
  border-bottom: 1px solid var(--color-border);  /* subtle */
  /* remove any box-shadow */
}
.cm-header h1 {
  font-size: var(--font-size-2xl);  /* was 20px */
  font-weight: 600;  /* was 700 */
  color: var(--color-accent);
  letter-spacing: -0.01em;
}
```

### 4.2 Host List Items (`.cm-host-item`)
```css
.cm-host-item {
  padding: var(--space-3) var(--space-4);  /* was 12px 12px */
  border-radius: var(--radius-md);
  /* Remove: outline: 1px solid var(--accent) on selected */
  /* Add: background: var(--color-surface-selected) on selected */
  transition: background 0.15s ease;
}
.cm-host-item:hover {
  background: var(--color-surface-hover);
}
.cm-host-selected {
  background: var(--color-surface-selected);
}
```

### 4.3 Status Bar (`.tv-statusbar`)
```css
.tv-statusbar {
  min-height: 28px;  /* was 24px */
  padding: var(--space-1) var(--space-3);
  border-top: 1px solid var(--color-border);  /* very subtle */
  gap: var(--space-3);  /* was 8px */
  /* Remove: .sb-divider with │ character — use flex gap */
}
.sb-divider { display: none; }
```

### 4.4 Top Bar (`.tv-topbar`)
```css
.tv-topbar {
  min-height: 44px;  /* was 36px */
  padding: 0 var(--space-4);
  border-bottom: 1px solid var(--color-border);
  /* Remove: any heavy borders */
}
.tv-host-info {
  font-size: var(--font-size-base);  /* was 12px monospace */
  color: var(--color-text-secondary);
}
```

### 4.5 Modals (`.modal-panel`)
```css
.modal-backdrop {
  background: rgba(0, 0, 0, 0.7);  /* was rgba(0,0,0,0.6) */
  backdrop-filter: blur(4px);  /* NEW — Linear-style frosted glass */
}
.modal-panel {
  background: var(--color-surface-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: var(--space-6);  /* was 24px */
  width: 520px;  /* was 480px */
  box-shadow: var(--shadow-lg);
}
```

### 4.6 Buttons
```css
.btn-primary {
  background: var(--color-accent);
  color: #fff;
  border: none;  /* was border: none implicitly */
  padding: var(--space-2) var(--space-4);
  border-radius: var(--radius-md);
  font-size: var(--font-size-base);
  font-weight: 500;  /* was 600 */
  transition: background 0.15s ease, transform 0.1s ease;
}
.btn-primary:hover {
  background: var(--color-accent-hover);
  opacity: 1;
}
.btn-primary:active {
  transform: scale(0.98);
}

.btn-secondary {
  background: transparent;
  color: var(--color-text-primary);
  border: 1px solid var(--color-border);
  padding: var(--space-2) var(--space-4);
  border-radius: var(--radius-md);
  font-size: var(--font-size-base);
  font-weight: 400;
  transition: border-color 0.15s ease, background 0.15s ease;
}
.btn-secondary:hover {
  border-color: var(--color-border-hover);
  background: var(--color-surface-hover);
}

.btn-text {
  background: none;
  border: none;
  color: var(--color-text-secondary);
  padding: var(--space-1) var(--space-2);
  font-size: var(--font-size-base);
  transition: color 0.15s ease;
}
.btn-text:hover {
  color: var(--color-text-primary);
}
```

### 4.7 Sidebar (`.tv-sidebar`)
```css
.tv-sidebar {
  background: var(--color-surface-secondary);
  border-left: none;  /* was 1px solid var(--border) — rely on bg diff */
  padding: var(--space-6);  /* was 16px */
  transition: width 0.2s ease;
}
```

### 4.8 Suggestion Dropdown (`.suggestion-dropdown`)
```css
.suggestion-dropdown {
  background: var(--color-surface-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  /* Remove: border: 1px solid var(--border) */
  /* Remove: box-shadow with heavy black */
  min-width: 320px;
  overflow: hidden;
}
.suggestion-item {
  height: 32px;  /* slightly less tall for tighter feel */
  padding: var(--space-2) var(--space-3);
}
.suggestion-item.selected {
  background: var(--color-surface-selected);
  outline: none;  /* was outline: 1px solid var(--accent) */
}
```

### 4.9 Form Inputs
```css
.host-form input[type="text"],
.host-form input[type="number"],
.host-form input[type="password"],
.host-form select,
.host-form textarea {
  background: var(--color-surface-primary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text-primary);
  padding: var(--space-2) var(--space-3);
  font-size: var(--font-size-base);
  transition: border-color 0.15s ease;
}
.host-form input:focus,
.host-form select:focus,
.host-form textarea:focus {
  border-color: var(--color-accent);
  outline: none;
}
```

### 4.10 Connecting Overlay
```css
.tv-overlay {
  background: rgba(33, 34, 37, 0.92);  /* was rgba(30,30,46,0.92) — new bg color */
  backdrop-filter: blur(8px);
}
.tv-progress-bar {
  background: var(--color-border);  /* was var(--border) = #313244 */
}
.tv-progress-fill {
  background: var(--color-accent);
}
```

### 4.11 Toast Notifications
```css
.toast {
  background: var(--color-surface-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  font-size: var(--font-size-base);
}
```

### 4.12 Badges (`.badge-iosxe`, etc.)
```css
.badge-iosxe { color: var(--color-accent) !important; }
.badge-nxos { color: #B4BEFE !important; }  /* already good */
.badge-tmos { color: var(--color-warning) !important; }
.badge-bash { color: var(--color-success) !important; }
```

### 4.13 Verify
- Visual check: connect screen, host list, terminal view with sidebar, modals
- All interactive elements (buttons, inputs, dropdowns) work
- No layout breakage from spacing changes

---

## Phase 5: Spacing System Refinement

**Outcome**: Consistent 8px grid, all spacing using semantic tokens.

### 5.1 Audit and update all spacing

Go through main.css and replace hardcoded spacing values with tokens:
- `4px` → `var(--space-1)`
- `8px` → `var(--space-2)`
- `12px` → `var(--space-3)`
- `16px` → `var(--space-4)`
- `20px` → `var(--space-5)`
- `24px` → `var(--space-6)`
- `32px` → `var(--space-8)`

Priority order:
1. Connection manager (most visible when idle)
2. Terminal view chrome (topbar, statusbar, sidebar)
3. Modals and dialogs
4. Form elements
5. Suggestion system

### 5.2 Verify
- Consistent spacing throughout
- No pixel values that aren't multiples of 4 (ideally 8)

---

## Phase 6: Typography Refinement

**Outcome**: Inter font adopted, consistent type scale.

### 6.1 Ensure Inter font loads

In `src/index.html` (or wherever fonts are loaded), add:
```html
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
```

### 6.2 Update font stacks

In tokens.css:
```css
--font-ui: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
```

### 6.3 Type scale usage

Update component styles to use the type scale:
- `font-size: var(--font-size-sm)` for metadata, timestamps
- `font-size: var(--font-size-base)` for body text
- `font-size: var(--font-size-lg)` for emphasized body
- `font-size: var(--font-size-xl)` for section headings
- `font-size: var(--font-size-2xl)` for page headings

### 6.4 Verify
- Text is readable and consistent
- No jarring size jumps between elements

---

## Phase 7: Creative Enhancements (Post-MVP or Behind Flags)

### 7.1 Ambient Mode Chrome
Add subtle `--chrome-tint` CSS variable that JS updates on mode change:
```typescript
// In terminal-view.ts, when mode changes:
document.documentElement.style.setProperty('--chrome-tint', tintValue);
```
CSS uses it on `.tv-topbar`, `.tv-statusbar` backgrounds.

### 7.2 Inline Suggestion Bar
A new `<div>` between terminal and status bar, toggled via `.suggestion-bar` class. Terminal resizes when bar appears.

### 7.3 Keyboard Command Palette
New component `CommandPalette.ts` + `command-palette.css`. Opens on `Ctrl+K`.

---

## Phase 8: Polish & Performance

### 8.1 Animations
Add subtle transitions:
- Sidebar show/hide: `transition: width 0.2s ease`
- Button hover: `transition: background 0.15s ease, transform 0.1s ease`
- Overlay fade: `transition: opacity 0.3s ease`
- **No animation on ghost text or dropdown** — those must be instant

### 8.2 Focus indicators
```css
*:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}
/* Remove any previous focus rings that conflict */
```

### 8.3 CSS file split (final state)

Move content from main.css into the component stub files created in Phase 2:
- `_connection-manager.css` → `.connection-manager`, `.cm-*`
- `_terminal-view.css` → `.terminal-view`, `.tv-*`
- `_modals.css` → `.modal-*`, `.host-form`, `.delete-confirm`
- `_buttons.css` → `.btn-*`
- `_overlays.css` → `.tv-overlay`, `.tv-banner`, `.toast-*`
- `_suggestion.css` → `.ghost-text`, `.suggestion-*`
- etc.

main.css becomes:
```css
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap');
@import './tokens.css';
@import './base.css';
@import './components/connection-manager.css';
@import './components/terminal-view.css';
/* etc. */
```

---

## Risk Items & Rollback

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| xterm.js theme change breaks terminal | Low | Test with real SSH session, not just local |
| Spacing changes cause layout overflow | Medium | Use overflow:hidden during dev, test all viewports |
| Inter font fails to load (network) | Low | System font fallback already in stack |
| Backdrop blur causes perf issues on low-end machines | Medium | Make blur conditional, disable via user pref |
| Sidebar border removal creates depth confusion | Medium | Test with and without sidebar, ensure bg difference is enough |
| Dropdown shadow too heavy | Low | Adjust shadow-lg to shadow-md if needed |

**Rollback**: If any phase breaks the app, `git checkout` the changed CSS files. The token system is additive (new tokens + old tokens), so rolling back tokens.css or the `:root` mappings is the fastest revert.

---

## Verification Checklist

After each phase, verify:
- [ ] Build passes (`npm run build`)
- [ ] LSP diagnostics clean (`lsp_diagnostics` on changed files)
- [ ] App loads without console errors
- [ ] Can navigate: host list → connect → terminal → sidebar → disconnect
- [ ] Can add/edit/delete a host
- [ ] Keyboard shortcuts still work (↑↓ navigate, Enter connect, / search, Esc close modals)
- [ ] Visual: no jarring misalignments, consistent spacing, readable text

---

## Files to Change

| File | Changes |
|------|---------|
| `src/styles/tokens.css` | NEW — design token definitions |
| `src/styles/main.css` | Wrap in @layer, update :root mappings, update all component styles |
| `src/main.ts` | Add tokens.css import |
| `src/components/terminal-view.ts` | Update xterm.js theme colors |
| `src/index.html` | Add Inter font link (if not already) |
| `src/styles/components/*.css` | NEW — split from main.css (Phase 8) |

---

## Implementation Order

1. **Phase 1** (tokens) → foundation, zero risk
2. **Phase 2** (layers) → structure, zero risk
3. **Phase 3** (colors) → biggest visual impact, test after
4. **Phase 4** (components) → most work, test each sub-item
5. **Phase 5** (spacing) → refine, test after
6. **Phase 6** (typography) → polish, test after
7. **Phase 7** (creative) → optional, post-MVP
8. **Phase 8** (file split) → cleanup, test after