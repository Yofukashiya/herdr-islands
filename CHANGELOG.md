# Changelog

All notable changes to this project are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.2] - 2026-11-08

Fixes from CodeRabbit's review of 1.2.0. 1.2.1 was tagged but not published as a release; this
release has its changes too.

### Fixed

- **Files, tabs:** two files with the same name (`a/index.js`, `b/index.js`) get tab names with
  their folder (`index.js · b`), so a second click goes to the right tab.
- **Files, viewer:**
  - files that are never text (archives, media, PDFs, Office files) aren't read: their tab offers
    the default app at once;
  - a text file past 1 MiB is read only up to 16 MB, after asking the OS its size;
  - one on another drive is copied into the cache first.
- **Files, `.xls`:** opens with "Open with default app" instead of the spreadsheet viewer's
  "can't read" error.

## [1.2.1] - 2026-11-08

Fixes from CodeRabbit's reviews of 1.1.2 and 1.1.3.

### Fixed

- **`sheet-viewer`:**
  - conditional formats over large ranges collect their numbers while yielding to the host, and
    sort them once per rule, only when a percentile or a rank needs it, numerically inside the
    engine; before, each threshold copied and sorted every value with a JS comparator;
  - a tiny nonzero number (`1e-10`) in General no longer shows as `0` when it doesn't fit.
- **`status-bar`:** a service whose first read failed with nothing to show keeps its request
  schedule across restarts, instead of being asked again at once.
- **`install.sh`:** a failed copy while updating a mod stops the update; before, `find` hid the error,
  and the update could report success with an old file left behind.
- **`tools/release.py`:** checks every `mod.json` before writing any.

## [1.2.0] - 2026-11-08

### Added

- **Files panel opens files in tabs.** A left click opens a file here in Herdr, in a tab of its own:
  - code and text read-only, with syntax colors and line numbers;
  - pictures fitted to the tab;
  - spreadsheets in the spreadsheet viewer.

  A second click goes to the tab already open. The panel used to show a small read-only preview in
  its own narrow column.
- **Files right-click menu:**
  - on a file, a folder or the empty part of the tree;
  - **Open with default app**, **Open in VS Code / Cursor** (when installed), a terminal editor from
    `settings.json`;
  - **Show in Explorer / Finder**, **Copy path**, **Copy relative path**, **Open terminal here**.

  For files on another machine, only what works there.
- **File tab bar:** each file tab has a bar with its folder and buttons to open it with the default
  app, show it in Explorer / Finder and copy its path.

## [1.1.3] - 2026-11-08

