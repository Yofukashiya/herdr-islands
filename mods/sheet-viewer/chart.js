// DrawingML chart engine: xl/charts/chartN.xml -> plain JSON model -> drawing primitives.
//
//   parseChart(xmlString)      -> model (JSON-able; colours stay unresolved theme references)
//   renderChart(model, ctx)    -> { items: Primitive[] }   (painter's order, px, origin top-left)
//   resolveRefs(model, lookup) -> model with empty caches filled from cells (optional helper)
//
// Pure computation (ES2020): no DOM, no Intl, no Node APIs. Only ./xml.js is imported.
//
// Absent boolean elements follow the OOXML defaults Excel applies to files that were not
// written by Excel 2007 (Excel itself always writes them): e.g. a missing <c:delete> hides an
// axis, a missing <c:roundedCorners> rounds the chart box, a missing <c:smooth> smooths a
// line series, and missing show* flags inside <c:dLbls> are on.

import { parseXml, child, kids, textOf } from "./xml.js";

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

const PX_PER_PT = 96 / 72;
const EMU_PER_PX = 9525; // 12700 EMU per pt * 72/96
const PAD = 9; // chart area inner padding
const TICK = 4; // major tick length
const MINOR_TICK = 2;
const TAU = Math.PI * 2;
const SEG = (3 * Math.PI) / 180; // max arc segment

const DEFAULT_THEME = {
  dk1: "#000000", lt1: "#ffffff", dk2: "#44546a", lt2: "#e7e6e6",
  accent1: "#4472c4", accent2: "#ed7d31", accent3: "#a5a5a5", accent4: "#ffc000",
  accent5: "#5b9bd5", accent6: "#70ad47", hlink: "#0563c1", folHlink: "#954f72",
};

const SCHEME_ALIAS = { bg1: "lt1", tx1: "dk1", bg2: "lt2", tx2: "dk2", dark1: "dk1", light1: "lt1", dark2: "dk2", light2: "lt2" };

const SYS_COLORS = {
  windowText: "000000", window: "ffffff", menuText: "000000", menu: "f0f0f0", btnFace: "f0f0f0",
  btnText: "000000", highlight: "0078d7", highlightText: "ffffff", grayText: "6d6d6d", captionText: "000000",
  windowFrame: "646464", btnShadow: "a0a0a0", btnHighlight: "ffffff", infoText: "000000", infoBk: "ffffe1",
  "3dDkShadow": "696969", "3dLight": "e3e3e3", activeBorder: "b4b4b4", inactiveBorder: "f4f7fc",
  appWorkspace: "ababab", background: "000000", scrollBar: "c8c8c8",
};

const PRESET_COLORS = {
  black: "000000", white: "ffffff", red: "ff0000", green: "008000", blue: "0000ff", yellow: "ffff00",
  cyan: "00ffff", magenta: "ff00ff", gray: "808080", grey: "808080", silver: "c0c0c0", maroon: "800000",
  olive: "808000", lime: "00ff00", aqua: "00ffff", teal: "008080", navy: "000080", purple: "800080",
  fuchsia: "ff00ff", orange: "ffa500", pink: "ffc0cb", brown: "a52a2a", gold: "ffd700", indigo: "4b0082",
  violet: "ee82ee", tan: "d2b48c", beige: "f5f5dc", coral: "ff7f50", crimson: "dc143c", khaki: "f0e68c",
  lavender: "e6e6fa", salmon: "fa8072", turquoise: "40e0d0", orchid: "da70d6", plum: "dda0dd",
  chocolate: "d2691e", tomato: "ff6347", wheat: "f5deb3", ivory: "fffff0", azure: "f0ffff", snow: "fffafa",
  ltGray: "d3d3d3", lightGray: "d3d3d3", dkGray: "a9a9a9", darkGray: "a9a9a9", dkBlue: "00008b",
  darkBlue: "00008b", dkRed: "8b0000", darkRed: "8b0000", dkGreen: "006400", darkGreen: "006400",
  ltBlue: "add8e6", lightBlue: "add8e6", ltGreen: "90ee90", lightGreen: "90ee90", ltYellow: "ffffe0",
  lightYellow: "ffffe0", skyBlue: "87ceeb", steelBlue: "4682b4", royalBlue: "4169e1", slateGray: "708090",
  dimGray: "696969", forestGreen: "228b22", seaGreen: "2e8b57", firebrick: "b22222", darkOrange: "ff8c00",
  hotPink: "ff69b4", deepPink: "ff1493", deepSkyBlue: "00bfff", dodgerBlue: "1e90ff", limeGreen: "32cd32",
  yellowGreen: "9acd32", goldenrod: "daa520", sienna: "a0522d", peru: "cd853f", midnightBlue: "191970",
};

// Excel's automatic palette: accent1..6, then the same accents through these modifier sets.
const PALETTE_VARIANTS = [
  [],
  [["lumMod", 60000]],
  [["lumMod", 80000], ["lumOff", 20000]],
  [["lumMod", 80000]],
  [["lumMod", 60000], ["lumOff", 40000]],
  [["lumMod", 50000]],
  [["lumMod", 70000], ["lumOff", 30000]],
  [["lumMod", 70000]],
  [["lumMod", 50000], ["lumOff", 50000]],
];

const AUTO_MARKERS = ["diamond", "square", "triangle", "x", "star", "circle", "plus", "dash", "dot"];

const DASHES = {
  solid: null, dot: [1, 3], dash: [4, 3], lgDash: [8, 3], dashDot: [4, 3, 1, 3], lgDashDot: [8, 3, 1, 3],
  lgDashDotDot: [8, 3, 1, 3, 1, 3], sysDash: [3, 1], sysDot: [1, 1], sysDashDot: [3, 1, 1, 1],
  sysDashDotDot: [3, 1, 1, 1, 1, 1],
};

const TEXT_KINDS = {
  title: { size: 14, color: "#595959", rel: 1.4 },
  axisTitle: { size: 10, color: "#595959", rel: 1.1 },
  axis: { size: 9, color: "#595959", rel: 1 },
  legend: { size: 9, color: "#595959", rel: 1 },
  label: { size: 9, color: "#404040", rel: 1 },
};

const GROUP_TYPES = {
  barChart: "bar", bar3DChart: "bar", lineChart: "line", line3DChart: "line", stockChart: "line",
  areaChart: "area", area3DChart: "area", pieChart: "pie", pie3DChart: "pie", ofPieChart: "pie",
  doughnutChart: "doughnut", scatterChart: "scatter", radarChart: "radar", bubbleChart: "bubble",
  surfaceChart: "surface", surface3DChart: "surface",
};

// Drawing / legend order of chart groups (Excel: area, bar, line, xy).
const GROUP_RANK = { area: 0, pie: 0, doughnut: 0, bar: 1, radar: 2, line: 2, scatter: 3, bubble: 3, surface: 4 };

const BUILTIN_UNITS = {
  hundreds: [100, "Hundreds"], thousands: [1e3, "Thousands"], tenThousands: [1e4, "x 10000"],
  hundredThousands: [1e5, "x 100000"], millions: [1e6, "Millions"], tenMillions: [1e7, "x 10000000"],
  hundredMillions: [1e8, "x 100000000"], billions: [1e9, "Billions"], trillions: [1e12, "Trillions"],
};

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

const num = (s, d = null) => {
  if (s == null || s === "") return d;
  const n = Number(String(s).trim());
  return Number.isFinite(n) ? n : d;
};
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const r2 = (v) => Math.round(v * 100) / 100;
const clean = (v) => (Math.abs(v) < 1e-12 ? 0 : parseFloat(v.toPrecision(12)));
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/** `<x val=".."/>` raw value; undefined when the element is absent, null when it has no val. */
function cval(el, name) {
  const c = child(el, name);
  if (!c) return undefined;
  return c.attrs.val !== undefined ? c.attrs.val : null;
}
function cnum(el, name, d = null) {
  const v = cval(el, name);
  return v == null ? d : num(String(v).replace("%", ""), d);
}
/** CT_Boolean: absent -> dflt; present without val -> true. */
function cbool(el, name, dflt) {
  const c = child(el, name);
  if (!c) return dflt;
  const v = c.attrs.val;
  return v === undefined ? true : v === "1" || v === "true" || v === "on";
}

/** Replaces mc:AlternateContent by its Fallback (else Choice) content, recursively. */
function unwrapAlternate(el) {
  const out = [];
  for (const c of el.children) {
    if (c.name === "AlternateContent") {
      const pick = child(c, "Fallback") || child(c, "Choice");
      if (pick) for (const x of pick.children) { unwrapAlternate(x); out.push(x); }
    } else {
      unwrapAlternate(c);
      out.push(c);
    }
  }
  el.children = out;
}

// ---------------------------------------------------------------------------------------------
// Parsing: colours, fills, lines, text
// ---------------------------------------------------------------------------------------------

const COLOR_TAGS = new Set(["srgbClr", "schemeClr", "sysClr", "prstClr", "hslClr", "scrgbClr"]);

function parseColorEl(c) {
  const m = c.children.map((x) => [x.name, num(x.attrs.val, 0)]);
  const a = c.attrs;
  switch (c.name) {
    case "srgbClr": return { k: "rgb", v: "#" + normHex(a.val), m };
    case "schemeClr": return { k: "scheme", v: a.val || "accent1", m };
    case "sysClr": return { k: "rgb", v: "#" + normHex(a.lastClr || SYS_COLORS[a.val] || "000000"), m };
    case "prstClr": return { k: "rgb", v: "#" + (PRESET_COLORS[a.val] || "000000"), m };
    case "hslClr": {
      const rgb = hslToRgb((num(a.hue, 0) / 60000 / 360) % 1, num(a.sat, 0) / 100000, num(a.lum, 0) / 100000);
      return { k: "rgb", v: rgbToHex(rgb), m };
    }
    case "scrgbClr": {
      const rgb = [a.r, a.g, a.b].map((x) => linToSrgb(clamp(num(x, 0) / 100000, 0, 1)));
      return { k: "rgb", v: rgbToHex(rgb), m };
    }
  }
  return null;
}

