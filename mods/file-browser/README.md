# file-browser

**Files** for [Herdr app](https://herdr.dev). Part of [Herdr Islands](../../README.md), and it works on its own.

Herdr's Files panel (the shipped `files` mod, cloned), with one change: spreadsheets (`.xlsx`,
`.xlsm`, `.csv`, `.tsv`) open in `sheet-viewer` in a tab of their own.

## Install only this mod

Windows (PowerShell):

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Yofukashiya/herdr-islands/main/install.ps1))) file-browser
```

macOS (Terminal):

```sh
curl -fsSL https://raw.githubusercontent.com/Yofukashiya/herdr-islands/main/install.sh | sh -s -- file-browser
```

Or copy this folder to `~/.config/herdr-app/mods/file-browser`. Herdr picks it up without a restart.

## Where it goes

Use it where your layout has Herdr's `files`:

```json
{ "id": "files", "type": "block", "content": { "mod": "file-browser" } }
```

## Works with

Install `sheet-viewer` too. Without it, spreadsheets show as text, like in the shipped Files panel.
It checks on each click, so installing the viewer later works at once.
