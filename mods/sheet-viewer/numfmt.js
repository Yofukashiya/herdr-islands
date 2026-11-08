/**
 * numfmt.js - Excel number-format engine for a read-only spreadsheet viewer.
 *
 * Pure ES2020 module: no imports, no Intl, no host APIs - only string and
 * arithmetic code, so it runs in small embedded runtimes (QuickJS-like).
 *
 *   formatValue(value, code, { date1904, locale }) -> { text, color }
 *   isDateFormat(code) -> boolean
 *   builtinFormat(numFmtId, locale) -> format code
 *   BUILTIN_FORMATS -> { id: code } (en-US canonical codes)
 *
 * Numbers are rounded the way Excel displays them: the double is first reduced
 * to 15 significant decimal digits, then rounded half away from zero on the
 * decimal digit string (so 1.005 with "0.00" gives 1.01).
 */

const NBSP = ' ';

const NAMES = {
  en: {
    months: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
    monthsGen: null,
    monthsShort: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    days: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    daysShort: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    am: 'AM',
    pm: 'PM'
  },
  ru: {
    months: ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'],
    monthsGen: ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'],
    monthsShort: ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'],
    days: ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'],
    daysShort: ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'],
    am: 'AM',
    pm: 'PM'
  }
};

/** Output conventions per locale. `longDate` / `sysTime` back [$-F800] / [$-F400]. */
const LOCALES = {
  ru: {
    lang: 'ru', dec: ',', group: NBSP, dateSep: '.', TRUE: 'ИСТИНА', FALSE: 'ЛОЖЬ',
    longDate: 'd mmmm yyyy "г."', longDateGenitive: true, sysTime: 'h:mm:ss'
  },
  en: {
    lang: 'en', dec: '.', group: ',', dateSep: '/', TRUE: 'TRUE', FALSE: 'FALSE',
    longDate: 'dddd, mmmm d, yyyy', longDateGenitive: false, sysTime: 'h:mm:ss AM/PM'
  }
};

const COLOR_NAMES = {
  black: '#000000', blue: '#0000ff', cyan: '#00ffff', green: '#00ff00',
  magenta: '#ff00ff', red: '#ff0000', white: '#ffffff', yellow: '#ffff00'
};

/** Excel's default 56-colour palette: [Color1] .. [Color56] (indexed colours 8..63). */
const PALETTE = [
  '000000', 'ffffff', 'ff0000', '00ff00', '0000ff', 'ffff00', 'ff00ff', '00ffff',
  '800000', '008000', '000080', '808000', '800080', '008080', 'c0c0c0', '808080',
  '9999ff', '993366', 'ffffcc', 'ccffff', '660066', 'ff8080', '0066cc', 'ccccff',
  '000080', 'ff00ff', 'ffff00', '00ffff', '800080', '800000', '008080', '0000ff',
  '00ccff', 'ccffff', 'ccffcc', 'ffff99', '99ccff', 'ff99cc', 'cc99ff', 'ffcc99',
  '3366ff', '33cccc', '99cc00', 'ffcc00', 'ff9900', 'ff6600', '666699', '969696',
  '003366', '339966', '003300', '333300', '993300', '993366', '333399', '333333'
];

const OPS = { '<': '<', '>': '>', '=': '=', '<=': '<=', '=<': '<=', '>=': '>=', '=>': '>=', '<>': '<>' };

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/* ------------------------------------------------------------------------ */
/* Built-in formats                                                         */
/* ------------------------------------------------------------------------ */

/** Built-in number formats (ECMA-376 18.8.30), en-US flavour. */
export const BUILTIN_FORMATS = {
  0: 'General',
  1: '0',
  2: '0.00',
  3: '#,##0',
  4: '#,##0.00',
  5: '"$"#,##0_);\\("$"#,##0\\)',
  6: '"$"#,##0_);[Red]\\("$"#,##0\\)',
  7: '"$"#,##0.00_);\\("$"#,##0.00\\)',
  8: '"$"#,##0.00_);[Red]\\("$"#,##0.00\\)',
  9: '0%',
  10: '0.00%',
  11: '0.00E+00',
  12: '# ?/?',
  13: '# ??/??',
  14: 'm/d/yyyy',
  15: 'd-mmm-yy',
  16: 'd-mmm',
  17: 'mmm-yy',
  18: 'h:mm AM/PM',
  19: 'h:mm:ss AM/PM',
  20: 'h:mm',
  21: 'h:mm:ss',
  22: 'm/d/yyyy h:mm',
  23: 'General',
  24: 'General',
  25: 'General',
  26: 'General',
  // 27-36 are East-Asian date/time formats; mapped to their nearest Western equivalent.
  27: 'm/d/yyyy',
  28: 'm/d/yyyy',
  29: 'm/d/yyyy',
  30: 'm/d/yyyy',
  31: 'm/d/yyyy',
  32: 'h:mm',
  33: 'h:mm:ss',
  34: 'm/d/yyyy',
  35: 'm/d/yyyy',
  36: 'm/d/yyyy',
  37: '#,##0 ;(#,##0)',
  38: '#,##0 ;[Red](#,##0)',
  39: '#,##0.00;(#,##0.00)',
  40: '#,##0.00;[Red](#,##0.00)',
  41: '_(* #,##0_);_(* \\(#,##0\\);_(* "-"_);_(@_)',
  42: '_("$"* #,##0_);_("$"* \\(#,##0\\);_("$"* "-"_);_(@_)',
  43: '_(* #,##0.00_);_(* \\(#,##0.00\\);_(* "-"??_);_(@_)',
  44: '_("$"* #,##0.00_);_("$"* \\(#,##0.00\\);_("$"* "-"??_);_(@_)',
  45: 'mm:ss',
  46: '[h]:mm:ss',
  47: 'mmss.0',
  48: '##0.0E+0',
  49: '@'
};

