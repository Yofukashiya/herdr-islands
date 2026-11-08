# tab-bar

**Tab bar** for [Herdr app](https://herdr.dev). Part of [Herdr Islands](../../README.md), and it works on its own.

Pill-shaped tabs; the active one takes the space color. On the right: buttons for the side panel
(Files, Changes, and Mods when the layout has it) and, where Herdr draws its own window frame (Windows),
the window buttons.

## Install only this mod

Windows (PowerShell):

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Yofukashiya/herdr-islands/main/install.ps1))) tab-bar
```

macOS (Terminal):

```sh
curl -fsSL https://raw.githubusercontent.com/Yofukashiya/herdr-islands/main/install.sh | sh -s -- tab-bar
```

Or copy this folder to `~/.config/herdr-app/mods/tab-bar`. Herdr picks it up without a restart.

## Where it goes

Use it where your layout has Herdr's `tabs`:

```json
{ "id": "tabs", "type": "block", "size": { "px": 30 }, "content": { "mod": "tab-bar" } }
```

The Mods button shows when the layout has a block with the id `mods` (for example `mod-manager` in the
side panel's stack).

## Works with

`space-list` gives it the space color; without it, the theme's accent.
