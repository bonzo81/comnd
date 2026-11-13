/**
 * Chunk-boundary stream replay — issue #58.
 *
 * Run with: npx vitest run src/lib/stream-replay.test.ts
 *
 * An SSH session delivers output in arbitrary byte slices, so a CSI/OSC
 * sequence or a multibyte codepoint can be split across two chunks. This
 * suite replays the same synthetic byte stream four times at different chunk
 * sizes — 1 byte, 2 bytes, 3 bytes and the whole event — plus once more as
 * slow interleaved chunks, and asserts the product reaches the same final
 * state every time. The interleaved schedule delivers 2-byte chunks 100 ms
 * apart, so a burst outlives the 300 ms output window opened by its newline
 * and a repaint lands in pieces. Its gaps stay below the idle tick, but they
 * still shift the phase of the 2 s passthrough window, which suppresses the
 * echo re-sync while it holds — the issue allows that, so the interleaved run
 * is compared on final state only, while the byte-only schedules have to agree
 * at every step and at every settled checkpoint.
 * The replay uses the real path (`StreamingTextDecoder.decode` →
 * `SuggestionController.onOutput` → `LineTracker.feed`) with the real
 * `GhostText` and `Dropdown`; there is no second parser, stripper or prompt
 * matcher in here.
 *
 * What is compared across schedules: at every step for the byte-only
 * schedules, the tracker-owned state
 * (`currentLine`, prompt mode, secret-prompt flag, passthrough, and the prompt
 * detection / mode change / secret detection counts) plus the bytes sent to
 * the remote. At every settled checkpoint — a step followed by an `idle` long
 * enough to fire the 200 ms idle tick and the 300 ms output window — the whole
 * state also has to agree, including the shadow buffer, ghost text and
 * dropdown. Between checkpoints the timeline may legitimately differ (a
 * re-chunked echo reconciles on a later tick with a smaller chunk), but once
 * everything is quiet the schedules must be indistinguishable.
 *
 * The WebDriver smoke suite feeds whole writes from the mock host, so it does
 * not cover this class of bug and no smoke coverage is claimed here.
 *
 * The checkpoint comparison is what caught the bug that prompted this suite:
 * an untrusted shadow buffer was reconciled on the first chunk of a repaint,
 * so the lone `\r` a 1-byte schedule delivers wiped the line and hid the ghost.
 * The re-sync now runs on the tracker's idle tick, the first moment the whole
 * burst has arrived. Keep the checkpoint assertions — comparing only the final
 * sample lets a later prompt heal the divergence and hide it again.
 *
 * How to add a fixture: copy the platform's `prompt_patterns`,
 * `secret_prompt_patterns`, `default_mode` and `prefix_commands` verbatim from
 * `knowledge-base/<platform>/index.yaml` into a `platform(...)` call, naming
 * that file in a comment — never invent a pattern. Then write a `Fixture` whose
 * `steps` alternate typed input (`type`), single control keystrokes (`key`),
 * remote bursts (`out`) and explicit quiet windows (`idle`). Only `out` steps
 * are re-chunked, and a step is the only place the clock moves, so every
 * schedule sees the same timeline; never sleep and never advance timers from a
 * helper. Use obviously fake hostnames, addresses and passwords, and derive
 * `expected` from the platform specs by hand — it is the golden final state,
 * not a snapshot of whatever the run produced.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { SuggestionController } from "./suggestion-controller";
import { LineTracker } from "./line-tracker";
import { GhostText } from "./ghost-text";
import { Dropdown } from "./dropdown";
import { StreamingTextDecoder } from "./stream-decoder";
import type { Command, PlatformIndex } from "./tauri-api";

// ─── Steps ──────────────────────────────────────────────────────────────────

type Step =
  | { kind: "type"; text: string }
  | { kind: "key"; keys: string[] }
  | { kind: "out"; text: string }
  | { kind: "idle"; ms: number };

/** Local keystrokes: one `keyIn` per character, as xterm delivers them. */
const type = (text: string): Step => ({ kind: "type", text });
/** One `keyIn` per control sequence (`\x7f`, `\x1b[D`, `\r`, …). */
const key = (...keys: string[]): Step => ({ kind: "key", keys });
/** A remote output burst — the only step whose bytes are re-chunked. */
const out = (text: string): Step => ({ kind: "out", text });
/** Advance the fake clock; the only thing that fires timers. */
const idle = (ms: number): Step => ({ kind: "idle", ms });

const repeat = (seq: string, count: number): string[] => Array.from({ length: count }, () => seq);

// ─── Observable state ───────────────────────────────────────────────────────

interface Sample {
  line: string;
  mode: string;
  secret: boolean;
  passthrough: boolean;
  receivingOutput: boolean;
  input: string;
  ghost: string | null;
  dropdown: boolean;
  prompts: number;
  modeChanges: number;
  secrets: number;
}

