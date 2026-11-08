// Reads an .xlsx/.xlsm workbook into a model the viewer draws: every sheet's cells with their
// resolved style (font, fill, borders, alignment, number format), geometry (column widths, row
// heights, hidden rows/columns), merges, frozen panes, conditional formatting, Excel tables,
// pictures, charts, shapes and comments. Read-only and lazy: a sheet is parsed when first shown.
//
// The mod runtime is an interpreter (~50x slower than V8) that stops any script running more
// than ~0.5 s without yielding. So the parts come from a *source* (the workbook unzipped by the
// OS into a cache folder, read natively), and every long loop yields through `pause()`.
import { unzipSync, strFromU8 } from "./fflate.js";
import { parseXml, child, kids, path, all, textOf, val } from "./xml.js";
import { resolveColor, DEFAULT_THEME, INDEXED, applyTint, mix } from "./colors.js";
import { evaluate, colIndex } from "./formula.js";

export const EMU_PER_PX = 9525;
const PT_PX = 96 / 72;
const MDW = 7; // maximum digit width of Calibri 11 at 96 dpi, Excel's unit for column widths

export const key = (r, c) => r * 16384 + c;
export function colName(c) {
  let s = "";
  for (c += 1; c > 0; c = Math.floor((c - 1) / 26)) s = String.fromCharCode(65 + ((c - 1) % 26)) + s;
  return s;
}
export function cellName(r, c) { return colName(c) + (r + 1); }
export function parseCell(ref) {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(ref);
  return m ? { r: Number(m[2]) - 1, c: colIndex(m[1]) } : null;
}
export function parseRange(ref) {
  const [a, b] = ref.split(":");
  const p = parseCell(a), q = b ? parseCell(b) : p;
  if (!p || !q) return null;
  return { r1: Math.min(p.r, q.r), c1: Math.min(p.c, q.c), r2: Math.max(p.r, q.r), c2: Math.max(p.c, q.c) };
}

/** Excel stores widths with padding; this is the pixel width Excel draws at 100%. */
export function widthPx(w) {
  return Math.trunc(((256 * w + Math.trunc(128 / MDW)) / 256) * MDW);
}

function dirOf(p) { const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i + 1); }
function join(base, target) {
  if (target.startsWith("/")) return target.slice(1);
  const parts = (base + target).split("/");
  const out = [];
  for (const x of parts) { if (x === "..") out.pop(); else if (x !== ".") out.push(x); }
  return out.join("/");
}

// Pattern fills Excel draws as a dot/hatch mix: approximate by their ink coverage.
const PATTERN = { gray125: 0.125, gray0625: 0.0625, lightGray: 0.25, mediumGray: 0.5, darkGray: 0.75, darkHorizontal: 0.5, darkVertical: 0.5, darkDown: 0.5, darkUp: 0.5, darkGrid: 0.5, darkTrellis: 0.75, lightHorizontal: 0.25, lightVertical: 0.25, lightDown: 0.25, lightUp: 0.25, lightGrid: 0.4, lightTrellis: 0.25 };
export const BORDER_PX = { hair: 1, thin: 1, dotted: 1, dashed: 1, dashDot: 1, dashDotDot: 1, medium: 2, mediumDashed: 2, mediumDashDot: 2, mediumDashDotDot: 2, slantDashDot: 2, thick: 3, double: 3 };

/** Yields to the host every ~`ms` of work; call it inside long loops. */
export function slicer(pause, ms = 90) {
  let t = Date.now(), n = 0;
  return async (force) => {
    if (!force && (++n & 31) !== 0) return;
    if (Date.now() - t > ms) { await pause(); t = Date.now(); }
  };
}

/** A source over zip bytes, for when the OS can not unzip (decompresses one part at a time). */
export function zipSource(bytes) {
  const cache = new Map();
  const get = (p) => {
    if (!cache.has(p)) cache.set(p, unzipSync(bytes, { filter: (f) => f.name === p })[p] ?? null);
    return cache.get(p);
  };
  return { text: async (p) => { const b = get(p); return b ? strFromU8(b) : null; }, exists: async (p) => !!get(p), bytes: async (p) => get(p) };
}

/**
 * src: { text(part) -> Promise<string|null>, exists(part) -> Promise<boolean> }
 * opts.pause: () => Promise, a real yield to the host (a timer), used between slices.
 */
