# Security

## Credential Storage

Passwords and SSH key passphrases are never written to app settings files. The app stores them in the secure credential store of your operating system:

| OS | Backend |
|---|---|
| Windows | Credential Manager |
| macOS | Keychain |
| Linux | libsecret (the keychain service used by GNOME and KDE) |

The app requests credentials from the keychain when you connect, and does not keep them in memory once the SSH session is established. If you need to review or remove a saved credential, use your OS keychain manager — Comnd does not duplicate that interface.

You choose which credentials to save. When adding a host, you can enter a password each session instead of storing it.

## SSH Keys

Comnd references private keys by file path only. It never copies, imports, or stores your key file contents.

**Supported formats:** OpenSSH and PEM (via the `russh` SSH library). PKCS#8 is not yet supported.

**Passphrase-protected keys:** When you connect with a passphrase-protected key, you are prompted for the passphrase. You can optionally save the passphrase in the OS keychain. If you decline, you will be asked again on each connection.

**Agent forwarding is not supported.** The app connects directly. It does not forward your local SSH agent.

## Host Key Verification

Comnd uses a trust-on-first-use (TOFU) model for SSH host keys. You verify the device the first time. After that, the app checks the key automatically. This is independent of the system `known_hosts` file.

**First connection to a host:**
You see the host key fingerprint and are asked to accept or reject it. The fingerprint is shown in SHA256 format.

**Subsequent connections:**
Comnd verifies the key automatically against the stored copy. No prompt appears if the key matches.

**Key change detected:**
If the host presents a different key, the connection is blocked and you see a warning:

> The host key has changed. This can indicate a man-in-the-middle attack.

Both the old and new fingerprints are displayed side by side. You must explicitly accept the new key or abort. There is no automatic fallback.

**Known hosts storage:** Host keys are stored in the app data directory as JSON, separate from the system `known_hosts` file. This avoids interfering with other SSH tools on your machine.

## Network & Privacy

**No telemetry.** Comnd sends zero usage data, crash reports, or analytics anywhere. There is nothing to opt out of because there is no tracking built in.

**No cloud sync.** All data stays local on your device: saved hosts, credentials, settings, and the knowledge base. There is no account system, no backend service, and no network activity except the SSH connections you initiate.

**No bundled browser engine.** The app renders its interface with the web engine built into your operating system. Compared to embedding a full browser, this leaves fewer components that can be exploited.

**Knowledge base updates (future):** When automatic KB updates are implemented, each update is verified by checksum before it is applied. A checksum is a fingerprint that confirms the file has not been tampered with. The KB ships bundled with the app and remains your baseline.

## Data Storage Reference

| Data | Location |
|---|---|
| Saved hosts (hostname, IP, port, key path) | App data directory (see platform paths below) |
| Passwords and key passphrases | OS keychain |
| SSH private keys | Your filesystem (referenced by path, never copied) |
| Known host keys | App data directory (JSON) |
| Knowledge base | Bundled with the app. User-editable copy in the app data directory |
| User preferences | App data directory (JSON) |

**App data directory by platform:**

| Platform | Path |
|---|---|
| Windows | `%LOCALAPPDATA%\com.comnd.app\` |
| macOS | `~/Library/Application Support/com.comnd.app/` |
| Linux | `$XDG_DATA_HOME/com.comnd.app/` or `~/.local/share/com.comnd.app/` |

## What This Means

- No plaintext credentials in app files, ever.
- If someone has access to your OS keychain, they already have access to everything — Comnd does not add risk beyond that baseline.
- If the host key of a device changes unexpectedly, you will know before you type anything.
- Nothing leaves your machine unless you open an SSH connection.

See [Connecting to Devices](03-connecting-to-devices.md) for the connection workflow and [Getting Started](02-getting-started.md) if you are new to Comnd.