const TRACKER_FIELDS: ReadonlyArray<keyof Sample> = [
  "line",
  "mode",
  "secret",
  "passthrough",
  "prompts",
  "modeChanges",
  "secrets",
];

const ALL_FIELDS: ReadonlyArray<keyof Sample> = [
  "line",
  "mode",
  "secret",
  "passthrough",
  "receivingOutput",
  "input",
  "ghost",
  "dropdown",
  "prompts",
  "modeChanges",
  "secrets",
];

function pick(sample: Sample, fields: ReadonlyArray<keyof Sample>): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const field of fields) picked[field] = sample[field];
  return picked;
}

interface Schedule {
  label: string;
  /** Bytes per `decode` call; `Infinity` delivers a whole burst at once. */
  chunk: number;
  /** Fake-clock ms between the chunks of one burst, as a slow device does. */
  gap: number;
}

const SCHEDULES: ReadonlyArray<Schedule> = [
  { label: "1-byte", chunk: 1, gap: 0 },
  { label: "2-byte", chunk: 2, gap: 0 },
  { label: "3-byte", chunk: 3, gap: 0 },
  { label: "whole-stream", chunk: Number.POSITIVE_INFINITY, gap: 0 },
  // Interleaved delivery, as a loaded link produces: the gaps stay below the
  // 200 ms idle window so no idle tick falls inside a burst, while a long burst
  // still outlives the 300 ms output window opened by its newline. The gaps do
  // accumulate into timer phase (see the comparison below), so this schedule is
  // held to final state only.
  { label: "interleaved", chunk: 2, gap: 100 },
];

// ─── Fixtures ───────────────────────────────────────────────────────────────

interface Fixture {
  label: string;
  index: PlatformIndex;
  commands: Command[];
  steps: Step[];
  /** Golden final state, hand-derived from the platform specs. */
  expected: Sample;
}

/** A minimal stand-in for `<platform>/index.yaml` (only the read fields). */
function platform(
  id: string,
  promptPatterns: Record<string, string>,
  defaultMode: string,
  secretPatterns: string[],
  extra: Record<string, unknown> = {},
): PlatformIndex {
  return {
    id,
    name: id,
    description: "",
    reference_url: "",
    versions: [],
    prompt_patterns: promptPatterns,
    secret_prompt_patterns: secretPatterns,
    default_mode: defaultMode,
    ...extra,
  } as unknown as PlatformIndex;
}

function command(name: string, mode: string, platformId: string): Command {
  return {
    id: `${platformId}:${name}`,
    name,
    mode,
    category: "test",
    description: "",
    usage: name,
    platforms: [platformId],
    aliases: [],
  } as unknown as Command;
}

const BASH_INDEX = platform(
  "linux-bash",
  // knowledge-base/linux-bash/index.yaml — `prompt_patterns: {}`. Bash ships no
  // pattern on purpose: the echo path learns the prompt prefix instead, and
  // passthrough is never armed (it needs at least one pattern).
  {},
  "shell",
  ["^\\[sudo\\] [Pp]assword(?: for [^:]+)?:\\s*$", "^[Pp]assword:\\s*$"],
  { prefix_commands: { sudo: { unlocks: ["shell"], skip_flag_value: ["-u"] } } },
);

const IOSXE_INDEX = platform(
  "cisco-iosxe",
  // knowledge-base/cisco-iosxe/index.yaml (declaration order preserved: the
  // first match wins, and `privileged-exec` cannot match a `(config…)` prompt).
  {
    "user-exec": "^[\\w\\-]+>",
    "privileged-exec": "^[\\w\\-]+#",
    "global-config": "^[\\w\\-]+\\(config\\)#",
    "interface-config": "^[\\w\\-]+\\(config-if\\)#",
    "routing-config": "^[\\w\\-]+\\(config-router\\)#",
    "line-config": "^[\\w\\-]+\\(config-line\\)#",
  },
  "privileged-exec",
  ["^[Pp]assword:\\s*$"],
  { negation_prefix: "no " },
);

const NXOS_INDEX = platform(
  "cisco-nxos",
  // knowledge-base/cisco-nxos/index.yaml — note `privileged-exec` also matches
  // `(config)#`, and it is declared *before* `global-config`, so NX-OS config
  // mode stays `privileged-exec`. The fixture asserts that on purpose.
  {
    "user-exec": "^[\\w\\-]+>$",
    "privileged-exec": "^[\\w\\-]+(?:\\(config\\))?#$",
    "global-config": "^[\\w\\-]+\\(config\\)#$",
    "interface-config": "^[\\w\\-]+\\(config-if\\)#$",
    "routing-config": "^[\\w\\-]+\\(config-router\\)#$",
    "vdc-config": "^[\\w\\-]+\\(config-vdc\\)#$",
  },
  "privileged-exec",
  ["^[Pp]assword:\\s*$"],
  { negation_prefix: "no " },
);

