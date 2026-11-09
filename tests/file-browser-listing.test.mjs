// Files' folder listings (mods/file-browser/listing.js), run through the real shells: powershell on
// Windows, sh wherever it is (Git Bash on Windows). Run with `node --test` from the repository's root.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { listFolders } from "../mods/file-browser/listing.js";

/** Herdr's exec, as the mod sees it: it rejects when the program can't start. */
const exec = (command, args, { cwd } = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd });
  const out = [], err = [];
  child.stdout.on("data", (d) => out.push(d));
  child.stderr.on("data", (d) => err.push(d));
  child.on("error", () => reject(new Error(`cannot start ${command}: program not found`)));
  child.on("close", (code) => resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }));
});

const has = (command) => !spawnSync(command, ["-c", "exit 0"]).error;
/** Each shell the mod can list with here: powershell is Windows's, sh is macOS's and Linux's. */
const shells = [
  { name: "powershell", windows: true, skip: process.platform !== "win32" && "powershell is Windows's" },
  { name: "sh", windows: false, skip: !has("sh") && "no sh here" },
];

/** A folder with these files (a trailing slash makes a folder). */
function folder(...paths) {
  const root = mkdtempSync(join(tmpdir(), "files-listing-"));
  for (const p of paths) {
    mkdirSync(dirname(join(root, p, p.endsWith("/") ? "x" : "")), { recursive: true });
    if (!p.endsWith("/")) writeFileSync(join(root, p), "");
  }
  return root;
}

for (const shell of shells) {
  test(`${shell.name}: a folder lists folders first, then files, by name, with hidden ones and without .git`, { skip: shell.skip }, async () => {
    // Folders Cyrillic, files Latin: whether Cyrillic sorts before Latin depends on the locale.
    const root = folder(".git/", "праздник 🎉/", "Документы/", "b.txt", ".env", "A.txt");
    const [listing] = await listFolders(exec, { root, windows: shell.windows }, { must: [""] });
    assert.deepEqual(listing, {
      entries: [
        { name: "Документы", dir: true }, { name: "праздник 🎉", dir: true },
        { name: ".env", dir: false }, { name: "A.txt", dir: false }, { name: "b.txt", dir: false },
      ],
      more: false,
    });
  });

  test(`${shell.name}: one process lists several folders; one that's gone gets its error, the rest still list`, { skip: shell.skip }, async () => {
    const root = folder("src/lib/", "src/lib/util.js", "it's ‘quoted’/", "it's ‘quoted’/note.md", "$HOME %PATH%/", "$HOME %PATH%/x");
    const listings = await listFolders(exec, { root, windows: shell.windows }, { must: ["src/lib", "gone", "it's ‘quoted’", "$HOME %PATH%", "src/lib/util.js"] });
    assert.deepEqual(listings[0], { entries: [{ name: "util.js", dir: false }], more: false });
    assert.match(listings[1].error, /\S$/);
    assert.deepEqual(listings[2], { entries: [{ name: "note.md", dir: false }], more: false });
    assert.deepEqual(listings[3], { entries: [{ name: "x", dir: false }], more: false });
    // A file isn't a folder; the message is shown as it is, so with no line break after it.
    assert.match(listings[4].error, /\S$/);
  });

  test(`${shell.name}: a link to a folder is a folder; a dangling one is not`, { skip: shell.skip }, async () => {
    const root = folder("real/", "target/");
    // A junction on Windows (no admin rights needed), a symlink elsewhere.
    symlinkSync(join(root, "real"), join(root, "linked"), "junction");
    symlinkSync(join(root, "target"), join(root, "dangling"), "junction");
    rmSync(join(root, "target"), { recursive: true });
    const [listing] = await listFolders(exec, { root, windows: shell.windows }, { must: [""] });
    assert.deepEqual(listing.entries, [{ name: "linked", dir: true }, { name: "real", dir: true }, { name: "dangling", dir: false }]);
  });

  test(`${shell.name}: a folder shows its first 500 entries and tells there are more`, { skip: shell.skip }, async () => {
    const root = folder(...Array.from({ length: 600 }, (_, i) => `f${i}`));
    const [listing] = await listFolders(exec, { root, windows: shell.windows }, { must: [""] });
    assert.equal(listing.entries.length, 500);
    assert.equal(listing.more, true);
  });

  test(`${shell.name}: folders listed ahead that don't fit in one command line are left for later`, { skip: shell.skip }, async () => {
    // Windows refuses a command line over 32,767 characters.
    const many = Array.from({ length: 2000 }, (_, i) => `a-rather-long-folder-name-${i}`);
    const root = folder("a/1", ...many.map((m) => m + "/"));
    const listings = await listFolders(exec, { root, windows: shell.windows }, { must: ["a"], ahead: many });
    assert.deepEqual(listings[0], { entries: [{ name: "1", dir: false }], more: false });
    assert.deepEqual(listings[1], { entries: [], more: false });
    assert.equal(listings.at(-1), null);
  });

  test(`${shell.name}: folders listed ahead stop at the budget; the ones asked for always list`, { skip: shell.skip }, async () => {
    const root = folder("a/1", "a/2", "b/1", "b/2", "c/1", "d/1");
    const listings = await listFolders(exec, { root, windows: shell.windows }, { must: ["a", "b"], ahead: ["c", "d"] }, { budget: 3 });
    assert.deepEqual(listings.map((l) => l && l.entries.length), [2, 2, null, null]);
    const roomy = await listFolders(exec, { root, windows: shell.windows }, { must: ["a"], ahead: ["b", "c", "d"] }, { budget: 3 });
    assert.deepEqual(roomy.map((l) => l && l.entries.length), [2, 2, null, null]);
  });
}

test("a Windows machine reached through herdr-core, with no sh, is listed with powershell", { skip: shells[0].skip }, async () => {
  const root = folder("src/");
  const noSh = (command, ...rest) => command === "sh" ? Promise.reject(new Error("cannot start sh: program not found")) : exec(command, ...rest);
  const [listing] = await listFolders(noSh, { root, on: "office-pc" }, { must: [""] });
  assert.deepEqual(listing, { entries: [{ name: "src", dir: true }], more: false });
});
