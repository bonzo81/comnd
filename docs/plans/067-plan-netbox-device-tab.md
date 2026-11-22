# Plan: NetBox device summary tab in the side panel (issue #177, phase 1)

Status: Phase 1 implemented; verification recorded below. Rebased onto `main` after #179
(undocked side panel), which also took the 066 plan number, so this plan is 067. Phase 2
(VLAN groups/VLANs, prefixes, connected devices) is implemented; its query plan and
verification are recorded at the end of this document.
Spec: bonzo81/comnd#177, artifact `spec-netbox-device-tab`
(<https://github.com/bonzo81/comnd/issues/177/artifacts/1>). Builds on
`docs/plans/016-plan-netbox-host-source.md`, the mock/harness work from
`docs/plans/064-plan-netbox-workflow-tests.md`, and the shared, two-home panel seam from
`docs/plans/066-plan-side-panel-undock.md`.

## Background

A NetBox-sourced host in Comnd carries only what a sync needs: name, primary IP, platform,
site/location slugs, tags, status and description. The side panel has no way to show the
facts an engineer wants while logged into the device: its role, device type, rack and U
position, and the IP addresses configured on its interfaces. Those facts live in NetBox, not
in the SSH session, and the sync cache deliberately does not keep them.

Phase 1 adds a third side-panel tab for NetBox-sourced hosts that fetches a live summary
when the user selects it. Phase 2 extends the same tab with VLAN groups, VLANs, prefixes and
connected devices; nothing in this plan builds those sections.

## Interaction with the undocked panel (after #179)

#179 moved the panel out of `terminal-view.ts` into an app-wide seam with two homes:

- `src/lib/side-panel.ts` owns `open`, `undocked`, `dockedWidth`, `mode` and the content
  `SidePanelSnapshot`; it is the only state either home renders.
- `src/lib/side-panel-render.ts` renders a snapshot into either home's `.sb-content`.
- `src/components/terminal-view.ts` paints the docked home.
- `src/components/panel-window.ts` paints the undocked OS window from the state the main
  window publishes over `comnd:panel-state`; it sends `mode`/`dock`/`close`/`play`/`add`/
  `run` back as `SidePanelAction`s.

This plan is adjusted around that seam rather than adding a terminal-view-only tab:

1. **The NetBox tab belongs to the shared state, not to one home.** `SidePanelState` gains
   `netboxHostId: string | null`. The terminal view that currently owns the app-wide panel
   (`panelActive`, ADR-013) publishes its host there. Ownership is tracked by the view object,
   not by the host id: two duplicate sessions can share `netbox:<id>`, so the losing view
   clears the subject only when it is still the published owner. Both homes show the tab from
   the same field, so the tab works docked and undocked.
2. **The fetch lives in `side-panel.ts`.** It is the module both homes act through, so a
   `mode: netbox` action from the undocked window and a click in the docked strip reach the
   same fresh fetch. `SidePanelSnapshot` gains a `netbox` variant carrying
   `loading | ready | error` plus the summary; the existing renderer draws it in both homes.
   `renderSidePanel` wires the error's Retry control to a new `retry-netbox` action, so Retry
   works in either home.
3. **`SidePanelMode` gains `"netbox"`.** `setSidePanelMode` performs the fetch; selecting
   the tab again refetches (the existing early return for the already-active KB/Replay tab
   does not apply to NetBox). Opening the panel while the selected mode is NetBox also
   refetches, because that is a user-initiated reveal of a live snapshot.
4. **The active tab still owns the subject.** Switching session tabs republishes
   `netboxHostId`; a NetBox host change while the panel is open and in NetBox mode refetches,
   and a move to a user host hides the tab and falls back to KB with a cleared snapshot.
   Nothing is fetched while the panel is closed.
5. **The strip is duplicated markup in both homes today.** Both are made icon-only from the
   same labels and `icons.ts` glyphs (`book`, `clock`, `netbox`), and both toggle the NetBox
   button's `hidden` from `netboxHostId`. The Undock control keeps the word+icon form #179
   chose after review; only the three tab buttons become icon-only. The tab strip stays at
   the panel's top right and the panel width is unchanged.

## Scope

In scope:

- A third tab in the terminal side panel, visible only for NetBox-sourced hosts
  (`host.source == "netbox"` or the `netbox:<id>` host-id form that `hosts.rs` encodes).
- Identity and status, device type, site, location, rack and U position.
- Interface IP addresses grouped by interface.
- The tab strip moves to the panel's top right and becomes icon-only, with an accessible
  name and a keyboard focus indicator on every icon.
- A single Tauri read command that fetches the summary fresh on every tab selection.

Out of scope (phase 2):

- VLAN groups, VLANs, prefixes and connected devices.
- Fetching or caching device detail during sync.
- Any write to NetBox.
- Polling, background refresh, or using the sync cache as a fallback.
- For user-added hosts, the tab is not rendered at all.

## NetBox REST API research

Verified against the NetBox v4.1.0 source (the version whose `API-Version` the existing mock
reports), because the mock fixtures are hand-written to the serializers below:

- `netbox/dcim/api/serializers_/devices.py` — `DeviceSerializer.Meta.brief_fields` and the
  fields used for rack/U/device type.
- `netbox/dcim/api/serializers_/device_components.py` — `InterfaceSerializer.Meta.brief_fields`.
- `netbox/ipam/api/serializers_/ip.py` — `IPAddressSerializer.Meta.brief_fields` and the
  `assigned_object` `SerializerMethodField`.
- `netbox/ipam/filtersets.py` — `IPAddressFilterSet.device_id`.
- `netbox/netbox/api/serializers/base.py` — nested serializers default to `brief_fields`, and
  `fields=` restricts the top-level serializer.
- `netbox/netbox/api/viewsets/__init__.py` — `brief`/`fields` are honoured by both list and
  detail actions.

Facts that drive the query plan:

1. **`?brief=1` on a device list is not enough.** `DeviceSerializer.brief_fields` is
   `(id, url, display, name, description)` — it drops device type, site, location, rack and
   position. A detail retrieve with `fields=` selects the top-level fields we need and leaves
   nested serializers brief (they default to their own `brief_fields`), which is the small
   payload the rule asks for.
2. **Interfaces have no `ip_addresses` field in the v4.1 serializer.** Interface serializers
   expose `count_ipaddresses`, not the addresses. Asking each interface for its IPs would be
   one request per interface, which the spec forbids.
3. **IP addresses can be filtered by device in one request.**
   `IPAddressFilterSet.device_id` resolves a device's interfaces (including virtual-chassis
   members) and filters IPs assigned to them. The response's nested `assigned_object` (brief)
   names the interface, so grouping happens client-side from one response.
