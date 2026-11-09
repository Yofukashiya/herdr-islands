// Files' tree (mods/file-browser/tree.js): which folders it asks to list, and when, and the rows it
// shows. Run with `node --test` from the repository's root.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FolderTree } from "../mods/file-browser/tree.js";

/** A folder's listing, as listing.js answers it; a trailing slash makes a folder. */
const ls = (...names) => ({ entries: names.map((n) => ({ name: n.replace(/\/$/, ""), dir: n.endsWith("/") })), more: false });

/** The rows in view, indented by depth: "name/" a folder, "name" a file, "(…)" a note under a folder. */
const shown = (tree) => tree.view().rows.map((r) => "  ".repeat(r.depth) + (r.note !== undefined ? `(${r.note})` : r.name + (r.dir ? "/" : "")));

/** Answers what the tree asks for from `disk` (listings by path) until it asks for nothing. */
function settle(tree, disk) {
  for (let batch = tree.next(); batch; batch = tree.next()) tree.apply(batch, [...batch.must, ...batch.ahead].map((p) => disk[p] ?? { error: "No such folder" }));
}

test("the tree asks for its folder first, then for the folders in it, ahead", () => {
  const tree = new FolderTree();
  const first = tree.next();
  assert.deepEqual(first, { must: [""], ahead: [] });
  tree.apply(first, [ls("docs/", "src/", "a.txt")]);
  const second = tree.next();
  assert.deepEqual(second, { must: [], ahead: ["docs", "src"] });
  tree.apply(second, [ls("guide.md"), ls("index.js")]);
  assert.equal(tree.next(), null);
});

test("a folder listed ahead opens with its rows at once; the folders in it are listed ahead only then", () => {
  const tree = new FolderTree();
  settle(tree, { "": ls("src/", "a.txt"), src: ls("lib/", "index.js") });
  // Listed ahead: src. Not yet: src/lib, a folder in a closed folder.
  assert.equal(tree.next(), null);
  tree.toggle("src");
  assert.deepEqual(shown(tree), ["src/", "  lib/", "  index.js", "a.txt"]);
  // In the same batch, src is listed again: its listing ahead may be a few seconds old.
  const batch = tree.next();
  assert.deepEqual(batch, { must: ["src"], ahead: ["src/lib"] });
  tree.apply(batch, [ls("lib/", "index.js", "new.js"), ls("x.js")]);
  assert.deepEqual(shown(tree), ["src/", "  lib/", "  index.js", "  new.js", "a.txt"]);
});

test("a folder opened before its listing comes shows Loading… under it, and it's asked for once", () => {
  const tree = new FolderTree();
  tree.apply(tree.next(), [ls("docs/", "src/", "a.txt")]);
  // Opened before anything listed it: it's asked for at once.
  tree.toggle("docs");
  assert.deepEqual(shown(tree), ["docs/", "  (Loading…)", "src/", "a.txt"]);
  const batch = tree.next();
  assert.deepEqual(batch, { must: ["docs"], ahead: ["src"] });
  // Opened while a batch lists it: that batch fills it.
  tree.toggle("src");
  assert.deepEqual(shown(tree), ["docs/", "  (Loading…)", "src/", "  (Loading…)", "a.txt"]);
  assert.equal(tree.next(), null);
  tree.apply(batch, [ls("guide.md"), ls("index.js")]);
  assert.deepEqual(shown(tree), ["docs/", "  guide.md", "src/", "  index.js", "a.txt"]);
});

test("a folder that can't be listed shows why under it; opening it again tries again", () => {
  const tree = new FolderTree();
  // Listed ahead, it failed: opening it asks again rather than show an old failure.
  settle(tree, { "": ls("locked/", "a.txt") });
  tree.toggle("locked");
  const batch = tree.next();
  assert.deepEqual(batch, { must: ["locked"], ahead: [] });
  tree.apply(batch, [{ error: "Access denied" }]);
  assert.deepEqual(shown(tree), ["locked/", "  (Access denied)", "a.txt"]);
  assert.equal(tree.next(), null);
  tree.toggle("locked");
  tree.toggle("locked");
  assert.deepEqual(tree.next(), { must: ["locked"], ahead: [] });
});

test("a refresh lists the folder, the open folders and the folders they show again, in one batch", () => {
  const tree = new FolderTree();
  const disk = { "": ls("docs/", "src/", "a.txt"), docs: ls("old/"), src: ls("lib/", "index.js"), "src/lib": ls("x.js") };
  settle(tree, disk);
  tree.toggle("src");
  settle(tree, disk);
  const refresh = tree.next(true);
  assert.deepEqual(refresh, { must: ["", "src"], ahead: ["docs", "src/lib"] });
  assert.equal(tree.next(), null);
  // What it brings back shows.
  tree.apply(refresh, [ls("src/", "a.txt", "b.txt"), ls("index.js"), ls("old/"), ls("x.js")]);
  assert.deepEqual(shown(tree), ["src/", "  index.js", "a.txt", "b.txt"]);
});

test("folders left out of a batch (past its budget) wait for the next refresh; opening one asks for it", () => {
  const tree = new FolderTree();
  tree.apply(tree.next(), [ls("a/", "b/", "c/")]);
  const ahead = tree.next();
  assert.deepEqual(ahead, { must: [], ahead: ["a", "b", "c"] });
  tree.apply(ahead, [ls("1"), null, null]);
  assert.equal(tree.next(), null);
  tree.toggle("b");
  assert.deepEqual(shown(tree), ["a/", "b/", "  (Loading…)", "c/"]);
  assert.deepEqual(tree.next(), { must: ["b"], ahead: [] });
  assert.deepEqual(tree.next(true).ahead, ["a", "c"]);
});