/** ru-RU differences (system short date, rouble currency, Russian accounting layout). */
const RU_BUILTINS = {
  5: '#,##0 "₽";-#,##0 "₽"',
  6: '#,##0 "₽";[Red]-#,##0 "₽"',
  7: '#,##0.00 "₽";-#,##0.00 "₽"',
  8: '#,##0.00 "₽";[Red]-#,##0.00 "₽"',
  14: 'dd.mm.yyyy',
  15: 'dd.mmm.yy',
  16: 'dd.mmm',
  17: 'mmm.yy',
  22: 'dd.mm.yyyy h:mm',
  41: '_-* #,##0_-;-* #,##0_-;_-* "-"_-;_-@_-',
  42: '_-* #,##0 "₽"_-;-* #,##0 "₽"_-;_-* "-" "₽"_-;_-@_-',
  43: '_-* #,##0.00_-;-* #,##0.00_-;_-* "-"??_-;_-@_-',
  44: '_-* #,##0.00 "₽"_-;-* #,##0.00 "₽"_-;_-* "-"?? "₽"_-;_-@_-'
};

/** Ids that resolve to another built-in (East-Asian variants, as Excel maps them in Western locales). */
const BUILTIN_ALIASES = {
  27: 14, 28: 14, 29: 14, 30: 14, 31: 14, 32: 20, 33: 21, 34: 14, 35: 14, 36: 14,
  50: 14, 51: 14, 52: 14, 53: 14, 54: 14, 55: 14, 56: 14, 57: 14, 58: 14,
  59: 1, 60: 2, 61: 3, 62: 4, 67: 9, 68: 10, 69: 12, 70: 13, 71: 14, 72: 14,
  73: 15, 74: 16, 75: 17, 76: 20, 77: 21, 78: 22, 79: 45, 80: 46, 81: 47
};

function localeKey(locale) {
  if (locale === undefined || locale === null || locale === '') return 'ru';
  const l = String(locale).toLowerCase();
  return l === 'ru-ru' || l === 'ru' ? 'ru' : 'en';
}

/** Format code for a built-in numFmtId; date/currency built-ins follow the locale. */
export function builtinFormat(id, locale) {
  const n = Number(id);
  if (!Number.isInteger(n)) return 'General';
  const target = hasOwn(BUILTIN_ALIASES, n) ? BUILTIN_ALIASES[n] : n;
  if (localeKey(locale) === 'ru' && hasOwn(RU_BUILTINS, target)) return RU_BUILTINS[target];
  return hasOwn(BUILTIN_FORMATS, target) ? BUILTIN_FORMATS[target] : 'General';
}

/* ------------------------------------------------------------------------ */
/* Parsing                                                                  */
/* ------------------------------------------------------------------------ */

function newSection() {
  return { tokens: [], color: null, cond: null, lang: null, genitive: false, sys: null, brackets: false };
}

function addLit(sec, v) {
  sec.tokens.push({ t: 'lit', v: v, raw: v });
}

function parseCurrency(sec, body) {
  const dash = body.indexOf('-');
  const sym = dash < 0 ? body : body.slice(0, dash);
  const loc = dash < 0 ? '' : body.slice(dash + 1).trim().toLowerCase();
  if (sym) addLit(sec, sym);
  if (!loc) return;
  if (loc.indexOf('x-sysdate') === 0) { sec.sys = 'date'; return; }
  if (loc.indexOf('x-systime') === 0) { sec.sys = 'time'; return; }
  if (/^[0-9a-f]+$/.test(loc)) {
    const lcid = parseInt(loc.slice(-4), 16); // low 16 bits; higher bits carry calendar / digit info
    if (lcid === 0xF800) sec.sys = 'date';
    else if (lcid === 0xF400) sec.sys = 'time';
    else {
      const prim = lcid & 0x3FF;
      if (prim === 0x09) sec.lang = 'en';
      else if (prim === 0x19) {
        sec.lang = 'ru';
        if ((lcid >> 10) === 0x3F) sec.genitive = true; // [$-FC19]: genitive month names
      }
    }
    return;
  }
  if (loc.indexOf('ru') === 0) sec.lang = 'ru';
  else if (loc.indexOf('en') === 0) sec.lang = 'en';
}

function parseBracket(sec, s) {
  sec.brackets = true;
  const low = s.trim().toLowerCase();
  if (hasOwn(COLOR_NAMES, low)) { sec.color = COLOR_NAMES[low]; return; }
  let m = /^color\s*(\d+)$/.exec(low);
  if (m) {
    const k = parseInt(m[1], 10);
    if (k >= 1 && k <= 56) sec.color = '#' + PALETTE[k - 1];
    return;
  }
  m = /^(<>|<=|>=|=<|=>|<|>|=)\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)$/.exec(low);
  if (m) { sec.cond = { op: OPS[m[1]], val: parseFloat(m[2]) }; return; }
  if (s.charAt(0) === '$') { parseCurrency(sec, s.slice(1)); return; }
  if (/^(h+|m+|s+)$/.test(low)) {
    sec.tokens.push({ t: 'elapsed', k: low.charAt(0), n: low.length, raw: '[' + s + ']' });
    return;
  }
  // [DBNum1], [NatNum..], [ENG] and other modifiers: ignored.
}

