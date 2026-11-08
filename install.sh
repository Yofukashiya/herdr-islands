#!/bin/sh
# Installs (or updates) the Islands layout and mods for Herdr app on macOS (and Linux).
#
# Everything (layout + all mods):
#   curl -fsSL https://raw.githubusercontent.com/Yofukashiya/herdr-islands/main/install.sh | sh
# Only some mods, for your own layout:
#   curl -fsSL https://raw.githubusercontent.com/Yofukashiya/herdr-islands/main/install.sh | sh -s -- status-bar sheet-viewer
# Update what is installed (what the Mods panel runs):  ... | sh -s -- --update [--ref v1.2.0]
# From a clone:
#   sh install.sh [mod ...] [--update] [--ref <tag>]
#
# Safe to run while Herdr is open and safe to run again: an update keeps your
# Look settings (mods/sidebar-chrome/settings.json).
# HERDR_APP_HOME picks another Herdr folder; HERDR_ISLANDS_NO_START=1 skips starting Herdr;
# HERDR_ISLANDS_MODS="a,b" is another way to name mods.
set -eu

REPO=Yofukashiya/herdr-islands
ALL="sidebar-chrome space-list agent-list tab-bar pane-header file-browser git-changes mod-manager status-bar agent-radar sheet-viewer"

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
    git-changes) say "  $1: in your layout, use it where the side panel has \"changes\"." ;;
    mod-manager) say "  $1: open it with: herdr-app do mod.open --name mod-manager (its README shows a key for it)." ;;
    status-bar) say "  $1: Herdr docks it at the bottom of the layout you are looking at." ;;
    agent-radar) say "  $1: add it to your layout's root: \"floating\": [{\"id\": \"radar\", \"content\": {\"mod\": \"agent-radar\"}, \"edge\": \"right\", \"align\": \"center\", \"peek\": 30}]." ;;
    sheet-viewer) say "  $1: spreadsheets open in it from file-browser, or: herdr-app do tab.new --mod sheet-viewer --props '{\"file\":\"/path/book.xlsx\"}'." ;;
  esac
}

# Arguments: mod names (or "a,b"), --update, --ref <branch or tag>.
UPDATE=""
REF=main
PICKED=""
while [ $# -gt 0 ]; do
  case $1 in
    --update) UPDATE=1 ;;
    # A trailing --ref with no value leaves REF empty, which the check below reports (a second
    # shift with nothing left would end the script silently under set -e).
    --ref) if [ $# -ge 2 ]; then shift; REF=$1; else REF=""; break; fi ;;
    *) PICKED="$PICKED $(printf '%s' "$1" | tr ',' ' ')" ;;
  esac
  shift
done
PICKED="$PICKED $(printf '%s' "${HERDR_ISLANDS_MODS:-}" | tr ',' ' ')"

# An update runs unattended from the Mods panel, which reads the last line of its log and the exit code.
fail() {
  say "$1"
  if [ -n "$UPDATE" ]; then say "islands-update: failed $1"; fi
  exit 1
}

case $REF in
  ''|*[!A-Za-z0-9._/-]*) fail "Bad --ref: $REF" ;;
esac

MODS=""
for m in $PICKED; do
  case " $ALL " in
    *" $m "*) case " $MODS " in *" $m "*) ;; *) MODS="$MODS $m" ;; esac ;;
    *) fail "Unknown mod: $m. Mods: $ALL." ;;
  esac
done

TARGET=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
# full: the layout and every mod; pick: the named mods; update: whatever of this is installed.
if [ -n "$UPDATE" ]; then
  MODE=update
  MODS=""
  for m in $ALL; do [ -f "$TARGET/mods/$m/mod.json" ] && MODS="$MODS $m"; done
  [ -n "$MODS" ] || fail "Nothing from Herdr Islands is installed in $TARGET."
elif [ -n "$MODS" ]; then
  MODE=pick
else
  MODE=full
  MODS=$ALL
fi

# Staging lives inside the Herdr folder, so moving a finished mod folder into mods/ is a rename on
# the same disk: Herdr sees it complete, never a folder without mod.json (which it would dock as a panel).
STAGE=$TARGET/.islands-install
cleanup() {
  rc=$?
  rm -rf "$STAGE"
  if [ "$rc" -ne 0 ] && [ "$MODE" = update ]; then say "islands-update: failed (exit $rc)"; fi
  exit "$rc"
}
trap cleanup EXIT

