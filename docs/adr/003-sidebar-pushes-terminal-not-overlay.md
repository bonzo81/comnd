# 003. Sidebar pushes the terminal — it does not overlay it

Date: 2026-10-02
Status: Accepted

## Context
The side panel and terminal share the window (AGENTS.md rule 4). The terminal must render at its true width so wrapped lines stay correct, which requires a real PTY resize when the panel opens/closes (`src/components/terminal-view`, `nav-panel`).

## Options
- **Overlay panel on top of the terminal.** Cost: terminal clipped/hidden; PTY width unchanged → wrapped lines wrong.
- **Push (resize) the terminal**, triggering a PTY resize on open/close. Cost: layout reflow; must coordinate the resize with panel animation and output re-sync.

## Decision
The side panel resizes (pushes) the terminal and does not overlay it. The terminal receives a PTY resize when the sidebar opens or closes.

## Consequences
- Easier: terminal always renders at true width; wrapped output stays correct; PTY stays in sync with visible columns.
- Harder: open/close triggers a PTY resize + reflow; must be coordinated with animation and output re-sync.
- Rules out: floating/overlay panels over the terminal; fixed-width terminal with side chrome.

## Amendment 2026-11 (issue #176, side panel undock)

The panel may leave the app window for its own OS window. That is not an overlay — it is the limit case of "push": the panel stops taking window width at all, so the terminal is laid out at the full window width and the PTY is resized to match, through the same fit → `ssh_resize` path that opening a docked panel already uses. Docking restores the panel and the terminal narrows again; the docked layout is unchanged.

So the rule above still holds in a stronger form: the panel and the terminal never overlap, whether the panel is docked beside the terminal or undocked into a separate window. Nothing floats inside the app window, and no terminal tab detaches — only the panel has a window, and only one of them exists at a time.
