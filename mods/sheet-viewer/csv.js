// CSV/TSV: bytes -> text (UTF-8, UTF-16 by BOM, else Windows-1251 the way Russian Excel saves),
// the delimiter Excel would pick (, ; tab |), and RFC 4180 parsing with quoted fields and
// line breaks inside quotes. Numbers stay text as written ("2 561,5" is shown as-is, like
// Excel shows a CSV opened in another locale... except plain numbers, which align right).
import { Cells } from "./cells.js";

// Windows-1251 bytes 0x80..0xFF.
const CP1251 = "ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏђ‘’“”•–—\u0098™љ›њќћџ ЎўЈ¤Ґ¦§Ё©Є«¬­®Ї°±Ііґµ¶·ё№є»јЅѕїАБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюя";

function utf8(bytes, start) {
  let out = "", i = start;
  const n = bytes.length;
  const parts = [];
  while (i < n) {
    const b = bytes[i];
    let cp;
    if (b < 0x80) { cp = b; i += 1; }
    else if (b >= 0xc2 && b < 0xe0 && i + 1 < n && (bytes[i + 1] & 0xc0) === 0x80) { cp = ((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f); i += 2; }
    else if (b >= 0xe0 && b < 0xf0 && i + 2 < n && (bytes[i + 1] & 0xc0) === 0x80 && (bytes[i + 2] & 0xc0) === 0x80) { cp = ((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f); i += 3; }
    else if (b >= 0xf0 && b < 0xf5 && i + 3 < n && (bytes[i + 1] & 0xc0) === 0x80 && (bytes[i + 2] & 0xc0) === 0x80 && (bytes[i + 3] & 0xc0) === 0x80) { cp = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f); i += 4; }
    else return null; // not UTF-8
    out += String.fromCodePoint(cp);
    if (out.length > 8192) { parts.push(out); out = ""; }
  }
  parts.push(out);
  return parts.join("");
}

function utf16(bytes, start, le) {
  const parts = [];
  let out = "";
  for (let i = start; i + 1 < bytes.length; i += 2) {
    out += String.fromCharCode(le ? bytes[i] | (bytes[i + 1] << 8) : (bytes[i] << 8) | bytes[i + 1]);
    if (out.length > 8192) { parts.push(out); out = ""; }
  }
  parts.push(out);
  return parts.join("");
}

function cp1251(bytes) {
  const parts = [];
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    out += b < 0x80 ? String.fromCharCode(b) : CP1251[b - 0x80];
    if (out.length > 8192) { parts.push(out); out = ""; }
  }
  parts.push(out);
  return parts.join("");
}

/** { text, encoding } */
export function decodeText(bytes) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { text: utf8(bytes, 3) ?? cp1251(bytes.subarray(3)), encoding: "UTF-8 BOM" };
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: utf16(bytes, 2, true), encoding: "UTF-16 LE" };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: utf16(bytes, 2, false), encoding: "UTF-16 BE" };
  const u = utf8(bytes, 0);
  if (u !== null) return { text: u, encoding: "UTF-8" };
  return { text: cp1251(bytes), encoding: "Windows-1251" };
}

/** The delimiter that splits the first lines most consistently. */
export function detectDelimiter(text, hint) {
  if (hint) return hint;
  const sample = text.slice(0, 20000);
  let best = ",", bestScore = -1;
  for (const d of [",", ";", "\t", "|"]) {
    const counts = [];
    let inQ = false, n = 0;
    for (let i = 0; i < sample.length && counts.length < 20; i++) {
      const ch = sample[i];
      if (ch === '"') inQ = !inQ;
      else if (!inQ && ch === d) n++;
      else if (!inQ && ch === "\n") { counts.push(n); n = 0; }
    }
    if (n) counts.push(n);
    if (!counts.length || !counts[0]) continue;
    const same = counts.filter((x) => x === counts[0]).length;
    const score = same * 100 + counts[0];
    if (score > bestScore) { best = d; bestScore = score; }
  }
  return best;
}

/** Rows of fields. */
export function parseCsv(text, delim) {
  const rows = [];
  let row = [], field = "", i = 0, inQ = false;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"' && field === "") { inQ = true; i++; continue; }
    if (ch === delim) { row.push(field); field = ""; i++; continue; }
    if (ch === "\r") { i++; continue; }
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += ch; i++;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** A CSV as the same sheet model the xlsx reader makes (one sheet, default styles). */
export function readCsv(bytes, { delimiter } = {}) {
  const { text, encoding } = decodeText(bytes);
  const delim = detectDelimiter(text, delimiter);
  const rows = parseCsv(text, delim);
  const cells = new Cells();
  let maxCol = 0;
  rows.forEach((fields, r) => {
    fields.forEach((f, c) => {
      if (f === "") return;
      putField(cells, r, c, f);
      if (c > maxCol) maxCol = c;
    });
  });
  return { rows: rows.length, maxCol, cells, encoding, delimiter: delim };
}

/**
 * A field as a cell { v, text }: the text as written, and plain numbers (either decimal mark) as
 * numbers too, as Excel would read them here. Packed (cells.js) unless the number reads
 * differently from its text ("1,5", "007"): a big CSV is mostly plain numbers and words.
 */
function putField(cells, r, c, f) {
  const plain = /^-?\d+([.,]\d+)?$/.test(f.trim()) ? Number(f.trim().replace(",", ".")) : null;
  if (plain === null || String(plain) === f) cells.add(r, c, 0, plain ?? f, true);
  else cells.addCell({ r, c, s: 0, v: plain, text: f });
}

// ---- time-sliced versions for the mod runtime (an interpreter that stops long runs) ----

/** Windows-1251 bytes to text, yielding as it goes. */
export async function cp1251Async(bytes, tick) {
  const parts = [];
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    out += b < 0x80 ? String.fromCharCode(b) : CP1251[b - 0x80];
    if ((i & 8191) === 8191) { parts.push(out); out = ""; await tick(true); }
  }
  parts.push(out);
  return parts.join("");
}

/** Like parseCsv, yielding every few thousand characters. */
export async function parseCsvAsync(text, delim, tick) {
  const rows = [];
  let row = [], field = "", i = 0, inQ = false;
  const n = text.length;
  while (i < n) {
    if ((i & 4095) === 0) await tick(true);
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"' && field === "") { inQ = true; i++; continue; }
    if (ch === delim) { row.push(field); field = ""; i++; continue; }
    if (ch === "\r") { i++; continue; }
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += ch; i++;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** A CSV from its text (already decoded) as the viewer's sheet model, time-sliced. */
export async function readCsvText(text, { delimiter, encoding, tick }) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const delim = detectDelimiter(text, delimiter);
  const rows = await parseCsvAsync(text, delim, tick);
  const cells = new Cells();
  let maxCol = 0;
  for (let r = 0; r < rows.length; r++) {
    const fields = rows[r];
    // A row's fields go once they're cells: the rows and the cells aren't held both at once.
    rows[r] = null;
    for (let c = 0; c < fields.length; c++) {
      const f = fields[c];
      if (f === "") continue;
      putField(cells, r, c, f);
      if (c > maxCol) maxCol = c;
    }
    if ((r & 255) === 255) await tick(true);
  }
  return { rows: rows.length, maxCol, cells, encoding, delimiter: delim };
}