export async function openXlsx(src, { pause = async () => {} } = {}) {
  const tick = slicer(pause);
  const text = (p) => src.text(p);
  const xml = async (p) => { const t = await text(p); return t ? parseXml(t) : null; };
  const relsOf = async (p) => {
    const out = {};
    const doc = await xml(dirOf(p) + "_rels/" + p.slice(dirOf(p).length) + ".rels");
    for (const r of kids(doc, "Relationship")) {
      out[r.attrs.Id] = { type: (r.attrs.Type || "").split("/").pop(), target: r.attrs.TargetMode === "External" ? r.attrs.Target : join(dirOf(p), r.attrs.Target), external: r.attrs.TargetMode === "External" };
    }
    return out;
  };

  const rootRels = await relsOf("");
  const wbPath = Object.values(rootRels).find((r) => r.type === "officeDocument")?.target ?? "xl/workbook.xml";
  const wbXml = await xml(wbPath);
  if (!wbXml) throw new Error("Not an Excel workbook (no xl/workbook.xml)");
  const wbRels = await relsOf(wbPath);
  const date1904 = ["1", "true"].includes(child(wbXml, "workbookPr")?.attrs.date1904);

  // Theme colors and fonts.
  const theme = { ...DEFAULT_THEME };
  const themePart = Object.values(wbRels).find((r) => r.type === "theme");
  const themeXml = themePart ? await xml(themePart.target) : null;
  if (themeXml) {
    const scheme = all(themeXml, "clrScheme")[0];
    for (const slot of scheme?.children ?? []) {
      const c = child(slot, "srgbClr")?.attrs.val ?? child(slot, "sysClr")?.attrs.lastClr;
      if (c) theme[slot.name] = "#" + c.toLowerCase();
    }
    const fonts = all(themeXml, "fontScheme")[0];
    theme.majorFont = path(fonts, "majorFont/latin")?.attrs.typeface || theme.majorFont;
    theme.minorFont = path(fonts, "minorFont/latin")?.attrs.typeface || theme.minorFont;
  }

  // Styles.
  const stylesPart = Object.values(wbRels).find((r) => r.type === "styles");
  const st = stylesPart ? await xml(stylesPart.target) : null;
  await tick(true);
  const indexed = INDEXED.slice();
  kids(path(st, "colors/indexedColors"), "rgbColor").forEach((c, i) => { const v = c.attrs.rgb; if (v) indexed[i] = "#" + v.slice(-6).toLowerCase(); });
  const color = (el) => (el ? resolveColor(el.attrs, theme, indexed) : null);
  const numFmts = {};
  for (const f of kids(child(st, "numFmts"), "numFmt")) numFmts[f.attrs.numFmtId] = f.attrs.formatCode;
  const font = (f) => f && {
    name: val(f, "name") ?? val(f, "rFont") ?? theme.minorFont,
    size: Number(val(f, "sz", 11)),
    bold: !!child(f, "b") && val(f, "b", "1") !== "0",
    italic: !!child(f, "i") && val(f, "i", "1") !== "0",
    underline: !!child(f, "u") && val(f, "u", "single") !== "none",
    strike: !!child(f, "strike") && val(f, "strike", "1") !== "0",
    color: color(child(f, "color")),
    vert: val(f, "vertAlign"),
    scheme: val(f, "scheme"),
  };
  const fill = (f, dxf = false) => {
    if (!f) return null;
    const p = child(f, "patternFill");
    if (p) {
      const type = p.attrs.patternType ?? (dxf ? "solid" : "none");
      const fg = color(child(p, "fgColor")), bg = color(child(p, "bgColor"));
      if (type === "none") return null;
      if (type === "solid") return { color: dxf ? (bg ?? fg) : (fg ?? bg ?? "#000000") };
      const k = PATTERN[type] ?? 0.5;
      return { color: mix(bg ?? "#ffffff", fg ?? "#000000", k) };
    }
    const g = child(f, "gradientFill");
    if (g) {
      const stops = kids(g, "stop").map((s) => color(child(s, "color"))).filter(Boolean);
      if (stops.length) return { color: stops.length > 1 ? mix(stops[0], stops[stops.length - 1], 0.5) : stops[0], gradient: stops, degree: Number(g.attrs.degree ?? 0) };
    }
    return null;
  };
  const border = (b) => {
    if (!b) return null;
    const side = (n) => { const s = child(b, n); const style = s?.attrs.style; return style && style !== "none" ? { style, color: color(child(s, "color")) ?? "#000000" } : null; };
    const out = { l: side("left") ?? side("start"), r: side("right") ?? side("end"), t: side("top"), b: side("bottom") };
    return out.l || out.r || out.t || out.b ? out : null;
  };
  const fonts = kids(child(st, "fonts"), "font").map((f) => font(f));
  const fills = kids(child(st, "fills"), "fill").map((f) => fill(f));
  const borders = kids(child(st, "borders"), "border").map(border);
  const baseFont = fonts[0] ?? { name: theme.minorFont, size: 11, bold: false, italic: false, underline: false, strike: false, color: null };
  const xfs = kids(child(st, "cellXfs"), "xf").map((x) => {
    const a = child(x, "alignment")?.attrs ?? {};
    const fontId = Number(x.attrs.fontId ?? 0), fillId = Number(x.attrs.fillId ?? 0), borderId = Number(x.attrs.borderId ?? 0);
    return {
      numFmtId: Number(x.attrs.numFmtId ?? 0),
      fmt: numFmts[x.attrs.numFmtId] ?? null, // null: built-in, resolved by the viewer's number formatter
      font: fonts[fontId] ?? baseFont,
      fill: fills[fillId] ?? null,
      border: borders[borderId] ?? null,
      explicitFont: fontId !== 0,
      explicitFill: fillId > 1,
      explicitBorder: borderId !== 0,
      align: { h: a.horizontal ?? "general", v: a.vertical ?? "bottom", wrap: a.wrapText === "1" || a.wrapText === "true", indent: Number(a.indent ?? 0), rot: Number(a.textRotation ?? 0), shrink: a.shrinkToFit === "1" },
    };
  });
  if (!xfs.length) xfs.push({ numFmtId: 0, fmt: null, font: baseFont, fill: null, border: null, align: { h: "general", v: "bottom", wrap: false, indent: 0, rot: 0 } });
  const dxfs = kids(child(st, "dxfs"), "dxf").map((d) => ({ font: child(d, "font") ? font(child(d, "font")) : null, fill: fill(child(d, "fill"), true), border: border(child(d, "border")), fmt: child(d, "numFmt")?.attrs.formatCode ?? null }));

  // Shared strings, keeping rich-text runs.
  const ssPart = Object.values(wbRels).find((r) => r.type === "sharedStrings");
  const strings = [];
  const ssXml = ssPart ? await text(ssPart.target) : null;
  if (ssXml) {
    // Plain strings by a fast scan; rich ones (runs) through the XML reader.
    const SI = /<si>([\s\S]*?)<\/si>|<si\/>/g;
    let m;
    while ((m = SI.exec(ssXml))) {
      const body = m[1] ?? "";
      const plain = body === "" ? ["", ""] : /^<t(?:\s[^>]*)?>([\s\S]*?)<\/t>$/.exec(body);
      strings.push(plain ? { text: unesc(plain[1]) } : richOf(parseXml("<si>" + body + "</si>"), font, baseFont));
      await tick();
    }
  }

  // Defined names are not needed for display; sheets in tab order.
  const sheets = kids(child(wbXml, "sheets"), "sheet").map((s) => ({
    name: s.attrs.name,
    hidden: s.attrs.state === "hidden" || s.attrs.state === "veryHidden",
    path: wbRels[s.attrs.id ?? s.attrs["r:id"]]?.target,
  }));
  const activeTab = Number(path(wbXml, "bookViews/workbookView")?.attrs.activeTab ?? 0);

  const wb = { sheets, activeTab, date1904, theme, xfs, dxfs, strings, indexed, numFmts, src };
  const loaded = new Map(), loading = new Map();
  const io = { xml, text, relsOf, color, fill, font, baseFont, tick };
  /** The sheet, parsing it the first time (a promise). */
  wb.loadSheet = (i) => {
    if (loaded.has(i)) return Promise.resolve(loaded.get(i));
    if (!loading.has(i)) loading.set(i, readSheet(wb, i, io).then((sh) => { loaded.set(i, sh); return sh; }));
    return loading.get(i);
  };
  /** An already parsed sheet, or null. */
  wb.sheet = (i) => loaded.get(i) ?? null;
  // For formulas and charts that reach into another (parsed) sheet.
  wb.sheetByName = (name) => {
    const i = sheets.findIndex((x) => x.name === name);
    return i < 0 ? null : loaded.get(i) ?? null;
  };
  return wb;
}

