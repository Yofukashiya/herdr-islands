# git-changes

**Changes** for [Herdr app](https://herdr.dev). Part of [Herdr Islands](../../README.md), and it works on its own.

Herdr's Changes panel (the shipped `changes` mod, cloned). It works the same way: the uncommitted files of
the focused terminal's repo, a file's diff, and a box to commit everything.

One thing is different. When a pane without a folder gets focus, such as a file opened from Files or any
mod's tab, the panel stays where it is. The shipped one cleared itself there and loaded again, and a
commit message you were typing was lost.

## Install only this mod

Windows (PowerShell):

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Yofukashiya/herdr-islands/main/install.ps1))) git-changes
```

macOS (Terminal):

```sh
curl -fsSL https://raw.githubusercontent.com/Yofukashiya/herdr-islands/main/install.sh | sh -s -- git-changes
```

Or copy this folder to `~/.config/herdr-app/mods/git-changes`. Herdr picks it up without a restart.

## Where it goes

Use it where your layout has Herdr's `changes`:

```json
{ "id": "changes", "type": "block", "content": { "mod": "git-changes" } }
```

## Works with

The Changes button in `tab-bar` (and in Herdr's own `tabs`) opens the block with the id `changes`, so
keep that id.