const TMOS_INDEX = platform(
  "f5-tmos",
  // knowledge-base/f5-tmos/index.yaml
  {
    tmsh: "^[\\w\\-]+(?:@\\([\\w\\-\\.]+\\))?\\(tmos(\\.[\\w]+)?\\)#\\s*$",
    bash: "^\\[[\\w\\-\\.@:]+\\S*\\][\\s\\$#]*\\s*$",
  },
  "tmsh",
  [
    "^(?:(?:[Oo]ld|[Cc]urrent|[Nn]ew|[Cc]onfirm|[Rr]e-?[Ee]nter|[Rr]etype) )?[Pp]assword:\\s*$",
    "^[Ee]nter (?:[Nn]ew )?[Pp]assword:\\s*$",
  ],
  { prefix_commands: { tmsh: { unlocks: ["tmsh"] } } },
);

/**
 * linux-bash: no prompt patterns, so mode never changes and passthrough never
 * arms — the fixture's coverage is the learned-prompt echo re-sync and the
 * secret-recovery heuristic, not a mode transition.
 */
const LINUX_BASH: Fixture = {
  label: "linux-bash",
  index: BASH_INDEX,
  commands: [command("df -h", "shell", "linux-bash"), command("journalctl -u nginx", "shell", "linux-bash")],
  steps: [
    // Banner as a single event: OSC window title (BEL-terminated) then an SGR
    // colour run, then the prompt, which ends in a space.
    out("\x1b]0;lab-bash\x07\x1b[32mlab-bash ready\x1b[0m\r\n[lab@lab-bash ~]$ "),
    // Quiet window: nothing can be detected here, and the 300 ms output
    // window opened by the banner closes.
    idle(300),
    // Line editing: `dff`, erase the extra `f` (devices echo `\b \b`), `-h`.
    type("dff"),
    out("dff"),
    key("\x7f"),
    out("\b \b"),
    type("-h"),
    out("-h"),
    // Left twice (before `h`) and type the missing space; the device repaints
    // CR + prompt + whole buffer. The shadow buffer is untrusted here, so this
    // repaint is reconciled through the tracker's 200 ms settle tick.
    key(...repeat("\x1b[D", 2)),
    type(" "),
    out("\r\n[lab@lab-bash ~]$ df -h"),
    idle(400),
    // Enter, then one df output burst. No prompt pattern matches, and bash
    // never arms passthrough (it needs patterns) — see the expected state.
    key("\r"),
    out("\r\nFilesystem      Size  Used Avail Use% Mounted on\r\n/dev/sda1        40G   12G   26G  32% /\r\n"),
    idle(2100),
    // The shell reprints its prompt. With no patterns and no secret prompt in
    // flight this is not a detection: the prompt count stays 0.
    out("[lab@lab-bash ~]$ "),
    idle(300),
    // `sudo -i` + echo, then the sudo secret prompt.
    type("sudo -i"),
    out("sudo -i"),
    key("\r"),
    out("\r\n[sudo] password for lab: "),
    idle(300),
    // The password is really sent to the remote but must never be buffered.
    type("not-a-real-password"),
    key("\r"),
    // root's prompt differs from every prompt seen so far, so only the
    // secret-recovery heuristic can detect it.
    out("\r\nroot@lab-bash:~# "),
    idle(300),
    // A partial command and its echo; the ghost follows after the debounce.
    type("df"),
    out("df"),
    idle(60),
  ],
  expected: {
    line: "df",
    mode: "shell",
    secret: false,
    passthrough: false,
    receivingOutput: false,
    input: "df",
    ghost: " -h",
    dropdown: true,
    prompts: 1,
    modeChanges: 0,
    secrets: 1,
  },
};

