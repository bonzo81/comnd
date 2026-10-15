# Installation

## System Requirements

| Platform | Minimum Version | Notes |
|---|---|---|
| Windows | Windows 10 (21H2) or later | x64 only. Windows 11 fully supported. |
| macOS | macOS 13 Ventura or later | Apple Silicon and Intel. Universal binary. |
| Linux | Any distro with glibc 2.31+ | Tested on Ubuntu 22.04, Fedora 39, Arch. |

## Windows

Download the `netssh-setup-x64.exe` installer from GitHub Releases. Double-click to run it. You do not need administrator rights unless your organization requires them for MSI installs. The installer places the app in `%LOCALAPPDATA%\Programs\netssh\` and creates a Start menu shortcut.

Alternative: download the `netssh-x64-portable.zip`. Extract it anywhere and run `net-sh.exe` directly. The file makes no registry entries and needs no install step.

## macOS

Download the `netssh-macos.dmg`. Drag netssh into your Applications folder. On first launch, macOS Gatekeeper can block the app. Right-click (or Control-click) the icon in Launchpad and choose **Open** to allow it once. The app is a single `.app` bundle with everything it needs inside. The app has no extra dependencies.

## Linux

Three options:

- **AppImage** (`netssh-x86_64.AppImage`) — recommended. Make the file executable with `chmod +x`, then run it. The AppImage is fully portable. You can run it from a USB stick without installing anything.
- **`.deb` package** — for Debian/Ubuntu. Run `sudo dpkg -i netssh_*.deb` or install it via your GUI package manager.
- **`.rpm` package** — for Fedora/RHEL. Run `sudo rpm -i netssh_*.rpm`.

The app bundles everything it needs. No additional dependencies are required.

## First Launch

The app opens directly to the Connection Manager with an empty host list. You can connect immediately (see [Getting Started](02-getting-started.md)). Or open the Knowledge Base tab and browse available commands before you connect.

## Updates

netssh checks for updates automatically when the app starts. When a newer version is available, a download icon appears in the title bar (top-right, next to the window controls). You can also check manually at any time: open **Settings → General** and click **Check for updates**. The status line below the button shows the result ("You're up to date.", an available version, or an error).

- **Windows and Linux** — click the title bar icon and netssh downloads the update, installs it, and restarts itself. Your saved hosts, groups, settings, and knowledge base are kept across the upgrade.
- **macOS** — clicking the icon opens the latest release on GitHub instead. Download the `.dmg` from there and drag netssh over the existing app. macOS does not allow the app to replace itself silently until the build is notarized, so manual updates remain for now.

Until code signing ships (see the roadmap), each new version still triggers Windows SmartScreen or macOS Gatekeeper on first launch after an update — approve it once and the warning stops.
