# Installs (or updates) the Islands layout and mods for Herdr app on Windows.
#
# Everything (layout + all mods):
#   irm https://raw.githubusercontent.com/Yofukashiya/herdr-islands/main/install.ps1 | iex
# Only some mods, for your own layout:
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/Yofukashiya/herdr-islands/main/install.ps1))) status-bar sheet-viewer
# From a clone:
#   powershell -ExecutionPolicy Bypass -File install.ps1 [mod ...]
#
# Safe to run while Herdr is open and safe to run again: an update keeps your
# Look settings (mods/sidebar-chrome/settings.json).
# HERDR_APP_HOME picks another Herdr folder; HERDR_ISLANDS_NO_START=1 skips starting Herdr;
# HERDR_ISLANDS_MODS="a,b" is another way to name mods.
# ASCII only: Windows PowerShell 5.1 reads scripts without a BOM as ANSI.

& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'

  $repo = 'Yofukashiya/herdr-islands'
  $all = 'sidebar-chrome', 'space-list', 'agent-list', 'tab-bar', 'pane-header',
         'file-browser', 'mod-manager', 'status-bar', 'agent-radar', 'sheet-viewer'
  # Where a mod installed on its own goes; the mod's README has the details.
  $hints = @{
    'sidebar-chrome' = 'In your layout, use it for the sidebar''s "brand" block (and "footer" with props {"footer": true}).'
    'space-list'     = 'In your layout, use it where the sidebar has "spaces".'
    'agent-list'     = 'In your layout, use it where the sidebar has "agents".'
    'tab-bar'        = 'In your layout, use it where the tab bar has "tabs".'
    'pane-header'    = 'In your layout, set it as the pane header: "pane": {"header": {"content": {"mod": "pane-header"}}}.'
    'file-browser'   = 'In your layout, use it where the side panel has "files".'
    'mod-manager'    = 'Open it with: herdr-app do mod.open --name mod-manager (its README shows a key for it).'
    'status-bar'     = 'Herdr docks it at the bottom of the layout you are looking at.'
    'agent-radar'    = 'Add it to your layout''s root: "floating": [{"id": "radar", "content": {"mod": "agent-radar"}, "edge": "right", "align": "center", "peek": 30}].'
    'sheet-viewer'   = 'Spreadsheets open in it from file-browser, or: herdr-app do tab.new --mod sheet-viewer --props ''{"file":"C:/path/book.xlsx"}''.'
  }

  $picked = @($args | ForEach-Object { "$_" -split ',' } | Where-Object { $_ })
  if ($env:HERDR_ISLANDS_MODS) { $picked += @($env:HERDR_ISLANDS_MODS -split '[,\s]+' | Where-Object { $_ }) }
  $single = $picked.Count -gt 0
  $unknown = @($picked | Where-Object { $all -notcontains $_ })
  if ($unknown) {
    Write-Host "Unknown mod: $($unknown -join ', '). Mods: $($all -join ', ')." -ForegroundColor Red
    return
  }
  $mods = if ($single) { @($picked | Select-Object -Unique) } else { $all }

  $target = if ($env:HERDR_APP_HOME) { $env:HERDR_APP_HOME } else { Join-Path $HOME '.config\herdr-app' }
  # Staging lives inside the Herdr folder, so moving a finished mod folder into mods\ is a rename on
  # the same drive: Herdr sees it complete, never a folder without mod.json (which it would dock as a panel).
  $stage = Join-Path $target '.islands-install'

  function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }

  try {
    foreach ($d in 'mods', 'layouts', 'backgrounds') { New-Item -ItemType Directory -Force (Join-Path $target $d) | Out-Null }
    if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
    New-Item -ItemType Directory $stage | Out-Null

    $here = $PSScriptRoot
    if ($here -and (Test-Path (Join-Path $here 'mods\sheet-viewer\mod.json'))) {
      $src = $here
      Say "Installing from $src"
    } else {
      Say "Downloading $repo..."
      [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
      $zip = Join-Path $stage 'src.zip'
      Invoke-WebRequest -UseBasicParsing "https://codeload.github.com/$repo/zip/refs/heads/main" -OutFile $zip
      Expand-Archive $zip (Join-Path $stage 'src') -Force
      $src = (Get-ChildItem (Join-Path $stage 'src') -Directory | Select-Object -First 1).FullName
    }

    foreach ($m in $mods) {
      $from = Join-Path $src "mods\$m"
      $to = Join-Path $target "mods\$m"
      if (Test-Path $to) {
        # Update in place (Herdr reloads changed files); keep the person's settings.
        $settings = Join-Path $to 'settings.json'
        $kept = if (Test-Path $settings) { [IO.File]::ReadAllBytes($settings) } else { $null }
        Copy-Item -Recurse -Force (Join-Path $from '*') $to
        if ($kept) { [IO.File]::WriteAllBytes($settings, $kept) }
        Say "  updated    $m"
      } else {
        $tmp = Join-Path $stage "new-$m"
        Copy-Item -Recurse $from $tmp
        if (-not $single) {
          # The Islands layout places every mod itself; "none" keeps Herdr from also docking a new mod
          # into whatever layout is on screen right now (it does that once, the first time it sees a mod).
          $meta = Join-Path $tmp 'mod.json'
          $json = [IO.File]::ReadAllText($meta) -replace '"place"\s*:\s*"[a-z]+"', '"place": "none"'
          [IO.File]::WriteAllText($meta, $json)
        }
        Move-Item $tmp $to
        Say "  installed  $m"
      }
    }
    if (-not $single) {
      Copy-Item -Force (Join-Path $src 'layouts\islands.*') (Join-Path $target 'layouts')
      Say "  layout     islands"
    }
    # sidebar-chrome's default backdrop is this grid image.
    if (-not $single -or $mods -contains 'sidebar-chrome') {
      Copy-Item -Force (Join-Path $src 'backgrounds\*') (Join-Path $target 'backgrounds')
      Say "  backdrop   backgrounds\islands-grid.png"
    }
  } finally {
    if (Test-Path $stage) { Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue }
  }
  # Windows PowerShell 5.1 turns a native program's redirected stderr into errors; with 'Stop' that
  # would abort on the first message. From here on, exit codes decide.
  $ErrorActionPreference = 'Continue'

  function Hints {
    foreach ($m in $mods) { Say "  $m`: $($hints[$m])" }
    Say "  More: https://github.com/$repo/tree/main/mods"
  }

  $cli = (Get-Command herdr-app -ErrorAction SilentlyContinue).Source
  if (-not $cli) {
    $guess = Join-Path $env:LOCALAPPDATA 'Programs\herdr-app\herdr-app.exe'
    if (Test-Path $guess) { $cli = $guess }
  }
  if (-not $cli) {
    if ($single) { Say "`nFiles are in place. Herdr app was not found; once it's installed:" Yellow; Hints }
    else { Say "`nFiles are in place. Herdr app was not found: install it, open it and press Ctrl+Shift+L until Islands shows." Yellow }
    return
  }

  # herdr-app.exe is a GUI program: PowerShell waits for it, and sets $LASTEXITCODE, only when its
  # output goes into a pipeline. So every call below pipes, even when the output is thrown away.
  $bad = @()
  foreach ($m in $mods) {
    $out = & $cli check (Join-Path $target "mods\$m") 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { $bad += $m; Say $out.Trim() Red }
  }
  if ($bad) {
    Say "`nSome mods failed the check: $($bad -join ', ')." Red
    if (-not $single) { Say 'The layout was not switched.' Red }
    return
  }
  Say "  checked    $($mods.Count) mod(s)"

  if ($single) {
    Say "`nDone. Next:" Green
    Hints
    return
  }

  function Running { & $cli status 2>&1 | Out-Null; return $LASTEXITCODE -eq 0 }
  if (-not (Running)) {
    if ($env:HERDR_ISLANDS_NO_START) {
      Say "`nDone. Open Herdr and press Ctrl+Shift+L until Islands shows." Green
      return
    }
    Say "Starting Herdr..."
    $lnk = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Herdr.lnk'
    if (Test-Path $lnk) { Start-Process $lnk } else { Start-Process $cli }
    for ($i = 0; $i -lt 60 -and -not (Running); $i++) { Start-Sleep -Milliseconds 500 }
  }
  & $cli do layout.switch --name islands 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) {
    Say "`nDone: Herdr shows the Islands layout. Ctrl+Shift+L cycles layouts; the Mods button (top right) manages mods and the look." Green
  } else {
    Say "`nDone. In Herdr press Ctrl+Shift+L until Islands shows." Green
  }
} @args
