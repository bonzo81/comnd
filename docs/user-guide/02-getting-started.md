# Getting Started

New to netssh? This guide takes you from first launch to your first terminal session in about five minutes.

## The Welcome Screen

On first launch, you see an empty connection manager with:

- A one-line summary of what netssh does: an SSH client that suggests commands as you type
- The supported device platforms: Cisco IOS-XE, NX-OS, F5 TMOS, Linux
- A single **+ Add your first host** button — your next step
- A tip explaining that netssh suggests commands inline while you work

This screen appears only when you have no saved hosts. After you add one host, the app replaces this screen with your connection list.

## Adding Your First Host

Click **Add your first host** or press `Ctrl+N`. This opens the new connection form.

### 1. Display Name

The name that identifies this device in your host list. Choose a name that you recognize easily.

_Example: "Core Router - LON"_

### 2. Hostname / IP

The address that netssh uses to reach the device. The field works with both IP addresses and DNS names.

_Example: "192.168.1.1" or "router.example.com"_

### 3. Port

Defaults to `22`, the standard SSH port. You rarely need to change this value.

### 4. Username

Your SSH login name on the remote device.

### 5. Platform

The command knowledge base that netssh uses for this device. Pick from:

| Platform | Typical devices |
|---|---|
| **Linux / bash** | Servers, VMs, Raspberry Pi, containers |
| **Cisco IOS-XE** | Routers, Catalyst switches, ASR, ISR |
| **Cisco NX-OS** | Nexus switches (3K/5K/7K/9K) |
| **F5 BIG-IP TMOS** | BIG-IP appliances and VEs |

This is the most important field. It tells netssh which commands to suggest while you work.

### 6. OS Version

Optional, but useful. Enter the software version that runs on the device (for example, _"17.6"_ or _"9.3(8)"_). Then netssh shows only commands that exist on that version. Leave the field blank to see all commands for the selected platform.

### 7. Authentication

Choose **Password** or **SSH Key**. netssh stores credentials in the secure keychain of your operating system.

Details on key setup are covered in [Connecting to Devices](03-connecting-to-devices.md).

### 8. Notes

Optional. Enter any information that you want to remember about this device, such as asset tags, circuit IDs, or the person to contact if the device fails.

### Save or Connect

Two buttons at the bottom:

- **Save** — stores the host and returns you to the connection list
- **Save & Connect** — saves and immediately opens a terminal session

For your first host, select **Save & Connect**.

## Your First Connection

After clicking Save & Connect, the terminal view opens and connection progress appears in the terminal output.

### Host Key Verification

The first time you connect to a device, netssh shows you a host key fingerprint and asks you to verify it. SSH uses this step to make sure that you connect to the correct device. This step works like checking an ID before you let someone into a building. The check makes sure that the device is what it claims to be.

netssh remembers accepted keys. You see this prompt only once per device.

### Connected

After the SSH session starts, you see:

- The terminal prompt from your remote device
- The top bar showing the device name, platform, and OS version
- A green connection indicator in the status bar
- The current CLI mode (for Cisco and F5 devices — this determines which commands are suggested)

You are now connected to the device. The app sends each command that you type directly to the remote device. The app does not store commands locally. Your keystrokes go directly to the device, and the output from the device appears on your screen.

## First Steps in the Terminal

Start typing a command. As you type, netssh searches the knowledge base for your platform and shows matching commands.

### Ghost Text

A semi-transparent completion appears after your cursor as you type. This ghost text shows the most likely command match.

Press **Tab** to accept the suggestion — it fills in the rest of the command for you.

### Browse All Matches

Press **Ctrl+Space** to open a dropdown listing every command that matches what you have typed so far. Use **↑** and **↓** to navigate, **Tab** to select.

### Side Panel

Click the **≡** (panel) button at the right end of the top bar to open the side panel; press `Escape` to close it. It shows detailed syntax, parameter descriptions, and examples for the command currently highlighted in the dropdown or at your cursor.

Full details on the suggestion system are in [Terminal & Suggestions](04-terminal-and-suggestions.md).

## Next Steps

- Add more hosts — repeat the steps above for each device you work with. Your host list is the home screen.
- Open the [Side Panel](05-side-panel.md) to browse command details while you work.
- Learn the [Keyboard Shortcuts](07-keyboard-shortcuts.md) — netssh is designed to be used without a mouse.
