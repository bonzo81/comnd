# Installation

## System Requirements

| Platform | Minimum Version | Notes |
|---|---|---|
| Windows | Windows 10 (21H2) or later | x64 only. Windows 11 fully supported. |
| macOS | macOS 13 Ventura or later | Apple Silicon and Intel. Universal binary. |
| Linux | Any distro with glibc 2.31+ | Tested on Ubuntu 22.04, Fedora 39, Arch. |

## Windows

Download the `netsh-setup-x64.exe` installer from GitHub Releases. Double-click to run it. You do not need administrator rights unless your organization requires them for MSI installs. The installer places the app in `%LOCALAPPDATA%\Programs\net.sh\` and creates a Start menu shortcut.

Alternative: download the `netsh-x64-portable.zip`. Extract it anywhere and run `net-sh.exe` directly. The file makes no registry entries and needs no install step.

## macOS

Download the `netsh-macos.dmg`. Drag net.sh into your Applications folder. On first launch, macOS Gatekeeper can block the app. Right-click (or Control-click) the icon in Launchpad and choose **Open** to allow it once. The app is a single `.app` bundle with everything it needs inside. The app has no extra dependencies.

## Linux

Three options:

- **AppImage** (`netsh-x86_64.AppImage`) — recommended. Make the file executable with `chmod +x`, then run it. The AppImage is fully portable. You can run it from a USB stick without installing anything.
- **`.deb` package** — for Debian/Ubuntu. Run `sudo dpkg -i netsh_*.deb` or install it via your GUI package manager.
- **`.rpm` package** — for Fedora/RHEL. Run `sudo rpm -i netsh_*.rpm`.

The app bundles everything it needs. No additional dependencies are required.

## First Launch

The app opens directly to the Connection Manager with an empty host list. You can connect immediately (see [Getting Started](02-getting-started.md)). Or open the Knowledge Base tab and browse available commands before you connect.

## Updates

net.sh is distributed through GitHub Releases. For now, download the latest package from GitHub Releases and install it over the existing version. Your saved hosts and settings remain after the upgrade.
