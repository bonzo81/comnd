# Development Setup

## Prerequisites

| Tool | Purpose | Install |
|---|---|---|
| Rust (via rustup) | Backend compilation | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| Node.js (LTS) | Frontend build tooling | `nvm install --lts` or system package manager |
| Tauri CLI | Build/run the app | `cargo install tauri-cli` |
| System webview | Tauri rendering | See platform-specific notes below |

### Linux (Ubuntu/Mint)

```bash
# System dependencies for Tauri
sudo apt install libgtk-3-dev libjavascriptcoregtk-4.1-dev libsoup-3.0-dev libwebkit2gtk-4.1-dev

# Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env

# Node.js (via nvm)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
nvm install --lts

# Tauri CLI
cargo install tauri-cli

# Clone and run
git clone https://github.com/bonzo81/netsh.git
cd netsh
npm install
cargo tauri dev
```

### Windows

```powershell
# Rust
winget install Rustlang.Rustup

# Node.js
winget install OpenJS.NodeJS.LTS

# Tauri CLI
cargo install tauri-cli

# WebView2 — usually pre-installed on Windows 10/11

# Clone and run
git clone https://github.com/bonzo81/netsh.git
cd netsh
npm install
cargo tauri dev
```

### macOS

```bash
# Xcode command line tools (includes WebKit)
xcode-select --install

# Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Node.js (via nvm or brew)
brew install node

# Tauri CLI
cargo install tauri-cli

# Clone and run
git clone https://github.com/bonzo81/netsh.git
cd netsh
npm install
cargo tauri dev
```

## Running

```bash
# Development (hot reload)
cargo tauri dev

# Build distributable
cargo tauri build
```

`cargo tauri dev` builds the Rust backend, starts the Vite dev server for the frontend, and opens the app window. Frontend changes hot-reload instantly. Rust changes trigger a recompile + restart.

## Project Structure

```
netsh/
├── docs/                    # Spec documents (8 parts)
├── knowledge-base/          # Platform command YAML files
│   ├── cisco-iosxe/
│   ├── cisco-nxos/
│   ├── f5-tmos/
│   └── linux-bash/
├── src/                     # Frontend (TypeScript)
│   ├── components/          # UI components
│   ├── lib/                 # Core logic (shadow buffer, suggestions, prompt detection)
│   └── styles/              # CSS
├── src-tauri/               # Rust backend
│   └── src/
│       ├── lib.rs           # Tauri commands (entry point)
│       ├── ssh.rs           # SSH connection manager (russh)
│       └── kb.rs            # Knowledge base loader
├── index.html               # App shell
├── package.json             # Frontend dependencies
├── vite.config.ts           # Vite configuration
└── tsconfig.json            # TypeScript configuration
```