4. **`limit=0` returns every matching object without pagination.** The existing geo fetch uses
   it; the summary uses it so the GET count never depends on interface or address count.
5. **Nested `assigned_object` is brief automatically.** `BaseModelSerializer.__init__` gives
   every nested serializer its `Meta.brief_fields` when no explicit `fields` are passed, so
   the interface object is `(id, url, display, device, name, description, cable, _occupied)`
   and the nested device is `(id, url, display, name, description)`.

### Endpoint and query plan

| # | Request | Parameters | Serializer shape used | GETs |
|---|---|---|---|---|
| 1 | `GET /api/dcim/devices/{netbox_id}/` | `fields=id,name,display,status,device_type,site,location,rack,position,face,primary_ip4,primary_ip6` | Top-level restricted; `device_type`, `site`, `location`, `rack`, `primary_ip4/6` nested brief | 1 |
| 2 | `GET /api/ipam/ip-addresses/` | `device_id={netbox_id}`, `fields=id,address,vrf,status,assigned_object,assigned_object_type,assigned_object_id`, `limit=0` | Top-level restricted; `assigned_object` nested brief (interface, then brief device) | 1 |

**Expected GET count per device: exactly 2**, independent of whether the device has 1 or 48
interfaces, and independent of how many addresses those interfaces hold. There is no
per-interface request and no pagination loop. An error on either request stops the command
and returns the error; no partial summary is rendered.

### Field mapping

| UI fact | Source |
|---|---|
| Name | Device `name`, falling back to `display` (requested in `fields=`), then `device-<id>` |
| Status | Device `status.label` (fallback `status.value`) |
| Device type | Device `device_type.manufacturer.name` composed with `device_type.model`; `display` is only a fallback because NetBox's `DeviceType.__str__` returns the model alone |
| Site | Device `site.name` (fallback `display`) |
| Location | Device `location.name` (fallback `display`) |
| Rack | Device `rack.name` (fallback `display`) |
| U position / face | Device `position` (decimal string or number) and `face` (`front`/`rear`/blank) |
| Primary IP | Device `primary_ip4.address`, falling back to `primary_ip6.address` |
| Interface groups | Each IP's `assigned_object.id` + `assigned_object.name`; only `assigned_object_type == "dcim.interface"` and only interfaces whose brief `device.id` equals the requested id (filters out virtual-chassis sibling interfaces) |
| Addresses | IP `address` (CIDR retained) plus optional `vrf.name` |

Interfaces with no IP addresses do not appear, because the panel lists the addresses the
device has, not every interface the device owns. An address with no assigned interface is
skipped defensively; the `device_id` filter should make that case unreachable.

## Decisions

1. **Two filtered GETs, no cache.** The summary is fetched only by the Tauri command, only
   when the tab is selected. The command never reads `NetBoxInventory`; the sync cache is not
   a fallback and cannot supply stale values.
2. **The read-only guard is unchanged.** Both requests go through `NetBoxClient::get_json`,
   which calls `readonly_http::ReadOnlyHttp::get`. No new HTTP client, no write verb, no new
   crate.
3. **Host id resolution mirrors `hosts.rs`.** The command requires
   `netbox::is_netbox_host_id(host_id)` and parses the suffix as `u64`, the same shape
   `touch_host` parses and `materialize_host` creates. A user host id is rejected before any
   network call. The frontend uses the same rule (`source == "netbox"` or the id prefix) so
   the tab cannot appear for a user host.
4. **Fixed request count is the acceptance test, not an optimisation.** The Rust test drives
   the in-process mock with 1 interface/1 address and with 48 interfaces/48 addresses and
   asserts identical GET counts (2) and the same endpoint set.