function richOf(si, font, baseFont) {
  const runs = kids(si, "r");
  if (!runs.length) return { text: textOf(child(si, "t")) };
  const out = runs.map((r) => ({ text: textOf(child(r, "t")), font: child(r, "rPr") ? { ...baseFont, ...stripNull(font(child(r, "rPr"))) } : null }));
  return { text: out.map((r) => r.text).join(""), runs: out };
}
function stripNull(o) { const out = {}; for (const k in o) if (o[k] !== null && o[k] !== undefined) out[k] = o[k]; return out; }

// ---- one sheet ---------------------------------------------------------------

async function readSheet(wb, index, io) {
  const meta = wb.sheets[index];
  const src = await io.text(meta.path);
  if (!src) throw new Error(`Sheet "${meta.name}" is missing from the file`);
  // sheetData is scanned directly (it is most of the file); the rest goes through the XML tree.
  let head = src, tail = "", data = "";
  const a = src.indexOf("<sheetData");
  if (a >= 0) {
    const open = src.indexOf(">", a);
    head = src.slice(0, a);
    if (src[open - 1] === "/") tail = src.slice(open + 1);
    else {
      const b = src.indexOf("</sheetData>", open);
      data = src.slice(open + 1, b < 0 ? src.length : b);
      tail = b < 0 ? "" : src.slice(b + 12);
    }
  }
  const doc = parseXml(head + "<sheetData/>" + tail) ?? { children: [] };
  const rels = await io.relsOf(meta.path);

  const sheet = {
    name: meta.name, index,
    cells: new Map(), // key -> { r, c, v, f, s, rich }
    maxRow: 0, maxCol: 0,
    colPx: [], colHidden: new Set(), colStyle: new Map(),
    rowPx: new Map(), rowHidden: new Set(), rowStyle: new Map(),
    merges: [], mergeAt: new Map(), mergeCovered: new Set(),
    cf: new Map(), table: new Map(), comments: new Map(), hyperlinks: new Map(),
    drawings: [], filters: [],
    tabColor: io.color(path(doc, "sheetPr/tabColor")),
  };

  // View: gridlines, zoom, frozen panes.
  const view = path(doc, "sheetViews/sheetView");
  const pane = child(view, "pane");
  const frozen = pane && (pane.attrs.state === "frozen" || pane.attrs.state === "frozenSplit");
  sheet.view = {
    grid: view?.attrs.showGridLines !== "0" && view?.attrs.showGridLines !== "false",
    headers: view?.attrs.showRowColHeaders !== "0",
    zoom: Number(view?.attrs.zoomScale ?? 100) / 100,
    rtl: view?.attrs.rightToLeft === "1",
    frozenRows: frozen ? Number(pane.attrs.ySplit ?? 0) : 0,
    frozenCols: frozen ? Number(pane.attrs.xSplit ?? 0) : 0,
    topLeft: parseCell(view?.attrs.topLeftCell ?? "A1"),
  };

  // Default sizes.
  const fmt = child(doc, "sheetFormatPr")?.attrs ?? {};
  sheet.defaultRowPx = Math.round(Number(fmt.defaultRowHeight ?? 15) * PT_PX);
  // baseColWidth 8 (Excel's default, "8.43" visible characters) is drawn 64 px wide.
  sheet.defaultColPx = fmt.defaultColWidth ? widthPx(Number(fmt.defaultColWidth)) : Math.round(Number(fmt.baseColWidth ?? 8) * MDW + 8);
  if (fmt.zeroHeight === "1") sheet.rowsHiddenByDefault = true;
  for (const c of kids(child(doc, "cols"), "col")) {
    const min = Number(c.attrs.min) - 1, max = Math.min(Number(c.attrs.max) - 1, 16383);
    const px = c.attrs.width !== undefined ? widthPx(Number(c.attrs.width)) : sheet.defaultColPx;
    const hidden = c.attrs.hidden === "1" || c.attrs.hidden === "true";
    // A <col> spanning to XFD sets the rest of the sheet: remember it as the default.
    if (max - min > 2000) { sheet.defaultColPx = px; if (c.attrs.style) sheet.defaultColStyle = Number(c.attrs.style); continue; }
    for (let i = min; i <= max; i++) {
      sheet.colPx[i] = px;
      if (hidden) sheet.colHidden.add(i);
      if (c.attrs.style) sheet.colStyle.set(i, Number(c.attrs.style));
    }
  }

  await scanSheetData(data, sheet, wb, io.tick);

  // Dimension may promise more than the data holds; keep the larger.
  const dimRef = child(doc, "dimension")?.attrs.ref;
  const dim = dimRef ? parseRange(dimRef) : null;
  if (dim) { sheet.maxRow = Math.max(sheet.maxRow, dim.r2); sheet.maxCol = Math.max(sheet.maxCol, dim.c2); }

  for (const m of kids(child(doc, "mergeCells"), "mergeCell")) {
    const rg = parseRange(m.attrs.ref ?? "");
    if (!rg) continue;
    sheet.merges.push(rg);
    sheet.mergeAt.set(key(rg.r1, rg.c1), rg);
    for (let r = rg.r1; r <= rg.r2; r++) for (let c = rg.c1; c <= rg.c2; c++) if (r !== rg.r1 || c !== rg.c1) sheet.mergeCovered.add(key(r, c));
    sheet.maxRow = Math.max(sheet.maxRow, rg.r2);
    sheet.maxCol = Math.max(sheet.maxCol, rg.c2);
  }

  for (const h of kids(child(doc, "hyperlinks"), "hyperlink")) {
    const rg = parseRange(h.attrs.ref ?? "");
    const target = rels[h.attrs.id ?? h.attrs["r:id"]]?.target ?? (h.attrs.location ? "#" + h.attrs.location : null);
    if (rg && target) sheet.hyperlinks.set(key(rg.r1, rg.c1), target);
  }

  // Formulas without a cached value (files written by libraries): evaluate what we can.
  await computeMissing(sheet, wb, io.tick);

  // Conditional formatting, Excel tables, then drawings and comments.
  await applyConditionalFormats(sheet, doc, wb, io.tick);
  if (child(doc, "autoFilter")) { const rg = parseRange(child(doc, "autoFilter").attrs.ref ?? ""); if (rg) sheet.filters.push({ r: rg.r1, c1: rg.c1, c2: rg.c2 }); }
  for (const tp of kids(child(doc, "tableParts"), "tablePart")) {
    const rel = rels[tp.attrs.id ?? tp.attrs["r:id"]];
    const t = rel ? await io.xml(rel.target) : null;
    if (t) applyTable(sheet, t, wb);
  }
  for (const rel of Object.values(rels)) {
    if (rel.type === "comments") readComments(sheet, await io.xml(rel.target));
  }
  const drawingId = child(doc, "drawing")?.attrs.id ?? child(doc, "drawing")?.attrs["r:id"];
  if (drawingId && rels[drawingId]) await readDrawing(sheet, rels[drawingId].target, io, wb);
  return sheet;
}

