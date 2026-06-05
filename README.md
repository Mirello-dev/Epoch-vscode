<p align="center">
  <img src="images/epoch-logo.png" alt="epoch logo" width="120" />
</p>

<h1 align="center">epoch</h1>

<p align="center">
  <strong>Automatic coding time tracking for VS Code</strong><br/>
  Seamlessly records your focus time and syncs it to your epoch instance.
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=Mirello.epoch-time">
    <img src="https://img.shields.io/visual-studio-marketplace/v/Mirello.epoch-time?color=blue&label=VS%20Marketplace" alt="VS Marketplace" />
  </a>
  <a href="https://github.com/mirello-dev/epoch-vscode/blob/main/LICENSE">
    <img src="https://img.shields.io/badge/license-GPL--3.0-green" alt="License" />
  </a>
  <a href="https://github.com/mirello-dev/epoch-vscode/issues">
    <img src="https://img.shields.io/github/issues/mirello-dev/epoch-vscode" alt="Issues" />
  </a>
</p>

---

## What it does

epoch runs silently in the background and tracks how much time you actively spend coding. It detects your current project via git, sends periodic heartbeats to your epoch instance, and shows a live timer in the status bar. Everything works offline — heartbeats are queued locally and synced automatically when connectivity is restored.

## Features

- **Live status bar** — shows today's total coding time at a glance (`1 hrs 23 mins`)
- **Automatic project detection** — resolves the project name from your git remote
- **Offline queue** — heartbeats are stored locally and flushed when back online
- **Zero configuration needed** — connects to `https://epoch.mirello.cloud` by default
- **Self-hosted support** — point it at any epoch instance with a custom URL

## Getting started

1. Install the extension from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=Mirello.epoch-time)
2. Open the command palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run **`epoch: Set API Key`**
3. Optionally run **`epoch: Set Instance`** if you're using a self-hosted server
4. Start coding — the timer appears in the bottom-left status bar

## Commands

| Command | Description |
|---|---|
| `epoch: Set API Key` | Store your epoch API key |
| `epoch: Set Instance` | Set the URL of your epoch instance |
| `epoch: Validate API Key` | Check that your key authenticates successfully |
| `epoch: Open Dashboard` | Open your epoch dashboard in the browser |
| `epoch: Show Output` | Open the epoch output channel for diagnostics |

## Configuration

Settings can be managed via VS Code settings or by editing the config file directly at `~/.config/epoch/config.json` (respects `$XDG_CONFIG_HOME`).

| Setting | Default | Description |
|---|---|---|
| `epoch.apiKey` | — | API key for authentication |
| `epoch.baseUrl` | `https://epoch.mirello.cloud` | URL of your epoch instance |

## Status bar indicators

| Display | Meaning |
|---|---|
| `⏰ 2 hrs 14 mins` | Tracking — connected and syncing |
| `↻ 1 hrs 05 mins (offline)` | Offline — data queued for sync |
| `✕ Unconfigured` | API key missing or invalid |

## License

GPL-3.0 — see [LICENSE](LICENSE) for details.

---

<p align="center">
  Built by <a href="https://mirello.ch">Mirello</a>
</p>