/** cisco-iosxe: user-exec → privileged-exec → global-config → interface-config. */
const CISCO_IOSXE: Fixture = {
  label: "cisco-iosxe",
  index: IOSXE_INDEX,
  commands: [
    command("show ip interface brief", "privileged-exec", "cisco-iosxe"),
    command("show clock", "privileged-exec", "cisco-iosxe"),
    command("interface GigabitEthernet0/1", "global-config", "cisco-iosxe"),
    command("description lab-uplink", "interface-config", "cisco-iosxe"),
    command("ip address 192.0.2.1 255.255.255.0", "interface-config", "cisco-iosxe"),
  ],
  steps: [
    // Banner (OSC title + bold) ending in the user-exec prompt: the tracker
    // starts at `default_mode: privileged-exec`, so this is mode change 1.
    out("\x1b]0;edge-rtr1\x07\x1b[1mEdge Router Lab\x1b[0m - simulated device\r\n\r\nPress RETURN to get started.\r\n\r\nedge-rtr1>"),
    idle(300),
    // "Press RETURN to get started." then the same prompt: a detection with no
    // mode change.
    key("\r"),
    out("\r\nedge-rtr1>"),
    idle(350),
    // Line editing: `showw`, erase the extra `w`, `ver`.
    type("showw"),
    out("showw"),
    key("\x7f"),
    out("\b \b"),
    type("ver"),
    out("ver"),
    // Left three times (before `ver`) and type the missing space; the device
    // repaints CRLF + prompt + whole buffer while the buffer is untrusted.
    key(...repeat("\x1b[D", 3)),
    type(" "),
    out("\r\nedge-rtr1>show ver"),
    idle(400),
    // `show ver` output burst. It arms the 2 s passthrough timer (patterns
    // exist and the burst contains newlines) and the 300 ms output window.
    key("\r"),
    out("\r\nedge-rtr1>show ver\r\nCisco IOS XE Software, Version 17.09.04a\r\nedge-rtr1 uptime is 3 days, 4 hours\r\n"),
    idle(2100),
    // Prompt after the output clears passthrough.
    out("\r\nedge-rtr1>"),
    idle(300),
    // `enable` + its password prompt.
    type("enable"),
    out("enable"),
    key("\r"),
    out("\r\nPassword: "),
    idle(300),
    type("not-a-real-password"),
    key("\r"),
    // Privileged prompt: mode change 2, secret cleared.
    out("\r\nedge-rtr1#"),
    idle(300),
    type("configure terminal"),
    out("configure terminal"),
    key("\r"),
    out("\r\nEnter configuration commands, one per line.  End with CNTL/Z.\r\nedge-rtr1(config)#"),
    idle(300),
    // Mode change 3.
    type("interface GigabitEthernet0/1"),
    out("interface GigabitEthernet0/1"),
    key("\r"),
    out("\r\nedge-rtr1(config-if)#"),
    idle(300),
    // Mode change 4, then a partial command whose ghost comes from the
    // interface-config command set only.
    type("desc"),
    out("desc"),
    idle(60),
  ],
  expected: {
    line: "desc",
    mode: "interface-config",
    secret: false,
    passthrough: false,
    receivingOutput: false,
    input: "desc",
    ghost: "ription lab-uplink",
    dropdown: true,
    prompts: 6,
    modeChanges: 4,
    secrets: 1,
  },
};

/**
 * cisco-nxos: same editing and secret shape as IOS, plus the pattern-order
 * case — `(config)#` matches `privileged-exec` first, so NX-OS config mode is
 * reported as `privileged-exec` and only `(config-if)#` changes the mode.
 */
const CISCO_NXOS: Fixture = {
  label: "cisco-nxos",
  index: NXOS_INDEX,
  commands: [
    command("show interface brief", "privileged-exec", "cisco-nxos"),
    command("show version", "privileged-exec", "cisco-nxos"),
    command("shutdown", "interface-config", "cisco-nxos"),
    command("description lab-uplink", "interface-config", "cisco-nxos"),
  ],
  steps: [
    out("\x1b]0;sw1-lab\x07\r\nCisco Nexus Operating System (NX-OS) Software\r\n\r\nsw1-lab>"),
    idle(300),
    // Line editing: `showw` → `show` → `ver`.
    type("showw"),
    out("showw"),
    key("\x7f"),
    out("\b \b"),
    type("ver"),
    out("ver"),
    key(...repeat("\x1b[D", 3)),
    type(" "),
    out("\r\nsw1-lab>show ver"),
    idle(400),
    key("\r"),
    out("\r\nsw1-lab>show ver\r\nNXOS: version 10.2(4)\r\nsw1-lab uptime is 0 days, 1 hours, 12 minutes\r\n"),
    idle(2100),
    out("\r\nsw1-lab>"),
    idle(300),
    type("enable"),
    out("enable"),
    key("\r"),
    out("\r\nPassword: "),
    idle(300),
    type("not-a-real-password"),
    key("\r"),
    out("\r\nsw1-lab#"),
    idle(300),
    // Mode change 2 (user-exec → privileged-exec).
    type("configure terminal"),
    out("configure terminal"),
    key("\r"),
    // `privileged-exec` is declared before `global-config` and also matches
    // `(config)#`, so this is a prompt detection with NO mode change.
    out("\r\nsw1-lab(config)#"),
    idle(300),
    type("interface Ethernet1/1"),
    out("interface Ethernet1/1"),
    key("\r"),
    out("\r\nsw1-lab(config-if)#"),
    idle(300),
    // Mode change 3.
    type("shut"),
    out("shut"),
    idle(60),
  ],
  expected: {
    line: "shut",
    mode: "interface-config",
    secret: false,
    passthrough: false,
    receivingOutput: false,
    input: "shut",
    ghost: "down",
    dropdown: true,
    prompts: 5,
    modeChanges: 3,
    secrets: 1,
  },
};