const CELL_RE = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
const ROW_RE = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
const ATTR_RE = /([\w:]+)="([^"]*)"/g;
function attrsOf(s) { const o = {}; let m; ATTR_RE.lastIndex = 0; while ((m = ATTR_RE.exec(s))) o[m[1]] = m[2]; return o; }
const unesc = (s) => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (m, e) => ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" }[e] ?? (e[1] === "x" ? String.fromCodePoint(parseInt(e.slice(2), 16)) : String.fromCodePoint(parseInt(e.slice(1), 10)))));

async function scanSheetData(data, sheet, wb, tick) {
  let m, rowIdx = -1;
  const shared = new Map(); // si -> { f, r, c }
  ROW_RE.lastIndex = 0;
  while ((m = ROW_RE.exec(data))) {
    const ra = attrsOf(m[1]);
    rowIdx = ra.r ? Number(ra.r) - 1 : rowIdx + 1;
    // Excel writes `ht` for rows it auto-fit too; both are the height it draws.
    if (ra.ht) sheet.rowPx.set(rowIdx, Math.round(Number(ra.ht) * PT_PX));
    if (ra.hidden === "1" || ra.hidden === "true") sheet.rowHidden.add(rowIdx);
    if (ra.s && (ra.customFormat === "1" || ra.customFormat === "true")) sheet.rowStyle.set(rowIdx, Number(ra.s));
    sheet.maxRow = Math.max(sheet.maxRow, rowIdx);
    await tick();
    if (!m[2]) continue;
    let colIdx = -1, cm;
    CELL_RE.lastIndex = 0;
    while ((cm = CELL_RE.exec(m[2]))) {
      const ca = attrsOf(cm[1]);
      const ref = ca.r ? /^([A-Z]+)(\d+)$/.exec(ca.r) : null;
      colIdx = ref ? colIndex(ref[1]) : colIdx + 1;
      const r = ref ? Number(ref[2]) - 1 : rowIdx;
      const body = cm[2] ?? "";
      const cell = { r, c: colIdx, s: Number(ca.s ?? 0), v: null };
      const vm = /<v>([\s\S]*?)<\/v>/.exec(body);
      const fm = /<f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/f>)/.exec(body);
      const t = ca.t ?? "n";
      if (vm) {
        const raw = unesc(vm[1]);
        if (t === "s") { const s = wb.strings[Number(raw)]; cell.v = s?.text ?? ""; if (s?.runs) cell.rich = s.runs; }
        else if (t === "b") cell.v = raw === "1";
        else if (t === "e") cell.v = { error: raw };
        else if (t === "str") cell.v = raw;
        else if (t === "d") { const d = Date.parse(raw); cell.v = Number.isFinite(d) ? d / 86400000 + 25569 : raw; }
        else cell.v = Number(raw);
      } else if (t === "inlineStr") {
        const is = /<is>([\s\S]*?)<\/is>/.exec(body);
        if (is) { const si = parseXml("<si>" + is[1] + "</si>"); const rich = richOf(si, () => null, null); cell.v = rich.text; }
      }
      if (fm) {
        const fa = attrsOf(fm[1]);
        const ftext = fm[2] ? unesc(fm[2]) : null;
        if (fa.t === "shared" && fa.si !== undefined) {
          if (ftext) shared.set(fa.si, { f: ftext, r, c: colIdx });
          const master = shared.get(fa.si);
          if (master) { cell.f = master.f; cell.fBase = { r: master.r, c: master.c }; }
        } else if (ftext) cell.f = ftext;
        if (!vm) cell.missing = !!cell.f;
      }
      if (cell.v === null && !cell.f && !cell.s) continue;
      sheet.cells.set(key(r, colIdx), cell);
      if (cell.v !== null || cell.f) { sheet.maxRow = Math.max(sheet.maxRow, r); sheet.maxCol = Math.max(sheet.maxCol, colIdx); }
    }
  }
}

/** Where a sheet's data ends, for formulas over whole columns; null when unknown. */
const boundsOf = (sh) => (sh && Number.isFinite(sh.maxRow) && Number.isFinite(sh.maxCol) ? { maxRow: sh.maxRow, maxCol: sh.maxCol } : null);

function valueGetter(sheet, wb) {
  const busy = new Set();
  const get = (r, c, sheetName) => {
    const sh = sheetName ? wb.sheetByName(sheetName) : sheet;
    if (!sh) return { error: "#REF!" };
    const cell = sh.cells.get(key(r, c));
    if (!cell) return null;
    if (cell.missing && cell.f) {
      const k = sh.index + ":" + key(r, c);
      if (busy.has(k)) return { error: "#REF!" };
      busy.add(k);
      const v = evaluate(cell.f, {
        get: (rr, cc, nm) => (nm ? get(rr, cc, nm) : (sh === sheet ? get(rr, cc) : getIn(sh, rr, cc))),
        bounds: (nm) => boundsOf(nm ? wb.sheetByName(nm) : sh),
      }, cell.fBase ? { r, c, baseR: cell.fBase.r, baseC: cell.fBase.c } : null);
      busy.delete(k);
      if (v !== undefined) { cell.v = v; cell.missing = false; }
      else cell.unknown = true;
    }
    return cell.v;
  };
  const getIn = (sh, r, c) => { const cell = sh.cells.get(key(r, c)); return cell ? cell.v : null; };
  return get;
}

