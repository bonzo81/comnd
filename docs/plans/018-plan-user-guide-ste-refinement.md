# Plan: User Guide — Simple English (STE) Refinement

Status: planned (2026-08-30)

Refine all user-facing docs in `docs/user-guide/` into plain, simple English for
newcomers, using the `simple-english` skill (ASD-STE100, pragmatic mode). Facts,
structure, and technical accuracy stay unchanged. No new content is added.

## Decisions (user-confirmed)

- Check verb: **make sure that** — single verb for all check/verify/confirm/
  double-check spots. Host-key technical terms ("host key verification",
  "verified automatically") stay as-is. Table cells become short noun phrases
  where possible, else "Make sure that…".
- App data directory: **`comnd`** is correct (with the dot). Files 09 and 10
  currently say `comnd` — fix them. File 11 already says `comnd` and stays.
- Scope: `docs/user-guide/` only (11 files). Internal `docs/*.md` plans, specs,
  and `DEVELOPMENT.md` are untouched.

## Scope

| # | File |
|---|---|
| 01 | `docs/user-guide/01-installation.md` |
| 02 | `docs/user-guide/02-getting-started.md` |
| 03 | `docs/user-guide/03-connecting-to-devices.md` |
| 04 | `docs/user-guide/04-terminal-and-suggestions.md` |
| 05 | `docs/user-guide/05-side-panel.md` |
| 06 | `docs/user-guide/06-knowledge-base-overview.md` |
| 07 | `docs/user-guide/07-keyboard-shortcuts.md` |
| 08 | `docs/user-guide/08-settings.md` |
| 09 | `docs/user-guide/09-security.md` |
| 10 | `docs/user-guide/10-troubleshooting.md` |
| 11 | `docs/user-guide/11-customizing-knowledge-base.md` |

## Global STE pass (applied to every file)

- Expand every contraction (`you'll`, `it's`, `don't`, `can't`, `there's`,
  `Here's`, `isn't`, `doesn't`, …).
- British → American spelling: organisation, recognise/recognised, behaviour,
  colour.
- Banned modals: may / might / could / would → `can` or restructure; should →
  must or delete.
- No semicolons — split into two sentences (Rule 8.1).
- `e.g.` → `for example` (GR-6).
- One check verb: **make sure that** only. Kill verify/confirm/double-check
  rotation outside host-key technical terms.
- Synonym rotation fix: use **settings**, not config, for user preferences
  (Rule 1.11). Applies to "config file" → "settings file", "host configuration"
  → "host settings".
- Sentence length: ≤20 words procedural, ≤25 words descriptive. Split longer
  sentences.
- Conditions before commands: `If X, do Y.` (Rule 5.4).
- Add missing H1 titles. Files 03–11 start at `##`; file 01 has no title at all.
- Jargon cleanup for a newcomer audience: explain or replace "shadow buffer",
  "local echo", "What Happens Under the Hood", "authoritative upstream",
  "block scalar", "surface the command".

## Per-file changes

| File | Main fixes |
|---|---|
| 01-installation | Add `# Installation`; "Grab" → "Download"; "Gatekeeper may block" → "can block"; split 28-word Updates sentence; "organisation" spelling |
| 02-getting-started | ~15 contractions; split host-key ID analogy (28 words); "You're now live on the device" → plain; simplify "local staging or buffering" line |
| 03-connecting | Semicolons → splits; "device might ask" → "can ask"; TOFU analogy split; error-table semicolons → commas/line breaks |
| 04-terminal | Heading "What Happens Under the Hood" → "How Input Works"; explain "local echo" in plain words; fix `(+N) badge` sentence; split 31-word sentence |
| 05-side-panel | "de-emphasised" jargon → plain; delete "Nothing to manage."; table contractions |
| 06-kb-overview | Split 40-word version-caveat sentence; "Here's what it checks" |
| 07-shortcuts | "Work regardless…" missing subject; "No dead ends." colloquial → plain |
| 08-settings | "config file" → settings file; double "by default"; "When this feature ships" → "is released"; remove unexplained "shadow buffer" term |
| 09-security | Possessives (`system's`); "could be exploited" → "can"; checksum passive → active; **paths `comnd` → `comnd`** |
| 10-troubleshooting | Heaviest: ~8 sentences over 30 words split; condition order; "sluggishness" → "lag", "Network blips" → "interruptions"; recognised/colour spelling; **paths `comnd` → `comnd`** (incl. logs paths) |
| 11-customizing | Split 40-word mode-list sentence into a list; explain "YAML block scalar"; "help surface the command" → "find"; best-practice imperatives → statements of fact where descriptive |

## Execution steps

1. Rewrite each file in place, `01` → `11`, applying the global STE pass and
   per-file changes above.
2. Per-file self-check after each rewrite:
   - grep contractions: `\b(you'll|you're|it's|don't|can't|isn't|doesn't|there's|here's|we'll|I'm)\b`
   - grep semicolons `;`, banned modals `\b(may|might|could|would|should)\b`,
     British spellings `(organisation|recognis|behaviour|colour)`, `e\.g\.`
   - Manual pass: sentence length, synonym rotation, jargon.
3. Fix path strings in 09-security.md and 10-troubleshooting.md to `comnd`.
4. Final sweep: same greps across all 11 files. Every hit must be a deliberate
   exception or fixed.

## Untouchables (stay exact)

- Code blocks, CLI flags, UI labels, error strings, numbers, file paths
  (except the confirmed `comnd` → `comnd` fix).
- All technical facts and section structure. No new sections, no new content.
