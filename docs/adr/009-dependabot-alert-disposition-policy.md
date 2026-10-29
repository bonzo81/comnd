# 009. Dependabot alert disposition: dismiss only when the code cannot ship and no fix exists

Date: 2026-10-19
Status: Accepted

## Context
Amended 2026-10-27: broadened from the glib-specific decision to the general rule, after the
extract-zip dismissals.

Amended 2026-10-29: the extract-zip dismissals are retired. The webdriverio 10 upgrade in
issue #66 dropped extract-zip from the dependency tree, so that worked example is history;
the rule and the glib example stand.

Two alerts on this repo pull in opposite directions, and without a written rule the
dispositions drift.

**glib #42** (GHSA-wrw7-89jp-8q8g, medium): unsoundness in `glib::VariantStrIter` — an
out-argument passed as `&p` instead of `&mut p`, undefined behavior that recent optimizing
rustc builds turn into NULL-deref crashes. Vulnerable range `>= 0.15.0, < 0.20.0`, patched
only in 0.20.0 — no 0.18.x backport exists. glib 0.18.5 reaches this repo only through the
Linux webview stack: comnd → tauri 2.12.4 → wry 0.57.0 / tao / muda / webkit2gtk 2.0.2 →
gtk-rs 0.18 → `glib ^0.18`. Every crate in that chain is at its latest stable release and
all pin `glib ^0.18`; the only thing beyond is tauri 3.0.0-alpha. The vulnerable API's only
entry point, `Variant::array_iter_str()`, has no callers anywhere in the dependency tree,
and the app never touches glib directly.

**extract-zip #86, #87** (GHSA-jmr9-qjv8-65gv / CVE-2026-56876 and GHSA-7pqw-9j4j-h8q3 /
CVE-2026-19693, both high) — **history, cleared 2026-10-29**: unvalidated symlink path
traversal, and arbitrary file writes through symlink archive entries. Vulnerable range
`<= 2.0.1`; `first_patched_version` was null — no fixed release existed at all. It arrived
as a `development`-scope transitive dependency of the end-to-end test harness: webdriverio →
@wdio/utils → @puppeteer/browsers → extract-zip. `npm ls extract-zip --omit=dev` returned
nothing, and no release artifact contained it. webdriverio 10.1.0 no longer uses extract-zip
for browser archive extraction, so the dependency is gone from the lockfile and neither
alert can fire again.

glib is unfixable from this repo. extract-zip was not: `npm audit` offered exactly
one remediation, a semver-major upgrade to webdriverio 10.1.0, tracked in issue #66.
That deferral, not the absence of a fix, was what the dismissal rested on. The
distinction matters — `first_patched_version: null` says nothing about whether an
upgrade further up the chain drops the dependency, so the parent chain has to be
checked separately every time. That is what happened: the deferred upgrade landed,
the chain dropped extract-zip, and the dismissals became unnecessary.

What separates the two is reachability: glib compiles into Linux release builds,
extract-zip never leaves the dev machine.

GitHub caps a dismissal comment at 280 characters, so both extract-zip comments were
truncated mid-sentence. The alert cannot carry the reasoning — that has to live here.

## Options
- **Leave every alert open until it clears itself.** Cost: the dashboard fills with alerts
  that will never close on their own, and the ones that will close stop standing out.
- **Dismiss every alert this repo cannot fix.** Cost: loses the automatic nudge — the
  dashboard stops showing a real risk that ships.
- **Dismiss only where the code cannot ship and no fix exists; leave the rest open.**
  Cost: one rule to apply, and reachability has to be checked each time.

## Decision
Dismiss an alert only when both hold:

1. **The vulnerable code cannot reach a release artifact.** It is absent from every shipped
   binary and bundle — typically `development`-scope npm tooling, or a build dependency
   with no runtime path.
2. **No patched version exists, or the only path to one is out of scope** — a semver-major
   upgrade of a dev tool, or an upstream release that has not happened.

Otherwise leave the alert open, even when the vulnerable API is unreachable. An open alert
is the reminder that closes itself the day a patched lockfile lands on the default branch.

Applied: glib #42 stays open — it compiles into Linux release builds, and a tauri/wry bump
carries the fix automatically. extract-zip #86 and #87 were dismissed as tolerable risk —
dev-only, never shipped, and the only remedy was the then-deferred webdriverio 10 upgrade in
#66; that upgrade landed on 2026-10-29 and removed the dependency, so those two dismissals
are history rather than accepted risk.

Every dismissal names the scope evidence, the dependency chain, and the upgrade that would
remove it, in that order, inside the 280-character limit. The full reasoning goes in an ADR
or a linked issue, never only in the alert comment.

## Consequences
- Easier: the dashboard shows only alerts that represent real, shippable exposure; the glib
  alert still closes itself when the stack moves; no forked dependencies.
- Harder: each unfixable alert needs a reachability check before dismissal, and a dismissed
  alert stops notifying — so the ADR carrying the reasoning has to be found again when that
  dependency is next touched.
- Rules out: blanket "dismiss all" cleanups; forking glib 0.18 to patch code nothing calls;
  chasing the glib alert from this repo (impossible while gtk-rs 0.18 pins `glib ^0.18`).
- Retired: the extract-zip dismissals closed by upgrade, not by a patch — webdriverio 10.1.0
  dropped the dependency and `npm audit` no longer reports it. A dev-only chain can leave
  through a major upgrade, so check the parent chain before treating an alert as permanent.
- Revisit when tauri 3 lands: the glib alert should close on its own, and this ADR's first
  worked example becomes history.
- A tracking issue for the glib alert has not been filed.