# Installs (or updates) the Islands layout and mods for Herdr app on Windows.
#
#   irm https://raw.githubusercontent.com/Yofukashiya/herdr-islands/main/install.ps1 | iex
#
# From a clone:  powershell -ExecutionPolicy Bypass -File install.ps1
#
# Safe to run while Herdr is open and safe to run again: an update keeps your
# Look settings (mods/sidebar-chrome/settings.json).
# HERDR_APP_HOME picks another Herdr folder; HERDR_ISLANDS_NO_START=1 skips starting Herdr.
# ASCII only: Windows PowerShell 5.1 reads scripts without a BOM as ANSI.

& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'

  $repo = 'Yofukashiya/herdr-islands'
  $mods = 'sidebar-chrome', 'space-list', 'agent-list', 'tab-bar', 'pane-header',
          'file-browser', 'mod-manager', 'status-bar', 'agent-radar', 'sheet-viewer'
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
        Move-Item $tmp $to
        Say "  installed  $m"
      }
    }
    Copy-Item -Force (Join-Path $src 'layouts\islands.*') (Join-Path $target 'layouts')
    Copy-Item -Force (Join-Path $src 'backgrounds\*') (Join-Path $target 'backgrounds')
    Say "  layout     islands"
  } finally {
    if (Test-Path $stage) { Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue }
  }
  # Windows PowerShell 5.1 turns a native program's redirected stderr into errors; with 'Stop' that
  # would abort on the first message. From here on, exit codes decide.
  $ErrorActionPreference = 'Continue'

  $cli = (Get-Command herdr-app -ErrorAction SilentlyContinue).Source
  if (-not $cli) {
    $guess = Join-Path $env:LOCALAPPDATA 'Programs\herdr-app\herdr-app.exe'
    if (Test-Path $guess) { $cli = $guess }
  }
  if (-not $cli) {
    Say "`nFiles are in place. Herdr app was not found: install it, open it and press Ctrl+Shift+L until Islands shows." Yellow
    return
  }

  $bad = @()
  foreach ($m in $mods) {
    $out = & $cli check (Join-Path $target "mods\$m") 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { $bad += $m; Say $out.Trim() Red }
  }
  if ($bad) {
    Say "`nSome mods failed the check: $($bad -join ', '). The layout was not switched." Red
    return
  }
  Say "  checked    all $($mods.Count) mods"

  # herdr-app.exe is a GUI program: PowerShell waits for it, and sets $LASTEXITCODE, only when its
  # output goes into a pipeline. So every call below pipes, even when the output is thrown away.
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
}
