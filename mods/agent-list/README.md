# agent-list

**Agents** for [Herdr app](https://herdr.dev). Part of [Herdr Islands](../../README.md), and it works on its own.

The list of agents. Hover an agent (in the full list or the narrow rail) and a card shows the
bottom of its screen, without the Claude Code or Codex input box. The card refreshes every 1.5 s while
open; click it to go to the agent.

## Install only this mod

Windows (PowerShell):

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Yofukashiya/herdr-islands/main/install.ps1))) agent-list
```

macOS (Terminal):

```sh
curl -fsSL https://raw.githubusercontent.com/Yofukashiya/herdr-islands/main/install.sh | sh -s -- agent-list
```

Or copy this folder to `~/.config/herdr-app/mods/agent-list`. Herdr picks it up without a restart.

## Where it goes

Use it where your layout has Herdr's `agents`:

```json
{ "id": "agents", "type": "block", "content": { "mod": "agent-list" } }
```

## Works with

With `space-list`, the preview card is tinted with the agent's space color.