function tokenize(code) {
  const secs = [];
  let sec = newSection();
  const n = code.length;
  let i = 0;
  while (i < n) {
    const c = code.charAt(i);
    if (c === ';') { secs.push(sec); sec = newSection(); i++; continue; }
    if (c === '"') {
      let j = code.indexOf('"', i + 1);
      if (j < 0) j = n;
      addLit(sec, code.slice(i + 1, j));
      i = j + 1;
      continue;
    }
    if (c === '\\') { if (i + 1 < n) addLit(sec, code.charAt(i + 1)); i += 2; continue; }
    if (c === '_') { addLit(sec, ' '); i += 2; continue; }   // space the width of the next char
    if (c === '*') { i += 2; continue; }                     // repeat-fill: dropped
    if (c === '[') {
      const j = code.indexOf(']', i + 1);
      if (j < 0) { addLit(sec, code.slice(i)); break; }
      parseBracket(sec, code.slice(i + 1, j));
      i = j + 1;
      continue;
    }
    if (c === '0' || c === '#' || c === '?') { sec.tokens.push({ t: 'dig', c: c, raw: c }); i++; continue; }
    if (c >= '1' && c <= '9') { sec.tokens.push({ t: 'num', raw: c }); i++; continue; }
    if (c === '.') { sec.tokens.push({ t: 'dot', raw: c }); i++; continue; }
    if (c === ',') { sec.tokens.push({ t: 'comma', raw: c }); i++; continue; }
    if (c === '%') { sec.tokens.push({ t: 'pct', raw: c }); i++; continue; }
    if (c === '@') { sec.tokens.push({ t: 'at', raw: c }); i++; continue; }
    if (c === '/') { sec.tokens.push({ t: 'slash', raw: c }); i++; continue; }
    const cl = c.toLowerCase();
    if (cl === 'e') {
      const nx = code.charAt(i + 1);
      if (nx === '+' || nx === '-') { sec.tokens.push({ t: 'exp', c: c, sign: nx, raw: c + nx }); i += 2; continue; }
      sec.tokens.push({ t: 'era', raw: c });
      i++;
      continue;
    }
    if (cl === 'g' && code.slice(i, i + 7).toLowerCase() === 'general') {
      sec.tokens.push({ t: 'general', raw: code.slice(i, i + 7) });
      i += 7;
      continue;
    }
    if (cl === 'a') {
      const s5 = code.slice(i, i + 5);
      if (s5.toUpperCase() === 'AM/PM') { sec.tokens.push({ t: 'ampm', raw: s5 }); i += 5; continue; }
      const s3 = code.slice(i, i + 3);
      if (s3.toUpperCase() === 'A/P') { sec.tokens.push({ t: 'ampm', raw: s3 }); i += 3; continue; }
    }
    if (cl === 'y' || cl === 'm' || cl === 'd' || cl === 'h' || cl === 's') {
      let j = i + 1;
      while (j < n && code.charAt(j).toLowerCase() === cl) j++;
      sec.tokens.push({ t: 'date', k: cl, n: j - i, raw: code.slice(i, j) });
      i = j;
      continue;
    }
    addLit(sec, c);
    i++;
  }
  secs.push(sec);
  return secs;
}

function analyzeDate(sec) {
  const src = sec.tokens;
  const tk = [];
  for (let i = 0; i < src.length; i++) {
    const t = src[i];
    if (t.t === 'dot' && i + 1 < src.length && src[i + 1].t === 'dig' && src[i + 1].c === '0') {
      let j = i + 1;
      while (j < src.length && src[j].t === 'dig' && src[j].c === '0') j++;
      tk.push({ t: 'subsec', n: j - i - 1, raw: src.slice(i, j).map((x) => x.raw).join('') });
      i = j - 1;
      continue;
    }
    tk.push(t);
  }
  let subsec = 0;
  let ampm = false;
  let hasTime = false;
  let usesDate = false;
  for (let i = 0; i < tk.length; i++) {
    const t = tk[i];
    if (t.t === 'date') {
      if (t.k === 'm' && t.n <= 2) {
        // m/mm means minutes right after an hour token or right before a seconds token.
        let prev = null;
        let next = null;
        for (let j = i - 1; j >= 0; j--) if (tk[j].t === 'date' || tk[j].t === 'elapsed') { prev = tk[j]; break; }
        for (let j = i + 1; j < tk.length; j++) if (tk[j].t === 'date' || tk[j].t === 'elapsed') { next = tk[j]; break; }
        t.min = !!((prev && prev.k === 'h') || (next && next.k === 's'));
      }
      if (t.k === 'h' || t.k === 's' || t.min) hasTime = true;
      else usesDate = true;
    } else if (t.t === 'elapsed') hasTime = true;
    else if (t.t === 'ampm') { hasTime = true; ampm = true; }
    else if (t.t === 'subsec') { hasTime = true; if (t.n > subsec) subsec = t.n; }
    else if (t.t === 'era') usesDate = true;
  }
  sec.tokens = tk;
  sec.subsec = Math.min(subsec, 3);
  sec.ampm = ampm;
  sec.hasTime = hasTime;
  sec.usesDate = usesDate;
}

