// The cells of one sheet, packed. Herdr runs every mod in one heap of about 256 MiB, and a cell
// kept as an object in a Map costs ~250 bytes there: a sheet of a million cells would not fit.
// Here a plain cell (a number, a string, a boolean, or only a style) is a few numbers in typed
// arrays, ~15-30 bytes. Any other cell (a formula, an error) is kept as the object it was given.
//
// Cells are added row by row, left to right, the order a sheet's XML lists them in. A cell that
// comes out of that order is still kept (as an object, aside), so a file that breaks the order
// only costs more memory.
//
// get(k) hands out an object for any cell. A packed cell's object is made when asked for and is a
// view: the viewer may keep its own notes on it (how it's formatted), but its value lives here.

export const COLS = 16384;
/** A cell's key, as the sheet's maps use it: row * 16384 + column, both 0-based. */
export const key = (r, c) => r * COLS + c;

// A slot's kind (meta & 7), whether its text is its value (meta & TEXT), and its style (meta >> 4).
const EMPTY = 0, NUM = 1, BOOL = 2, SHARED = 3, STR = 4, OBJ = 5;
const TEXT = 8;
// Packed cells' objects kept, so a cell on screen keeps what the viewer noted on it (its formatted
// text) between frames: a 2560 px wide sheet at 50% shows ~11,000 cells.
const VIEWS = 16384;

/** A shared string's text: the workbook keeps a plain one as a string, a rich one as { text, runs }. */
export const sharedText = (x) => (x === undefined || x === null ? "" : typeof x === "string" ? x : x.text);

export class Cells {
  /** `strings`: the workbook's shared strings, for cells added with addShared. */
  constructor(strings = []) {
    this.strings = strings;
    this.cols = new Uint16Array(256);
    this.nums = new Float64Array(256); // the number, or an index into strings, strs or objs
    this.meta = new Int32Array(256);
    this.rowStart = new Int32Array(256); // row r's cells are the slots rowStart[r] .. rowStart[r + 1] - 1
    this.n = 0;
    this.lastRow = -1;
    this.lastCol = -1;
    this.strs = [];
    this.objs = [];
    this.aside = null; // key -> object, for cells added out of order
    this.shadowed = 0; // packed cells that a later one aside replaced
    this.views = new Map();
  }

  get size() { return this.n - this.shadowed + (this.aside?.size ?? 0); }

  /** A cell whose value is null, a number, a boolean or a string. `asText`: it shows String(v). */
  add(r, c, s, v, asText = false) {
    const t = typeof v;
    if (v !== null && t !== "number" && t !== "boolean" && t !== "string") return this.addCell({ r, c, s, v });
    if (!this.inOrder(r, c)) return this.addCell(asText ? { r, c, s, v, text: String(v) } : { r, c, s, v });
    const i = this.slot(r, c);
    const flag = asText ? TEXT : 0;
    if (v === null) this.meta[i] = s * 16 | EMPTY;
    else if (t === "number") { this.nums[i] = v; this.meta[i] = s * 16 | flag | NUM; }
    else if (t === "boolean") { this.nums[i] = v ? 1 : 0; this.meta[i] = s * 16 | flag | BOOL; }
    else { this.nums[i] = this.strs.length; this.strs.push(v); this.meta[i] = s * 16 | flag | STR; }
  }

  /** A cell showing shared string `si`. */
  addShared(r, c, s, si) {
    if (!this.inOrder(r, c)) {
      const x = this.strings[si];
      return this.addCell(x?.runs ? { r, c, s, v: x.text, rich: x.runs } : { r, c, s, v: sharedText(x) });
    }
    const i = this.slot(r, c);
    this.nums[i] = si;
    this.meta[i] = s * 16 | SHARED;
  }

  /** A cell kept as its object ({ r, c, s, v, f, ... }): formulas, errors, anything unusual. */
  addCell(cell) {
    if (!this.inOrder(cell.r, cell.c)) {
      // Aside, it hides a packed cell written before it at the same place (a file that wrote it twice).
      const k = key(cell.r, cell.c);
      this.aside ??= new Map();
      if (!this.aside.has(k) && this.find(k) >= 0) this.shadowed++;
      this.aside.set(k, cell);
      return;
    }
    const i = this.slot(cell.r, cell.c);
    this.nums[i] = this.objs.length;
    this.objs.push(cell);
    this.meta[i] = OBJ;
  }

  has(k) { return this.aside?.has(k) || this.find(k) >= 0; }

  /** The cell's value; null when it is empty or absent. */
  value(k) {
    const a = this.aside?.get(k);
    if (a) return a.v;
    const i = this.find(k);
    if (i < 0) return null;
    const m = this.meta[i], n = this.nums[i];
    switch (m & 7) {
      case NUM: return n;
      case BOOL: return n !== 0;
      case SHARED: return sharedText(this.strings[n]);
      case STR: return this.strs[n];
      case OBJ: return this.objs[n].v;
      default: return null;
    }
  }