/** f5-tmos: starts in tmsh, drops to the bash shell, back to tmsh. */
const F5_TMOS: Fixture = {
  label: "f5-tmos",
  index: TMOS_INDEX,
  commands: [command("show sys version", "tmsh", "f5-tmos"), command("list auth user", "tmsh", "f5-tmos")],
  steps: [
    // Banner ending in the bash prompt: `default_mode` is tmsh, so mode
    // change 1.
    out("\x1b]0;lb1-lab\x07\x1b[1mBIG-IP TMOS 17.0.0 lab device\x1b[0m\r\nLast login: lab console\r\n[admin@lb1:Active:Standalone] #"),
    idle(300),
    // Line editing in bash: `lss` → `ls` → `ls-l`.
    type("lss"),
    out("lss"),
    key("\x7f"),
    out("\b \b"),
    type("-l"),
    out("-l"),
    key(...repeat("\x1b[D", 2)),
    type(" "),
    out("\r\n[admin@lb1:Active:Standalone] # ls -l"),
    idle(400),
    key("\r"),
    out("\r\n[admin@lb1:Active:Standalone] # ls -l\r\ntotal 8\r\ndrwxr-xr-x 2 admin admin 4096 Jan  1 00:00 config\r\n"),
    idle(2100),
    out("\r\n[admin@lb1:Active:Standalone] # "),
    idle(300),
    // Back to tmsh — the mode change the fixture covers.
    type("tmsh"),
    out("tmsh"),
    key("\r"),
    out("\r\nadmin(tmos)# "),
    idle(300),
    // Mode change 2 (bash → tmsh).
    type("modify auth user admin password"),
    out("modify auth user admin password"),
    key("\r"),
    // Secret detection 1.
    out("\r\nEnter new password: "),
    idle(300),
    type("not-a-real-password"),
    key("\r"),
    // The confirmation prompt matches the same secret regex set, and the
    // tracker is already in the secret state — no second detection fires.
    out("\r\nRe-enter password: "),
    idle(300),
    type("not-a-real-password"),
    key("\r"),
    // tmsh prompt: same mode, secret cleared, prompt count 4.
    out("\r\nadmin(tmos)# "),
    idle(300),
    type("show sys"),
    out("show sys"),
    idle(60),
  ],
  expected: {
    line: "show sys",
    mode: "tmsh",
    secret: false,
    passthrough: false,
    receivingOutput: false,
    input: "show sys",
    ghost: " version",
    dropdown: true,
    prompts: 4,
    modeChanges: 2,
    secrets: 1,
  },
};

const FIXTURES: ReadonlyArray<Fixture> = [LINUX_BASH, CISCO_IOSXE, CISCO_NXOS, F5_TMOS];

// ─── Replay ─────────────────────────────────────────────────────────────────

function terminalStub(): Terminal {
  return {
    write: vi.fn(),
    buffer: { active: { cursorX: 0, cursorY: 0 } },
    rows: 10,
    cols: 80,
    options: {},
  } as unknown as Terminal;
}

const cleanups: Array<() => void> = [];

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
  vi.useRealTimers();
});

interface ReplayResult {
  samples: Sample[];
  sent: string[];
}

/**
 * Replay one fixture through the production wiring (`terminal-view.ts`) under
 * the given schedule, sampling the observable state after every step.
 */