async function computeMissing(sheet, wb, tick) {
  const get = valueGetter(sheet, wb);
  for (const cell of sheet.cells.values()) if (cell.missing) { get(cell.r, cell.c); await tick(); }
}

// ---- conditional formatting ----------------------------------------------------

function numericCells(sheet, ranges) {
  const out = [];
  for (const rg of ranges) for (let r = rg.r1; r <= rg.r2; r++) for (let c = rg.c1; c <= rg.c2; c++) {
    const v = sheet.cells.get(key(r, c))?.v;
    if (typeof v === "number") out.push({ r, c, v });
  }
  return out;
}

/** A rule threshold from its cfvo. `stats` = { min, max, sorted() }: only percentiles need the
 *  values sorted, and sorted() does that once per rule. */
function threshold(cfvo, stats, get) {
  const type = cfvo?.attrs.type ?? "min";
  const v = cfvo?.attrs.val;
  const { min, max } = stats;
  if (type === "min") return min;
  if (type === "max") return max;
  if (type === "num") return Number(v);
  if (type === "percent") return min + ((max - min) * Number(v)) / 100;
  if (type === "percentile") {
    const sorted = stats.sorted();
    const k = (Number(v) / 100) * (sorted.length - 1);
    const lo = Math.floor(k), hi = Math.ceil(k);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (k - lo);
  }
  if (type === "formula") { const x = get(v); return typeof x === "number" ? x : min; }
  return min;
}

function lerpColor(a, b, k) { return mix(a, b, Math.max(0, Math.min(1, k))); }

