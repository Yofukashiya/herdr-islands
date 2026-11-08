# status-bar

**Status bar** for [Herdr app](https://herdr.dev). Part of [Herdr Islands](../../README.md), and it works on its own.

A status bar with your plan limits for Claude, Codex, OpenCode and Cursor, and CPU, memory and
load. On the left it shows the current space and branch. Limits read like a battery of what's left: green from 50%, amber from 11 to 49%,
red at 10% or less. Click a limit for details.

## Install only this mod

Windows (PowerShell):

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Yofukashiya/herdr-islands/main/install.ps1))) status-bar
```

macOS (Terminal):

```sh
curl -fsSL https://raw.githubusercontent.com/Yofukashiya/herdr-islands/main/install.sh | sh -s -- status-bar
```

Or copy this folder to `~/.config/herdr-app/mods/status-bar`. Herdr picks it up without a restart.

## Where it goes

Installed on its own, Herdr docks it at the bottom of the layout on screen the first time it sees
it. To place it yourself:

```json
{ "id": "status", "type": "block", "size": { "px": 32 }, "content": { "mod": "status-bar" } }
```

To ask only some services, create `~/.config/herdr-app/usage.json` with
`{ "providers": ["claude", "codex"] }`; `{ "providers": [] }` leaves only CPU and memory.

It reads saved CLI logins (`~/.claude/.credentials.json` or the macOS Keychain, `~/.codex/auth.json`,
opencode's `auth.json`, Cursor's database). It sends each token only to its own service, every 10 minutes.
See [what it reads and sends](../../README.md#what-the-status-bar-reads-and-sends).

## Works with

`space-list` colors the space chip; `sidebar-chrome` sets the card opacity.

## License

Based on `mods/usage` from [DanielFGray/herdr-config](https://github.com/DanielFGray/herdr-config),
Apache-2.0 ([license](../../LICENSE-usage-Apache-2.0.txt)); the changes are listed in the
[changelog](../../CHANGELOG.md).
