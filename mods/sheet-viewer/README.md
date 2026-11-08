# sheet-viewer

**Spreadsheet viewer** for [Herdr app](https://herdr.dev). Part of [Herdr Islands](../../README.md), and it works on its own.

A read-only spreadsheet viewer for `.xlsx`, `.xlsm`, `.csv` and `.tsv` that looks like Excel. It
shows number formats, fonts, fills, borders, merged cells, frozen panes, conditional formatting, tables,
pictures, charts, shapes, comments and sheet tabs. See [Spreadsheet viewer](../../README.md#spreadsheet-viewer)
for the full list and the limits.

## Install only this mod

Windows (PowerShell):

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Yofukashiya/herdr-islands/main/install.ps1))) sheet-viewer
```

macOS (Terminal):

```sh
curl -fsSL https://raw.githubusercontent.com/Yofukashiya/herdr-islands/main/install.sh | sh -s -- sheet-viewer
```

Or copy this folder to `~/.config/herdr-app/mods/sheet-viewer`. Herdr picks it up without a restart.

## Where it goes

It opens in a tab of its own. Click a spreadsheet in `file-browser`, or:

```sh
herdr-app do tab.new --name book.xlsx --mod sheet-viewer --props '{"file":"/full/path/book.xlsx"}'
```

Workbooks are unzipped by the system (`powershell` on Windows, `unzip` on macOS and Linux) into `.cache`
here. The cache goes when the tab closes, or after 12 hours.

## Works with

`file-browser` opens spreadsheets in it with a click.

## License

Uses [fflate](https://github.com/101arrowz/fflate) 0.8.2 (MIT, [license](LICENSE-fflate.txt)) as a
fallback unzipper.