5. **No new command dependencies.** Types and parsing live in the existing NetBox module;
   one `#[tauri::command]` is added and registered beside the existing NetBox commands.
6. **Tab strip: icon-only tabs in both homes, right-aligned, no width change.** The strips
   in `terminal-view.ts` and `panel-window.ts` keep their `role="tablist"`; the three tab
   buttons gain `aria-label` and `title`, reuse `icons.ts` (`book`, `clock`, `netbox`), and
   are right-aligned in the same top area. Buttons are natively focusable, so Tab reaches
   them; the panel's width remains the resizable fixed width. The Undock control is not a
   tab: it keeps the word+icon form #179 adopted after review, so the shared strip stays
   legible and the way back to docked is never an unlabelled glyph.
7. **Failure is a clear error with Retry and no stale values.** The snapshot is replaced by
   a `loading` snapshot before each fetch, so a failure cannot leave the previous values in
   the pane. A failed fetch renders the message and a Retry control only. Retry performs a
   fresh fetch in whichever home it was pressed; a late response from a superseded selection
   or a session that has given up the panel is ignored.
8. **A new mock scenario for the smoke path.** The app-level NetBox mock gains a `device-tab`
   scenario: one device whose primary IP is `127.0.0.1`, plus the device-detail and
   IP-address endpoints. The SSH smoke suite uses it to connect a real NetBox-sourced host to
   the SSH mock and open the tab, so the smoke pass exercises both mocks together.

## The four known gaps from the spec

1. **Exact meaning of "subnets associated":** stays open. Phase 1 fetches no prefixes, so
   neither interpretation is implemented. Phase 2 must confirm against the NetBox model
   whether it means prefixes containing the interface IPs, prefixes of the device's VLANs, or
   both, and record the choice before building.
2. **Which VLAN source is authoritative:** stays open. Phase 1 fetches no VLANs. Phase 2 must
   choose between the device's own VLANs and its site's VLAN groups.
3. **How much of the tab strip redesign the two existing tabs get:** resolved. All three tab
   buttons in both homes become icon-only at the panel's top right: `book` (Knowledge Base),
   `clock` (Command Replay), `netbox` (NetBox). Each has both `aria-label` and `title`, and
   the existing tab content rendering (KB detail, Replay list) is untouched. The separate
   Undock control keeps #179's word+icon decision.
4. **Behaviour when a device has very many IPs or VLANs:** resolved for phase 1 addresses.
   The panel renders every address in the one page and scrolls vertically
   (`overflow-y: auto`). NetBox's `limit=0` is still capped by the server's `MAX_PAGE_SIZE`
   (1000 by default), so a response with a non-null `next` or `count > results.len()` is
   rejected with an actionable error rather than silently truncating the list; the fixed
   two-GET contract is kept. VLAN volume remains a phase 2 question.

## Files touched

- `src-tauri/src/netbox/mod.rs`: serializable `DeviceSummary`, `DeviceSummaryInterface`,
  `DeviceSummaryAddress` types.
- `src-tauri/src/netbox/client.rs`: `fetch_device_summary` (two GETs, parsing, grouping,
  sorting) and unit tests, including the 1-vs-48-interface request-count test.
- `src-tauri/src/netbox/commands.rs`: `netbox_get_device_summary` command.
- `src-tauri/src/lib.rs`: register the command.
- `src-tauri/src/netbox/mock.rs`: the `device-tab` scenario and its fixtures/endpoints.
- `src/lib/tauri-api.ts`: summary types and the typed invoke wrapper.
- `src/lib/netbox-host.ts` (new): `isNetboxHostId` / `isNetboxHost`, the frontend mirror of
  `hosts.rs`'s host-id rule; unit-tested over a NetBox host, a user host and `null`.
- `src/lib/side-panel.ts`: `netboxHostId` in the shared state, the `netbox` snapshot variant,
  the fresh fetch/refresh path, retry, host publication and the `netbox` mode transition.
- `src/lib/side-panel-render.ts`: the NetBox summary/loading/error markup and its Retry
  wiring, so both homes render the same pane.
- `src/components/terminal-view.ts`: icon-only three-tab strip in the docked home, publishing
  the active host's NetBox id while it owns the app-wide panel, and clearing it on hand-off.
- `src/components/panel-window.ts`: icon-only three-tab strip in the undocked home, the
  NetBox button's visibility from the published state, and the `netbox` mode/retry actions.
- `src/lib/icons.ts`: no new icon (reuses `book`, `clock`, `netbox`).
- `src/styles/components/_replay.css`: icon-only tab buttons in the shared `.sb-toggle`
  strip (it already owns them); the Undock control is left as #179 shipped it.
- `src/styles/components/_netbox-device.css` (new): summary layout, tokens only.
- `src/styles/main.css`: import the new stylesheet.
- `src/components/panel-window.test.ts`: the undocked home's icon-only strip, NetBox tab
  visibility by host source, and the Retry action.
- `src/lib/netbox-host.test.ts` (new): the frontend mirror of the host-id rule.
- `src/lib/ipc-contract.test.ts`: the new command wrapper's exact invoke name and args.
- `src/lib/side-panel-netbox.test.ts` (new): stubbed-IPC state and rendering tests for the
  fetch, summary, grouping, error/Retry and host hand-off.
