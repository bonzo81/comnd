# Changelog

## [0.6.0](https://github.com/bonzo81/comnd/compare/v0.5.0...v0.6.0) (2026-10-31)


### Features

* **sessions:** allow concurrent sessions to the same host ([#80](https://github.com/bonzo81/comnd/issues/80)) ([7c2a21a](https://github.com/bonzo81/comnd/commit/7c2a21a7e31c5633b062ace423ef8eb3b0a33a5d))


### Bug Fixes

* **deps:** bump russh, fast-uri and vitest to patched releases ([#63](https://github.com/bonzo81/comnd/issues/63)) ([9182885](https://github.com/bonzo81/comnd/commit/918288520a148cd44707b264221640f937de0c88))
* **deps:** bump rustls to 0.23.46 and vite to 6.4.5 ([#81](https://github.com/bonzo81/comnd/issues/81)) ([56f7fe4](https://github.com/bonzo81/comnd/commit/56f7fe41eecb05d6153ab1afbc3f02603cafac63))
* **deps:** bump zip to 9.x to clear dependabot alerts ([#73](https://github.com/bonzo81/comnd/issues/73)) ([90d4f0b](https://github.com/bonzo81/comnd/commit/90d4f0b16317dce652b19df39d29efc78af120e1))
* **logging:** stop writing usernames to the app log ([#65](https://github.com/bonzo81/comnd/issues/65)) ([451903b](https://github.com/bonzo81/comnd/commit/451903b27a87a1e07336b289143e6e6df1ac00fa))

## [0.5.0](https://github.com/bonzo81/comnd/compare/v0.4.1...v0.5.0) (2026-10-19)


### Features

* **netbox:** enforce read-only netbox api access ([#44](https://github.com/bonzo81/comnd/issues/44)) ([2b9368c](https://github.com/bonzo81/comnd/commit/2b9368cdce1b7f308043645a7bb12a1b9df97b13))
* **netbox:** hide empty folders by default with a show-all setting ([#30](https://github.com/bonzo81/comnd/issues/30)) ([bf13606](https://github.com/bonzo81/comnd/commit/bf13606b3abaf7f179e1bd38b68690d6499869f1))
* **netbox:** show inherited source defaults in configure dialog ([#50](https://github.com/bonzo81/comnd/issues/50)) ([3bc1743](https://github.com/bonzo81/comnd/commit/3bc1743c783eb503fa15392a3600c77e2e9664c5))
* **settings:** replace nav sub-items with labeled icon rail ([#46](https://github.com/bonzo81/comnd/issues/46)) ([948e7ab](https://github.com/bonzo81/comnd/commit/948e7aba9abef9a38ee6fdf9533c2e431bb61e57))


### Bug Fixes

* **deps:** bump russh to 0.63.3 to clear 14 ssh advisories ([#43](https://github.com/bonzo81/comnd/issues/43)) ([e812edc](https://github.com/bonzo81/comnd/commit/e812edcf99bfe15fcac6f8ca3c3f88a3029ed464))
* **deps:** replace serde_yml with yaml_serde to drop unsound libyml ([#37](https://github.com/bonzo81/comnd/issues/37)) ([758e491](https://github.com/bonzo81/comnd/commit/758e4914674759aae27f18ac1957cf556443561d))
* **nav:** bind menus to expanded tree rows ([#48](https://github.com/bonzo81/comnd/issues/48)) ([012bdd7](https://github.com/bonzo81/comnd/commit/012bdd7df1160e08cbfc7391dce8d48cac4d22b5))
* **netbox:** keep persisted `enabled` flag in sync with the settings toggle ([#41](https://github.com/bonzo81/comnd/issues/41)) ([b119919](https://github.com/bonzo81/comnd/commit/b119919323c21833e6a248af76666ddcb4a2a0b5))
* **ui:** keep title-bar search usable when narrow ([#49](https://github.com/bonzo81/comnd/issues/49)) ([f7e6bf2](https://github.com/bonzo81/comnd/commit/f7e6bf2a356272daea75f529310d07c53d8d901e))


### Dependencies

* **deps-dev:** bump vite from 6.4.1 to 6.4.4 ([#31](https://github.com/bonzo81/comnd/issues/31)) ([824ea40](https://github.com/bonzo81/comnd/commit/824ea40dc286254099e8911c98e584071aaf4c37))
* **deps:** bump nanoid from 3.3.11 to 3.3.20 ([#34](https://github.com/bonzo81/comnd/issues/34)) ([6529e70](https://github.com/bonzo81/comnd/commit/6529e709c1a3a94bac1e5bf08ae9fd490344b641))
* **deps:** bump openssl from 0.10.77 to 0.10.81 in /src-tauri ([#33](https://github.com/bonzo81/comnd/issues/33)) ([ad443a9](https://github.com/bonzo81/comnd/commit/ad443a90bc0d7c2d73db0f0197270876a4f67cf4))
* **deps:** bump picomatch from 4.0.3 to 4.0.7 ([#42](https://github.com/bonzo81/comnd/issues/42)) ([c5d5f7d](https://github.com/bonzo81/comnd/commit/c5d5f7df6892d13b31b8b4a38a8ce4c1e0e25d22))
* **deps:** bump postcss from 8.5.8 to 8.5.31 ([#36](https://github.com/bonzo81/comnd/issues/36)) ([4c14e68](https://github.com/bonzo81/comnd/commit/4c14e6892970bf2535483fc39ccf2155b6d56c3c))
* **deps:** bump russh from 0.49.2 to 0.60.3 in /src-tauri ([#35](https://github.com/bonzo81/comnd/issues/35)) ([e359316](https://github.com/bonzo81/comnd/commit/e359316b0ce00eb6c905ee8c689c11350e5326fa))
* **deps:** bump source-map-js from 1.2.1 to 1.2.2 ([#32](https://github.com/bonzo81/comnd/issues/32)) ([e56aabd](https://github.com/bonzo81/comnd/commit/e56aabd93e522dea0b1982052bd7c4a8b6e4099e))
* **deps:** bump undici from 7.29.0 to 7.30.1 ([#39](https://github.com/bonzo81/comnd/issues/39)) ([e497593](https://github.com/bonzo81/comnd/commit/e49759308107fffa29b5b1a45ae69a6824d6b048))

## [0.4.1](https://github.com/bonzo81/comnd/compare/v0.4.0...v0.4.1) (2026-10-18)


### Bug Fixes

* **updater:** point manifest endpoint at latest-release permalink ([1bbeda6](https://github.com/bonzo81/comnd/commit/1bbeda656f01044e46f998f3e6ce0011d601ea4b))
* **updater:** point manifest endpoint at latest-release permalink ([4da6b8b](https://github.com/bonzo81/comnd/commit/4da6b8b205b4fbdfc0ac99aafd5a7f5425c82add))

## [0.4.0](https://github.com/bonzo81/comnd/compare/v0.3.0...v0.4.0) (2026-10-18)


### ⚠ BREAKING CHANGES

* **app:** app data directory and saved credentials move to comnd naming

### Features

* **app:** rename app identity to comnd ([d811a21](https://github.com/bonzo81/comnd/commit/d811a218e5c0530fabf7315e386ea405f4dae298))
* **nav:** add host-row tooltip with connection details ([58b99be](https://github.com/bonzo81/comnd/commit/58b99be481c995fcb3b4fc9088e8dff8c7c9489d))
* **nav:** add host-row tooltip with connection details ([0ec9232](https://github.com/bonzo81/comnd/commit/0ec9232b2c8324e64aa39b33a97d7297915efb10))


### Bug Fixes

* close secret prompt recovery gaps ([982e01a](https://github.com/bonzo81/comnd/commit/982e01a3fcfcd661d57396fddfd03aa08bebf152))
* **logging:** make session logs opt-in ([e4511dc](https://github.com/bonzo81/comnd/commit/e4511dc0341111ebe4c584a7898ffb7e2460d8c9))
* **logging:** make session logs opt-in ([adaed9c](https://github.com/bonzo81/comnd/commit/adaed9c85208a4cec99c871edef65c3e5a832b23)), closes [#20](https://github.com/bonzo81/comnd/issues/20)
* **logging:** mask ambiguous Suggest quote spans ([b0db3f1](https://github.com/bonzo81/comnd/commit/b0db3f11736deda59039fa5be212347ead91707e)), closes [#19](https://github.com/bonzo81/comnd/issues/19)
* **logging:** redact suggestion buffer diagnostics ([b3d78af](https://github.com/bonzo81/comnd/commit/b3d78afeba6a5dc0bfc1e0cf037a36c27b0c8a87))
* **logging:** redact suggestion buffer diagnostics ([4c6ba4a](https://github.com/bonzo81/comnd/commit/4c6ba4ac9fe9988eaea4ac8149e1dbebac8e9fbc)), closes [#19](https://github.com/bonzo81/comnd/issues/19)
* **nav:** bind expanded host rows, harden tooltip dismissal ([75aad5d](https://github.com/bonzo81/comnd/commit/75aad5d70055258e2cb242a100b25be3336fb50d))
* **ssh:** address pr review findings in interactive auth ([c5b7313](https://github.com/bonzo81/comnd/commit/c5b7313a345fa14f0f6b9963bbcb9b342d88df6f))
* **ssh:** interactive password prompt for hosts without stored password ([1097e18](https://github.com/bonzo81/comnd/commit/1097e18bbb8c38dc624904adbd4993ede6b69fbd))
* **ssh:** interactive password prompt for hosts without stored password ([3e71518](https://github.com/bonzo81/comnd/commit/3e71518f10d9019130387e5686f08ca4ab066fb4))
* suppress shadow buffer at secret prompts ([c1c42a7](https://github.com/bonzo81/comnd/commit/c1c42a758850c431f68ea64f7b7dc8e9b2724b77))
* suppress shadow buffer at secret prompts ([05a5994](https://github.com/bonzo81/comnd/commit/05a599458693ff59a4533b73d768334484c4d050))

## [0.3.0](https://github.com/bonzo81/comnd/compare/v0.2.2...v0.3.0) (2026-10-15)


### Features

* **updater:** add minisign-signed in-app updates with macOS fallback ([d17d5dd](https://github.com/bonzo81/comnd/commit/d17d5dd2285c03235db52e1a7b59d34d96355b53))


### Bug Fixes

* **updater:** guard applyAvailableUpdate against concurrent installs ([94200d3](https://github.com/bonzo81/comnd/commit/94200d334ecfcfd773466201bcded8017ed2ed0b))

## [0.2.2](https://github.com/bonzo81/comnd/compare/v0.2.1...v0.2.2) (2026-10-14)


### Bug Fixes

* **terminal:** re-measure char size after web font loads ([ed89676](https://github.com/bonzo81/comnd/commit/ed89676c87ca72a58de721efb390ed41de5ed495))
* **terminal:** re-measure char size after web font loads ([f6b313a](https://github.com/bonzo81/comnd/commit/f6b313adc5b16c290d6fd9fa87ff30170e76858c))
* **terminal:** use _charSizeService and reconcile PTY after connect ([a210765](https://github.com/bonzo81/comnd/commit/a210765e5fcf18e40f38e83fb438900f6eb32841))

## [0.2.1](https://github.com/bonzo81/comnd/compare/v0.2.0...v0.2.1) (2026-10-14)


### Bug Fixes

* **kb-viewer:** show error instead of infinite spinner when no platforms exist ([2231f93](https://github.com/bonzo81/comnd/commit/2231f931713adb13f8e3648aeef1f8604e4f0a78))
* **kb:** bundle knowledge-base at canonical resource path ([1ec9f1c](https://github.com/bonzo81/comnd/commit/1ec9f1c0368f270feb101aa3cfb032c58289d100))
* **kb:** bundle knowledge-base at canonical resource path and tolerate _up_ layout ([50a53c1](https://github.com/bonzo81/comnd/commit/50a53c150c3625eb860e22e7204610ac133b2f1f))

## [0.2.0](https://github.com/bonzo81/comnd/compare/v0.1.0...v0.2.0) (2026-10-12)


### Features

* **a11y:** ARIA roles, focus management, accessibility doc ([c8e1769](https://github.com/bonzo81/comnd/commit/c8e1769e43c883e05de10bc8feea0ae003b4b2a1))
* add global search box in titlebar for hosts and KB commands ([2b51592](https://github.com/bonzo81/comnd/commit/2b515929ab28f278a9f04c3aef2cfe181645259f))
* **backup:** add overwrite vs merge mode selection for restore ([ec79e4c](https://github.com/bonzo81/comnd/commit/ec79e4ca3b8114ab61af1c522e0baa82f07587a5))
* **backup:** restart button on restore success toast ([ef00b16](https://github.com/bonzo81/comnd/commit/ef00b164207663631d506d7395b656dd33eba29e))
* **backup:** true entry-level merge with pre-flight conflict detection ([a56b673](https://github.com/bonzo81/comnd/commit/a56b6731ef1c87818ede2e9a0608d25601ee3840))
* **connection:** Wave 1 - shared stripAnsi utility, output pane template, mock test server ([03992fc](https://github.com/bonzo81/comnd/commit/03992fcd352b3e6b403e68190d2564acf58a0b1c))
* **connection:** Wave 2 - output buffer, pane rendering, state guards, buffer lifecycle ([b8b1fc4](https://github.com/bonzo81/comnd/commit/b8b1fc4369a9139ef58614af3597643dd657cc80))
* **creds:** Auth Integrations settings page (chunk 7) ([390402e](https://github.com/bonzo81/comnd/commit/390402e7dad88cfb9a4f222c889273e6b224107a))
* **creds:** connect-time secret resolution + failure UX (chunk 10) ([011e57f](https://github.com/bonzo81/comnd/commit/011e57ff6d5d62988025f02a70fa4c3db5d26294))
* **creds:** CredentialSource model, Rust-side resolution, agent identity enumeration ([fcdc26d](https://github.com/bonzo81/comnd/commit/fcdc26d3abfe2d083c765dc8019af0609d83f11c))
* **creds:** helper text for agent, secret-ref, PAT fields ([0b0b101](https://github.com/bonzo81/comnd/commit/0b0b1010e27bd1cade9980095f1c496fe2e639b6))
* **creds:** host form secret-ref auth method (chunk 9) ([91d862d](https://github.com/bonzo81/comnd/commit/91d862db37e3561ed5d68d223e6861a65aebab6a))
* **creds:** host form SSH agent auth method + identity picker (chunk 5) ([84c89d0](https://github.com/bonzo81/comnd/commit/84c89d0577f84fe0d0b2d40d57c72700b11cbf2c))
* **creds:** list Proton items + reference combobox (chunk 15) ([5763d72](https://github.com/bonzo81/comnd/commit/5763d72b2f5e2333c4c239226c0ca4432910ee48))
* **creds:** Proton Pass provider (chunk 8) ([32b34a0](https://github.com/bonzo81/comnd/commit/32b34a04aac3ec243de2fe41afab074e87633a14))
* **creds:** SecretProvider trait, registry, config storage, CLI runner (chunk 6) ([7d48796](https://github.com/bonzo81/comnd/commit/7d4879657ebfb5b8eca1ee4a71592266ad6d9d6d))
* **creds:** SSH agent auth in SshSession (chunk 4) ([f37b393](https://github.com/bonzo81/comnd/commit/f37b39301d075c1c1b2744b8dcbfaef2f2f7de02))
* frameless window with custom title bar ([7202ed0](https://github.com/bonzo81/comnd/commit/7202ed01dede71de3d248cf10bef0e2e74f0886d))
* **hosts:** replace connection manager with host screen ([6c37e75](https://github.com/bonzo81/comnd/commit/6c37e75f29cc41f0a9e79522d29ab41bf1231cee))
* **import:** emit tokens, preview before commit, token-aware viewer ([37ace60](https://github.com/bonzo81/comnd/commit/37ace6023d87fcc981ac23394b48fd557e81ba2e))
* **kb-import:** chunk large pages + tame stream logging ([d1c4b8a](https://github.com/bonzo81/comnd/commit/d1c4b8a54ee517f25a766967efb020a0464f089c))
* **kb-import:** paste-text mode, per-command categories, single progress modal ([32ec965](https://github.com/bonzo81/comnd/commit/32ec9653dc51d4e958b6f60a316f69db30d6bdab))
* **kb:** add non-destructive disable for commands ([f547b73](https://github.com/bonzo81/comnd/commit/f547b7347f93f225fc775d99b1642debf03bcc1b))
* **kb:** custom user-owned knowledge base with scoped LLM import ([503217b](https://github.com/bonzo81/comnd/commit/503217b4dd037eeb6d4845f3a86c890c80e15bf4))
* **kb:** grow linux-bash KB to 50 validated commands ([8c834d3](https://github.com/bonzo81/comnd/commit/8c834d3f5e871d1ebb7af7a331f6a282d1f262b8))
* **kb:** knowledge base store, viewer, and Ollama import ([e55d218](https://github.com/bonzo81/comnd/commit/e55d21841de48fefb4979510d18cf744af372e3f))
* **kb:** per-token help text in schema and UI ([b5029b5](https://github.com/bonzo81/comnd/commit/b5029b5bcac7ee8a771f614cc0c9bf81e989d847))
* **kb:** populate cisco-nxos, f5-tmos, linux-bash with token-backed commands ([5bccc15](https://github.com/bonzo81/comnd/commit/5bccc15313001bc68e96d77af1c8a7786d3a7c23))
* **kb:** populate flag/argument help for linux-bash commands ([5ce2181](https://github.com/bonzo81/comnd/commit/5ce21817bffdf20baee4d13874580842a4bac86f))
* **kb:** token schema validation and token-aware suggestion matching ([5d61c65](https://github.com/bonzo81/comnd/commit/5d61c655f4fec328cd2ee58fe5c21258823cb912))
* **log:** capture per-session SSH transcripts to file with settings toggles ([07f70cd](https://github.com/bonzo81/comnd/commit/07f70cdd14d2688809bd59c9dca8d1dd42ef0ece))
* **log:** unified logging with level, size cap, and arg forwarding ([9f17a1e](https://github.com/bonzo81/comnd/commit/9f17a1ef369682be45924db09f8e6b71f5562ab1))
* **nav:** add right-click context menu to host and group rows ([803d838](https://github.com/bonzo81/comnd/commit/803d838a2548273f5632e698655c43074e2f87dd))
* **nav:** inline rename for hosts and groups ([a0fc3a8](https://github.com/bonzo81/comnd/commit/a0fc3a83a2747e9ffc6a5e021cbfbfb598d4c5bd))
* **nav:** move host tree into nav panel, content area shows recent sessions ([be3e854](https://github.com/bonzo81/comnd/commit/be3e854886d6e99d888e08e891fadc64ce3890b0))
* **nav:** pointer-based drag reorder + reparent with lift-clone image ([809d6b5](https://github.com/bonzo81/comnd/commit/809d6b584836e8504b14041ea2bf016f14e26d45))
* **nav:** replace chevron with icons on section headers ([dbcae6a](https://github.com/bonzo81/comnd/commit/dbcae6a95efae2d98f1612cf688dc4fc079ccd33))
* **netbox:** mirror full geography hierarchy in nav tree ([34cfec7](https://github.com/bonzo81/comnd/commit/34cfec7dde07fd5c4a9eeedcdb20685b4f71175a))
* **netbox:** NetBox host source integration ([8873cbe](https://github.com/bonzo81/comnd/commit/8873cbee5417a0f20ffab8d16e300205816e6054))
* **netbox:** replace filter text inputs with searchable multi-select ([15ff6ff](https://github.com/bonzo81/comnd/commit/15ff6ffc2af96309630822e83bb95c1a0914bdba))
* **platforms:** scan KB roots for valid platforms ([3d8c5de](https://github.com/bonzo81/comnd/commit/3d8c5de7ece3e71402c23be01b84bfaabbbfc83c))
* **reading-comfort:** add dyslexia-friendly readability preset ([55a330a](https://github.com/bonzo81/comnd/commit/55a330a2a8b1e94d17ed9120ed5ace801e4ed5db))
* **replay:** add Command Replay with saved commands + variables ([875fa68](https://github.com/bonzo81/comnd/commit/875fa6853aa10851af4c08c4343ba0028cce6456))
* **settings:** add shortcuts pane with capture and validation ([a30c5d7](https://github.com/bonzo81/comnd/commit/a30c5d76107e9eb8e51db53e9ad211e0fe4c36c7))
* **settings:** add Theme settings section; tidy search box padding ([b72379d](https://github.com/bonzo81/comnd/commit/b72379d551818722d31ffbef66cabb99f82943d3))
* **settings:** custom log file location with fallback toast ([9ef4d80](https://github.com/bonzo81/comnd/commit/9ef4d80cf41222cb7e4fab2cf5a58207e83b30ed))
* **settings:** data export and restore (backup/restore zip) ([1c66fed](https://github.com/bonzo81/comnd/commit/1c66fed5001344855b5289bd5d9b683d8a13f919))
* **settings:** generalize Ollama settings to any LLM provider ([d4c422c](https://github.com/bonzo81/comnd/commit/d4c422c09e16dc2e9b0730b52348b45b3eeff63f))
* **settings:** move Ollama settings to dedicated settings view ([f625340](https://github.com/bonzo81/comnd/commit/f625340e1afeaca7f6d6ff13e84fdb7a0e3099ed))
* **shortcuts:** add new-connection and disconnect bindings ([5ff05fb](https://github.com/bonzo81/comnd/commit/5ff05fbe43478b91a864315a7f57d825b0ebb3da))
* **shortcuts:** add shortcut registry, matcher, and config overrides ([3969484](https://github.com/bonzo81/comnd/commit/396948402786451942602e72b06c039e5356dc55))
* **shortcuts:** drive help modal from registry, add status bar button ([4184313](https://github.com/bonzo81/comnd/commit/41843136bbfc20573f98b240fb4c90949c5f251d))
* **shortcuts:** user-definable keyboard shortcuts ([e2fc3ae](https://github.com/bonzo81/comnd/commit/e2fc3aeb5106b8e0f14a9305ba641cad52c0c6bb))
* **ssh:** max concurrent sessions limit with settings toggle ([4d46fe8](https://github.com/bonzo81/comnd/commit/4d46fe8b633301b1290b9025c317764e23d2b522))
* **statusbar:** click session item to return to terminal ([c8d2cf6](https://github.com/bonzo81/comnd/commit/c8d2cf60ac62b2f91f2ff8e492e8a66573d4a816))
* **storage:** harden local storage security and reliability ([7066845](https://github.com/bonzo81/comnd/commit/7066845b16f08cff92e58feaf05514cc281c9e75))
* **suggest:** ghost text + dropdown render next expected token ([5f9779b](https://github.com/bonzo81/comnd/commit/5f9779bc8bcab576721a16246ac8a55704395943))
* **suggest:** harden suggestion pipeline with echo re-sync and word accept ([66aafef](https://github.com/bonzo81/comnd/commit/66aafef39c5a9374053b4f60de6b664cb2b26e22))
* **suggest:** mode-aware suggestion engine, dropdown, command palette ([0f90273](https://github.com/bonzo81/comnd/commit/0f902737d6b2edc82fbc286cb5053a24f2cd179e))
* **suggest:** prefix commands (sudo/tmsh) + scrollback search ([9ccf058](https://github.com/bonzo81/comnd/commit/9ccf058b0e4ab99a80e5d66598a2c4890ee88f22))
* **tabs:** multi-session terminal tabs ([6f195a4](https://github.com/bonzo81/comnd/commit/6f195a43f2d322c0371fe6d6ef65af274611ff0f))
* **terminal:** add iTerm-style line timestamps ([f5fa801](https://github.com/bonzo81/comnd/commit/f5fa801d5bd9b569d2f658d70d70359c0df59f0d))
* **terminal:** add suggestion auto-show toggle (toolbar + Ctrl+Space) ([406d1c5](https://github.com/bonzo81/comnd/commit/406d1c55b27a02c5d00efec823a4719945eca70d))
* **terminal:** auto-copy selection, right-click menu, topbar tooltips ([ec70343](https://github.com/bonzo81/comnd/commit/ec70343e786ef28c13c29bc223ec81ce30563633))
* **terminal:** make side panel resizable ([64b9cf5](https://github.com/bonzo81/comnd/commit/64b9cf5d76f3efb32abad6511a856cfad4718659))
* **terminal:** resolve terminal shortcut bindings through registry ([57b5010](https://github.com/bonzo81/comnd/commit/57b5010707a96a098b7b65cdbb692f7b55a4f209))
* **terminal:** show reconnect banner on unexpected disconnect ([f76e4a6](https://github.com/bonzo81/comnd/commit/f76e4a65ed85e27cbba881ce45013fba6fc5007c))
* **terminal:** syntax highlighting for command output ([fde494b](https://github.com/bonzo81/comnd/commit/fde494b9c5332c51b1add0f0143d42c2fadd4376))
* **theme:** add Dracula, Monokai, Solarized Light, Nord app themes ([8de9d2b](https://github.com/bonzo81/comnd/commit/8de9d2b656c865e0120060908329d23267a62c36))
* **ui:** add app and terminal theme switchers ([a4866a8](https://github.com/bonzo81/comnd/commit/a4866a8f88a3757a429a16a18a93f491daca429b))
* **ui:** add global status bar with session count and theme toggle ([f15fa94](https://github.com/bonzo81/comnd/commit/f15fa94550a605c9aa4c85494e42dbbcb5659f90))
* **ui:** panel gutters, rounded borders, nav search box ([abdd648](https://github.com/bonzo81/comnd/commit/abdd64833ed2e734206cc418adf397cb2d3e162e))
* **ui:** per-folder hover actions, inline group creation, terminal icons ([b843f39](https://github.com/bonzo81/comnd/commit/b843f39764d417ef027d7bd4b11dbe9d182b7444))
* **ui:** replace tab bar with left nav panel ([641acf6](https://github.com/bonzo81/comnd/commit/641acf63bcbba743464d3a73821a7cf5ddf8dcce))


### Bug Fixes

* align tauri crate to 2.11 to match @tauri-apps/api 2.11.1 ([658819e](https://github.com/bonzo81/comnd/commit/658819eed91a68bf2dc9e7777251c0ca6ec5e1c4))
* **backup:** copy-based backup instead of rename to avoid locked-dir error ([0ba7c7a](https://github.com/bonzo81/comnd/commit/0ba7c7a9f67421ef7abcf4bd61b365f8ae7d88e5))
* **backup:** restrict self-restart to release builds ([a71cae1](https://github.com/bonzo81/comnd/commit/a71cae140dbe352480c6f1c66a760d8372c41872))
* **ci:** load commitlint configuration ([ec55b59](https://github.com/bonzo81/comnd/commit/ec55b59d8fc2de9d1537b6c9a423b0dcaf828cbb))
* **ci:** run commitlint job on pull requests only ([8645cae](https://github.com/bonzo81/comnd/commit/8645cae008576b18bed9c807bf8bea6435c5441b))
* **config:** unique keychain target in llm-key test ([5bb4979](https://github.com/bonzo81/comnd/commit/5bb497996a3405552894bee2ce5586d75c6e02b3))
* **connection:** reorder output pane below error in DOM per Must Have MH4 ([b44e274](https://github.com/bonzo81/comnd/commit/b44e274dd80f8e1200f68a71c803e820d6458116))
* gate test-only provider methods with #[cfg(test)] to silence dead-code warning ([069f3f6](https://github.com/bonzo81/comnd/commit/069f3f6953b5e87177e1ba906b8a507dac0056ab))
* **highlighter:** emit partial lines immediately in transform ([c57d699](https://github.com/bonzo81/comnd/commit/c57d699c4d462986b80ca492e9314a8160907b2d))
* **kb:** single-source platform index + save-time validation verdict ([17ed1c0](https://github.com/bonzo81/comnd/commit/17ed1c0c8b6cd57d83ae145179256ec4ae8839ea))
* **kb:** surface imported commands on non-Cisco platforms ([c5d3c5c](https://github.com/bonzo81/comnd/commit/c5d3c5cbb1897f51b678abb5a1a6f441155942ff))
* **log:** cap dependency crates at warn level ([b78e6c6](https://github.com/bonzo81/comnd/commit/b78e6c6c28b94570888a0a35d919c34e4a6d808d))
* **log:** error severity, single config read, redact preserves key ([a591200](https://github.com/bonzo81/comnd/commit/a591200bf361fc5746ed38e67f31747fec27abfd))
* **log:** write log file in dev builds, not just release ([a6eb161](https://github.com/bonzo81/comnd/commit/a6eb161ad0f0e49c000e817cdea6d76448655156))
* **nav:** add hover actions to All Hosts row ([5088993](https://github.com/bonzo81/comnd/commit/50889932fc28486017ce24f18ea1ab535c789840))
* **nav:** close context menu on row click and menu actions ([56cc6d4](https://github.com/bonzo81/comnd/commit/56cc6d4a70eb90e3c86b98ad00f7070853bfb376))
* **nav:** drag init race, pseudo-group drops, expand state, session dots ([97e094c](https://github.com/bonzo81/comnd/commit/97e094cb730e044870f2837d2c6d3bfec856aaf5))
* **nav:** headers only toggle accordion, sub-items switch view ([db19f18](https://github.com/bonzo81/comnd/commit/db19f189c8c69d274192abfd28815e9b9ebe762e))
* **nav:** independent section toggles with animated collapse/expand ([52cf452](https://github.com/bonzo81/comnd/commit/52cf45200f14724f58a1219fe2427e58438cafd3))
* **nav:** keep connections section open when opening a host ([526f863](https://github.com/bonzo81/comnd/commit/526f8637f202b6d9eaf89427d4ade5a5d4e07c9a))
* **nav:** nest root folders under All Hosts row ([2477fc5](https://github.com/bonzo81/comnd/commit/2477fc53ce3c7dfa1c5169f6ead8c0d6c7b202f1))
* **nav:** sync panel after host edits in form ([a47b52a](https://github.com/bonzo81/comnd/commit/a47b52af93f33c9fc7267a547f92fc2657c370b9))
* resolve clipping bugs and layout inconsistencies in settings screen ([20b0851](https://github.com/bonzo81/comnd/commit/20b08517d513b62d0b85bd5942dcfed772873f03))
* **robustness:** install panic hook to capture crashes in netsh.log ([04c359a](https://github.com/bonzo81/comnd/commit/04c359a2f2b159eb4139119240183ffccc8e8c83))
* **robustness:** remove panics from runtime IPC and init paths ([7694be4](https://github.com/bonzo81/comnd/commit/7694be46949fc554bde16db875f420434b26de3c))
* **search:** freeze on arrow keys, scope command search, settings toggle ([db92345](https://github.com/bonzo81/comnd/commit/db923451e7454e4e96abaa48c02abffcb4ce0702))
* **secrets:** return clean error when no SSH agent instead of pageant fallback ([3247c8d](https://github.com/bonzo81/comnd/commit/3247c8d1d42708dca23d36c9d12d0a3a1cac1114))
* **security:** harden IPC surface, TOFU, and import paths ([7acdc89](https://github.com/bonzo81/comnd/commit/7acdc89a8acd9d0dcf7be223dfab846840d64f13))
* **security:** validate host fields and show full SSH fingerprint ([d386578](https://github.com/bonzo81/comnd/commit/d386578ea97b75cc66c479ca9844ec02adad05b5))
* **settings:** apply layout review fixes per plan ([d1c8486](https://github.com/bonzo81/comnd/commit/d1c84862b2090d7b972373a76207ef454842f22e))
* **settings:** stabilize log file path tests ([bc7d09d](https://github.com/bonzo81/comnd/commit/bc7d09d5124f54c2543ccf533e1c1bdc06a609d7))
* **shortcuts:** guard reserved keystrokes in the matcher ([0e0b8ef](https://github.com/bonzo81/comnd/commit/0e0b8eff4dd1c05ea54481ae511039a56b63ac64))
* **ssh:** dedupe browser-auth URL opens per host across reconnects ([46a43e0](https://github.com/bonzo81/comnd/commit/46a43e0cbb1daa74452d697cd4d61d5f697d1263))
* **ssh:** race opening browser for Tailscale auth URL ([bc63b45](https://github.com/bonzo81/comnd/commit/bc63b45f591d03226e299a6aaf6d5cfa6f39f1e2))
* **ssh:** restore browser-auth, drop default-key attempts ([8109b20](https://github.com/bonzo81/comnd/commit/8109b205087e86148237c241bd6dbe7b1ef82b52))
* **ssh:** route all terminal output through Transcript module ([5abf89c](https://github.com/bonzo81/comnd/commit/5abf89c76df35c84506b8b48e26ca3c7ab8ecc57))
* start session id counter at Date.now() to avoid HMR collisions ([72d474b](https://github.com/bonzo81/comnd/commit/72d474b09932d85e0bbbdfbd2c995c9431e895d1))
* **suggest:** keep ghost text visible while typing ([869d0bc](https://github.com/bonzo81/comnd/commit/869d0bcaeb5280bf5038ad93a14dea75c7664ba3))
* **terminal:** inset screen from clip edges, drop suggestion bar ([b26847f](https://github.com/bonzo81/comnd/commit/b26847f1ce9eae6373a0bc7a610d168675cc1768))
* **terminal:** keep keyboard focus in terminal on toolbar clicks ([299cce0](https://github.com/bonzo81/comnd/commit/299cce079779f3f5021146319d5712c7eb24b76c))
* **terminal:** reconnect to existing session tab; guard pre-connect disconnects ([98a26f7](https://github.com/bonzo81/comnd/commit/98a26f7bedc0bb5bc69d188a8e59382e309509e8))
* **terminal:** sync theme across tabs, remove listener leak ([4b231e9](https://github.com/bonzo81/comnd/commit/4b231e9f6f027cca1d80795f83d4a0466afa094f))
* **terminal:** use monotonic counter for session IDs ([5a61513](https://github.com/bonzo81/comnd/commit/5a61513254aa6dd837ddea990b6139baf4159f4c))
* **ui:** action toast grid layout — action button below text, close top-right ([a3c0eae](https://github.com/bonzo81/comnd/commit/a3c0eaeac5207faee3148ed9ead808d9dd1b7bb6))
* **ui:** action toast overflow — wider max-width, wrap long messages ([a65027c](https://github.com/bonzo81/comnd/commit/a65027cb97f765ff12eff5e27f90b84cc32e430e))
* **ui:** layout consistency — dialogs, search rows, host rows, title-bar indicator ([143075a](https://github.com/bonzo81/comnd/commit/143075a408f0f9e03698b76a2b3c4bcab26acef1))
* **ui:** light-theme contrast, SVG icon set, toast aria ([97b71de](https://github.com/bonzo81/comnd/commit/97b71def5a2afe28e3b3fb988c8e38d277fe334e))


### Performance Improvements

* **ssh:** no global lock on the keystroke path ([bacc0d3](https://github.com/bonzo81/comnd/commit/bacc0d3eb6807eb5ab0cf109b310e6d6c74f73dc))
