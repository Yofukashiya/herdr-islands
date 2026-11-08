#!/bin/sh
# Installs (or updates) the Islands layout and mods for Herdr app on macOS (and Linux).
#
# Everything (layout + all mods):
#   curl -fsSL https://raw.githubusercontent.com/Yofukashiya/herdr-islands/main/install.sh | sh
# Only some mods, for your own layout:
#   curl -fsSL https://raw.githubusercontent.com/Yofukashiya/herdr-islands/main/install.sh | sh -s -- status-bar sheet-viewer
# From a clone:
#   sh install.sh [mod ...]
#
# Safe to run while Herdr is open and safe to run again: an update keeps your
# Look settings (mods/sidebar-chrome/settings.json).
# HERDR_APP_HOME picks another Herdr folder; HERDR_ISLANDS_NO_START=1 skips starting Herdr;
# HERDR_ISLANDS_MODS="a,b" is another way to name mods.
set -eu

REPO=Yofukashiya/herdr-islands
ALL="sidebar-chrome space-list agent-list tab-bar pane-header file-browser mod-manager status-bar agent-radar sheet-viewer"

say() { printf '%s\n' "$*"; }

# Where a mod installed on its own goes; the mod's README has the details.
hint() {
  case $1 in
    sidebar-chrome) say "  $1: in your layout, use it for the sidebar's \"brand\" block (and \"footer\" with props {\"footer\": true})." ;;
    space-list) say "  $1: in your layout, use it where the sidebar has \"spaces\"." ;;
    agent-list) say "  $1: in your layout, use it where the sidebar has \"agents\"." ;;
    tab-bar) say "  $1: in your layout, use it where the tab bar has \"tabs\"." ;;
    pane-header) say "  $1: in your layout, set it as the pane header: \"pane\": {\"header\": {\"content\": {\"mod\": \"pane-header\"}}}." ;;
    file-browser) say "  $1: in your layout, use it where the side panel has \"files\"." ;;
    mod-manager) say "  $1: open it with: herdr-app do mod.open --name mod-manager (its README shows a key for it)." ;;
    status-bar) say "  $1: Herdr docks it at the bottom of the layout you are looking at." ;;
    agent-radar) say "  $1: add it to your layout's root: \"floating\": [{\"id\": \"radar\", \"content\": {\"mod\": \"agent-radar\"}, \"edge\": \"right\", \"align\": \"center\", \"peek\": 30}]." ;;
    sheet-viewer) say "  $1: spreadsheets open in it from file-browser, or: herdr-app do tab.new --mod sheet-viewer --props '{\"file\":\"/path/book.xlsx\"}'." ;;
  esac
}

PICKED=$(printf '%s ' "$@" "${HERDR_ISLANDS_MODS:-}" | tr ',' ' ')
MODS=""
for m in $PICKED; do
  case " $ALL " in
    *" $m "*) case " $MODS " in *" $m "*) ;; *) MODS="$MODS $m" ;; esac ;;
    *) say "Unknown mod: $m. Mods: $ALL."; exit 1 ;;
  esac
done
if [ -n "$MODS" ]; then SINGLE=1; else SINGLE=""; MODS=$ALL; fi

TARGET=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
# Staging lives inside the Herdr folder, so moving a finished mod folder into mods/ is a rename on
# the same disk: Herdr sees it complete, never a folder without mod.json (which it would dock as a panel).
STAGE=$TARGET/.islands-install
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
    if [ -z "$SINGLE" ]; then
      # The Islands layout places every mod itself; "none" keeps Herdr from also docking a new mod
      # into whatever layout is on screen right now (it does that once, the first time it sees a mod).
      sed 's/"place"[[:space:]]*:[[:space:]]*"[a-z]*"/"place": "none"/' "$STAGE/new-$m/mod.json" > "$STAGE/mod.json"
      mv "$STAGE/mod.json" "$STAGE/new-$m/mod.json"
    fi
    mv "$STAGE/new-$m" "$to"
    say "  installed  $m"
  fi
done
if [ -z "$SINGLE" ]; then
  cp "$SRC"/layouts/islands.* "$TARGET/layouts/"
  say "  layout     islands"
fi
# sidebar-chrome's default backdrop is this grid image.
case " $MODS " in
  *" sidebar-chrome "*)
    cp "$SRC"/backgrounds/* "$TARGET/backgrounds/"
    say "  backdrop   backgrounds/islands-grid.png" ;;
esac

hints() {
  for m in $MODS; do hint "$m"; done
  say "  More: https://github.com/$REPO/tree/main/mods"
}

if command -v herdr-app >/dev/null 2>&1; then CLI=herdr-app
elif [ -x "$HOME/.local/bin/herdr-app" ]; then CLI=$HOME/.local/bin/herdr-app
else
  say ""
  if [ -n "$SINGLE" ]; then
    say "Files are in place. The herdr-app command was not found (open Herdr once from Applications to"
    say "create ~/.local/bin/herdr-app). Next:"
    hints
  else
    say "Files are in place. The herdr-app command was not found: open Herdr once from Applications"
    say "(it creates ~/.local/bin/herdr-app), then switch layouts until Islands shows."
  fi
  exit 0
fi

bad=""
n=0
for m in $MODS; do
  n=$((n + 1))
  if ! out=$("$CLI" check "$TARGET/mods/$m" 2>&1); then bad="$bad $m"; say "$out"; fi
done
if [ -n "$bad" ]; then
  say ""
  say "Some mods failed the check:$bad."
  [ -n "$SINGLE" ] || say "The layout was not switched."
  exit 1
fi
say "  checked    $n mod(s)"

if [ -n "$SINGLE" ]; then
  say ""
  say "Done. Next:"
  hints
  exit 0
fi

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
