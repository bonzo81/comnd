# Stage 12 — Integration Testing & Cross-Platform Builds

**Goal:** End-to-end testing of the complete app against real devices, edge case verification, cross-platform builds for Windows/macOS/Linux, and final polish.

**Spec refs:** `docs/01-overview-goals.md` (target platforms, build artifacts), `docs/02-technical-architecture.md` (error handling scenarios), `docs/DEVELOPMENT.md` (build instructions)

---

## Why This Stage

All features are implemented. This stage validates the complete experience works end-to-end and produces distributable builds. It catches integration issues, edge cases, and platform-specific bugs that unit tests and per-stage testing didn't cover.

---

## Steps

### 1. End-to-end smoke test

Connect to a real Cisco IOS-XE device and run through the full workflow:

1. Launch app → connection manager shows
2. Add a new host → save
3. Select host → Enter → connecting overlay → authentication → terminal ready
4. Type `enable` → mode changes to `privileged_exec` (status bar updates)
5. Type `show ` → ghost text appears with top match + `(+N)` badge
6. Press `Tab` → suggestion accepted → command completes on device
7. Press `Enter` → command executes → output renders correctly
8. Press `Ctrl+Space` → dropdown opens → navigate with arrows → side panel updates
9. Press `Enter` → different command sent → output renders
10. Open sidebar (`Ctrl+\``) → command detail visible → click example → command runs
11. Enter `configure terminal` → mode changes to `global_config` → suggestions filter to config-mode commands
12. Exit back through modes → mode tracking stays accurate
13. Resize window → terminal and sidebar reflow correctly
14. Zoom in/out → font changes → layout stable
15. `Ctrl+Shift+W` → disconnect → back to connection manager
16. Re-select host → reconnect → TOFU accepts known key immediately

### 2. Test all 5 error scenarios

Per `docs/02-technical-architecture.md`:

| Scenario | How to trigger | Expected behaviour |
|----------|----------------|-------------------|
| **Auth failure** | Use wrong password | Error in overlay, retry/back buttons, can re-enter password |
| **Connection timeout** | Use unreachable IP (e.g. 10.255.255.1) | Timeout after 10s, error message, cancel/retry |
| **Host key changed** | Modify `known_hosts.json` for a known host | Warning message with host key mismatch, option to accept new key or cancel |
| **Mid-session drop** | Disconnect network cable during session | Disconnected banner within ~45s, reconnect/back options |
| **Unrecognised auth challenge** | (May need mock) Keyboard-interactive with unexpected prompt | Fallback to password or show prompt to user |

### 3. Test edge cases

- **Fast typing**: Type rapidly — ghost text keeps up, no flickering or lag
- **Long command output**: Run `show running-config` (thousands of lines) — terminal scrolls correctly, no hang, prompt detected at end
- **Special characters**: Type commands with pipes, redirects, quotes — all pass through correctly
- **Paste large text**: Paste a multi-line config block — sent to device correctly
- **Rapid connect/disconnect**: Connect and disconnect 10 times quickly — no state leaks or crashes
- **Empty KB**: Connect with a platform that has no commands (e.g. stub `cisco-nxos`) — no errors, suggestions just don't appear
- **Concurrent events**: Resize while output is streaming — no crashes
- **Very long hostname**: Host with 60+ character hostname — UI doesn't break

### 4. Test keyboard-only workflow

Complete the entire workflow without touching the mouse:

1. Launch → `Ctrl+N` → fill form with Tab between fields → `Enter` to save
2. Arrow down to host → `Enter` to connect
3. Use `Tab` for ghost text, `Ctrl+Space` for dropdown, arrows to navigate, `Enter` to select
4. `Ctrl+\`` for sidebar → `Escape` cascade back through UI elements
5. `Ctrl+Shift+W` to disconnect → arrow to host → `Enter` to reconnect

### 5. Cross-platform builds

#### Windows (.msi)
- Build: `cargo tauri build`
- Verify: installer runs, app launches, SSH works, keychain stores credentials in Windows Credential Manager
- Test: JetBrains Mono font loads correctly, Ctrl shortcuts work

#### macOS (.dmg) — if macOS build environment available
- Build: `cargo tauri build`
- Verify: DMG opens, app launches, SSH works, keychain uses macOS Keychain
- Test: Cmd+key shortcuts may need mapping (Tauri handles this), Retina display rendering

#### Linux (.AppImage / .deb) — if Linux build environment available
- Build: `cargo tauri build`
- Verify: AppImage runs, SSH works, keychain uses Secret Service (GNOME Keyring / KDE Wallet)
- Test: Wayland vs X11 compatibility (Tauri/WebKitGTK handles most of this)

### 6. Performance validation

- **Suggestion latency**: <50ms from keystroke to ghost text appearance
- **SSH throughput**: Large command output (e.g. `show tech`) streams without lag
- **Memory**: App memory stays reasonable (~100-200MB) during extended sessions
- **Startup time**: App opens to connection manager in <2 seconds

### 7. Fix any remaining issues

- Catalogue issues found during testing
- Fix critical bugs (crashes, data loss, incorrect behaviour)
- Defer cosmetic issues to a post-MVP polish pass
- Update any stale stub code that was missed in earlier stages

### 8. Update documentation

- Update `README.md` with final build instructions, screenshots, and usage overview
- Review `DEVELOPMENT.md` — ensure setup instructions are accurate
- Ensure `CONTRIBUTING.md` reflects any KB schema changes made during implementation

---

## Files Modified

Potentially any file — this stage is about bug fixes and final adjustments found during integration testing,

## Files Created

None expected — unless testing reveals a need for a missing utility module.

---

## Verification

This entire stage IS verification. The definition of done below is the test checklist.

---

## Definition of Done

- [ ] Full workflow completes end-to-end on a real IOS-XE device without errors
- [ ] All 5 error scenarios handled correctly with appropriate user feedback
- [ ] Complete keyboard-only workflow successful
- [ ] Ghost text, dropdown, and side panel render correctly in all terminal states
- [ ] Prompt detection tracks mode accurately through IOS-XE mode transitions
- [ ] Suggestion performance is under 50ms
- [ ] Cross-platform: Windows build produces `.msi`, installs, and runs correctly
- [ ] Cross-platform: macOS build produces `.dmg` (if build env available)
- [ ] Cross-platform: Linux build produces `.AppImage` (if build env available)
- [ ] No crashes during extended use (30+ minute session)
- [ ] No state leaks on rapid connect/disconnect cycles
- [ ] `README.md` updated with accurate usage information
- [ ] All keyboard shortcuts work per `docs/07-keyboard-shortcuts.md`
- [ ] Status bar shows accurate live data (connection, host, platform, mode, latency)
