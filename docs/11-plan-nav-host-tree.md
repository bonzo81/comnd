# Plan: Nav-Panel Host Tree + Recent Sessions Content

Follow-up to `10-plan-nav-panel-redesign.md`. Currently the nav panel holds only the
group tree + search box; the host list lives in the content area. This plan moves
hosts into the nav tree (under their group) and turns the content area into a
"recent sessions" list.

## Target behavior

```
┌──────────────┬──────────────────────────────────────────┐
│ NAV PANEL    │  Content area                            │
│ (240px)      │                                          │
│ [New Conn]   │  RECENT SESSIONS                         │
│ [search…]    │  ┌────────────────────────────────────┐  │
│ ▾ All Hosts  │  │ sw-dc1-router   2h ago  [IOS]     │  │
│   ▾ Production│ │ sw-dc2-switch   5h ago  [NXOS]    │  │
│     sw-dc1   │  │ rtr-edge-1      1d ago  [IOS]     │  │
│     sw-dc2   │  │ … (last_connected desc)           │  │
│   ▸ Staging  │  └────────────────────────────────────┘  │
│     sw-dc3   │                                          │
│ ▸ Dev        │                                          │
│   sw-dc4     │                                          │
└──────────────┴──────────────────────────────────────────┘
```

- Nav panel: group tree **with hosts nested under their group**. Unassigned hosts
  (`group_id === null`) render under a pseudo "Ungrouped" node at top level.
- Content area: **recent sessions** = hosts with `last_connected != null`, sorted
  desc. Always global (ignores group selection).
- Group click = expand/collapse **only**. No content-area filtering by group.
- Host click = select (highlight). Double-click / Enter = connect.
- Search (nav panel) = all hosts, ignores group selection, filters the tree in
  place (show matching hosts + ancestor groups, hide the rest).

## Decisions (confirmed)

| Question | Decision |
|---|---|
| Group selection effect | Expand/collapse tree only. No content-area filter. |
| Recent list scope | Recently connected hosts (`last_connected` desc). No new backend. |
| Search scope | All hosts, ignores group selection, filters tree in place. |
| Group actions (add host, add subgroup, delete) | Stay on tree rows (hover actions). |
| Move host to group | Drag host row onto a group row. No context-menu "Move to group". |
| Restructure groups | Drag group row onto another group row (reparent) or onto root (ungroup). |
| Ungrouped hosts | Pseudo "Ungrouped" node at top level of tree. |

## Files touched

### 1. `src/components/nav-panel.ts` — main work

- **Hosts in tree**: `renderGroupNode()` (L176) gains a child host list under each
  group (hosts where `group_id === group.id`, sorted by `last_connected` desc).
  Unassigned hosts render under a pseudo "Ungrouped" node.
- **Selection model**: replace `selectedGroupId` filter semantics with
  `selectedHostId`. Host row click = select (highlight). Double-click / Enter =
  connect. Group row click = toggle expand only (existing `expandedGroups` Set).
- **Search**: `onSearchInput` filters the tree — show matching host rows + ancestor
  groups, hide non-matching. Reuse the substring matcher extracted from
  `host-filters.ts` (see §4) so nav tree and recents share one matcher.
- **Drag & drop** (HTML5 DnD):
  - Group rows: `draggable=true`, `dragstart` carries `{type:'group', id}`.
    Drop targets = another group row (drop = reparent) + a root drop zone
    (drop = ungroup). Prevent dropping a group into its own descendant.
  - Host rows: `draggable=true`, `dragstart` carries `{type:'host', id}`.
    Drop targets = group rows (drop = set `group_id`).
  - After drop: call existing host-update / `saveGroup` IPC, refresh tree.
- **Keyboard**: existing ↑/↓/Enter nav must traverse the *flattened visible tree*
  (groups + hosts + ungrouped), not just groups. Enter on host = connect,
  Enter on group = expand/collapse.
- **API change**: `setGroup()` (L88) → repurpose or remove. Add
  `selectHost(id)`, `getSelectedHost()`. `onSelectGroup` callback in main.ts →
  `onSelectHost` (connect flow).

### 2. `src/components/host-screen.ts` — repurpose

- Drop group-filter badge, drop `setGroup` / group `applyFilter` logic.
- `render()` (L179) now renders **recent sessions**: hosts with
  `last_connected != null`, sorted desc. Reuse `renderHostItem()` (L218) markup as-is.
- Empty state: "No recent sessions — connect to a host to see it here."
- Remove the content-area search block (search now lives only in the nav panel).
- Keep: host form modal, delete confirm, context menu (minus "Move to group"),
  `connectToHost()` (L855), double-click / Enter connect.
- `setSearchQuery` / `focusNavSearch` / `clearNavSearch` (L102–124) → move ownership
  to nav panel or delete.

### 3. `src/main.ts` — wire-up

- `onSelectGroup` (L123–149) → `onSelectHost`: `showView("connections")` +
  `hostScreen.selectHost(id)` (or connect directly on double-click).
- `onSearchInput` → now calls the nav panel's internal tree filter (no host-screen call).
- `onGroupsChanged` callback → refresh the nav tree (hosts moved / groups reparented).

### 4. `src/lib/host-filters.ts`

- Extract `hostMatches(host, query): boolean` (the substring logic at L39–50) for
  reuse by both the nav tree and the recents list.
- `filterHosts()` → simplify to "recent hosts" (drop group param) or keep for
  recents sort only.

### 5. `src-tauri/src/hosts.rs`

- Verify existing IPC covers: `update_host_group(host_id, group_id)` (may already
  exist via host update) and `update_group(group)` for reparenting. If
  `update_group` doesn't accept `parent_id`, add it. **Verify during impl.**

### 6. CSS

- `_nav-panel.css`: host row styles (reuse `.hs-host-item` patterns or new
  `.nav-host-row`), drag ghost, drop-target highlight (valid / invalid).
- `_host-screen.css`: strip search-row / group-badge styles, keep list + row styles.

## Risks / flags

1. **Ungrouped hosts** — pseudo-node label (default: "Ungrouped").
2. **DnD on Windows** — HTML5 DnD works in WebView2 but is finicky; may need
   `dragover` preventDefault + visual feedback. Fallback: if DnD proves
   unreliable, keep a context menu for moves (decide during impl).
3. **Keyboard nav** over a 2D tree (groups + hosts) is the fiddliest part —
   use a flattened visible-list model.
4. **Backward compat** — `last_connected` is already populated; recents work with
   zero data migration.

## Out of scope

- Session records (durations, attempts) — not requested.
- Persisting tree expand/collapse state — nice-to-have, skip.

## Verification

- Frontend: `npm run build` (runs `tsc`) — must exit 0.
- Rust (if `hosts.rs` changes): `cargo check` in `src-tauri/` — must exit 0.
- Manual: drag host → group, drag group → group, drag group → root, search
  filters tree, recents sort by `last_connected`, keyboard nav over tree.