  /** The cell's style index; 0 when it is absent. */
  style(k) {
    const a = this.aside?.get(k);
    if (a) return a.s ?? 0;
    const i = this.find(k);
    if (i < 0) return 0;
    return (this.meta[i] & 7) === OBJ ? this.objs[this.nums[i]].s ?? 0 : this.meta[i] >> 4;
  }

  /** The cell's object when it is kept as one (a formula, say), else undefined. */
  object(k) {
    const a = this.aside?.get(k);
    if (a) return a;
    const i = this.find(k);
    return i >= 0 && (this.meta[i] & 7) === OBJ ? this.objs[this.nums[i]] : undefined;
  }

  /** The cell as an object ({ r, c, s, v, rich?, text?, f?, ... }), or undefined when absent. */
  get(k) {
    const a = this.aside?.get(k);
    if (a) return a;
    const i = this.find(k);
    if (i < 0) return undefined;
    if ((this.meta[i] & 7) === OBJ) return this.objs[this.nums[i]];
    let cell = this.views.get(k);
    if (cell) return cell;
    const r = Math.floor(k / COLS);
    cell = this.view(i, r, k - r * COLS);
    if (this.views.size >= VIEWS) this.views.clear();
    this.views.set(k, cell);
    return cell;
  }

  /** Every cell kept as an object, in the order they were added. */
  *objects() {
    yield* this.objs;
    if (this.aside) yield* this.aside.values();
  }

  /** Every cell as an object, row by row (packed ones as fresh views). */
  *values() {
    let r = 0;
    for (let i = 0; i < this.n; i++) {
      while (this.rowStart[r + 1] <= i) r++;
      if (this.shadowed && this.aside.has(key(r, this.cols[i]))) continue;
      yield (this.meta[i] & 7) === OBJ ? this.objs[this.nums[i]] : this.view(i, r, this.cols[i]);
    }
    if (this.aside) yield* this.aside.values();
  }

  /** Drops every cell: a closed tab gives its memory back at once. */
  clear() {
    this.cols = new Uint16Array(0); this.nums = new Float64Array(0); this.meta = new Int32Array(0);
    this.rowStart = new Int32Array(0);
    this.n = 0; this.lastRow = -1; this.lastCol = -1;
    this.strs = []; this.objs = []; this.aside = null; this.shadowed = 0; this.views.clear();
  }

  // ---- inside ----

  view(i, r, c) {
    const m = this.meta[i], n = this.nums[i], s = m >> 4;
    switch (m & 7) {
      case NUM: return m & TEXT ? { r, c, s, v: n, text: String(n) } : { r, c, s, v: n };
      case BOOL: return m & TEXT ? { r, c, s, v: n !== 0, text: String(n !== 0) } : { r, c, s, v: n !== 0 };
      case SHARED: { const x = this.strings[n]; return x?.runs ? { r, c, s, v: x.text, rich: x.runs } : { r, c, s, v: sharedText(x) }; }
      case STR: return m & TEXT ? { r, c, s, v: this.strs[n], text: this.strs[n] } : { r, c, s, v: this.strs[n] };
      default: return { r, c, s, v: null };
    }
  }

  inOrder(r, c) { return r > this.lastRow || (r === this.lastRow && c > this.lastCol); }

  /** A new slot at the end for cell (r, c), which comes after every cell so far. */
  slot(r, c) {
    if (this.n === this.cols.length) this.grow();
    if (r + 2 > this.rowStart.length) {
      let size = Math.max(256, this.rowStart.length * 2);
      while (size < r + 2) size *= 2;
      const rows = new Int32Array(size);
      rows.set(this.rowStart);
      this.rowStart = rows;
    }
    // Rows skipped since the last cell are empty: they start and end where the next one starts.
    for (let q = this.lastRow + 1; q <= r; q++) this.rowStart[q] = this.n;
    const i = this.n++;
    this.cols[i] = c;
    this.rowStart[r + 1] = this.n;
    this.lastRow = r;
    this.lastCol = c;
    return i;
  }

  grow() {
    const size = Math.max(256, this.cols.length * 2); // a cleared store starts over
    const cols = new Uint16Array(size), nums = new Float64Array(size), meta = new Int32Array(size);
    cols.set(this.cols); nums.set(this.nums); meta.set(this.meta);
    this.cols = cols; this.nums = nums; this.meta = meta;
  }

  /** The slot of the cell with key k, or -1. */
  find(k) {
    const r = Math.floor(k / COLS);
    if (r < 0 || r > this.lastRow) return -1;
    const c = k - r * COLS, cols = this.cols;
    let a = this.rowStart[r], b = this.rowStart[r + 1];
    // A long row is halved down to a few cells, then scanned: its columns go left to right.
    while (b - a > 8) {
      const mid = (a + b) >> 1;
      if (cols[mid] <= c) a = mid; else b = mid;
    }
    for (; a < b; a++) if (cols[a] === c) return a;
    return -1;
  }
}
