// How much memory the spreadsheet viewer keeps for a big sheet (mods/sheet-viewer). Herdr runs
// every mod in one heap of about 256 MiB (measured in the runtime: 244 MiB of strings fit, then
// "out of memory"; a cell as an object in a Map cost ~250 bytes there). Node lays objects out
// more tightly than that runtime, so these limits are tighter than they look.
// Run with `node --test` from the repository's root.
import { test } from "node:test";
import assert from "node:assert/strict";
import v8 from "node:v8";
import vm from "node:vm";
import { openXlsx, key, rowHeight } from "../mods/sheet-viewer/xlsx.js";
import { readCsvText } from "../mods/sheet-viewer/csv.js";
import { workbook, NS, REL } from "./sheet-viewer-book.mjs";

v8.setFlagsFromString("--expose-gc");
const gc = vm.runInNewContext("gc");

/** The heap and typed-array bytes that what `make()` returns keeps alive. */
async function retained(make) {
  const used = () => { gc(); gc(); const m = process.memoryUsage(); return m.heapUsed + m.arrayBuffers; };
  const before = used();
  const kept = await make();
  return { kept, bytes: used() - before };
}

/** Rows of three numbers, as a big export writes them: `<c r="A1" t="n"><v>…</v></c>`. */
function numbers(rows) {
  const out = [];
  for (let r = 1; r <= rows; r++) {
    out.push(`<row r="${r}">`);
    for (const col of "ABC") out.push(`<c r="${col}${r}" t="n"><v>${((r * 7919 + col.charCodeAt(0) * 104729) % 100000) / 1000}</v></c>`);
    out.push("</row>");
  }
  return out.join("");
}

const ROWS = 100000, CELLS = ROWS * 3;

test("a sheet of 300,000 numbers keeps under 40 bytes a cell", async () => {
  const book = workbook(numbers(ROWS));
  const { kept: sheet, bytes } = await retained(async () => (await openXlsx(book)).loadSheet(0));
  assert.equal(sheet.cells.get(key(ROWS - 1, 2)).v, ((ROWS * 7919 + 67 * 104729) % 100000) / 1000);
  assert.ok(bytes / CELLS < 40, `${(bytes / CELLS).toFixed(0)} bytes a cell`);
});

// The rules from issue #3: a color scale, a data bar and traffic lights, each over a whole column.
const RULES = `<conditionalFormatting sqref="A1:A${ROWS + 1}"><cfRule type="colorScale" priority="1"><colorScale>`
  + `<cfvo type="min"/><cfvo type="max"/><color rgb="00F8696B"/><color rgb="0063BE7B"/></colorScale></cfRule></conditionalFormatting>`
  + `<conditionalFormatting sqref="B1:B${ROWS + 1}"><cfRule type="dataBar" priority="2"><dataBar>`
  + `<cfvo type="min"/><cfvo type="max"/><color rgb="00638EC6"/></dataBar></cfRule></conditionalFormatting>`
  + `<conditionalFormatting sqref="C1:C${ROWS + 1}"><cfRule type="iconSet" priority="3"><iconSet iconSet="3TrafficLights1">`
  + `<cfvo type="percent" val="0"/><cfvo type="percent" val="33"/><cfvo type="percent" val="67"/></iconSet></cfRule></conditionalFormatting>`;

test("color scales, data bars and icons over 300,000 cells keep under 48 bytes a cell with the cells", async () => {
  const book = workbook(numbers(ROWS), RULES);
  const { kept: sheet, bytes } = await retained(async () => (await openXlsx(book)).loadSheet(0));
  // The rows holding each column's smallest and largest value.
  const ends = (c) => {
    let lo = 0, hi = 0;
    for (let r = 0; r < ROWS; r++) {
      const v = sheet.cells.value(key(r, c));
      if (v < sheet.cells.value(key(lo, c))) lo = r;
      if (v > sheet.cells.value(key(hi, c))) hi = r;
    }
    return [lo, hi];
  };
  const [aLo, aHi] = ends(0), [bLo, bHi] = ends(1), [cLo, cHi] = ends(2);
  assert.deepEqual([sheet.cf.get(key(aLo, 0)).fill, sheet.cf.get(key(aHi, 0)).fill], ["#f8696b", "#63be7b"]);
  assert.deepEqual([sheet.cf.get(key(bLo, 1)).bar, sheet.cf.get(key(bHi, 1)).bar], [{ pct: 0.1, color: "#638ec6" }, { pct: 0.9, color: "#638ec6" }]);
  assert.deepEqual([sheet.cf.get(key(cLo, 2)).icon, sheet.cf.get(key(cHi, 2)).icon], [{ set: "3TrafficLights1", level: 0, of: 3 }, { set: "3TrafficLights1", level: 2, of: 3 }]);
  assert.equal(sheet.cf.get(key(0, 3)), undefined);
  assert.ok(bytes / CELLS < 48, `${(bytes / CELLS).toFixed(0)} bytes a cell`);
});