function replay(fixture: Fixture, schedule: Schedule): ReplayResult {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const ghost = new GhostText(terminalStub(), container);

  const samples: Sample[] = [];
  const sent: string[] = [];
  // Mirrors of the tracker's private state, updated only from its callbacks.
  let mode = fixture.index.default_mode;
  let secret = false;
  let prompts = 0;
  let modeChanges = 0;
  let secrets = 0;

  let controller!: SuggestionController;
  const dropdown = new Dropdown(container, (command, payload) => controller.acceptFromDropdown(command, payload));
  const tracker = new LineTracker(
    (next) => {
      mode = next;
      modeChanges++;
      controller.setMode(next);
    },
    () => {
      prompts++;
      secret = false;
      controller.onPromptDetected();
    },
    () => {
      secrets++;
      secret = true;
      controller.onSecretPromptDetected();
    },
  );

  controller = new SuggestionController({
    send: (data) => {
      sent.push(data);
    },
    tracker,
    ghost: () => ghost,
    dropdown: () => dropdown,
    sidebar: { detail: () => {}, placeholder: () => {} },
    ui: { isSidebarOpen: () => false, dismissSidebar: () => {}, toggleSuggestions: () => {} },
  });

  tracker.loadPatterns(
    fixture.index.prompt_patterns,
    fixture.index.default_mode,
    fixture.index.secret_prompt_patterns ?? [],
  );
  controller.setPlatformIndex(fixture.index);
  controller.loadCommands(fixture.commands, fixture.index.id, fixture.index.negation_prefix ?? null);
  controller.setConnected(true);
  controller.setSuggestionsEnabled(true);
  controller.setMode(fixture.index.default_mode);

  const decoder = new StreamingTextDecoder();
  decoder.reset();

  const sample = (): Sample => ({
    line: tracker.currentLine,
    mode,
    secret,
    passthrough: tracker.isPassthrough,
    receivingOutput: controller.isReceivingOutput,
    input: controller.input,
    ghost: ghost.isShowing() ? ghost.getCurrentRemainder() : null,
    dropdown: dropdown.isVisible(),
    prompts,
    modeChanges,
    secrets,
  });

  // Bytes → decoder → controller.onOutput, exactly as the ssh-output listener
  // does. Empty decodes are forwarded too: a chunk holding half a codepoint
  // decodes to "" and the production listener still calls onOutput with it,
  // which re-arms the tracker's idle timer.
  const feed = (text: string) => {
    const bytes = new TextEncoder().encode(text);
    for (let offset = 0; offset < bytes.length; offset += schedule.chunk) {
      if (offset > 0 && schedule.gap > 0) vi.advanceTimersByTime(schedule.gap);
      controller.onOutput(decoder.decode(bytes.slice(offset, offset + schedule.chunk)).text);
    }
  };

  for (const step of fixture.steps) {
    switch (step.kind) {
      case "type":
        for (const ch of step.text) controller.keyIn(ch);
        break;
      case "key":
        for (const seq of step.keys) controller.keyIn(seq);
        break;
      case "out":
        feed(step.text);
        break;
      case "idle":
        vi.advanceTimersByTime(step.ms);
        break;
    }
    samples.push(sample());
  }

  controller.dispose();
  ghost.destroy();
  dropdown.destroy();
  container.remove();

  return { samples, sent };
}

function replayAllSchedules(fixture: Fixture): Array<Schedule & ReplayResult> {
  return SCHEDULES.map((schedule) => ({ ...schedule, ...replay(fixture, schedule) }));
}

/**
 * Indices of the samples taken immediately after a quiet window long enough to
 * fire both the 200 ms idle tick and the 300 ms output window. Every timer the
 * output path schedules has fired by then, so the full observable state — not
 * just the tracker's — has to agree across schedules at these points.
 */
const SETTLE_MS = 300;

function checkpoints(fixture: Fixture): number[] {
  const indices: number[] = [];
  fixture.steps.forEach((step, index) => {
    if (step.kind === "idle" && step.ms >= SETTLE_MS) indices.push(index);
  });
  return indices;
}

// ─── Schedule invariance ────────────────────────────────────────────────────

describe("stream replay — chunking schedules are equivalent", () => {
  for (const fixture of FIXTURES) {
    it(`${fixture.label} reaches the same state under every schedule`, () => {
      const runs = replayAllSchedules(fixture);
      // Whole-stream is the reference: it is the only schedule that is also
      // the natural single write the SSH layer would deliver.
      const byteRuns = runs.filter((run) => run.gap === 0);
      const baseline = byteRuns[byteRuns.length - 1];
      const settled = checkpoints(fixture);

      for (const run of runs) {
        expect(run.samples.length, `${run.label} step count`).toBe(baseline.samples.length);
        // A schedule that also moves the clock changes timer phase, not just
        // chunking: its 2 s passthrough window expires at a different byte
        // offset, and while passthrough holds the echo re-sync is suppressed by
        // design. Only its final state is required to agree — the same rule the
        // issue sets for any schedule that changes idle timing. The mid-burst
        // settle bug this matrix targets is regressed by the fake-timer tests in
        // suggestion-controller.test.ts, which pin the exact timings.
        if (run.gap === 0) {
          for (let i = 0; i < baseline.samples.length; i++) {
            // Tracker-owned state must agree at every step: it is derived from
            // the whole char stream, so no schedule may see a different value.
            expect(pick(run.samples[i], TRACKER_FIELDS), `${run.label} step ${i}`).toEqual(
              pick(baseline.samples[i], TRACKER_FIELDS),
            );
          }
          for (const i of settled) {
            expect(pick(run.samples[i], ALL_FIELDS), `${run.label} settled step ${i}`).toEqual(
              pick(baseline.samples[i], ALL_FIELDS),
            );
          }
        }
        // The keystroke path is schedule-independent by construction; asserting
        // it keeps a stray interception (Tab, Ctrl+W) from hiding in a fixture.
        expect(run.sent.join("|"), `${run.label} sent bytes`).toBe(baseline.sent.join("|"));
      }

      for (const run of runs) {
        const last = run.samples[run.samples.length - 1];
        // Golden final state per schedule, so five identically wrong runs
        // cannot agree their way to a pass.
        expect(pick(last, ALL_FIELDS), `${run.label} final state`).toEqual(fixture.expected);
      }
    });
  }
});