- `test/smoke/run.mjs`: the NetBox-connected smoke steps, tab focus/name assertions and the
  existing `--mutation=focus` target.
- `docs/plans/067-plan-netbox-device-tab.md`: this plan.

## Test plan

- **Unit (frontend):** the NetBox tab is present in the shared state/strip for a NetBox host
  and absent for a user host and for `null`, including the undocked window's DOM.
- **Component (stubbed IPC via `createHarness`):** select the NetBox mode for
  `netbox:<id>`; assert the loading snapshot is replaced by identity/status/device type/
  site/location/rack/U, and that fetching is not attempted before selection. A separate case
  serves two interfaces holding three addresses and asserts the grouping. A failing second
  fetch replaces the values with an error plus Retry; Retry refetches and no earlier value
  survives.
- **Rust unit:** parsing and grouping; 403 on the second request returns an error; and the
  request-count test against the mock NetBox (1 interface vs 48 → identical 2 GETs).
- **Smoke (`npm run smoke`):** start both mocks, sync one loopback NetBox device, connect it
  through the SSH mock, open the docked side panel, assert the three icon tabs are named,
  focusable and draw a focus ring, select the NetBox tab, and assert the rendered summary.
  `panel-undock-dock` must stay green, and the undocked window must show the same NetBox tab
  for the active NetBox host.
- **Mutation (`npm run smoke -- --mutation=focus`):** the focus assertion above must be the
  single named expected failure, with `mutation activation: focus applied`.
- **Existing suites:** `npm run smoke:netbox` and the full `npm run smoke` must stay green.

## Review fixes (CodeRabbit and Copilot)

- Device detail asks for `display`, so an unnamed device still has its fallback.
- Device type is composed from `manufacturer.name` + `model`; NetBox's `DeviceType.__str__`
  returns the model only, so relying on `display` dropped the manufacturer.
- A 403 on the IP-address request names IPAM read access instead of pointing at DCIM Device.
- A capped address page (`next` set, or `count > results.len()`) is rejected with an
  actionable error instead of presenting a truncated summary.
- The panel's NetBox subject is owned by the publishing view, so a duplicate session
  switching order cannot clear the incoming view's tab.

## Verification (this branch)

- `npm run build` — exit 0 (`tsc` + Vite).
- `npm run test` — exit 0, 54 files, 1004 tests.
- `npm run test:coverage` — exit 0; `src/lib` 87.65% lines (floor 78%), `src/components`
  38.21% lines (floor 29%).
- `npm run lint:css` — exit 0, 82 tokens across 124 files.
- `cargo check --all-targets` (in `src-tauri/`) — exit 0.
- `cargo test` (in `src-tauri/`) — exit 0, 281 lib tests + 3 log-redaction tests.
- `cargo test --release --lib` (in `src-tauri/`) — exit 0, 279 tests.
- `npm run smoke` — exit 0, all 24 scenarios passed (including `keyboard-focus`,
  `terminal-sidebar-layout`, `panel-undock-dock`).
- `npm run smoke:mutation` — exit 0; expected `ssh_send` failure (11 bytes dropped).
- `npm run smoke -- --mutation=focus` — exit 0; exactly one expected failure:
  `Keyboard focus: panel tabs: … has no visible focus indicator … mutation activation: focus
  applied`.
- `npm run smoke:netbox` — exit 0, all 7 scenarios passed.

Windows needs `msedgedriver.exe` on `PATH` at the installed WebView2 version; if it is
missing or mismatched, the smoke result is reported as not runnable rather than installed by
the agent. `node_modules` was absent in this worktree, so `npm install` was run once; no
manifest changed.

## Risks / open points

- `fields=` is already relied on by the existing choices fetch, so this plan does not add a
  new API-version assumption. An instance too old to honour it would return larger objects
  but the same two requests; the parser reads only the fields it needs.
- `limit=0` on a device with a very large number of addresses trades pagination for one large
  response. That is deliberate: it keeps the GET count fixed as the spec requires. NetBox
  still caps that response at `MAX_PAGE_SIZE` (1000 by default); the client detects the cap
  (`next` set or `count > results.len()`) and returns an actionable error instead of a
  partial list. A server with `MAX_PAGE_SIZE` raised or unset returns everything.
- Two open sessions can share one NetBox host id (duplicate sessions). The panel's NetBox
  subject is owned by the publishing view, so an outgoing duplicate cannot clear the incoming
  one's tab; a test drives that activation order explicitly.
- Virtual chassis: `device_id` includes sibling members' interfaces. The parser filters on the
  brief `assigned_object.device.id`, so the tab never shows another member's interfaces under
  this device.
- The smoke scenario needs a NetBox host with a loopback primary IP. It is confined to the
  new `device-tab` mock scenario; the existing `ok`/`refresh` fixtures and their counts are
  unchanged.
- The tab strip is still two copies of markup (docked in `terminal-view.ts`, undocked in
  `panel-window.ts`) because #179 did not extract it. This plan keeps the labels, glyphs and
  visibility rule identical in both and covers each with a test; extracting a shared strip
  renderer is a reasonable follow-up, not a prerequisite.
