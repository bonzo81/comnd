/**
 * Per-platform highlighting rules for terminal output.
 *
 * Derived from a real-world MobaXterm custom syntax config (Cisco rules)
 * plus common network/Unix patterns. See docs/plan-terminal-output-highlighting.md.
 *
 * Rules are deliberately conservative — high signal, low false-positive.
 * Boundary convention: MobaXterm-style `[^A-Za-z0-9]` char classes (more
 * permissive than `\b`; treats parens, brackets, slashes as boundaries,
 * which correctly matches Cisco output like `GigabitEthernet0/0/0(is up)`).
 *
 * Platform keys match knowledge-base/ directory names exactly:
 * "cisco-iosxe", "cisco-nxos", "f5-tmos", "linux-bash".
 */

import { AnsiColor } from "./highlight-palette";

export interface HighlightRule {
  pattern: RegExp;
  color: AnsiColor;
  priority?: number;
}

const L = "(?:^|[^A-Za-z0-9])";
const R = "(?=$|[^A-Za-z0-9])";

const gi = "gi";

const COMMON_RULES: HighlightRule[] = [
  // Addresses / identifiers → yellow
  {
    pattern: new RegExp(
      `${L}(?:[1-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-4])\\.[0-9]+\\.[0-9]+\\.[0-9]+${R}`,
      gi,
    ),
    color: "yellow",
    priority: 10,
  },
  {
    pattern: new RegExp(`${L}(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F:]+${R}`, gi),
    color: "yellow",
    priority: 10,
  },
  {
    pattern: new RegExp(
      `${L}[0-9a-fA-F]{2}(?::|-)[0-9a-fA-F]{2}(?::|-)[0-9a-fA-F]{2}(?::|-)[0-9a-fA-F]{2}(?::|-)[0-9a-fA-F]{2}(?::|-)[0-9a-fA-F]{2}${R}`,
      gi,
    ),
    color: "yellow",
    priority: 10,
  },
  { pattern: new RegExp(`${L}localhost${R}`, gi), color: "yellow", priority: 10 },

  // URLs → blue (underline in MobaXterm; ANSI 4 not in palette v1)
  {
    pattern: new RegExp(`https?://[A-Za-z0-9_.:/&?=%~#{}()@+-]+`, gi),
    color: "blue",
    priority: 15,
  },

  // Negative status → red
  {
    pattern: new RegExp(
      `${L}(?:disabled|unknown|fault|shutdown|disconnected|error|failed|denied|not permitted|disallowed|not allowed|refused|problem|failure|notconnect|down|invalid|unreachable|blocked|inactive|stopped)${R}`,
      gi,
    ),
    color: "red",
    priority: 20,
  },

  // Cisco log prefix → red
  {
    pattern: new RegExp(`^%[A-Z]+-[0-9]+-[A-Z_]+`, "i"),
    color: "red",
    priority: 19,
  },

  // Warning → orange
  {
    pattern: new RegExp(`${L}(?:warn(?:ing)?|degraded)${R}`, gi),
    color: "orange",
    priority: 21,
  },

  // Positive status → green
  {
    pattern: new RegExp(
      `${L}(?:enabled|connected|up|yes|ok|active|running|established|reachable)${R}`,
      gi,
    ),
    color: "green",
    priority: 22,
  },
];

const CISCO_RULES: HighlightRule[] = [
  // `!` comment lines → blue
  { pattern: /^!.*$/, color: "blue", priority: 5 },

  // Config description/identity lines → green
  {
    pattern: new RegExp(`^(?:description|hostname|nameif|version)\\s.+`, "i"),
    color: "green",
    priority: 5,
  },

  // `no` negation prefix → red
  { pattern: /^no\s/i, color: "red", priority: 5 },

  // Interface names → yellow (MobaXterm: [a-z]+thernet|gi + long forms)
  {
    pattern: new RegExp(
      `${L}(?:[a-z]+thernet|gi|tengige|tengigabitethernet|loopback|tunnel|port-channel|management)[0-9]+(?:/[0-9]+)*`,
      gi,
    ),
    color: "yellow",
    priority: 8,
  },

  // VLAN → yellow (higher priority than interface)
  { pattern: new RegExp(`${L}[Vv]lan[0-9]+${R}`, gi), color: "yellow", priority: 7 },

  // ACL deny → red (priority over permit's yellow)
  { pattern: new RegExp(`${L}deny${R}`, gi), color: "red", priority: 12 },
  // ACL permit → yellow
  { pattern: new RegExp(`${L}permit${R}`, gi), color: "yellow", priority: 13 },

  // Config keywords → magenta (MobaXterm magenta set)
  {
    pattern: new RegExp(
      `${L}(?:policy-map|class|global|logging(?:\\s+event)?|(?:allocate-)?interface|failover|static|security-level|service(?:-policy)?|spanning-tree|switchport)${R}`,
      gi,
    ),
    color: "magenta",
    priority: 14,
  },

  // Command/output keywords → cyan (MobaXterm cyan set)
  {
    pattern: new RegExp(
      `${L}(?:%link-[0-9]+-updown|(?:allowed\\s+)?(?:private-)?vlan(?:-range)?|route|access-(?:list|group)|port-forward|mtu|show|encapsulation|rate-limit|speed|duplex|autoneg|snmp-server|media-type|ip(?:\\s+address)?|monitor(?:\\s+session)?)${R}`,
      gi,
    ),
    color: "cyan",
    priority: 14,
  },
];

