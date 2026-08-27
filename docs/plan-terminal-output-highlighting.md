# Plan: Terminal Output Syntax Highlighting

Status: planned

## Goal

Colorize streamed command output in the terminal for network engineer contexts:
IPs, interface names, status keywords (`up`/`down`/`error`/`warn`), ACLs, VLAN
IDs, prompts, file paths. Echo and interactive apps (`vi`, `more`, `top`) bypass
highlighting entirely.

This is **terminal output highlighting** — NOT sidebar/KB syntax coloring (already
spec'd in `docs/03-ui-visual-design.md:142`) and NOT input-line coloring
(forbidden by the no-local-echo rule, see `docs/02-technical-architecture.md`).

## Library research (do NOT replace bespoke with a library)

Investigated before planning bespoke. Recording here so an implementing agent
knows bespoke is deliberate, not an oversight.

**xterm.js official addons** (`addon-fit`, `addon-web-links`, `addon-search`,
`addon-serialize`, `addon-webgl`, `addon-unicode11`): **no highlight addon
exists.** The `ICharacterJoiner` API is for grapheme clusters (combining
characters), not recoloring. `registerDecoration` (used by the existing
timestamps feature) renders overlay DOM elements, not inline cell recoloring.
Writing a custom renderer addon would mean reimplementing the WebGL/DOM renderer
— massive overkill for color injection.

**Code highlighters** (highlight.js, shiki, prismjs):

| Library | Cisco IOS / NX-OS / F5 TMOS grammar | bash/shell grammar | Bundle weight |
|---|---|---|---|
| highlight.js | None | Yes | ~1MB core |
| shiki (VS Code) | None | Yes | Heavy — TextMate grammars + oniguruma WASM |
| prismjs | None | Yes | Lighter |

Critical mismatch: these parse structured **language grammars**. Our use case is
**unstructured command output** — colorizing IPs, interface names, status words
in `show ip interface brief` or `ip addr` output. That's pattern-matching, not
grammar-parsing. Running bash grammar on `ip addr` output mis-highlights
("up" parsed as keyword, etc.). Network CLI output is not a "language" in the
highlight.js sense.

**cli-highlight** (`npm i cli-highlight`): wraps highlight.js + chalk + parse5
(HTML parser). Node-focused, whole-document, designed for piping stdout through.
Last published >1yr ago. Pulls `parse5` (HTML parser) into a Tauri frontend
bundle for no reason. Still no Cisco/F5 grammars — same gap as highlight.js.

**Industry analog:** iTerm2's "Triggers" (user regex → color) is the closest
mainstream feature. No open library does regex-based colorization of arbitrary
network CLI output, because the rules are network-OS-specific where no grammar
exists.

**Verdict:** bespoke regex-based highlighting IS the right approach. The rules
ARE the feature — they encode network engineering domain knowledge no library
has. We borrow the ANSI injection pattern (same mechanism cli-highlight uses)
and keep the palette semantic mapping from the existing design tokens.

## Decisions (user-confirmed)

- **Off by default** on first ship. User opts in via a toolbar toggle button.
  Safer for first release — no surprise coloring, easy rollback.
- **Rules in a TypeScript module** (`src/lib/highlight-rules.ts`), not YAML.
  Faster iteration, type-checked, version-controlled. No runtime parsing, no
  Rust IPC. Unlike the knowledge base, rules are app logic, not user data.
- **Only terminal output highlighting** is in scope. Sidebar/KB syntax coloring
  and ghost-text coloring are explicitly out of scope for this plan.

## Background — read these before starting

An implementing agent MUST read these docs first to understand the architecture
constraints that shape this plan:

| Doc | Why it matters |
|---|---|
| `docs/02-technical-architecture.md` | Shadow buffer model, no local echo, keystroke flow, prompt detection pipeline. The "Keystroke Flow" and "Prompt Detection" sections are mandatory reading. |
| `AGENTS.md` | Non-negotiable rules: no local echo, no heavy logic in Rust that could be in frontend, keyboard-first, no `Ctrl+W` interception. |
| `docs/03-ui-visual-design.md` | Design tokens, toolbar button conventions, color semantics. |
| `docs/05-suggestion-engine.md` | How `receivingOutput` gating already works for suggestions — the highlighter reuses the same gate. |

## Architecture

### Current output flow

In `src/components/terminal-view.ts`, the `ssh-output` event listener
(`registerSshListeners()`, around line 642):

```
ssh-output event
  → decode base64 bytes → text
  → terminal.write(bytes)              // raw bytes to xterm
  → promptDetector.feed(text)          // original text to detector
  → if text.includes("\n"):
      receivingOutput = true
      (300ms later) receivingOutput = false
```

### New flow

```
ssh-output event
  → decode base64 bytes → text
  → if highlighter.enabled AND receivingOutput AND NOT promptDetector.passthrough:
      transformed = highlighter.transform(text, platform)
      terminal.write(transformed)     // string with injected ANSI
  else:
      terminal.write(bytes)           // raw bytes, unchanged
  → promptDetector.feed(text)          // ALWAYS original text, never transformed
  → (receivingOutput flag logic unchanged)
```

**Critical invariant:** `promptDetector.feed()` always receives the ORIGINAL
text, never the transformed text. Injected ANSI codes would corrupt the prompt
regex matching (see `src/lib/prompt-detector.ts:39` — patterns use `^...$` anchors
on ANSI-stripped text; injecting ANSI before the strip would break matches).

### Why gate on `receivingOutput`

`receivingOutput` (tracked in `terminal-view.ts:119`, set at line 668) is the
existing signal that distinguishes command output from keystroke echo. It
becomes `true` when output contains a newline, and resets to `false` 300ms after
the last newline-bearing chunk.

- **Echo** (single chars, no newline) → `receivingOutput === false` → passthrough.
  We must NOT color echo: the remote device owns echo, and recoloring it would
  require local echo (forbidden by `docs/02-technical-architecture.md`).
- **Command output** (multi-line, contains newlines) → `receivingOutput === true`
  → highlighter applies rules line-by-line.
- **First output chunk** (the one that flips the flag via its newline) is written
  BEFORE the flag is set (line 652 write, line 668 flag set). That chunk passes
  through untransformed. This is correct and desirable — that chunk is typically
  the echoed command line, not result output.

### Interactive-app bypass (`vi`, `more`, `top`)

Interactive apps produce rapid continuous output with no idle gap and no prompt
match. The prompt detector already uses this to enter raw pass-through mode for
suggestions (`docs/02-technical-architecture.md:107`). The highlighter must use
the same signal.

**New `passthrough` flag on `PromptDetector`** (`src/lib/prompt-detector.ts`):

- Add `private passthrough = false`
- Add a second timer: if no prompt has matched for >2000ms AND `feed()` keeps
  receiving data, set `passthrough = true`.
- On next successful prompt match (`checkPrompt()`), clear `passthrough = false`.
- Expose via `get isPassthrough(): boolean`.
- This is SEPARATE from the existing `IDLE_MS = 200` timer — that timer fires the
  prompt CHECK; this new timer tracks sustained no-match-while-outputting.

The highlighter checks `promptDetector.isPassthrough` and bypasses when true.
This prevents corrupting `vi`/`more`/`top` screen output, where injected ANSI
would break cursor positioning and screen redraws.

### Burst-rate fallback

Large dumps (`show tech-support`, `cat /var/log/...`) can produce thousands of
lines/sec. Per-line regex application at that rate can stutter the UI.

**Rule:** if the highlighter processes more than N lines in the last M ms
(initial: 500 lines / 1000ms), set a `burstMode = true` flag and pass through
unchanged until the rate drops below the threshold for 500ms. This is a
heuristic safety valve, not a precise throttle — correctness over smoothness.

Track in `OutputHighlighter`:
- `private lineCount = 0`
- `private windowStart = 0` (timestamp)
- On each `transform()` call that processes lines: increment, check window,
  set `burstMode` if exceeded, reset window.

## Highlighting rules

### Config location

`src/lib/highlight-rules.ts` — exported as a `Record<platform, Rule[]>`.

```ts
export interface HighlightRule {
  pattern: RegExp;        // matches a substring within a single line
  color: AnsiColor;       // from highlight-palette.ts
  priority?: number;      // lower = applied first; earlier rules win on overlap
}
```

Platform keys match `knowledge-base/` directory names exactly:
`"cisco-iosxe"`, `"cisco-nxos"`, `"f5-tmos"`, `"linux-bash"`.

### Rule application algorithm (per line)

1. If line contains existing ANSI escape sequences (`/\x1b\[/` test) → SKIP
   the line entirely. The device already colored it; injecting more would
   double-color or conflict. Use the existing `stripAnsi` from `src/lib/ansi.ts`
   to detect, not to strip.
2. Sort rules by `priority` (default 0).
3. For each rule, find all matches in the line. Track match spans
   `[start, end)`.
4. If a new match overlaps an already-claimed span, skip it (first rule wins).
5. Build the output line by splicing ANSI color codes around each claimed span:
   `\x1b[<color>m<matched-text>\x1b[0m`. Reset to default foreground after each
   span (use `\x1b[39m` to reset only foreground, not `\x1b[0m` which resets
   everything — preserves any device bold/underline that preceded it). Actually
   use `\x1b[0m` for safety since we already skipped lines with existing ANSI.

### Rule source — MobaXterm reference

The Cisco rule sets below are derived from a real-world MobaXterm custom syntax
config (MobaXterm's "CustomSyntax" feature uses regex → ANSI color mapping,
same model as this feature). See `Cisco syntax highlighting.txt` reference.

Key adaptations from MobaXterm:
- **Boundary style:** MobaXterm uses `[^A-Za-z0-9]` char classes instead of
  `\b` word boundaries. More permissive — treats parens, brackets, slashes as
  boundaries (matches `interface(GigabitEthernet0/0)` etc.). We adopt this.
- **Prompt anchor:** MobaXterm rules prefix with `�` (a non-ASCII prompt char)
  to anchor "start of line after prompt." We DROP this — our `receivingOutput`
  gate already ensures we only process post-prompt output lines, so every line
  we touch is inherently post-prompt.
- **Color semantics map directly:** MobaXterm red/green/yellow/blue/magenta/cyan
  → our red/green/yellow/blue/magenta/cyan `AnsiColor` tokens.

### Initial rule sets (battle-tested — high signal, low false-positive)

**Boundary convention:** all status-word and keyword rules use
`(?:^|[^A-Za-z0-9])` as the left boundary and `(?=$|[^A-Za-z0-9])` as the right
boundary (equivalent to MobaXterm's `[^A-Za-z0-9]` but also matching start/end of
line). This is more permissive than `\b` and correctly handles Cisco output like
`GigabitEthernet0/0/0(is up)`.

**Common (apply to all platforms — add as a fallback layer):**

| Pattern | Color | Notes |
|---|---|---|
| URL: `(?:https?://)[A-Za-z0-9_.&?=%~#{}()@+-]+` | underline | MobaXterm underline; we map to `blue` (ANSI has no underline token in our palette — use blue). Actually add `underline` as a styling ANSI (`\x1b[4m`) combined with a color. For v1: use `blue`. |
| IPv4: `(?:[1-9]\|[1-9][0-9]\|1[0-9][0-9]\|2[0-4][0-9]\|25[0-4])\.[0-9]+\.[0-9]+\.[0-9]+` | yellow | MobaXterm pattern — stricter than `\d{1,3}` (rejects leading-zero octets) |
| IPv6: `(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F:]+` | yellow | Conservative — requires 2+ groups |
| MAC: `[0-9a-fA-F]{2}(?::\|-)[0-9a-fA-F]{2}(?::\|-)[0-9a-fA-F]{2}(?::\|-)[0-9a-fA-F]{2}(?::\|-)[0-9a-fA-F]{2}(?::\|-)[0-9a-fA-F]{2}` | yellow | MobaXterm accepts `:` or `-` separators |
| `localhost` | yellow | MobaXterm |
| Negative status: `(?:disabled\|unknown\|fault\|shutdown\|disconnected\|error\|failed\|denied\|not permitted\|disallowed\|not allowed\|refused\|problem\|failure\|notconnect\|down\|invalid\|unreachable\|blocked\|inactive\|stopped)` (case-insensitive, bounded) | red | MobaXterm red set + extensions. Bounded with `(?:^|[^A-Za-z0-9])...(?=$|[^A-Za-z0-9])`. |
| `no ` (negation prefix at line start) | red | MobaXterm — Cisco `no` form negates a command; color it red to flag removal. Pattern: `^no\s` (we don't need MobaXterm's prompt anchor — `^` suffices since we process line-by-line). |
| Positive status: `(?:enabled\|connected\|up\|yes\|ok\|active\|running\|established\|reachable)` (case-insensitive, bounded) | green | MobaXterm green set + extensions |
| `warn\|warning\|degraded` (case-insensitive, bounded) | orange | Not in MobaXterm but common across platforms |
| Cisco log prefix: `^%[A-Z]+-\d+-[A-Z]+` | red | `%SYS-...`, `%LINK-...`, `%LINEPROTO-...` |

**`linux-bash`:**

| Pattern | Color | Notes |
|---|---|---|
| File path: `/(?:[a-zA-Z0-9._-]+/)+[a-zA-Z0-9._-]+` | blue | `/etc/...`, `/var/log/...` |
| `~/...` paths | blue | |
| Man page section header: `^[A-Z][A-Z ]+$` (short uppercase lines) | bold | Use bold ANSI (`\x1b[1m`) |
| (inherits Common rules) | | |

**`cisco-iosxe` and `cisco-nxos` (share rules — duplicate intentionally per AGENTS.md; derived from MobaXterm reference):**

| Pattern | Color | Notes |
|---|---|---|
| Interface: `(?:[a-z]+thernet\|gi\|TenGigE\|TenGigabitEthernet\|FastEthernet\|Ethernet\|Loopback\|Tunnel\|Vlan\|Port-channel\|Management)[0-9]+(?:/[0-9]+)*` (case-insensitive) | yellow | MobaXterm pattern: `[a-z]+thernet\|gi` covers `GigabitEthernet`, `TenGigabitEthernet`, `FastEthernet`, `Ethernet`, `gi` shorthand. Add the long forms for clarity. |
| VLAN: `[Vv]lan[0-9]+` | yellow | MobaXterm — overlaps interface rule, higher priority |
| Config comment line: `^!.*` | blue | MobaXterm blue — `!` lines in Cisco config |
| Config description/identity lines: `^(description\|hostname\|nameif\|version)\s.+` | green | MobaXterm green — context lines |
| Config keywords (magenta set): `(?:policy-map\|class\|global\|logging(?:\s+event)?\|(?:allocate-)?interface\|failover\|static\|security-level\|service(?:-policy)?\|spanning-tree\|switchport)` (case-insensitive, bounded) | magenta | MobaXterm magenta — config-mode structural keywords |
| Command/output keywords (cyan set): `(?:%link-[0-9]+-updown\|(?:allowed\s+)?(?:private-)?vlan(?:-range)?\|route\|access-(?:list\|group)\|port-forward\|mtu\|show\|encapsulation\|rate-limit\|speed\|duplex\|autoneg\|snmp-server\|media-type\|ip(?:\s+address)?\|monitor(?:\s+session)?)` (case-insensitive, bounded) | cyan | MobaXterm cyan — command/output keywords. `%link-N-updown` is a Cisco log message. |
| ACL verbs: `(?:permit\|deny)` (bounded) | yellow/red | `permit` → yellow, `deny` → red. Two separate rules, `deny` higher priority. |
| `is up`, `is down`, `is administratively down`, `line protocol is (up\|down)` | green/red | Context status. `up` → green, `down` → red. Implement as two rules. |
| (inherits Common rules) | | |

**`f5-tmos`:**

| Pattern | Color | Notes |
|---|---|---|
| Pool/member status: `(?:available\|active\|down\|disabled)` (bounded) | green/red | `available`/`active` → green, `down`/`disabled` → red |
| VIP/pool addresses: IPv4 rule (shared from Common) | yellow | |
| `tmsh` paths: `/(?:usr/)?(?:local/)?(?:config\|var)/...` | blue | |
| (inherits Common rules) | | |

Rules are deliberately conservative. False positives (e.g. coloring "up" in
prose) are mitigated with the `[^A-Za-z0-9]` boundary style (MobaXterm's
approach) and context patterns. The agent implementing this should NOT add broad
rules like "color all numbers" — specificity is the design constraint.

## Color palette

`src/lib/highlight-palette.ts` — maps semantic color names to ANSI SGR codes.
ANSI 256-color codes chosen to match the existing design token semantics from
`docs/03-ui-visual-design.md` (these are FIXED constants, not CSS vars — ANSI
codes go into the byte stream, not the DOM):

```ts
export type AnsiColor =
  | "cyan"       // addresses, interfaces — #22D3EE-ish → ANSI 51
  | "green"      // up/ok/active — #22C55E-ish → ANSI 34/28
  | "red"        // down/error/failed — #EF4444-ish → ANSI 196/160
  | "orange"     // warn/warning — #F59E0B-ish → ANSI 208/172
  | "yellow"     // permit/ACL — #EAB308-ish → ANSI 220/178
  | "blue"       // paths — #3B82F6-ish → ANSI 33/27
  | "muted"      // secondary — #94A3B8-ish → ANSI 245
  | "bold";      // man headers — ANSI 1

export const ANSI_CODES: Record<AnsiColor, string> = {
  cyan:   "38;5;51",
  green:  "38;5;34",
  red:    "38;5;196",
  orange: "38;5;208",
  yellow: "38;5;220",
  blue:   "38;5;33",
  muted:  "38;5;245",
  bold:   "1",
};
```

Injection format: `\x1b[${ANSI_CODES[color]}m${text}\x1b[0m`.

These are tuned for the dark terminal theme (`#0F172A` background). A future
enhancement could swap palettes for the light terminal theme, but for v1 both
themes use the same palette (the colors chosen have sufficient contrast on
both `#0F172A` and `#F8FAFC`).

## Feature flag & toolbar toggle

Follow the EXACT established pattern of the existing toggles (timestamps,
suggestions, auto-copy). See `terminal-view.ts:74-81` for the suggestions
toggle as the reference implementation.

### Storage + events

`src/lib/output-highlight.ts` (new, ~30 lines):

```ts
const STORAGE_KEY = "netsh-output-highlight";

export function getOutputHighlightEnabled(): boolean {
  return localStorage.getItem(STORAGE_KEY) === "1";
}

export function setOutputHighlightEnabled(enabled: boolean): void {
  localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
  window.dispatchEvent(new CustomEvent("netsh:output-highlight", { detail: enabled }));
}
```

### Toolbar button

In `terminal-view.ts` `mount()` (around line 425-475, the `container.innerHTML`
template), add a button to `.tv-topbar` alongside the existing toggles:

```html
<button class="btn-text tv-highlight-btn" aria-label="Toggle output highlighting"></button>
```

Place it AFTER `.tv-autocopy-btn` and BEFORE `.tv-theme-btn` (ordering:
timestamps, suggestions, autocopy, **highlight**, theme, panel — keeps
output-affecting toggles grouped before cosmetic ones).

Wire it identically to `.tv-suggestions-btn` (see lines 519-524):
- Click → `setOutputHighlightEnabled(!getOutputHighlightEnabled())`
- Listen for `netsh:output-highlight` window event → `syncHighlight()`
- `syncHighlight()` method: read flag, toggle `.active` class, set icon + aria-label.
- Icon: use a Lucide "palette" or "highlighter" path. Add to `src/lib/icons.ts`.
  Suggested: Lucide "paintbrush" path:
  `<path d="M18.37 2.63 14.7 6.3a2.5 2.5 0 1 0 3.6 3.6L21.97 6.23"/><path d="m9 13-2-2"/><path d="m14 18-2-2"/><path d="m14 4-2-2"/><path d="m5 18 3 3"/><path d="M9 11 4 6a3 3 0 0 1 0-4l3 3"/>`
  (or pick any Lucide icon — verify it renders at 14px in the toolbar).
- Add `.tv-highlight-btn` to the existing `.active` CSS rules in
  `_terminal-view.css:399-413` (extend the selector list).

### Cross-tab sync

Because the toggle dispatches a `window` event and each `TerminalView` instance
listens, all open session tabs stay in sync (same pattern as timestamps/theme).

## Files to create / modify

| File | Action | Lines (est.) |
|---|---|---|
| `src/lib/output-highlighter.ts` | **New** — line-buffered transform, gating, burst fallback, rule application | ~150 |
| `src/lib/highlight-rules.ts` | **New** — per-platform rule sets + `HighlightRule` interface | ~120 |
| `src/lib/highlight-palette.ts` | **New** — `AnsiColor` type + `ANSI_CODES` map | ~25 |
| `src/lib/output-highlight.ts` | **New** — feature flag get/set + window event (toggle module) | ~15 |
| `src/lib/prompt-detector.ts` | **Modify** — add `passthrough` flag + 2s timeout + `isPassthrough` getter | +25 |
| `src/components/terminal-view.ts` | **Modify** — wire highlighter into `ssh-output` handler, add toolbar button, `syncHighlight()`, cleanup | +40 |
| `src/lib/icons.ts` | **Modify** — add highlight/paintbrush icon | +2 |
| `src/styles/components/_terminal-view.css` | **Modify** — add `.tv-highlight-btn` to `.active` selector lists (lines 399-413) | +3 |

### No Rust changes

Highlighting is pure frontend. No new Tauri commands, no Rust deps, no IPC. Per
AGENTS.md, latency-critical paths stay in the frontend.

## Integration details for `terminal-view.ts`

### 1. New imports

```ts
import { OutputHighlighter } from "../lib/output-highlighter";
import { getOutputHighlightEnabled, setOutputHighlightEnabled } from "../lib/output-highlight";
```

### 2. New private fields (alongside existing `ghostText`, `dropdown`, etc.)

```ts
private outputHighlighter: OutputHighlighter | null = null;
private highlightChangeHandler: (() => void) | null = null;
```

### 3. Initialize in `registerSshListeners()` → `ssh-connected` handler

After `this.ghostText = new GhostText(...)` (around line 708):

```ts
this.outputHighlighter = new OutputHighlighter(this.host?.platform ?? "linux-bash");
```

Pass the platform from `this.host.platform` so rules load for the right device.

### 4. Modify the `ssh-output` handler (line 642-681)

Replace the write block (lines 649-656):

```ts
if (this.state === "connected") {
  const buf = this.terminal!.buffer.active;
  const lineBefore = buf.baseY + buf.cursorY;

  const highlightOn = getOutputHighlightEnabled()
    && this.receivingOutput
    && !this.promptDetector.isPassthrough
    && this.outputHighlighter !== null;

  if (highlightOn) {
    const transformed = this.outputHighlighter!.transform(text);
    this.terminal?.write(transformed, () => {
      const b = this.terminal?.buffer.active;
      if (b) this.timestampGutter?.onWrite(lineBefore, b.baseY + b.cursorY);
    });
  } else {
    this.terminal?.write(bytes, () => {
      const b = this.terminal?.buffer.active;
      if (b) this.timestampGutter?.onWrite(lineBefore, b.baseY + b.cursorY);
    });
  }
  this.promptDetector.feed(text);  // ALWAYS original text
}
```

Keep the `receivingOutput` flag logic (lines 668-680) UNCHANGED.

### 5. Toolbar button (in `mount()`)

Add to the topbar HTML template (after `.tv-autocopy-btn`, before `.tv-theme-btn`):

```html
<button class="btn-text tv-highlight-btn" aria-label="Toggle output highlighting"></button>
```

Add the click listener + event sync (after the auto-copy block, ~line 532):

```ts
this.$(".tv-highlight-btn")!.addEventListener("click", () => {
  setOutputHighlightEnabled(!getOutputHighlightEnabled());
});
this.highlightChangeHandler = () => this.syncHighlight();
window.addEventListener("netsh:output-highlight", this.highlightChangeHandler);
this.syncHighlight();
```

### 6. `syncHighlight()` method (alongside `syncSuggestions`, `syncAutoCopy`)

```ts
private syncHighlight() {
  const on = getOutputHighlightEnabled();
  const btn = this.$(".tv-highlight-btn");
  if (btn) {
    btn.innerHTML = icons.paintbrush;
    btn.classList.toggle("active", on);
    this.setBtnLabel(btn, on ? "Disable output highlighting" : "Enable output highlighting");
  }
}
```

### 7. Cleanup in `cleanup()` (around line 1295)

Add alongside the other handler removals:

```ts
if (this.highlightChangeHandler) {
  window.removeEventListener("netsh:output-highlight", this.highlightChangeHandler);
  this.highlightChangeHandler = null;
}
this.outputHighlighter = null;
```

## CSS changes

In `src/styles/components/_terminal-view.css`, extend the existing `.active`
selector lists (lines 399-413) to include `.tv-highlight-btn`:

```css
.tv-timestamps-btn.active,
.tv-suggestions-btn.active,
.tv-autocopy-btn.active,
.tv-highlight-btn.active {       /* ADD */
  color: var(--color-accent);
}

.tv-timestamps-btn.active:hover,
.tv-suggestions-btn.active:hover,
.tv-autocopy-btn.active:hover,
.tv-highlight-btn.active:hover { /* ADD */
  color: var(--color-accent-hover);
  background: var(--accent-tint-soft);
}
```

No new CSS file. The button inherits `.tv-topbar .btn-text` pill styles (line 395).

## `OutputHighlighter` class — detailed design

`src/lib/output-highlighter.ts`:

```ts
import { HIGHLIGHT_RULES, HighlightRule } from "./highlight-rules";
import { ANSI_CODES, AnsiColor } from "./highlight-palette";

const ANSI_DETECT = /\x1b\[/;           // detect existing ANSI in a line
const BURST_LINE_THRESHOLD = 500;       // lines in window
const BURST_WINDOW_MS = 1000;           // sliding window
const BURST_COOLDOWN_MS = 500;           // quiet period before re-enabling

export class OutputHighlighter {
  private rules: HighlightRule[];
  private lineBuffer = "";
  private burstMode = false;
  private lineCount = 0;
  private windowStart = 0;
  private lastBurstLine = 0;

  constructor(platform: string) {
    this.rules = HIGHLIGHT_RULES[platform] ?? [];
  }

  /** Update platform rules (e.g. on reconnect to a different host type). */
  setPlatform(platform: string) {
    this.rules = HIGHLIGHT_RULES[platform] ?? [];
    this.lineBuffer = "";
  }

  /**
   * Transform a chunk of output text. Line-buffered: accumulates until a
   * newline is seen, then applies rules to each complete line. Returns a
   * string (possibly with injected ANSI) to write to xterm.
   */
  transform(text: string): string {
    if (this.rules.length === 0) return text;

    this.lineBuffer += text;
    const lines = this.lineBuffer.split("\n");
    // Last element is the partial line (no trailing newline) — keep it buffered
    this.lineBuffer = lines.pop() ?? "";

    let out = "";
    for (const line of lines) {
      out += this.transformLine(line) + "\n";
    }
    // Flush the partial line too if it's likely a prompt (no newline, small) —
    // actually NO: partial lines stay buffered until newline arrives. But if
    // buffer grows unbounded (device never sends newline), flush at cap.
    if (this.lineBuffer.length > 65536) {
      out += this.lineBuffer;
      this.lineBuffer = "";
    }
    return out;
  }

  private transformLine(line: string): string {
    // Skip lines with existing ANSI (device already colored)
    if (ANSI_DETECT.test(line)) return line;

    // Burst-rate fallback
    const now = Date.now();
    if (now - this.windowStart > BURST_WINDOW_MS) {
      this.windowStart = now;
      this.lineCount = 0;
      if (this.burstMode && now - this.lastBurstLine > BURST_COOLDOWN_MS) {
        this.burstMode = false;
      }
    }
    this.lineCount++;
    if (this.lineCount > BURST_LINE_THRESHOLD) {
      this.burstMode = true;
      this.lastBurstLine = now;
    }
    if (this.burstMode) return line;

    // Apply rules, tracking claimed spans to avoid overlap
    const claimed: Array<[number, number]> = [];
    const sorted = [...this.rules].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
    const injections: Array<{ start: number; end: number; color: AnsiColor }> = [];

    for (const rule of sorted) {
      const re = new RegExp(rule.pattern.source, rule.pattern.flags.includes("g") ? rule.pattern.flags : rule.pattern.flags + "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        const s = m.index;
        const e = s + m[0].length;
        // Check overlap with claimed spans
        if (claimed.some(([cs, ce]) => s < ce && e > cs)) continue;
        claimed.push([s, e]);
        injections.push({ start: s, end: e, color: rule.color });
        if (m[0].length === 0) re.lastIndex++; // avoid zero-length loop
      }
    }

    if (injections.length === 0) return line;

    // Build output by splicing ANSI codes around matched spans
    injections.sort((a, b) => a.start - b.start);
    let result = "";
    let pos = 0;
    for (const inj of injections) {
      result += line.substring(pos, inj.start);
      result += `\x1b[${ANSI_CODES[inj.color]}m`;
      result += line.substring(inj.start, inj.end);
      result += "\x1b[0m";
      pos = inj.end;
    }
    result += line.substring(pos);
    return result;
  }
}
```

**Note on line buffering:** the highlighter buffers partial lines until a
newline arrives. This means output is delayed by one line (the partial line
shows only when the next newline arrives). This is acceptable and matches how
most terminal colorizers work. The `65536` cap prevents pathological stalls if a
device sends a very long line without newlines (rare; flushes as-is).

**Note on `\r\n`:** terminal output often uses `\r\n`. The `split("\n")` leaves
the `\r` at the end of each line. The regex rules should account for this —
patterns generally won't match `\r` since they use word boundaries. The `\r`
gets preserved in the output (xterm interprets `\r` as carriage return). No
special handling needed, but the implementing agent should verify `\r` doesn't
break rule matching (test with `show ip interface brief` output on Cisco).

## `PromptDetector` changes

`src/lib/prompt-detector.ts` — add passthrough tracking:

```ts
private passthrough = false;
private noMatchTimer: ReturnType<typeof setTimeout> | null = null;
private static readonly PASSTHROUGH_MS = 2000;

// In feed(), after resetting the existing idleTimer:
if (this.noMatchTimer) clearTimeout(this.noMatchTimer);
this.noMatchTimer = setTimeout(() => {
  // No prompt matched for 2s while data kept arriving → interactive app
  this.passthrough = true;
}, PromptDetector.PASSTHROUGH_MS);

// In checkPrompt(), on a successful match:
this.passthrough = false;
if (this.noMatchTimer) {
  clearTimeout(this.noMatchTimer);
  this.noMatchTimer = null;
}

// Public getter:
get isPassthrough(): boolean {
  return this.passthrough;
}
```

**Important:** the existing `IDLE_MS = 200` timer fires the prompt CHECK
(`checkPrompt()`). The new `PASSTHROUGH_MS = 2000` timer is SEPARATE — it tracks
"sustained no-match while output continues". They are independent timers with
different purposes. Do not merge them.

The `noMatchTimer` is cleared on every `feed()` call and reset — same as the
existing `idleTimer`. It only fires if NO prompt matched for the full 2s window,
which only happens during interactive apps (rapid output, no idle gap long
enough for a prompt match, OR prompts that don't match any pattern).

## Verification

Before marking complete, the implementing agent MUST run and pass:

1. **`npm run build`** (runs `tsc`) in the project root — must exit 0.
   This is the mandatory frontend verification per AGENTS.md.

2. **Manual QA** (using the mock server in `src-tauri/src/test_server.rs`,
   started via `testStartMockServer()` — see how existing tests use it):
   - Connect to a Linux mock host.
   - Toggle highlighting ON via the toolbar button.
   - Type a command that produces output with IPs and status words.
   - Verify: IPs appear cyan, `up`/`active` green, `down`/`error` red.
   - Verify: the echoed command line (before output) is NOT colored.
   - Toggle highlighting OFF → verify output returns to plain monochrome.
   - Verify: the toggle persists across app restart (check `localStorage`).

3. **Interactive-app regression:**
   - Start `vi` or `more` on a connected host.
   - Verify: `vi`/`more` screen output is NOT colored (passthrough flag).
   - Verify: exiting `vi`/`more` returns to prompt and highlighting resumes.

4. **Device-emitted ANSI regression:**
   - Run `ls --color=auto` on a Linux host (produces ANSI-colored output).
   - Verify: the device's colors are preserved, NOT double-colored or stripped.

5. **Large-output regression:**
   - Run a command that produces >500 lines rapidly (e.g. `seq 1 10000`).
   - Verify: no UI freeze/stutter; burst-mode fallback kicks in and passes
     through untransformed until rate drops.

6. **Prompt detection regression:**
   - After highlighted output, verify the prompt detector still correctly
     detects the next prompt and resets mode (feed original text — confirm
     `promptDetector.feed(text)` receives untransformed text).

7. **Cross-tab sync:**
   - Open two session tabs to different hosts.
   - Toggle highlighting in one tab.
   - Verify: the other tab's toolbar button reflects the same state.

## Deliberately skipped (out of scope — do NOT implement)

| Skip | Why | Add when |
|---|---|---|
| Sidebar/KB syntax coloring | Already spec'd in `docs/03-ui-visual-design.md:142`, separate effort | Separate plan |
| Ghost text / suggestion coloring | Different overlay, different mechanism | Separate plan |
| Input-line highlighting (fish-style) | Forbidden — requires local echo, violates `docs/02-technical-architecture.md` | Never |
| Light-theme-specific ANSI palette | v1 uses one palette for both themes; chosen codes have contrast on both | Light-theme user complaints |
| User-editable rule files (YAML) | Rules are app logic, not user data; TS module is type-checked | Power-user demand |
| Per-rule enable/disable UI | Adds complexity; rules are conservative by design | False-positive reports |
| Highlighting in the connection-phase output pane | That pane shows raw connection logs, not command output | Never (different context) |

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Breaks interactive apps (`vi`, `more`, `top`) | `promptDetector.isPassthrough` gate + `receivingOutput` gate |
| Double-colors device-emitted ANSI | Skip lines containing `\x1b\[` (existing-ANSI detection) |
| Latency on large output (`show tech-support`) | Line buffer is per-line; burst-rate fallback at 500 lines/sec |
| False positives (colors "up" in prose) | Conservative rules with word boundaries + context patterns |
| Corrupts prompt detection | `promptDetector.feed()` ALWAYS receives original (untransformed) text |
| Breaks copy/paste | xterm selection reads buffer cells; verify ANSI is handled correctly on selection — test in QA |
| Line-buffer delay (partial line held until newline) | Acceptable — matches standard colorizer behavior; 64KB cap prevents stalls |
| `\r\n` confuses regex matching | Patterns use word boundaries; `\r` preserved in output. Verify in QA. |