- The Undock control is deliberately not made icon-only. #179 changed it to word+icon after
  review so the two halves of the dock/undock action read consistently; #177's "icon-only
  strip" is applied to the three tab buttons. If the intent is a literal icon-only strip
  including Undock, that needs a design decision, not a silent regression.
- `SidePanelState` gains a field that is published to the undocked window. The panel window
  and the main window run the same bundle in this repo, so no version skew is possible; a
  stale panel window from an earlier process is destroyed with the main window (#179).

---

# Phase 2 — VLANs, subnets and connected devices (issue #177)

Status: implemented. Subnet source (b) uses route A (one `limit=0` prefixes request),
chosen by the maintainer over the GraphQL alternative because it keeps the implementation
REST-only and a capped page fails loudly, matching the phase 1 rule.

## Confirmed scope (from the issue hand-off)

- **VLANs:** the device's own VLANs — the union of `untagged_vlan` and `tagged_vlans` across
  its interfaces — grouped by VLAN group, showing VID, name and group name.
- **Subnets:** one deduplicated list combining (a) prefixes assigned to those VLANs and
  (b) prefixes containing the device's interface IP addresses that have an address.
  Deduplicate by prefix id, then sort. Both sources are "related to this device", so they are
  one section, not two.
- **Connected devices:** every cabled peer. A peer that matches a host already in Comnd gets
  a Connect button opening the existing connect flow; unmatched peers render as plain text.
- **Matching order:** NetBox id (`netbox:<id>`), then primary IP against `host.hostname`,
  then name against `host.display_name`. First match wins.
- **Volume:** render everything, let the panel scroll. A NetBox-capped page is an error with
  an actionable message, never a truncated list (the phase 1 rule for IPs).
- Writes remain impossible: every request goes through `NetBoxClient::get_json` →
  `readonly_http::ReadOnlyHttp::get`.

### Gap answers (the two the spec left open)

1. **"Subnets associated" = both sources.** (a) prefixes whose `vlan` is one of the device's
   VLANs and (b) prefixes whose network contains one of the device's interface IPs, in the
   same VRF as that IP. They are one deduplicated list keyed by prefix id.
2. **VLAN source = the device's own VLANs.** The union of `untagged_vlan` and `tagged_vlans`
   across the device's interfaces, grouped by `VLAN.group`. The site's VLAN groups are not
   used: they include VLANs this device is not a member of.

## NetBox REST API research (v4.1.0 source)

Verified against the v4.1.0 tag the phase 1 plan pinned. New facts that drive the phase 2
requests:

1. **`DeviceSerializer.brief_fields` is `(id, url, display, name, description)`.** A nested
   peer device has no `primary_ip4`/`primary_ip6` and no `platform`. Matching a peer by IP
   therefore needs its own batched request; it cannot come from the cable's nested object.
   A **top-level** device list with `fields=id,name,display,primary_ip4,primary_ip6` does
   return both primary IPs, because a nested `IPAddressSerializer` defaults to its brief
   shape (`id, url, display, family, address, description`) — `address` included.
2. **`InterfaceSerializer.brief_fields` is `(id, url, display, device, name, description,
   cable, _occupied)`.** It has **no** `untagged_vlan`, `tagged_vlans`, `link_peers` or
   `ip_addresses`. Asking for `fields=id,name,device,untagged_vlan,tagged_vlans` on the
   interfaces list returns the two VLAN fields, and each nested VLAN uses
   `VLANSerializer.brief_fields` = `(id, url, display, vid, name, description)` — **the brief
   VLAN has no `group`**, and `VLAN.__str__` is `name (vid)`, so the group name cannot be
   inferred from `display` either.
3. **VLAN group therefore needs its own batched request.** `GET /api/ipam/vlans/` with
   `fields=id,vid,name,group` returns the group; `group` is nested brief
   (`id, url, display, name, slug, description, vlan_count`), so `group.name` is present.
   The `id` filter is NetBox's `MultiValueNumberFilter` (BigAutoField resolves through
   `IntegerField` in `BaseFilterSet.FILTER_DEFAULTS`), so repeated `?id=` values are an OR.
   The request is issued only when at least one VLAN id exists; an empty `?id=` set would
   mean "every VLAN in NetBox", which is not a valid request.
4. **`IPAddressFilterSet.device_id` includes virtual-chassis siblings** — its `filter_device`
   expands `device.vc_interfaces()`. **`InterfaceFilterSet.device_id` does not**: it is the
   plain `device__in` inherited from `DeviceComponentFilterSet`. Both are still filtered
   defensively on the nested brief `device.id` (the interfaces request asks for `device` so
   the check is possible if NetBox ever widens that filter).
5. **`limit=0` is still capped by `MAX_PAGE_SIZE`** (`netbox/api/pagination.py`), whose
   default is `1000` (`netbox/config/parameters.py`). When `MAX_PAGE_SIZE` is set,
   `limit=0` becomes that limit and `next` is non-null if the result is larger. Every new
   list request repeats phase 1's check: `next` set, or `count > results.len()` → error with
   an actionable message, no partial list.