const LINUX_RULES: HighlightRule[] = [
  // `#` comment lines → green (MobaXterm Unix shell). Legit in output:
  // /etc/os-release, /etc/hostname, shell scripts cat'd to terminal.
  { pattern: /^#.*$/, color: "green", priority: 5 },

  // File paths → blue
  { pattern: /(?:^|\s)(\/(?:[a-zA-Z0-9._-]+\/)+[a-zA-Z0-9._-]+)/, color: "blue", priority: 10 },
  { pattern: /(?:^|\s)(~\/[a-zA-Z0-9._/-]+)/, color: "blue", priority: 10 },
  // /dev/null → blue (MobaXterm)
  { pattern: new RegExp(`${L}/dev/null${R}`, gi), color: "blue", priority: 9 },

  // Shell variable expansions → yellow (MobaXterm Unix shell). These appear
  // in real output: env dumps, error messages referencing $VAR, heredocs.
  // $VAR, ${VAR}, $[expr], $((expr)), $?, $@, $$
  { pattern: /\$\(\([^()]+\)\)/, color: "yellow", priority: 11 },
  { pattern: /\$\{[^}]+\}/, color: "yellow", priority: 11 },
  { pattern: /\$\[[^\]]+\]/, color: "yellow", priority: 11 },
  { pattern: /\$[?@\$]/, color: "yellow", priority: 11 },
  { pattern: /\$[A-Za-z_][A-Za-z_0-9]*/, color: "yellow", priority: 11 },

  // Command substitution $(...) → red (MobaXterm Unix shell). Appears in
  // output when scripts are cat'd or in PS1-style prompt output.
  { pattern: /\$\([^()]+\)/, color: "red", priority: 12 },
  // Backtick command substitution → red
  { pattern: /`[^`]+`/, color: "red", priority: 12 },

  // Logical operators || && → blue (MobaXterm). Appear in output of
  // `type`/`alias` commands and script listings.
  { pattern: /\|\|/, color: "blue", priority: 13 },
  { pattern: /&&/, color: "blue", priority: 13 },

  // Man page section header → bold
  { pattern: /^[A-Z][A-Z ]+$/, color: "bold", priority: 5 },

  // NOTE: Shell control-flow keywords (for/while/if/then/else/case/etc.) and
  // builtins (echo/printf/export/etc.) are NOT highlighted. They belong to
  // shell SOURCE highlighting (MobaXterm colors typed input too). In our
  // output-only gate they false-positive on prose: "if" in ifconfig, "for"
  // in log messages, "echo" in command help text. Removed deliberately.
];

const F5_RULES: HighlightRule[] = [
  // Pool/member status
  {
    pattern: new RegExp(`${L}(?:available|active)${R}`, gi),
    color: "green",
    priority: 20,
  },
  // (down/disabled handled by COMMON_RULES red set)

  // tmsh/config paths → blue
  { pattern: /(?:^|\s)(\/(?:usr\/)?(?:local\/)?(?:config|var)\/[a-zA-Z0-9._/-]+)/, color: "blue", priority: 10 },
];

export const HIGHLIGHT_RULES: Record<string, HighlightRule[]> = {
  "cisco-iosxe": [...CISCO_RULES, ...COMMON_RULES],
  "cisco-nxos": [...CISCO_RULES, ...COMMON_RULES],
  "f5-tmos": [...F5_RULES, ...COMMON_RULES],
  "linux-bash": [...LINUX_RULES, ...COMMON_RULES],
};