test("a batch that fails as a whole: the folders asked for show why, the ones listed ahead wait", () => {
  const tree = new FolderTree();
  assert.equal(tree.view().loading, true);
  tree.apply(tree.next(), [ls("src/", "docs/")]);
  assert.equal(tree.view().loading, false);
  tree.toggle("src");
  const batch = tree.next();
  assert.deepEqual(batch, { must: ["src"], ahead: ["docs"] });
  tree.apply(batch, new Error("The machine is unreachable"));
  assert.deepEqual(shown(tree), ["src/", "  (The machine is unreachable)", "docs/"]);
  assert.equal(tree.next(), null);
  // The folder itself: the panel says why instead of its rows.
  const gone = new FolderTree();
  gone.apply(gone.next(), new Error("No such folder"));
  assert.deepEqual(gone.view(), { rows: [], loading: false, error: "No such folder", limited: false });
});

test("the tree shows 5,000 rows at most, and tells when a folder in view has more than it shows", () => {
  const files = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
  const tree = new FolderTree();
  const big = { entries: [{ name: "x", dir: false }], more: true };
  settle(tree, { "": ls("a/", "big/", ...files("f", 3000)), a: ls(...files("g", 3000)), big });
  // big, listed ahead, has more; it isn't in view.
  assert.equal(tree.view().limited, false);
  tree.toggle("a");
  const { rows, limited } = tree.view();
  assert.equal(rows.length, 5000);
  // a, then its 3,000 files, then big, then the folder's files up to the 5,000th row.
  assert.deepEqual([rows[0].name, rows[1].name, rows[3000].name, rows[3001].name, rows[4999].name], ["a", "g0", "g2999", "big", "f1997"]);
  assert.equal(limited, true);
  tree.toggle("a");
  tree.toggle("big");
  assert.equal(tree.view().limited, true);
});

test("a tree that comes back with folders open lists them with the folder, in its first batch", () => {
  const tree = new FolderTree(["src", "src/lib"]);
  const first = tree.next();
  assert.deepEqual(first, { must: ["", "src", "src/lib"], ahead: [] });
  tree.apply(first, [ls("docs/", "src/"), ls("lib/"), ls("x.js")]);
  assert.deepEqual(shown(tree), ["docs/", "src/", "  lib/", "    x.js"]);
  assert.deepEqual(tree.next(), { must: [], ahead: ["docs"] });
});

test("closing a folder forgets what was listed inside it, so listings don't pile up", () => {
  const tree = new FolderTree();
  const disk = { "": ls("src/"), src: ls("lib/"), "src/lib": ls("deep/"), "src/lib/deep": ls("x") };
  settle(tree, disk);
  tree.toggle("src");
  settle(tree, disk);
  tree.toggle("src/lib");
  settle(tree, disk);
  // Closing src closes src/lib too.
  tree.toggle("src");
  tree.toggle("src");
  assert.deepEqual(shown(tree), ["src/", "  lib/"]);
  const batch = tree.next();
  assert.deepEqual(batch, { must: ["src"], ahead: ["src/lib"] });
  // What comes back for a folder closed meanwhile isn't kept either.
  tree.toggle("src");
  tree.apply(batch, [ls("lib/"), ls("deep/")]);
  tree.toggle("src");
  assert.deepEqual(tree.next(), { must: ["src"], ahead: ["src/lib"] });
});

test("a folder a refresh leaves out forgets its listing, so opening it never shows an old one", () => {
  const tree = new FolderTree();
  settle(tree, { "": ls("a/", "b/"), a: ls("1"), b: ls("deleted.txt") });
  const refresh = tree.next(true);
  assert.deepEqual(refresh, { must: [""], ahead: ["a", "b"] });
  tree.apply(refresh, [ls("a/", "b/"), ls("1"), null]);
  tree.toggle("b");
  assert.deepEqual(shown(tree), ["a/", "b/", "  (Loading…)"]);
  assert.deepEqual(tree.next(), { must: ["b"], ahead: [] });
});

test("a folder asked for that a batch doesn't answer shows an error, not asked for again and again", () => {
  const tree = new FolderTree();
  tree.apply(tree.next(), [ls("src/")]);
  tree.toggle("src");
  tree.apply(tree.next(), [null]);
  assert.deepEqual(shown(tree), ["src/", "  (Cannot list this folder)"]);
  assert.equal(tree.next(), null);
});

test("a batch that comes back after a newer one for the same folders doesn't undo it", () => {
  const tree = new FolderTree();
  settle(tree, { "": ls("src/"), src: ls("a.js") });
  tree.toggle("src");
  const older = tree.next();
  const newer = tree.next(true);
  assert.deepEqual([older.must, newer.must], [["src"], ["", "src"]]);
  tree.apply(newer, [ls("src/"), ls("a.js", "b.js")]);
  tree.apply(older, [ls("a.js")]);
  assert.deepEqual(shown(tree), ["src/", "  a.js", "  b.js"]);
  // The other way round: the older one coming back first leaves src to the newer one.
  const first = tree.next(true), second = tree.next(true);
  tree.apply(first, [ls("src/"), ls("c.js")]);
  assert.equal(tree.next(), null);
  tree.apply(second, [ls("src/"), ls("d.js")]);
  assert.deepEqual(shown(tree), ["src/", "  d.js"]);
});