/** Assign int/dec/point/group/scale roles for a plain (or mantissa) digit run in [start, end). */
function assignMantissa(sec, start, end) {
  const tk = sec.tokens;
  let di = -1;
  for (let i = start; i < end; i++) if (tk[i].t === 'dot') { di = i; break; }
  const intEnd = di < 0 ? end : di;
  const intToks = [];
  const decToks = [];
  for (let i = start; i < end; i++) {
    const t = tk[i];
    if (t.t !== 'dig') continue;
    if (i < intEnd) { t.role = 'int'; intToks.push(t); } else { t.role = 'dec'; decToks.push(t); }
  }
  if (di >= 0) tk[di].role = 'point';
  let grouping = false;
  let scale = 0;
  for (let i = start; i < end; i++) {
    const t = tk[i];
    if (t.t !== 'comma') continue;
    let a = i - 1;
    while (a >= start && tk[a].t === 'comma') a--;
    let b = i + 1;
    while (b < end && tk[b].t === 'comma') b++;
    const prevDig = a >= start && tk[a].t === 'dig';
    const nextDig = b < end && tk[b].t === 'dig';
    let digBefore = false;
    let digAfter = false;
    if (i < intEnd) {
      for (let k = start; k < i; k++) if (tk[k].t === 'dig') { digBefore = true; break; }
      for (let k = i + 1; k < intEnd; k++) if (tk[k].t === 'dig') { digAfter = true; break; }
    }
    if (digBefore && digAfter) { t.role = 'group'; grouping = true; }
    else if (prevDig && !nextDig) { t.role = 'scale'; scale++; }
    else t.role = 'lit';
  }
  sec.intToks = intToks;
  sec.decToks = decToks;
  sec.grouping = grouping;
  sec.scale = scale;
}

const isSpaceLit = (t) => t.t === 'lit' && t.v === ' ';

function detectFraction(sec) {
  const tk = sec.tokens;
  for (let i = 0; i < tk.length; i++) {
    if (tk[i].t !== 'slash') continue;
    let a = i - 1;
    while (a >= 0 && isSpaceLit(tk[a])) a--;
    if (a < 0 || tk[a].t !== 'dig') continue;
    let b = i + 1;
    while (b < tk.length && isSpaceLit(tk[b])) b++;
    if (b >= tk.length || (tk[b].t !== 'dig' && tk[b].t !== 'num')) continue;
    let ns = a;
    while (ns > 0 && tk[ns - 1].t === 'dig') ns--;
    let de = b;
    while (de + 1 < tk.length && (tk[de + 1].t === 'dig' || tk[de + 1].t === 'num')) de++;
    const numToks = tk.slice(ns, a + 1);
    const denToks = tk.slice(b, de + 1);
    numToks.forEach((t) => { t.role = 'num'; });
    denToks.forEach((t) => { t.role = 'den'; });
    tk[i].role = 'fslash';
    const fixed = denToks.some((t) => t.t === 'num') && denToks.every((t) => t.t === 'num' || t.c === '0');
    const intToks = [];
    for (let k = 0; k < ns; k++) if (tk[k].t === 'dig') { tk[k].role = 'int'; intToks.push(tk[k]); }
    let grouping = false;
    for (let k = 0; k < ns; k++) {
      if (tk[k].t !== 'comma') continue;
      let before = false;
      let after = false;
      for (let q = 0; q < k; q++) if (tk[q].role === 'int') { before = true; break; }
      for (let q = k + 1; q < ns; q++) if (tk[q].role === 'int') { after = true; break; }
      if (before && after) { tk[k].role = 'group'; grouping = true; }
    }
    sec.mode = 'frac';
    sec.intToks = intToks;
    sec.numToks = numToks;
    sec.denToks = denToks;
    sec.grouping = grouping;
    sec.fixedDen = fixed ? parseInt(denToks.map((t) => t.raw).join(''), 10) : 0;
    return true;
  }
  return false;
}

function analyzeNum(sec) {
  const tk = sec.tokens;
  let pct = 0;
  let general = false;
  let hasDig = false;
  for (const t of tk) {
    if (t.t === 'pct') pct++;
    else if (t.t === 'general') general = true;
    else if (t.t === 'dig') hasDig = true;
  }
  sec.pct = pct;
  if (general || (tk.length === 0 && sec.brackets)) { sec.mode = 'general'; return; }
  if (!hasDig) { sec.mode = 'lit'; return; }
  let ei = -1;
  for (let i = 0; i < tk.length; i++) if (tk[i].t === 'exp') { ei = i; break; }
  if (ei >= 0) {
    const expToks = [];
    for (let i = ei + 1; i < tk.length; i++) if (tk[i].t === 'dig') expToks.push(tk[i]);
    if (expToks.length) {
      sec.mode = 'sci';
      tk[ei].role = 'emark';
      assignMantissa(sec, 0, ei);
      expToks.forEach((t) => { t.role = 'edig'; });
      sec.expToks = expToks;
      return;
    }
  }
  if (detectFraction(sec)) return;
  sec.mode = 'fixed';
  assignMantissa(sec, 0, tk.length);
}