// ─── Explicit sequence splits ───────────────────────────────────────────────

interface SplitResult {
  decoded: string;
  line: string;
}

/**
 * Feed `sample` through the real decoder + stripper + char walk, cutting the
 * byte stream at `cuts`. No prompt or secret patterns are loaded: this isolates
 * the decode / ANSI-strip / line-reconstruction layers, where a split must be
 * invisible.
 */
function replaySplit(sample: string, cuts: readonly number[]): SplitResult {
  const tracker = new LineTracker(
    () => {},
    () => {},
    () => {},
  );
  tracker.loadPatterns({}, "shell", []);
  const decoder = new StreamingTextDecoder();
  const bytes = new TextEncoder().encode(sample);
  const bounds = [0, ...[...cuts].sort((a, b) => a - b), bytes.length];
  let decoded = "";
  for (let i = 1; i < bounds.length; i++) {
    const text = decoder.decode(bytes.slice(bounds[i - 1], bounds[i])).text;
    decoded += text;
    if (text) tracker.feed(text);
  }
  vi.clearAllTimers();
  return { decoded, line: tracker.currentLine };
}

/** Every two-chunk split of the whole byte stream must agree with no split. */
function expectEverySplitEquivalent(sample: string) {
  const whole = replaySplit(sample, []);
  expect(whole.decoded).not.toContain("\uFFFD");
  expect(whole.line).not.toContain("\uFFFD");

  const length = new TextEncoder().encode(sample).length;
  for (let at = 0; at <= length; at++) {
    const split = replaySplit(sample, [at]);
    expect(split.decoded, `decode diverged on a cut at byte ${at}`).toBe(whole.decoded);
    expect(split.line, `line diverged on a cut at byte ${at}`).toBe(whole.line);
  }
}

describe("stream replay — sequence splits", () => {
  it("splits a CSI sequence at ESC/[, inside the parameters and at its final byte", () => {
    // One SGR run and one cursor-to-BOL erase, the pair a line repaint uses.
    const sample = "\x1b[38;5;208mwarn\x1b[0m\r\nedge-rtr1>show\r\x1b[1Kedge-rtr1>show ver";
    const sgr = sample.indexOf("\x1b");
    const erase = sample.indexOf("\x1b[1K");

    const cuts = [
      sgr + 1, // between ESC and "[" — the state the stripper must hold
      sgr + 3, // inside the SGR parameters
      sample.indexOf("m", sgr), // at the SGR final byte
      erase + 1, // ESC/"[" again, inside a repaint
      sample.lastIndexOf("K"), // at the erase's final byte
    ];

    for (const at of cuts) {
      const whole = replaySplit(sample, []);
      const split = replaySplit(sample, [at]);
      expect(split.decoded, `cut at byte ${at}`).toBe(whole.decoded);
      expect(split.line, `cut at byte ${at}`).toBe(whole.line);
    }

    const whole = replaySplit(sample, []);
    expect(whole.line).toBe("edge-rtr1>show ver");
    expect(whole.decoded).toContain("\x1b[1K");
    expectEverySplitEquivalent(sample);
  });

  it("splits an OSC sequence in the payload, at the BEL terminator and between ESC and \\", () => {
    // BEL-terminated (window title) — the terminator pair itself split too.
    const bel = "\x1b]0;edge-rtr1-lab\x07edge-rtr1>";
    const belCuts = [bel.indexOf("\x1b") + 1, bel.indexOf(";") + 4, bel.indexOf("\x07"), bel.indexOf("\x07") + 1];
    expect(replaySplit(bel, []).line).toBe("edge-rtr1>");

    // ST-terminated (`ESC \\`), with the two characters of the terminator in
    // different chunks — the case a whole-stream stripper never sees.
    const st = "\x1b]2;lab console\x1b\\after\r\nedge-rtr1#";
    const stTerminator = st.indexOf("\x1b\\");
    const stCuts = [st.indexOf(";") + 2, stTerminator, stTerminator + 1, stTerminator + 2];
    expect(replaySplit(st, []).line).toBe("edge-rtr1#");

    for (const [sample, cuts] of [
      [bel, belCuts] as const,
      [st, stCuts] as const,
    ]) {
      const whole = replaySplit(sample, []);
      for (const at of cuts) {
        const split = replaySplit(sample, [at]);
        expect(split.decoded, `cut at byte ${at}`).toBe(whole.decoded);
        expect(split.line, `cut at byte ${at}`).toBe(whole.line);
      }
      expectEverySplitEquivalent(sample);
    }
  });

  it("splits inside 2-, 3- and 4-byte UTF-8 codepoints", () => {
    const two = "\u00e9"; // U+00E9 — 2 bytes
    const three = "\u20ac"; // U+20AC — 3 bytes
    const four = "\u{1F600}"; // U+1F600 — 4 bytes
    const sample = `\r\nlab-${two}${three}${four}`;
    const prefix = new TextEncoder().encode("\r\nlab-").length;

    const cuts = [
      prefix + 1, // inside the 2-byte form
      prefix + 2 + 1, // inside the 3-byte form
      prefix + 2 + 2,
      prefix + 2 + 3 + 1, // inside the 4-byte form
      prefix + 2 + 3 + 2,
      prefix + 2 + 3 + 3,
    ];

    const whole = replaySplit(sample, []);
    expect(whole.line).toBe(`lab-${two}${three}${four}`);
    for (const at of cuts) {
      const split = replaySplit(sample, [at]);
      expect(split.decoded, `cut at byte ${at}`).toBe(whole.decoded);
      expect(split.line, `cut at byte ${at}`).toBe(whole.line);
    }
    expectEverySplitEquivalent(sample);
  });
});

