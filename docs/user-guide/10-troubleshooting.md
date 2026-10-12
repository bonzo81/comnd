# Troubleshooting

## Connection Problems

### "Connection timed out"

**The remote host did not respond within 10 seconds.**
Check the hostname, IP address, and port in your [host settings](03-connecting-to-devices.md). A typo in the address is the most common cause — copy it directly from your inventory rather than typing it.
Make sure that your machine can reach the host. Make sure that no firewall blocks SSH traffic on the port you specified (the default is 22).
If the device sits behind a VPN, make sure that the VPN tunnel is active before connecting.

### "Connection refused"

**The remote host actively rejected the connection.**
This usually means nothing is listening on the specified port. Check the port number in host settings. Some devices run SSH on non-standard ports. Make sure that the SSH service runs on the remote device. If you recently changed the port on the device side, make sure that you updated the host settings to match.

### "Authentication failed"

**Your credentials were rejected by the remote device.**
For password authentication, make sure that the password in [host settings](03-connecting-to-devices.md) is correct. Watch for trailing spaces if you pasted it.

For SSH key authentication, make sure that these three things are true before you continue:
- The key path points to the **private** key file, not the `.pub` public key.
- The file uses a supported format: OpenSSH (`-----BEGIN OPENSSH PRIVATE KEY-----`) or PEM (`-----BEGIN RSA PRIVATE KEY-----`).
- The corresponding public key is installed on the remote device (in `~/.ssh/authorized_keys` for Linux, or the equivalent location on that device).

SSH keys protected by a passphrase are supported. You will be prompted when connecting. If your key has a passphrase and you are not seeing the prompt, the SSH library can fail to recognize the key format.

Some devices using keyboard-interactive authentication (common on F5 TMOS and certain Cisco platforms) expect a specific question-and-answer format. If keyboard-interactive fails, try switching the host authentication method to password.

### "Host key has changed"

**This is a security warning, not an error.**
netssh saves the host key on first connection and checks it on every subsequent connection. If it no longer matches, a common cause is that the device was re-imaged, its OS was reinstalled, or its SSH server keys were regenerated.

If you were not expecting this change, stop and ask the device administrator before you proceed. This can also indicate a man-in-the-middle attack. If you are certain the change is legitimate, netssh will let you accept the new key and update the saved fingerprint. For background on host key verification, see [Security](09-security.md).

### Connection drops mid-session

**The SSH session closed unexpectedly.**
Network drops, remote device reboots, idle timeouts on the remote side, and aggressive keepalive settings can all cause this. Your last terminal output stays frozen on screen so you can read the scrollback. Click **Reconnect** to resume.

If drops happen frequently, check the SSH idle timeout setting of the remote device (`ClientAliveInterval` on Linux, `exec-timeout` on Cisco) and increase it if you can.

### "No route to host" or "Network is unreachable"

**Your machine cannot find a path to the remote device.**
The hostname or IP can point to a network that is not accessible from your current location. Make sure that you are on the correct network (VPN, management VLAN, out-of-band network). Make sure that your routing allows access to the target subnet.

## Suggestion Problems

### No suggestions / ghost text not appearing

**The suggestion engine is not producing matches.** Three settings control which commands appear:

1. **Platform** — set in host settings. If the wrong platform is selected (for example, `linux-bash` for a Cisco device), you are searching the wrong knowledge base. Make sure that the platform matches the device OS.
2. **OS version** — also in host settings. A specific version filters out commands that do not apply to that release. Clear this field to see every command available for the platform.
3. **CLI mode** — shown in the status bar. Suggestions are filtered to the current mode. At a shell prompt, you will see shell commands. In config mode, you will see config commands.

If all three look correct but you still see nothing, check whether the terminal is inside an interactive program. Suggestions pause when the terminal is inside programs like `vi`, `more`, `less`, or `top`. Exit back to the shell prompt and suggestions will resume.

### Suggestions appear slowly or lag behind

**Ghost text lags behind your typing.**
The knowledge base query runs in the background — a brief delay on first connection is normal while the KB loads into memory.
If the lag continues, heavy terminal output with formatting codes can slow down prompt detection. Clear the screen if the output buffer feels backed up.