function analyzeSection(sec) {
  let isDate = !!sec.sys;
  sec.hasAt = false;
  for (const t of sec.tokens) {
    if (t.t === 'at') sec.hasAt = true;
    else if (t.t === 'date' || t.t === 'elapsed' || t.t === 'ampm') isDate = true;
  }
  sec.isDate = isDate;
  if (isDate) analyzeDate(sec);
  else analyzeNum(sec);
}

function buildFormat(code) {
  let secs = tokenize(code === '' ? 'General' : code);
  if (secs.length > 4) secs = secs.slice(0, 4);
  secs.forEach(analyzeSection);
  let num = secs;
  let text = null;
  if (secs.length === 4) { text = secs[3]; num = secs.slice(0, 3); }
  else if (secs[secs.length - 1].hasAt) { text = secs[secs.length - 1]; num = secs.slice(0, secs.length - 1); }
  return { num: num, text: text, hasCond: num.some((s) => !!s.cond) };
}

const CACHE = new Map();
function getFormat(code) {
  let f = CACHE.get(code);
  if (!f) {
    f = buildFormat(code);
    if (CACHE.size >= 2000) CACHE.clear();
    CACHE.set(code, f);
  }
  return f;
}

const SYS_CACHE = {};
function sysSection(kind, L) {
  const key = L.lang + ':' + kind;
  let s = SYS_CACHE[key];
  if (!s) {
    s = buildFormat(kind === 'date' ? L.longDate : L.sysTime).num[0];
    s.lang = L.lang;
    if (kind === 'date' && L.longDateGenitive) s.genitive = true;
    SYS_CACHE[key] = s;
  }
  return s;
}

/* ------------------------------------------------------------------------ */
/* Decimal helpers                                                          */
/* ------------------------------------------------------------------------ */

const zeros = (n) => (n > 0 ? '0'.repeat(n) : '');

/** x >= 0 -> { d: significant digits (<= 15, no trailing zeros), p: digits before the point }. */
function toDec(x) {
  if (!(x > 0)) return { d: '', p: 0 };
  const s = x.toExponential(14);
  const e = s.indexOf('e');
  const d = (s.charAt(0) + s.slice(2, e)).replace(/0+$/, '');
  return { d: d, p: parseInt(s.slice(e + 1), 10) + 1 };
}

function incStr(s) {
  const a = s.split('');
  for (let i = a.length - 1; i >= 0; i--) {
    if (a[i] === '9') a[i] = '0';
    else { a[i] = String.fromCharCode(a[i].charCodeAt(0) + 1); return a.join(''); }
  }
  return '1' + a.join('');
}

/** Round to n decimals, half away from zero, on the digit string. -> { int: '' for 0, frac: n digits }. */
function roundDec(dec, n) {
  const d = dec.d;
  if (!d) return { int: '', frac: zeros(n) };
  const keep = dec.p + n;
  let D;
  if (keep < 0) D = '';
  else if (keep >= d.length) D = d + zeros(keep - d.length);
  else {
    D = d.slice(0, keep);
    if (d.charCodeAt(keep) >= 53) D = incStr(D);
  }
  D = D.replace(/^0+/, '');
  if (D.length <= n) return { int: '', frac: zeros(n - D.length) + D };
  return { int: D.slice(0, D.length - n), frac: D.slice(D.length - n) };
}

/* ------------------------------------------------------------------------ */
/* General                                                                  */
/* ------------------------------------------------------------------------ */

function genFixed(dec, n, ds) {
  const r = roundDec(dec, n);
  if (r.int.length > 11) return null;
  const f = r.frac.replace(/0+$/, '');
  return (r.int || '0') + (f ? ds + f : '');
}

function genExp(dec, sig, ds) {
  let D = dec.d;
  let e = dec.p - 1;
  if (D.length > sig) {
    let r = D.slice(0, sig);
    if (D.charCodeAt(sig) >= 53) {
      r = incStr(r);
      if (r.length > sig) { e++; r = r.slice(0, sig); }
    }
    D = r;
  }
  D = D.replace(/0+$/, '');
  const ae = Math.abs(e);
  return D.charAt(0) + (D.length > 1 ? ds + D.slice(1) : '') + 'E' + (e < 0 ? '-' : '+') + (ae < 10 ? '0' + ae : String(ae));
}

/** Excel's General display for a standard-width column (11 characters). a >= 0. */
function generalNum(a, L, neg) {
  if (!(a > 0)) return '0';
  const dec = toDec(a);
  const e = dec.p - 1;
  const ds = L.dec;
  let s = null;
  if (e >= -4 && e <= -1) s = genFixed(dec, 9, ds);
  else if (e >= 0 && e <= 10) s = genFixed(dec, e <= 9 ? 9 - e : 0, ds);
  else if (e >= -9 && e <= -5) {
    const t = genFixed(dec, 12, ds);
    if (t !== null && t.length <= (neg ? 12 : 11)) s = t;
  }
  return s === null ? genExp(dec, 6, ds) : s;
}

/* ------------------------------------------------------------------------ */
/* Number sections                                                          */
/* ------------------------------------------------------------------------ */

