# Suggestion Engine

## Behaviour

* Triggers as user types in the terminal input line
* Queries the local knowledge base filtered by: platform ID + OS version + **current CLI mode**
* Shows top N matching commands as ghost text (accept with Tab) or dropdown (navigate with arrow keys)
* Side panel (when open) updates in real time to show detail of the highlighted suggestion
* Suggestions are prefix-matched and ranked by frequency/relevance (simple scoring, no ML)

## Mode Detection (MVP)

The terminal monitors each line of output and parses the prompt to determine current CLI mode. Mode is used to filter suggestions to only those valid for the current context.

**Cisco IOS / IOS-XE prompt patterns:**

| Prompt pattern | Mode |
|----------------|------|
| `hostname>`    | user-exec |
| `hostname#`    | privileged-exec |
| `hostname(config)#` | global-config |
| `hostname(config-if)#` | interface-config |
| `hostname(config-router)#` | routing-config |
| `hostname(config-line)#` | line-config |

**Cisco NX-OS prompt patterns:**

| Prompt pattern | Mode |
|----------------|------|
| `hostname#`    | privileged-exec |
| `hostname(config)#` | global-config |
| `hostname(config-if)#` | interface-config |
| `hostname(config-router)#` | routing-config |

**F5 BIG-IP TMOS prompt patterns:**

| Prompt pattern | Mode |
|----------------|------|
| `user@(hostname)(cfg-sync ...)(/partition)(tmos)#` | tmsh root |
| `user@(hostname)(cfg-sync ...)(tmos.ltm)#` | ltm context |
| `user@(hostname)(cfg-sync ...)(tmos.net)#` | net context |
| `user@(hostname)(cfg-sync ...)(tmos.sys)#` | sys context |
| `hostname:~$` or `[user@hostname:Active:...]` | bash shell |

F5 prompt parsing is more complex — the prompt contains cluster sync state, partition, and context path. MVP approach: match on the `(tmos` substring to detect tmsh vs bash, and extract the context path (e.g. `.ltm`, `.net`) for mode filtering. Exact regex defined in `index.yaml`.

**Linux bash:**

Bash prompts are user-configurable (`PS1`) and cannot be reliably parsed for mode. MVP approach:

* Default mode: `shell` (all commands shown)
* No sub-mode detection (e.g. inside vim, python REPL, etc.)
* If the app detects a non-prompt interactive context (rapid output, no recognisable prompt), suggestions are disabled (raw pass-through mode)

Other platforms define their own prompt patterns in `index.yaml`. If mode cannot be determined, suggestions default to showing all commands for the platform (unfiltered).

## Suggestion UI

Two complementary suggestion modes, matching modern IDE behaviour (e.g. VS Code):

**Ghost text (primary)**

* Top matching command appears as greyed-out text inline after the cursor
* Accept with `Tab`
* Always visible while typing — zero disruption

**Dropdown (toggleable auto-show)**

* Off by default. Enabled via the lightbulb button in the terminal toolbar or `Ctrl+Space` (both toggle the same persisted state)
* When enabled, shows top N matches as a popup list below the cursor automatically while typing
* Navigate with arrow keys, accept with `Tab` (`Enter` always submits to the remote)
* Dismiss with `Escape`; disabling the toggle hides it immediately

Both update in real time as the user types, filtered by platform + version + current mode.

## Suggestion Sources (MVP)

* Local knowledge base only
* Filtered by: platform ID + OS version (or all versions if unspecified)

## Suggestion Sources (Post-MVP)

* Command history (per host)
* AI/LLM layer (optional, user-enabled)
