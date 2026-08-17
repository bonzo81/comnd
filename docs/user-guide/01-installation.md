
## System Requirements

- **Windows:** 10 or later (64-bit)
- **macOS:** 12 Monterey or later (Intel and Apple Silicon)
- **Linux:** Tested on Ubuntu 22.04+, Fedora 38+, Arch Linux
- **Disk space:** 200MB free
- **Display:** net.sh uses your operating system's built-in web rendering engine — no separate browser or web engine to install

## Downloads

All releases are published on [GitHub Releases](https://github.com/bonzo81/netsh/releases).

| Platform | Package |
|----------|---------|
| Windows  | `.msi` installer |
| macOS    | `.dmg` disk image |
| Linux    | `.AppImage`, `.deb`, or `.rpm` |

Grab the package that matches your operating system. No account or sign-up needed.

## Windows

1. Download the `.msi` installer from the releases page.
2. Double-click the installer and follow the prompts.
3. Once finished, launch **net.sh** from the Start menu.

The installer puts the app in `%LOCALAPPDATA%\Programs\netsh`. No admin rights required unless your organisation enforces them for MSI installs.

## macOS

1. Download the `.dmg` from the releases page.
2. Double-click to mount the disk image.
3. Drag the **net.sh** icon into the Applications folder.
4. On first launch, macOS Gatekeeper may block the app. Open **System Settings → Privacy & Security** and click **Open Anyway**, or right-click the app and select **Open**.

The app is a single `.app` bundle with everything it needs inside. No extra dependencies to install.

## Linux

**AppImage** (works on any distro):

```bash
chmod +x net-sh_*.AppImage
./net-sh_*.AppImage
```

**Debian/Ubuntu:**

```bash
sudo dpkg -i net-sh_*.deb
```

**Fedora/RHEL:**

```bash
sudo rpm -i net-sh_*.rpm
```

The AppImage is fully portable — you can run it from a USB stick without installing anything. The `.deb` and `.rpm` packages integrate with your system's package manager so updates are easier to manage. No additional dependencies — the app bundles everything it needs.

## First Launch

The app opens straight to the Connection Manager. From there you can add hosts, import an SSH config, or jump into a quick-connect session.

See [Getting Started](02-getting-started.md) for a walkthrough of the interface and your first connection.

## Updates

The app checks for new releases when it starts and lets you know if one is available. Automatic updating is planned but not yet implemented. For now, download the latest package from [GitHub Releases](https://github.com/bonzo81/netsh/releases) and install it over the existing version — your saved hosts and settings are preserved across upgrades.

## Next Steps

- [Getting Started](02-getting-started.md) — interface overview and your first SSH session
- [Connecting to Devices](03-connecting-to-devices.md) — platform-specific connection details
- [Security](09-security.md) — how credentials and keys are handled
- [Troubleshooting](10-troubleshooting.md) — common issues and fixes
