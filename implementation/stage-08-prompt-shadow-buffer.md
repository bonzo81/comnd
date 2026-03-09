# Stage 08 — Prompt Detection & Shadow Buffer Integration

**Goal:** Connect the prompt detection state machine and shadow buffer to the live SSH session. The app detects which CLI mode the device is in (e.g. `privileged_exec`, `global_config`) and tracks what the user is currently typing — both prerequisites for suggestions.

**Spec refs:** `docs/02-technical-architecture.md` (prompt detection state machine, shadow buffer model), `docs/05-suggestion-engine.md` (mode detection, prompt patterns)

---

## Why This Stage

Ghost text and dropdown suggestions (Stages 09-10) require two inputs: the current CLI mode (from prompt detection) and the current input text (from the shadow buffer). Both modules are well-implemented (`src/lib/prompt-detector.ts`, `src/lib/shadow-buffer.ts`) but not connected to the SSH data stream. This stage wires them in.

---

## Steps

### 1. Load prompt patterns on connect

When a connection is established:

- Call `loadPlatformIndex(platform)` from `tauri-api.ts` to get the platform's `prompt_patterns`
- Parse the prompt patterns (they're regex strings mapped to mode names)
- Pass them to the prompt detector: `promptDetector.loadPatterns(patterns)`
- Set the initial mode to the platform's `default_mode` (from the index)

### 2. Feed SSH output to the prompt detector

In `terminal-view.ts`, after writing SSH output to xterm.js:

- Also pass the raw output data to `promptDetector.feed(data)`
- The prompt detector:
  1. Strips ANSI escape sequences
  2. Accumulates text in a line buffer
  3. After 200ms of idle (no new data), checks the last line against prompt patterns
  4. If a pattern matches → fires `onModeChange` callback with the new mode name
  5. Resets the shadow buffer (user is at a fresh prompt)

### 3. Wire mode changes to the status bar

- Register a callback on the prompt detector: `promptDetector.onModeChange((mode) => { ... })`
- Update the status bar "Mode" field with the detected mode (e.g. "privileged_exec" → display as "Privileged Exec" or per spec formatting)
- Store the current mode in terminal-view state — this is passed to suggestion queries

### 4. Wire the shadow buffer to keystroke input

In the `terminal.onData()` handler (from Stage 07):

- For printable characters: call `shadowBuffer.append(char)`
- For backspace (`\x7f` or `\b`): call `shadowBuffer.backspace()`
- For Enter (`\r`): call `shadowBuffer.reset()` (user submitted the command)
- For Ctrl+C: call `shadowBuffer.reset()` (user cancelled)
- For arrow keys (up/down): call `shadowBuffer.reset()` (user navigating history — shadow buffer can't track remote history)
- Still send all keystrokes to SSH as before — the shadow buffer only _observes_

### 5. Reset shadow buffer on prompt detection

When the prompt detector fires `onModeChange`:

- Call `shadowBuffer.reset()` — the user is at a fresh prompt, any previous typing context is stale
- This prevents stale suggestions from appearing after command execution

### 6. Expose shadow buffer content for suggestion queries

- Register `shadowBuffer.onUpdate((text) => { ... })` callback
- On each update, store the current input text in terminal-view state
- This text will be used as the `prefix` for `queryKb()` calls in Stage 09
- Don't trigger suggestion queries yet — just store the value

### 7. Handle edge cases

- **Fast typist**: Shadow buffer updates on every keystroke. If the user types quickly, many updates fire. The suggestion engine (Stage 09) will need debouncing — but the shadow buffer itself should update instantly.
- **Paste**: `terminal.onData()` fires with the full pasted text. Feed each character to the shadow buffer, or set the buffer directly to the pasted text.
- **Tab key**: For now, Tab passes through to remote and resets the shadow buffer (the remote may do tab-completion, changing the command line in unpredictable ways).
- **Remote tab-completion**: When the remote autocompletes, the shadow buffer doesn't know. This is an accepted limitation — the shadow buffer resets on next prompt detection.

### 8. Add mode display formatting

Create a utility to format mode names for display:

- `privileged_exec` → "Privileged Exec"
- `global_config` → "Global Config"
- `user_exec` → "User Exec"
- etc.
- Or use the mode name as-is with first letter capitalized + underscores replaced with spaces

---

## Files Modified

| File | Changes |
|------|---------|
| `src/components/terminal-view.ts` | Wire prompt detector + shadow buffer to SSH stream, update status bar mode |
| `src/lib/prompt-detector.ts` | Minor changes if needed (verify pattern loading API matches what we need) |
| `src/lib/shadow-buffer.ts` | Minor changes if needed (verify API supports paste scenario) |
| `src/lib/tauri-api.ts` | Ensure `loadPlatformIndex()` wrapper exists and returns typed `PlatformIndex` |

## Files Created

None.

---

## Verification

1. `cargo tauri dev` → connect to a Cisco IOS-XE device
2. **Prompt detection**: After connecting, the status bar should show the current mode (e.g. "User Exec" or "Privileged Exec")
3. **Mode change**: Type `enable` + Enter (enter privileged exec) → status bar updates to "Privileged Exec"
4. **Config mode**: Type `configure terminal` + Enter → status bar shows "Global Config"
5. **Interface config**: Type `interface GigabitEthernet1` + Enter → status bar shows "Interface Config"
6. **Exit back**: Type `exit` repeatedly → mode steps back through each level
7. **Shadow buffer tracking**: Open DevTools → add a console.log in the `shadowBuffer.onUpdate` callback → type characters → see the buffer contents update in real time
8. **Shadow buffer reset on Enter**: Type a partial command → press Enter → buffer resets to empty
9. **Shadow buffer reset on prompt**: After command output finishes and prompt appears → buffer should be empty
10. **Ctrl+C reset**: Start typing → press Ctrl+C → buffer resets
11. **Arrow key reset**: Start typing → press Up arrow → buffer resets (remote history navigation)
12. **Paste handling**: Paste "show version" into terminal → shadow buffer contains "show version"

---

## Technical Notes

- The prompt detector's 200ms idle timer is crucial. SSH output arrives in chunks — the timer prevents false-positive prompt detection mid-output. If you see incorrect mode changes during long command output, the timer may need adjustment.
- The shadow buffer is intentionally simple. It can't handle cursor-movement editing (left/right arrows, Home/End). This is an accepted limitation — most network engineers type commands linearly and use tab-completion, not cursor editing.
- The spec explicitly states: "If the user uses remote history (↑ key), the shadow buffer can't know what the remote selected." Resetting on arrow keys is the correct tradeoff.

---

## Definition of Done

The prompt detector correctly identifies CLI mode changes on a real IOS-XE device. Mode transitions (user_exec → privileged_exec → global_config → interface_config → back) are reflected in the status bar. The shadow buffer accurately tracks typed input and resets appropriately on Enter, Ctrl+C, arrow keys, and prompt detection.
