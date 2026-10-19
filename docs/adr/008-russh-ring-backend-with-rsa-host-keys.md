# 008. russh crypto backend: ring, with the rsa feature kept for ssh-rsa host keys

Date: 2026-10-19
Status: Accepted

## Context
Fourteen open Dependabot security alerts against russh 0.60.3 forced the bump to 0.63.3 (PR #43, merged). In `src-tauri/Cargo.toml` the dependency is declared as `russh = { version = "0.63", default-features = false, features = ["flate2", "rsa", "ring"] }`, which fixes two choices beyond the version bump itself. First, the crypto backend: russh's default backend is aws-lc-rs, whose Windows builds need the NASM assembler toolchain; `ring` builds on the stock toolchain. Second, the `rsa` feature: without it, ssh-rsa host-key verification is unavailable — and the target network devices (Cisco IOS-XE, Cisco NX-OS, F5 BIG-IP TMOS) still present ssh-rsa host keys, so dropping it would fail host-key checks against them.

## Options
- **ring backend.** Cost: no FIPS-validated crypto; ring's release cadence is slower than aws-lc-rs.
- **aws-lc-rs backend (the russh default).** Cost: NASM/CMake toolchain prerequisites — contributors and CI cannot build on a stock Windows toolchain.
- **rsa feature enabled.** Cost: ssh-rsa stays in the accepted host-key set — a deliberate legacy compatibility concession.
- **rsa feature disabled.** Cost: host-key verification fails against devices that present only ssh-rsa host keys — the named target platforms.

## Decision
russh uses the `ring` crypto backend with the `rsa` feature enabled: Windows builds need no extra assembler toolchain, and ssh-rsa host keys from the target network devices remain verifiable. Revisit if a target platform stops offering ssh-rsa or a FIPS-validated backend becomes a requirement.

## Consequences
- Easier: stock-toolchain builds on Windows; legacy device host keys verify; all 14 russh advisories cleared (PR #43).
- Harder: no FIPS posture; ssh-rsa support is kept as a compatibility concession.
- Rules out: aws-lc-rs until its build drops the NASM prerequisite (or a toolchain decision changes); silently dropping ssh-rsa support for target devices.
- Lesson from the bump: Dependabot's one-shot `cargo update -p russh:0.60.3` could not cross russh 0.62's pre-release→stable crypto-stack swap, so the bump had to be manual (two-step resolution). From 0.63.3 onward, routine Dependabot updates work again.