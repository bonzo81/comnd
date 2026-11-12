# 019. NetBox TLS verification is skipped only by an explicit, default-off opt-in

Date: 2026-11-12
Status: Accepted

## Context

Code scanning alert #4 (`rust/disabled-certificate-check`, rule severity warning,
security severity high) points at `src-tauri/src/netbox.rs:1043`, where
`readonly_http::ReadOnlyHttp::new` calls
`builder.danger_accept_invalid_certs(true)`. The finding is mechanically correct
and the default is safe: the call is reached only when a user has turned on
"Allow self-signed certificates" for the NetBox host source.

**The toggle is off unless the user turns it on.** `NetBoxConfig::allow_invalid_certs`
(`netbox.rs:633`) is a `#[serde(default)] bool`, and `impl Default for NetBoxConfig`
sets it to `false` (`netbox.rs:657`). A config that predates the field, omits it,
or fails to parse at all (`NetBoxConfig::from_json` falls back to
`NetBoxConfig::default()`) therefore yields `false`, and certificate verification
is on. Nothing in the product code flips the default.

**The user is warned where they turn it on.** The Settings switch row
(`src/components/settings-screen.ts:710-712`) reads "Allow self-signed
certificates" with the help text: "Skip TLS verification for the NetBox URL (home
labs with a self-signed or internal CA). Off by default — it makes the API token
MITM-able. Prefer trusting your CA in the OS cert store." Enabling it also logs
`NetBox client for <url> built with TLS verification disabled — home-lab mode,
token is MITM-able` (`netbox.rs:1092-1095`). The value is read by the autosave
path from the checkbox (`settings-screen.ts:1697`); `saveConnection` reuses the
saved config and seeds a fresh one with `allow_invalid_certs: false`
(`settings-screen.ts:1743`), so it cannot be switched on as a side effect of
saving a URL or token. "Test Connection" passes the live form toggle
(`settings-screen.ts:1793,1806` → `netbox_test_connection`, `netbox.rs:1463-1476`)
so the tested state is the state on screen; `netbox_sync` (`netbox.rs:1502`) and
`build_netbox_client` (`netbox.rs:1543`) read it from saved config.

**The read-only guarantee is untouched.** All NetBox HTTP goes through
`readonly_http` (`netbox.rs:1028-1066`): a private `reqwest::Client` exposing one
`get` method, with `test_netbox_source_has_no_write_http_methods`
(`netbox.rs:2684`) failing CI if a raw client or a write verb appears. Skipping
certificate verification loosens *who can answer* the GETs; it does not add a
verb. The option is also inert on `http://` base URLs, where there is no TLS to
verify.

**Why this needs a written decision.** Alert #4 has been open since 2026-10-19
and re-raises on every analysis of `main`, because the code will keep calling
`danger_accept_invalid_certs` for as long as the feature exists. An intentional
CodeQL finding is not silenced by editing the code — ADR 012 set that precedent
when it accepted `session_id` in the app log and dismissed the alerts that
followed. ADR 009 is the analogous rule for Dependabot alerts; its test is
reachability of a vulnerable dependency from a release artifact, which does not
apply to a vulnerability introduced by a deliberate feature flag.

## Options

- **Delete the setting; require the CA in the OS certificate store.** Closes the
  alert by removing the feature. Cost: every internal-CA NetBox installation
  must have its CA installed at the OS level first, which is not always possible
  (locked-down or temporary lab machines, an appliance CA handed out as a PEM
  file), and the setting exists precisely for that case.
- **Keep the setting, leave the alert open.** Cost: a permanently open alert that
  can never close while the feature exists. It trains reviewers to ignore the
  dashboard, which is the opposite of what the alert is for, and it gives a
  future genuine `rust/disabled-certificate-check` finding no way to stand out.