/** Right-align `digits` onto integer placeholders; extra digits go to the leftmost one. */
function intRender(toks, digits, grouping, sep) {
  const n = toks.length;
  const L = digits.length;
  const out = new Array(n);
  for (let j = 0; j < n; j++) {
    const p = n - 1 - j;
    let s = '';
    if (j === 0 && L > n) {
      for (let q = L - 1; q >= n; q--) {
        s += digits.charAt(L - 1 - q);
        if (grouping && q % 3 === 0) s += sep;
      }
    }
    const gp = grouping && p > 0 && p % 3 === 0;
    if (p < L) {
      s += digits.charAt(L - 1 - p);
      if (gp) s += sep;
    } else {
      const c = toks[j].c;
      if (c === '0') { s += '0'; if (gp) s += sep; }
      else if (c === '?') { s += ' '; if (gp) s += ' '; }
    }
    out[j] = s;
  }
  return out;
}

function litText(t) {
  switch (t.t) {
    case 'lit': return t.v;
    case 'at': return '';
    default: return t.raw;
  }
}

function decimalsText(decToks, frac) {
  let keep = decToks.length;
  while (keep > 0 && decToks[keep - 1].c !== '0' && frac.charAt(keep - 1) === '0') keep--;
  return decToks.map((t, k) => (k < keep ? frac.charAt(k) : t.c === '?' ? ' ' : ''));
}

function renderFixed(sec, a, L) {
  const dec = toDec(a);
  if (dec.d) dec.p += 2 * sec.pct - 3 * sec.scale;
  const r = roundDec(dec, sec.decToks.length);
  const ip = intRender(sec.intToks, r.int, sec.grouping, L.group);
  const dp = decimalsText(sec.decToks, r.frac);
  let out = '';
  let ii = 0;
  let di = 0;
  for (const t of sec.tokens) {
    switch (t.role) {
      case 'int': out += ip[ii++]; break;
      case 'dec': out += dp[di++]; break;
      case 'point':
        if (sec.intToks.length === 0 && r.int) out += r.int;
        out += L.dec;
        break;
      case 'group': case 'scale': break;
      default: out += litText(t);
    }
  }
  return out;
}

function renderSci(sec, a, L) {
  const nI = sec.intToks.length;
  const nD = sec.decToks.length;
  const dec = toDec(a);
  let exp = 0;
  let m;
  if (!dec.d) m = { int: '', frac: zeros(nD) };
  else {
    dec.p += 2 * sec.pct;
    const e10 = dec.p - 1;
    const step = nI > 1 ? nI : 1;
    // With several integer placeholders the exponent is a multiple of their count (##0.0E+0 = engineering).
    exp = nI === 0 ? e10 + 1 : nI === 1 ? e10 : Math.floor(e10 / nI) * nI;
    m = roundDec({ d: dec.d, p: dec.p - exp }, nD);
    if (m.int.length > nI) {
      exp += step;
      m = roundDec({ d: dec.d, p: dec.p - exp }, nD);
    }
  }
  const ip = intRender(sec.intToks, m.int, false, '');
  const dp = decimalsText(sec.decToks, m.frac);
  const ep = intRender(sec.expToks, String(Math.abs(exp)), false, '');
  let out = '';
  let ii = 0;
  let di = 0;
  let ei = 0;
  for (const t of sec.tokens) {
    switch (t.role) {
      case 'int': out += ip[ii++]; break;
      case 'dec': out += dp[di++]; break;
      case 'point':
        if (nI === 0 && m.int) out += m.int;
        out += L.dec;
        break;
      case 'emark': out += t.c + (exp < 0 ? '-' : t.sign === '+' ? '+' : ''); break;
      case 'edig': out += ep[ei++]; break;
      case 'group': case 'scale': break;
      default: out += litText(t);
    }
  }
  return out;
}

/** Closest fraction n/d to x >= 0 with d <= maxDen (ties -> smaller d). */
function bestFrac(x, maxDen) {
  if (!(x > 0)) return [0, 1];
  if (maxDen <= 999) {
    let bn = Math.round(x);
    let bd = 1;
    let be = Math.abs(x - bn);
    for (let d = 2; d <= maxDen && be > 0; d++) {
      const nn = Math.round(x * d);
      const err = Math.abs(x - nn / d);
      if (err < be - 1e-15) { be = err; bn = nn; bd = d; }
    }
    return [bn, bd];
  }
  // Continued fractions with a final semiconvergent (exact best approximation).
  let p0 = 0, q0 = 1, p1 = 1, q1 = 0;
  let r = x;
  for (let it = 0; it < 64; it++) {
    const ai = Math.floor(r);
    const q2 = ai * q1 + q0;
    if (q2 > maxDen) {
      const k = Math.floor((maxDen - q0) / q1);
      const ps = k * p1 + p0;
      const qs = k * q1 + q0;
      return Math.abs(x - ps / qs) < Math.abs(x - p1 / q1) ? [ps, qs] : [p1, q1];
    }
    const p2 = ai * p1 + p0;
    p0 = p1; q0 = q1; p1 = p2; q1 = q2;
    const f = r - ai;
    if (f < 1e-12 || Math.abs(x - p1 / q1) < 1e-15) break;
    r = 1 / f;
  }
  return [p1, q1];
}

