# space-list

**Spaces** for [Herdr app](https://herdr.dev). Part of [Herdr Islands](../../README.md), and it works on its own.

The list of spaces, with a color per space. It publishes the shown space's color, which other
mods use as the accent.

## Install only this mod

Windows (PowerShell):

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Yofukashiya/herdr-islands/main/install.ps1))) space-list
```

macOS (Terminal):

```sh
curl -fsSL https://raw.githubusercontent.com/Yofukashiya/herdr-islands/main/install.sh | sh -s -- space-list
```

Or copy this folder to `~/.config/herdr-app/mods/space-list`. Herdr picks it up without a restart.

## Where it goes

Use it where your layout has Herdr's `spaces`:

```json
{ "id": "spaces", "type": "block", "content": { "mod": "space-list" } }
```

## Works with

`tab-bar`, `pane-header`, `status-bar`, `agent-list` and `agent-radar` use the color it publishes;
without it they use the theme's accent. With `sidebar-chrome`, its `accent` setting picks space color,
theme accent or a fixed color.
