# Connecting to Devices

## Connection Flow

When you click **Connect** on a saved host, the app follows these steps:

1. **TCP connection** opens to the target host and port — this is the basic internet connection to the device.
2. **Host key verification**: on the first connection, the app asks you to accept the fingerprint. The app verifies known hosts automatically.
3. **Authentication**: password, SSH key, or keyboard-interactive, depending on the settings that you saved for the host.
4. **Terminal session opens**: the terminal view goes live and you can start sending commands and seeing responses.

The app shows progress step by step during the connection. You can cancel at any stage before the session opens.

A background keepalive (a regular "are you still there?" ping) runs automatically to stop firewalls and network equipment from dropping idle connections.

## Authentication Methods

netssh supports several authentication methods. The method depends on the settings that you saved for the host (see [Getting Started](02-getting-started.md)).

### Password

netssh stores passwords in the secure credential store of your operating system. The app never writes passwords to application files. You type the password once, when you save the host. After that, netssh retrieves it automatically for every connection.

| Platform | Where your passwords are stored |
|----------|-------------------------------|
| Windows  | Credential Manager |
| macOS    | Keychain |
| Linux    | libsecret (the keychain system used by GNOME and KDE) |

If the password changes on the device side, update it in the host settings (**Edit Host** from the connection manager).

### SSH Key

You select a private key file from your filesystem when you configure the host. netssh stores only the file path — it never copies or moves the key. Both **OpenSSH** and **PEM** formats are supported.

**Passphrase-protected keys:** When you connect, the app asks you for the passphrase. You can save the passphrase in the OS keychain. Then future connections do not ask again. The passphrase is stored with your other credentials and never written to disk.

If authentication fails, netssh shows an error banner. The banner names the reason (a wrong key, a wrong passphrase, or a missing key file) and offers a **Retry** button.

### Keyboard-Interactive

Many network devices (Cisco switches and routers, F5 BIG-IP appliances) use a multi-step login process instead of a simple password prompt. Instead of one `Password:` field, the device can ask several questions. This process is called keyboard-interactive authentication.

netssh handles this automatically:

- If the challenge looks like a standard password prompt, netssh responds with the stored password.
- If the device asks something unexpected (a custom banner or a secondary authentication step), netssh shows a dialog box. You type the required information manually.

You do not need to configure anything special. Keyboard-interactive support is active for all connections.

### Browser Authentication (Tailscale-style)

Some hosts (for example, Tailscale SSH in check mode) require you to authenticate via a web browser before SSH access is granted. When this happens, netssh detects the authentication URL in the server banner or in the keyboard-interactive instructions. The app opens the URL in your default browser.

The connection overlay shows the URL and provides an **Open again** button if you need to re-open it. After you complete authentication in the browser, the connection usually continues on its own. The server keeps the connection open while you authenticate. If the connection times out instead, click **Retry**. You are already authenticated, so the retry connects immediately.

## Host Key Verification

netssh uses a **trust-on-first-use** (TOFU) model for host keys. This works like meeting someone for the first time. You check their ID once. After that, you recognize them by sight.

### First Connection

Before the connection proceeds, the app displays the SSH key fingerprint for the host. You must accept the fingerprint explicitly. This acceptance tells netssh that you trust this remote device.

### Subsequent Connections

On every later connection, netssh checks the stored key automatically. If the key matches, the connection proceeds without a prompt.

### Host Key Changed

If a previously-saved host key no longer matches, netssh blocks the connection and shows a warning:

> Host key has changed. This can indicate a man-in-the-middle attack.

Both the old key fingerprint and the new one are displayed side by side. You can:

- **Accept the new key** — appropriate when you know the device was replaced, re-imaged, or had its SSH keys regenerated.
- **Abort the connection** — the safe default if the change is unexpected.

If you accept the new key, it replaces the old one in the known hosts store.

Known host keys are stored in the app data directory (not in the system `known_hosts` file). This keeps netssh host verification separate from other SSH clients on your system.

## Error Scenarios

| Scenario | What you see | What to do |
|---|---|---|
| Wrong password or rejected key | Error banner with reason. **Retry** button visible | Update the credentials in the host settings. Or retry if you mistyped the password |
| Host unreachable (timeout) | Timeout overlay after ~10 seconds. **Retry** button visible | Make sure that the host address, port, and network connection are correct |
| Host key changed | Blocking MITM warning. Old and new keys shown | Contact the device administrator before you accept the new key |
| Mid-session disconnect | "Disconnected" overlay. Terminal frozen. Last output preserved | Make sure that the network connection is active. Click **Reconnect** to re-establish the session |
| Keyboard-interactive challenge unrecognized | Dialog box that asks for manual input | Enter the information the device is asking for |

## Disconnecting

Three ways to end a session:

- Type `exit` in the terminal. This runs the exit command on the remote device for a clean session close.
- Press `Ctrl+Shift+W`. This closes the active tab (after a confirmation dialog) and disconnects the session.
- Click the `×` on the tab. Same behavior as `Ctrl+Shift+W`.

After disconnecting, the host remains in the connection manager. Press `Enter` to reconnect.

## Next Steps

- [Terminal & Suggestions](04-terminal-and-suggestions.md): typing commands and using inline suggestions
- [Security](09-security.md): credential and key storage details
- [Troubleshooting](10-troubleshooting.md): common connection issues and fixes
