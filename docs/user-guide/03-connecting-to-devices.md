## Connection Flow

When you click **Connect** on a saved host, here's what happens step by step:

1. **TCP connection** opens to the target host and port — this is the basic internet connection to the device.
2. **Host key verification**: first connection prompts you to accept the fingerprint; known hosts are verified automatically.
3. **Authentication**: password, SSH key, or keyboard-interactive, depending on the host's saved settings.
4. **Terminal session opens**: the terminal view goes live and you can start sending commands and seeing responses.

Progress is shown step by step during connection. You can cancel at any stage before the session opens.

A background keepalive (like a regular "are you still there?" ping) runs automatically to prevent firewalls and network equipment from dropping idle connections.

## Authentication Methods

net.sh supports three authentication methods. The one used depends on what you configured when saving the host (see [Getting Started](02-getting-started.md)).

### Password

Passwords are stored in your operating system's secure credential store, never in application files or config. You type the password once when saving a host; net.sh retrieves it automatically on every subsequent connection.

| Platform | Where your passwords are stored |
|----------|-------------------------------|
| Windows  | Credential Manager |
| macOS    | Keychain |
| Linux    | libsecret (the keychain system used by GNOME and KDE) |

If the password changes on the device side, update it in the host's settings (**Edit Host** from the connection manager).

### SSH Key

You select a private key file from your filesystem when configuring the host. net.sh stores only the file path — it never copies or moves the key. Both **OpenSSH** and **PEM** formats are supported.

**Passphrase-protected keys:** When connecting, you'll be asked for the passphrase. You can optionally save it in the OS keychain so future connections don't ask again. The passphrase is stored alongside other credentials and never written to disk.

If authentication fails (wrong key, wrong passphrase, or key not found at the stored path), net.sh shows an error banner with the reason and a **Retry** button.

### Keyboard-Interactive

Many network devices (Cisco switches and routers, F5 BIG-IP appliances) use a multi-step login process instead of a simple password prompt. Instead of one `Password:` field, the device might ask several questions — this is called keyboard-interactive authentication.

net.sh handles this automatically:
- If the challenge looks like a standard password prompt, net.sh responds with the stored password.
- If the device asks something unexpected (for example, a custom banner or a secondary authentication step), net.sh shows a dialog box so you can type the required information manually.

You don't need to configure anything special to enable keyboard-interactive support. It's active for all connections.

### Browser Authentication (Tailscale-style)

Some hosts (e.g. Tailscale SSH in check mode) require you to authenticate via a web browser before SSH access is granted. When this happens, net.sh automatically detects the authentication URL in the server's banner or keyboard-interactive instructions and opens it in your default browser.

The connection overlay shows the URL and provides an **Open again** button if you need to re-open it. Once you complete authentication in the browser, the connection usually proceeds on its own — the server holds it open while you authenticate. If it times out instead, click **Retry**: you're already authenticated, so the retry connects immediately.

## Host Key Verification

net.sh uses a **trust-on-first-use** (TOFU) model for host keys. Think of it like meeting someone for the first time — you check their ID, and after that you recognise them by sight.

### First Connection

Before the connection proceeds, the app displays the host's SSH key fingerprint. You must explicitly accept it. This confirms that you trust the remote device is who it claims to be.

### Subsequent Connections

On every later connection, the stored key is checked automatically. If it matches, the connection proceeds without any prompt.

### Host Key Changed

If a previously-saved host key no longer matches, net.sh blocks the connection and shows a warning:

> Host key has changed. This could indicate a man-in-the-middle attack.

Both the old key fingerprint and the new one are displayed side by side. You can:

- **Accept the new key** — appropriate when you know the device was replaced, re-imaged, or had its SSH keys regenerated.
- **Abort the connection** — the safe default if the change is unexpected.

If you accept the new key, it replaces the old one in the known hosts store.

Known host keys are stored in the app's data directory (not in your system `known_hosts` file). This keeps net.sh's host verification separate from other SSH clients on your system.

## Error Scenarios

| Scenario | What you see | What to do |
|---|---|---|
| Wrong password or rejected key | Error banner with reason; **Retry** button visible | Update credentials in host settings, or retry if you mistyped |
| Host unreachable (timeout) | Timeout overlay after ~10 seconds; **Retry** button visible | Check the host address, port, and network connectivity |
| Host key changed | Blocking MITM warning; old and new keys shown | Verify with the device administrator before accepting the new key |
| Mid-session disconnect | "Disconnected" overlay; terminal frozen; last output preserved | Check network; click **Reconnect** to re-establish the session |
| Keyboard-interactive challenge unrecognised | Dialog box prompting for manual input | Enter the information the device is asking for |

## Disconnecting

Three ways to end a session:

- Type `exit` in the terminal. This runs the exit command on the remote device for a clean session close.
- Press `Ctrl+Shift+W`. This closes the active tab (with confirm) and disconnects the session.
- Click the `×` on the tab. Same behaviour as `Ctrl+Shift+W`.

After disconnecting, the host remains in the connection manager. Press `Enter` to reconnect.

## Next Steps

- [Terminal & Suggestions](04-terminal-and-suggestions.md): typing commands and using inline suggestions
- [Security](09-security.md): credential and key storage details
- [Troubleshooting](10-troubleshooting.md): common connection issues and fixes
