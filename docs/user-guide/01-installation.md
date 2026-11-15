# Install Comnd

## System Requirements

| Platform | Minimum Version | Notes |
|---|---|---|
| Windows | Windows 10 (21H2) or later | x64 only. Windows 11 fully supported. |
| macOS | macOS 13 Ventura or later | Apple Silicon and Intel (separate builds). |
| Linux | glibc 2.34+ (Ubuntu 22.04, Debian 12, RHEL 9 or later) | AppImage, `.deb` or `.rpm`. Tested on Ubuntu 22.04 and Fedora 39. |

## Windows

Download `Comnd_<version>_x64-setup.exe` from GitHub Releases and run it. A Windows build produced this NSIS installer name. Replace `<version>` with the release version. You do not need administrator rights. The installer places the app in `%LOCALAPPDATA%\Programs\Comnd\` and creates a Start menu shortcut.

## macOS

Download the `.dmg` asset for your Mac (`aarch64` for Apple Silicon, `x64` for Intel) from GitHub Releases. Drag Comnd into your Applications folder. On first launch, macOS Gatekeeper can block the app. Right-click (or Control-click) the icon in Launchpad and choose **Open** to allow it once. The app is a single `.app` bundle with everything it needs inside. The app has no extra dependencies.

## Linux

Comnd ships three Linux formats. Pick the one that matches how you want to run it.

### AppImage (portable, no install)

Download the `.AppImage` asset from GitHub Releases, make it executable, and run it:

```bash
chmod +x Comnd_<version>_amd64.AppImage
./Comnd_<version>_amd64.AppImage
```

The AppImage is portable. You can run it from a USB stick without installing anything, and it is the only Linux format Comnd can update by itself (see [Updates](#updates)).

It bundles its own GTK 3 and WebKitGTK, so the library versions your distro ships do not matter. Two things are taken from your system: `libwayland-client.so.0` and glibc. Any GTK 3 desktop has both at a usable version.

### Debian / Ubuntu (`.deb`)

Download the `.deb` asset and install it:

```bash
sudo apt install ./Comnd_<version>_amd64.deb
```

This registers a desktop entry, so Comnd appears in your application menu. Upgrade by downloading the next `.deb` and repeating the command, or through whatever tool manages `.deb` files on your machine.

### Fedora / RHEL (`.rpm`)

Download the `.rpm` asset and install it:

```bash
sudo dnf install ./Comnd-<version>-1.x86_64.rpm
```

The `.rpm` is built with dependencies on `webkit2gtk4.1` and `gtk3`; `dnf` installs them if they are missing. Upgrade by installing the next release's `.rpm`.

These packages use the WebKitGTK and GTK 3 that your distribution provides rather than carrying their own copies, so the app is a few megabytes instead of a few hundred.

### Blank window on startup

If an AppImage window appears with nothing drawn in it, the cause is almost always `libwayland-client.so.0`. An older AppImage build could bundle a copy that its own EGL driver then refused. The fix is to prefer your system's copy:

```bash
LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libwayland-client.so.0 ./Comnd_<version>_amd64.AppImage
```

Better: use a release built after this was fixed (0.6.1 and later), or use the `.deb`/`.rpm`, which never contains the bundled copy.

## First Launch

The app opens directly to the Connection Manager with an empty host list. You can connect immediately (see [Getting Started](02-getting-started.md)). Or open the Knowledge Base tab and browse available commands before you connect.

## Updates

Comnd checks for updates automatically when the app starts. When a newer version is available, a download icon appears in the title bar (top-right, next to the window controls). You can also check manually at any time: open **Settings → General** and click **Check for updates**. The status line below the button shows the result ("You're up to date.", an available version, or an error).

- **Windows** — click the title bar icon and Comnd downloads the update, installs it, and restarts itself. Your saved hosts, groups, settings, and knowledge base are kept across the upgrade.
- **Linux AppImage** — the same one-click update: Comnd replaces the AppImage file in place and restarts. The file must be somewhere you can write to, and it must be a real AppImage rather than a `.deb` or `.rpm` install.
- **Linux `.deb` / `.rpm`** — clicking the icon opens the latest release on GitHub instead. Download the new package and install it; your distribution records the upgrade. A package in `/usr` cannot be replaced by the app itself.
- **macOS** — clicking the icon opens the latest release on GitHub instead. Download the `.dmg` from there and drag Comnd over the existing app. macOS does not allow the app to replace itself silently until the build is notarized, so manual updates remain for now.

Until code signing ships (see the roadmap), each new version still triggers Windows SmartScreen or macOS Gatekeeper on first launch after an update — approve it once and the warning stops.