mkdir -p "$TARGET/mods" "$TARGET/layouts" "$TARGET/backgrounds"
rm -rf "$STAGE"
mkdir -p "$STAGE"

here=$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)
if [ -n "$here" ] && [ -f "$here/install.sh" ] && [ -f "$here/mods/sheet-viewer/mod.json" ]; then
  SRC=$here
  say "Installing from $SRC"
else
  say "Downloading $REPO ($REF)..."
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/$REF" | tar -xzf - -C "$STAGE"
  SRC=$(find "$STAGE" -mindepth 1 -maxdepth 1 -type d | head -n 1)
fi
# An update also installs a mod the new Islands layout uses that isn't here yet (one a release
# added): the layout is replaced below, and its block would point at a missing mod.
if [ "$MODE" = update ] && [ -f "$TARGET/layouts/islands.json" ]; then
  placed=" $(grep -o '"mod"[[:space:]]*:[[:space:]]*"[A-Za-z0-9_-]*"' "$SRC/layouts/islands.json" | cut -d '"' -f 4 | tr '\n' ' ') "
  for m in $ALL; do
    case " $MODS " in *" $m "*) continue ;; esac
    case $placed in *" $m "*) MODS="$MODS $m" ;; esac
  done
fi

for m in $MODS; do
  to=$TARGET/mods/$m
  if [ -d "$to" ]; then
    # Update in place (Herdr reloads changed files); keep the person's settings. main.js goes
    # last: Herdr reloads a mod on each file that changes, and the reload the entry point
    # triggers then finds every new module already there. Interrupted: run it again.
    kept=""
    if [ -f "$to/settings.json" ]; then kept=$STAGE/settings-$m.json; cp "$to/settings.json" "$kept"; fi
    # find, not a glob: it takes hidden files too and copes with an empty folder. The `+` form makes
    # find fail when a cp fails (with `\;` it would still exit 0), so set -e stops a half update.
    find "$SRC/mods/$m" -mindepth 1 -maxdepth 1 ! -name main.js -exec sh -c 'cp -R "$@" "$0"' "$to/" {} +
    cp "$SRC/mods/$m/main.js" "$to/main.js"
    if [ -n "$kept" ]; then cp "$kept" "$to/settings.json"; fi
    # Files this release no longer has go too: a removed module would linger. The person's
    # settings, the files Herdr generates and hidden ones (cache, update log) stay.
    for f in "$to"/*; do
      [ -e "$f" ] || continue
      case ${f##*/} in settings.json|gpui-kit.d.ts|jsconfig.json) continue ;; esac
      [ -e "$SRC/mods/$m/${f##*/}" ] || rm -rf "$f"
    done
    say "  updated    $m"
  else
    cp -R "$SRC/mods/$m" "$STAGE/new-$m"
    if [ "$MODE" != pick ]; then
      # The Islands layout places every mod itself (a full install, or one an update adds for the
      # layout); "none" keeps Herdr from also docking a new mod into whatever layout is on screen
      # right now (it does that once, the first time it sees a mod).
      sed 's/"place"[[:space:]]*:[[:space:]]*"[a-z]*"/"place": "none"/' "$STAGE/new-$m/mod.json" > "$STAGE/mod.json"
      mv "$STAGE/mod.json" "$STAGE/new-$m/mod.json"
    fi
    mv "$STAGE/new-$m" "$to"
    say "  installed  $m"
  fi
done
if [ "$MODE" = full ] || { [ "$MODE" = update ] && [ -f "$TARGET/layouts/islands.json" ]; }; then
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
  if [ "$MODE" = update ]; then say "islands-update: ok $REF"; exit 0; fi
  say ""
  if [ "$MODE" = pick ]; then
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
  [ "$MODE" = full ] && say "The layout was not switched."
  fail "Some mods failed the check:$bad."
fi
say "  checked    $n mod(s)"

if [ "$MODE" = update ]; then say "islands-update: ok $REF"; exit 0; fi
if [ "$MODE" = pick ]; then
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
