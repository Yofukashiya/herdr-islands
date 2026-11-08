# agent-radar

**Agent radar** for [Herdr app](https://herdr.dev). Part of [Herdr Islands](../../README.md), and it works on its own.

A floating drawer at the window edge. Collapsed, it's a thin strip with the agent count and their
states: a pulsing red dot when one needs you, a spinner while one works. Hover it and the list slides out
with each agent's space color, name, place and last line on screen; click one to go there. It hides when no
agent runs.

## Install only this mod

Windows (PowerShell):

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Yofukashiya/herdr-islands/main/install.ps1))) agent-radar
```

macOS (Terminal):

```sh
curl -fsSL https://raw.githubusercontent.com/Yofukashiya/herdr-islands/main/install.sh | sh -s -- agent-radar
```

Or copy this folder to `~/.config/herdr-app/mods/agent-radar`. Herdr picks it up without a restart.

## Where it goes

Add it to your layout's root (a floating block can't dock by itself):

```json
"floating": [ { "id": "radar", "content": { "mod": "agent-radar" }, "edge": "right", "align": "center", "peek": 30 } ]
```

Drag it to another edge if you like; Herdr remembers the spot.

## Works with

`space-list` gives the rows their space colors. With `sidebar-chrome`, `"radar": false` in its
settings hides the drawer.
