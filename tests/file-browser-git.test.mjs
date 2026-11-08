// Files' git marks: what each row of the tree shows for `git status` (mods/file-browser/git.js).
// Run with `node --test tests/`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readStatus } from "../mods/file-browser/git.js";

/** `git status --porcelain=v1 -z` output for these entries. */
const z = (...entries) => entries.map((e) => e + "\0").join("");

test("an untracked file shows U, VS Code's letter for it", async () => {
  const marks = await readStatus(z("?? notes.txt"), "/repo");
  assert.deepEqual(marks.row("/repo/notes.txt"), { letter: "U", tone: "U", dot: false });
});

test("a staged new file shows A, apart from an untracked one", async () => {
  const marks = await readStatus(z("A  added.js", "?? loose.js"), "/repo");
  assert.equal(marks.row("/repo/added.js").letter, "A");
  assert.equal(marks.row("/repo/loose.js").letter, "U");
});

test("a file new to the repository stays A after edits, as in the Changes panel (a diff against HEAD)", async () => {
  const marks = await readStatus(z("AM added.js", " A intent.js", "MM edited.js"), "/repo");
  assert.deepEqual(["added", "intent", "edited"].map((n) => marks.row(`/repo/${n}.js`).letter), ["A", "A", "M"]);
});

test("every kind of merge conflict shows !, not U", async () => {
  const kinds = ["UU", "AA", "DD", "AU", "UA", "DU", "UD"];
  const marks = await readStatus(z(...kinds.map((xy) => `${xy} ${xy}.txt`)), "/repo");
  assert.deepEqual(kinds.map((xy) => marks.row(`/repo/${xy}.txt`).letter), ["!", "!", "!", "!", "!", "!", "!"]);
});

test("a deleted file shows D, whether deleted on disk, staged, or edited then deleted", async () => {
  const marks = await readStatus(z(" D gone.txt", "D  staged.txt", "MD edited.txt"), "/repo");
  assert.deepEqual(["gone", "staged", "edited"].map((n) => marks.row(`/repo/${n}.txt`).letter), ["D", "D", "D"]);
});

test("every folder above a change gets its color and a dot, but no letter", async () => {
  const marks = await readStatus(z("?? docs/guide/new.md"), "/repo");
  assert.deepEqual(marks.row("/repo/docs"), { letter: null, tone: "U", dot: true });
  assert.deepEqual(marks.row("/repo/docs/guide"), { letter: null, tone: "U", dot: true });
  assert.deepEqual(marks.row("/repo/src"), { letter: null, tone: null, dot: false });
});

test("a folder takes the most urgent change inside: conflict, deleted, modified, added, untracked", async () => {
  const marks = await readStatus(z(
    " M a/one", "UU a/two", "?? a/three",
    "?? b/one", " D b/two", " M b/three",
    "?? c/one", " M c/two", "A  c/three",
    "?? d/one", "A  d/two", "?? d/three",
  ), "/repo");
  assert.deepEqual(["a", "b", "c", "d"].map((f) => marks.row(`/repo/${f}`).tone), ["!", "D", "M", "A"]);
});

test("ignored files and folders are dimmed, and so is everything in an ignored folder", async () => {
  // --ignored=matching lists an ignored folder once, with a slash, and not the files in it.
  const marks = await readStatus(z("!! .env.local", "!! src/cache/"), "/repo");
  const dimmed = { letter: null, tone: "I", dot: false };
  assert.deepEqual(marks.row("/repo/.env.local"), dimmed);
  assert.deepEqual(marks.row("/repo/src/cache"), dimmed);
  assert.deepEqual(marks.row("/repo/src/cache/deep/page.html"), dimmed);
});

test("ignored files don't mark the folders above them", async () => {
  const marks = await readStatus(z("!! src/cache/", "!! src/debug.log"), "/repo");
  assert.deepEqual(marks.row("/repo/src"), { letter: null, tone: null, dot: false });
  assert.deepEqual(marks.row("/repo/src-old/page.html"), { letter: null, tone: null, dot: false });
});

test("a folder git reports whole (a changed submodule, a repository inside) shows its own letter", async () => {
  const marks = await readStatus(z(" M modules/core", "?? vendor/lib/"), "/repo");
  assert.deepEqual(marks.row("/repo/modules/core"), { letter: "M", tone: "M", dot: false });
  assert.deepEqual(marks.row("/repo/vendor/lib"), { letter: "U", tone: "U", dot: false });
  assert.equal(marks.row("/repo/vendor").dot, true);
});

test("past the limit, entries are left unmarked", async () => {
  const marks = await readStatus(z(" M one.txt", " M two.txt", " M three.txt"), "/repo", { limit: 2 });
  assert.deepEqual(["one", "two", "three"].map((n) => marks.row(`/repo/${n}.txt`).letter), ["M", "M", null]);
});

test("a Windows pane's spelling of a path finds git's mark", async () => {
  const marks = await readStatus(z(" M docs/readme.md", "!! out/"), "C:/repo");
  assert.equal(marks.row("c:\\repo\\docs\\readme.md").letter, "M");
  assert.equal(marks.row("C:\\repo\\docs").dot, true);
  assert.equal(marks.row("c:\\repo\\out\\app.exe").tone, "I");
});

test("on macOS and Linux a backslash is part of a name, not a separator", async () => {
  const marks = await readStatus(z("?? a\\b.txt"), "/repo");
  assert.equal(marks.row("/repo/a\\b.txt").letter, "U");
  assert.equal(marks.row("/repo/a").dot, false);
});
