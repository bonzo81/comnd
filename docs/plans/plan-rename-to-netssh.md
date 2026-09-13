# Plan: Rename netssh / netssh → netssh

Full-app rename. Decisions (2026-08-30):

- No built-in data migration — only the dev environment has user data; migrate manually during the rename work
- All docs renamed, including historical planning docs (grep stays clean)
- GitHub repo + local folder rename included as final manual steps

## Scope summary

63 files. Three identity layers + one manual layer:

- **Rust**: package `netssh`, lib `netssh_lib`, identifier `com.netssh.app`, keyring service `netssh`, log file `netssh.log`
- **Frontend**: title text, localStorage keys `netssh-*`, window events `netssh:*`
- **npm/docs**: package name, ~30 doc files
- **Manual (dev env)**: data dir move, credential re-save, repo + folder rename

## Phase 1 — Rust backend (`src-tauri/`)

| File | Change |
|---|---|
| `Cargo.toml` | `name = "netssh"` → `"netssh"`; lib `netssh_lib` → `netssh_lib`. `Cargo.lock` regenerates on next build |
| `src/main.rs:5` | `netssh_lib::run()` → `netssh_lib::run()` |
| `tauri.conf.json` | `productName` → `"netssh"`, `identifier` → `"com.netssh.app"`, window `title` → `"netssh"` |
| `capabilities/default.json` | description → "Default capabilities for netssh" |
| `src/paths.rs` | `BUNDLE_ID` → `com.netssh.app`; doc comments; temp dirs `netssh-import-{}` → `netssh-import-{}`; error msg "netssh data files" → "netssh". **Keep** legacy-migration source dir `dirs::data_dir()/netssh` untouched (real historical path) |
| `src/credentials.rs` | keyring service `"netssh"` → `"netssh"` (4 sites); test fixtures `netssh_test_probe`, `netssh_cred_test_*`, `netssh_legacy_*` → `netssh_*` |
| `src/config.rs` | `OLLAMA_KEY_ENTRY` → `"netssh_ollama_api_key"`; `Entry::new("netssh", …)` ×4 → `"netssh"`; key format `netssh_provider_{}` → `netssh_provider_{}`; doc comments; test strings incl. `/var/log/netssh/netssh.log` → netssh |
| `src/netbox.rs` | `TOKEN_KEY`/`DEFAULT_PW_KEY` → `netssh_source_netbox_*`; "netssh platform" comments; test temp dirs |
| `src/lib.rs` | log prefixes `"netssh v{} starting"`, `eprintln!("netssh: …")` ×2 → netssh; logger filter `starts_with("netssh_lib")/("netssh")` → netssh variants; default log `netssh.log` → `netssh.log` (3 sites); test asserts + `netssh-test-logs` dirs |
| `src/kb.rs`, `src/hosts.rs`, `src/secrets/mod.rs` | test temp-dir names, `netssh_TEST_*` env vars → `NETSSH_TEST_*`, fixture strings, doc comments |

## Phase 2 — Frontend (`src/`)

| File | Change |
|---|---|
| `main.ts:216` | title text `"netssh"` → `"netssh"`; `:303` event `netssh:theme` → `netssh:theme` |
| `index.html` | `<title>` → netssh |
| `lib/theme.ts`, `lib/timestamps.ts`, `lib/auto-copy.ts`, `lib/output-highlight.ts`, `lib/search-prefs.ts` | localStorage keys + CustomEvent names → `netssh-*` / `netssh:*` |
| `components/nav-panel.ts` | `netssh.nav.expandedGroups` → `netssh.nav.expandedGroups` |
| `components/terminal-view.ts` | `SUGGESTIONS_KEY` + 13 event names → netssh |
| `components/settings-screen.ts:305` | hint text; `defaultPath` `netssh.log`→`netssh.log`, `netssh-backup.zip`→`netssh-backup.zip` |
| `lib/logger.ts` | doc comment + prefix `[netssh:${tag}]` → `[netssh:${tag}]` |
| `styles/main.css:1` | comment |
| `tests/settings-log-file.test.ts` | 6× `netssh.log` → `netssh.log` |

## Phase 3 — npm + packaging

- `package.json` name → `netssh`; run `npm install` to regenerate `package-lock.json`
- Binary becomes `netssh.exe` automatically (was `netssh.exe`); installer artifact names follow `productName` — **after a build, verify actual artifact filenames** and use them in docs

## Phase 4 — Docs (all)

Mechanical `netssh`/`netssh` → `netssh` across:

- Root: `README.md`, `CONTRIBUTING.md`, `agents.md`, `.github/copilot-instructions.md`, `.agents/skills/review-documentation/SKILL.md`
- `docs/`: 01, 02 (line 135 also has stale dir paths `~/.config/netssh/` → fix to `com.netssh.app`), 03, 04, 08, 12, accessibility, implementation-plan, DEVELOPMENT.md (clone URL → `bonzo81/netssh.git`, `cd netssh` → `cd netssh`), extract_all_commands.py + extract_sample.py (hardcoded `C:\Users\andyt\development\netssh\...` → new folder path)
- `docs/plans/plan-*` (8 files), `docs/credentials/02-implementation-plan.md`, `docs/user-guide/` (11 files — 01-installation.md installer names get real post-build names, not guessed)

Caveat: historical plan docs describe past state; mechanical rename makes some slightly inaccurate (e.g. legacy-migration narrative). Accepted per the "all docs" decision.

## Phase 5 — Manual dev-env migration (one-off, NOT in app)

1. Stop app. `Move-Item $env:LOCALAPPDATA\com.netssh.app $env:LOCALAPPDATA\com.netssh.app`
2. Keyring: after rename, re-save via UI — reconnect each host (re-enter password), re-add NetBox token + Ollama key in Settings. Then optionally purge stale `netssh*` entries from Windows Credential Manager (`cmdkey /list`)
3. localStorage prefs reset — re-apply theme/timestamps if wanted (trivial)

## Phase 6 — Repo + folder (final manual steps)

1. GitHub settings: rename repo `bonzo81/netssh` → `bonzo81/netssh` (old URL redirects)
2. `git remote set-url origin https://github.com/bonzo81/netssh.git`
3. Close editor/terminals, move `C:\Users\andyt\development\netssh` → `...\netssh`
4. Confirm `extract_*.py` paths match new location (set in Phase 4)

## Verification

- `npm run build` — exit 0 (tsc strict)
- `npm test` — vitest green
- `cargo check` + `cargo test` in `src-tauri/` — unit tests assert log paths/keyring names, all updated
- Final sweep: `rg -i "net\.sh|netssh"` → **zero hits** outside `.git`
- Smoke: `npm run tauri dev` — titlebar "netssh", connect host (post re-save), suggestions work, `netssh.log` appears under `%LOCALAPPDATA%\com.netssh.app\logs\`

## Open items / risks

1. **Icon** — if the app icon has "netssh" text baked in, regenerate via `npm run tauri icon <new-source.png>`. Check `src-tauri/icons/` visually.
2. **Version bump** — rename is a product-identity change; consider 0.1.0 → 0.2.0 (optional).
3. Docs `user-guide/01-installation.md` currently says `net-sh.exe` (stale — real binary was `netssh.exe`). Phase 4 fixes it to actual post-rename artifact names after a build.

## Execution order

Phases 1→2→3 (code, verify builds/tests) → Phase 4 (docs) → Phase 5 (dev data) → Phase 6 (repo/folder). One commit per phase keeps bisect clean.