// ─── The idle rule ──────────────────────────────────────────────────────────

describe("stream replay — the 200 ms idle rule", () => {
  function idleTracker() {
    let prompts = 0;
    let secrets = 0;
    let settled = 0;
    const tracker = new LineTracker(
      () => {},
      () => {
        prompts++;
      },
      () => {
        secrets++;
      },
    );
    tracker.setSettledListener(() => {
      settled++;
    });
    tracker.loadPatterns(IOSXE_INDEX.prompt_patterns, IOSXE_INDEX.default_mode, ["^[Pp]assword:\\s*$"]);
    return { tracker, counts: () => ({ prompts, secrets, settled }) };
  }

  it("detects a prompt only after 200 ms of quiet", () => {
    const { tracker, counts } = idleTracker();
    tracker.feed("\r\nedge-rtr1>");

    vi.advanceTimersByTime(199);
    expect(counts().prompts).toBe(0);

    // The chunk that completes the prompt arrives one ms before the deadline,
    // and detection happens on that tick — not on arrival.
    vi.advanceTimersByTime(1);
    expect(counts().prompts).toBe(1);
  });

  it("re-arms the idle window on every chunk", () => {
    const { tracker, counts } = idleTracker();
    tracker.feed("edge-rtr1");
    vi.advanceTimersByTime(150);
    tracker.feed(">");

    // 349 ms after the first chunk, 199 ms after the last: still quiet.
    vi.advanceTimersByTime(199);
    expect(counts().prompts).toBe(0);

    vi.advanceTimersByTime(1);
    expect(counts().prompts).toBe(1);
  });

  it("fires the settle listener on the idle tick, after the prompt check", () => {
    const order: string[] = [];
    const tracker = new LineTracker(
      () => {},
      () => order.push("prompt"),
      () => {},
    );
    tracker.setSettledListener(() => order.push("settled"));
    tracker.loadPatterns(IOSXE_INDEX.prompt_patterns, IOSXE_INDEX.default_mode, []);

    tracker.feed("\r\nedge-rtr1>");
    vi.advanceTimersByTime(199);
    expect(order).toEqual([]);

    // The consumer must see the state the prompt check produced (the reset
    // that clears its untrusted-buffer flag), so the order is not incidental.
    vi.advanceTimersByTime(1);
    expect(order).toEqual(["prompt", "settled"]);
  });

  it("fires the settle listener once per idle window, not once per chunk", () => {
    const { tracker, counts } = idleTracker();
    tracker.feed("\r\nedge-rtr1");
    vi.advanceTimersByTime(150);
    tracker.feed(">");
    vi.advanceTimersByTime(199);
    expect(counts().settled).toBe(0);

    // Both chunks belong to one burst: one tick, one settle.
    vi.advanceTimersByTime(1);
    expect(counts().settled).toBe(1);

    tracker.feed("show ver");
    vi.advanceTimersByTime(199);
    expect(counts().settled).toBe(1);
    vi.advanceTimersByTime(1);
    expect(counts().settled).toBe(2);
  });

  it("raises a secret prompt synchronously, without waiting for the idle tick", () => {
    const { tracker, counts } = idleTracker();
    tracker.feed("\r\nPassword: ");
    // Buffering the first password character before the next tick would leak
    // it into the shadow buffer, so this one cannot be idle-gated.
    expect(counts().secrets).toBe(1);
    expect(counts().prompts).toBe(0);
  });
});