6. **Cables in 4.1 have two terminable ends, `a_terminations` and `b_terminations`**, each a
   list of `GenericObjectSerializer` values: `{object_type, object_id, object}`. `object` is
   the nested brief termination, and for a `dcim.interface` it carries the brief `device`
   (`id, display, name`). `CableFilterSet` **accepts `device_id`** (a `MultiValueNumberFilter`
   that filters `terminations___device__in`), so one request returns every cable attached to
   the device; the peer is the termination whose nested `device.id` differs from ours.
   Terminations without a device (circuit, power feed) are skipped.
7. **Prefix containment has no batched REST filter in v4.1.** `PrefixFilterSet.contains` is
   a single-valued `django_filters.CharFilter`; `?contains=a&contains=b` keeps only `b`.
   There is no address-list filter and no `vrf_id` "empty" lookup (`vrf_id` is a
   `ModelMultipleChoiceFilter`, which only gains negation), so "prefixes containing N
   addresses in the global table" cannot be expressed as one filtered list request. This is
   the one open decision; §"Open decision" below lists the routes and their costs.

## Endpoint and query plan (route A, implemented)

| # | Request | Parameters | Serializer shape used | GETs |
|---|---|---|---|---|
| 1 | `GET /api/dcim/devices/{id}/` | `fields=id,name,display,status,device_type,site,location,rack,position,face,primary_ip4,primary_ip6` | Phase 1 (unchanged) | 1 |
| 2 | `GET /api/ipam/ip-addresses/` | `device_id={id}`, `fields=id,address,vrf,status,assigned_object,assigned_object_type,assigned_object_id`, `limit=0` | Phase 1 (unchanged); keeps `vrf.id` and `address` for subnets | 1 |
| 3 | `GET /api/dcim/interfaces/` | `device_id={id}`, `fields=id,name,device,untagged_vlan,tagged_vlans`, `limit=0` | Top-level restricted; `device` and each VLAN nested brief | 1 |
| 4 | `GET /api/ipam/vlans/` | `id={vlan ids…}`, `fields=id,vid,name,group`, `limit=0` | `group` nested brief (`name`) | 1, skipped when the device has no VLANs |
| 5 | `GET /api/ipam/prefixes/` | `limit=0`, `fields=id,prefix,vrf,vlan` | `vrf` and `vlan` nested brief; `prefix` as CIDR | 1 (see open decision) |
| 6 | `GET /api/dcim/cables/` | `device_id={id}`, `fields=id,a_terminations,b_terminations`, `limit=0` | Each end a `GenericObjectSerializer`; `object` nested brief (`device` brief) | 1 |
| 7 | `GET /api/dcim/devices/` | `id={peer ids…}`, `fields=id,name,display,primary_ip4,primary_ip6`, `limit=0` | `primary_ip4/6` nested `IPAddressSerializer` brief (`address`) | 1, skipped when there are no peer devices |

**Total: 7 GETs** for a device that has at least one VLAN and at least one cabled peer.
Requests 4 and 7 are skipped only when the *set is empty* — never split or repeated by
count. Requests 1 and 7 hit the devices endpoint at different paths (detail versus list), so
the endpoint set is seven distinct paths, each fetched exactly once.

### Field mapping

| UI fact | Source |
|---|---|
| Device VLAN set | Request 3: `untagged_vlan.id` plus every `tagged_vlans[].id`, for interfaces whose brief `device.id` equals `{id}` |
| VLAN row | Request 4: `vid`, `name`, `group.id` (grouping key) and `group.name` (display label; nullable → "No group"), deduped by `id` |
| Subnet, source (a) | Request 5: prefix whose `vlan.id` is in the device VLAN id set |
| Subnet, source (b) | Request 5: prefix whose network contains an IP from request 2 and whose `vrf.id` equals that IP's `vrf.id` (both null → global table). Containment is computed in Rust from the CIDR (`std::net` only — no new crate) |
| Subnet row | Prefix `prefix` (CIDR) and `vrf.name` when set; deduped by `id`; sorted by family then network |
| Peer device | Request 6: the `a_terminations`/`b_terminations` entry whose nested `object.device.id` differs from `{id}`; deduped by peer device id |
| Peer name | Termination `object.device.name`, falling back to `object.device.display`, then `device-<id>` |
| Peer primary IP | Request 7: `primary_ip4.address`, falling back to `primary_ip6.address` (mask retained in the summary, stripped for host matching) |
| Connect target | Frontend only: NetBox id → primary IP → name match against the main window's host list |

### Subnet source (b) — resolved: route A

The fixed-count rule forbids one request per address (the 1-vs-48-interface test would
change the count). The v4.1 REST filterset offers no batched containment filter, so the
viable routes were:

| Route | GETs | Correctness | Cost |
|---|---|---|---|
| **A. All prefixes in one `limit=0` request** (chosen) | 1, fixed | Exact: both sources filtered client-side from the one page | A NetBox with more prefixes than `MAX_PAGE_SIZE` (1000 by default) errors with the actionable cap message. Most real instances exceed 1000 prefixes, so this is a real limitation |
| B. GraphQL aliases, one `GET /graphql/?query=…` with one aliased `prefix_list(filters: {contains: "<ip>"})` per address | 1 HTTP GET | Exact, no page cap | Adds a second API surface (Strawberry GET), a `/graphql/` mock route, and GraphQL error handling (`200` with `errors`) for one section |
| C. Site-scoped prefixes (`site_id`) plus client-side containment | 1–2 | Misses prefixes whose `site` is null (global allocations), a common case | Smaller payload, but silent omissions |
| D. One `?contains=` request per address | 1 + N | Exact | Rejected: the acceptance test compares 1 and 48 interfaces |

