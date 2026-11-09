// The tree's folders: which are open, which are listed, and what to list next. A folder is listed
// before it's opened (ahead): when a listing arrives, the folders it shows are listed next, in one
// batch, so a click on one draws its rows at once. Pure: listing.js does the listing, and this is
// tested with Node (tests/file-browser-tree.test.mjs).

/** Rows the tree shows at most. */
export const TOTAL = 5000;

/** The path of `name` in the folder at `path` ("" is the tree's own folder). */
const join = (path, name) => path ? `${path}/${name}` : name;

export class FolderTree {
  /** `open`: the folders open when the tree last showed this folder. */
  constructor(open = []) {
    this.open = new Set(open);
    // By path ("" is the folder itself): its listing as listFolders answers it, and the number of
    // the batch it came in, so a batch that comes back late doesn't undo a newer one.
    this.listings = new Map();
    this.listedIn = new Map();
    // Folders asked for, by the number of the latest batch asking.
    this.pending = new Map();
    this.batches = new Map();
    this.count = 0;
    // Folders a batch left out (past its budget): not listed ahead again until a refresh.
    this.skipped = new Set();
    // Folders opened from a listing made ahead, to list again: it may be a few seconds old.
    this.relist = new Set();
  }

  /** The folder and the open folders in view, top to bottom. */
  *shownFolders(path = "") {
    yield path;
    for (const entry of this.listings.get(path)?.entries ?? []) {
      const sub = join(path, entry.name);
      if (entry.dir && this.open.has(sub)) yield* this.shownFolders(sub);
    }
  }

  /**
   * The next batch to list, or null. `must`: the folder and the open folders not listed yet (and
   * those just opened from a listing made ahead). `ahead`: the folders they show. They're pending
   * until apply(). `all`: a refresh, every one of them again.
   */
  next(all = false) {
    if (all) this.skipped.clear();
    const unlisted = (path) => !this.listings.has(path) && !this.pending.has(path);
    // Every open folder, not only those in view yet: a tree that comes back lists them at once.
    const must = ["", ...this.open].filter((path) => all || unlisted(path) || this.relist.has(path) && !this.pending.has(path));
    const ahead = [];
    for (const path of this.shownFolders()) {
      for (const entry of this.listings.get(path)?.entries ?? []) {
        const sub = join(path, entry.name);
        if (entry.dir && !this.open.has(sub) && (all || !this.skipped.has(sub) && unlisted(sub))) ahead.push(sub);
      }
    }
    for (const path of must) this.relist.delete(path);
    if (!must.length && !ahead.length) return null;
    const batch = { must, ahead }, number = ++this.count;
    this.batches.set(batch, number);
    for (const path of [...must, ...ahead]) this.pending.set(path, number);
    return batch;
  }

  /** Takes a batch's listings, one per path of next()'s `must` and `ahead` (null: left out), or
   *  the error the whole batch failed with. */
  apply(batch, listings) {
    const { must, ahead } = batch, number = this.batches.get(batch);
    this.batches.delete(batch);
    if (listings instanceof Error) {
      const error = { error: listings.message };
      listings = [...must.map(() => error), ...ahead.map(() => null)];
    }
    [...must, ...ahead].forEach((path, i) => {
      if (this.pending.get(path) === number) this.pending.delete(path);
      if ((this.listedIn.get(path) ?? 0) > number) return;
      this.listedIn.set(path, number);
      if (listings[i]) this.listings.set(path, listings[i]);
      // A folder asked for always gets an answer, or it would be asked for again and again.
      else if (i < must.length) this.listings.set(path, { error: "Cannot list this folder" });
      else {
        // Left out, its old listing would show when it opens.
        this.listings.delete(path);
        this.skipped.add(path);
      }
    });
    this.forget();
  }

  /** Drops the listings of folders neither open nor shown by an open folder (a closed one's). */
  forget() {
    const kept = (path) => !path || this.open.has(path) || !path.includes("/") || this.open.has(path.slice(0, path.lastIndexOf("/")));
    for (const path of this.listings.keys()) if (!kept(path)) this.listings.delete(path);
    for (const path of this.listedIn.keys()) if (!kept(path)) this.listedIn.delete(path);
    for (const path of this.skipped) if (!kept(path)) this.skipped.delete(path);
  }

  /** Opens a folder, or closes it and every folder in it. One that failed is asked for again. */
  toggle(path) {
    if (!this.open.has(path)) {
      this.open.add(path);
      if (this.listings.get(path)?.error) this.listings.delete(path);
      else if (this.listings.has(path) && !this.pending.has(path)) this.relist.add(path);
      return;
    }
    for (const folder of [...this.open]) if (folder === path || folder.startsWith(path + "/")) {
      this.open.delete(folder);
      this.relist.delete(folder);
    }
    this.forget();
  }

  /**
   * What the tree shows. `rows`: { path, name, dir, depth, open } an entry; under an open folder
   * with no entries to show, { path, depth, note }: "Loading…" or why it couldn't be listed.
   * `loading`: the folder itself isn't listed yet; `error`: why it couldn't be. `limited`: a
   * folder in view has more entries than it shows, or the rows stop at TOTAL.
   */
  view() {
    const root = this.listings.get("");
    const rows = [];
    let limited = false;
    const walk = (path, depth) => {
      const listing = this.listings.get(path);
      if (listing?.more) limited = true;
      for (const entry of listing?.entries ?? []) {
        if (rows.length >= TOTAL) { limited = true; return; }
        const sub = join(path, entry.name), open = entry.dir && this.open.has(sub);
        rows.push({ path: sub, name: entry.name, dir: entry.dir, depth, open });
        if (!open) continue;
        const inside = this.listings.get(sub);
        if (inside?.entries) walk(sub, depth + 1);
        else if (rows.length < TOTAL) rows.push({ path: sub, depth: depth + 1, note: inside?.error ?? "Loading…" });
      }
    };
    walk("", 0);
    return { rows, loading: !root, error: root?.error ?? null, limited };
  }
}
