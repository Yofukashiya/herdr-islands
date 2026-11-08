# Changelog

All notable changes to this project are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/Yofukashiya/herdr-islands/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Yofukashiya/herdr-islands/releases/tag/v1.0.0