async function applyConditionalFormats(sheet, doc, wb, tick) {
  const get = valueGetter(sheet, wb);
  const ctx = { get, bounds: (nm) => boundsOf(nm ? wb.sheetByName(nm) : sheet) };
  const blocks = kids(doc, "conditionalFormatting");
  const rules = [];
  for (const b of blocks) {
    // Whole-column rules ("A:A", "A1:A1048576") only matter where there is data.
    const ranges = (b.attrs.sqref ?? "").split(/\s+/)
      .map((x) => parseRange(/^[A-Z]+:[A-Z]+$/i.test(x) ? x.replace(/^([A-Z]+):([A-Z]+)$/i, "$11:$21048576") : x)).filter(Boolean)
      .map((rg) => ({ ...rg, r2: Math.min(rg.r2, sheet.maxRow), c2: Math.min(rg.c2, sheet.maxCol) }))
      .filter((rg) => rg.r1 <= rg.r2 && rg.c1 <= rg.c2);
    for (const rule of kids(b, "cfRule")) rules.push({ ranges, rule, priority: Number(rule.attrs.priority ?? 999) });
  }
  rules.sort((a, b) => a.priority - b.priority);
  const stopped = new Set();
  const put = (r, c, patch) => {
    const k = key(r, c);
    if (stopped.has(k)) return;
    const cur = sheet.cf.get(k) ?? {};
    // Higher priority (earlier) rules win per property.
    for (const p in patch) if (cur[p] === undefined) cur[p] = patch[p];
    sheet.cf.set(k, cur);
  };
  const style = (dxfId) => {
    const d = wb.dxfs[Number(dxfId)];
    if (!d) return {};
    const out = {};
    if (d.fill?.color) out.fill = d.fill.color;
    if (d.font?.color) out.color = d.font.color;
    if (d.font) { if (d.font.bold) out.bold = true; if (d.font.italic) out.italic = true; if (d.font.underline) out.underline = true; if (d.font.strike) out.strike = true; }
    if (d.border) out.border = d.border;
    if (d.fmt) out.fmt = d.fmt;
    return out;
  };
  const evalAt = (formula, rg, r, c) => evaluate(formula, ctx, { r, c, baseR: rg.r1, baseC: rg.c1 });
  for (const { ranges, rule } of rules) {
    const type = rule.attrs.type;
    const stop = rule.attrs.stopIfTrue === "1";
    const cells = [];
    // Ranges can cover a whole sheet (A:Z on 100 000 rows): every loop over them yields now and then.
    let spin = 0;
    for (const rg of ranges) for (let r = rg.r1; r <= rg.r2; r++) {
      for (let c = rg.c1; c <= rg.c2; c++) cells.push({ rg, r, c, v: sheet.cells.get(key(r, c))?.v ?? null });
      if ((++spin & 255) === 0) await tick(true);
    }
    // The numbers, their min and max in the same pass (yielding like the rest), and a sort only
    // when a percentile or a rank needs it: a Float64Array sorts numerically inside the engine,
    // without a JS comparator call per comparison.
    const nums = [];
    let numMin = Infinity, numMax = -Infinity;
    for (const x of cells) {
      if ((++spin & 1023) === 0) await tick(true);
      if (typeof x.v !== "number") continue;
      nums.push(x.v);
      if (x.v < numMin) numMin = x.v;
      if (x.v > numMax) numMax = x.v;
    }
    let sortedOnce = null;
    const stats = { min: numMin, max: numMax, sorted: () => (sortedOnce ??= Float64Array.from(nums).sort()) };
    const hit = (x, patch) => { put(x.r, x.c, patch); if (stop) stopped.add(key(x.r, x.c)); };
    await tick(true);
    if (type === "colorScale") {
      const cs = child(rule, "colorScale");
      const cfvos = kids(cs, "cfvo"), colors = kids(cs, "color").map((e) => resolveColor(e.attrs, wb.theme, wb.indexed));
      if (!nums.length || colors.length < 2) continue;
      const th = cfvos.map((v) => threshold(v, stats, (f) => evaluate(f, ctx)));
      for (const x of cells) {
        if ((++spin & 1023) === 0) await tick(true);
        if (typeof x.v !== "number") continue;
        let col;
        if (colors.length === 2) col = lerpColor(colors[0], colors[1], th[1] === th[0] ? 1 : (x.v - th[0]) / (th[1] - th[0]));
        else col = x.v <= th[1] ? lerpColor(colors[0], colors[1], th[1] === th[0] ? 1 : (x.v - th[0]) / (th[1] - th[0])) : lerpColor(colors[1], colors[2], th[2] === th[1] ? 1 : (x.v - th[1]) / (th[2] - th[1]));
        hit(x, { fill: col });
      }
    } else if (type === "dataBar") {
      const db = child(rule, "dataBar");
      const cfvos = kids(db, "cfvo");
      const col = resolveColor(child(db, "color")?.attrs, wb.theme, wb.indexed) ?? "#638ec6";
      if (!nums.length) continue;
      const lo = threshold(cfvos[0], stats, (f) => evaluate(f, ctx)), hi = threshold(cfvos[1], stats, (f) => evaluate(f, ctx));
      const minLen = Number(db.attrs.minLength ?? 10) / 100, maxLen = Number(db.attrs.maxLength ?? 90) / 100;
      const showValue = db.attrs.showValue !== "0";
      for (const x of cells) {
        if ((++spin & 1023) === 0) await tick(true);
        if (typeof x.v !== "number") continue;
        const k = hi === lo ? 1 : Math.max(0, Math.min(1, (x.v - lo) / (hi - lo)));
        hit(x, { bar: { pct: minLen + (maxLen - minLen) * k, color: col }, hideValue: !showValue });
      }
    } else if (type === "iconSet") {
      const is = child(rule, "iconSet");
      const cfvos = kids(is, "cfvo");
      const set = is?.attrs.iconSet ?? "3TrafficLights1";
      const reverse = is?.attrs.reverse === "1";
      if (!nums.length) continue;
      const th = cfvos.map((v) => threshold(v, stats, (f) => evaluate(f, ctx)));
      const n = th.length;
      for (const x of cells) {
        if ((++spin & 1023) === 0) await tick(true);
        if (typeof x.v !== "number") continue;
        let level = 0;
        for (let i = 1; i < n; i++) if (x.v >= th[i]) level = i;
        if (reverse) level = n - 1 - level;
        hit(x, { icon: { set, level, of: n }, hideValue: is?.attrs.showValue === "0" });
      }
    } else {
      const d = style(rule.attrs.dxfId);
      const fs = kids(rule, "formula").map(textOf);
      // What rank, average and duplicate rules compare against, worked out once per rule: per cell
      // it was O(n²), minutes for a duplicates rule on a few thousand rows in this interpreter.
      let edge = null, avg = 0, sd = 0;
      const counts = new Map();
      if (type === "top10" && nums.length) {
        const rank = Number(rule.attrs.rank ?? 10), pct = rule.attrs.percent === "1", bottom = rule.attrs.bottom === "1";
        const asc = stats.sorted(), n = Math.min(pct ? Math.max(1, Math.floor((asc.length * rank) / 100)) : rank, asc.length);
        // The n-th largest (top) or n-th smallest (bottom) value.
        edge = n > 0 ? (bottom ? asc[n - 1] : asc[asc.length - n]) : null;
      } else if (type === "aboveAverage" && nums.length) {
        avg = nums.reduce((s, q) => s + q, 0) / nums.length;
        sd = rule.attrs.stdDev ? Math.sqrt(nums.reduce((s, q) => s + (q - avg) ** 2, 0) / nums.length) * Number(rule.attrs.stdDev) : 0;
      } else if (type === "duplicateValues" || type === "uniqueValues") {
        for (const y of cells) {
          if ((++spin & 1023) === 0) await tick(true);
          if (y.v === null) continue;
          const k = String(y.v).toLowerCase();
          counts.set(k, (counts.get(k) ?? 0) + 1);
        }
      }
      for (const x of cells) {
        let ok = false;
        const v = x.v;
        if (type === "cellIs") {
          const a = evalAt(fs[0] ?? "", x.rg, x.r, x.c), b = fs[1] !== undefined ? evalAt(fs[1], x.rg, x.r, x.c) : undefined;
          const op = rule.attrs.operator;
          if (v === null || v === undefined || v === "") { ok = false; }
          else {
            const cmp = (p, q) => (typeof p === "number" && typeof q === "number" ? p - q : String(p).toLowerCase().localeCompare(String(q).toLowerCase()));
            if (op === "lessThan") ok = cmp(v, a) < 0;
            else if (op === "lessThanOrEqual") ok = cmp(v, a) <= 0;
            else if (op === "greaterThan") ok = cmp(v, a) > 0;
            else if (op === "greaterThanOrEqual") ok = cmp(v, a) >= 0;
            else if (op === "equal") ok = cmp(v, a) === 0;
            else if (op === "notEqual") ok = cmp(v, a) !== 0;
            else if (op === "between") ok = cmp(v, Math.min(a, b)) >= 0 && cmp(v, Math.max(a, b)) <= 0;
            else if (op === "notBetween") ok = !(cmp(v, Math.min(a, b)) >= 0 && cmp(v, Math.max(a, b)) <= 0);
          }
        } else if (type === "expression") {
          const res = evalAt(fs[0] ?? "", x.rg, x.r, x.c);
          ok = res === true || (typeof res === "number" && res !== 0);
        } else if (type === "containsText" || type === "notContainsText" || type === "beginsWith" || type === "endsWith") {
          const needle = String(rule.attrs.text ?? "").toLowerCase(), s = String(v ?? "").toLowerCase();
          ok = type === "containsText" ? s.includes(needle) : type === "notContainsText" ? !s.includes(needle) : type === "beginsWith" ? s.startsWith(needle) : s.endsWith(needle);
        } else if (type === "containsBlanks") ok = v === null || String(v).trim() === "";
        else if (type === "notContainsBlanks") ok = !(v === null || String(v).trim() === "");
        else if (type === "containsErrors") ok = v && typeof v === "object" && "error" in v;
        else if (type === "notContainsErrors") ok = !(v && typeof v === "object" && "error" in v);
        else if (type === "top10") {
          const bottom = rule.attrs.bottom === "1";
          ok = typeof v === "number" && edge !== null && (bottom ? v <= edge : v >= edge);
        } else if (type === "aboveAverage") {
          if (typeof v !== "number" || !nums.length) ok = false;
          else {
            const above = rule.attrs.aboveAverage !== "0", eq = rule.attrs.equalAverage === "1";
            ok = above ? (eq ? v >= avg + sd : v > avg + sd) : (eq ? v <= avg - sd : v < avg - sd);
          }
        } else if (type === "duplicateValues" || type === "uniqueValues") {
          const count = v === null ? 0 : counts.get(String(v).toLowerCase()) ?? 0;
          ok = v !== null && v !== "" && (type === "duplicateValues" ? count > 1 : count === 1);
        } else if (type === "timePeriod") ok = false;
        if (ok) hit(x, d);
        await tick();
      }
    }
  }
}