function renderFrac(sec, a, L) {
  const x = Number(a.toPrecision(15)) * Math.pow(100, sec.pct);
  const mixed = sec.intToks.length > 0;
  let ip = 0;
  let num;
  let den;
  if (sec.fixedDen) {
    den = sec.fixedDen;
    const rr = Math.round(x * den);
    if (mixed) { ip = Math.floor(rr / den); num = rr - ip * den; } else num = rr;
  } else {
    const maxDen = Math.pow(10, Math.min(sec.denToks.length, 7)) - 1;
    if (mixed) {
      ip = Math.floor(x);
      const f = bestFrac(x - ip, maxDen);
      num = f[0];
      den = f[1];
      if (num >= den) { ip += Math.floor(num / den); num = 0; }
    } else {
      const f = bestFrac(x, maxDen);
      num = f[0];
      den = f[1];
    }
  }
  const hide = mixed && num === 0; // whole number: the fraction part becomes blanks
  const ipParts = intRender(sec.intToks, ip > 0 ? String(ip) : hide ? '0' : '', sec.grouping, L.group);
  const numParts = intRender(sec.numToks, num > 0 ? String(num) : mixed ? '' : '0', false, '');
  const denStr = String(den);
  const nDen = sec.denToks.length;
  let out = '';
  let ii = 0;
  let ni = 0;
  let dI = 0;
  for (const t of sec.tokens) {
    switch (t.role) {
      case 'int': out += ipParts[ii++]; break;
      case 'num': out += hide ? ' ' : numParts[ni]; ni++; break;
      case 'fslash': out += hide ? ' ' : '/'; break;
      case 'den': {
        const k = dI++;
        if (hide) out += ' ';
        else if (sec.fixedDen) out += t.raw;
        else if (k < denStr.length) out += k === nDen - 1 ? denStr.slice(k) : denStr.charAt(k);
        else out += t.c === '#' ? '' : ' ';
        break;
      }
      case 'group': break;
      default: out += litText(t);
    }
  }
  return out;
}

function renderNumber(sec, a, L, neg) {
  switch (sec.mode) {
    case 'general': {
      let out = '';
      let seen = false;
      for (const t of sec.tokens) {
        if (t.t === 'general') { out += generalNum(a, L, neg); seen = true; } else out += litText(t);
      }
      return seen ? out : generalNum(a, L, neg);
    }
    case 'fixed': return renderFixed(sec, a, L);
    case 'sci': return renderSci(sec, a, L);
    case 'frac': return renderFrac(sec, a, L);
    default: {
      let out = '';
      for (const t of sec.tokens) out += litText(t);
      return out;
    }
  }
}

/* ------------------------------------------------------------------------ */
/* Dates                                                                    */
/* ------------------------------------------------------------------------ */

const MAX_SERIAL = 2958465; // 9999-12-31

function civilFromDays(z) {
  // Days since 1970-01-01 -> proleptic Gregorian date (H. Hinnant's algorithm).
  z += 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return { y: y, m: m, d: d };
}

/** 1900-system serial (with Excel's fictitious 29 Feb 1900) -> { y, m, d }. */
function serialToYMD(n) {
  if (n === 0) return { y: 1900, m: 1, d: 0 };
  if (n === 60) return { y: 1900, m: 2, d: 29 };
  return civilFromDays((n < 60 ? n + 1 : n) - 25569);
}

const pad2 = (v) => (v < 10 ? '0' + v : String(v));
function padN(v, n) {
  const s = String(v);
  return s.length >= n ? s : zeros(n - s.length) + s;
}

function ampmText(raw, H, N) {
  const pm = H >= 12;
  const lower = raw.charAt(0) === raw.charAt(0).toLowerCase();
  let s = pm ? N.pm : N.am;
  if (raw.length === 3) s = s.charAt(0); // A/P
  return lower ? s.toLowerCase() : s;
}

function renderDate(sec, a, ctx) {
  const L = ctx.L;
  const s = sec.sys ? sysSection(sec.sys, L) : sec;
  const lang = s.lang || sec.lang || L.lang;
  const N = NAMES[lang];
  const genitive = (s.genitive || sec.genitive) && !!N.monthsGen;
  const F = s.subsec;
  const unit = Math.pow(10, F);
  const perDay = 86400 * unit;
  let total;
  if (s.hasTime) total = Math.round(a * perDay);
  else total = Math.floor(Math.round(a * 86400000) / 86400000) * perDay;
  const day = Math.floor(total / perDay);
  let rem = total - day * perDay;
  const H = Math.floor(rem / (3600 * unit));
  rem -= H * 3600 * unit;
  const M = Math.floor(rem / (60 * unit));
  rem -= M * 60 * unit;
  const S = Math.floor(rem / unit);
  const sub = rem - S * unit;
  const serial = day + (ctx.date1904 ? 1462 : 0);
  if (s.usesDate && serial > MAX_SERIAL) return null;
  const ymd = serialToYMD(serial);
  const wd = (serial + 6) % 7;
  let out = '';
  for (const t of s.tokens) {
    switch (t.t) {
      case 'date': {
        const n = t.n;
        switch (t.k) {
          case 'y': out += n <= 2 ? pad2(ymd.y % 100) : String(ymd.y); break;
          case 'm':
            if (t.min) out += n === 1 ? String(M) : pad2(M);
            else if (n === 1) out += String(ymd.m);
            else if (n === 2) out += pad2(ymd.m);
            else if (n === 3) out += N.monthsShort[ymd.m - 1];
            else if (n === 5) out += N.months[ymd.m - 1].charAt(0);
            else out += (genitive ? N.monthsGen : N.months)[ymd.m - 1];
            break;
          case 'd':
            if (n === 1) out += String(ymd.d);
            else if (n === 2) out += pad2(ymd.d);
            else if (n === 3) out += N.daysShort[wd];
            else out += N.days[wd];
            break;
          case 'h': {
            const hv = s.ampm ? (H % 12 || 12) : H;
            out += n === 1 ? String(hv) : pad2(hv);
            break;
          }
          default: out += n === 1 ? String(S) : pad2(S); // 's'
        }
        break;
      }
      case 'elapsed': {
        const div = t.k === 'h' ? 3600 * unit : t.k === 'm' ? 60 * unit : unit;
        out += padN(Math.floor(total / div), t.n);
        break;
      }
      case 'subsec': out += L.dec + (padN(sub, F) + zeros(t.n)).slice(0, t.n); break;
      case 'ampm': out += ampmText(t.raw, H, N); break;
      case 'era': out += String(ymd.y); break;
      case 'slash': out += L.dateSep; break; // "/" is the locale date separator in date formats
      default: out += litText(t);
    }
  }
  return out;
}

