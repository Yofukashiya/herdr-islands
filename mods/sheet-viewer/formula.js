// A small formula evaluator, used only where a file carries no cached result (files written by
// libraries such as openpyxl) and for conditional-formatting rules. Excel files normally store
// every formula's last value, which is always shown as-is.
//
// evaluate(formula, ctx, at) -> number | string | boolean | null | {error}, undefined if unknown
//   ctx.get(r, c, sheet)  value of a cell (0-based), evaluating it if needed
//   ctx.bounds(sheet)  { maxRow, maxCol }, where the sheet's data ends: a range (A:A, 1:1,
//                      A1:A1048576) stops there. null when the sheet isn't there (or loaded).
//   ctx.memo(key, compute)  optional. compute() is a function's result over ranges; key names the
//                           function and what it read. A ctx that returns the result it kept for
//                           the key (while the cells are unchanged) lets a rule checked on every
//                           row (A1>AVERAGE(A:A)) read A once.
//   at = { r, c, baseR, baseC }  the cell the formula is for. Relative references shift by
//   (r - baseR, c - baseC): that is how shared formulas and conditional-format expressions apply
//   to a range. A range used as one value (=A:A*2) reads row r or column c of it.

const ERR = (e) => ({ error: e });
const isErr = (v) => v && typeof v === "object" && "error" in v;