// ---- Excel tables (ListObjects) ------------------------------------------------

// Built-in table styles, approximated from their family and accent.
function tableLook(name, theme) {
  const m = /^TableStyle(Light|Medium|Dark)(\d+)$/.exec(name ?? "");
  if (!m) return null;
  const fam = m[1], n = Number(m[2]);
  const slot = (n - 1) % 7; // 0 = dark/neutral, 1..6 = accent1..6
  const base = slot === 0 ? "#000000" : theme["accent" + slot];
  const lite = (k) => (slot === 0 ? applyTint("#808080", k) : applyTint(base, k));
  const group = Math.floor((n - 1) / 7); // style group inside the family
  if (fam === "Light") {
    if (group === 0) return { header: { bold: true, borderB: base }, band: lite(0.8), edges: base };
    if (group === 1) return { header: { fill: base, color: "#ffffff", bold: true }, band: null, edges: base, grid: base };
    return { header: { bold: true, borderB: base }, band: lite(0.8), grid: lite(0.4) };
  }
  if (fam === "Medium") {
    if (group === 0) return { header: { fill: base, color: "#ffffff", bold: true }, band: lite(0.8), inner: lite(0.6) };
    if (group === 1) return { header: { fill: base, color: "#ffffff", bold: true }, band: lite(0.6), band2: lite(0.8) };
    if (group === 2) return { header: { fill: "#000000", color: "#ffffff", bold: true }, band: lite(0.8), band2: lite(0.9) };
    return { header: { fill: lite(0.4), bold: true }, band: lite(0.8), grid: lite(0.4) };
  }
  // Dark
  const dark = slot === 0 ? "#404040" : applyTint(base, -0.25);
  return { header: { fill: "#000000", color: "#ffffff", bold: true }, band: dark, band2: slot === 0 ? "#595959" : base, text: "#ffffff" };
}

function applyTable(sheet, t, wb) {
  const rg = parseRange(t.attrs.ref ?? "");
  if (!rg) return;
  const info = child(t, "tableStyleInfo")?.attrs ?? {};
  const look = tableLook(info.name ?? "TableStyleMedium2", wb.theme);
  const headerRows = Number(t.attrs.headerRowCount ?? 1);
  const totals = Number(t.attrs.totalsRowCount ?? 0);
  const stripes = info.showRowStripes !== "0";
  if (headerRows && child(t, "autoFilter")) sheet.filters.push({ r: rg.r1, c1: rg.c1, c2: rg.c2 });
  if (!look) return;
  for (let r = rg.r1; r <= rg.r2; r++) {
    const isHeader = r < rg.r1 + headerRows;
    const isTotal = totals && r > rg.r2 - totals;
    const bodyIdx = r - rg.r1 - headerRows;
    for (let c = rg.c1; c <= rg.c2; c++) {
      const s = {};
      if (isHeader) {
        if (look.header.fill) s.fill = look.header.fill;
        if (look.header.color) s.color = look.header.color;
        if (look.header.bold) s.bold = true;
        if (look.header.borderB) s.border = { b: { style: "thin", color: look.header.borderB } };
      } else if (isTotal) {
        s.bold = true;
        s.border = { t: { style: "double", color: look.edges ?? look.inner ?? "#000000" } };
      } else {
        if (stripes && bodyIdx % 2 === 0 && look.band) s.fill = look.band;
        else if (stripes && look.band2) s.fill = look.band2;
        if (look.text) s.color = look.text;
        if (look.grid) s.border = { l: { style: "thin", color: look.grid }, r: { style: "thin", color: look.grid }, t: { style: "thin", color: look.grid }, b: { style: "thin", color: look.grid } };
        else if (look.inner) s.border = { t: { style: "thin", color: look.inner } };
      }
      if (look.edges && (r === rg.r2)) s.border = { ...(s.border ?? {}), b: { style: "thin", color: look.edges } };
      sheet.table.set(key(r, c), s);
    }
  }
}

function readComments(sheet, doc) {
  if (!doc) return;
  for (const c of all(doc, "comment")) {
    const p = parseCell(c.attrs.ref ?? "");
    if (p) sheet.comments.set(key(p.r, p.c), textOf(child(c, "text")).trim());
  }
}

// ---- drawings: pictures, charts, shapes ------------------------------------------

/** Sheet x of a column edge (px at 100%, hidden columns are 0 wide). */
export function colX(sheet, c) {
  if (!sheet._colX) sheet._colX = [0];
  const xs = sheet._colX;
  for (let i = xs.length - 1; i < c; i++) xs.push(xs[i] + colWidth(sheet, i));
  return xs[c];
}
export function rowY(sheet, r) {
  if (!sheet._rowY) sheet._rowY = [0];
  const ys = sheet._rowY;
  for (let i = ys.length - 1; i < r; i++) ys.push(ys[i] + rowHeight(sheet, i));
  return ys[r];
}
export function colWidth(sheet, c) { return sheet.colHidden.has(c) ? 0 : (sheet.colPx[c] ?? sheet.defaultColPx); }
export function rowHeight(sheet, r) { return sheet.rowHidden.has(r) || (sheet.rowsHiddenByDefault && !sheet.rowPx.has(r)) ? 0 : (sheet.rowPx.get(r) ?? sheet.defaultRowPx); }