function normHex(s) {
  s = String(s || "000000").replace(/^#/, "").toLowerCase();
  if (s.length === 3) s = s.split("").map((c) => c + c).join("");
  if (s.length === 8) s = s.slice(2);
  return /^[0-9a-f]{6}$/.test(s) ? s : "000000";
}

/** First colour element child of el. */
function parseColor(el) {
  if (!el) return undefined;
  for (const c of el.children) if (COLOR_TAGS.has(c.name)) return parseColorEl(c);
  return undefined;
}

/** Fill of a spPr / ln / rPr: undefined = not specified (automatic), null = noFill, else colour spec. */
function parseFill(el) {
  if (!el) return undefined;
  for (const c of el.children) {
    switch (c.name) {
      case "noFill": return null;
      case "solidFill": return parseColor(c);
      case "gradFill": {
        const stops = kids(child(c, "gsLst"), "gs")
          .map((g) => ({ pos: num(g.attrs.pos, 0) / 100000, c: parseColor(g) }))
          .filter((s) => s.c);
        if (!stops.length) return undefined;
        stops.sort((a, b) => a.pos - b.pos);
        return { k: "grad", stops };
      }
      case "pattFill": return parseColor(child(c, "fgClr"));
      default: break;
    }
  }
  return undefined;
}

function parseSpPr(el) {
  if (!el) return null;
  const sp = {};
  const f = parseFill(el);
  if (f !== undefined) sp.fill = f;
  const ln = child(el, "ln");
  if (ln) {
    const L = {};
    const lf = parseFill(ln);
    if (lf !== undefined) L.fill = lf;
    if (ln.attrs.w != null) L.w = num(ln.attrs.w, 0) / EMU_PER_PX;
    const d = child(ln, "prstDash");
    if (d && d.attrs.val) L.dash = d.attrs.val;
    const cd = child(ln, "custDash");
    if (cd) {
      const ds = [];
      for (const s of kids(cd, "ds")) ds.push(num(s.attrs.d, 100000) / 100000, num(s.attrs.sp, 100000) / 100000);
      if (ds.length) L.dash = ds;
    }
    sp.ln = L;
  }
  return sp;
}

/** Run properties (a:rPr / a:defRPr): size in pt, bold, italic, colour. Only defined keys are set. */
function parseRunProps(r) {
  const o = {};
  if (!r) return o;
  if (r.attrs.sz != null) o.size = num(r.attrs.sz, 1000) / 100;
  if (r.attrs.b != null) o.bold = r.attrs.b === "1" || r.attrs.b === "true";
  if (r.attrs.i != null) o.italic = r.attrs.i === "1" || r.attrs.i === "true";
  const f = parseFill(r);
  if (f) o.color = f;
  return o;
}

function parseBodyRot(body, o) {
  if (!body) return o;
  if (body.attrs.rot != null) {
    const deg = num(body.attrs.rot, 0) / 60000;
    if (Math.abs(deg) <= 90) o.rot = deg <= -45 ? -90 : deg >= 45 ? -90 : 0;
  }
  const v = body.attrs.vert;
  if (v === "vert" || v === "vert270" || v === "eaVert" || v === "wordArtVert") o.rot = -90;
  return o;
}

/** c:txPr -> { size, bold, italic, color, rot } (defined keys only). */
function parseTxPr(el) {
  if (!el) return null;
  const o = parseRunProps(firstDefRPr(el));
  return parseBodyRot(child(el, "bodyPr"), o);
}

function firstDefRPr(el) {
  for (const p of kids(el, "p")) {
    const d = child(child(p, "pPr"), "defRPr");
    if (d) return d;
  }
  return null;
}

/** c:rich -> { base: txProps, lines: [[{text, ...runProps}]] } */
function parseRich(rich) {
  const base = parseBodyRot(child(rich, "bodyPr"), parseRunProps(firstDefRPr(rich)));
  const lines = [];
  for (const p of kids(rich, "p")) {
    const pdef = parseRunProps(child(child(p, "pPr"), "defRPr"));
    let line = [];
    for (const c of p.children) {
      if (c.name === "r" || c.name === "fld") {
        line.push({ text: textOf(child(c, "t")), ...pdef, ...parseRunProps(child(c, "rPr")) });
      } else if (c.name === "br") {
        lines.push(line);
        line = [];
      }
    }
    lines.push(line);
  }
  while (lines.length && !lines[lines.length - 1].some((r) => r.text)) lines.pop();
  return { base, lines };
}

function parseLayout(el) {
  const m = child(el, "manualLayout");
  if (!m) return null;
  const o = {
    target: cval(m, "layoutTarget") || "outer",
    xMode: cval(m, "xMode") || "factor", yMode: cval(m, "yMode") || "factor",
    wMode: cval(m, "wMode") || "factor", hMode: cval(m, "hMode") || "factor",
    x: cnum(m, "x"), y: cnum(m, "y"), w: cnum(m, "w"), h: cnum(m, "h"),
  };
  return o.x == null && o.y == null && o.w == null && o.h == null ? null : o;
}

// ---------------------------------------------------------------------------------------------
// Parsing: data, series, groups, axes
// ---------------------------------------------------------------------------------------------

function readCache(cache, isNumber) {
  const n = cnum(cache, "ptCount", 0) || 0;
  const v = new Array(n).fill(null);
  for (const pt of kids(cache, "pt")) {
    const idx = num(pt.attrs.idx, -1);
    if (idx < 0 || idx > 100000) continue;
    const raw = textOf(child(pt, "v"));
    while (v.length <= idx) v.push(null);
    v[idx] = isNumber ? num(raw, null) : raw;
  }
  const fc = child(cache, "formatCode");
  return { v, fmt: fc ? textOf(fc) : null };
}

/** cat/val/xVal/yVal/bubbleSize/tx -> { ref, num, fmt, v: [...] } */
function parseData(el) {
  if (!el) return null;
  for (const c of el.children) {
    const ref = textOf(child(c, "f")) || null;
    switch (c.name) {
      case "numRef": case "numLit": {
        const cache = c.name === "numLit" ? c : child(c, "numCache");
        const r = cache ? readCache(cache, true) : { v: [], fmt: null };
        return { ref, num: true, fmt: r.fmt || "General", v: r.v };
      }
      case "strRef": case "strLit": {
        const cache = c.name === "strLit" ? c : child(c, "strCache");
        const r = cache ? readCache(cache, false) : { v: [] };
        return { ref, num: false, fmt: null, v: r.v };
      }
      case "multiLvlStrRef": {
        const cache = child(c, "multiLvlStrCache");
        const n = cnum(cache, "ptCount", 0) || 0;
        const lv = kids(cache, "lvl");
        const r = lv.length ? readCache(lv[0], false) : { v: [] };
        while (r.v.length < n) r.v.push(null);
        return { ref, num: false, fmt: null, v: r.v, levels: lv.length };
      }
      default: break;
    }
  }
  return null;
}

const SHOW_FLAGS = [["val", "showVal"], ["pct", "showPercent"], ["cat", "showCatName"], ["ser", "showSerName"], ["key", "showLegendKey"], ["bub", "showBubbleSize"]];

function parseDLblBody(el) {
  const o = {};
  if (cbool(el, "delete", false)) { o.del = true; return o; }
  for (const [k, tag] of SHOW_FLAGS) {
    const v = cbool(el, tag, undefined);
    if (v !== undefined) o[k] = v;
  }
  const pos = cval(el, "dLblPos");
  if (pos) o.pos = pos;
  const nf = child(el, "numFmt");
  if (nf) o.numFmt = { code: nf.attrs.formatCode || "General", linked: nf.attrs.sourceLinked === "1" || nf.attrs.sourceLinked === "true" };
  const sep = child(el, "separator");
  if (sep) o.sep = sep.attrs.val !== undefined ? sep.attrs.val : textOf(sep);
  const sp = parseSpPr(child(el, "spPr"));
  if (sp) o.sp = sp;
  const tx = parseTxPr(child(el, "txPr"));
  if (tx) o.tx = tx;
  const t = child(el, "tx");
  if (t) {
    const rich = child(t, "rich");
    if (rich) {
      const r = parseRich(rich);
      o.text = r.lines.map((l) => l.map((x) => x.text).join("")).join("\n");
      if (!o.tx) o.tx = r.base;
    } else {
      const d = parseData(t);
      if (d) o.text = d.v.filter((x) => x != null).join(" ");
    }
  }
  return o;
}

function parseDLbls(el) {
  if (!el) return null;
  const o = parseDLblBody(el);
  const pts = {};
  let any = false;
  for (const d of kids(el, "dLbl")) {
    const idx = cnum(d, "idx", null);
    if (idx == null) continue;
    pts[idx] = parseDLblBody(d);
    any = true;
  }
  if (any) o.points = pts;
  return o;
}

function parseMarker(el) {
  if (!el) return null;
  const o = {};
  const sym = cval(el, "symbol");
  if (sym) o.symbol = sym;
  const size = cnum(el, "size", null);
  if (size != null) o.size = clamp(size, 2, 72);
  const sp = parseSpPr(child(el, "spPr"));
  if (sp) o.sp = sp;
  return o;
}

function parseSeries(el, idxDefault) {
  const idx = cnum(el, "idx", idxDefault);
  const s = { idx, order: cnum(el, "order", idx) };
  const tx = child(el, "tx");
  if (tx) {
    const v = child(tx, "v");
    if (v) s.name = textOf(v);
    else {
      const d = parseData(tx);
      if (d) {
        s.nameRef = d.ref;
        const parts = d.v.filter((x) => x != null && x !== "");
        if (parts.length) s.name = parts.join(" ");
      }
    }
  }
  const sp = parseSpPr(child(el, "spPr"));
  if (sp) s.sp = sp;
  const mk = parseMarker(child(el, "marker"));
  if (mk) s.marker = mk;
  const pts = {};
  let anyPt = false;
  for (const d of kids(el, "dPt")) {
    const i = cnum(d, "idx", null);
    if (i == null) continue;
    const p = {};
    const psp = parseSpPr(child(d, "spPr"));
    if (psp) p.sp = psp;
    const pm = parseMarker(child(d, "marker"));
    if (pm) p.marker = pm;
    const ex = cnum(d, "explosion", null);
    if (ex != null) p.explosion = ex;
    const inv = cbool(d, "invertIfNegative", undefined);
    if (inv !== undefined) p.invert = inv;
    pts[i] = p;
    anyPt = true;
  }
  if (anyPt) s.points = pts;
  const dl = parseDLbls(child(el, "dLbls"));
  if (dl) s.dLbls = dl;
  const ex = cnum(el, "explosion", null);
  if (ex != null) s.explosion = ex;
  const inv = cbool(el, "invertIfNegative", undefined);
  if (inv !== undefined) s.invertIfNegative = inv;
  const sm = cbool(el, "smooth", undefined);
  if (sm !== undefined) s.smooth = sm;
  // Excel 2010+ colour for inverted negative bars lives in an extension.
  for (const ext of kids(child(el, "extLst"), "ext")) {
    const inv2 = child(ext, "invertSolidFillFmt");
    if (inv2) {
      const isp = parseSpPr(child(inv2, "spPr"));
      if (isp && isp.fill) s.invertFill = isp.fill;
    }
  }
  for (const [key, tag] of [["cat", "cat"], ["val", "val"], ["x", "xVal"], ["y", "yVal"], ["size", "bubbleSize"]]) {
    const d = parseData(child(el, tag));
    if (d) s[key] = d;
  }
  return s;
}

function parseGroup(el) {
  const type = GROUP_TYPES[el.name];
  const g = { type, tag: el.name, is3D: /3D/.test(el.name), axIds: kids(el, "axId").map((a) => num(a.attrs.val, 0)) };
  g.varyColors = cbool(el, "varyColors", true);
  g.series = kids(el, "ser").map((s, i) => parseSeries(s, i)).sort((a, b) => a.order - b.order || a.idx - b.idx);
  const dl = parseDLbls(child(el, "dLbls"));
  if (dl) g.dLbls = dl;
  const gp = cval(el, "grouping");
  switch (type) {
    case "bar":
      g.barDir = cval(el, "barDir") || "col";
      g.grouping = gp || "clustered";
      if (g.grouping === "standard") g.grouping = "clustered";
      g.gapWidth = cnum(el, "gapWidth", 150);
      g.overlap = cnum(el, "overlap", g.grouping === "clustered" ? 0 : 100);
      break;
    case "line":
      g.grouping = gp && gp !== "clustered" ? gp : "standard";
      g.marker = el.name === "line3DChart" ? false : cbool(el, "marker", el.name !== "stockChart");
      if (el.name === "stockChart") g.stock = true;
      if (child(el, "smooth")) g.smooth = cbool(el, "smooth", true);
      break;
    case "area":
      g.grouping = gp && gp !== "clustered" ? gp : "standard";
      break;
    case "pie":
      g.firstSliceAng = cnum(el, "firstSliceAng", 0);
      if (el.name === "ofPieChart") g.ofPie = cval(el, "ofPieType") || "pie";
      break;
    case "doughnut":
      g.firstSliceAng = cnum(el, "firstSliceAng", 0);
      g.holeSize = clamp(cnum(el, "holeSize", 50), 1, 90);
      break;
    case "scatter":
      g.scatterStyle = cval(el, "scatterStyle") || "marker";
      break;
    case "radar":
      g.radarStyle = cval(el, "radarStyle") || "standard";
      break;
    case "bubble":
      g.bubbleScale = clamp(cnum(el, "bubbleScale", 100), 0, 300);
      g.showNegBubbles = cbool(el, "showNegBubbles", false);
      g.sizeRepresents = cval(el, "sizeRepresents") || "area";
      break;
    default: break;
  }
  for (const [key, tag] of [["dropLines", "dropLines"], ["hiLowLines", "hiLowLines"]]) {
    const c = child(el, tag);
    if (c) g[key] = parseSpPr(child(c, "spPr")) || {};
  }
  const ud = child(el, "upDownBars");
  if (ud) {
    g.upDownBars = {
      gapWidth: cnum(ud, "gapWidth", 150),
      up: parseSpPr(child(child(ud, "upBars"), "spPr")) || {},
      down: parseSpPr(child(child(ud, "downBars"), "spPr")) || {},
    };
  }
  return g;
}

function parseTitle(el) {
  if (!el) return null;
  const t = { overlay: cbool(el, "overlay", false) };
  const lay = parseLayout(child(el, "layout"));
  if (lay) t.layout = lay;
  const sp = parseSpPr(child(el, "spPr"));
  if (sp) t.sp = sp;
  const tx = parseTxPr(child(el, "txPr"));
  if (tx) t.tx = tx;
  const tEl = child(el, "tx");
  if (tEl) {
    const rich = child(tEl, "rich");
    if (rich) {
      const r = parseRich(rich);
      t.lines = r.lines;
      t.base = r.base;
    } else {
      const d = parseData(tEl);
      if (d) {
        t.ref = d.ref;
        const s = d.v.filter((x) => x != null).join(" ");
        if (s) t.lines = s.split(/\r?\n/).map((line) => [{ text: line }]);
      }
    }
  }
  return t;
}

const AXIS_KINDS = { catAx: "cat", valAx: "val", dateAx: "date", serAx: "ser" };

function parseAxis(el) {
  const kind = AXIS_KINDS[el.name];
  const sc = child(el, "scaling");
  const a = {
    id: cnum(el, "axId", 0), kind,
    deleted: cbool(el, "delete", true),
    pos: cval(el, "axPos") || (kind === "val" ? "l" : "b"),
    orient: cval(sc, "orientation") || "minMax",
    min: cnum(sc, "min", null), max: cnum(sc, "max", null),
    logBase: cnum(sc, "logBase", null),
    majorUnit: cnum(el, "majorUnit", null), minorUnit: cnum(el, "minorUnit", null),
    majorGrid: child(el, "majorGridlines") ? parseSpPr(child(child(el, "majorGridlines"), "spPr")) || {} : null,
    minorGrid: child(el, "minorGridlines") ? parseSpPr(child(child(el, "minorGridlines"), "spPr")) || {} : null,
    tickLblPos: cval(el, "tickLblPos") || "nextTo",
    majorTick: cval(el, "majorTickMark") || "cross",
    minorTick: cval(el, "minorTickMark") || "cross",
    crossAx: cnum(el, "crossAx", null),
    crosses: cval(el, "crosses") || "autoZero",
    crossesAt: cnum(el, "crossesAt", null),
    crossBetween: cval(el, "crossBetween") || null,
    tickLblSkip: cnum(el, "tickLblSkip", null),
    tickMarkSkip: cnum(el, "tickMarkSkip", null),
    lblOffset: cnum(el, "lblOffset", 100),
  };
  const nf = child(el, "numFmt");
  if (nf) a.numFmt = { code: nf.attrs.formatCode || "General", linked: nf.attrs.sourceLinked === "1" || nf.attrs.sourceLinked === "true" };
  const title = parseTitle(child(el, "title"));
  if (title) a.title = title;
  const sp = parseSpPr(child(el, "spPr"));
  if (sp) a.sp = sp;
  const tx = parseTxPr(child(el, "txPr"));
  if (tx) a.tx = tx;
  const du = child(el, "dispUnits");
  if (du) {
    const b = cval(du, "builtInUnit");
    const cu = cnum(du, "custUnit", null);
    const lbl = child(du, "dispUnitsLbl");
    const u = { factor: b && BUILTIN_UNITS[b] ? BUILTIN_UNITS[b][0] : cu || 1, label: null };
    if (lbl) {
      const t = parseTitle(lbl);
      u.label = t && t.lines ? t.lines.map((l) => l.map((r) => r.text).join("")).join(" ") : b && BUILTIN_UNITS[b] ? BUILTIN_UNITS[b][1] : "";
      if (t && t.tx) u.tx = t.tx;
    }
    a.dispUnits = u;
  }
  return a;
}

function parseLegend(el) {
  if (!el) return null;
  const L = { pos: cval(el, "legendPos") || "r", overlay: cbool(el, "overlay", false), deleted: [] };
  for (const e of kids(el, "legendEntry")) {
    if (cbool(e, "delete", false)) L.deleted.push(cnum(e, "idx", -1));
  }
  const lay = parseLayout(child(el, "layout"));
  if (lay) L.layout = lay;
  const sp = parseSpPr(child(el, "spPr"));
  if (sp) L.sp = sp;
  const tx = parseTxPr(child(el, "txPr"));
  if (tx) L.tx = tx;
  return L;
}

/**
 * Guards xml.js against input it cannot survive: an unterminated <!--, <![CDATA[, <? or <!
 * makes it loop forever, and a numeric entity above U+10FFFF makes it throw. Truncated parts
 * are cut at the unterminated construct.
 */
function guardXml(s) {
  let cut = s.length;
  const scan = (open, close) => {
    let i = 0;
    while ((i = s.indexOf(open, i)) >= 0 && i < cut) {
      const j = s.indexOf(close, i + open.length);
      if (j < 0) { cut = i; return; }
      i = j + close.length;
    }
  };
  scan("<!--", "-->");
  scan("<![CDATA[", "]]>");
  scan("<?", "?>");
  scan("<!", ">");
  if (cut < s.length) s = s.slice(0, cut);
  return s.replace(/&#([xX][0-9a-fA-F]+|[0-9]+);/g, (m, e) => {
    const n = e[0] === "x" || e[0] === "X" ? parseInt(e.slice(1), 16) : parseInt(e, 10);
    return n > 0x10ffff ? "&#xFFFD;" : m;
  });
}

/** Parses a chart part into a JSON-able model. */
export function parseChart(xmlString) {
  let root = null;
  try { root = parseXml(guardXml(String(xmlString || ""))); } catch (e) { root = null; }
  const model = { version: 1, roundedCorners: false, style: 2, plot: null, legend: null, title: null };
  if (!root) return model;
  unwrapAlternate(root);
  const chart = child(root, "chart");
  model.roundedCorners = cbool(root, "roundedCorners", true);
  model.style = cnum(root, "style", 2);
  model.date1904 = cbool(root, "date1904", false);
  const sp = parseSpPr(child(root, "spPr"));
  if (sp) model.sp = sp;
  const tx = parseTxPr(child(root, "txPr"));
  if (tx) model.tx = tx;
  if (!chart) return model;
  model.title = parseTitle(child(chart, "title"));
  model.autoTitleDeleted = cbool(chart, "autoTitleDeleted", true);
  model.plotVisOnly = cbool(chart, "plotVisOnly", true);
  const db = child(chart, "dispBlanksAs");
  model.dispBlanksAs = db ? db.attrs.val || "zero" : "zero";
  const pa = child(chart, "plotArea");
  const plot = { layout: null, groups: [], axes: [] };
  if (pa) {
    plot.layout = parseLayout(child(pa, "layout"));
    const psp = parseSpPr(child(pa, "spPr"));
    if (psp) plot.sp = psp;
    for (const c of pa.children) {
      if (GROUP_TYPES[c.name]) plot.groups.push(parseGroup(c));
      else if (AXIS_KINDS[c.name]) plot.axes.push(parseAxis(c));
    }
  }
  model.plot = plot;
  model.legend = parseLegend(child(chart, "legend"));
  return model;
}

