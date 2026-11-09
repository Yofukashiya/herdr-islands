# sidebar-chrome

**Sidebar chrome** for [Herdr app](https://herdr.dev). Part of [Herdr Islands](../../README.md), and it works on its own.

The top and bottom cards of the sidebar, in the Islands card style: Herdr's logo, search and
the sidebar toggle on top; Settings and Add machine at the bottom. It also applies the Islands look
(backdrop, card and pane opacity, accent), but only to a layout whose `brand` block is this mod.
Once a day it also asks GitHub whether a newer Herdr Islands release is out, and tells you (or, with
`"auto_update": true` in its settings, installs it).

## Install only this mod

Windows (PowerShell):

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Yofukashiya/herdr-islands/main/install.ps1))) sidebar-chrome
```

macOS (Terminal):

```sh
curl -fsSL https://raw.githubusercontent.com/Yofukashiya/herdr-islands/main/install.sh | sh -s -- sidebar-chrome
```

Or copy this folder to `~/.config/herdr-app/mods/sidebar-chrome`. Herdr picks it up without a restart.

## Where it goes

Use it where your layout has Herdr's `workspace-chrome` (clone a shipped layout first with
`layout.clone`; shipped layouts don't take structure changes):

```json
{ "id": "brand", "type": "block", "content": { "mod": "sidebar-chrome" } }
{ "id": "sidebar-footer", "type": "block", "content": { "mod": "sidebar-chrome", "props": { "footer": true } } }
```

Its settings are in `settings.json` here; see [Settings](../../README.md#settings). The installer also
copies the grid backdrop to `backgrounds/islands-grid.png`, which the default settings use.

## Works with

The other mods read what it publishes: card opacity (`space-list`, `agent-list`, `tab-bar`,
`status-bar`, and the side panel's `file-browser`, `git-changes` and `mod-manager`), pane opacity (`pane-header`), the accent mode (`space-list`) and whether the radar shows
(`agent-radar`). Without it they use full opacity, the space color and a visible radar.
`mod-manager`'s Look tab edits its settings.
