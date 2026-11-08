# mod-manager

**Mod manager** for [Herdr app](https://herdr.dev). Part of [Herdr Islands](../../README.md), and it works on its own.

A Mods panel with three tabs:
- **Mods:** your mods grouped by where they sit in the window, with switches, errors, Check and Folder.
- **Look:** the theme, plus the Islands look settings in a layout that uses `sidebar-chrome`.
- **Layouts:** every layout with a preview.

On top it shows the Herdr Islands version you have, with **Check for updates**; when a release is out,
a card offers **What's new** and **Update**, which installs it in the background.

## Install only this mod

Windows (PowerShell):

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Yofukashiya/herdr-islands/main/install.ps1))) mod-manager
```

macOS (Terminal):

```sh
curl -fsSL https://raw.githubusercontent.com/Yofukashiya/herdr-islands/main/install.sh | sh -s -- mod-manager
```

Or copy this folder to `~/.config/herdr-app/mods/mod-manager`. Herdr picks it up without a restart.

## Where it goes

Open it as a dialog:

```sh
herdr-app do mod.open --name mod-manager
```

To open it with a key, add this to `~/.config/herdr-app/keys.json` (pick a key you don't use). Once you
edit that file, Herdr keeps it as yours, and new default shortcuts from updates no longer get added:

```json
{ "global": { "ctrl-shift-m": { "command": "mod.open", "args": { "name": "mod-manager" } } } }
```

Or keep it in the side panel, as Islands does: a block with the id `mods` in the panel's stack, next to
`files` and `changes`. `tab-bar` then shows a Mods button for it.

## Works with

The Look tab's Islands settings need `sidebar-chrome`; the theme choice works everywhere. With
`sidebar-chrome` running, updates are found in the background and shared with this panel; without it,
the panel checks when it opens.