function anchorBox(sheet, a) {
  const pt = (el) => ({ c: Number(textOf(child(el, "col"))), co: Number(textOf(child(el, "colOff"))) / EMU_PER_PX, r: Number(textOf(child(el, "row"))), ro: Number(textOf(child(el, "rowOff"))) / EMU_PER_PX });
  if (a.name === "absoluteAnchor") {
    const pos = child(a, "pos")?.attrs ?? {}, ext = child(a, "ext")?.attrs ?? {};
    return { x: Number(pos.x ?? 0) / EMU_PER_PX, y: Number(pos.y ?? 0) / EMU_PER_PX, w: Number(ext.cx ?? 0) / EMU_PER_PX, h: Number(ext.cy ?? 0) / EMU_PER_PX };
  }
  const f = pt(child(a, "from"));
  const x = colX(sheet, f.c) + f.co, y = rowY(sheet, f.r) + f.ro;
  if (a.name === "oneCellAnchor") {
    const ext = child(a, "ext")?.attrs ?? {};
    return { x, y, w: Number(ext.cx ?? 0) / EMU_PER_PX, h: Number(ext.cy ?? 0) / EMU_PER_PX, row: f.r, col: f.c };
  }
  const t = pt(child(a, "to"));
  return { x, y, w: colX(sheet, t.c) + t.co - x, h: rowY(sheet, t.r) + t.ro - y, row: f.r, col: f.c };
}

function shapeFill(spPr, wb) {
  if (!spPr) return { fill: null, line: null };
  const solid = (el) => {
    const c = el && (child(el, "srgbClr") ?? child(el, "schemeClr") ?? child(el, "sysClr") ?? child(el, "prstClr"));
    if (!c) return null;
    let hex = c.name === "srgbClr" ? "#" + (c.attrs.val ?? "000000").toLowerCase() : c.name === "sysClr" ? "#" + (c.attrs.lastClr ?? "000000").toLowerCase() : c.name === "schemeClr" ? (wb.theme[{ tx1: "dk1", bg1: "lt1", tx2: "dk2", bg2: "lt2" }[c.attrs.val] ?? c.attrs.val] ?? "#000000") : "#000000";
    const lm = child(c, "lumMod")?.attrs.val, lo = child(c, "lumOff")?.attrs.val;
    if (lm) hex = applyTint(hex, Number(lm) / 100000 - 1);
    if (lo) hex = applyTint(hex, Number(lo) / 100000);
    const t = child(c, "tint")?.attrs.val, s = child(c, "shade")?.attrs.val;
    if (t) hex = mix("#ffffff", hex, Number(t) / 100000);
    if (s) hex = mix("#000000", hex, Number(s) / 100000);
    return hex;
  };
  const ln = child(spPr, "ln");
  return {
    fill: child(spPr, "noFill") ? null : solid(child(spPr, "solidFill")),
    line: ln && !child(ln, "noFill") ? { color: solid(child(ln, "solidFill")) ?? "#000000", w: Math.max(1, Number(ln.attrs.w ?? 9525) / EMU_PER_PX) } : null,
  };
}

async function readDrawing(sheet, dpath, io, wb) {
  const doc = await io.xml(dpath);
  if (!doc) return;
  const rels = await io.relsOf(dpath);
  // Chart parts are read now, so drawing them needs nothing asynchronous.
  const pending = [];
  for (const a of doc.children) {
    if (!["twoCellAnchor", "oneCellAnchor", "absoluteAnchor"].includes(a.name)) continue;
    const box = anchorBox(sheet, a);
    const add = (el, b) => {
      if (el.name === "pic") {
        const blip = all(el, "blip")[0];
        const rel = rels[blip?.attrs.embed ?? blip?.attrs["r:embed"]];
        if (rel && !rel.external) sheet.drawings.push({ kind: "image", ...b, media: rel.target, name: path(el, "nvPicPr/cNvPr")?.attrs.name });
      } else if (el.name === "graphicFrame") {
        const ch = all(el, "chart")[0];
        const rel = ch && rels[ch.attrs.id ?? ch.attrs["r:id"]];
        if (rel) { const d = { kind: "chart", ...b, chart: rel.target, xml: null }; sheet.drawings.push(d); pending.push(io.text(rel.target).then((x) => { d.xml = x; })); }
      } else if (el.name === "sp" || el.name === "cxnSp") {
        const spPr = child(el, "spPr");
        const geom = path(spPr, "prstGeom")?.attrs.prst ?? "rect";
        const { fill, line } = shapeFill(spPr, wb);
        const paras = kids(child(el, "txBody"), "p").map((p) => kids(p, "r").map((r) => textOf(child(r, "t"))).join(""));
        const algn = path(child(el, "txBody"), "p/pPr")?.attrs.algn;
        const sz = Number(all(el, "rPr")[0]?.attrs.sz ?? 1100) / 100;
        const tcolor = all(el, "rPr").map((r) => child(r, "solidFill")).find(Boolean);
        sheet.drawings.push({ kind: "shape", ...b, geom, fill, line, text: paras.join("\n"), align: algn, size: sz, color: tcolor ? shapeFill({ name: "spPr", attrs: {}, children: [tcolor], text: "" }, wb).fill : null, connector: el.name === "cxnSp" });
      } else if (el.name === "grpSp") {
        const x = path(el, "grpSpPr/xfrm");
        const off = child(x, "off")?.attrs, ext = child(x, "ext")?.attrs, cOff = child(x, "chOff")?.attrs, cExt = child(x, "chExt")?.attrs;
        for (const kid of el.children) {
          const kx = path(kid, "spPr/xfrm") ?? path(kid, "xfrm") ?? path(kid, "grpSpPr/xfrm");
          const ko = child(kx, "off")?.attrs, ke = child(kx, "ext")?.attrs;
          if (!ko || !ke || !cExt || !cOff) { add(kid, b); continue; }
          const sx = b.w / (Number(cExt.cx) || 1), sy = b.h / (Number(cExt.cy) || 1);
          add(kid, { x: b.x + (Number(ko.x) - Number(cOff.x)) * sx, y: b.y + (Number(ko.y) - Number(cOff.y)) * sy, w: Number(ke.cx) * sx, h: Number(ke.cy) * sy });
        }
        void off; void ext;
      }
    };
    for (const el of a.children) add(el, box);
  }
  await Promise.all(pending);
  sheet.drawings = sheet.drawings.filter((d) => d.kind !== "chart" || d.xml);
}
