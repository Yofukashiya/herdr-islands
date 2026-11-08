// The tree's git marks, the way an IDE shows them: a changed file's name in its status color with
// VS Code's letter after it, a dot on every folder with changes inside (open or not), ignored files
// dimmed. Pure: no herdr calls, so it's tested with Node (tests/file-browser-git.test.mjs).

// One spelling per path, so git's "C:/repo/a.js" and a Windows pane's "c:\repo" find the same mark.
// Only a Windows path ("C:\", "\\server") is respelled: on macOS and Linux "\" is part of a name.
// By the path's shape, not the window's platform: a folder on another machine is that machine's.
export const normPath = (s) => /^([A-Za-z]:|\\\\)/.test(s) ? s.replace(/\\/g, "/").replace(/^([a-z]):/, (_m, d) => d.toUpperCase() + ":") : s;

// What a row shows. `letter`: a changed file's, VS Code's (U untracked, A added, M modified,
// D deleted, ! in conflict), or a folder's that git reports whole (a submodule). `tone`: the color
// its name takes, a letter's or "I" for ignored. `dot`: a folder with changes inside.
const NONE = Object.freeze({ letter: null, tone: null, dot: false });
const IGNORED = Object.freeze({ letter: null, tone: "I", dot: false });

// A folder with several kinds of change inside shows the first of these: a conflict needs you,
// and a deleted file has no row of its own to show it.
const URGENCY = ["!", "D", "M", "A", "U"];

/** The letter for a porcelain v1 status (XY). */
function letterOf(xy) {
  if (xy === "??") return "U";
  // Unmerged: either side U, or both sides added or both deleted.
  if (xy.includes("U") || xy === "AA" || xy === "DD") return "!";
  // Against HEAD, like the Changes panel: a new file stays A after edits, a deleted one is D.
  return xy.includes("D") ? "D" : xy.includes("A") ? "A" : "M";
}

export class Marks {
  /** `top`: the repository's root (none: no marks). */
  constructor(top = null) {
    // Without its trailing slash: git says "C:/" for a repository at a drive's root.
    this.top = top == null ? null : normPath(top).replace(/\/$/, "");
    this.files = new Map(); this.folders = new Map(); this.ignored = new Set();
  }

  /** Marks `rel` (a path in the repository) and the folders above it. */
  add(rel, letter) {
    this.files.set(`${this.top}/${rel}`, letter);
    for (let i = rel.lastIndexOf("/"); i > 0; i = rel.lastIndexOf("/", i - 1)) {
      const folder = `${this.top}/${rel.slice(0, i)}`, had = this.folders.get(folder);
      // Each change marks every folder up to the top, so the ones above outrank this already.
      if (had && URGENCY.indexOf(had) <= URGENCY.indexOf(letter)) break;
      this.folders.set(folder, letter);
    }
  }

  /** Marks `rel` ignored, and with a folder everything in it. */
  ignore(rel) { this.ignored.add(`${this.top}/${rel}`); }

  /** What the row for `path` shows, in any spelling of it. */
  row(path) {
    path = normPath(path);
    const letter = this.files.get(path);
    if (letter) return { letter, tone: letter, dot: false };
    const inside = this.folders.get(path);
    if (inside) return { letter: null, tone: inside, dot: true };
    return this.isIgnored(path) ? IGNORED : NONE;
  }

  /** Whether `path` or a folder above it, up to the repository's root, is ignored. */
  isIgnored(path) {
    if (!this.ignored.size) return false;
    for (let p = path; p.length > this.top.length; p = p.slice(0, p.lastIndexOf("/"))) if (this.ignored.has(p)) return true;
    return false;
  }
}

/**
 * Reads `git status --porcelain=v1 -z --ignored=matching` output; `top` is the repository's root.
 * Only the first `limit` entries count (git lists ignored ones last); the rest aren't even split
 * off. `pause` is awaited every 1,000 entries: the runtime ends a mod that runs ~0.5 s without
 * yielding.
 */
export async function readStatus(stdout, top, { limit = undefined, pause = null } = {}) {
  const marks = new Marks(top), entries = stdout.split("\0", limit).filter(Boolean);
  for (let i = 0; i < entries.length; i++) {
    if (pause && i && i % 1000 === 0) await pause();
    const entry = entries[i], xy = entry.slice(0, 2), rel = entry.slice(3).replace(/\/$/, "");
    if (xy === "!!") marks.ignore(rel);
    else marks.add(rel, letterOf(xy));
  }
  return marks;
}
