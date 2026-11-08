# pane-header

**Pane header** for [Herdr app](https://herdr.dev). Part of [Herdr Islands](../../README.md), and it works on its own.

A header on each pane: the program, its folder and status, and buttons to split, zoom and close
that fade in on hover. In a split tab, the focused pane gets a line in the space color.

## Install only this mod

Windows (PowerShell):

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Yofukashiya/herdr-islands/main/install.ps1))) pane-header
```

macOS (Terminal):

```sh
curl -fsSL https://raw.githubusercontent.com/Yofukashiya/herdr-islands/main/install.sh | sh -s -- pane-header
```

Or copy this folder to `~/.config/herdr-app/mods/pane-header`. Herdr picks it up without a restart.

## Where it goes

Set it as the pane header in your layout's `main` block:

```json
"pane": { "header": { "content": { "mod": "pane-header" }, "reveal": "always", "height": 30, "position": "top" } }
```

## Works with

`space-list` gives the focus line its color; without it, the theme's accent.
