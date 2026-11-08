// A small, fast XML reader for OOXML parts (sheets, styles, drawings, charts).
// Element: { name, qname, attrs, children, text }
//   name   local name, namespace prefix dropped ("c:barChart" -> "barChart")
//   qname  the name as written
//   attrs  by local name AND by qualified name when prefixed ("r:id" and "id")
//   text   the element's own text (entities decoded), concatenated
// No DTDs, no namespaces resolution: OOXML parts don't need either.

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decode(s) {
  if (s.indexOf("&") < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return ENT[e] ?? m;
  });
}

const local = (q) => {
  const i = q.indexOf(":");
  return i < 0 ? q : q.slice(i + 1);
};

const ATTR = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

/** Parses a whole document; returns the root element (or null). */
export function parseXml(src) {
  const root = { name: "#document", qname: "#document", attrs: {}, children: [], text: "" };
  const stack = [root];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt < 0) break;
    if (lt > i) {
      const top = stack[stack.length - 1];
      if (top !== root) top.text += decode(src.slice(i, lt));
    }
    const c = src.charCodeAt(lt + 1);
    // Unterminated declarations, comments or CDATA end the document (never loop).
    if (c === 63 /* ? */) { const e = src.indexOf("?>", lt); if (e < 0) break; i = e + 2; continue; }
    if (c === 33 /* ! */) {
      if (src.startsWith("<!--", lt)) { const e = src.indexOf("-->", lt); if (e < 0) break; i = e + 3; continue; }
      if (src.startsWith("<![CDATA[", lt)) {
        const end = src.indexOf("]]>", lt);
        if (end < 0) break;
        stack[stack.length - 1].text += src.slice(lt + 9, end);
        i = end + 3;
        continue;
      }
      const e = src.indexOf(">", lt);
      if (e < 0) break;
      i = e + 1;
      continue;
    }
    // The tag ends at the first ">" outside a quoted attribute value.
    let gt = -1, q = 0;
    for (let k = lt + 1; k < n; k++) {
      const ch = src.charCodeAt(k);
      if (q) { if (ch === q) q = 0; }
      else if (ch === 34 || ch === 39) q = ch;
      else if (ch === 62) { gt = k; break; }
    }
    if (gt < 0) break;
    if (c === 47 /* / */) {
      if (stack.length > 1) stack.pop();
      i = gt + 1;
      continue;
    }
    let body = src.slice(lt + 1, gt);
    const self = body.endsWith("/");
    if (self) body = body.slice(0, -1);
    const sp = body.search(/\s/);
    const qname = sp < 0 ? body : body.slice(0, sp);
    const attrs = {};
    if (sp >= 0) {
      ATTR.lastIndex = 0;
      const rest = body.slice(sp);
      let m;
      while ((m = ATTR.exec(rest))) {
        const v = decode(m[3] ?? m[4] ?? "");
        attrs[m[1]] = v;
        const l = local(m[1]);
        if (l !== m[1] && !(l in attrs)) attrs[l] = v;
      }
    }
    const el = { name: local(qname), qname, attrs, children: [], text: "" };
    stack[stack.length - 1].children.push(el);
    if (!self) stack.push(el);
    i = gt + 1;
  }
  return root.children[0] ?? null;
}

/** First direct child named `name` (local name). */
export function child(el, name) {
  if (!el) return null;
  for (const c of el.children) if (c.name === name) return c;
  return null;
}

/** All direct children named `name`. */
export function kids(el, name) {
  return el ? el.children.filter((c) => c.name === name) : [];
}

/** Walks a path of local names: path(el, "plotArea/barChart/ser"). */
export function path(el, p) {
  let cur = el;
  for (const part of p.split("/")) {
    cur = child(cur, part);
    if (!cur) return null;
  }
  return cur;
}

/** Every descendant named `name`, depth first. */
export function all(el, name, out = []) {
  if (!el) return out;
  for (const c of el.children) {
    if (c.name === name) out.push(c);
    all(c, name, out);
  }
  return out;
}

/** The element's text plus its descendants' (in order). */
export function textOf(el) {
  if (!el) return "";
  let s = el.text;
  for (const c of el.children) s += textOf(c);
  return s;
}

/** `<x val="..."/>` style value of a child, or `fallback`. */
export function val(el, name, fallback = null) {
  const c = child(el, name);
  return c && c.attrs.val !== undefined ? c.attrs.val : fallback;
}