/**
 * Fills series caches that are empty (charts written without caches, e.g. by openpyxl) from
 * the workbook. lookup(ref, isNumber) -> array of cell values (or { values, formatCode }) | null.
 */
export function resolveRefs(model, lookup) {
  if (!model || !model.plot || typeof lookup !== "function") return model;
  const fill = (d) => {
    if (!d || !d.ref || d.v.some((x) => x != null)) return;
    let r = null;
    try { r = lookup(d.ref, d.num); } catch (e) { r = null; }
    if (!r) return;
    const values = Array.isArray(r) ? r : r.values || [];
    if (!Array.isArray(r) && r.formatCode) d.fmt = r.formatCode;
    const anyText = values.some((x) => typeof x === "string" && x !== "" && !isNum(num(x)));
    if (d.num && anyText) { d.num = false; d.fmt = null; }
    d.v = values.map((x) => (x == null || x === "" ? null : d.num ? num(x, null) : String(x)));
  };
  for (const g of model.plot.groups) {
    for (const s of g.series) {
      for (const k of ["cat", "val", "x", "y", "size"]) fill(s[k]);
      if (s.name == null && s.nameRef) {
        const d = { ref: s.nameRef, num: false, v: [] };
        fill(d);
        const parts = d.v.filter((x) => x != null && x !== "");
        if (parts.length) s.name = parts.join(" ");
      }
    }
  }
  return model;
}

// ---------------------------------------------------------------------------------------------
// Colour math
// ---------------------------------------------------------------------------------------------

function hexToRgb(h) {
  const s = normHex(h);
  return [parseInt(s.slice(0, 2), 16) / 255, parseInt(s.slice(2, 4), 16) / 255, parseInt(s.slice(4, 6), 16) / 255];
}
function rgbToHex(rgb) {
  return "#" + rgb.map((c) => Math.round(clamp(c, 0, 1) * 255).toString(16).padStart(2, "0")).join("");
}
function rgbToHsl([r, g, b]) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h;
  if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}
