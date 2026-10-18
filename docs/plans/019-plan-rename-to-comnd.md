# Plan: Rename comnd / comnd → comnd

Full-app rename. Decisions (2026-08-30):

- No built-in data migration — only the dev environment has user data; migrate manually during the rename work
- All docs renamed, including historical planning docs (grep stays clean)
- GitHub repo + local folder rename included as final manual steps

## Scope summary

63 files. Three identity layers + one manual layer:

- **Rust**: package `comnd`, lib `comnd_lib`, identifier `com.comnd.app`, keyring service `comnd`, log file `comnd.log`
- **Frontend**: title text, localStorage keys `comnd-*`, window events `comnd:*`
- **npm/docs**: package name, ~30 doc files
- **Manual (dev env)**: data dir move, credential re-save, repo + folder rename

## Phase 1 — Rust backend (`src-tauri/`)

| File | Change |
|---|---|
| `Cargo.toml` | `name = "comnd"` → `"comnd"`; lib `comnd_lib` → `comnd_lib`. `Cargo.lock` regenerates on next build |
| `src/main.rs:5` | `comnd_lib::run()` → `comnd_lib::run()` |
| `tauri.conf.json` | `productName` → `"comnd"`, `identifier` → `"com.comnd.app"`, window `title` → `"comnd"` |
| `capabilities/default.json` | description → "Default capabilities for comnd" |
| `src/paths.rs` | `BUNDLE_ID` → `com.comnd.app`; doc comments; temp dirs `comnd-import-{}` → `comnd-import-{}`; error msg "comnd data files" → "comnd". **Keep** legacy-migration source dir `dirs::data_dir()/comnd` untouched (real historical path) |
| `src/credentials.rs` | keyring service `"comnd"` → `"comnd"` (4 sites); test fixtures `comnd_test_probe`, `comnd_cred_test_*`, `comnd_legacy_*` → `comnd_*` |
| `src/config.rs` | `OLLAMA_KEY_ENTRY` → `"comnd_ollama_api_key"`; `Entry::new("comnd", …)` ×4 → `"comnd"`; key format `comnd_provider_{}` → `comnd_provider_{}`; doc comments; test strings incl. `/var/log/comnd/comnd.log` → comnd |
| `src/netbox.rs` | `TOKEN_KEY`/`DEFAULT_PW_KEY` → `comnd_source_netbox_*`; "comnd platform" comments; test temp dirs |
| `src/lib.rs` | log prefixes `"comnd v{} starting"`, `eprintln!("comnd: …")` ×2 → comnd; logger filter `starts_with("comnd_lib")/("comnd")` → comnd variants; default log `comnd.log` → `comnd.log` (3 sites); test asserts + `comnd-test-logs` dirs |
| `src/kb.rs`, `src/hosts.rs`, `src/secrets/mod.rs` | test temp-dir names, `comnd_TEST_*` env vars → `COMND_TEST_*`, fixture strings, doc comments |

## Phase 2 — Frontend (`src/`)

| File | Change |
|---|---|
| `main.ts:216` | title text `"comnd"` → `"comnd"`; `:303` event `comnd:theme` → `comnd:theme` |
| `index.html` | `<title>` → comnd |
| `lib/theme.ts`, `lib/timestamps.ts`, `lib/auto-copy.ts`, `lib/output-highlight.ts`, `lib/search-prefs.ts` | localStorage keys + CustomEvent names → `comnd-*` / `comnd:*` |
| `components/nav-panel.ts` | `comnd.nav.expandedGroups` → `comnd.nav.expandedGroups` |
| `components/terminal-view.ts` | `SUGGESTIONS_KEY` + 13 event names → comnd |
| `components/settings-screen.ts:305` | hint text; `defaultPath` `comnd.log`→`comnd.log`, `comnd-backup.zip`→`comnd-backup.zip` |
| `lib/logger.ts` | doc comment + prefix `[comnd:${tag}]` → `[comnd:${tag}]` |
| `styles/main.css:1` | comment |
| `tests/settings-log-file.test.ts` | 6× `comnd.log` → `comnd.log` |

## Phase 3 — npm + packaging

- `package.json` name → `comnd`; run `npm install` to regenerate `package-lock.json`
- Binary becomes `comnd.exe` automatically (was `comnd.exe`); installer artifact names follow `productName` — **after a build, verify actual artifact filenames** and use them in docs

## Phase 4 — Docs (all)

Mechanical `comnd`/`comnd` → `comnd` across:

- Root: `README.md`, `CONTRIBUTING.md`, `agents.md`, `.github/copilot-instructions.md`, `.agents/skills/review-documentation/SKILL.md`
- `docs/`: 01, 02 (line 135 also has stale dir paths `~/.config/comnd/` → fix to `com.comnd.app`), 03, 04, 08, 12, accessibility, implementation-plan, DEVELOPMENT.md (clone URL → `bonzo81/comnd.git`, `cd comnd` → `cd comnd`), extract_all_commands.py + extract_sample.py (hardcoded `C:\Users\andyt\development\comnd\...` → new folder path)
- `docs/plans/plan-*` (8 files), `docs/credentials/02-implementation-plan.md`, `docs/user-guide/` (11 files — 01-installation.md installer names get real post-build names, not guessed)

Caveat: historical plan docs describe past state; mechanical rename makes some slightly inaccurate (e.g. legacy-migration narrative). Accepted per the "all docs" decision.

## Phase 5 — Manual dev-env migration (one-off, NOT in app)

1. Stop app. `Move-Item $env:LOCALAPPDATA\com.comnd.app $env:LOCALAPPDATA\com.comnd.app`
2. Keyring: after rename, re-save via UI — reconnect each host (re-enter password), re-add NetBox token + Ollama key in Settings. Then optionally purge stale `comnd*` entries from Windows Credential Manager (`cmdkey /list`)
3. localStorage prefs reset — re-apply theme/timestamps if wanted (trivial)

## Phase 6 — Repo + folder (final manual steps)

1. GitHub settings: rename repo `bonzo81/comnd` → `bonzo81/comnd` (old URL redirects)
2. `git remote set-url origin https://github.com/bonzo81/comnd.git`
3. Close editor/terminals, move `C:\Users\andyt\development\comnd` → `...\comnd`
4. Confirm `extract_*.py` paths match new location (set in Phase 4)

## Verification

- `npm run build` — exit 0 (tsc strict)
- `npm test` — vitest green
- `cargo check` + `cargo test` in `src-tauri/` — unit tests assert log paths/keyring names, all updated
- Final sweep: `rg -i "net\.sh|comnd"` → **zero hits** outside `.git`
- Smoke: `npm run tauri dev` — titlebar "comnd", connect host (post re-save), suggestions work, `comnd.log` appears under `%LOCALAPPDATA%\com.comnd.app\logs\`

## Open items / risks

1. **Icon** — if the app icon has "comnd" text baked in, regenerate via `npm run tauri icon <new-source.png>`. Check `src-tauri/icons/` visually.
2. **Version bump** — rename is a product-identity change; consider 0.1.0 → 0.2.0 (optional).
3. Docs `user-guide/01-installation.md` currently says `net-sh.exe` (stale — real binary was `comnd.exe`). Phase 4 fixes it to actual post-rename artifact names after a build.

## Execution order

Phases 1→2→3 (code, verify builds/tests) → Phase 4 (docs) → Phase 5 (dev data) → Phase 6 (repo/folder). One commit per phase keeps bisect clean.
