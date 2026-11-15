# 022. Linux AppImages stop bundling libwayland-client, and .deb/.rpm ship alongside

Date: 2026-11-15
Status: Accepted

## Context

The 0.6.0 AppImage opens a blank window on a current desktop. Only the window
frame appears: no Connection Manager, no error, no crash. The log ends with

```
Could not create default EGL display: EGL_BAD_PARAMETER. Aborting...
```

The main process stays alive and the WebKitGTK web-content process dies, so the
window survives with nothing painted in it. ADR-006's updater is not involved —
the same file fails on first launch.

**What the bundler produces.** `tauri-bundler` does not ship its own linuxdeploy.
`prepare_tools()` (`crates/tauri-bundler/src/bundle/linux/linuxdeploy.rs:226-240`)
downloads one from `https://github.com/tauri-apps/binary-releases/releases/download/linuxdeploy/linuxdeploy-x86_64.AppImage`
— a fork published **2022-07-14** and re-uploaded unchanged in 2024. That
fork's embedded excludelist carries `libdrm.so.2`, `libEGL.so.1`, `libgbm.so.1`
and `libGL.so.1` but **not** `libwayland-client.so.0`, so the build copies
Ubuntu 22.04's 1.20 library into the AppImage. Current upstream linuxdeploy
excludes it, as does `pkg2appimage`'s excludelist (citing Mesa issue 11316).

**Why one stale library blanks the window.** `libEGL_mesa.so.0` links
`libwayland-client.so.0` directly, and Mesa's EGL implementation must agree with
the compositor's client library. The bundled 1.20 copy wins over the host's
because the AppImage runtime puts its own `lib` first, so on any distro whose
Mesa is built against a newer wayland-client, `eglGetDisplay(EGL_DEFAULT_DISPLAY)`
returns `EGL_NO_DISPLAY` and WebKitGTK aborts.

**Measured, on real builds.** A 20-line libEGL-only probe reproduces the failure
without the app:

| Probe input | Result |
|---|---|
| Host `libwayland-client` | `EGL 1.5 initialised` |
| Ubuntu 22.04's 1.20 copy (LD_PRELOAD) | `EGL_NO_DISPLAY` |
| The AppImage's bundled copy (LD_PRELOAD) | `EGL_NO_DISPLAY` |

Two real 0.6.0 AppImages were then built in an `ubuntu:22.04` container matching
the release job's toolchain (rustc 1.100.0, Node 22.14.0, webkit2gtk-4.1 2.50.4,
gtk+-3.0 3.24.33). They differ only in the linuxdeploy binary used:

| Build | Libraries | `libwayland-client.so.0` | Launch |
|---|---|---|---|
| Control (bundler's 2022 fork) | 166 | bundled | **blank window**, 3/3 runs |
| Fixed (current linuxdeploy) | 165 | absent, host-provided | **loads**, 3/3 runs |

The difference between the two trees is exactly one file. A synthetic AppDir run
of each linuxdeploy against the same inputs gives 149 vs 148 libraries with the
same single-file diff, so the mechanism is the excludelist and nothing else.

**A retraction.** An earlier investigation concluded that the bundled
WebKitGTK 2.50.4 (vs a host 2.52.4) was at fault and recommended shipping no
bundled WebKit/GTK. That was wrong: swapping only the bundled WebKit for the
system one on top of the otherwise-unchanged bundle still launched, and swapping
only `libwayland-client.so.0` fixed it. Bundling WebKit is what makes the
AppImage work on distros older than its build host, and it stays.

**`.deb` and `.rpm` do not exist.** The only Linux artifact is the AppImage, so
a user on a distro with a package manager installs nothing and gets no menu
entry, no desktop file registration and no way to satisfy the package
dependencies their distro already tracks.

## Options

- **Repack the finished AppImage, deleting the library.** Cost: the AppImage's
  minisign signature is computed from the file, so repacking breaks the
  `latest.json` signature unless the artifact is re-signed in CI. Works, but it
  adds a step that must stay ordered after signing and is easy to get wrong.
- **Patch `tauri-bundler` or vendor a fork.** Cost: carrying a patched Rust
  dependency for a one-line excludelist difference.
- **Pass linuxdeploy an exclusion flag.** Cost: not available. Tauri's
  `AppImageConfig` exposes only `bundleMediaFramework` and `files`; there is no
  library-exclusion knob, and its linuxdeploy invocation already targets
  upstream's interface (`--plugin gtk`, `--output appimage`).
- **Seed the tool path before the build.** `prepare_tools()` downloads only
  `if !linuxdeploy.exists()`, and the path resolves to
  `dirs::cache_dir()/tauri/linuxdeploy-x86_64.AppImage`
  (`settings.local_tools_directory()` is honoured only when
  `bundle.useLocalToolsDir` is set, which this repo does not set). Writing the
  desired binary there suppresses the fork download entirely.
- **Keep the AppImage only.** Cost: leaves Linux without a distro-native
  install path, and the blank-window defect stays.

## Decision

**Seed linuxdeploy in the release job** (`.github/workflows/release.yml`). On the
Linux matrix leg only, before `tauri-action@v1`, the workflow downloads
`linuxdeploy` tag `1-alpha-20251107-1` to
`~/.cache/tauri/linuxdeploy-x86_64.AppImage` and marks it executable. The
pinned tag's excludelist contains `libwayland-client.so.0`, so the AppImage stops
bundling it. The build log shows no linuxdeploy download once the seed is in
place, which is the observable proof the fork was bypassed.

Seeding is preferred over repacking because the signature is produced from the
artifact the bundler writes; nothing downstream of signing is touched.

**Ship `.deb` and `.rpm` too** (`src-tauri/tauri.linux.conf.json` targets
`["appimage", "deb", "rpm"]`). They are ordinary distro packages: they depend on
the system `libwebkit2gtk-4.1-0` and `libgtk-3-0` rather than carrying a
245 MB `usr/lib` payload, and they register a desktop entry through `dpkg`/`rpm`.

**A package install cannot update itself.** Tauri's Linux updater replaces an
AppImage in place, which needs the `$APPIMAGE` path its runtime sets; a `.deb` or
`.rpm` install lives under `/usr`. The new `running_as_appimage` command reports
the launch channel, and `src/lib/updater.ts` sends a non-AppImage Linux install
to the release page — the same landing place macOS already uses under ADR-006 —
so those users are never offered an install that cannot work. The check runs
inside `checkForUpdatesNow()`, before an update can be found, so the indicator's
label and its click agree.

## Consequences

- Easier: the AppImage runs on any GTK3 desktop, not only one matching Ubuntu
  22.04's wayland stack. Linux users get a menu entry and a package-managed
  upgrade path.
- Harder: `libwayland-client.so.0` is now a host dependency. Everything bundled
  that links it — `libgdk-3.so.0`, the bundled `libwebkit2gtk-4.1.so.0`,
  `libgstgl-1.0.so.0`, `libwayland-cursor.so.0`, `im-wayland.so` — needs it
  present, which any GTK3 desktop satisfies. The other wayland-family libraries
  (`libwayland-cursor`, `libwayland-egl`, `libwayland-server`) and `libxkbcommon`
  stay bundled; the fixed tree was verified to launch with them in place.
- Real minimum is **glibc 2.34** (the shipped binary's highest required symbol
  version), i.e. Ubuntu 22.04, Debian 12 and RHEL 9 or later. Earlier docs
  claimed 2.31, which was wrong.
- Rules out: repacking or re-signing the AppImage after build, and any patched
  `tauri-bundler`.
- Guarded, not automated: nothing fails the build if the bundled library
  returns. The check is a launch smoke test against a host with a newer Mesa,
  and the visual reference captures under `test/smoke/` do not exercise EGL
  selection. A build-time assertion would need the extracted AppDir, which the
  bundler deletes.
- Unverified: `.deb`/`.rpm` dependency resolution has been checked only by
  building on Ubuntu 22.04 and reading the generated metadata, not by installing
  on Fedora or RHEL.
- Revisit when `tauri-bundler` moves off the 2022 fork. At that point the seed
  step is dead weight and should be deleted rather than updated.
- Related: ADR-006 covers the update channel and signing. It is unchanged except
  that its "Linux updates in place" statement now applies only to AppImages.
