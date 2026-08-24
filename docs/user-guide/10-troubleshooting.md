## Connection Problems

### "Connection timed out"

**The remote host didn't respond within 10 seconds.**
Check the hostname or IP address and port in your [host settings](03-connecting-to-devices.md). A typo in the address is the most common cause — copy it directly from your inventory rather than typing it.
Make sure your machine can reach the host, and confirm no firewall is blocking SSH traffic on the port you specified (default is 22).
If the device sits behind a VPN, make sure the VPN tunnel is active before connecting.

### "Connection refused"

**The remote host actively rejected the connection.**
This usually means nothing is listening on the specified port — check the port number in host settings (some devices run SSH on non-standard ports). Confirm the SSH service is running on the remote device. If you recently changed the port on the device side, make sure you updated the host settings to match.

### "Authentication failed"

**Your credentials were rejected by the remote device.**
For password authentication, double-check the password in [host settings](03-connecting-to-devices.md) — watch for trailing spaces if you pasted it.

For SSH key authentication, check three things before troubleshooting further:
- The key path points to the **private** key file, not the `.pub` public key.
- The file uses a supported format: OpenSSH (`-----BEGIN OPENSSH PRIVATE KEY-----`) or PEM (`-----BEGIN RSA PRIVATE KEY-----`).
- The corresponding public key is installed on the remote device (in `~/.ssh/authorized_keys` for Linux, or the equivalent for that device's OS).

SSH keys protected by a passphrase are supported — you'll be prompted when connecting. If your key has a passphrase and you aren't seeing the prompt, the key format may not be recognised by the SSH library.

Some devices using keyboard-interactive authentication (common on F5 TMOS and certain Cisco platforms) expect a specific question-and-answer format. If keyboard-interactive fails, try switching the host authentication method to password.

### "Host key has changed"

**This is a security warning, not an error.**
net.sh saves the host key on first connection and checks it on every subsequent connection. If it no longer matches, the device may have been re-imaged, had its OS reinstalled, or its SSH server keys regenerated.

If you weren't expecting this change, stop and verify with the device administrator before proceeding — this can also indicate a man-in-the-middle attack. If you're certain the change is legitimate, net.sh will let you accept the new key and update the saved fingerprint. For background on host key verification, see [Security](09-security.md).

### Connection drops mid-session

**The SSH session closed unexpectedly.**
Network blips, remote device reboots, session idle timeouts on the remote side, and aggressive keepalive settings can all cause this. Your last terminal output stays frozen on screen so you can read the scrollback. Click **Reconnect** to resume.

If drops happen frequently, check the remote device's SSH idle timeout setting (`ClientAliveInterval` on Linux, `exec-timeout` on Cisco) and consider increasing it.

### "No route to host" or "Network is unreachable"

**Your machine can't find a path to the remote device.**
The hostname or IP may point to a network that isn't accessible from your current location. Check that you're on the correct network (VPN, management VLAN, out-of-band network) and that your routing allows access to the target subnet.

## Suggestion Problems

### No suggestions / ghost text not appearing

**The suggestion engine isn't producing matches.** Three settings control which commands appear:

1. **Platform** — set in host settings. If the wrong platform is selected (e.g., `linux-bash` for a Cisco device), you're searching the wrong knowledge base. Check the platform matches the device OS.
2. **OS version** — also in host settings. A specific version filters out commands that don't apply to that release. Clear this field to see every command available for the platform.
3. **CLI mode** — shown in the status bar. Suggestions are filtered to the current mode. At a shell prompt, you'll see shell commands; in config mode, you'll see config commands.

If all three look correct but you still see nothing, you may be inside an interactive program. Suggestions pause when the terminal is inside programs like `vi`, `more`, `less`, or `top`. Exit back to the shell prompt and suggestions will resume.

### Suggestions appear slowly or lag behind

**Ghost text lags behind your typing.**
The knowledge base query runs in the background — a brief delay on first connection is normal while the KB loads into memory.
If sluggishness persists, heavy terminal output with formatting codes can slow down prompt detection. Try clearing the screen if the output buffer feels backed up.

### Wrong suggestions showing

**Suggestions don't match the commands you'd expect for this device.**
Check the platform first — edit the host and make sure it matches the remote device's OS. If the platform is correct, look at the status bar for the detected CLI mode. Mode detection is automatic but can misdetect during rapid command sequences or when prompt patterns are unusual — wait a moment after landing at a prompt for detection to settle. If you're in config mode, only config-mode commands appear; return to exec mode to see the full command set.

### Dropdown not showing

**The suggestion dropdown doesn't appear while typing.**
The dropdown is off by default — press `Ctrl+Space` or click the lightbulb button in the terminal toolbar to enable auto-show (the setting persists). If `Ctrl+Space` does nothing, it is usually reserved by the input method editor (IME) on Linux and Windows, or by Spotlight on macOS. Check your OS keyboard settings and either unbind the conflicting shortcut or remap it; the toolbar button works regardless.

### Suggestion panel shows commands from the wrong device

**You're connected to one device but seeing commands for another.**
The knowledge base is loaded per-session based on the host's platform setting. If you changed which host you're connected to but didn't update the platform, edit the host entry and select the correct platform — the change takes effect on the next connection.

## Display & UI Issues

### Terminal font too small or large

Zoom in-session with `Ctrl++` and out with `Ctrl+-`. Changes affect the current session only. To set a permanent default, open Settings with `Ctrl+,` and adjust the terminal font size — new sessions will use that default.

### Terminal output looks garbled

**Formatting codes or control characters appear as literal text on screen.**
This happens when the remote device sends output in a format that net.sh's terminal emulator doesn't fully support. Most modern devices use a standard format (xterm-compatible ANSI).

If possible, set the `TERM` environment variable on the remote side to `xterm-256color`. For devices where you can't change the remote terminal type (locked-down Cisco or F5), try reducing colour output on the remote side: `terminal no color` on Cisco, or `TERM=dumb` in a shell.

### Copy/paste doesn't work

**Clipboard operations behave differently from a standard desktop app.**
Terminal selection copies to the clipboard automatically — no `Ctrl+C` needed. `Ctrl+Shift+V` pastes from the clipboard. `Ctrl+C` and `Ctrl+V` are passed through to the remote because they have meaning there (interrupt for `Ctrl+C`, literal-next in some shells for `Ctrl+V`).

If `Ctrl+Shift+V` isn't pasting, another application or your window manager may be intercepting the key combination.

### Side panel won't open

Press `` Ctrl+` `` (backtick) to toggle the side panel. `Escape` closes it if already open and returns focus to the terminal. If the shortcut isn't responding, another application or your window manager may be intercepting it — use the side panel toggle button in the toolbar as a fallback.

### App won't launch

Check that your system meets the [installation requirements](01-installation.md). A corrupted installation is the most common cause on all platforms — reinstall from the [latest release](01-installation.md). If the app still won't start, check the application logs for crash details (paths in the Logs section below).

### Blurry text on high-DPI displays

**Text appears fuzzy, especially on Windows or Linux with fractional scaling.**
net.sh uses your OS display scaling setting. If text is blurry, try adjusting the font size in Settings rather than relying on OS fractional scaling (e.g., 125% or 150%). Increasing the terminal font size by one or two points often produces a sharper result than OS-level upscaling.

## Logs & Diagnostics

App logs are plain text files you can open in any editor. They capture connection attempts, authentication steps, errors, and internal state changes. When things go wrong, logs are your best diagnostic tool.

| Platform | Log path |
|---|---|
| **Linux** | `~/.config/netsh/logs/` |
| **Windows** | `%APPDATA%\netsh\logs\` |
| **macOS** | `~/Library/Application Support/netsh/logs/` |

Log files are rotated — the current session writes to the most recent file, and older sessions are kept with timestamps in the filename. Look for lines containing `ERROR` or `WARN` near the time your problem occurred.

Verbose debug logging (more detail than the default level) is planned but not yet available in the current release.
