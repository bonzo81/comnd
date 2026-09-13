# Clickable Terminal Links — Implementation Plan

Make URLs printed in terminal output clickable; clicks open the system browser.

**Depends on:** `docs/auth-url-implementation-plan.md` completed (reuses its `open_url_cmd` Tauri command + `openUrl()` TS wrapper).

## Background

Remote output routinely contains URLs (vendor docs, firmware links, `tailscale up` auth URLs on the remote host). Today: select → copy → paste into browser manually. Standard terminal emulators (VS Code, Windows Terminal, iTerm) make these clickable.

## Design

Use official `@xterm/addon-web-links` (same org/versioning train as existing `@xterm/addon-fit`). It supplies URL regex matching over buffer content, hover styling, and a click-handler callback. Hand-rolling detection reimplements the addon — rejected.

Custom click handler is **mandatory**: addon default opens via browser navigation, which in a Tauri webview would navigate the app webview itself (or no-op). Handler routes to `openUrl()` → `open_url_cmd` → `std::process::Command` system-browser open (from auth plan).

## Changes (~15 lines + 1 dep)

### 1. `package.json`

- Add `"@xterm/addon-web-links": "^0.11.0"` — verify peer compat with `@xterm/xterm` 5.5 at install time.

### 2. `src/components/terminal-view.ts` (~6 lines)

In `mount()`, after `FitAddon` load:

```ts
import { WebLinksAddon } from "@xterm/addon-web-links";
// ...
this.terminal.loadAddon(new WebLinksAddon((_event, uri) => {
  openUrl(uri).catch(() => {});
}));
```

That is the entire frontend change.

### 3. `src-tauri/src/lib.rs` — amend auth-plan validation (1 line)

Relax `open_url_cmd` guard from `https://` to `https?://`. Rationale: auth auto-open fires without user consent (https-only justified); a terminal click IS the consent, and legitimate `http://` links exist (firmware, internal docs). Update the comment.

### 4. `src-tauri/src/test_server.rs` (debug-only, 1 line)

Add a URL to the mock welcome message, e.g. `"Docs: https://example.com\r\n$ "`, so link QA is self-contained.

### 5. `docs/user-guide/04-terminal-and-suggestions.md`

One line: URLs in terminal output are clickable; click opens system browser.

## Behavior

- Plain click activates; drag still selects (xterm handles the distinction natively).
- Hover underline + pointer cursor come from the addon — no CSS work.
- Works on all post-connect output, covering cases the auth plan deliberately skipped (e.g. `tailscale up` run on a remote host).

## Security

- Remote server controls printed URLs → phishing surface. Mitigation is explicit user click (consent gate), same model as every mainstream terminal emulator.
- No auto-open from terminal output. Ever.
- `http://` allowed on click (see change 3); https-only remains for the auth-plan auto-open path... note: both flow through the same `open_url_cmd`, so the relaxed guard applies to both — auth path additionally gates itself by only extracting `https://` tokens in `extract_https_url`. Keep it that way.

## Deliberately skipped (ponytail)

| Skip | Why | Add when |
|---|---|---|
| Ctrl/Cmd+click requirement | Plain click fine, matches most terminals | Misclick complaints |
| OSC 8 hyperlink sequences (`\e]8;;url`) | Niche; regex URLs cover real output | Devices emit OSC 8 |
| Custom hover styling / tooltips | Addon defaults acceptable | Design review asks |
| Hand-rolled link detector | Reimplements official addon | Never |

## Verification

1. `npm install`; `tsc && vite build` — clean.
2. Dev QA: `testStartMockServer()` → connect → welcome URL underlines on hover → click → `example.com` opens in **system browser**, app webview does NOT navigate.
3. Regression: drag-select copy still works; ghost text/dropdown unaffected.
4. `lsp_diagnostics` on changed files — clean.
