# Getting Started

New to net.sh? This guide takes you from first launch to your first terminal session in about five minutes.

## The Welcome Screen

On first launch you'll see an empty connection manager with:

- A one-line summary of what net.sh does: an SSH client that suggests commands as you type
- The supported device platforms: Cisco IOS-XE, NX-OS, F5 TMOS, Linux
- A single **+ Add your first host** button — your next step
- A tip explaining that net.sh suggests commands inline while you work

This screen only appears when you have no saved hosts. Once you add one, it's replaced by your connection list.

## Adding Your First Host

Click **Add your first host** or press `Ctrl+N`. This opens the new connection form.

### 1. Display Name

What you'll call this device in your host list. Pick something you'll recognise.

_Example: "Core Router - LON"_

### 2. Hostname / IP

The address net.sh uses to reach the device. Works with both IP addresses and DNS names.

_Example: "192.168.1.1" or "router.example.com"_

### 3. Port

Defaults to `22`, the standard SSH port. You'll rarely need to change this.

### 4. Username

Your SSH login name on the remote device.

### 5. Platform

Which command knowledge base net.sh should use for this device. Pick from:

| Platform | Typical devices |
|---|---|
| **Linux / bash** | Servers, VMs, Raspberry Pi, containers |
| **Cisco IOS-XE** | Routers, Catalyst switches, ASR, ISR |
| **Cisco NX-OS** | Nexus switches (3K/5K/7K/9K) |
| **F5 BIG-IP TMOS** | BIG-IP appliances and VEs |

This is the most important field. It tells net.sh which commands to suggest while you work.

### 6. OS Version

Optional, but useful. Enter the software version running on the device (for example, _"17.6"_ or _"9.3(8)"_) and net.sh will filter suggestions to commands that exist on that version. Leave it blank to see all commands for the selected platform.

### 7. Authentication

Choose **Password** or **SSH Key**. Credentials are stored in your operating system's secure keychain.

Details on key setup are covered in [Connecting to Devices](03-connecting-to-devices.md).

### 8. Notes

Optional free-text field for anything you want to remember about this device — asset tags, circuit IDs, who to call if it goes down.

### Save or Connect

Two buttons at the bottom:

- **Save** — stores the host and returns you to the connection list
- **Save & Connect** — saves and immediately opens a terminal session

For your first host, hit **Save & Connect**.

## Your First Connection

After clicking Save & Connect, the terminal view opens and connection progress appears in the terminal output.

### Host Key Verification

The first time you connect to a device, net.sh shows you a host key fingerprint and asks you to verify it. This is SSH's way of making sure you're connecting to the right device. Think of it like checking someone's ID before letting them into a building — you're confirming the device is who it claims to be.

net.sh remembers accepted keys, so you'll only see this prompt once per device.

### Connected

Once the SSH session is established, you'll see:

- The terminal prompt from your remote device
- The top bar showing the device name, platform, and OS version
- A green connection indicator in the status bar
- The current CLI mode (for Cisco and F5 devices — this determines which commands are suggested)

You're now live on the device. Commands you type are sent directly to the remote — there's no local staging or buffering. What you type goes straight to the device, and what the device sends back appears on your screen.

## First Steps in the Terminal

Start typing a command. As you type, net.sh looks through its knowledge base for your platform and shows matching commands.

### Ghost Text

A semi-transparent completion appears after your cursor as you type. This ghost text shows the most likely command match.

Press **Tab** to accept the suggestion — it fills in the rest of the command for you.

### Browse All Matches

Press **Ctrl+Space** to open a dropdown listing every command that matches what you've typed so far. Use **↑** and **↓** to navigate, **Tab** to select.

### Side Panel

Press **Ctrl+`** (backtick) to open the side panel. It shows detailed syntax, parameter descriptions, and examples for the command currently highlighted in the dropdown or at your cursor.

Full details on the suggestion system are in [Terminal & Suggestions](04-terminal-and-suggestions.md).

## What's Next

- Add more hosts — repeat the steps above for each device you work with. Your host list is the home screen.
- Open the [Side Panel](05-side-panel.md) to browse command details while you work.
- Learn the [Keyboard Shortcuts](07-keyboard-shortcuts.md) — net.sh is designed to be used without a mouse.
