// The tree's git marks, the way an IDE shows them: a changed file's name in its status color with
// VS Code's letter after it, a dot on every folder with changes inside (open or not), ignored files
// dimmed. Pure: no herdr calls, so it's tested with Node (tests/file-browser-git.test.mjs).

/**
 * One spelling per path, so git's "C:/repo/a.js" and a Windows pane's "c:\repo" find the same mark.
 * Only a Windows path ("C:\", "\\server") is respelled: on macOS and Linux "\" is part of a name.
 * By the path's shape, not the window's platform: a folder on another machine is that machine's.
 * @param {string} s
 */
export const normPath = (s) => /^([A-Za-z]:|\\\\)/.test(s) ? s.replace(/\\/g, "/").replace(/^([a-z]):/, (_m, /** @type {string} */ d) => d.toUpperCase() + ":") : s;

/**
 * A changed path's letter, as VS Code has them: U untracked, A added, M modified, D deleted,
 * ! in conflict.
 * @typedef {"U" | "A" | "M" | "D" | "!"} Letter
 */
/**
 * What a row shows. `letter`: a changed file's (or a folder git reports whole, like a submodule).
 * `tone`: the color its name takes, a letter's or "I" for ignored. `dot`: changes inside a folder.
 * @typedef {{ letter: Letter | null, tone: Letter | "I" | null, dot: boolean }} Row
 */

/** @type {Row} */
const NONE = Object.freeze({ letter: null, tone: null, dot: false });
/** @type {Row} */
const IGNORED = Object.freeze({ letter: null, tone: "I", dot: false });

/** A folder with several kinds of change inside shows the first of these: a conflict needs you,
 *  and a deleted file has no row of its own to show it.
 *  @type {Letter[]} */
const URGENCY = ["!", "D", "M", "A", "U"];

/**
 * The letter for a porcelain v1 status (`XY`).
 * @param {string} xy
 * @returns {Letter}
 */
function letterOf(xy) {
  if (xy === "??") return "U";
  // Unmerged: either side U, or both sides added or both deleted.
  if (xy.includes("U") || xy === "AA" || xy === "DD") return "!";
  // Against HEAD, like the Changes panel: a new file stays A after edits, a deleted one is D.
  return xy.includes("D") ? "D" : xy.includes("A") ? "A" : "M";
}

export class Marks {
  /** @param {string | null} top the repository's root, in normPath's spelling; none for no marks */
  constructor(top = null) {
    this.top = top;
    /** @type {Map<string, Letter>} */
    this.files = new Map();
    /** @type {Map<string, Letter>} */
    this.folders = new Map();
    /** @type {Set<string>} */
    this.ignored = new Set();
  }

  /**
   * Marks `rel` (a path in the repository) and the folders above it.
   * @param {string} rel
   * @param {Letter} letter
   */
  add(rel, letter) {
    this.files.set(`${this.top}/${rel}`, letter);
    for (let i = rel.lastIndexOf("/"); i > 0; i = rel.lastIndexOf("/", i - 1)) {
      const folder = `${this.top}/${rel.slice(0, i)}`, had = this.folders.get(folder);
      // Each change marks every folder up to the top, so the ones above outrank this already.
      if (had && URGENCY.indexOf(had) <= URGENCY.indexOf(letter)) break;
      this.folders.set(folder, letter);
    }
  }

  /**
   * What the row for `path` shows, in any spelling of it.
   * @param {string} path
   * @returns {Row}
   */
  row(path) {
    path = normPath(path);
    const letter = this.files.get(path);
    if (letter) return { letter, tone: letter, dot: false };
    const inside = this.folders.get(path);
    if (inside) return { letter: null, tone: inside, dot: true };
    return this.isIgnored(path) ? IGNORED : NONE;
  }

  /**
   * Whether `path` or a folder above it, up to the repository's root, is ignored.
   * @param {string} path
   */
  isIgnored(path) {
    if (!this.ignored.size) return false;
    for (let p = path; p.length > this.top.length; p = p.slice(0, p.lastIndexOf("/"))) if (this.ignored.has(p)) return true;
    return false;
  }
}

/**
 * Reads `git status --porcelain=v1 -z --ignored=matching` output; `top` is the repository's root.
 * Only the first `limit` entries count (git lists ignored ones last). `pause` is awaited every
 * 1,000 entries: the runtime ends a mod that runs ~0.5 s without yielding.
 * @param {string} stdout
 * @param {string} top
 * @param {{ limit?: number, pause?: (() => Promise<void>) | null }} [options]
 */
export async function readStatus(stdout, top, { limit = 5000, pause = null } = {}) {
  const marks = new Marks(normPath(top)), entries = stdout.split("\0").filter(Boolean).slice(0, limit);
  for (let i = 0; i < entries.length; i++) {
    if (pause && i && i % 1000 === 0) await pause();
    const entry = entries[i], xy = entry.slice(0, 2), rel = entry.slice(3).replace(/\/$/, "");
    if (xy === "!!") marks.ignored.add(`${marks.top}/${rel}`);
    else marks.add(rel, letterOf(xy));
  }
  return marks;
}
