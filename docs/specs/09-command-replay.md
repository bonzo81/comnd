# netssh — Command Replay

**Version:** 0.1 (draft) **Status:** In progress **Author:** Andy Norwood (architect) **Last updated:** 2026-09-03

---

## Intent: Knowledge Base vs Command Replay

netssh has two distinct command stores. They look similar (both surface commands into the terminal) but serve different purposes:

| | **Knowledge Base (KB)** | **Command Replay** |
|---|---|---|
| Who creates it | App authors (shipped with app) | The user |
| What it is | Curated reference of *valid syntax* per platform — canonical commands, descriptions, examples | The user's own *working commands* — the ones they actually run, saved for reuse |
| Question it answers | "What is the correct syntax for X on this platform?" | "How did I run that last time?" |
| Where it lives | `knowledge-base/<platform>/commands/*.yaml`, read-only, shipped with install | User data directory, user-editable, starts empty |
| How it's used | Ghost text suggestions as the user types in the terminal | Side panel list with a **Play** button that inserts the command into the terminal |
| Variables | Static reference text (examples may show placeholders, but they are documentation) | Named variables (`interface-name`, `acl-name`) captured at save time and prompted for at play time |
| Platform binding | Fixed per YAML file | Assigned per command at save time, changeable by the user |

In short: the **KB teaches**, **Command Replay remembers**. Both exist from day one — the KB is populated but a work in progress; Command Replay is empty until the user fills it.

---

## Capturing Commands

Two ways to save a command to Command Replay:

1. **Manually** — in the Command Replay section, the user adds a command by typing it (and names its variables, if any).
2. **From the terminal** — the user selects text in the terminal, right-clicks, and chooses **Add to Command Replay**.

In both cases a save modal opens confirming the command text. In the modal the user can:

- **Mark variables** — highlight the portion of the command that is a variable (e.g. an interface name or ACL name) and give it a name. The command is saved knowing the offsets of each variable.
- **Assign a platform** — pre-filled from the current session's detected platform where available, but always changeable by the user.
- Click **Save**.

## Playing Commands

While working in a terminal, the side panel (which currently shows KB entries) becomes switchable between **Knowledge Base** and **Command Replay** views.

- Each Command Replay item shows a **Play** button.
- Clicking Play with no variables inserts the command into the terminal immediately.
- If the command has variables, a dialog first prompts for a value per variable, then inserts the completed command into the terminal.

Insertion means typing into the terminal via the normal keystroke path (same as keyboard input) — the shadow buffer observes it like any other input. The command is **not** auto-executed; the user reviews and presses Enter themselves.

---

## Open Questions

* Storage format for Command Replay (JSON in user data dir, following host storage patterns?)
* Sharing/export of replay sets between machines or teammates (post-MVP)
* Whether replay items can be sequences (multiple commands) — see roadmap "Command snippets"
* Editing an existing replay item (re-open the same variable-marking modal?)
