// sheet-viewer: a read-only spreadsheet viewer for .xlsx/.xlsm/.csv/.tsv, drawn like Excel:
// fonts, fills, borders, number formats, merged cells, column widths and row heights, frozen
// panes, conditional formatting, Excel tables, pictures, charts and shapes, sheet tabs.
// Opens as a tab or pane: props { file: absolute path, on?: machine }.
import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { props, theme, exec, home, appHome, window as hwin, settings } from "herdr";
import * as fs from "fs/promises";
import { openXlsx, zipSource, slicer, key, cellName, colName, colWidth, rowHeight, colX, rowY, BORDER_PX, parseRange } from "./xlsx.js";
import { readCsvText, cp1251Async } from "./csv.js";
import { formatValue, builtinFormat } from "./numfmt.js";
import { drawChart } from "./draw.js";

const MOD = "sheet-viewer";
const PT = 96 / 72;
const HEAD_H = 20;         // column header strip (Excel's)
const GRID = "#d4d4d4";    // Excel's gridline color
const SEL = "#217346";     // Excel's selection green
const HEAD_BG = "#f3f2f1", HEAD_FG = "#444444", HEAD_LINE = "#d4d4d4";
const EXTRA_ROWS = 40, EXTRA_COLS = 8; // empty sheet past the data, like Excel's endless grid

const ext = (p) => (/\.([^.\\/]+)$/.exec(p)?.[1] ?? "").toLowerCase();
const base = (p) => p.split(/[\\/]/).pop();
const isErr = (v) => v && typeof v === "object" && "error" in v;

/** Estimated width of text in px at font size `size` (no font metrics in mods): Calibri-like. */
function textWidth(text, size, bold) {
  let em = 0;
  for (const ch of String(text)) {
    if (ch >= "0" && ch <= "9") em += 0.507;
    else if (" \u00a0\u202f,.:;'!|il".includes(ch)) em += 0.25;
    else if (ch >= "A" && ch <= "Z" || ch >= "А" && ch <= "Я") em += 0.6;
    else em += 0.5;
  }
  return em * size * (bold ? 1.06 : 1);
}

/**
 * A General-format number shrunk to its column, as Excel does instead of "####": fewer decimals
 * (rounded), then E notation. null when nothing fits. `sep` is the locale's decimal separator.
 */
function fitGeneral(v, fits, sep) {
  if (!Number.isFinite(v)) return null;
  for (let d = 9; d >= 0; d--) {
    const s = String(Number(v.toFixed(d)));
    if (s.includes("e")) break;
    const t = s.replace(".", sep);
    if (fits(t)) return t;
  }
  for (let d = 5; d >= 0; d--) {
    const t = v.toExponential(d).replace(".", sep).replace(/e([+-])(\d)$/, "e$10$2").toUpperCase();
    if (fits(t)) return t;
  }
  return null;
}

// ---- reading the file ------------------------------------------------------------

function platform() {
  return hwin()?.platform ?? (/^[A-Za-z]:/.test(home()) ? "windows" : home().startsWith("/Users") ? "macos" : "linux");
}

const CACHE = `mods/${MOD}/.cache`;
// Inside a PowerShell single-quoted string. PowerShell reads the curly single quotes (‘ ’ ‚ ‛) as
// quotes too, so a file named "a’; cmd; ’.xlsx" would run cmd: every one of them is doubled.
const q = (x) => x.replace(/['‘’‚‛]/g, "$&$&");

async function bytesFromBase64(text, tick) {
  const bin = atob(text.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
    if ((i & 65535) === 65535) await tick(true);
  }
  return out;
}

/** Copies a local file into the cache (for files outside the mods' read root). */
async function copyLocal(file, dest) {
  const r = platform() === "windows"
    ? await exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", `Copy-Item -LiteralPath '${q(file)}' -Destination '${q(dest)}'`])
    : await exec("cp", [file, dest]);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || "cannot read the file").trim().split(/\r?\n/)[0]);
}

