// Folder listings for the tree, many folders per process: a process start is most of a listing's
// cost (powershell takes ~0.2 s to start, a folder ~1 ms to list). Pure but for the `exec` it's
// given, so it's tested with Node against the real shells (tests/file-browser-listing.test.mjs).

/** Entries a folder shows; the script lists one more, to tell that there are more. */
export const PER_FOLDER = 500;

// Both scripts take the folders relative to the working directory ("" is the folder itself) and
// write, NUL-separated, a pair per entry ("d" or "f", the name) and one closing pair per folder:
// "end", "error" and its message, or "skip" for one listed ahead after the budget ran out.

// Links keep directory attributes even when dangling; their target is checked. Other reparse
// points (OneDrive's folders) have no LinkType and are folders. Write's output is UTF-8, as exec
// decodes it.
const POWERSHELL = (must, budget, paths) => "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); " +
  "& { param($must, $budget, $paths) $out = [Console]::Out; $z = [string][char]0; $n = 0; $i = 0; " +
  "foreach ($rel in $paths) { $i++; " +
  "if ($i -gt $must -and $n -ge $budget) { $out.Write('skip' + $z + $z); continue }; " +
  "try { $c = 0; " +
  "foreach ($f in [IO.DirectoryInfo]::new([IO.Path]::GetFullPath($(if ($rel) { $rel } else { '.' }))).EnumerateFileSystemInfos()) { " +
  "if ($f.Name -eq '.git') { continue }; " +
  "$dir = $f -is [IO.DirectoryInfo] -and (-not ($f.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $f.LinkType -or ($f.Target -and [IO.Directory]::Exists([IO.Path]::Combine($f.Parent.FullName, @($f.Target)[0])))); " +
  "$out.Write($(if ($dir) { 'd' } else { 'f' }) + $z + $f.Name + $z); $c++; " +
  `if ($c -gt ${PER_FOLDER}) { break } }; ` +
  "$n += $c; $out.Write('end' + $z + $z) } " +
  "catch { $e = $_.Exception; while ($e.InnerException) { $e = $e.InnerException }; $out.Write('error' + $z + $e.Message + $z) } } } " +
  // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
  `${must} ${budget} @(${paths.map((p) => "'" + p.replace(/['‘’‚‛]/g, "$&$&") + "'").join(", ")})`;

const SH = `must=$1 budget=$2; shift 2; i=0 n=0
for d in "$@"; do
  i=$((i+1))
  if [ "$i" -gt "$must" ] && [ "$n" -ge "$budget" ]; then printf 'skip\\0\\0'; continue; fi
  [ -n "$d" ] || d=.
  if [ ! -d "$d" ]; then printf 'error\\0No such folder\\0'; continue; fi
  if [ ! -r "$d" ] || [ ! -x "$d" ]; then printf 'error\\0Permission denied\\0'; continue; fi
  c=0
  for p in "$d"/* "$d"/.[!.]* "$d"/..?*; do
    [ -e "$p" ] || [ -L "$p" ] || continue
    name=\${p##*/}
    [ "$name" = .git ] && continue
    if [ -d "$p" ]; then k=d; else k=f; fi
    printf '%s\\0%s\\0' "$k" "$name"
    c=$((c+1)); [ "$c" -gt ${PER_FOLDER} ] && break
  done
  n=$((n+c)); printf 'end\\0\\0'
done`;

/** Entries a batch lists in all before it stops listing folders ahead. */
const BUDGET = 5000;

/** Characters of folder paths in one command: Windows refuses a command line over 32,767, and the
 *  script takes some of it. */
const COMMAND_ROOM = 24000;

/** Folders first, then by name. */
const order = (a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name);

/**
 * Lists a batch in one process: the `must` folders, then `ahead` ones until `budget` entries have
 * been listed in all. Paths are relative to `root`; "" is the folder itself.
 *
 * Answers one listing per path, in order:
 * - { entries, more }: folders first, at most PER_FOLDER entries, `more` if there were more;
 * - { error }: why the folder couldn't be listed;
 * - null: an `ahead` folder left out, past the budget or past what one command can carry.
 *
 * `pause` is awaited after every 1,000 entries sorted: the runtime ends a mod that runs ~0.5 s
 * without yielding.
 */
export async function listFolders(exec, { root, on = null, windows = false }, { must, ahead = [] }, { budget = BUDGET, pause = null } = {}) {
  let room = COMMAND_ROOM - must.reduce((n, p) => n + p.length + 4, 0), fit = 0;
  while (fit < ahead.length && (room -= ahead[fit].length + 4) >= 0) fit++;
  const paths = [...must, ...ahead.slice(0, fit)];
  const powershell = () => exec("powershell", ["-NoProfile", "-Command", POWERSHELL(must.length, budget, paths)], { cwd: root, on });
  let r;
  if (windows) r = await powershell();
  else {
    try { r = await exec("sh", ["-c", SH, "files", String(must.length), String(budget), ...paths], { cwd: root, on }); }
    catch (e) {
      // A Windows machine reached through herdr-core has no sh.
      if (on && String(e).includes("cannot start sh: program not found")) r = await powershell();
      else throw e;
    }
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [...must, ...ahead].map(() => null);
  let folder = 0, entries = [], sinceYield = 0;
  for (let i = 0; i + 1 < fields.length && folder < paths.length; i += 2) {
    const kind = fields[i], value = fields[i + 1];
    if (kind === "d" || kind === "f") { entries.push({ name: value, dir: kind === "d" }); continue; }
    if (kind === "end") {
      if (pause && sinceYield >= 1000) { await pause(); sinceYield = 0; }
      out[folder] = { entries: entries.slice(0, PER_FOLDER).sort(order), more: entries.length > PER_FOLDER };
      sinceYield += entries.length;
    } else if (kind === "error") out[folder] = { error: value.trim() || "Cannot list this folder" };
    folder++; entries = [];
  }
  return out;
}
