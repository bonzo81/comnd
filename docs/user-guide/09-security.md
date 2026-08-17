## Credential Storage

Passwords and SSH key passphrases are never written to app config files. They go directly to your operating system's secure credential store:

| OS | Backend |
|---|---|
| Windows | Credential Manager |
| macOS | Keychain |
| Linux | libsecret (the keychain service used by GNOME and KDE) |

The app requests credentials from the keychain when you connect, and doesn't keep them in memory once the SSH session is established. If you need to review or remove a saved credential, use your OS keychain manager — net.sh doesn't duplicate that interface.

You choose which credentials to save. When adding a host, you can enter a password each session instead of storing it.

## SSH Keys

net.sh references private keys by file path only. It never copies, imports, or stores your key file contents.

**Supported formats:** OpenSSH and PEM (via the `russh` SSH library). PKCS#8 is not yet supported.

**Passphrase-protected keys:** When you connect with a passphrase-protected key, you're prompted for the passphrase. You can optionally save the passphrase in the OS keychain. If you decline, you'll be asked again on each connection.

**Agent forwarding is not supported.** The app connects directly; it doesn't forward your local SSH agent.

## Host Key Verification

net.sh uses a trust-on-first-use (TOFU) model for SSH host keys — you verify the device the first time, and after that it's checked automatically. This is independent of your system's `known_hosts` file.

**First connection to a host:**
You see the host key fingerprint and are asked to accept or reject it. The fingerprint is shown in SHA256 format.

**Subsequent connections:**
The host's key is verified automatically against the stored copy. No prompt appears if the key matches.

**Key change detected:**
If the host presents a different key, the connection is blocked and you see a warning:

> The host key has changed. This could indicate a man-in-the-middle attack.

Both the old and new fingerprints are displayed side by side. You must explicitly accept the new key or abort. There is no automatic fallback.

**Known hosts storage:** Host keys are stored in the app data directory as JSON, separate from the system `known_hosts` file. This avoids interfering with other SSH tools on your machine.

## Network & Privacy

**No telemetry.** net.sh sends zero usage data, crash reports, or analytics anywhere. There is nothing to opt out of because there's no tracking built in.

**No cloud sync.** All data stays local on your device: saved hosts, credentials, settings, and the knowledge base. There is no account system, no backend service, and no network activity except the SSH connections you initiate.

**No bundled browser engine.** The app uses your operating system's built-in web rendering engine for its interface. This means a smaller attack surface — fewer components that could be exploited — compared to embedding a full browser.

**Knowledge base updates (future):** When automatic KB updates are implemented, updates will be verified by checksum (a fingerprint that confirms the file hasn't been tampered with) before being applied. The KB ships bundled with the app and remains your baseline.

## Data Storage Reference

| Data | Location |
|---|---|
| Saved hosts (hostname, IP, port, key path) | App data directory (see platform paths below) |
| Passwords and key passphrases | OS keychain |
| SSH private keys | Your filesystem (referenced by path, never copied) |
| Known host keys | App data directory (JSON) |
| Knowledge base | Bundled with app; user-editable copy in app data directory |
| User preferences | App data directory (JSON) |

**App data directory by platform:**

| Platform | Path |
|---|---|
| Windows | `%APPDATA%\netsh\` |
| macOS | `~/Library/Application Support/netsh/` |
| Linux | `~/.config/netsh/` |

## What This Means

- No plaintext credentials in config files, ever.
- If someone has access to your OS keychain, they already have access to everything — net.sh doesn't add risk beyond that baseline.
- If a device's host key changes unexpectedly, you'll know before you type anything.
- Nothing leaves your machine unless you open an SSH connection.

See [Connecting to Devices](03-connecting-to-devices.md) for the connection workflow and [Getting Started](02-getting-started.md) if you're new to net.sh.