/** Unzips with the OS (fast, native); false when it can't. */
async function unzipNative(file, dir) {
  try {
    const r = platform() === "windows"
      ? await exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory('${q(file)}', '${q(dir)}')`])
      : await exec("unzip", ["-qq", "-o", file, "-d", dir]);
    return r.code === 0 && (await fs.exists(`${dir}/[Content_Types].xml`));
  } catch {
    return false;
  }
}

function dirSource(dir, rel) {
  return {
    dir, rel,
    text: (part) => fs.readFile(`${dir}/${part}`, "utf8").catch(() => null),
    exists: (part) => fs.exists(`${dir}/${part}`),
  };
}

/** Removes cache entries older than 12 hours (best effort). */
async function sweepCache() {
  try {
    const now = Date.now();
    for (const name of await fs.readdir(`${appHome()}/${CACHE}`)) {
      const born = parseInt((/^[xrcm]-([0-9a-z]+)-/.exec(name) ?? [])[1] ?? "", 36);
      if (born && now - born > 12 * 3600e3) removeCache(`${appHome()}/${CACHE}/${name}`);
    }
  } catch {}
}
function removeCache(abs) {
  const r = platform() === "windows"
    ? exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", `Remove-Item -LiteralPath '${q(abs)}' -Recurse -Force -ErrorAction SilentlyContinue`])
    : exec("rm", ["-rf", abs]);
  r.catch(() => {});
}

/**
 * The file as something the readers can use, without ever holding a whole workbook in JS:
 * an xlsx is unzipped by the OS into the cache and its parts read natively; a CSV is read as
 * text natively (UTF-8), else as bytes (Windows-1251, UTF-16). Another machine's file is
 * copied here first.
 */
async function prepare(file, on, id, tick) {
  const e = ext(file);
  const cache = `${appHome()}/${CACHE}`;
  try { await fs.mkdir(cache, { recursive: true }); } catch {}
  let local = file;
  if (on) {
    const r = await exec("sh", ["-c", 'base64 < "$1"', "sh", file], { on });
    if (r.code !== 0) throw new Error((r.stderr || r.stdout || "cannot read the file").trim().split(/\r?\n/)[0]);
    local = `${cache}/r-${id}.${e}`;
    await fs.writeFile(local, await bytesFromBase64(r.stdout, tick));
  }
  if (e === "xlsx" || e === "xlsm") {
    const dir = `${cache}/x-${id}`;
    if (await unzipNative(local, dir)) return { kind: "xlsx", src: dirSource(dir, `${CACHE}/x-${id}`), cleanup: [dir, local !== file ? local : null] };
    // No unzip tool: decompress in JS, one part at a time.
    let bytes, copy = null;
    try { bytes = await fs.readFile(local); } catch { copy = `${cache}/c-${id}.${e}`; await copyLocal(local, copy); bytes = await fs.readFile(copy); }
    return { kind: "xlsx", src: zipSource(bytes), cleanup: [copy, local !== file ? local : null] };
  }
  // CSV / TSV / TXT.
  let path = local, copied = null;
  try { await fs.readFile(path, "utf8"); } catch { copied = `${cache}/c-${id}.${e}`; await copyLocal(local, copied); path = copied; }
  let text = null, encoding = "UTF-8";
  try { text = await fs.readFile(path, "utf8"); } catch {}
  if (text !== null && text.charCodeAt(0) === 0xfeff) encoding = "UTF-8 BOM";
  if (text === null || text.includes("\ufffd")) {
    const bytes = await fs.readFile(path);
    if (bytes[0] === 0xff && bytes[1] === 0xfe || bytes[0] === 0xfe && bytes[1] === 0xff) {
      const le = bytes[0] === 0xff;
      const parts = [];
      let out = "";
      for (let i = 2; i + 1 < bytes.length; i += 2) {
        out += String.fromCharCode(le ? bytes[i] | (bytes[i + 1] << 8) : (bytes[i] << 8) | bytes[i + 1]);
        if ((i & 16383) === 0) { parts.push(out); out = ""; await tick(true); }
      }
      parts.push(out);
      text = parts.join("");
      encoding = le ? "UTF-16 LE" : "UTF-16 BE";
    } else {
      text = await cp1251Async(bytes, tick);
      encoding = "Windows-1251";
    }
  }
  return { kind: "csv", text, encoding, cleanup: [copied, local !== file ? local : null] };
}

/** The OS locale (number and date display), asked once and remembered. */
async function systemLocale() {
  try { const l = localStorage.getItem("locale"); if (l) return l; } catch {}
  let loc = "en-US";
  try {
    const p = platform();
    const r = p === "windows" ? await exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", "(Get-Culture).Name"])
      : p === "macos" ? await exec("defaults", ["read", "-g", "AppleLocale"])
      : await exec("sh", ["-c", 'echo "${LC_ALL:-${LC_NUMERIC:-$LANG}}"']);
    const m = /([a-z]{2})[-_]([A-Z]{2})/.exec(r.stdout ?? "");
    if (m) loc = `${m[1]}-${m[2]}`;
  } catch {}
  try { localStorage.setItem("locale", loc); } catch {}
  return loc;
}

/** A picture's path for the image loader: in the unzipped folder, else written to the cache once. */
async function mediaPath(src, part, id) {
  if (src.rel) return `${src.rel}/${part}`;
  const bytes = src.bytes ? await src.bytes(part) : null;
  if (!bytes) return null;
  const rel = `${CACHE}/m-${id}-${part.replace(/[^\w.-]+/g, "_")}`;
  try { await fs.writeFile(`${appHome()}/${rel}`, bytes); } catch { return null; }
  return rel;
}

// ---- the view --------------------------------------------------------------------

export default class Sheet extends View {
  init(_props, cx) {
    this.state = "loading";
    this.error = null;
    this.zoom = 1;
    this.sx = 0; this.sy = 0; // scroll of the main pane, sheet px (unzoomed)
    this.sel = { r: 0, c: 0 };
    this.vw = 800; this.vh = 500;
    this.focus = cx.focus_handle();
    this.media = {};
    const p = props() ?? {};
    this.file = p.file ?? "";
    this.on = p.on ?? null;
    this.id = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e8).toString(36)}`;
    sweepCache();
    cx.spawn(async (cx) => {
      // A real yield to the host: the runtime stops scripts that run ~0.5 s without one.
      this.pause = () => new Promise((resolve) => cx.timer.after(1, () => resolve()));
      const tick = slicer(this.pause);
      const stage = (name) => { this.stage = name; cx.notify(); };
      try {
        if (!this.file) throw new Error("No file to show. Click a spreadsheet in the Files panel (file-browser mod), or run: herdr-app do tab.new --mod sheet-viewer --props '{\"file\":\"/full/path/book.xlsx\"}'");
        const e = ext(this.file);
        if (e === "xls") throw new Error("Old binary .xls workbooks can't be read: save it as .xlsx in Excel or LibreOffice.");
        stage("Reading the system locale");
        this.locale = await systemLocale();
        stage("Reading the file");
        const prep = await prepare(this.file, this.on, this.id, tick);
        this.cleanup = prep.cleanup.filter(Boolean);
        stage(prep.kind === "csv" ? "Reading rows" : "Reading styles and strings");
        if (prep.kind === "csv") {
          const csv = await readCsvText(prep.text, { delimiter: e === "tsv" ? "\t" : undefined, encoding: prep.encoding, tick });
          this.wb = await csvWorkbook(csv, this.file, tick);
        } else {
          this.wb = await openXlsx(prep.src, { pause: this.pause });
        }
        const visible = this.wb.sheets.map((s, i) => (s.hidden ? -1 : i)).filter((i) => i >= 0);
        stage("Reading the sheet");
        await this.openSheet(visible.includes(this.wb.activeTab) ? this.wb.activeTab : visible[0] ?? 0, cx);
        this.state = "ready";
      } catch (e) {
        this.state = "error";
        this.error = String(e?.message ?? e);
      }
      cx.notify();
    });
  }

  /** A click on sheet i. A sheet that fails to read shows why, with the other sheets to pick from. */
  switchSheet(i, cx) {
    cx.spawn(async (cx2) => {
      try { await this.openSheet(i, cx2); }
      catch (e) { if (this.tab === i) this.sheetError = String(e?.message ?? e); }
      cx2.notify();
    });
  }

  /** Shows sheet i, parsing it first if needed. */
  async openSheet(i, cx) {
    this.tab = i;
    this.sh = null;
    this.sheetError = null;
    cx?.notify();
    const sh = await this.wb.loadSheet(i);
    if (this.tab !== i) return; // another sheet was picked meanwhile: its own load sets the view up
    this.sh = sh;
    this.media = this.media ?? {};
    this.zoom = this.sh.view?.zoom ?? 1;
    const tl = this.sh.view?.topLeft ?? { r: 0, c: 0 };
    const fr = this.sh.view?.frozenRows ?? 0, fc = this.sh.view?.frozenCols ?? 0;
    this.sx = Math.max(0, colX(this.sh, Math.max(tl.c, fc)) - colX(this.sh, fc));
    this.sy = Math.max(0, rowY(this.sh, Math.max(tl.r, fr)) - rowY(this.sh, fr));
    this.sel = { r: Math.max(tl.r, fr), c: Math.max(tl.c, fc) };
    for (const d of this.sh.drawings) {
      if (d.kind !== "image" || this.media[d.media]) continue;
      const rel = await mediaPath(this.wb.src, d.media, this.id);
      this.media[d.media] = rel;
      // A picture written to the cache (not one in the unzipped folder) goes with the tab too.
      if (rel && rel.startsWith(`${CACHE}/m-`)) (this.cleanup ??= []).push(`${appHome()}/${rel}`);
    }
    cx?.notify();
  }

  /** The cache this view made goes with it. */
  async close() {
    for (const p of this.cleanup ?? []) removeCache(p);
  }

  // ---- geometry ----
  get fr() { return this.sh.view?.frozenRows ?? 0; }
  get fc() { return this.sh.view?.frozenCols ?? 0; }
  rowsTotal() { return Math.max(this.sh.maxRow + 1 + EXTRA_ROWS, this.fr + 1); }
  colsTotal() { return Math.min(16384, Math.max(this.sh.maxCol + 1 + EXTRA_COLS, this.fc + 1)); }
  headers() { return this.sh.view?.headers !== false; }
  rowHeadW() { return this.headers() ? Math.max(32, String(this.rowsTotal()).length * 8 + 14) : 0; }
  colHeadH() { return this.headers() ? HEAD_H : 0; }

  /** First row whose bottom edge is past y (sheet px), from row `from`. */
  rowAt(y, from = 0) {
    const sh = this.sh, total = this.rowsTotal();
    let lo = from, hi = total;
    rowY(sh, total);
    while (lo < hi) { const mid = (lo + hi) >> 1; if (rowY(sh, mid + 1) <= y) lo = mid + 1; else hi = mid; }
    return Math.min(lo, total - 1);
  }
  colAt(x, from = 0) {
    const sh = this.sh, total = this.colsTotal();
    let lo = from, hi = total;
    colX(sh, total);
    while (lo < hi) { const mid = (lo + hi) >> 1; if (colX(sh, mid + 1) <= x) lo = mid + 1; else hi = mid; }
    return Math.min(lo, total - 1);
  }
  maxScroll() {
    const z = this.zoom, sh = this.sh;
    const paneW = (this.vw - this.rowHeadW()) / z - colX(sh, this.fc), paneH = (this.vh - this.colHeadH()) / z - rowY(sh, this.fr);
    return {
      x: Math.max(0, colX(sh, this.colsTotal()) - colX(sh, this.fc) - paneW),
      y: Math.max(0, rowY(sh, this.rowsTotal()) - rowY(sh, this.fr) - paneH),
    };
  }
  scrollBy(dx, dy) {
    const m = this.maxScroll();
    this.sx = Math.max(0, Math.min(m.x, this.sx + dx));
    this.sy = Math.max(0, Math.min(m.y, this.sy + dy));
  }
  /** Keeps the selected cell in view. */
  reveal() {
    const sh = this.sh, z = this.zoom, { r, c } = this.sel;
    const paneW = (this.vw - this.rowHeadW()) / z - colX(sh, this.fc), paneH = (this.vh - this.colHeadH()) / z - rowY(sh, this.fr);
    if (c >= this.fc) {
      const x0 = colX(sh, c) - colX(sh, this.fc), x1 = x0 + colWidth(sh, c);
      if (x0 < this.sx) this.sx = x0; else if (x1 > this.sx + paneW) this.sx = x1 - paneW;
    }
    if (r >= this.fr) {
      const y0 = rowY(sh, r) - rowY(sh, this.fr), y1 = y0 + rowHeight(sh, r);
      if (y0 < this.sy) this.sy = y0; else if (y1 > this.sy + paneH) this.sy = y1 - paneH;
    }
    this.scrollBy(0, 0);
  }

  // ---- input ----
  wheel(e, cx) {
    const mods = e.modifiers ?? {};
    if (mods.control || mods.platform) {
      const k = (e.delta?.y ?? 0) > 0 ? 1.1 : 1 / 1.1;
      this.zoom = Math.max(0.5, Math.min(4, this.zoom * k));
    } else {
      let dx = -(e.delta?.x ?? 0), dy = -(e.delta?.y ?? 0);
      if (mods.shift && !dx) { dx = dy; dy = 0; }
      this.scrollBy(dx / this.zoom, dy / this.zoom);
    }
    cx.notify();
  }

  pick(local) {
    const sh = this.sh, z = this.zoom;
    const x = (local.x - this.rowHeadW()) / z, y = (local.y - this.colHeadH()) / z;
    if (x < 0 || y < 0) return null;
    const fw = colX(sh, this.fc), fh = rowY(sh, this.fr);
    const sxp = x < fw ? x : x + this.sx, syp = y < fh ? y : y + this.sy;
    let r = this.rowAt(syp), c = this.colAt(sxp);
    for (const m of sh.merges) if (r >= m.r1 && r <= m.r2 && c >= m.c1 && c <= m.c2) { r = m.r1; c = m.c1; }
    return { r, c };
  }

  key(e, cx) {
    const k = e.key, sh = this.sh;
    const step = (dr, dc) => {
      let { r, c } = this.sel;
      const m = sh.mergeAt.get(key(r, c));
      if (m && dr > 0) r = m.r2;
      if (m && dc > 0) c = m.c2;
      r = Math.max(0, Math.min(this.rowsTotal() - 1, r + dr));
      c = Math.max(0, Math.min(this.colsTotal() - 1, c + dc));
      while (dr && rowHeight(sh, r) === 0 && r > 0 && r < this.rowsTotal() - 1) r += dr;
      while (dc && colWidth(sh, c) === 0 && c > 0 && c < this.colsTotal() - 1) c += dc;
      for (const mm of sh.merges) if (r >= mm.r1 && r <= mm.r2 && c >= mm.c1 && c <= mm.c2) { r = mm.r1; c = mm.c1; }
      this.sel = { r, c };
    };
    const page = Math.max(1, Math.floor((this.vh - this.colHeadH()) / this.zoom / sh.defaultRowPx) - 1);
    if (k === "up") step(-1, 0);
    else if (k === "down" || k === "enter") step(1, 0);
    else if (k === "left") step(0, -1);
    else if (k === "right" || k === "tab") step(0, 1);
    else if (k === "pageup") step(-page, 0);
    else if (k === "pagedown") step(page, 0);
    else if (k === "home") this.sel = { r: e.modifiers?.control || e.modifiers?.platform ? 0 : this.sel.r, c: 0 };
    else if (k === "end" && (e.modifiers?.control || e.modifiers?.platform)) this.sel = { r: sh.maxRow, c: sh.maxCol };
    else if ((k === "=" || k === "+") && (e.modifiers?.control || e.modifiers?.platform)) this.zoom = Math.min(4, this.zoom * 1.1);
    else if (k === "-" && (e.modifiers?.control || e.modifiers?.platform)) this.zoom = Math.max(0.5, this.zoom / 1.1);
    else if (k === "0" && (e.modifiers?.control || e.modifiers?.platform)) this.zoom = 1;
    else return;
    this.reveal();
    cx.notify();
  }

  // ---- cell content and style ----
  styleOf(r, c, cell) {
    const sh = this.sh, wb = this.wb;
    const s = cell?.s ?? sh.rowStyle.get(r) ?? sh.colStyle.get(c) ?? sh.defaultColStyle ?? 0;
    const xf = wb.xfs[s] ?? wb.xfs[0];
    const k = key(r, c);
    const tbl = sh.table.get(k), cf = sh.cf.get(k);
    const font = { ...xf.font };
    let fill = xf.fill?.color ?? null;
    let border = xf.border;
    if (tbl) {
      if (!xf.explicitFill && tbl.fill) fill = tbl.fill;
      if (!xf.explicitFont) { if (tbl.color) font.color = tbl.color; if (tbl.bold) font.bold = true; }
      if (tbl.border && !xf.explicitBorder) border = tbl.border;
    }
    let fmt = xf.fmt ?? builtinFormat(xf.numFmtId, this.locale);
    if (cf) {
      if (cf.fill) fill = cf.fill;
      if (cf.color) font.color = cf.color;
      if (cf.bold) font.bold = true;
      if (cf.italic) font.italic = true;
      if (cf.underline) font.underline = true;
      if (cf.strike) font.strike = true;
      if (cf.border) border = { ...(border ?? {}), ...cf.border };
      if (cf.fmt) fmt = cf.fmt;
    }
    return { xf, font, fill, border, fmt, cf, align: xf.align };
  }

  display(cell, st) {
    if (!cell) return null;
    if (cell.text !== undefined) return { text: cell.text, color: null, num: typeof cell.v === "number" };
    let v = cell.v;
    if ((v === null || v === undefined) && cell.unknown && cell.f) return { text: "=" + cell.f, color: "#7f7f7f", num: false, italic: true };
    if (v === null || v === undefined) return null;
    if (isErr(v)) return { text: v.error, color: null, num: false, err: true };
    const fmt = st.fmt || "General";
    if (cell._fmt !== fmt) {
      const out = formatValue(v, fmt, { date1904: this.wb.date1904, locale: this.locale }) ?? { text: String(v) };
      cell._fmt = fmt;
      cell._out = { text: out.text, color: out.color ?? null, num: typeof v === "number", bool: typeof v === "boolean",
        general: fmt === "General" && typeof v === "number" ? v : undefined };
    }
    return cell._out;
  }

  /** How far left-aligned text may spill right into empty neighbours (sheet px). */
  spill(r, c, w, dir) {
    const sh = this.sh;
    let total = w, cc = c + dir, n = 0;
    while (cc >= 0 && cc < this.colsTotal() && n < 30) {
      const k = key(r, cc);
      const nb = sh.cells.get(k);
      if ((nb && nb.v !== null && nb.v !== undefined && nb.v !== "") || sh.mergeCovered.has(k) || sh.mergeAt.has(k)) break;
      total += colWidth(sh, cc);
      cc += dir; n++;
    }
    return total;
  }

  // ---- drawing ----
  renderCells(t, rows, cols, ox, oy) {
    const sh = this.sh, z = this.zoom;
    const fills = [], texts = [], borders = [], lines = [], extras = [];
    const X = (c) => (colX(sh, c) - ox) * z, Y = (r) => (rowY(sh, r) - oy) * z;
    const [r0, r1] = rows, [c0, c1] = cols;
    // Gridlines first: everything else covers them.
    if (sh.view?.grid !== false) {
      for (let c = c0; c <= c1 + 1; c++) lines.push(div().absolute().left(X(c) - 1).top(Y(r0)).w(1).h(Y(r1 + 1) - Y(r0)).bg(GRID));
      for (let r = r0; r <= r1 + 1; r++) if (rowHeight(sh, r - 1) > 0 || r === r0) lines.push(div().absolute().top(Y(r) - 1).left(X(c0)).h(1).w(X(c1 + 1) - X(c0)).bg(GRID));
    }
    const drawn = new Set();
    const cellBox = (r, c, rr2, cc2) => {
      const x = X(c), y = Y(r), w = X(cc2 + 1) - x, h = Y(rr2 + 1) - y;
      if (w <= 0 || h <= 0) return;
      const cell = sh.cells.get(key(r, c));
      const st = this.styleOf(r, c, cell);
      if (st.fill) fills.push(div().absolute().left(x).top(y).w(w).h(h).bg(st.fill));
      if (st.cf?.bar) {
        const bw = Math.max(2, (w - 4) * st.cf.bar.pct);
        fills.push(div().absolute().left(x + 2).top(y + 2).w(bw).h(Math.max(2, h - 4)).bg(st.cf.bar.color + "cc").border(1).border_color(st.cf.bar.color));
      }
      const shown = st.cf?.hideValue ? null : this.display(cell, st);
      if (shown?.text) {
        const f = st.font, a = st.align;
        const size = (f.size || 11) * PT * z;
        const h0 = a.h === "general" ? (shown.err || shown.bool ? "center" : shown.num ? "right" : "left") : a.h;
        let text = shown.text;
        let boxX = x, boxW = w;
        const wrap = a.wrap || a.h === "justify" || a.h === "distributed";
        if (!wrap && shown.general !== undefined && !shown.err) {
          // General never shows "####" in Excel: it rounds to the column, then goes to E notation.
          const room = w - 4 * z - (st.cf?.icon ? size * 1.3 : 0);
          if (textWidth(text, size, f.bold) > room) {
            text = fitGeneral(shown.general, (s) => textWidth(s, size, f.bold) <= room, text.includes(",") ? "," : ".") ?? text;
          }
        }
        if (!wrap && !st.cf?.icon) {
          const est = textWidth(text, size, f.bold);
          if (shown.num && est > w - 4 * z && !shown.err) text = "#".repeat(Math.max(1, Math.floor((w - 4 * z) / (size * 0.5))));
          else if (!shown.num && est > w && (h0 === "left" || h0 === "general" || h0 === "fill")) boxW = this.spill(r, c, colX(sh, cc2 + 1) - colX(sh, c), 1) * z;
          else if (!shown.num && est > w && h0 === "right") { const sw = this.spill(r, c, colX(sh, cc2 + 1) - colX(sh, c), -1) * z; boxX = x + w - sw; boxW = sw; }
          else if (!shown.num && est > w && (h0 === "center" || h0 === "centerContinuous")) { const extra = Math.min(est - w, w * 4) / 2; boxX = x - extra; boxW = w + extra * 2; }
        }
        const indent = (a.indent || 0) * 9 * z;
        let el = div().absolute().left(boxX).top(y).w(boxW).h(h).px(2 * z).flex().overflow_hidden()
          .text_size(size).font_family(f.name || "Calibri").text_color(shown.color ?? f.color ?? "#000000")
          .when(a.v === "top", (e) => e.items_start()).when(a.v === "center" || a.v === "distributed" || a.v === "justify", (e) => e.items_center()).when(!a.v || a.v === "bottom", (e) => e.items_end())
          .when(h0 === "center" || h0 === "centerContinuous" || h0 === "distributed", (e) => e.justify_center())
          .when(h0 === "right", (e) => e.justify_end())
          .when(Boolean(indent) && h0 !== "right", (e) => e.pl(indent + 2 * z))
          .when(Boolean(indent) && h0 === "right", (e) => e.pr(indent + 2 * z));
        const styleText = (d, ff) => d.when(ff.bold, (e) => e.font_weight(700)).when(ff.italic || shown.italic, (e) => e.italic()).when(ff.underline, (e) => e.underline()).when(ff.strike, (e) => e.line_through());
        if (cell?.rich && !shown.color && cell.text === undefined) {
          const runs = cell.rich.map((run, i) => styleText(div().id(`run-${r}-${c}-${i}`).flex_none().whitespace_nowrap().text_size(((run.font?.size ?? f.size) || 11) * PT * z).font_family(run.font?.name ?? f.name).text_color(run.font?.color ?? f.color ?? "#000000").child(run.text), run.font ?? f));
          el = el.child(h_flex().when(wrap, (e) => e.flex_wrap()).children(runs));
        } else if (a.rot === 255) {
          el = el.child(styleText(v_flex().items_center().children([...text].map((ch) => div().child(ch))), f));
        } else {
          el = styleText(el, f).child(wrap ? div().w_full().whitespace_normal().line_height(size * 1.22).when(h0 === "center", (e) => e.text_center()).when(h0 === "right", (e) => e.text_right()).child(text) : div().flex_none().whitespace_nowrap().child(text));
        }
        if (st.cf?.icon) el = el.child(iconFor(st.cf.icon, size));
        texts.push(el);
      } else if (st.cf?.icon) {
        texts.push(div().absolute().left(x).top(y).w(w).h(h).flex().items_center().px(2).child(iconFor(st.cf.icon, 11 * PT * z)));
      }
      if (st.border) {
        for (const [side, b] of Object.entries(st.border)) {
          if (!b) continue;
          const px = (BORDER_PX[b.style] ?? 1) * Math.max(1, Math.round(z));
          const col = b.color ?? "#000000";
          const dbl = b.style === "double";
          const line = (lx, ly, lw, lh) => borders.push(div().absolute().left(lx).top(ly).w(lw).h(lh).bg(col));
          if (side === "t") { line(x - 1, y - 1, w + 1, dbl ? 1 : px); if (dbl) line(x - 1, y + 1, w + 1, 1); }
          if (side === "b") { line(x - 1, y + h - px, w + 1, dbl ? 1 : px); if (dbl) line(x - 1, y + h - 3, w + 1, 1); }
          if (side === "l") { line(x - 1, y - 1, dbl ? 1 : px, h + 1); if (dbl) line(x + 1, y - 1, 1, h + 1); }
          if (side === "r") { line(x + w - px, y - 1, dbl ? 1 : px, h + 1); if (dbl) line(x + w - 3, y - 1, 1, h + 1); }
        }
      }
      if (sh.comments.has(key(r, c))) extras.push(div().absolute().left(x + w - 6 * z).top(y).size(5 * z).bg("#c00000"));
    };
    // Merged ranges overlapping this window, drawn whole from their top-left.
    for (const m of sh.merges) {
      if (m.r2 < r0 || m.r1 > r1 || m.c2 < c0 || m.c1 > c1) continue;
      cellBox(m.r1, m.c1, m.r2, m.c2);
      drawn.add(key(m.r1, m.c1));
    }
    for (let r = r0; r <= r1; r++) {
      if (rowHeight(sh, r) === 0) continue;
      for (let c = c0; c <= c1; c++) {
        const k = key(r, c);
        if (drawn.has(k) || sh.mergeCovered.has(k) || colWidth(sh, c) === 0) continue;
        if (!sh.cells.has(k) && !sh.rowStyle.has(r) && !sh.colStyle.has(c) && sh.defaultColStyle === undefined && !sh.table.has(k) && !sh.cf.has(k) && !sh.comments.has(k)) continue;
        cellBox(r, c, r, c);
      }
    }
    for (const f of sh.filters) {
      if (f.r < r0 || f.r > r1) continue;
      for (let c = Math.max(f.c1, c0); c <= Math.min(f.c2, c1); c++) {
        const s = 15 * z;
        extras.push(div().absolute().left(X(c + 1) - s - 2).top(Y(f.r + 1) - s - 2).size(s).bg("#ffffff").border(1).border_color("#a6a6a6").flex().items_center().justify_center().text_size(9 * z).text_color("#444444").child("▾"));
      }
    }
    return [...lines, ...fills, ...texts, ...borders, ...extras];
  }

  renderDrawings(t, ox, oy, paneKey = "m") {
    const sh = this.sh, z = this.zoom;
    return sh.drawings.map((d, i) => {
      const x = (d.x - ox) * z, y = (d.y - oy) * z, w = d.w * z, h = d.h * z;
      if (x > this.vw || y > this.vh || x + w < 0 || y + h < 0 || w <= 0 || h <= 0) return null;
      if (d.kind === "image") {
        const src = this.media[d.media];
        return div().id(`dr-${paneKey}-${i}`).absolute().left(x).top(y).w(w).h(h).when(Boolean(src), (e) => e.child(image(src).w(w).h(h)));
      }
      if (d.kind === "chart") {
        return div().id(`dr-${paneKey}-${i}`).absolute().left(x).top(y).w(w).h(h).overflow_hidden()
          .child(d.xml ? drawChart(d.xml, {
            // This view's id too: a workbook changed on disk and opened again must not get the old chart.
            width: w, height: h, zoom: z, theme: this.wb.theme, key: `${this.id}|${this.file}|${this.tab}-${i}`,
            format: (v, code) => formatValue(v, code || "General", { date1904: this.wb.date1904, locale: this.locale }).text,
            lookup: (ref, isNum) => this.refValues(ref, isNum),
          }) : div());
      }
      // Shapes and text boxes.
      const radius = d.geom === "roundRect" ? Math.min(w, h) * 0.16 : d.geom === "ellipse" ? Math.min(w, h) / 2 : 0;
      return div().id(`dr-${paneKey}-${i}`).absolute().left(x).top(y).w(w).h(h).rounded(radius)
        .when(Boolean(d.fill), (e) => e.bg(d.fill))
        .when(Boolean(d.line), (e) => e.border(Math.max(1, Math.round(d.line.w * z))).border_color(d.line.color))
        .flex().items_center().when(d.align === "ctr", (e) => e.justify_center()).when(d.align === "r", (e) => e.justify_end())
        .p(4 * z).text_size((d.size || 11) * PT * z).text_color(d.color ?? "#000000")
        .when(Boolean(d.text), (e) => e.child(div().whitespace_normal().child(d.text)));
    }).filter(Boolean);
  }

  /**
   * A chart's data reference ("'Sheet 1'!$B$3:$B$7", several areas in parentheses) read from
   * the workbook: for charts saved without cached values. Categories come back as the text
   * Excel shows (dates and numbers formatted).
   */
  refValues(ref, isNum) {
    const parts = String(ref).trim().replace(/^\(|\)$/g, "").split(/,(?=(?:[^']*'[^']*')*[^']*$)/);
    const values = [];
    let formatCode = null;
    for (const part of parts) {
      const m = /^(?:'((?:[^']|'')+)'|([^!]+))!(.+)$/.exec(part.trim());
      const sh = m ? this.wb.sheetByName(m[1] ? m[1].replace(/''/g, "'") : m[2]) : this.sh;
      const rg = parseRange((m ? m[3] : part).replace(/\$/g, "").trim());
      if (!sh || !rg) continue;
      for (let r = rg.r1; r <= rg.r2; r++) for (let c = rg.c1; c <= rg.c2; c++) {
        const cell = sh.cells.get(key(r, c));
        const xf = this.wb.xfs[cell?.s ?? 0] ?? this.wb.xfs[0];
        const fmt = xf.fmt ?? builtinFormat(xf.numFmtId, this.locale);
        const v = cell?.v;
        if (v === null || v === undefined) { values.push(null); continue; }
        if (typeof v === "number" && formatCode === null) formatCode = fmt;
        if (isNum) values.push(v);
        else values.push(typeof v === "number" ? formatValue(v, fmt || "General", { date1904: this.wb.date1904, locale: this.locale }).text : isErr(v) ? v.error : String(v));
      }
    }
    return { values, formatCode };
  }

  renderGrid(t) {
    const sh = this.sh, z = this.zoom;
    const RH = this.rowHeadW(), CH = this.colHeadH();
    const fr = this.fr, fc = this.fc;
    const fw = colX(sh, fc), fh = rowY(sh, fr);
    const paneW = (this.vw - RH) / z, paneH = (this.vh - CH) / z;
    // Visible rows/cols of the scrolling part.
    const rStart = this.rowAt(fh + this.sy, fr), rEnd = this.rowAt(fh + this.sy + paneH - fh, rStart);
    const cStart = this.colAt(fw + this.sx, fc), cEnd = this.colAt(fw + this.sx + paneW - fw, cStart);
    const pane = (left, top, w, h, kids) => div().absolute().left(left).top(top).w(Math.max(0, w)).h(Math.max(0, h)).overflow_hidden().children(kids);
    const bodyX = RH + fw * z, bodyY = CH + fh * z;
    const out = [];
    // Main (scrolls both ways), top (frozen rows, scrolls x), left (frozen cols, scrolls y), corner.
    out.push(pane(bodyX, bodyY, this.vw - bodyX, this.vh - bodyY, [
      ...this.renderCells(t, [rStart, rEnd], [cStart, cEnd], fw + this.sx, fh + this.sy),
      ...this.renderDrawings(t, fw + this.sx, fh + this.sy),
    ]));
    if (fr) out.push(pane(bodyX, CH, this.vw - bodyX, fh * z, [...this.renderCells(t, [0, fr - 1], [cStart, cEnd], fw + this.sx, 0), ...this.renderDrawings(t, fw + this.sx, 0, "t")]));
    if (fc) out.push(pane(RH, bodyY, fw * z, this.vh - bodyY, [...this.renderCells(t, [rStart, rEnd], [0, fc - 1], 0, fh + this.sy), ...this.renderDrawings(t, 0, fh + this.sy, "l")]));
    if (fr && fc) out.push(pane(RH, CH, fw * z, fh * z, [...this.renderCells(t, [0, fr - 1], [0, fc - 1], 0, 0), ...this.renderDrawings(t, 0, 0, "c")]));
    // Frozen-pane edges, as Excel draws them.
    if (fr) out.push(div().absolute().left(RH).top(bodyY - 1).w(this.vw - RH).h(1).bg("#a0a0a0"));
    if (fc) out.push(div().absolute().left(bodyX - 1).top(CH).w(1).h(this.vh - CH).bg("#a0a0a0"));

    // Selection rectangle.
    const m = sh.mergeAt.get(key(this.sel.r, this.sel.c));
    const sr2 = m ? m.r2 : this.sel.r, sc2 = m ? m.c2 : this.sel.c;
    const sxOf = (c) => (c < fc ? RH + colX(sh, c) * z : bodyX + (colX(sh, c) - fw - this.sx) * z);
    const syOf = (r) => (r < fr ? CH + rowY(sh, r) * z : bodyY + (rowY(sh, r) - fh - this.sy) * z);
    const selX = sxOf(this.sel.c), selY = syOf(this.sel.r);
    const selW = sxOf(sc2 + 1) - selX, selH = syOf(sr2 + 1) - selY;
    out.push(div().absolute().left(selX - 1).top(selY - 1).w(selW + 1).h(selH + 1).border(2).border_color(SEL));

    // Headers.
    if (this.headers()) {
      // Column letters and row numbers, in four clipped strips like the cell panes.
      const colHead = (c, x) => { const w = colWidth(sh, c) * z; if (w <= 0) return null; const on = c >= this.sel.c && c <= sc2; return div().absolute().left(x).top(0).w(w).h(CH).bg(on ? "#d2d2d2" : HEAD_BG).border_r(1).border_b(on ? 2 : 1).border_color(on ? SEL : HEAD_LINE).flex().items_center().justify_center().text_size(11).text_color(on ? "#1f1f1f" : HEAD_FG).child(colName(c)); };
      const rowHead = (r, y) => { const h = rowHeight(sh, r) * z; if (h <= 0) return null; const on = r >= this.sel.r && r <= sr2; return div().absolute().left(0).top(y).w(RH).h(h).bg(on ? "#d2d2d2" : HEAD_BG).border_b(1).border_r(on ? 2 : 1).border_color(on ? SEL : HEAD_LINE).flex().items_center().justify_center().text_size(11).text_color(on ? "#1f1f1f" : HEAD_FG).child(String(r + 1)); };
      const range = (a, b) => { const o = []; for (let i = a; i <= b; i++) o.push(i); return o; };
      out.push(div().absolute().left(0).top(0).w(this.vw).h(CH).bg(HEAD_BG));
      out.push(div().absolute().left(0).top(0).w(RH).h(this.vh).bg(HEAD_BG));
      if (fc) out.push(pane(RH, 0, fw * z, CH, range(0, fc - 1).map((c) => colHead(c, colX(sh, c) * z)).filter(Boolean)));
      out.push(pane(bodyX, 0, this.vw - bodyX, CH, range(cStart, cEnd).map((c) => colHead(c, (colX(sh, c) - fw - this.sx) * z)).filter(Boolean)));
      if (fr) out.push(pane(0, CH, RH, fh * z, range(0, fr - 1).map((r) => rowHead(r, rowY(sh, r) * z)).filter(Boolean)));
      out.push(pane(0, bodyY, RH, this.vh - bodyY, range(rStart, rEnd).map((r) => rowHead(r, (rowY(sh, r) - fh - this.sy) * z)).filter(Boolean)));
      out.push(div().absolute().left(0).top(0).w(RH).h(CH).bg(HEAD_BG).border_r(1).border_b(1).border_color(HEAD_LINE));
    }

    // Scrollbars: position only (wheel, keys and drag of the thumb scroll).
    const ms = this.maxScroll();
    if (ms.y > 0) {
      const trackH = this.vh - bodyY - 10, th = Math.max(24, trackH * (paneH - fh) / (paneH - fh + ms.y));
      out.push(div().id("vthumb").absolute().right(2).top(bodyY + 2 + (trackH - th) * (this.sy / ms.y)).w(6).h(th).rounded_full().bg("#00000040")
        .on_mouse_down("left", (e, cx) => { this.drag = { axis: "y", from: e.position.y, start: this.sy, per: ms.y / Math.max(1, trackH - th) }; cx.stop_propagation(); }));
    }
    if (ms.x > 0) {
      const trackW = this.vw - bodyX - 10, tw = Math.max(24, trackW * (paneW - fw) / (paneW - fw + ms.x));
      out.push(div().id("hthumb").absolute().bottom(2).left(bodyX + 2 + (trackW - tw) * (this.sx / ms.x)).h(6).w(tw).rounded_full().bg("#00000040")
        .on_mouse_down("left", (e, cx) => { this.drag = { axis: "x", from: e.position.x, start: this.sx, per: ms.x / Math.max(1, trackW - tw) }; cx.stop_propagation(); }));
    }
    return out;
  }

  render() {
    const t = theme();
    const name = base(this.file);
    const shell = (body) => v_flex().id("sheet-root").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13).child(body);
    if (this.state !== "ready") {
      return shell(v_flex().size_full().items_center().justify_center().gap(8)
        .child(div().text_size(14).font_semibold().child(name || "Spreadsheet"))
        .child(div().text_color(this.state === "error" ? t.blocked : t.dim).max_w(520).whitespace_normal().text_center().child(this.state === "error" ? this.error : `${this.stage ?? "Opening"}…`)));
    }
    const sh = this.sh;
    if (!sh && this.sheetError) {
      // One sheet failed to read: say why, and keep the other sheets a click away.
      const others = this.wb.sheets.map((s, i) => ({ s, i })).filter(({ s, i }) => !s.hidden && i !== this.tab);
      return shell(v_flex().size_full().items_center().justify_center().gap(10)
        .child(div().text_color(t.blocked).max_w(520).whitespace_normal().text_center().child(this.sheetError))
        .child(h_flex().gap(6).flex_wrap().justify_center().children(others.map(({ s, i }) =>
          div().id(`err-tab-${i}`).h(24).px(10).flex().items_center().rounded(5).text_size(12.5).cursor_pointer()
            .border(1).border_color(t.border).hover((st) => st.bg(t.hover))
            .on_click((_ev, cx) => this.switchSheet(i, cx)).child(s.name)))));
    }
    if (!sh) return shell(v_flex().size_full().items_center().justify_center().text_color(t.dim).child("Reading the sheet…"));
    const cell = sh.cells.get(key(this.sel.r, this.sel.c));
    const raw = cell ? (cell.f ? "=" + cell.f : cell.text !== undefined ? cell.text : isErr(cell.v) ? cell.v.error : cell.v === null || cell.v === undefined ? "" : String(cell.v)) : "";
    const note = sh.comments.get(key(this.sel.r, this.sel.c));
    const link = sh.hyperlinks.get(key(this.sel.r, this.sel.c));
    const tabs = this.wb.sheets.map((s, i) => ({ s, i })).filter(({ s }) => !s.hidden);
    const z = this.zoom;
    const btn = (id, label, action) => div().id(id).px(6).h(22).rounded(5).flex().items_center().text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => { action(); cx.notify(); }).child(label);

    return shell(v_flex().size_full().min_h(0)
      // Title bar.
      .child(h_flex().h(34).flex_none().px(12).gap(10).items_center().border_b(1).border_color(t.border)
        .child(svg("mods/sheet-viewer/file.svg").size(14).text_color(t.muted))
        .child(div().font_semibold().truncate().child(name))
        .child(div().text_size(11.5).text_color(t.dim).child(this.wb.csv ? `${this.wb.csv.encoding} · "${this.wb.csv.delimiter === "\t" ? "Tab" : this.wb.csv.delimiter}"` : `${sh.maxRow + 1} × ${sh.maxCol + 1}`))
        .child(div().flex_1())
        .child(btn("zoom-out", "−", () => { this.zoom = Math.max(0.5, this.zoom / 1.1); this.scrollBy(0, 0); }))
        .child(div().w(44).text_center().text_size(12).text_color(t.muted).child(`${Math.round(z * 100)}%`))
        .child(btn("zoom-in", "+", () => { this.zoom = Math.min(4, this.zoom * 1.1); }))
        .child(btn("zoom-reset", "100%", () => { this.zoom = 1; })))
      // Formula bar.
      .child(h_flex().h(28).flex_none().px(8).gap(8).items_center().border_b(1).border_color(t.border).text_size(12.5)
        .child(div().w(72).flex_none().text_center().font_family("JetBrains Mono").text_color(t.muted).child(cellName(this.sel.r, this.sel.c)))
        .child(div().w(1).h(16).bg(t.border))
        .child(div().flex_1().min_w(0).truncate().font_family(cell?.f ? "JetBrains Mono" : "inherit").child(raw))
        .when(Boolean(link), (e) => e.child(div().flex_none().max_w(260).truncate().text_color(t.accent).child(`↗ ${link}`)))
        .when(Boolean(note), (e) => e.child(div().flex_none().max_w(360).truncate().text_color(t.dim).child(`💬 ${note}`))))
      // The sheet itself: white like Excel, so colors read as in the file.
      .child(div().id("grid").relative().flex_1().min_h(0).overflow_hidden().bg("#ffffff")
        .track_focus(this.focus)
        .on_size_change((size, cx) => { if (size.width !== this.vw || size.height !== this.vh) { this.vw = size.width; this.vh = size.height; this.scrollBy(0, 0); cx.notify(); } })
        .on_scroll_wheel((e, cx) => this.wheel(e, cx))
        .on_key_down((e, cx) => this.key(e, cx))
        .on_mouse_down("left", (e, cx) => {
          this.focus.focus();
          if (!e.local_position) return;
          const p = this.pick(e.local_position);
          if (p) { this.sel = p; cx.notify(); }
        })
        .on_mouse_move((e, cx) => {
          if (!this.drag) return;
          const d = this.drag;
          if (d.axis === "y") this.sy = d.start + (e.position.y - d.from) * d.per;
          else this.sx = d.start + (e.position.x - d.from) * d.per;
          this.scrollBy(0, 0);
          cx.notify();
        })
        .on_mouse_up("left", () => { this.drag = null; })
        .children(this.renderGrid(t)))
      // Sheet tabs.
      .when(!this.wb.csv, (e) => e.child(h_flex().id("tabs").h(30).flex_none().px(8).gap(2).items_center().border_t(1).border_color(t.border).overflow_x_scroll()
        .children(tabs.map(({ s, i }) => {
          const on = i === this.tab;
          const color = this.wb.sheet(i)?.tabColor ?? this.wb.sheets[i].tabColor;
          return div().id(`tab-${i}`).relative().h(24).px(12).flex().items_center().rounded(5).text_size(12.5)
            .bg(on ? t.surface : "#00000000").text_color(on ? t.foreground : t.muted).when(on, (e2) => e2.font_semibold().border(1).border_color(t.border))
            .hover((st) => st.bg(t.hover))
            .on_click((_ev, cx) => { if (i !== this.tab) this.switchSheet(i, cx); })
            .child(s.name)
            .when(Boolean(color), (e2) => e2.child(div().absolute().left(6).right(6).bottom(1).h(3).rounded_full().bg(color)));
        })))));
  }
}

// Icon sets as glyphs: arrows (green up, amber side, red down), else traffic lights.
function iconFor(icon, size) {
  const { set, level, of } = icon;
  const k = of <= 1 ? 1 : level / (of - 1);
  const col = k >= 0.67 ? "#63be7b" : k >= 0.34 ? "#ffc000" : "#f8696b";
  const arrows = /Arrows/i.test(set);
  const glyph = arrows ? (k >= 0.67 ? "↑" : k >= 0.34 ? "→" : "↓") : /Symbols/i.test(set) ? (k >= 0.67 ? "✔" : k >= 0.34 ? "!" : "✖") : /Flags/i.test(set) ? "⚑" : "●";
  return div().flex_none().mr(4).text_size(size).text_color(col).child(glyph);
}

// A CSV as a one-sheet workbook with Excel's default look. Async: it walks every cell, and a big
// file would otherwise run past the host's time limit without a yield.
async function csvWorkbook(csv, file, tick) {
  const font = { name: "Calibri", size: 11, bold: false, italic: false, underline: false, strike: false, color: "#000000" };
  const sheet = {
    name: base(file).replace(/\.[^.]+$/, ""), index: 0, cells: csv.cells, maxRow: Math.max(0, csv.rows - 1), maxCol: csv.maxCol,
    colPx: [], colHidden: new Set(), colStyle: new Map(), rowPx: new Map(), rowHidden: new Set(), rowStyle: new Map(),
    merges: [], mergeAt: new Map(), mergeCovered: new Set(), cf: new Map(), table: new Map(), comments: new Map(), hyperlinks: new Map(),
    drawings: [], filters: [], defaultRowPx: 20, defaultColPx: 64, view: { grid: true, headers: true, zoom: 1, frozenRows: 0, frozenCols: 0, topLeft: { r: 0, c: 0 } },
  };
  // Columns as wide as their content (up to a limit), so a CSV reads without resizing.
  const widest = [];
  let n = 0;
  for (const c of csv.cells.values()) {
    if ((++n & 1023) === 0) await tick(true);
    if (c.r > 2000) continue;
    const longest = Math.max(...String(c.text).split("\n").map((l) => l.length));
    widest[c.c] = Math.max(widest[c.c] ?? 0, longest);
  }
  widest.forEach((n, c) => { sheet.colPx[c] = Math.max(64, Math.min(420, Math.round(n * 7.2 + 12))); });
  return {
    csv: { encoding: csv.encoding, delimiter: csv.delimiter },
    sheets: [{ name: sheet.name, hidden: false }], activeTab: 0, date1904: false, theme: {},
    xfs: [{ numFmtId: 0, fmt: "General", font, fill: null, border: null, align: { h: "general", v: "bottom", wrap: false, indent: 0, rot: 0 } }],
    sheet: () => sheet, loadSheet: async () => sheet, sheetByName: () => null, src: {},
  };
}