test("an Excel table over 300,000 cells keeps under 40 bytes a cell with the cells", async () => {
  const book = workbook(numbers(ROWS), `<tableParts count="1"><tablePart r:id="rId1"/></tableParts>`, {
    sheetRels: `<Relationship Id="rId1" Type="${REL}/table" Target="../tables/table1.xml"/>`,
    more: { "xl/tables/table1.xml": `<table ${NS} id="1" name="T" displayName="T" ref="A1:C${ROWS}" totalsRowCount="1">`
      + `<autoFilter ref="A1:C${ROWS - 1}"/><tableStyleInfo name="TableStyleLight1" showRowStripes="1"/></table>` },
  });
  const { kept: sheet, bytes } = await retained(async () => (await openXlsx(book)).loadSheet(0));
  const thin = { style: "thin", color: "#000000" };
  assert.deepEqual([0, 1, 2, ROWS - 2, ROWS - 1].map((r) => sheet.table.get(key(r, 2))), [
    { bold: true, border: { b: thin } }, // the header
    { fill: "#e6e6e6" }, {}, // banded rows
    {}, // the last row of data (99,999th: odd, so not banded)
    { bold: true, border: { t: { style: "double", color: "#000000" }, b: thin } }, // the totals row
  ]);
  assert.deepEqual([sheet.table.get(key(1, 3)), sheet.table.has(key(ROWS, 0)), sheet.table.has(key(5, 0))], [undefined, false, true]);
  assert.ok(bytes / CELLS < 40, `${(bytes / CELLS).toFixed(0)} bytes a cell`);
});

test("rows that LibreOffice saves with their height (default or not) keep under 40 bytes a cell", async () => {
  // LibreOffice writes every row's height, even the default one; only row 5 here is taller.
  const n = 300000, out = [];
  for (let r = 1; r <= n; r++) {
    out.push(`<row r="${r}" s="0" customFormat="false" ht="${r === 5 ? 30 : 12.8}" hidden="false" customHeight="${r === 5}" outlineLevel="0" collapsed="false">`
      + `<c r="A${r}" s="0" t="n"><v>${r}</v></c></row>`);
  }
  const book = workbook(out.join(""), "", { before: `<sheetFormatPr defaultColWidth="11.53515625" defaultRowHeight="12.8" zeroHeight="false" outlineLevelRow="0" outlineLevelCol="0"/>` });
  const { kept: sheet, bytes } = await retained(async () => (await openXlsx(book)).loadSheet(0));
  assert.deepEqual([3, 4, 5].map((r) => rowHeight(sheet, r)), [17, 40, 17]);
  assert.ok(bytes / n < 40, `${(bytes / n).toFixed(0)} bytes a cell`);
});

test("a closed workbook lets its sheets go, though something still holds it and its sheet", async () => {
  // The runtime frees what a closed tab held only when it collects cycles: closing must not wait.
  const book = workbook(numbers(ROWS), RULES);
  const { kept, bytes } = await retained(async () => {
    const wb = await openXlsx(book);
    const sheet = await wb.loadSheet(0);
    wb.close();
    return { wb, sheet };
  });
  assert.deepEqual([kept.wb.sheet(0), kept.sheet.cells.size, kept.sheet.cf.get(key(0, 0))], [null, 0, undefined]);
  assert.ok(bytes < 1e6, `${(bytes / 1e6).toFixed(1)} MB kept`);
});

test("a CSV of 300,000 cells keeps under 40 bytes a cell, each shown as written", async () => {
  const lines = ['"1,5",007,word'];
  for (let i = 1; i < ROWS; i++) lines.push(`${i},${i}.25,${i % 1000}`);
  const text = lines.join("\n");
  const { kept: csv, bytes } = await retained(() => readCsvText(text, { tick: async () => {} }));
  const shown = (r, c) => { const cell = csv.cells.get(key(r, c)); return [cell.v, cell.text]; };
  assert.deepEqual([shown(0, 0), shown(0, 1), shown(0, 2), shown(5, 1), shown(ROWS - 1, 2)], [[1.5, "1,5"], [7, "007"], ["word", "word"], [5.25, "5.25"], [999, "999"]]);
  assert.equal(csv.cells.get(key(0, 3)), undefined);
  assert.ok(bytes / CELLS < 40, `${(bytes / CELLS).toFixed(0)} bytes a cell`);
});

test("closing a workbook while its sheet is being read stops the read", async () => {
  // The clock runs fast, so the reader yields often; the workbook closes at the 5th yield.
  const book = workbook(numbers(ROWS));
  let pauses = 0, wb = null;
  const pause = () => new Promise((r) => { if (wb && ++pauses === 5) wb.close(); setImmediate(r); });
  const now = Date.now;
  Date.now = () => performance.now() * 1000;
  try {
    const opened = await openXlsx(book, { pause });
    wb = opened;
    await assert.rejects(opened.loadSheet(0), /closed/);
    assert.equal(opened.sheet(0), null);
  } finally { Date.now = now; }
});

test("cells written out of order or twice are all there once, the later one winning", async () => {
  const rows = `<row r="1"><c r="B1"><v>2</v></c><c r="A1"><v>1</v></c><c r="B1"><v>3</v></c></row><row r="2"><c r="A2"><v>4</v></c></row>`;
  const sheet = await (await openXlsx(workbook(rows))).loadSheet(0);
  assert.deepEqual([sheet.cells.size, [...sheet.cells.values()].map((c) => [c.r, c.c, c.v]).sort()],
    [3, [[0, 0, 1], [0, 1, 3], [1, 0, 4]]]);
});