Decision: **A** was chosen. It is the only REST route that is exact and fixed-count, and a
capped page failing loudly matches the phase 1 rule. Route B remains the replacement if the
`MAX_PAGE_SIZE` limitation proves unacceptable in use: same command, same snapshot, one
request.

## Section behaviour

- VLANs are grouped by `group.id`, labelled with `group.name` (a null group renders as
  "No group"), because NetBox makes group names unique only within a scope; VLAN rows are
  sorted by VID within a group.
- Subnets render as one list of `prefix` + optional VRF badge, sorted by family then prefix.
- Peers render in one list. A matched peer shows its name and a **Connect** button whose
  accessible name is `Connect to <host display name>`; the button carries `nbd-connect` and
  the existing keyboard focus ring (`*:focus-visible` in `main.css`). An unmatched peer is
  plain text. A peer whose termination is not attached to a device (circuit, power feed) is
  skipped.
- An empty section still renders its heading with a short placeholder, matching phase 1's
  "No interface addresses."

## Two-window contract

- `SidePanelSnapshot`'s ready variant carries the summary **after peer resolution**: every
  peer already has `hostId: string | null` and `label: string | null`. Resolution happens in
  the main window's `refreshNetbox` through a new `SidePanelDeps.resolvePeerHost` (default
  returns null); the renderer never looks anything up. `main.ts` supplies the resolver from
  `NavPanel`'s loaded host list.
- `SidePanelAction` gains `{ type: "connect"; hostId: string }`; `SidePanelHandlers` gains
  `connect(hostId)`. The docked home's handler calls a new `TerminalView` constructor
  callback wired in `main.ts` to `navPanel.getHost(hostId)` → the existing `onConnect(host)`;
  the undocked home sends the action over `comnd:panel-action`, and `main.ts` resolves it the
  same way. No second connect path is added.
- `netboxSeq` semantics are unchanged: a superseded host, tab switch or lost panel drops the
  result, and Retry refetches every section in one command call.

## Mock and smoke plan

- Extend the existing **`device-tab`** app-mock scenario with the new endpoints
  (`/api/dcim/interfaces/`, `/api/ipam/vlans/`, `/api/ipam/prefixes/`, `/api/dcim/cables/`,
  and the filtered `/api/dcim/devices/?id=…` peer response) rather than adding a scenario.
  Adding a scenario would duplicate the whole loopback fixture and the SSH wiring; extending
  `device-tab` leaves every pinned count intact — the synced device count stays `1`, the
  existing list fixtures are untouched, and the phase 1 assertions still see exactly two
  interface groups. The peer device (id 202) is only ever served from the filtered `id=`
  request, never from the sync list, so `report.fetched` stays 1.
- Add one smoke scenario, `netbox-device-sections`, that reuses `installNetboxTabHost` +
  `connectNetboxTabHost`: opens the docked panel, asserts the VLAN groups/subnets/peer rows,
  presses a matched peer's Connect and asserts a session tab opens, closes that session, then
  undocks and repeats the Connect from the panel window. The match is by a unique display
  name, and no host uses a peer primary IP, so the result does not depend on host-list order;
  closing the first session keeps the duplicate-session prompt out of the path. The existing
  `keyboard-focus` NetBox assertions and the `--mutation=focus` target are unchanged;
  `smoke:netbox` keeps its 7 scenarios.

## Files touched (phase 2)

- `src-tauri/src/netbox/mod.rs`: `DeviceSummaryVlan`, `DeviceSummarySubnet`,
  `DeviceSummaryPeer`, and the three new fields on `DeviceSummary`.
- `src-tauri/src/netbox/client.rs`: the five new requests, prefix containment, parsing,
  grouping and the fixed-count test.
- `src-tauri/src/netbox/mock.rs`: `device-tab` fixtures and routes for the new endpoints.
- `src/lib/tauri-api.ts`: the new summary types.
- `src/lib/netbox-peer.ts` (new): the pure peer→host matcher (id, IP, name), plus tests.
- `src/lib/side-panel.ts`: `resolvePeerHost` dependency, peer resolution before publishing,
  the `connect` action.
- `src/lib/side-panel-render.ts`: VLAN/subnet/peer sections and the Connect handler.
- `src/components/terminal-view.ts`: `connect` in `panelHandlers` → new constructor callback.
- `src/components/panel-window.ts`: `connect` handler → bridge action.
- `src/main.ts`: resolver wiring and the `connect` action case.
- `src/components/nav-panel.ts`: read-only `getHosts()` for the resolver.
- `src/styles/components/_netbox-device.css`: VLAN/subnet/peer/Connect styles, tokens only.
- Tests: `src/lib/netbox-peer.test.ts`, `src/lib/side-panel-netbox.test.ts`,
  `src/components/panel-window.test.ts`, Rust unit/mock tests, `test/smoke/run.mjs`.