function hslToRgb(h, s, l) {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => {
    t = ((t % 1) + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}
const srgbToLin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const linToSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

function applyMods(rgb, mods) {
  let a = 1;
  let c = rgb.slice();
  const hsl = (fn) => {
    const [h, s, l] = rgbToHsl(c);
    const r = fn(h, s, l);
    c = hslToRgb(((r[0] % 1) + 1) % 1, clamp(r[1], 0, 1), clamp(r[2], 0, 1));
  };
  for (const [name, v] of mods || []) {
    const f = v / 100000;
    switch (name) {
      case "lumMod": hsl((h, s, l) => [h, s, l * f]); break;
      case "lumOff": hsl((h, s, l) => [h, s, l + f]); break;
      case "lum": hsl((h, s) => [h, s, f]); break;
      case "satMod": hsl((h, s, l) => [h, s * f, l]); break;
      case "satOff": hsl((h, s, l) => [h, s + f, l]); break;
      case "sat": hsl((h, s, l) => [h, f, l]); break;
      case "hue": hsl((h, s, l) => [v / 60000 / 360, s, l]); break;
      case "hueOff": hsl((h, s, l) => [h + v / 60000 / 360, s, l]); break;
      case "hueMod": hsl((h, s, l) => [h * f, s, l]); break;
      case "comp": hsl((h, s, l) => [h + 0.5, s, l]); break;
      case "tint": c = c.map((x) => linToSrgb(1 - (1 - srgbToLin(x)) * f)); break;
      case "shade": c = c.map((x) => linToSrgb(srgbToLin(x) * f)); break;
      case "inv": c = c.map((x) => 1 - x); break;
      case "gray": { const y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; c = [y, y, y]; break; }
      case "alpha": a = f; break;
      case "alphaMod": a *= f; break;
      case "alphaOff": a += f; break;
      case "red": c[0] = linToSrgb(f); break;
      case "green": c[1] = linToSrgb(f); break;
      case "blue": c[2] = linToSrgb(f); break;
      case "redMod": c[0] = linToSrgb(srgbToLin(c[0]) * f); break;
      case "greenMod": c[1] = linToSrgb(srgbToLin(c[1]) * f); break;
      case "blueMod": c[2] = linToSrgb(srgbToLin(c[2]) * f); break;
      case "redOff": c[0] = linToSrgb(srgbToLin(c[0]) + f); break;
      case "greenOff": c[1] = linToSrgb(srgbToLin(c[1]) + f); break;
      case "blueOff": c[2] = linToSrgb(srgbToLin(c[2]) + f); break;
      default: break;
    }
    c = c.map((x) => clamp(x, 0, 1));
  }
  return { rgb: c, a: clamp(a, 0, 1) };
}

// ---------------------------------------------------------------------------------------------
// Render environment
// ---------------------------------------------------------------------------------------------

function fallbackFormat(v, code) {
  if (!isNum(v)) return v == null ? "" : String(v);
  code = String(code || "General");
  const body = code.split(";")[0].replace(/"[^"]*"/g, "").replace(/\\./g, "");
  if (/general/i.test(body) || !/[0#?]/.test(body)) return String(clean(v));
  const pct = body.includes("%");
  const m = body.match(/\.([0#?]+)/);
  const dec = m ? m[1].replace(/[#?]/g, "").length : 0;
  let x = pct ? v * 100 : v;
  let s = Math.abs(x).toFixed(dec);
  if (body.includes(",")) {
    const [i, f] = s.split(".");
    s = i.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (f ? "." + f : "");
  }
  const lit = (code.split(";")[0].match(/"([^"]*)"/g) || []).map((q) => q.slice(1, -1));
  const pre = lit.length && code.indexOf('"') < code.search(/[0#?]/) ? lit[0] : "";
  return (x < 0 && Number(s.replace(/,/g, "")) !== 0 ? "-" : "") + pre + s + (pct ? "%" : "");
}

function makeEnv(model, ctx, W, H) {
  const theme = { ...DEFAULT_THEME };
  for (const k of Object.keys(ctx.theme || {})) {
    if (typeof ctx.theme[k] === "string" && /^#?[0-9a-fA-F]{6}$/.test(ctx.theme[k])) theme[k] = "#" + normHex(ctx.theme[k]);
  }
  const fmt = (v, code) => {
    if (typeof ctx.format === "function") {
      try {
        const s = ctx.format(v, code || "General");
        if (s != null) return String(s);
      } catch (e) { /* fall through */ }
    }
    return fallbackFormat(v, code);
  };
  const st = model.style;
  const styleCol = st >= 1 && st <= 48 ? (st - 1) % 8 : 1;
  const color = (spec) => {
    if (!spec) return null;
    if (spec.k === "grad") {
      const stops = spec.stops;
      let a = stops[0], b = stops[stops.length - 1];
      for (let i = 0; i < stops.length - 1; i++) {
        if (stops[i].pos <= 0.5 && stops[i + 1].pos >= 0.5) { a = stops[i]; b = stops[i + 1]; break; }
      }
      const ca = color(a.c), cb = color(b.c);
      const t = b.pos > a.pos ? clamp((0.5 - a.pos) / (b.pos - a.pos), 0, 1) : 0;
      const x = hexToRgb(ca.c), y = hexToRgb(cb.c);
      return { c: rgbToHex(x.map((v, i) => v + (y[i] - v) * t)), a: ca.a + (cb.a - ca.a) * t };
    }
    let base;
    if (spec.k === "scheme") {
      const key = SCHEME_ALIAS[spec.v] || spec.v;
      base = theme[key] || (spec.v === "phClr" ? theme.accent1 : "#000000");
    } else base = spec.v || "#000000";
    const r = applyMods(hexToRgb(base), spec.m);
    return { c: rgbToHex(r.rgb), a: r.a };
  };
  const autoSpec = (i, n) => {
    i = Math.max(0, i | 0);
    if (styleCol === 1) return { k: "scheme", v: "accent" + ((i % 6) + 1), m: PALETTE_VARIANTS[Math.floor(i / 6) % PALETTE_VARIANTS.length] };
    const base = styleCol === 0 ? { k: "rgb", v: "#808080" } : { k: "scheme", v: "accent" + (styleCol - 1) };
    const t = n > 1 ? -0.5 + Math.min(i, n - 1) / (n - 1) : 0;
    const m = t < 0 ? [["lumMod", Math.round((1 + t) * 100000)]] : t > 0 ? [["lumMod", Math.round((1 - t) * 100000)], ["lumOff", Math.round(t * 100000)]] : [];
    return { ...base, m };
  };
  return { model, ctx, W, H, out: [], theme, fmt, color, autoSpec };
}

const rgb = (hex) => ({ k: "rgb", v: hex, m: [] });

function textStyle(env, kind, ...layers) {
  const d = TEXT_KINDS[kind];
  const cs = env.model.tx || {};
  const o = { size: cs.size != null ? cs.size * d.rel : d.size, bold: cs.bold || false, italic: cs.italic || false, color: cs.color || null, rot: undefined };
  for (const L of layers) {
    if (!L) continue;
    for (const k of ["size", "bold", "italic", "color", "rot"]) if (L[k] !== undefined) o[k] = L[k];
  }
  const c = o.color ? env.color(o.color) : null;
  return { px: clamp(o.size, 1, 400) * PX_PER_PT, bold: !!o.bold, italic: !!o.italic, color: c ? c.c : d.color, rot: o.rot };
}

const textW = (s, st) => (st.bold ? 0.6 : 0.55) * st.px * String(s).length;
const lineH = (st) => st.px * 1.2;

function mergeSp(a, b) {
  if (!b) return a || null;
  if (!a) return b;
  const o = { ...a, ...b };
  if (a.ln || b.ln) o.ln = { ...(a.ln || {}), ...(b.ln || {}) };
  return o;
}

/** Resolves spPr against automatic defaults: { fill: {c,a}|null, line: {c,a,w,dash}|null }. */
function shapeStyle(env, sp, auto) {
  sp = sp || {};
  const fillSpec = "fill" in sp ? sp.fill : auto.fill;
  const ln = sp.ln, aln = auto.ln;
  let lineSpec = null, w = 1, dash = null;
  if (ln) {
    lineSpec = "fill" in ln ? ln.fill : aln ? aln.fill : null;
    w = ln.w != null ? ln.w : aln ? aln.w : 1;
    dash = ln.dash != null ? ln.dash : aln ? aln.dash : null;
  } else if (aln) {
    lineSpec = aln.fill;
    w = aln.w;
    dash = aln.dash || null;
  }
  const fill = fillSpec ? env.color(fillSpec) : null;
  const lc = lineSpec ? env.color(lineSpec) : null;
  return { fill, line: lc ? { c: lc.c, a: lc.a, w: Math.max(0.5, w || 0.5), dash } : null };
}

function dashArray(line) {
  if (!line || !line.dash) return null;
  const base = Array.isArray(line.dash) ? line.dash : DASHES[line.dash];
  if (!base) return null;
  const w = Math.max(1, line.w);
  return base.map((v) => r2(v * w));
}

// ---------------------------------------------------------------------------------------------
// Primitive emitters
// ---------------------------------------------------------------------------------------------

const P2 = (p) => [r2(p[0]), r2(p[1])];

function emitLine(env, pts, line) {
  if (!line || pts.length < 2) return;
  const it = { t: "line", pts: pts.map(P2), stroke: line.c, sw: r2(line.w) };
  const d = dashArray(line);
  if (d) it.dash = d;
  if (line.a < 1) it.alpha = r2(line.a);
  env.out.push(it);
}

function emitPoly(env, pts, st) {
  if (pts.length < 3) return;
  const { fill, line } = st;
  if (!fill && !line) return;
  const P = pts.map(P2);
  const dash = dashArray(line);
  if (fill && line && !dash && Math.abs(fill.a - line.a) < 1e-3) {
    const it = { t: "poly", pts: P, fill: fill.c, stroke: line.c, sw: r2(line.w) };
    if (fill.a < 1) it.alpha = r2(fill.a);
    env.out.push(it);
    return;
  }
  if (fill) {
    const it = { t: "poly", pts: P, fill: fill.c };
    if (fill.a < 1) it.alpha = r2(fill.a);
    env.out.push(it);
  }
  if (line) emitLine(env, P.concat([P[0]]), line);
}

function emitRect(env, x, y, w, h, st) {
  if (w < 0) { x += w; w = -w; }
  if (h < 0) { y += h; h = -h; }
  const { fill, line } = st;
  if (!fill && !line) return;
  const dash = dashArray(line);
  const same = !fill || !line || Math.abs(fill.a - line.a) < 1e-3;
  if (!dash && same) {
    const it = { t: "rect", x: r2(x), y: r2(y), w: r2(w), h: r2(h) };
    if (fill) it.fill = fill.c;
    if (line) { it.stroke = line.c; it.sw = r2(line.w); }
    const a = fill ? fill.a : line.a;
    if (a < 1) it.alpha = r2(a);
    env.out.push(it);
    return;
  }
  if (fill) emitRect(env, x, y, w, h, { fill, line: null });
  if (line) emitLine(env, [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]], line);
}

function emitText(env, s, x, y, st, anchor, base, rot) {
  if (s == null || s === "") return;
  const it = { t: "text", x: r2(x), y: r2(y), s: String(s), size: r2(st.px), color: st.color, anchor, base };
  if (st.bold) it.bold = true;
  if (st.italic) it.italic = true;
  if (rot === -90) it.rot = -90;
  env.out.push(it);
}

function arcPts(cx, cy, r, a0, a1) {
  // angles: radians clockwise from 12 o'clock
  const n = Math.max(1, Math.ceil(Math.abs(a1 - a0) / SEG));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    pts.push([cx + r * Math.sin(a), cy - r * Math.cos(a)]);
  }
  return pts;
}

function circlePts(cx, cy, r) {
  const pts = arcPts(cx, cy, r, 0, TAU);
  pts.pop();
  return pts;
}

function roundedRectPts(x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  return [
    ...arcPts(x + w - r, y + r, r, 0, Math.PI / 2),
    ...arcPts(x + w - r, y + h - r, r, Math.PI / 2, Math.PI),
    ...arcPts(x + r, y + h - r, r, Math.PI, Math.PI * 1.5),
    ...arcPts(x + r, y + r, r, Math.PI * 1.5, TAU),
  ];
}

function drawMarker(env, sym, x, y, px, st) {
  const h = px / 2;
  const stroke = st.line || (st.fill ? { c: st.fill.c, a: st.fill.a, w: 1 } : null);
  switch (sym) {
    case "circle": emitPoly(env, circlePts(x, y, h), st); break;
    case "square": emitRect(env, x - h, y - h, px, px, st); break;
    case "diamond": emitPoly(env, [[x, y - h], [x + h, y], [x, y + h], [x - h, y]], st); break;
    case "triangle": emitPoly(env, [[x, y - h], [x + h, y + h], [x - h, y + h]], st); break;
    case "x":
      emitLine(env, [[x - h, y - h], [x + h, y + h]], stroke);
      emitLine(env, [[x - h, y + h], [x + h, y - h]], stroke);
      break;
    case "plus":
      emitLine(env, [[x - h, y], [x + h, y]], stroke);
      emitLine(env, [[x, y - h], [x, y + h]], stroke);
      break;
    case "star":
      emitLine(env, [[x - h, y - h], [x + h, y + h]], stroke);
      emitLine(env, [[x - h, y + h], [x + h, y - h]], stroke);
      emitLine(env, [[x, y - h], [x, y + h]], stroke);
      break;
    case "dash": emitRect(env, x - h, y - px / 10, px, px / 5, { fill: st.fill || (st.line && { c: st.line.c, a: st.line.a }), line: null }); break;
    case "dot": emitRect(env, x - px / 5, y - px / 5, (px * 2) / 5, (px * 2) / 5, { fill: st.fill || (st.line && { c: st.line.c, a: st.line.a }), line: null }); break;
    default: emitPoly(env, circlePts(x, y, h), st); break;
  }
}

/** Catmull-Rom spline through pts (Excel-like smoothing), sampled as a polyline. */
function smoothPts(pts) {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || pts[i + 1];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    const steps = 12;
    for (let k = 1; k <= steps; k++) {
      const t = k / steps, u = 1 - t;
      out.push([
        u * u * u * p1[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p2[0],
        u * u * u * p1[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p2[1],
      ]);
    }
  }
  return out;
}

function wrapWords(s, maxW, st) {
  const words = String(s).split(/\s+/).filter(Boolean);
  if (words.length < 2) return null;
  const lines = [];
  let cur = "";
  for (const w of words) {
    if (textW(w, st) > maxW) return null;
    const t = cur ? cur + " " + w : w;
    if (cur && textW(t, st) > maxW) { lines.push(cur); cur = w; } else cur = t;
  }
  if (cur) lines.push(cur);
  return lines;
}

// ---------------------------------------------------------------------------------------------
// Series preparation (styles, colours, markers)
// ---------------------------------------------------------------------------------------------

function seriesName(s) {
  return s.name != null && s.name !== "" ? s.name : "Series" + (s.idx + 1);
}

function catCount(series) {
  let n = 0;
  for (const s of series) n = Math.max(n, s.cat ? s.cat.v.length : 0, s.val ? s.val.v.length : 0);
  return n;
}

function prepare(env) {
  const model = env.model;
  const groups = model.plot.groups
    .filter((g) => g.type && g.type !== "surface" && g.series.length)
    .map((g, i) => ({ g, i }))
    .sort((a, b) => GROUP_RANK[a.g.type] - GROUP_RANK[b.g.type] || a.i - b.i)
    .map((x) => x.g);
  const nSeries = groups.reduce((n, g) => n + g.series.length, 0);
  const rgs = [];
  for (const g of groups) {
    const pieLike = g.type === "pie" || g.type === "doughnut";
    const vary = pieLike ? g.varyColors : g.varyColors && nSeries === 1 && ["bar", "line", "scatter", "bubble", "radar"].includes(g.type);
    const rg = { g, type: g.type, vary, series: [] };
    const nPts = catCount(g.series) || Math.max(0, ...g.series.map((s) => (s.y || s.val || { v: [] }).v.length));
    for (const s of g.series) {
      const auto = env.autoSpec(s.idx, nSeries);
      const rs = { s, auto, name: seriesName(s), nPts };
      let autoFill = null, autoLine = null, markersAuto = false, showLineAuto = true;
      switch (g.type) {
        case "bar": case "area": case "bubble": autoFill = auto; break;
        case "pie": case "doughnut": autoFill = auto; autoLine = { fill: { k: "scheme", v: "lt1", m: [] }, w: 1 }; break;
        case "line":
          autoLine = { fill: auto, w: g.is3D ? 1.5 : 3 };
          markersAuto = g.marker;
          if (g.stock) showLineAuto = false;
          break;
        case "scatter": {
          const ss = g.scatterStyle;
          showLineAuto = ss !== "marker";
          autoLine = { fill: auto, w: 2 };
          markersAuto = ss === "marker" || ss === "lineMarker" || ss === "smoothMarker";
          break;
        }
        case "radar":
          if (g.radarStyle === "filled") autoFill = auto;
          else autoLine = { fill: auto, w: 3 };
          markersAuto = g.radarStyle === "marker";
          break;
        default: break;
      }
      if (!showLineAuto) autoLine = { fill: null, w: 1 };
      rs.autoShape = { fill: autoFill, ln: autoLine };
      rs.style = shapeStyle(env, s.sp, rs.autoShape);
      rs.markersAuto = markersAuto;
      rs.smooth = g.type === "line" ? (g.is3D ? false : s.smooth != null ? s.smooth : g.smooth != null ? g.smooth : true)
        : g.type === "scatter" ? (s.smooth != null ? s.smooth : /^smooth/.test(g.scatterStyle || "")) : false;
      rg.series.push(rs);
    }
    rgs.push(rg);
  }
  env.nSeries = nSeries;
  return rgs;
}

function pointSpec(env, rg, rs, i) {
  return rg.vary ? env.autoSpec(i, rs.nPts) : rs.auto;
}

/** Resolved shape style of point i (series spPr + dPt overrides + vary-colour automatic). */
function pointStyle(env, rg, rs, i) {
  const pt = rs.s.points && rs.s.points[i];
  if (!rg.vary && !pt) return rs.style;
  const a = pointSpec(env, rg, rs, i);
  const aln = rs.autoShape.ln;
  const auto = {
    fill: rs.autoShape.fill ? a : null,
    ln: aln ? { ...aln, fill: aln.fill === rs.auto ? a : aln.fill } : null,
  };
  return shapeStyle(env, mergeSp(rs.s.sp, pt && pt.sp), auto);
}

/** Marker of point i: { sym, px, st } or null. */
function markerOf(env, rg, rs, i) {
  const s = rs.s;
  const pm = s.points && s.points[i] && s.points[i].marker;
  let sym = (pm && pm.symbol) || (s.marker && s.marker.symbol) || null;
  if (!sym || sym === "auto") sym = rs.markersAuto || (sym === "auto") ? AUTO_MARKERS[s.idx % AUTO_MARKERS.length] : null;
  if (!sym || sym === "none" || sym === "picture") return null;
  const size = (pm && pm.size) || (s.marker && s.marker.size) || 5;
  const a = pointSpec(env, rg, rs, i);
  const st = shapeStyle(env, mergeSp(s.marker && s.marker.sp, pm && pm.sp), { fill: a, ln: { fill: a, w: 1 } });
  return { sym, px: size * PX_PER_PT, st };
}

// ---------------------------------------------------------------------------------------------
// Axes: instances, scales, mapping
// ---------------------------------------------------------------------------------------------

function defaultAxis(id, kind) {
  return {
    id, kind, deleted: false, pos: kind === "val" ? "l" : "b", orient: "minMax", min: null, max: null, logBase: null,
    majorUnit: null, minorUnit: null, majorGrid: kind === "val" ? {} : null, minorGrid: null, tickLblPos: "nextTo",
    majorTick: "none", minorTick: "none", crossAx: null, crosses: "autoZero", crossesAt: null, crossBetween: null,
    tickLblSkip: null, tickMarkSkip: null, lblOffset: 100,
  };
}

function setupAxes(env, rgs) {
  const byId = new Map(env.model.plot.axes.map((a) => [a.id, a]));
  const insts = new Map();
  const inst = (m, dir, role) => {
    let a = insts.get(m.id);
    if (!a) {
      a = { m, id: m.id, dir, role, groups: [], deleted: m.deleted };
      insts.set(m.id, a);
    }
    return a;
  };
  let synth = -1;
  const get = (id, kind) => {
    const m = byId.get(id);
    if (m) return m;
    const d = defaultAxis(synth--, kind);
    byId.set(d.id, d);
    return d;
  };
  for (const rg of rgs) {
    const g = rg.g;
    if (rg.type === "pie" || rg.type === "doughnut") continue;
    let m0 = get(g.axIds[0], rg.type === "scatter" || rg.type === "bubble" ? "val" : "cat");
    let m1 = get(g.axIds[1], "val");
    if (rg.type === "scatter" || rg.type === "bubble") {
      const vert = (p) => p === "l" || p === "r";
      if (vert(m0.pos) && !vert(m1.pos)) [m0, m1] = [m1, m0];
      rg.xAx = inst(m0, "h", "val");
      rg.yAx = inst(m1, "v", "val");
      rg.xAx.groups.push(rg);
      rg.yAx.groups.push(rg);
      rg.xAx.isX = true;
      rg.xAx.pair = rg.yAx;
      rg.yAx.pair = rg.xAx;
    } else if (rg.type === "radar") {
      rg.catAx = { m: m0, id: m0.id, dir: "r", role: "cat", groups: [rg], deleted: m0.deleted };
      rg.valAx = { m: m1, id: m1.id, dir: "r", role: "val", groups: [rg], deleted: m1.deleted };
    } else {
      const horiz = !(rg.type === "bar" && g.barDir === "bar");
      if (m0.kind === "val" && m1.kind !== "val") [m0, m1] = [m1, m0];
      rg.catAx = inst(m0, horiz ? "h" : "v", "cat");
      rg.valAx = inst(m1, horiz ? "v" : "h", "val");
      rg.catAx.groups.push(rg);
      rg.valAx.groups.push(rg);
      if (!rg.catAx.pair) rg.catAx.pair = rg.valAx;
      if (!rg.valAx.pair) rg.valAx.pair = rg.catAx;
    }
  }
  const list = [...insts.values()];
  for (const a of list) {
    const c = a.m.crossAx != null ? insts.get(a.m.crossAx) : null;
    a.partner = c && c.dir !== a.dir ? c : a.pair || null;
    a.ts = textStyle(env, "axis", a.m.tx);
  }
  // category axes: count, labels, between/midCat
  for (const a of list) {
    if (a.role !== "cat") continue;
    const series = a.groups.flatMap((rg) => rg.g.series);
    a.n = Math.max(1, catCount(series));
    let vb = null;
    for (const v of list) if (v.role === "val" && (v.m.crossAx === a.id || v.pair === a) && v.m.crossBetween) { vb = v.m.crossBetween; break; }
    if (!vb) vb = a.groups.every((rg) => rg.type === "area") ? "midCat" : "between";
    a.between = vb !== "midCat" || a.n < 2;
    const src = series.find((s) => s.cat && s.cat.v.some((x) => x != null));
    const code = a.m.numFmt && !a.m.numFmt.linked ? a.m.numFmt.code : src && src.cat.fmt;
    a.labels = [];
    for (let i = 0; i < a.n; i++) {
      const v = src ? src.cat.v[i] : i + 1;
      a.labels.push(v == null ? "" : typeof v === "number" ? (src ? env.fmt(v, code || "General") : String(v)) : String(v));
    }
  }
  return list;
}

/** Data extents for a value axis instance. */
function valueExtents(env, a) {
  let lo = Infinity, hi = -Infinity, zero = false, percent = false, bubble = false;
  const add = (v) => { if (isNum(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } };
  const blanksZero = env.model.dispBlanksAs === "zero";
  for (const rg of a.groups) {
    const g = rg.g;
    if (rg.type === "scatter" || rg.type === "bubble") {
      if (rg.type === "bubble") bubble = true;
      for (const s of g.series) {
        if (a.isX) {
          if (s.x && s.x.num) s.x.v.forEach(add);
          else { const n = (s.y || s.val || { v: [] }).v.length; for (let i = 1; i <= n; i++) add(i); }
        } else (s.y || s.val || { v: [] }).v.forEach(add);
      }
      continue;
    }
    if (rg.type === "bar" || rg.type === "area") zero = true;
    const grouping = g.grouping;
    const n = catCount(g.series);
    if (grouping === "stacked" || grouping === "percentStacked") {
      const pct = grouping === "percentStacked";
      if (pct) percent = true;
      for (let i = 0; i < n; i++) {
        let pos = 0, neg = 0, tot = 0;
        for (const s of g.series) {
          const v = s.val && s.val.v[i];
          if (!isNum(v)) continue;
          if (v >= 0) pos += v; else neg += v;
          tot += Math.abs(v);
        }
        if (pct) { if (tot > 0) { add(pos / tot); add(neg / tot); } }
        else { add(pos); add(neg); }
      }
    } else {
      for (const s of g.series) {
        if (!s.val) continue;
        for (const v of s.val.v) { if (v == null && blanksZero && rg.type === "line") add(0); else add(v); }
      }
    }
  }
  if (lo === Infinity) { lo = 0; hi = percent ? 1 : 0; }
  return { lo, hi, zero, percent, bubble };
}

const NICE = [1, 2, 5];

function niceUnits(range) {
  const out = [];
  let e = Math.floor(Math.log10(Math.max(range, 1e-300))) - 3;
  for (let k = 0; k < 9; k++, e++) for (const m of NICE) out.push(clean(m * Math.pow(10, e)));
  return out;
}

function axisCode(env, a) {
  const m = a.m;
  if (m.numFmt && !m.numFmt.linked) return m.numFmt.code;
  if (a.percent) return "0%";
  for (const rg of a.groups) {
    for (const s of rg.g.series) {
      const d = a.isX ? s.x : rg.type === "scatter" || rg.type === "bubble" ? s.y : s.val;
      if (d && d.num && d.fmt) return d.fmt;
    }
  }
  return m.numFmt ? m.numFmt.code : "General";
}

function tickLabel(env, a, v) {
  const f = a.m.dispUnits ? a.m.dispUnits.factor || 1 : 1;
  return env.fmt(clean(v / f), a.code);
}

/** Computes lo/hi/ticks of a value axis for a pixel length. */
function computeValScale(env, a, len) {
  const m = a.m;
  const ext = valueExtents(env, a);
  a.percent = ext.percent;
  a.code = axisCode(env, a);
  const st = a.ts;
  const lh = lineH(st);
  const minSpacing = a.dir === "r" ? 1.2 * lh : 1.85 * lh;
  let { lo, hi } = ext;
  const log = m.logBase && m.logBase > 1 ? m.logBase : null;
  a.log = log;
  if (log) {
    const L = Math.log(log);
    let mnPos = Infinity, mxPos = -Infinity;
    for (const rg of a.groups) for (const s of rg.g.series) {
      const d = a.isX ? s.x : rg.type === "scatter" || rg.type === "bubble" ? s.y : s.val;
      if (d) for (const v of d.v) if (isNum(v) && v > 0) { mnPos = Math.min(mnPos, v); mxPos = Math.max(mxPos, v); }
    }
    if (mnPos === Infinity) { mnPos = 1; mxPos = log; }
    let l = m.min != null && m.min > 0 ? m.min : Math.pow(log, Math.floor(Math.log(mnPos) / L + 1e-9));
    let h = m.max != null && m.max > l ? m.max : Math.pow(log, Math.ceil(Math.log(mxPos) / L - 1e-9));
    if (h <= l) h = l * log;
    const step = m.majorUnit && m.majorUnit > 1 ? m.majorUnit : log;
    a.lo = clean(l); a.hi = clean(h);
    a.ticks = [];
    for (let v = l, k = 0; v <= h * (1 + 1e-9) && k < 200; v *= step, k++) a.ticks.push(clean(v));
    a.minor = [];
    a.frac = (v) => (isNum(v) && v > 0 ? (Math.log(v) - Math.log(a.lo)) / (Math.log(a.hi) - Math.log(a.lo)) : 0);
    a.labels = a.ticks.map((v) => tickLabel(env, a, v));
    return;
  }
  if (ext.bubble) {
    const r = hi - lo || Math.abs(hi) || 1;
    lo -= r * 0.15;
    hi += r * 0.15;
  }
  if (!(hi > lo)) {
    if (lo === 0) hi = 1;
    else if (lo > 0) lo = 0;
    else hi = 0;
  }
  if (a.percent) { lo = lo < 0 ? -1 : 0; hi = hi > 0 ? 1 : 0; if (hi <= lo) hi = lo + 1; }
  if (m.min == null && lo >= 0 && (ext.zero || lo < (hi * 5) / 6)) lo = 0;
  if (m.max == null && hi <= 0 && (ext.zero || hi > (lo * 5) / 6)) hi = 0;
  const range = hi - lo;
  let plo = lo, phi = hi;
  if (!a.percent) {
    if (hi !== 0) phi = hi + 0.05 * range;
    if (lo !== 0) plo = lo - 0.05 * range;
    if (lo >= 0 && plo < 0) plo = 0;
    if (hi <= 0 && phi > 0) phi = 0;
  }
  if (m.min != null) plo = m.min;
  if (m.max != null) phi = m.max;
  if (phi <= plo) phi = plo + (Math.abs(plo) || 1);
  const pick = (u) => {
    const L = m.min != null ? m.min : Math.floor(plo / u + 1e-9) * u;
    let Hh = m.max != null ? m.max : Math.ceil(phi / u - 1e-9) * u;
    if (Hh <= L) Hh = L + u;
    return [clean(L), clean(Hh)];
  };
  let unit = m.majorUnit && m.majorUnit > 0 ? m.majorUnit : null;
  let L, Hh;
  if (unit) {
    [L, Hh] = pick(unit);
    if ((Hh - L) / unit > 1000) unit = null;
  }
  if (!unit) {
    const cands = a.percent ? [0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1] : niceUnits(phi - plo);
    for (const u of cands) {
      const [l, h] = pick(u);
      const n = Math.round((h - l) / u);
      if (n > 200) continue;
      let need = minSpacing;
      if (a.dir === "h") {
        let w = 0;
        for (let k = 0; k <= n; k++) w = Math.max(w, textW(tickLabel(env, a, l + k * u), st));
        need = Math.max(w + st.px * 2, 3.6 * lh);
      }
      if (len / Math.max(1, n) >= need || u === cands[cands.length - 1]) { unit = u; L = l; Hh = h; break; }
    }
  }
  a.lo = L; a.hi = Hh; a.unit = unit;
  a.ticks = [];
  for (let k = 0; k < 1000; k++) {
    const v = clean(L + k * unit);
    if (v > Hh + unit * 1e-6) break;
    a.ticks.push(v);
  }
  const mu = m.minorUnit && m.minorUnit > 0 ? m.minorUnit : unit / 5;
  a.minor = [];
  if (m.minorGrid || (m.minorTick && m.minorTick !== "none")) {
    for (let k = 0; k < 2000; k++) {
      const v = clean(L + k * mu);
      if (v > Hh + mu * 1e-6) break;
      a.minor.push(v);
    }
  }
  const span = Hh - L || 1;
  a.frac = (v) => (v - L) / span;
  a.labels = a.ticks.map((v) => tickLabel(env, a, v));
}

/** Fraction along a category axis (increasing direction) of category i, offset f within its band. */
function catFrac(a, i, f) {
  if (a.between) return (i + f) / a.n;
  return a.n > 1 ? (i + f - 0.5) / (a.n - 1) : 0.5;
}
function bandFrac(a) {
  return a.between ? 1 / a.n : 1 / Math.max(1, a.n - 1);
}

/** Pixel along the axis direction for a fraction (orientation applied). */
function axisPx(a, P, f) {
  if (a.m.orient === "maxMin") f = 1 - f;
  return a.dir === "h" ? P.x + f * P.w : P.y + P.h - f * P.h;
}
function valPx(a, P, v) {
  return axisPx(a, P, clamp(a.frac(v), 0, 1));
}

/** Value on value axis c at which axis a crosses it. */
function crossValue(a, c) {
  const m = a.m;
  if (m.crossesAt != null) return clamp(m.crossesAt, Math.min(c.lo, c.hi), Math.max(c.lo, c.hi));
  if (m.crosses === "max") return c.hi;
  if (m.crosses === "min" || c.log) return c.lo;
  return c.lo <= 0 && c.hi >= 0 ? 0 : c.lo > 0 ? c.lo : c.hi;
}

/** Screen fraction where axis a sits across its partner: v axis -> x from left, h axis -> y from bottom. */
function crossScreenFrac(a) {
  const c = a.partner;
  if (!c) return 0;
  let f;
  if (c.role === "val") f = clamp(c.frac(crossValue(a, c)), 0, 1);
  else if (a.m.crossesAt != null) f = clamp(catFrac(c, a.m.crossesAt - 1, c.between ? 0 : 0.5), 0, 1);
  else f = a.m.crosses === "max" ? 1 : 0;
  return c.m.orient === "maxMin" ? 1 - f : f;
}

/** Where the axis line is drawn (perpendicular pixel coordinate). */
function crossPx(a, P) {
  const s = crossScreenFrac(a);
  return a.dir === "v" ? P.x + s * P.w : P.y + P.h - s * P.h;
}

/** Label placement: { side: l|r|t|b, edge: bool } or null. */
function labelPlacement(a) {
  if (a.deleted || a.m.tickLblPos === "none") return null;
  const s = crossScreenFrac(a);
  const atMax = s >= 0.999, atMin = s <= 0.001;
  const pRev = a.partner && a.partner.m.orient === "maxMin";
  const low = a.m.tickLblPos === "low", high = a.m.tickLblPos === "high";
  if (a.dir === "v") {
    if (low || high) return { side: (low !== pRev) ? "l" : "r", edge: true };
    return { side: atMax ? "r" : "l", edge: atMax || atMin };
  }
  if (low || high) return { side: (low !== pRev) ? "b" : "t", edge: true };
  return { side: atMax ? "t" : "b", edge: atMax || atMin };
}

function tickOut(a, major = true) {
  const t = major ? a.m.majorTick : a.m.minorTick;
  return t === "out" || t === "cross" ? (major ? TICK : MINOR_TICK) : 0;
}

/** Category label layout for axis a at pixel length len. */
function computeCatLabels(env, a, len) {
  const st = a.ts, lh = lineH(st);
  const band = len * bandFrac(a);
  const ws = a.labels.map((s) => textW(s, st));
  const maxW = Math.max(0, ...ws);
  let skip = a.m.tickLblSkip && a.m.tickLblSkip > 0 ? a.m.tickLblSkip : 0;
  let rot = st.rot;
  let lines = a.labels.map((s) => [s]);
  if (a.dir === "h") {
    const avail = Math.max(1, band - 4);
    if (rot === -90) {
      skip = skip || Math.max(1, Math.ceil((lh * 1.05) / band));
    } else if (maxW <= avail * (skip || 1)) {
      skip = skip || 1;
      rot = 0;
    } else {
      const wrapped = a.labels.map((s) => (textW(s, st) <= avail ? [s] : wrapWords(s, avail, st)));
      if (wrapped.every((w) => w && w.length <= 3)) {
        lines = wrapped;
        skip = skip || 1;
        rot = 0;
      } else if (rot === undefined && maxW <= 0.4 * env.H) {
        rot = -90;
        skip = skip || Math.max(1, Math.ceil((lh * 1.05) / band));
      } else {
        rot = 0;
        skip = skip || Math.max(1, Math.ceil((maxW + st.px) / band));
      }
    }
  } else {
    rot = 0;
    // long labels beside a vertical category axis wrap at about a third of the chart width
    const maxLabW = Math.max(40, env.W * 0.3);
    let rows = 1;
    if (maxW > maxLabW) {
      lines = a.labels.map((s) => (textW(s, st) <= maxLabW ? [s] : wrapWords(s, maxLabW, st) || [s]));
      rows = Math.max(...lines.map((l) => l.length));
      if (rows * lh > band * 1.5 && !skip) { lines = a.labels.map((s) => [s]); rows = 1; }
    }
    skip = skip || Math.max(1, Math.ceil((lh * rows * 0.95) / band));
  }
  let blockH = 0, blockW = 0;
  for (let i = 0; i < a.labels.length; i += skip) {
    if (rot === -90) blockH = Math.max(blockH, ws[i]);
    else {
      blockH = Math.max(blockH, lines[i].length * lh);
      blockW = Math.max(blockW, ...lines[i].map((s) => textW(s, st)));
    }
  }
  a.lab = { rot: rot === -90 ? -90 : 0, skip, lines, blockH, blockW, lh };
}

function axisTitleBlock(env, a) {
  if (!a.m.title || a.deleted) return null;
  const vert = a.dir === "v";
  const blk = textBlock(env, "axisTitle", a.m.title, "Axis Title", env.W * 0.8);
  const explicit = a.m.title.base && a.m.title.base.rot !== undefined ? a.m.title.base.rot : a.m.title.tx && a.m.title.tx.rot !== undefined ? a.m.title.tx.rot : undefined;
  blk.rot = vert ? (explicit === 0 ? 0 : -90) : explicit === -90 ? -90 : 0;
  blk.thick = vert ? (blk.rot === -90 ? blk.h : blk.w) : blk.rot === -90 ? blk.w : blk.h;
  return blk;
}

function measureAxes(env, axes, P) {
  for (const a of axes) if (a.role === "val") computeValScale(env, a, a.dir === "h" ? P.w : P.h);
  for (const a of axes) {
    if (a.role === "cat") computeCatLabels(env, a, a.dir === "h" ? P.w : P.h);
    a.place = labelPlacement(a);
    const gap = (a.dir === "v" ? 5 : 4) * clamp(a.m.lblOffset / 100, 0, 10);
    let labelSize = 0;
    if (a.place) {
      if (a.role === "val") labelSize = a.dir === "v" ? Math.max(0, ...a.labels.map((s) => textW(s, a.ts))) : lineH(a.ts);
      else labelSize = a.dir === "v" ? a.lab.blockW : a.lab.blockH;
    }
    a.gap = gap;
    a.thick = a.place ? gap + labelSize + tickOut(a) : 0;
    a.titleBlk = axisTitleBlock(env, a);
    a.unitBlk = null;
    if (!a.deleted && a.m.dispUnits && a.m.dispUnits.label) {
      const st = textStyle(env, "axis", a.m.tx, a.m.dispUnits.tx);
      a.unitBlk = { text: a.m.dispUnits.label, st, thick: lineH(st) };
    }
  }
}

function plotMargins(env, axes) {
  const m = { l: 0, r: 0, t: 0, b: 0 };
  for (const a of axes) {
    if (a.deleted) continue;
    const side = a.place ? a.place.side : a.dir === "v" ? "l" : "b";
    a.offset = 0;
    if (a.place && a.place.edge) {
      a.offset = m[side];
      m[side] += a.thick;
    }
    if (a.unitBlk && a.dir === "v") { a.unitOffset = m[side]; m[side] += a.unitBlk.thick + 2; }
    if (a.titleBlk) {
      a.titleSide = side;
      m[side] += a.titleBlk.thick + 6;
    }
  }
  for (const a of axes) {
    if (a.deleted || !a.place) continue;
    const lh = lineH(a.ts);
    if (a.dir === "v") {
      if (a.role === "val") {
        m.t = Math.max(m.t, lh / 2 + 1);
        m.b = Math.max(m.b, lh / 2 + 1);
      }
    } else if (a.role === "val" && a.labels.length) {
      const w0 = textW(a.labels[0], a.ts) / 2, w1 = textW(a.labels[a.labels.length - 1], a.ts) / 2;
      const left = a.m.orient === "maxMin" ? w1 : w0, right = a.m.orient === "maxMin" ? w0 : w1;
      m.l = Math.max(m.l, left + 1);
      m.r = Math.max(m.r, right + 1);
    } else if (a.role === "cat" && !a.between && a.lab && a.lab.rot === 0) {
      // labels centred on the plot edges (midCat) overhang by half their width
      const half = (i) => Math.max(0, ...(a.lab.lines[i] || [""]).map((s) => textW(s, a.ts))) / 2;
      const last = Math.floor((a.n - 1) / a.lab.skip) * a.lab.skip;
      const w0 = half(0), w1 = half(last);
      const left = a.m.orient === "maxMin" ? w1 : w0, right = a.m.orient === "maxMin" ? w0 : w1;
      m.l = Math.max(m.l, left + 1);
      m.r = Math.max(m.r, right + 1);
    }
  }
  m.l = Math.max(m.l, 4);
  m.r = Math.max(m.r, 6);
  m.t = Math.max(m.t, 4);
  m.b = Math.max(m.b, 4);
  return m;
}

function manualRect(lay, auto, W, H) {
  if (!lay || lay.w == null || lay.h == null) {
    if (!lay || (lay.x == null && lay.y == null)) return null;
  }
  const x = lay.x != null ? (lay.xMode === "edge" ? lay.x * W : auto.x + lay.x * W) : auto.x;
  const y = lay.y != null ? (lay.yMode === "edge" ? lay.y * H : auto.y + lay.y * H) : auto.y;
  let w = lay.w != null ? (lay.wMode === "edge" ? lay.w * W - x : lay.w * W) : auto.w;
  let h = lay.h != null ? (lay.hMode === "edge" ? lay.h * H - y : lay.h * H) : auto.h;
  if (lay.w == null && lay.xMode !== "edge") w = auto.w;
  return { x, y, w: Math.max(4, w), h: Math.max(4, h) };
}

function layoutPlot(env, rgs, axes, area) {
  const lay = env.model.plot.layout;
  let outer = { ...area }, fixed = null;
  const mr = manualRect(lay, area, env.W, env.H);
  if (mr) { if (lay.target === "inner") fixed = mr; else outer = mr; }
  if (!axes.length) {
    const P = fixed || { x: outer.x + 2, y: outer.y + 2, w: Math.max(4, outer.w - 4), h: Math.max(4, outer.h - 4) };
    return { P, outer };
  }
  let P = fixed || { x: outer.x + 30, y: outer.y + 8, w: Math.max(10, outer.w - 40), h: Math.max(10, outer.h - 30) };
  for (let pass = 0; pass < 5; pass++) {
    measureAxes(env, axes, P);
    const m = plotMargins(env, axes);
    if (fixed) break;
    const nP = { x: outer.x + m.l, y: outer.y + m.t, w: Math.max(10, outer.w - m.l - m.r), h: Math.max(10, outer.h - m.t - m.b) };
    const same = Math.abs(nP.x - P.x) + Math.abs(nP.y - P.y) + Math.abs(nP.w - P.w) + Math.abs(nP.h - P.h) < 0.5;
    P = nP;
    if (same) break;
  }
  measureAxes(env, axes, P);
  plotMargins(env, axes);
  return { P, outer };
}

// ---------------------------------------------------------------------------------------------
// Text blocks (titles)
// ---------------------------------------------------------------------------------------------

/** Builds a multi-run text block: { lines: [{runs:[{text, st, w}], w, h}], w, h }. */
function textBlock(env, kind, t, autoText, maxW) {
  const baseSt = [t && t.tx, t && t.base];
  let lines = t && t.lines && t.lines.length ? t.lines : [[{ text: autoText }]];
  const out = [];
  for (const line of lines) {
    const runs = line.filter((r) => r.text !== "").map((r) => {
      const st = textStyle(env, kind, ...baseSt, r);
      return { text: r.text, st, w: textW(r.text, st) };
    });
    if (!runs.length) {
      const st = textStyle(env, kind, ...baseSt);
      out.push({ runs: [], w: 0, h: lineH(st) });
      continue;
    }
    let w = runs.reduce((s, r) => s + r.w, 0);
    if (runs.length === 1 && w > maxW) {
      const wr = wrapWords(runs[0].text, maxW, runs[0].st) || [runs[0].text];
      for (const s of wr) out.push({ runs: [{ text: s, st: runs[0].st, w: textW(s, runs[0].st) }], w: textW(s, runs[0].st), h: lineH(runs[0].st) });
      continue;
    }
    out.push({ runs, w, h: Math.max(...runs.map((r) => lineH(r.st))) });
  }
  return { lines: out, w: Math.max(0, ...out.map((l) => l.w)), h: out.reduce((s, l) => s + l.h, 0) };
}

/** Draws a block centred at (cx, cy). rot -90 reads bottom-to-top. */
function drawBlock(env, blk, cx, cy, rot) {
  if (rot === -90) {
    let x = cx - blk.h / 2;
    for (const line of blk.lines) {
      const lx = x + line.h / 2;
      if (line.runs.length === 1) emitText(env, line.runs[0].text, lx, cy, line.runs[0].st, "middle", "middle", -90);
      else {
        let y = cy + line.w / 2;
        for (const r of line.runs) { emitText(env, r.text, lx, y, r.st, "start", "middle", -90); y -= r.w; }
      }
      x += line.h;
    }
    return;
  }
  let y = cy - blk.h / 2;
  for (const line of blk.lines) {
    const ly = y + line.h / 2;
    if (line.runs.length === 1) emitText(env, line.runs[0].text, cx, ly, line.runs[0].st, "middle", "middle");
    else {
      let x = cx - line.w / 2;
      for (const r of line.runs) { emitText(env, r.text, x, ly, r.st, "start", "middle"); x += r.w; }
    }
    y += line.h;
  }
}

// ---------------------------------------------------------------------------------------------
// Title and legend
// ---------------------------------------------------------------------------------------------

function layoutTitle(env, rgs, area) {
  const model = env.model;
  const T = model.title;
  let auto = null;
  const all = rgs.flatMap((rg) => rg.series);
  if (T) {
    if (!T.lines || !T.lines.length) auto = all.length === 1 ? all[0].name : "Chart Title";
  } else if (!model.autoTitleDeleted && all.length === 1) {
    auto = all[0].name;
  } else return null;
  const blk = textBlock(env, "title", T, auto, env.W * 0.8);
  if (!blk.lines.length) return null;
  const mr = T && T.layout ? manualRect(T.layout, { x: 0, y: 0, w: env.W, h: env.H }, env.W, env.H) : null;
  if (mr && T.layout.x != null && T.layout.xMode === "edge") {
    blk.cx = mr.x + blk.w / 2 + 4;
    blk.cy = mr.y + blk.h / 2 + 2;
  } else {
    blk.cx = env.W / 2;
    blk.cy = area.y + 1 + blk.h / 2;
    if (!(T && T.overlay)) {
      const used = blk.h + 1 + 5;
      area.y += used;
      area.h -= used;
    }
  }
  blk.sp = T && T.sp;
  return blk;
}

function legendEntries(env, rgs) {
  const L = env.model.legend;
  const del = new Set(L.deleted);
  const entries = [];
  const first = rgs[0];
  const pointMode = first && (first.type === "pie" || first.type === "doughnut" || (first.vary && env.nSeries === 1));
  if (pointMode) {
    const rg = first, rs = rg.series[0];
    const cats = rg.catAx ? rg.catAx.labels : null;
    const n = rs.nPts;
    for (let i = 0; i < n; i++) {
      if (del.has(i)) continue;
      const c = rs.s.cat && rs.s.cat.v[i];
      let text = cats ? cats[i] : c != null ? (typeof c === "number" ? env.fmt(c, rs.s.cat.fmt) : String(c)) : String(i + 1);
      entries.push({ text, key: keyFor(env, rg, rs, i) });
    }
    return entries;
  }
  for (const rg of rgs) {
    let list = rg.series.slice();
    if (rg.type === "pie" || rg.type === "doughnut") list = list.slice(0, rg.type === "pie" ? 1 : list.length);
    const vertical = L.pos === "r" || L.pos === "l" || L.pos === "tr";
    const g = rg.g;
    const reverse = vertical && ((rg.type === "bar" && (g.barDir === "bar" || g.grouping !== "clustered")) || (rg.type === "area" && g.grouping !== "standard"));
    if (reverse) list.reverse();
    for (const rs of list) {
      if (del.has(rs.s.idx)) continue;
      entries.push({ text: rs.name, key: keyFor(env, rg, rs, null) });
    }
  }
  return entries;
}

function keyFor(env, rg, rs, i) {
  const t = rg.type;
  const st = i == null ? rs.style : pointStyle(env, rg, rs, i);
  if (t === "line" || t === "scatter" || (t === "radar" && rg.g.radarStyle !== "filled")) {
    const mk = markerOf(env, rg, rs, i == null ? -1 : i);
    return { kind: "line", line: st.line, marker: mk };
  }
  return { kind: "box", st };
}

function layoutLegend(env, rgs, area) {
  const L = env.model.legend;
  if (!L) return null;
  const entries = legendEntries(env, rgs);
  if (!entries.length) return null;
  const st = textStyle(env, "legend", L.tx);
  const lh = lineH(st);
  const rowH = lh + 2;
  const box = Math.round(st.px * 0.58);
  for (const e of entries) {
    e.keyW = e.key.kind === "line" ? Math.round(st.px * 1.75) : box;
    e.w = e.keyW + 4 + textW(e.text, st);
  }
  const pos = L.pos;
  const vertical = pos === "r" || pos === "l" || pos === "tr";
  const padX = 4, padY = 2, entryGap = Math.round(st.px * 0.9), sideGap = 8;
  const leg = { st, rowH, box, entries, vertical, rows: [] };
  const mr = L.layout ? manualRect(L.layout, area, env.W, env.H) : null;
  if (vertical) {
    const colW = Math.max(...entries.map((e) => e.w));
    const maxRows = Math.max(1, Math.floor((area.h - 2 * padY) / rowH));
    const shown = entries.slice(0, maxRows);
    leg.rows = shown.map((e) => [e]);
    leg.w = colW + 2 * padX;
    leg.h = shown.length * rowH + 2 * padY;
    leg.x = pos === "l" ? area.x : area.x + area.w - leg.w;
    leg.y = pos === "tr" ? area.y : area.y + (area.h - leg.h) / 2;
    if (mr) { leg.x = mr.x; leg.y = mr.y; }
    else if (!L.overlay) {
      if (pos === "l") area.x += leg.w + sideGap;
      area.w -= leg.w + sideGap;
    }
  } else {
    const maxW = (mr ? mr.w : area.w) - 2 * padX;
    let row = [], rw = 0;
    for (const e of entries) {
      const add = (row.length ? entryGap : 0) + e.w;
      if (row.length && rw + add > maxW) { leg.rows.push(row); row = []; rw = 0; }
      rw += (row.length ? entryGap : 0) + e.w;
      row.push(e);
    }
    if (row.length) leg.rows.push(row);
    const maxRows = Math.max(1, Math.floor((area.h * 0.5) / rowH));
    leg.rows = leg.rows.slice(0, maxRows);
    leg.rowW = leg.rows.map((r) => r.reduce((s, e, k) => s + e.w + (k ? entryGap : 0), 0));
    leg.w = Math.max(...leg.rowW) + 2 * padX;
    leg.h = leg.rows.length * rowH + 2 * padY;
    leg.x = area.x + (area.w - leg.w) / 2;
    leg.y = pos === "t" ? area.y : area.y + area.h - leg.h;
    if (mr) { leg.x = mr.x; leg.y = mr.y; }
    else if (!L.overlay) {
      if (pos === "t") area.y += leg.h + 4;
      area.h -= leg.h + 4;
    }
  }
  leg.entryGap = entryGap;
  leg.padX = padX;
  leg.padY = padY;
  leg.sp = L.sp;
  return leg;
}

function drawLegend(env, leg) {
  if (!leg) return;
  const bg = shapeStyle(env, leg.sp, { fill: null, ln: null });
  emitRect(env, leg.x, leg.y, leg.w, leg.h, bg);
  leg.rows.forEach((row, ri) => {
    const cy = leg.y + leg.padY + ri * leg.rowH + leg.rowH / 2;
    let x = leg.vertical ? leg.x + leg.padX : leg.x + (leg.w - leg.rowW[ri]) / 2;
    for (const e of row) {
      const k = e.key;
      if (k.kind === "line") {
        if (k.line) emitLine(env, [[x, cy], [x + e.keyW, cy]], { ...k.line, w: Math.min(k.line.w, 3) });
        if (k.marker) drawMarker(env, k.marker.sym, x + e.keyW / 2, cy, Math.min(k.marker.px, 7), k.marker.st);
      } else {
        const st = { fill: k.st.fill, line: k.st.line ? { ...k.st.line, w: Math.min(k.st.line.w, 1.5) } : null };
        if (!st.fill && !st.line) st.line = { c: "#808080", a: 1, w: 1 };
        emitRect(env, x, cy - leg.box / 2, leg.box, leg.box, st);
      }
      emitText(env, e.text, x + e.keyW + 4, cy, leg.st, "start", "middle");
      x += e.w + leg.entryGap;
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Data labels
// ---------------------------------------------------------------------------------------------

function labelSpec(env, rg, rs, i) {
  const gl = rg.g.dLbls, sl = rs.s.dLbls;
  const pl = sl && sl.points ? sl.points[i] : gl && gl.points ? gl.points[i] : null;
  if (!gl && !sl && !pl) return null;
  if (pl && pl.del) return null;
  if (!pl && ((sl && sl.del) || (!sl && gl && gl.del))) return null;
  const chain = [pl, sl, gl].filter(Boolean);
  const get = (k, d) => { for (const c of chain) if (c[k] !== undefined) return c[k]; return d; };
  const e = {};
  for (const [k] of SHOW_FLAGS) e[k] = get(k, true);
  e.pos = get("pos", null);
  e.numFmt = get("numFmt", null);
  e.sep = get("sep", null);
  e.sp = get("sp", null);
  e.text = pl ? pl.text : undefined;
  e.st = textStyle(env, "label", gl && gl.tx, sl && sl.tx, pl && pl.tx);
  return e;
}

function labelText(env, rg, rs, i, e, v, extra) {
  if (e.text != null) return e.text;
  const parts = [];
  const s = rs.s;
  if (e.ser) parts.push(rs.name);
  if (e.cat) {
    if (rg.type === "scatter" || rg.type === "bubble") {
      const xv = s.x && s.x.v[i];
      parts.push(xv == null ? String(i + 1) : typeof xv === "number" ? env.fmt(xv, s.x.fmt) : String(xv));
    } else {
      const c = rg.catAx ? rg.catAx.labels[i] : s.cat ? s.cat.v[i] : null;
      parts.push(c == null ? String(i + 1) : typeof c === "number" ? env.fmt(c, s.cat.fmt) : String(c));
    }
  }
  const code = e.numFmt && !e.numFmt.linked ? e.numFmt.code : (rg.type === "scatter" || rg.type === "bubble" ? s.y && s.y.fmt : s.val && s.val.fmt) || "General";
  if (e.val && v != null) parts.push(env.fmt(v, code));
  if (e.pct && extra && extra.pct != null) {
    const pc = e.numFmt && !e.numFmt.linked && /%/.test(e.numFmt.code) ? e.numFmt.code : "0%";
    parts.push(env.fmt(extra.pct, pc));
  }
  if (e.bub && extra && extra.size != null) parts.push(env.fmt(extra.size, (s.size && s.size.fmt) || "General"));
  if (!parts.length) return "";
  let sep = e.sep != null ? e.sep : ", ";
  return parts.join(sep);
}

/** Queues a label: text at (x,y) with anchor/base; drawn after all series. */
function queueLabel(env, e, text, x, y, anchor, base, keySt) {
  if (!text) return;
  env.labels.push({ e, text, x, y, anchor, base, keySt });
}

function drawLabels(env) {
  for (const L of env.labels) {
    const st = L.e.st;
    const lines = String(L.text).split(/\r?\n/);
    const lh = lineH(st);
    const w = Math.max(...lines.map((s) => textW(s, st)));
    const h = lines.length * lh;
    const showKey = L.e.key && L.keySt;
    const kw = showKey ? st.px * 0.6 + 3 : 0;
    const tw = w + kw;
    let left = L.anchor === "start" ? L.x : L.anchor === "end" ? L.x - tw : L.x - tw / 2;
    let top = L.base === "top" ? L.y : L.base === "bottom" ? L.y - h : L.y - h / 2;
    if (L.e.sp) {
      const bg = shapeStyle(env, L.e.sp, { fill: null, ln: null });
      emitRect(env, left - 2, top - 1, tw + 4, h + 2, bg);
    }
    if (showKey) {
      const k = st.px * 0.6;
      emitRect(env, left, top + lh / 2 - k / 2, k, k, L.keySt);
    }
    const cx = left + kw + w / 2;
    lines.forEach((s, k) => emitText(env, s, cx, top + k * lh + lh / 2, st, "middle", "middle"));
  }
}

// ---------------------------------------------------------------------------------------------
// Plot types
// ---------------------------------------------------------------------------------------------

function seriesValue(s, i) {
  const v = s.val && s.val.v[i];
  return isNum(v) ? v : null;
}

/** Stack bases for stacked groupings: returns per series per category [v0, v1, raw]. */
function stackValues(rg, n, blanksZero) {
  const g = rg.g;
  const stacked = g.grouping === "stacked" || g.grouping === "percentStacked";
  const pct = g.grouping === "percentStacked";
  const tot = new Array(n).fill(0);
  if (pct) for (let i = 0; i < n; i++) for (const rs of rg.series) { const v = seriesValue(rs.s, i); if (v != null) tot[i] += Math.abs(v); }
  const pos = new Array(n).fill(0), neg = new Array(n).fill(0);
  return rg.series.map((rs) => {
    const arr = [];
    for (let i = 0; i < n; i++) {
      let v = seriesValue(rs.s, i);
      if (v == null) { if (blanksZero) v = 0; else { arr.push(null); continue; } }
      if (!stacked) { arr.push([null, v, v]); continue; }
      const sv = pct ? (tot[i] ? v / tot[i] : 0) : v;
      if (rg.type === "bar") {
        if (sv >= 0) { arr.push([pos[i], pos[i] + sv, v]); pos[i] += sv; }
        else { arr.push([neg[i], neg[i] + sv, v]); neg[i] += sv; }
      } else {
        arr.push([pos[i], pos[i] + sv, v]);
        pos[i] += sv;
      }
    }
    return arr;
  });
}

function drawBars(env, rg, P) {
  const g = rg.g, cat = rg.catAx, va = rg.valAx;
  const n = cat.n;
  const horiz = cat.dir === "v"; // bars grow horizontally
  const len = cat.dir === "h" ? P.w : P.h;
  const band = len * bandFrac(cat);
  const stacked = g.grouping !== "clustered";
  const nS = stacked ? 1 : rg.series.length;
  const ov = clamp(g.overlap, -100, 100) / 100;
  const gap = clamp(g.gapWidth, 0, 500) / 100;
  const bw = band / (nS - (nS - 1) * ov + gap);
  const base = crossValue(cat, va);
  const vals = stackValues(rg, n, false);
  const defPos = stacked ? "ctr" : "outEnd";
  rg.series.forEach((rs, k) => {
    const slot = stacked ? 0 : k;
    for (let i = 0; i < n; i++) {
      const sv = vals[k][i];
      if (!sv) continue;
      const v0 = stacked ? sv[0] : base, v1 = sv[1], raw = sv[2];
      const o0 = (bw * gap) / 2 + slot * bw * (1 - ov);
      const f0 = catFrac(cat, i, 0) + (o0 / len);
      const f1 = f0 + bw / len;
      const a0 = axisPx(cat, P, f0), a1 = axisPx(cat, P, f1);
      const p0 = valPx(va, P, v0), p1 = valPx(va, P, v1);
      let st = pointStyle(env, rg, rs, i);
      const pt = rs.s.points && rs.s.points[i];
      const inv = pt && pt.invert !== undefined ? pt.invert : rs.s.invertIfNegative !== undefined ? rs.s.invertIfNegative : true;
      if (raw < 0 && inv && st.fill) st = { fill: rs.s.invertFill ? env.color(rs.s.invertFill) : { c: "#ffffff", a: st.fill.a }, line: st.line };
      if (horiz) emitRect(env, Math.min(p0, p1), Math.min(a0, a1), Math.abs(p1 - p0), Math.abs(a1 - a0), st);
      else emitRect(env, Math.min(a0, a1), Math.min(p0, p1), Math.abs(a1 - a0), Math.abs(p1 - p0), st);
      const e = labelSpec(env, rg, rs, i);
      if (!e) continue;
      const text = labelText(env, rg, rs, i, e, raw, null);
      if (!text) continue;
      const pos = e.pos || defPos;
      const mid = (a0 + a1) / 2;
      // direction of growth in pixels along value axis
      const dir = Math.sign(p1 - p0) || (horiz ? 1 : -1);
      const lh = lineH(e.st);
      let x, y, anchor = "middle", base2 = "middle";
      if (!horiz) {
        x = mid;
        const up = dir < 0;
        if (pos === "inBase") { y = p0 + (up ? -3 : 3); base2 = up ? "bottom" : "top"; }
        else if (pos === "ctr") { y = (p0 + p1) / 2; }
        else if (pos === "inEnd") { y = p1 + (up ? 3 : -3); base2 = up ? "top" : "bottom"; }
        else { y = p1 + (up ? -3 : 3); base2 = up ? "bottom" : "top"; }
        if (base2 === "top" && y + lh > P.y + P.h + lh) y = P.y + P.h - lh;
      } else {
        y = mid;
        const right = dir > 0;
        if (pos === "inBase") { x = p0 + (right ? 3 : -3); anchor = right ? "start" : "end"; }
        else if (pos === "ctr") { x = (p0 + p1) / 2; }
        else if (pos === "inEnd") { x = p1 + (right ? -3 : 3); anchor = right ? "end" : "start"; }
        else { x = p1 + (right ? 3 : -3); anchor = right ? "start" : "end"; }
      }
      queueLabel(env, e, text, x, y, anchor, base2, st);
    }
  });
}

function catPoint(rg, P, i) {
  return axisPx(rg.catAx, P, catFrac(rg.catAx, i, 0.5));
}

function drawLines(env, rg, P) {
  const g = rg.g, cat = rg.catAx, va = rg.valAx;
  const n = cat.n;
  const blanks = env.model.dispBlanksAs;
  const vals = stackValues(rg, n, blanks === "zero");
  const horiz = cat.dir === "v";
  const xy = (i, v) => {
    const c = catPoint(rg, P, i), p = valPx(va, P, v);
    return horiz ? [p, c] : [c, p];
  };
  const allPts = [], allSegs = [];
  rg.series.forEach((rs, k) => {
    const segs = [];
    let cur = [];
    const pts = [];
    for (let i = 0; i < n; i++) {
      const sv = vals[k][i];
      if (!sv) {
        if (blanks !== "span" && cur.length) { segs.push(cur); cur = []; }
        pts.push(null);
        continue;
      }
      const p = xy(i, sv[1]);
      cur.push(p);
      pts.push(p);
    }
    if (cur.length) segs.push(cur);
    allPts.push(pts);
    allSegs.push(segs);
  });
  // drop lines / high-low lines / up-down bars (behind the series lines)
  if (g.hiLowLines || g.dropLines || g.upDownBars) {
    const auto = { fill: null, ln: { fill: rgb("#404040"), w: 1 } };
    for (let i = 0; i < n; i++) {
      const col = allPts.map((p) => p[i]).filter(Boolean);
      if (!col.length) continue;
      const ys = col.map((p) => (horiz ? p[0] : p[1]));
      const c = horiz ? col[0][1] : col[0][0];
      if (g.hiLowLines && col.length > 1) {
        const st = shapeStyle(env, g.hiLowLines, auto);
        const a = Math.min(...ys), b = Math.max(...ys);
        emitLine(env, horiz ? [[a, c], [b, c]] : [[c, a], [c, b]], st.line);
      }
      if (g.dropLines) {
        const st = shapeStyle(env, g.dropLines, auto);
        const axisAt = crossPx(cat, P);
        const top = horiz ? Math.max(...ys) : Math.min(...ys);
        emitLine(env, horiz ? [[top, c], [axisAt, c]] : [[c, top], [c, axisAt]], st.line);
      }
      if (g.upDownBars && allPts.length > 1) {
        const p0 = allPts[0][i], p1 = allPts[allPts.length - 1][i];
        if (!p0 || !p1) continue;
        const v0 = horiz ? p0[0] : p0[1], v1 = horiz ? p1[0] : p1[1];
        const up = horiz ? v1 > v0 : v1 < v0;
        const bandPx = (cat.dir === "h" ? P.w : P.h) * bandFrac(cat);
        const bw = bandPx / (1 + clamp(g.upDownBars.gapWidth, 0, 500) / 100);
        const st = shapeStyle(env, up ? g.upDownBars.up : g.upDownBars.down, { fill: rgb(up ? "#ffffff" : "#404040"), ln: { fill: rgb("#404040"), w: 1 } });
        if (horiz) emitRect(env, Math.min(v0, v1), c - bw / 2, Math.abs(v1 - v0), bw, st);
        else emitRect(env, c - bw / 2, Math.min(v0, v1), bw, Math.abs(v1 - v0), st);
      }
    }
  }
  rg.series.forEach((rs, k) => {
    const line = rs.style.line;
    if (line) for (const sg of allSegs[k]) emitLine(env, rs.smooth ? smoothPts(sg) : sg, line);
  });
  rg.series.forEach((rs, k) => {
    for (let i = 0; i < n; i++) {
      const p = allPts[k][i];
      if (!p) continue;
      const mk = markerOf(env, rg, rs, i);
      if (mk) drawMarker(env, mk.sym, p[0], p[1], mk.px, mk.st);
      const e = labelSpec(env, rg, rs, i);
      if (!e) continue;
      const text = labelText(env, rg, rs, i, e, vals[k][i][2], null);
      pointLabel(env, e, text, p, mk ? mk.px / 2 : 2, e.pos || "r", mk ? mk.st : rs.style);
    }
  });
}

function pointLabel(env, e, text, p, r, pos, keySt) {
  const d = r + 3;
  switch (pos) {
    case "t": return queueLabel(env, e, text, p[0], p[1] - d, "middle", "bottom", keySt);
    case "b": return queueLabel(env, e, text, p[0], p[1] + d, "middle", "top", keySt);
    case "l": return queueLabel(env, e, text, p[0] - d, p[1], "end", "middle", keySt);
    case "ctr": return queueLabel(env, e, text, p[0], p[1], "middle", "middle", keySt);
    case "outEnd": return queueLabel(env, e, text, p[0], p[1] - d, "middle", "bottom", keySt);
    default: return queueLabel(env, e, text, p[0] + d, p[1], "start", "middle", keySt);
  }
}

function drawAreas(env, rg, P) {
  const g = rg.g, cat = rg.catAx, va = rg.valAx;
  const n = cat.n;
  const vals = stackValues(rg, n, true);
  const stacked = g.grouping !== "standard";
  const base = crossValue(cat, va);
  const horiz = cat.dir === "v";
  const xy = (i, v) => {
    const c = catPoint(rg, P, i), p = valPx(va, P, v);
    return horiz ? [p, c] : [c, p];
  };
  const tops = [];
  rg.series.forEach((rs, k) => {
    const top = [], bot = [];
    for (let i = 0; i < n; i++) {
      const sv = vals[k][i] || [0, 0, 0];
      const v0 = stacked ? sv[0] : base;
      top.push(xy(i, sv[1]));
      bot.push(xy(i, v0));
    }
    tops.push(top);
    if (n === 1) {
      const w = 2;
      emitPoly(env, [[top[0][0] - w, top[0][1]], [top[0][0] + w, top[0][1]], [bot[0][0] + w, bot[0][1]], [bot[0][0] - w, bot[0][1]]], rs.style);
    } else emitPoly(env, top.concat(bot.slice().reverse()), rs.style);
  });
  if (g.dropLines) {
    const st = shapeStyle(env, g.dropLines, { fill: null, ln: { fill: rgb("#404040"), w: 1 } });
    for (let i = 0; i < n; i++) {
      const t = tops[tops.length - 1][i];
      const b = xy(i, base);
      emitLine(env, [t, b], st.line);
    }
  }
  rg.series.forEach((rs, k) => {
    for (let i = 0; i < n; i++) {
      const sv = vals[k][i];
      if (!sv) continue;
      const e = labelSpec(env, rg, rs, i);
      if (!e) continue;
      const v0 = stacked ? sv[0] : base;
      const p = xy(i, (v0 + sv[1]) / 2);
      queueLabel(env, e, labelText(env, rg, rs, i, e, sv[2], null), p[0], p[1], "middle", "middle", rs.style);
    }
  });
}

function scatterPoints(env, rg, rs, P) {
  const s = rs.s;
  const yd = s.y || s.val;
  const n = Math.max(yd ? yd.v.length : 0, s.x ? s.x.v.length : 0);
  const textX = !s.x || !s.x.num;
  const blanks = env.model.dispBlanksAs;
  const pts = [];
  for (let i = 0; i < n; i++) {
    let y = yd ? yd.v[i] : null;
    let x = textX ? i + 1 : s.x.v[i];
    if (!isNum(y)) { if (blanks === "zero" && yd && i < yd.v.length) y = 0; else { pts.push(null); continue; } }
    if (!isNum(x)) x = textX ? i + 1 : 0;
    pts.push({ i, x, y, p: [valPx(rg.xAx, P, x), valPx(rg.yAx, P, y)] });
  }
  return pts;
}

function drawScatter(env, rg, P) {
  const blanks = env.model.dispBlanksAs;
  const all = rg.series.map((rs) => scatterPoints(env, rg, rs, P));
  rg.series.forEach((rs, k) => {
    const line = rs.style.line;
    if (!line) return;
    const segs = [];
    let cur = [];
    for (const q of all[k]) {
      if (!q) { if (blanks !== "span" && cur.length) { segs.push(cur); cur = []; } continue; }
      cur.push(q.p);
    }
    if (cur.length) segs.push(cur);
    for (const sg of segs) emitLine(env, rs.smooth ? smoothPts(sg) : sg, line);
  });
  rg.series.forEach((rs, k) => {
    for (const q of all[k]) {
      if (!q) continue;
      const mk = markerOf(env, rg, rs, q.i);
      if (mk) drawMarker(env, mk.sym, q.p[0], q.p[1], mk.px, mk.st);
      const e = labelSpec(env, rg, rs, q.i);
      if (!e) continue;
      pointLabel(env, e, labelText(env, rg, rs, q.i, e, q.y, null), q.p, mk ? mk.px / 2 : 2, e.pos || "r", mk ? mk.st : rs.style);
    }
  });
}

function drawBubbles(env, rg, P) {
  const g = rg.g;
  let maxS = 0;
  for (const rs of rg.series) if (rs.s.size) for (const v of rs.s.size.v) if (isNum(v)) maxS = Math.max(maxS, Math.abs(v));
  const rMax = (Math.min(P.w, P.h) * 0.25 * (g.bubbleScale / 100)) / 2;
  rg.series.forEach((rs) => {
    const pts = scatterPoints(env, rg, rs, P);
    for (const q of pts) {
      if (!q) continue;
      const sz = rs.s.size ? rs.s.size.v[q.i] : 1;
      if (!isNum(sz) || (sz < 0 && !g.showNegBubbles) || sz === 0) continue;
      const rel = maxS ? Math.abs(sz) / maxS : 1;
      const r = Math.max(1, rMax * (g.sizeRepresents === "w" ? rel : Math.sqrt(rel)));
      let st = pointStyle(env, rg, rs, q.i);
      if (sz < 0) st = { fill: { c: "#ffffff", a: 1 }, line: st.line || (st.fill && { c: st.fill.c, a: 1, w: 1 }) };
      emitPoly(env, circlePts(q.p[0], q.p[1], r), st);
      const e = labelSpec(env, rg, rs, q.i);
      if (!e) continue;
      pointLabel(env, e, labelText(env, rg, rs, q.i, e, q.y, { size: sz }), q.p, r, e.pos || "ctr", st);
    }
  });
}

/** Whether a label of width tw fits inside a slice (bestFit puts it inside, else outside). */
function fitsInSlice(R, sweep, tw) {
  if (sweep >= TAU - 1e-9) return true;
  const chord = 2 * R * 0.62 * Math.sin(Math.min(sweep, Math.PI) / 2);
  return chord >= Math.min(tw, R * 0.9) + 4;
}

function drawPie(env, rg, P) {
  const g = rg.g;
  const doughnut = rg.type === "doughnut";
  const list = doughnut ? rg.series : rg.series.slice(0, 1);
  if (!list.length) return;
  const cx = P.x + P.w / 2, cy = P.y + P.h / 2;
  // label room: outside labels (outEnd, or bestFit labels that do not fit their slice) shrink the pie
  let outside = false, labW = 0, labH = 0;
  let R = Math.min(P.w, P.h) / 2 - 2;
  if (!doughnut) {
    const rs = list[0];
    const vals = [];
    let total = 0;
    for (let i = 0; i < rs.nPts; i++) { const v = Math.abs(seriesValue(rs.s, i) || 0); vals.push(v); total += v; }
    for (let i = 0; i < rs.nPts; i++) {
      const e = labelSpec(env, rg, rs, i);
      if (!e || !vals[i]) continue;
      const text = labelText(env, rg, rs, i, e, seriesValue(rs.s, i), { pct: total ? vals[i] / total : 0 });
      if (!text) continue;
      const pos = e.pos || "bestFit";
      const tw = Math.max(...text.split(/\r?\n/).map((t) => textW(t, e.st)));
      const sweep = total ? (vals[i] / total) * TAU : 0;
      if (pos === "outEnd" || (pos === "bestFit" && !fitsInSlice(R, sweep, tw))) {
        outside = true;
        labW = Math.max(labW, tw);
        labH = Math.max(labH, text.split(/\r?\n/).length * lineH(e.st));
      }
    }
  }
  if (outside) R = Math.min(P.h / 2 - labH - 6, P.w / 2 - Math.min(labW, P.w / 4) - 8);
  R = Math.max(8, R);
  let maxEx = 0;
  for (const rs of list) {
    maxEx = Math.max(maxEx, rs.s.explosion || 0);
    if (rs.s.points) for (const k in rs.s.points) maxEx = Math.max(maxEx, rs.s.points[k].explosion || 0);
  }
  const R0 = R / (1 + Math.min(maxEx, 400) / 100);
  const hole = doughnut ? (R0 * g.holeSize) / 100 : 0;
  const ringW = doughnut ? (R0 - hole) / list.length : R0;
  const start = ((g.firstSliceAng || 0) * Math.PI) / 180;
  list.forEach((rs, k) => {
    const s = rs.s;
    const n = rs.nPts;
    const vals = [];
    let total = 0;
    for (let i = 0; i < n; i++) { const v = seriesValue(s, i); vals.push(v == null ? 0 : Math.abs(v)); total += v == null ? 0 : Math.abs(v); }
    if (!(total > 0)) return;
    const rIn = doughnut ? hole + k * ringW : 0;
    const rOut = doughnut ? rIn + ringW : R0;
    let a = start;
    for (let i = 0; i < n; i++) {
      const v = vals[i];
      if (!v) continue;
      const sweep = (v / total) * TAU;
      const mid = a + sweep / 2;
      const ex = (((s.points && s.points[i] && s.points[i].explosion) ?? s.explosion ?? 0) / 100) * R0;
      const ox = Math.sin(mid) * ex, oy = -Math.cos(mid) * ex;
      const st = pointStyle(env, rg, rs, i);
      const ccx = cx + ox, ccy = cy + oy;
      let pts;
      if (doughnut) {
        const outer = arcPts(ccx, ccy, rOut, a, a + sweep);
        const inner = arcPts(ccx, ccy, rIn, a + sweep, a);
        pts = outer.concat(inner);
      } else if (sweep >= TAU - 1e-9) pts = circlePts(ccx, ccy, rOut);
      else pts = [[ccx, ccy]].concat(arcPts(ccx, ccy, rOut, a, a + sweep));
      emitPoly(env, pts, st);
      const e = labelSpec(env, rg, rs, i);
      if (e) {
        const text = labelText(env, rg, rs, i, e, seriesValue(s, i), { pct: v / total });
        if (text) {
          let pos = e.pos || (doughnut ? "ctr" : "bestFit");
          const lines = text.split(/\r?\n/);
          const tw = Math.max(...lines.map((t) => textW(t, e.st)));
          const th = lines.length * lineH(e.st);
          if (pos === "bestFit") pos = fitsInSlice(rOut, sweep, tw) ? "ctrFit" : "outEnd";
          const sx = Math.sin(mid), sy = -Math.cos(mid);
          if (pos === "outEnd") {
            const d = rOut + 5;
            const x = ccx + sx * d, y = ccy + sy * d;
            const anchor = sx > 0.15 ? "start" : sx < -0.15 ? "end" : "middle";
            const base = sy < -0.15 ? "bottom" : sy > 0.15 ? "top" : "middle";
            queueLabel(env, e, text, x, y, anchor, base, st);
          } else {
            let d;
            if (doughnut) d = (rIn + rOut) / 2;
            else if (pos === "inEnd") d = rOut - Math.max(tw, th) / 2 - 4;
            else if (pos === "ctrFit") d = rOut * 0.62;
            else d = rOut / 2;
            if (sweep >= TAU - 1e-9 && !doughnut) d = 0;
            queueLabel(env, e, text, ccx + sx * d, ccy + sy * d, "middle", "middle", st);
          }
        }
      }
      a += sweep;
    }
  });
}

function drawRadar(env, rg, P) {
  const g = rg.g, cat = rg.catAx, va = rg.valAx;
  const series = g.series;
  const n = Math.max(1, catCount(series));
  const src = series.find((s) => s.cat && s.cat.v.some((x) => x != null));
  const code = cat.m.numFmt && !cat.m.numFmt.linked ? cat.m.numFmt.code : src && src.cat.fmt;
  const labels = [];
  for (let i = 0; i < n; i++) {
    const v = src ? src.cat.v[i] : i + 1;
    labels.push(v == null ? "" : typeof v === "number" ? env.fmt(v, code || "General") : String(v));
  }
  cat.labels = labels;
  cat.n = n;
  const cst = textStyle(env, "axis", cat.m.tx);
  va.ts = textStyle(env, "axis", va.m.tx);
  va.groups = [rg];
  const showCat = !cat.deleted && cat.m.tickLblPos !== "none";
  const maxW = showCat ? Math.max(0, ...labels.map((s) => textW(s, cst))) : 0;
  const cx = P.x + P.w / 2, cy = P.y + P.h / 2;
  let R = Math.min(P.w / 2 - maxW - 8, P.h / 2 - (showCat ? lineH(cst) + 6 : 4));
  R = Math.max(10, R);
  computeValScale(env, va, R);
  const rev = cat.m.orient === "maxMin";
  const ang = (i) => ((rev ? -1 : 1) * TAU * i) / n;
  const rOf = (v) => clamp(va.frac(v), 0, 1) * R;
  const pt = (i, v) => { const a = ang(i), r = rOf(v); return [cx + r * Math.sin(a), cy - r * Math.cos(a)]; };
  // web gridlines
  const gridAuto = { fill: null, ln: { fill: rgb("#d9d9d9"), w: 1 } };
  if (va.m.minorGrid) {
    const st = shapeStyle(env, va.m.minorGrid, gridAuto);
    for (const t of va.minor) { if (t === va.lo) continue; const ring = []; for (let i = 0; i < n; i++) ring.push(pt(i, t)); emitLine(env, ring.concat([ring[0]]), st.line); }
  }
  if (va.m.majorGrid) {
    const st = shapeStyle(env, va.m.majorGrid, gridAuto);
    for (const t of va.ticks) { if (t === va.lo) continue; const ring = []; for (let i = 0; i < n; i++) ring.push(pt(i, t)); emitLine(env, ring.concat([ring[0]]), st.line); }
  }
  // spokes
  const spokeSp = cat.m.majorGrid || (!cat.deleted ? cat.m.sp || {} : null);
  if (spokeSp) {
    const st = shapeStyle(env, spokeSp, gridAuto);
    for (let i = 0; i < n; i++) emitLine(env, [[cx, cy], pt(i, va.hi)], st.line);
  }
  // series
  const filled = g.radarStyle === "filled";
  const all = rg.series.map((rs) => {
    const pts = [];
    for (let i = 0; i < n; i++) { const v = seriesValue(rs.s, i); pts.push(v == null ? null : pt(i, v)); }
    return pts;
  });
  rg.series.forEach((rs, k) => {
    const pts = all[k].filter(Boolean);
    if (pts.length < 2) return;
    if (filled) emitPoly(env, pts, rs.style);
    else if (rs.style.line) emitLine(env, pts.concat([pts[0]]), rs.style.line);
  });
  // value axis line + labels on the top spoke
  if (!va.deleted) {
    const st = shapeStyle(env, va.m.sp, { fill: null, ln: null });
    if (st.line) emitLine(env, [[cx, cy], [cx, cy - R]], st.line);
    if (va.m.tickLblPos !== "none") {
      va.ticks.forEach((t, k) => emitText(env, va.labels[k], cx - 4, cy - rOf(t), va.ts, "end", "middle"));
    }
  }
  rg.series.forEach((rs, k) => {
    for (let i = 0; i < n; i++) {
      const p = all[k][i];
      if (!p) continue;
      if (!filled) {
        const mk = markerOf(env, rg, rs, i);
        if (mk) drawMarker(env, mk.sym, p[0], p[1], mk.px, mk.st);
      }
      const e = labelSpec(env, rg, rs, i);
      if (e) pointLabel(env, e, labelText(env, rg, rs, i, e, seriesValue(rs.s, i), null), p, 3, e.pos || "t", rs.style);
    }
  });
  if (showCat) {
    for (let i = 0; i < n; i++) {
      const a = ang(i);
      const sx = Math.sin(a), sy = -Math.cos(a);
      const d = R + 6 + (sy < -0.9 && !va.deleted ? lineH(va.ts) * 0.5 : 0);
      const x = cx + d * sx, y = cy + d * sy;
      const anchor = sx > 0.1 ? "start" : sx < -0.1 ? "end" : "middle";
      const base = sy < -0.1 ? "bottom" : sy > 0.1 ? "top" : "middle";
      emitText(env, labels[i], x, y, cst, anchor, base);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Axes drawing
// ---------------------------------------------------------------------------------------------

function gridPositions(a, P, minor) {
  if (a.role === "val") return (minor ? a.minor : a.ticks).map((v) => valPx(a, P, v));
  if (minor) return [];
  const out = [];
  const skip = a.m.tickMarkSkip && a.m.tickMarkSkip > 0 ? a.m.tickMarkSkip : 1;
  if (a.between) for (let i = 0; i <= a.n; i += skip) out.push(axisPx(a, P, i / a.n));
  else for (let i = 0; i < a.n; i += skip) out.push(axisPx(a, P, catFrac(a, i, 0.5)));
  return out;
}

function drawGridlines(env, axes, P) {
  const auto = { fill: null, ln: { fill: rgb("#d9d9d9"), w: 1 } };
  for (const minor of [true, false]) {
    for (const a of axes) {
      const sp = minor ? a.m.minorGrid : a.m.majorGrid;
      if (!sp) continue;
      const st = shapeStyle(env, sp, auto);
      if (!st.line) continue;
      for (const p of gridPositions(a, P, minor)) {
        if (a.dir === "v") emitLine(env, [[P.x, p], [P.x + P.w, p]], st.line);
        else emitLine(env, [[p, P.y], [p, P.y + P.h]], st.line);
      }
    }
  }
}

function drawAxisLines(env, axes, P) {
  for (const a of axes) {
    if (a.deleted) continue;
    const auto = { fill: null, ln: a.role === "cat" ? { fill: rgb("#d9d9d9"), w: 1 } : null };
    const st = shapeStyle(env, a.m.sp, auto);
    if (!st.line) continue;
    const c = crossPx(a, P);
    if (a.dir === "v") emitLine(env, [[c, P.y], [c, P.y + P.h]], st.line);
    else emitLine(env, [[P.x, c], [P.x + P.w, c]], st.line);
    const side = a.place ? a.place.side : a.dir === "v" ? "l" : "b";
    const outSign = side === "l" || side === "t" ? -1 : 1;
    for (const major of [false, true]) {
      const t = major ? a.m.majorTick : a.m.minorTick;
      if (!t || t === "none") continue;
      const L = major ? TICK : MINOR_TICK;
      const o0 = t === "in" ? -L : t === "cross" ? -L : 0;
      const o1 = t === "in" ? 0 : L;
      const pos = gridPositions(a, P, !major);
      for (const p of pos) {
        if (a.dir === "v") emitLine(env, [[c + outSign * o0, p], [c + outSign * o1, p]], st.line);
        else emitLine(env, [[p, c + outSign * o0], [p, c + outSign * o1]], st.line);
      }
    }
  }
}

function drawAxisLabels(env, axes, P, outer) {
  for (const a of axes) {
    if (a.deleted) continue;
    const pl = a.place;
    if (pl) {
      const st = a.ts;
      const edgeX = pl.side === "l" ? P.x : P.x + P.w;
      const edgeY = pl.side === "t" ? P.y : P.y + P.h;
      const line = crossPx(a, P);
      const out = tickOut(a);
      if (a.role === "val") {
        a.ticks.forEach((t, k) => {
          const p = valPx(a, P, t);
          const s = a.labels[k];
          if (a.dir === "v") {
            const base = pl.edge ? (pl.side === "l" ? edgeX - a.offset : edgeX + a.offset) : line;
            const x = pl.side === "l" ? base - a.gap - out : base + a.gap + out;
            emitText(env, s, x, p, st, pl.side === "l" ? "end" : "start", "middle");
          } else {
            const base = pl.edge ? (pl.side === "t" ? edgeY - a.offset : edgeY + a.offset) : line;
            const y = pl.side === "t" ? base - a.gap - out : base + a.gap + out;
            emitText(env, s, p, y, st, "middle", pl.side === "t" ? "bottom" : "top");
          }
        });
      } else {
        const lab = a.lab;
        for (let i = 0; i < a.n; i += lab.skip) {
          const p = axisPx(a, P, catFrac(a, i, 0.5));
          const lines = lab.lines[i] || [""];
          if (a.dir === "h") {
            const base = pl.edge ? (pl.side === "t" ? edgeY - a.offset : edgeY + a.offset) : line;
            const top = pl.side === "t";
            const y = top ? base - a.gap - out : base + a.gap + out;
            if (lab.rot === -90) emitText(env, a.labels[i], p, y, st, top ? "start" : "end", "middle", -90);
            else {
              const lh = lab.lh;
              lines.forEach((s, k) => {
                const yy = top ? y - (lines.length - 1 - k) * lh : y + k * lh;
                emitText(env, s, p, yy, st, "middle", top ? "bottom" : "top");
              });
            }
          } else {
            const base = pl.edge ? (pl.side === "l" ? edgeX - a.offset : edgeX + a.offset) : line;
            const x = pl.side === "l" ? base - a.gap - out : base + a.gap + out;
            lines.forEach((s, k) => emitText(env, s, x, p + (k - (lines.length - 1) / 2) * lab.lh, st, pl.side === "l" ? "end" : "start", "middle"));
          }
        }
      }
    }
    if (a.unitBlk && a.dir === "v") {
      const left = (a.place ? a.place.side : "l") === "l";
      const x = left ? P.x - (a.unitOffset || 0) - a.unitBlk.thick / 2 : P.x + P.w + (a.unitOffset || 0) + a.unitBlk.thick / 2;
      emitText(env, a.unitBlk.text, x, P.y + P.h / 2, a.unitBlk.st, "middle", "middle", -90);
    }
    if (a.titleBlk) {
      const b = a.titleBlk;
      const side = a.titleSide || (a.dir === "v" ? "l" : "b");
      if (a.dir === "v") {
        const x = side === "l" ? outer.x + b.thick / 2 : outer.x + outer.w - b.thick / 2;
        drawBlock(env, b, x, P.y + P.h / 2, b.rot);
      } else {
        const y = side === "t" ? outer.y + b.thick / 2 : outer.y + outer.h - b.thick / 2;
        drawBlock(env, b, P.x + P.w / 2, y, b.rot);
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Main render
// ---------------------------------------------------------------------------------------------

function drawChartSpace(env) {
  const { W, H } = env;
  const st = shapeStyle(env, env.model.sp, { fill: rgb("#ffffff"), ln: { fill: rgb("#d9d9d9"), w: 1 } });
  const sw = st.line ? st.line.w : 0;
  const x = sw / 2, y = sw / 2, w = W - sw, h = H - sw;
  if (env.model.roundedCorners) {
    const r = clamp(Math.min(W, H) * 0.035, 3, 12);
    emitPoly(env, roundedRectPts(x, y, w, h, r), st);
  } else emitRect(env, x, y, w, h, st);
}

/**
 * Renders a parsed chart model into primitives for a width x height box. Never throws: on an
 * unexpected model the primitives drawn so far are returned together with `error`.
 */
export function renderChart(model, ctx = {}) {
  const W = Math.max(1, Number(ctx.width) || 480), H = Math.max(1, Number(ctx.height) || 288);
  model = model || {};
  const env = makeEnv(model, ctx || {}, W, H);
  env.labels = [];
  try {
    render(env, model, W, H);
  } catch (e) {
    return { items: env.out, error: String((e && e.message) || e) };
  }
  return { items: env.out };
}

function render(env, model, W, H) {
  drawChartSpace(env);
  if (!model.plot) return;
  const rgs = prepare(env);
  const axes = setupAxes(env, rgs);
  const area = { x: PAD, y: PAD, w: W - 2 * PAD, h: H - 2 * PAD };
  const title = layoutTitle(env, rgs, area);
  const legend = layoutLegend(env, rgs, area);
  const { P, outer } = layoutPlot(env, rgs, axes, area);
  // plot area background
  if (model.plot.sp) emitRect(env, P.x, P.y, P.w, P.h, shapeStyle(env, model.plot.sp, { fill: null, ln: null }));
  drawGridlines(env, axes, P);
  let axesDrawn = false;
  for (const rg of rgs) {
    if (!axesDrawn && GROUP_RANK[rg.type] >= 2) { drawAxisLines(env, axes, P); axesDrawn = true; }
    switch (rg.type) {
      case "bar": drawBars(env, rg, P); break;
      case "area": drawAreas(env, rg, P); break;
      case "line": drawLines(env, rg, P); break;
      case "scatter": drawScatter(env, rg, P); break;
      case "bubble": drawBubbles(env, rg, P); break;
      case "pie": case "doughnut": drawPie(env, rg, P); break;
      case "radar": drawRadar(env, rg, P); break;
      default: break;
    }
  }
  if (!axesDrawn) drawAxisLines(env, axes, P);
  drawLabels(env);
  drawAxisLabels(env, axes, P, outer);
  if (title) {
    if (title.sp) {
      const bg = shapeStyle(env, title.sp, { fill: null, ln: null });
      emitRect(env, title.cx - title.w / 2 - 4, title.cy - title.h / 2 - 2, title.w + 8, title.h + 4, bg);
    }
    drawBlock(env, title, title.cx, title.cy, 0);
  }
  drawLegend(env, legend);
}
