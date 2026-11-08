#!/bin/sh
# Installs (or updates) the Islands layout and mods for Herdr app on macOS (and Linux).
#
#   curl -fsSL https://raw.githubusercontent.com/Yofukashiya/herdr-islands/main/install.sh | sh
#
# From a clone:  sh install.sh
#
# Safe to run while Herdr is open and safe to run again: an update keeps your
# Look settings (mods/sidebar-chrome/settings.json).
# HERDR_APP_HOME picks another Herdr folder; HERDR_ISLANDS_NO_START=1 skips starting Herdr.
set -eu

REPO=Yofukashiya/herdr-islands
MODS="sidebar-chrome space-list agent-list tab-bar pane-header file-browser mod-manager status-bar agent-radar sheet-viewer"
TARGET=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
# Staging lives inside the Herdr folder, so moving a finished mod folder into mods/ is a rename on
# the same disk: Herdr sees it complete, never a folder without mod.json (which it would dock as a panel).
STAGE=$TARGET/.islands-install

say() { printf '%s\n' "$*"; }
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$TARGET/mods" "$TARGET/layouts" "$TARGET/backgrounds"
rm -rf "$STAGE"
mkdir -p "$STAGE"

here=$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)
if [ -n "$here" ] && [ -f "$here/install.sh" ] && [ -f "$here/mods/sheet-viewer/mod.json" ]; then
  SRC=$here
  say "Installing from $SRC"
else
  say "Downloading $REPO..."
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/main" | tar -xzf - -C "$STAGE"
  SRC=$(find "$STAGE" -mindepth 1 -maxdepth 1 -type d | head -n 1)
fi

for m in $MODS; do
  to=$TARGET/mods/$m
  if [ -d "$to" ]; then
    # Update in place (Herdr reloads changed files); keep the person's settings.
    kept=""
    if [ -f "$to/settings.json" ]; then kept=$STAGE/settings-$m.json; cp "$to/settings.json" "$kept"; fi
    cp -R "$SRC/mods/$m/." "$to/"
    if [ -n "$kept" ]; then cp "$kept" "$to/settings.json"; fi
    say "  updated    $m"
  else
    cp -R "$SRC/mods/$m" "$STAGE/new-$m"
    mv "$STAGE/new-$m" "$to"
    say "  installed  $m"
  fi
done
cp "$SRC"/layouts/islands.* "$TARGET/layouts/"
cp "$SRC"/backgrounds/* "$TARGET/backgrounds/"
say "  layout     islands"

if command -v herdr-app >/dev/null 2>&1; then CLI=herdr-app
elif [ -x "$HOME/.local/bin/herdr-app" ]; then CLI=$HOME/.local/bin/herdr-app
else
  say ""
  say "Files are in place. The herdr-app command was not found: open Herdr once from Applications"
  say "(it creates ~/.local/bin/herdr-app), then switch layouts until Islands shows."
  exit 0
fi

bad=""
for m in $MODS; do
  if ! out=$("$CLI" check "$TARGET/mods/$m" 2>&1); then bad="$bad $m"; say "$out"; fi
done
if [ -n "$bad" ]; then
  say ""
  say "Some mods failed the check:$bad. The layout was not switched."
  exit 1
fi
say "  checked    all 10 mods"

running() { "$CLI" status >/dev/null 2>&1; }
if ! running; then
  if [ -n "${HERDR_ISLANDS_NO_START:-}" ]; then
    say ""
    say "Done. Open Herdr and switch layouts (layout.switch) until Islands shows."
    exit 0
  fi
  say "Starting Herdr..."
  if [ "$(uname)" = Darwin ] && open -a Herdr >/dev/null 2>&1; then :
  else nohup "$CLI" >/dev/null 2>&1 &
  fi
  i=0
  while [ $i -lt 60 ] && ! running; do sleep 0.5; i=$((i + 1)); done
fi
if "$CLI" do layout.switch --name islands >/dev/null 2>&1; then
  say ""
  say "Done: Herdr shows the Islands layout. The Mods button (top right) manages mods and the look."
else
  say ""
  say "Done. In Herdr switch layouts (layout.switch) until Islands shows."
fi