/* ------------------------------------------------------------------------ */
/* Section choice & public API                                              */
/* ------------------------------------------------------------------------ */

function testCond(c, v) {
  switch (c.op) {
    case '<': return v < c.val;
    case '<=': return v <= c.val;
    case '>': return v > c.val;
    case '>=': return v >= c.val;
    case '=': return v === c.val;
    default: return v !== c.val; // <>
  }
}

/** A condition that only admits non-positive values acts as a negative section: no minus sign. */
const negOnly = (c) => ((c.op === '<' || c.op === '<=') && c.val <= 0) || (c.op === '=' && c.val < 0);

function chooseSection(fmt, v) {
  const secs = fmt.num;
  const n = secs.length;
  for (let i = 0; i < n; i++) {
    const s = secs[i];
    if (s.cond) {
      if (testCond(s.cond, v)) return { sec: s, abs: v < 0 && negOnly(s.cond) };
      continue;
    }
    if (n === 1 || (fmt.hasCond && i === n - 1)) return { sec: s, abs: false }; // catch-all keeps the sign
    if (i === 0) { if (n === 2 ? v >= 0 : v > 0) return { sec: s, abs: false }; }
    else if (i === 1) { if (v < 0) return { sec: s, abs: true }; }
    else if (v === 0) return { sec: s, abs: false };
  }
  return null;
}

const result = (text, color) => ({ text: text, color: color || null });

function formatNumber(v, fmt, ctx) {
  if (!isFinite(v)) return result('#NUM!', null);
  if (v === 0) v = 0; // drop -0
  const ch = chooseSection(fmt, v);
  const a = Math.abs(v);
  if (!ch) return result((v < 0 ? '-' : '') + generalNum(a, ctx.L, v < 0), null);
  const sec = ch.sec;
  if (sec.isDate) {
    if (v < 0) return result('#####', sec.color);
    const t = renderDate(sec, a, ctx);
    return result(t === null ? '#####' : t, sec.color);
  }
  const body = renderNumber(sec, a, ctx.L, v < 0);
  return result((v < 0 && !ch.abs ? '-' : '') + body, sec.color);
}

function formatText(str, fmt) {
  const ts = fmt.text;
  if (!ts) return result(str, null);
  let out = '';
  for (const t of ts.tokens) out += t.t === 'at' || t.t === 'general' ? str : litText(t);
  return result(out, ts.color);
}

function resolveCode(code, locale) {
  if (typeof code === 'number') return builtinFormat(code, locale);
  if (code === undefined || code === null) return 'General';
  return String(code);
}

/**
 * Format a cell value with an Excel number-format code.
 * @param {number|string|boolean|{error:string}|null|undefined} value
 * @param {string} code  format code (XML-decoded) or "General"; a number is taken as a built-in id
 * @param {{date1904?: boolean, locale?: string}} [opts]  locale "ru-RU" (default) or anything else = en-US
 * @returns {{text: string, color: string|null}}
 */
export function formatValue(value, code, opts) {
  const o = opts || {};
  const L = LOCALES[localeKey(o.locale)];
  if (value === null || value === undefined) return result('', null);
  if (typeof value === 'boolean') return result(value ? L.TRUE : L.FALSE, null);
  if (typeof value === 'object') {
    if (value.error !== undefined && value.error !== null) return result(String(value.error), null);
    return result(String(value), null);
  }
  const fmt = getFormat(resolveCode(code, o.locale));
  if (typeof value === 'string') return formatText(value, fmt);
  if (typeof value === 'number') return formatNumber(value, fmt, { L: L, date1904: !!o.date1904 });
  if (typeof value === 'bigint') return formatNumber(Number(value), fmt, { L: L, date1904: !!o.date1904 });
  return result(String(value), null);
}

/** True when the code renders numbers as dates/times (tokens outside quotes, escapes and brackets). */
export function isDateFormat(code) {
  const c = resolveCode(code);
  return getFormat(c).num.some((s) => s.isDate);
}