## Test plan (phase 2)

- **Rust parse:** VLAN dedupe/grouping across two groups; subnet union dedupe where one
  prefix arrives from both sources; peer dedupe and self-termination filtering; prefix
  containment (IPv4 and IPv6, VRF equality).
- **Rust request count:** mock with 1 interface / 2 VLANs / 2 peers vs 48 interfaces /
  40 VLANs / 40 peers — identical 7 GETs and identical endpoint set.
- **Rust capped page:** `next` or `count > results.len()` on the prefixes request returns
  the actionable error.
- **Component:** a summary spanning two VLAN groups; a prefix reachable from both sources
  appears once; four peers (id match, IP match, name match, unmatched) render one Connect
  button for each match and plain text for the miss; a second fetch that fails leaves no
  stale sections and Retry refetches all of them.
- **Panel window:** the undocked home renders the same sections from the published snapshot
  and sends `{ type: "connect", hostId }` for a matched peer.
- **Smoke:** the new `netbox-device-sections` scenario (docked Connect + undocked Connect).

## Risks (phase 2)

- Route A's cap: a NetBox with more prefixes than `MAX_PAGE_SIZE` errors the whole tab. If
  that proves unacceptable in use, switch route (b) to GraphQL aliases in a follow-up.
- The VLAN `?id=` list can be long on a device that trunks thousands of VLANs; the request
  line may be rejected (HTTP 414). That surfaces as an error with Retry rather than a
  truncated list, and the message names the VLAN-id request.
- `CableFilterSet.device_id` matches any termination on the device, including console and
  power cables; a console server or PDU is therefore listed as a peer device, which matches
  "every cabled peer".
- Name matching is case-insensitive and trimmed; two hosts with the same display name make
  the first in the loaded host list win, after the id and IP passes have failed.

## Review fixes (phase 2)

- **IPv6 literals are canonicalised before the primary-IP comparison.** Host validation
  accepts `[2001:db8::1]` and `2001:0db8:0:0:0:0:0:1`, which did not equal NetBox's
  compressed form. `bareAddress` now expands IPv6 to eight hex groups and strips brackets
  and any zone suffix, leaving DNS names and IPv4 addresses unchanged.
- **VLAN groups are keyed by `group.id`, not by name.** NetBox only makes group names unique
  within a scope, so two groups sharing a name were merged into one section. The summary now
  carries `group_id` (the key) and `group` (the label); a component test spans two groups
  with the same name.
- **The smoke scenario's peer match is deterministic.** It matches one peer by a unique
  display name, and no host has a peer primary IP, so the IP pass cannot reach the user host
  or the NetBox host whichever order the backend returns. The first session is closed before
  the second Connect, so the duplicate-session prompt never enters the path.

## Verification (phase 2, this branch)

Run on Windows with PowerShell. Exit codes are the command's own code.

- `npm run build` — exit 0 (`tsc` + Vite; the >500 kB chunk advisory is pre-existing).
- `npm run test` — exit 0, 55 files, 1016 tests.
- `npm run test:coverage` — exit 0; `src/lib` 87.88% lines (floor 78%), `src/components`
  38.22% lines (floor 29%).
- `npm run lint:css` — exit 0, 82 tokens across 126 files.
- `git add -A && npm run lint:eol` — exit 0, 377 text files checked in the index.
- `cargo check --all-targets` (in `src-tauri/`) — exit 0.
- `cargo test` (in `src-tauri/`) — exit 0, 286 lib tests + 3 log-redaction tests.
- `cargo test --release --lib` (in `src-tauri/`) — exit 0, 284 tests.
- `cargo llvm-cov --no-report`, `cargo llvm-cov report --json --summary-only
  --output-path target/coverage.json`, `npm run test:coverage:rust` — exit 0;
  `hosts.rs + replay.rs + config.rs` 68.00% lines (floor 65%), `lib.rs` 40.87% (floor 35%).
  The script notes the floors are measured on ubuntu-22.04.
- `npm run smoke` — exit 0: all 25 regular scenarios plus the expected `isolation-cleanup`
  probe passed, including the new `netbox-device-sections` (docked Connect and undocked
  Connect) and the unchanged `keyboard-focus`, `panel-undock-dock` and
  `terminal-sidebar-layout`.
- `npm run smoke:mutation` — exit 0; the expected `ssh_send` failure reported
  `mutation activation: ssh_send dropped 11 bytes`.
- `npm run smoke -- --mutation=focus` — exit 0; exactly one expected failure on the panel
  tab focus assertion, with `mutation activation: focus applied`.
- `npm run smoke:netbox` — exit 0 on re-run, 7/7 scenarios. The first run flaked on
  `refresh-changes` (its host-tooltip focus check); that scenario uses the untouched
  `ok`/`refresh` fixtures, and the immediate re-run passed.
- `npx commitlint --from origin/main` — exit 0.

Windows rewrote line endings in `src-tauri/Cargo.toml` and
`src-tauri/gen/schemas/*.json` during the smoke builds. `git diff` showed no content
change for those files (the schema diffs were build-time regeneration, unrelated to this
task), so they were reverted with `git checkout --` and are not part of the commit.