### Wrong suggestions showing

**Suggestions do not match the commands you expect for this device.**
Check the platform first. Edit the host and make sure that it matches the OS of the remote device. If the platform is correct, look at the status bar for the detected CLI mode. Mode detection is automatic, but it can misdetect during rapid command sequences or when prompt patterns are unusual. Wait a moment after you reach a prompt so detection can settle. If you are in config mode, only config-mode commands appear. Return to exec mode to see the full command set.

### Dropdown not showing

**The suggestion dropdown does not appear while typing.**
The dropdown is off by default. Press `Ctrl+Space` or click the lightbulb button in the terminal toolbar to enable auto-show. The setting persists. If `Ctrl+Space` does nothing, it is usually reserved by the input method editor (IME) on Linux and Windows, or by Spotlight on macOS. Check your OS keyboard settings. Unbind the conflicting shortcut or remap it. The toolbar button works regardless.

### Suggestion panel shows commands from the wrong device

**You are connected to one device but see commands for another.**
The knowledge base loads per session based on the platform setting of the host. If you changed which host you are connected to but did not update the platform, edit the host entry and select the correct platform. The change takes effect on the next connection.

## Display & UI Issues

### Terminal font too small or large

Zoom in-session with `Ctrl++` and out with `Ctrl+-`. Changes affect the current session only. To set a permanent default, open Settings with `Ctrl+,` and adjust the terminal font size — new sessions will use that default.

### Terminal output looks garbled

**Formatting codes or control characters appear as literal text on screen.**
This happens when the remote device sends output in a format that the terminal emulator of netssh does not fully support. Most modern devices use a standard format (xterm-compatible ANSI).

If possible, set the `TERM` environment variable on the remote side to `xterm-256color`. For devices where you cannot change the remote terminal type (locked-down Cisco or F5), reduce color output on the remote side: `terminal no color` on Cisco, or `TERM=dumb` in a shell.

### Copy/paste does not work

**Clipboard operations behave differently from a standard desktop app.**
Terminal selection copies to the clipboard automatically — no `Ctrl+C` needed. `Ctrl+Shift+V` pastes from the clipboard. `Ctrl+C` and `Ctrl+V` are passed through to the remote because they have meaning there (interrupt for `Ctrl+C`, literal-next in some shells for `Ctrl+V`).

If `Ctrl+Shift+V` is not pasting, another application or your window manager can be intercepting the key combination.

### Side panel will not open

Click the **≡** button at the right end of the top bar to open the side panel — there is no keyboard shortcut for opening it. `Escape` closes it if already open and returns focus to the terminal. If the panel is open but shows no command details, nothing is highlighted yet — type in the terminal or open the dropdown with `Ctrl+Space` to pick a command first.

### App will not launch

Check that your system meets the [installation requirements](01-installation.md). A corrupted installation is the most common cause on all platforms. Reinstall from the [latest release](01-installation.md). If the app still will not start, check the application logs for crash details (paths in the Logs section below).

### Blurry text on high-DPI displays

**Text appears fuzzy, especially on Windows or Linux with fractional scaling.**
netssh uses your OS display scaling setting. If text is blurry, adjust the font size in Settings rather than relying on OS fractional scaling (for example, 125% or 150%). Increasing the terminal font size by one or two points often produces a sharper result than OS-level upscaling.

## Logs & Diagnostics

App logs are plain text files you can open in any editor. They capture connection attempts, authentication steps, errors, and internal state changes. When things go wrong, logs are your best diagnostic tool.

| Platform | Log path |
|---|---|
| **Linux** | `~/.config/netssh/logs/` |
| **Windows** | `%APPDATA%\netssh\logs\` |
| **macOS** | `~/Library/Application Support/netssh/logs/` |

Log files are rotated — the current session writes to the most recent file, and older sessions are kept with timestamps in the filename. Look for lines containing `ERROR` or `WARN` near the time your problem occurred.

Verbose debug logging (more detail than the default level) is planned but not yet available in the current release.
