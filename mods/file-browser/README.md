# file-browser

**Files** for [Herdr app](https://herdr.dev). Part of [Herdr Islands](../../README.md), and it works on its own.

Herdr's Files panel (the shipped `files` mod, cloned), made to open files rather than preview them:
- **Left click** opens a file here in Herdr, in a tab of its own. Code and text open read-only, with syntax
  colors and line numbers; pictures (PNG, JPEG, GIF, WebP, BMP, ICO, SVG) are fitted to the tab;
  spreadsheets open in `sheet-viewer`. A file that's already open goes to its tab.
- **Right click** on a file, a folder or the empty part of the tree opens a menu for everything else:
  - Open with default app;
  - Open in VS Code / Cursor (when installed);
  - a terminal editor from settings;
  - Show in Explorer / Finder;
  - Copy path / Copy relative path;
  - Open terminal here.

  For files on another machine, only the items that work there show.
- **Git status** shows the way it does in an IDE. A changed file's name takes its color, with VS Code's
  letter after it: `M` modified (amber), `A` added and `U` untracked (green), `D` deleted and `!` in
  conflict (red). A folder with changes inside gets the same color and a dot, even when it's
  collapsed. Ignored files and folders are dimmed.
- **Folders open at once:** the folders you can see are listed before you click them, many in one
  process.

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

To open files in a terminal editor from the menu, create `settings.json` in this folder:

```json
{ "terminal_editor": ["nvim"] }
```

The menu then has "Open in nvim", which runs it in a new tab.

## Works with

Install `sheet-viewer` too, for spreadsheets. Without it they open as text (CSV) or with a button
to open them in their program (xlsx).