- **Keep the setting, exclude the query or path in code-scanning settings.**
  Cost: hides the finding without recording a decision, hides *future* instances
  of the same pattern anywhere on that path, and leaves the next maintainer with
  no explanation of why the risk is acceptable.
- **Keep the setting opt-in and default-off, record the accepted risk, and
  dismiss this alert against the ADR.** Cost: one ADR to maintain and the
  residual risk below, which is real but conditional on a deliberate user action.

## Decision

Keep `allow_invalid_certs` as an opt-in, default-off escape hatch for home labs
and internal-CA deployments. No product code changes: the flag stays
`#[serde(default)]` and `false` in `Default`, the Settings warning stays as
written, and the `readonly_http` GET-only guard stays untouched.

**Accepted risk.** With the toggle on, anyone who can intercept traffic between
the user's machine and the configured NetBox URL — a rogue access point, ARP or
DNS spoofing, a compromised router on the path — can present any certificate,
terminate TLS, read the NetBox API token from the `Authorization` header, and
return forged device inventory. The token carries whatever NetBox granted it
(read access to DCIM is enough for the sync), and forged entries can put wrong
hosts in front of the user, who may then connect to them. The exposure is bounded
by three things: it requires an explicit opt-in that is off by default, it
applies only to the NetBox integration and only to the URL configured for it,
and the integration is strictly read-only, so a forged response cannot write
back to NetBox. SSH credentials are not involved — they live in the OS keychain
and go to devices, never through the NetBox client. The option is global to the
NetBox host source rather than per-URL, so enabling it in a lab also applies to
any NetBox URL configured later; that is accepted as part of the same trade.

**General rule for dismissing an intentional CodeQL finding.** Dismiss as
`won't fix` only when all of the following hold:

1. The flagged behaviour is deliberate and required by a feature that exists on
   purpose, not an oversight to be fixed.
2. The unsafe path is off unless the user explicitly opts in, or the code is
   unreachable from a release artifact.
3. The risk and the mitigation are visible to the user at the point of use — a
   UI warning, a log line, or both.
4. An ADR records the decision, and the dismissal comment names that ADR path.
   The comment is a pointer, because GitHub caps it at 280 characters (ADR 009);
   the reasoning lives here.
5. No product change would remove the finding without removing the feature or
   misleading the user.

Otherwise fix the code. ADR 012 is the precedent for this rule, and ADR 009
remains the rule for Dependabot alerts: a finding that ships is not dismissed on
the grounds that it is hard to fix.

Applied to alert #4: the feature is deliberate (1), the branch is guarded by a
default-off opt-in (2), the switch text and the log line state the risk (3), this
ADR records it and the dismissal comment names it (4), and the only code change
that would clear the finding is deleting the feature (5). The alert is dismissed
as `won't fix` under this ADR.

## Consequences

- Easier: alert #4 leaves the dashboard with its reasoning on record, and any
  future `rust/disabled-certificate-check` alert on the same line is dismissed
  against this ADR rather than re-litigated or fixed by deleting a feature
  users rely on.
- Harder: a dismissed alert stops notifying, so the reasoning has to be found
  again the next time `netbox.rs` is touched. The alert comment names this file
  for that reason; keep it pointing here if the alert is ever re-dismissed.
- Rules out: turning the toggle on by default, and any "skip TLS for every host
  source" generalisation of it. Either supersedes this ADR.
- Rules out: a code-scanning query or path exclusion in place of a decision. If
  the finding is not acceptable, fix the code; if it is, say so in an ADR.
- Guarded: `test_netbox_config_json_roundtrip_and_defaults` asserts that a config
  with no stored value and a config predating the field both parse to `false`.
  Frontend config fixtures in `settings-screen.test.ts:19,101` and
  `ipc-contract.test.ts:48` carry `false` as well, so the shipped default is
  visible on both sides of the IPC boundary.
- Revisit when the setting is removed, renamed, or given a different default;
  supersede this ADR and re-examine alert #4 at the same time.
