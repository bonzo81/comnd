# 009. Accept glib advisory GHSA-wrw7-89jp-8q8g until the tauri/gtk-rs stack moves past glib 0.18

Date: 2026-10-19
Status: Accepted

## Context
Dependabot alert #42 (GHSA-wrw7-89jp-8q8g, medium): unsoundness in `glib::VariantStrIter` — an out-argument passed as `&p` instead of `&mut p`, undefined behavior that recent optimizing rustc builds turn into NULL-deref crashes. Vulnerable range `>= 0.15.0, < 0.20.0`, patched only in 0.20.0 — no 0.18.x backport exists.

glib 0.18.5 reaches this repo only through the Linux webview stack: comnd → tauri 2.12.4 → wry 0.57.0 / tao / muda / webkit2gtk 2.0.2 → gtk-rs 0.18 → `glib ^0.18`. Every crate in that chain is at its latest stable release and all pin `glib ^0.18`; the only thing beyond is tauri 3.0.0-alpha. Windows and macOS builds do not include glib at all (WebView2 / WKWebView backends). The vulnerable API's only entry point, `Variant::array_iter_str()`, has no callers anywhere in the dependency tree, and the app never touches glib directly; the advisory's observed impact is a crash, not an exploit primitive. Dependabot cannot close the alert: it closes only when a lockfile containing glib >= 0.20 lands on the default branch.

## Options
- **Accept and wait for upstream.** Cost: the alert stays open and Linux builds ship the (unreachable) code.
- **Dismiss the alert as tolerable risk.** Cost: loses the automatic nudge — Dependabot closes the alert by itself the day a patched lockfile lands on main.
- **`[patch.crates-io]` fork of glib 0.18 with the upstream `&mut` fix backported.** Cost: maintaining a fork of the gtk-rs 0.18 generation to patch code nothing calls.

## Decision
Accept and wait: leave alert #42 open, do not fork, do not dismiss. The exposure is Linux builds only, the vulnerable API is unreachable, and the alert closes automatically when a tauri/wry bump lands glib >= 0.20 (most likely with the tauri 3 line). Revisit if the app ever calls glib directly or a compliance policy demands zero open alerts.

## Consequences
- Easier: no forked dependencies; the existing Dependabot cargo-bump PRs carry the eventual fix with no extra process.
- Harder: one permanently-open medium alert on the repo dashboard; Linux builds carry dead vulnerable code until the stack moves.
- Rules out: chasing the alert from this repo (impossible while gtk-rs 0.18 pins `glib ^0.18`); dismissing the alert and losing auto-closure.
- A tracking issue referencing this ADR has not been filed yet.