export function colIndex(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// The last row and column of a sheet, 0-based: where a whole-column (A:A) or whole-row (1:1)
// range ends.
const LAST_ROW = 1048575, LAST_COL = 16383;

/** The sheet name in a reference's `Sheet2!` or `'My data'!` prefix, unquoted; null without one. */
const unquoteSheet = (name) => (name ? name.replace(/^'|'$/g, "").replace(/''/g, "'") : null);

// Built once: the interpreter is slow, and every distinct formula text is tokenized.
const SHEET_PREFIX = /(?:('(?:[^']|'')+'|[A-Za-z_][\w.]*)!)?/.source;
const re = {
  space: /^\s+/,
  num: /^(\d+\.?\d*|\.\d+)(E[+-]?\d+)?%?/i,
  str: /^"((?:[^"]|"")*)"/,
  err: /^#(NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A)/,
  cols: new RegExp("^" + SHEET_PREFIX + /(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})(?![\w(])/.source),
  // Excel has no time literal (1:30 is written "1:30" or TIME(1,30,0)), so digits:digits
  // outside a string are always rows.
  rows: new RegExp("^" + SHEET_PREFIX + /(\$?)(\d+):(\$?)(\d+)(?![\w.(])/.source),
  ref: new RegExp("^" + SHEET_PREFIX + /(\$?)([A-Za-z]{1,3})(\$?)(\d+)(?::(\$?)([A-Za-z]{1,3})(\$?)(\d+))?(?![\w(])/.source),
  bool: /^(TRUE|FALSE)(?![\w(])/i,
  fn: /^([A-Za-z_][\w.]*)\(/,
  op: /^(<>|<=|>=|[-+*/^&=<>(),:;%])/,
};

function tokenize(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const rest = s.slice(i);
    let m;
    if ((m = re.space.exec(rest))) { i += m[0].length; continue; }
    if ((m = re.str.exec(rest))) { out.push({ t: "str", v: m[1].replace(/""/g, '"') }); i += m[0].length; continue; }
    if ((m = re.err.exec(rest))) { out.push({ t: "err", v: "#" + m[1] }); i += m[0].length; continue; }
    if ((m = re.bool.exec(rest))) { out.push({ t: "bool", v: m[1].toUpperCase() === "TRUE" }); i += m[0].length; continue; }
    // A whole column spans every row, so its rows never shift: they are absolute.
    if ((m = re.cols.exec(rest))) {
      out.push({ t: "ref", sheet: unquoteSheet(m[1]),
        a: { cAbs: !!m[2], c: colIndex(m[3]), rAbs: true, r: 0 },
        b: { cAbs: !!m[4], c: colIndex(m[5]), rAbs: true, r: LAST_ROW } });
      i += m[0].length;
      continue;
    }
    if ((m = re.rows.exec(rest))) {
      out.push({ t: "ref", sheet: unquoteSheet(m[1]),
        a: { cAbs: true, c: 0, rAbs: !!m[2], r: Number(m[3]) - 1 },
        b: { cAbs: true, c: LAST_COL, rAbs: !!m[4], r: Number(m[5]) - 1 } });
      i += m[0].length;
      continue;
    }
    if ((m = re.ref.exec(rest))) {
      out.push({ t: "ref", sheet: unquoteSheet(m[1]),
        a: { cAbs: !!m[2], c: colIndex(m[3]), rAbs: !!m[4], r: Number(m[5]) - 1 },
        b: m[7] ? { cAbs: !!m[6], c: colIndex(m[7]), rAbs: !!m[8], r: Number(m[9]) - 1 } : null });
      i += m[0].length;
      continue;
    }
    if ((m = re.fn.exec(rest))) { out.push({ t: "fn", v: m[1].toUpperCase() }); i += m[0].length; continue; }
    if ((m = re.num.exec(rest))) {
      let v = parseFloat(m[1] + (m[2] ?? ""));
      if (m[0].endsWith("%")) v /= 100;
      out.push({ t: "num", v });
      i += m[0].length;
      continue;
    }
    if ((m = re.op.exec(rest))) { out.push({ t: "op", v: m[1] === ";" ? "," : m[1] }); i += m[0].length; continue; }
    throw new Error("token");
  }
  return out;
}

// Pratt parser to an AST.
function parse(tokens) {
  let p = 0;
  const peek = () => tokens[p];
  const next = () => tokens[p++];
  const PREC = { "=": 1, "<>": 1, "<": 1, ">": 1, "<=": 1, ">=": 1, "&": 2, "+": 3, "-": 3, "*": 4, "/": 4, "^": 5 };
  function primary() {
    const tk = next();
    if (!tk) throw new Error("eof");
    if (tk.t === "num" || tk.t === "str" || tk.t === "bool" || tk.t === "err") return { k: "lit", v: tk.t === "err" ? ERR(tk.v) : tk.v };
    if (tk.t === "ref") return { k: "ref", tk };
    if (tk.t === "fn") {
      const args = [];
      if (!(peek()?.t === "op" && peek().v === ")")) {
        for (;;) {
          if (peek()?.t === "op" && (peek().v === "," || peek().v === ")")) args.push({ k: "lit", v: null });
          else args.push(expr(0));
          const sep = next();
          if (sep?.v === ")") break;
          if (sep?.v !== ",") throw new Error("args");
        }
      } else next();
      return { k: "fn", name: tk.v, args };
    }
    if (tk.t === "op" && tk.v === "(") { const e = expr(0); next(); return e; }
    if (tk.t === "op" && (tk.v === "-" || tk.v === "+")) return { k: "neg", v: primary(), sign: tk.v };
    throw new Error("unexpected");
  }
  function operand() {
    let v = primary();
    while (peek()?.t === "op" && peek().v === "%") { next(); v = { k: "pct", v }; }
    return v;
  }
  // Precedence climbing: left-associative except ^.
  function expr(min) {
    let left = operand();
    for (;;) {
      const tk = peek();
      if (!tk || tk.t !== "op" || !(tk.v in PREC)) break;
      const prec = PREC[tk.v];
      if (prec < min) break;
      next();
      const right = expr(tk.v === "^" ? prec : prec + 1);
      left = { k: "bin", op: tk.v, a: left, b: right };
    }
    return left;
  }
  const ast = expr(0);
  if (p < tokens.length) throw new Error("trailing");
  return ast;
}

const cache = new Map();
function compile(f) {
  let ast = cache.get(f);
  if (!ast) {
    ast = parse(tokenize(f.replace(/^=/, "")));
    if (cache.size > 5000) cache.clear();
    cache.set(f, ast);
  }
  return ast;
}

class Range {
  constructor(sheet, r1, c1, r2, c2) { this.sheet = sheet; this.r1 = r1; this.c1 = c1; this.r2 = r2; this.c2 = c2; }
}

const num = (v) => {
  if (isErr(v)) return v;
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return v;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : ERR("#VALUE!");
};
const str = (v) => (v === null || v === undefined ? "" : typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : String(v));

function values(ctx, x, out = []) {
  if (x instanceof Range) {
    // Cells past the sheet's data are empty, and no function here counts an empty cell: a
    // whole-column range (A:A, A1:A1048576) stops at the data instead of walking a million rows.
    const b = ctx.bounds?.(x.sheet);
    // No such sheet (or not loaded yet): each cell would read #REF!, so the range reads one.
    if (b === null) { out.push(ERR("#REF!")); return out; }
    const r2 = b ? Math.min(x.r2, b.maxRow) : x.r2, c2 = b ? Math.min(x.c2, b.maxCol) : x.c2;
    for (let r = x.r1; r <= r2; r++) for (let c = x.c1; c <= c2; c++) out.push(ctx.get(r, c, x.sheet));
  } else out.push(x);
  return out;
}

function numbersOf(ctx, args, direct) {
  const out = [];
  for (const a of args) {
    if (a instanceof Range) { for (const v of values(ctx, a)) if (typeof v === "number") out.push(v); else if (isErr(v)) return v; }
    else { const n = direct ? num(a) : a; if (isErr(n)) return n; if (typeof n === "number") out.push(n); }
  }
  return out;
}

const FN = {
  SUM: (ctx, a) => { const n = numbersOf(ctx, a, true); return isErr(n) ? n : n.reduce((s, x) => s + x, 0); },
  PRODUCT: (ctx, a) => { const n = numbersOf(ctx, a, true); return isErr(n) ? n : n.reduce((s, x) => s * x, 1); },
  AVERAGE: (ctx, a) => { const n = numbersOf(ctx, a, true); return isErr(n) ? n : n.length ? n.reduce((s, x) => s + x, 0) / n.length : ERR("#DIV/0!"); },
  MIN: (ctx, a) => { const n = numbersOf(ctx, a, true); return isErr(n) ? n : n.length ? Math.min(...n) : 0; },
  MAX: (ctx, a) => { const n = numbersOf(ctx, a, true); return isErr(n) ? n : n.length ? Math.max(...n) : 0; },
  COUNT: (ctx, a) => a.flatMap((x) => values(ctx, x)).filter((v) => typeof v === "number").length,
  COUNTA: (ctx, a) => a.flatMap((x) => values(ctx, x)).filter((v) => v !== null && v !== undefined && v !== "").length,
  ABS: (ctx, [x]) => { const n = num(x); return isErr(n) ? n : Math.abs(n); },
  ROUND: (ctx, [x, d]) => { const n = num(x), k = num(d ?? 0); if (isErr(n)) return n; const m = 10 ** k; return Math.sign(n) * Math.round(Math.abs(n) * m + 1e-9) / m; },
  INT: (ctx, [x]) => { const n = num(x); return isErr(n) ? n : Math.floor(n); },
  IF: (ctx, [c, a, b]) => (truthy(c) ? (a ?? true) : (b ?? false)),
  AND: (ctx, a) => a.flatMap((x) => values(ctx, x)).every(truthy),
  OR: (ctx, a) => a.flatMap((x) => values(ctx, x)).some(truthy),
  NOT: (ctx, [x]) => !truthy(x),
  CONCATENATE: (ctx, a) => a.flatMap((x) => values(ctx, x)).map(str).join(""),
  CONCAT: (ctx, a) => a.flatMap((x) => values(ctx, x)).map(str).join(""),
  LEN: (ctx, [x]) => str(x).length,
  UPPER: (ctx, [x]) => str(x).toUpperCase(),
  LOWER: (ctx, [x]) => str(x).toLowerCase(),
  ISBLANK: (ctx, [x]) => x === null || x === undefined || x === "",
  ISNUMBER: (ctx, [x]) => typeof x === "number",
  ISERROR: (ctx, [x]) => isErr(x),
  IFERROR: (ctx, [x, y]) => (isErr(x) ? y : x),
  TODAY: () => Math.floor(Date.now() / 86400000) + 25569,
  NOW: () => Date.now() / 86400000 + 25569,
  MOD: (ctx, [a, b]) => { const x = num(a), y = num(b); if (isErr(x)) return x; if (isErr(y)) return y; return y === 0 ? ERR("#DIV/0!") : x - y * Math.floor(x / y); },
};

function truthy(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v.toUpperCase() === "TRUE";
  return false;
}

function cmp(a, b) {
  if (typeof a === "number" && typeof b === "number") return a - b;
  const x = str(a).toLowerCase(), y = str(b).toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

// A range used as one value (=A:A*2, a rule =$A:$A="Yes") is read the way Excel reads it: a
// one-column range on the formula's row, a one-row range in its column, #VALUE! when the formula
// is outside it. Without `at` the formula's place isn't known, so neither is the value.
function single(ctx, v, at) {
  if (!(v instanceof Range)) return v;
  if (v.r1 === v.r2 && v.c1 === v.c2) return ctx.get(v.r1, v.c1, v.sheet);
  if (!at) throw new Error("place");
  if (v.c1 === v.c2) return at.r >= v.r1 && at.r <= v.r2 ? ctx.get(at.r, v.c1, v.sheet) : ERR("#VALUE!");
  if (v.r1 === v.r2) return at.c >= v.c1 && at.c <= v.c2 ? ctx.get(v.r1, at.c, v.sheet) : ERR("#VALUE!");
  return ERR("#VALUE!");
}

// What a function call read: a Range as its cells (not its text, so A:A and A1:A1048576 are one),
// strings quoted ("1" isn't 1), and Infinity, NaN and an empty argument each their own.
const memoKey = (name, args) => name + "(" + args.map((v) => (v instanceof Range ? `${JSON.stringify(v.sheet)}!${v.r1},${v.c1}:${v.r2},${v.c2}`
  : isErr(v) ? v.error : typeof v === "string" ? JSON.stringify(v) : String(v))).join(";") + ")";

function run(node, ctx, at) {
  switch (node.k) {
    case "lit": return node.v;
    case "neg": { const n = num(single(ctx, run(node.v, ctx, at), at)); return isErr(n) ? n : node.sign === "-" ? -n : n; }
    case "pct": { const n = num(single(ctx, run(node.v, ctx, at), at)); return isErr(n) ? n : n / 100; }
    case "ref": {
      const { a, b, sheet } = node.tk;
      const dr = at ? at.r - (at.baseR ?? at.r) : 0, dc = at ? at.c - (at.baseC ?? at.c) : 0;
      const R = (p) => (p.rAbs ? p.r : p.r + dr), C = (p) => (p.cAbs ? p.c : p.c + dc);
      if (!b) return ctx.get(R(a), C(a), sheet);
      return new Range(sheet, Math.min(R(a), R(b)), Math.min(C(a), C(b)), Math.max(R(a), R(b)), Math.max(C(a), C(b)));
    }
    case "fn": {
      const f = FN[node.name];
      if (!f) throw new Error("fn " + node.name);
      const args = node.args.map((x) => run(x, ctx, at));
      const scalarArgs = ["IF", "ABS", "ROUND", "INT", "NOT", "LEN", "UPPER", "LOWER", "ISBLANK", "ISNUMBER", "ISERROR", "IFERROR", "MOD"].includes(node.name);
      if (scalarArgs) return f(ctx, args.map((v) => single(ctx, v, at)));
      if (!ctx.memo || !args.some((v) => v instanceof Range)) return f(ctx, args);
      return ctx.memo(memoKey(node.name, args), () => f(ctx, args));
    }
    case "bin": {
      const x = single(ctx, run(node.a, ctx, at), at), y = single(ctx, run(node.b, ctx, at), at);
      if (isErr(x)) return x;
      if (isErr(y)) return y;
      switch (node.op) {
        case "&": return str(x) + str(y);
        case "=": return cmp(x, y) === 0;
        case "<>": return cmp(x, y) !== 0;
        case "<": return cmp(x, y) < 0;
        case ">": return cmp(x, y) > 0;
        case "<=": return cmp(x, y) <= 0;
        case ">=": return cmp(x, y) >= 0;
      }
      const a = num(x), b2 = num(y);
      if (isErr(a)) return a;
      if (isErr(b2)) return b2;
      switch (node.op) {
        case "+": return a + b2;
        case "-": return a - b2;
        case "*": return a * b2;
        case "/": return b2 === 0 ? ERR("#DIV/0!") : a / b2;
        case "^": return a ** b2;
      }
    }
  }
  throw new Error("node");
}

/** The formula's value, or undefined when it uses something this evaluator doesn't know. */
export function evaluate(formula, ctx, at) {
  try {
    return single(ctx, run(compile(formula), ctx, at), at);
  } catch {
    return undefined;
  }
}