The rest of CodeRabbit's review of 1.1.1 (the nitpicks), and known limits filed as issues
([#2](https://github.com/Yofukashiya/herdr-islands/issues/2) to
[#6](https://github.com/Yofukashiya/herdr-islands/issues/6)) and linked from the README.

### Fixed

- **`sheet-viewer`:**
  - very small General numbers switch to E notation when it shows more of them, as Excel does
    (`-1.2E-05` rather than `-0.00001`);
  - E notation uses the locale's decimal separator and drops trailing zeros (`4.2E+01`);
  - a CSV file is read from disk once instead of twice.
- **Updating a mod in place:**
  - also removes files the new release no longer has (the person's settings, Herdr's generated
    files and hidden ones stay);
  - copies hidden files too.
- **`install.ps1`:** run as a file, a failure (unknown mod, bad `--ref`, a mod failing its check)
  ends with exit code 1. Pasted into a shell, it still leaves the shell open.
- **`tools/release.py`:** closes the files it writes.

## [1.1.2] - 2026-11-08

Fixes from CodeRabbit's review of 1.1.1.

### Fixed

- **`sheet-viewer`:**
  - formulas over whole columns (`=SUM(A1:A1048576)`) stop at the sheet's data instead of reading
    a million cells, which stalled sheets saved without cached values;
  - the workbook copy and the pictures it writes to the cache are removed when the tab closes, as
    the README says.
- **`mod-manager`:** a failed update check no longer hides why an update failed.
- **`sidebar-chrome`:** an update notice isn't marked as shown before it goes out.
- **`status-bar`:**
  - a `providers` value in `usage.json` that isn't a list no longer breaks the bar;
  - total memory and cores are asked again when the first try fails (up to 3 tries), instead of
    leaving MEM off until a reload.
- **`tools/release.py`:** checks the changelog before touching any `mod.json`.

## [1.1.1] - 2026-11-08

Fixes from CodeRabbit's reviews of the whole code. 1.1.0 was tagged but never published as a release; this
is the first release with update notices.

### Security

- `sheet-viewer`: file paths given to PowerShell now escape the curly single quotes (`‘ ’ ‚ ‛`)
  as well, which PowerShell also reads as quotes. A crafted file name could run a command when the
  sheet was opened, and an ordinary name like `John’s report.xlsx` failed to open at all. The
  update launcher quotes its log path the same way.

### Fixed

- **`agent-list`:**
  - clicking a sub-agent row crashed (the hover card's field shadowed the `peek` method);
  - pinning an agent now closes its preview card and stops reading its screen;
  - preview reads no longer overlap on slow (remote) agents.
- **`sheet-viewer`:**
  - opened sheets with whole-column conditional formatting on large ranges (100 000 rows) instead
    of stalling on "Reading the sheet…";
  - rank, average and duplicate rules are worked out once per rule instead of per cell (O(n²)
    before);
  - a sheet that fails to read shows why, with the other sheets to pick, and a slow sheet can no
    longer replace the one picked after it;
  - big CSV files yield to the host while sizing columns;
  - a workbook opened again after it changed on disk no longer shows the old charts;
  - numbers in the General format shrink to the column (fewer decimals, then E notation) as in
    Excel, instead of showing `####`.
- **`file-browser`:** git marks (A, M, D, U) show on Windows, where git and the pane spell paths
  differently.
- **`mod-manager`:**
  - quick changes in Look are written in the order chosen;
  - mods added while the list refreshes are picked up;
  - a clicked Check for updates shows its own answer;
  - switching off a floating block or pane header that's gone no longer leaves it half-parked.
- **`status-bar`:**
  - reads `~/.claude.json` past 1 MiB (for the account email);
  - keeps sampling CPU and memory when the first sample fails.
- **`tab-bar`:** no longer breaks on macOS when the zoom setting is missing.
- **Updates:**
  - a failed download of the installer is reported at once instead of after 5 minutes;
  - updating a mod in place copies `main.js` last, so Herdr reloads it with all its new files.
- **`install.sh`:** a trailing `--ref` with no value gives a clear error.

## [1.1.0] - 2026-11-08

### Added

- **Update notices:**
  - `sidebar-chrome` asks GitHub for a newer release once a day and posts one notice per version;
    clicking it opens Mods.
  - The Mods panel shows the installed version with a **Check for updates** button: the icon spins while
    it checks, and the answer pulses for a moment.
  - When a release is out, a card above the tabs offers **What's new** and **Update**.
  - **Install updates automatically** in Mods → Look (off by default) installs new releases unasked.
- **Installer modes:**
  - `--update` updates only what is installed, keeps your settings and doesn't switch layouts.
  - `--ref <tag>` installs a given release.
- `version` in every `mod.json`, and `tools/release.py` to move it together with the changelog.
- `RECIPE.md` and `preview.png`, for the herdr.dev gallery.

## [1.0.0] - 2026-11-08

First release.

### Added

- **Islands layout** (`layouts/islands.json`): every panel is a rounded card over the backdrop.
- **Grid backdrop** (`backgrounds/islands-grid.png`, generator `make_islands_grid.py`): a grid that
  fades into a gradient, 3840×2160 with soft lines and dithering, so it holds up from 1080p to 4K and
  Retina and survives cropping to any aspect ratio.
- **Standalone mods.** Each of the 10 mods works on its own, in any layout:
  - it keeps its icons in its own folder;
  - every link to another mod is optional, with a fallback;
  - it has a README with standalone install and where it goes.
- **One-command installers** for Windows (`install.ps1`, PowerShell 5.1 and 7) and macOS/Linux
  (`install.sh`):
  - **Full install:** downloads, checks every mod, starts Herdr and switches to Islands.
  - **Single mods:** name some mods to install only those.
  - **Safe while open:** works while Herdr is open, never lets it dock a half-copied mod, and keeps
    your Look settings on update.
- **`mod-manager`:** a Mods panel with three tabs.
  - *Mods:* mods grouped by where they sit (Sidebar, Top bar, Panes, Side panel, Status bar, Floating,
    Not in this layout, Other layouts, Herdr system), with switches, errors, Check and Folder.
  - *Look:* theme, accent, card and pane opacity, backdrop, radar.
  - *Layouts:* every layout with a preview.

  Opens in the side panel, or on its own as a dialog (`mod.open`).
- **`sheet-viewer`:** a read-only viewer for `.xlsx`, `.xlsm`, `.csv` and `.tsv`.
  - *Formatting:* Excel number formats in the system language, fonts, fills and borders.
  - *Layout:* merged cells, frozen panes.
  - *Rules:* conditional formatting (color scales, data bars, icon sets, rules).
  - *Objects:* tables, pictures, charts, shapes.
  - *Extras:* comments, links, sheet tabs.

  The system unzips workbooks, and parsing runs in short slices to stay within Herdr's script time limit.
- **`agent-radar`:** a floating drawer of agents at the window edge, with status and the last line of
  each agent's screen.
- **Agent preview** in `agent-list`: hover an agent to see the bottom of its screen.
- **Space color as the accent** across tabs, pane focus line, status bar, radar and previews.
- **Animations** (native, no timers): limit and memory bars slide to new values; the agents dot pulses
  while working or blocked; the pane focus line and header buttons fade.
- `file-browser`: the shipped Files panel, with spreadsheets opening in `sheet-viewer` when it is
  installed (as text otherwise).
- README in English and Russian, screenshots, MIT license, CodeRabbit review settings.

### Changed (compared with the original Islands mods)

- **Names:** mods renamed from `islands-*` to plain names (`sidebar-chrome`, `space-list`,
  `agent-list`, `tab-bar`, `pane-header`, …).
- **Backdrop:** follows the system appearance: the grid in dark mode, a gradient from the theme's
  colors in light mode.
- **Look settings:** `mods/sidebar-chrome/settings.json` takes `backdrop` (image, `gradient`, `plain`),
  `radar` and `accent`, and applies them live.

### Changed (compared with DanielFGray/herdr-config `usage`, now `status-bar`)

- **Style:** the Islands card style, with the current space and branch on the left.
- **Width:** fits the window width, zoom included, hiding the least important items first instead of
  cutting text.
- **CPU and memory everywhere:** on Windows (`typeperf`) and macOS (`iostat`, `vm_stat`, `sysctl`),
  not only Linux.
- **Fewer tools needed:** no longer needs `jq`, `sh` or `test`. Reads the Claude login from the macOS
  Keychain. The Usage Dashboard link opens on every OS.
- **Limits:** shown as what's left: green from 50%, amber from 11 to 49%, pulsing red at 10% or less.

### Fixed (in the original code)

- **Islands:**
  - terminal panes kept the old theme's color after a theme change;
  - the settings watcher could restyle another layout after a layout switch;
  - on Windows, pane headers shortened only the home folder itself to `~`.
- **Status bar:** every reload of the mod asked all services again, so Claude answered "rate limited";
  the request schedule now survives reloads.

[Unreleased]: https://github.com/Yofukashiya/herdr-islands/compare/v1.2.2...HEAD
[1.2.2]: https://github.com/Yofukashiya/herdr-islands/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/Yofukashiya/herdr-islands/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/Yofukashiya/herdr-islands/compare/v1.1.3...v1.2.0
[1.1.3]: https://github.com/Yofukashiya/herdr-islands/compare/v1.1.2...v1.1.3
[1.1.2]: https://github.com/Yofukashiya/herdr-islands/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/Yofukashiya/herdr-islands/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/Yofukashiya/herdr-islands/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/Yofukashiya/herdr-islands/releases/tag/v1.0.0
