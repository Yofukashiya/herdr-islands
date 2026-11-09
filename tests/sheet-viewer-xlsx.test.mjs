// Formulas the spreadsheet viewer computes itself while it reads a sheet
// (mods/sheet-viewer/xlsx.js): cells saved without a value and conditional-format expressions.
// Run with `node --test` from the repository's root.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openXlsx, key } from "../mods/sheet-viewer/xlsx.js";

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** A one-sheet workbook as openXlsx reads it, from the sheet's sheetData and what follows it. */
function workbook(sheetData, after = "") {
  const parts = {
    "xl/workbook.xml": `<workbook ${NS}><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + `<Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/>`
      + `<Relationship Id="rId2" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
    "xl/styles.xml": `<styleSheet ${NS}><dxfs count="1"><dxf><fill><patternFill><bgColor rgb="FFFFC7CE"/></patternFill></fill></dxf></dxfs></styleSheet>`,
    "xl/worksheets/sheet1.xml": `<worksheet ${NS}><sheetData>${sheetData}</sheetData>${after}</worksheet>`,
  };
  return { text: async (p) => parts[p] ?? null, exists: async (p) => p in parts };
}

const column = (...values) => values.map((v, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${v}</v></c></row>`).join("");

test("a cell saved without its value, as openpyxl writes =SUM(A:A), shows the column's sum", async () => {
  const wb = await openXlsx(workbook(column(1, 2, 9) + `<row r="4"><c r="B4"><f>SUM(A:A)</f></c></row>`));
  const sheet = await wb.loadSheet(0);
  assert.equal(sheet.cells.get(key(3, 1)).v, 12);
});

test("an expression rule =A1>AVERAGE(A:A) colors the cells above the column's average", async () => {
  const rule = `<conditionalFormatting sqref="A1:A3"><cfRule type="expression" dxfId="0" priority="1">`
    + `<formula>A1&gt;AVERAGE(A:A)</formula></cfRule></conditionalFormatting>`;
  const wb = await openXlsx(workbook(column(1, 2, 9), rule));
  const sheet = await wb.loadSheet(0);
  assert.deepEqual([0, 1, 2].map((r) => sheet.cf.get(key(r, 0))?.fill ?? null), [null, null, "#ffc7ce"]);
});

test("a rule over a whole row (sqref 2:2) colors that row's cells", async () => {
  const rows = `<row r="1"><c r="A1"><v>5</v></c><c r="B1"><v>5</v></c></row>`
    + `<row r="2"><c r="A2"><v>5</v></c><c r="B2"><v>1</v></c><c r="C2"><v>7</v></c></row>`;
  const rule = `<conditionalFormatting sqref="2:2"><cfRule type="cellIs" dxfId="0" priority="1" operator="greaterThan">`
    + `<formula>4</formula></cfRule></conditionalFormatting>`;
  const wb = await openXlsx(workbook(rows, rule));
  const sheet = await wb.loadSheet(0);
  const filled = [...sheet.cf].filter(([, s]) => s.fill).map(([k]) => k).sort((a, b) => a - b);
  assert.deepEqual(filled, [key(1, 0), key(1, 2)]);
});

test("a formula that names its own sheet (=SUM(Sheet1!A:A) on Sheet1) reads it while the sheet loads", async () => {
  const wb = await openXlsx(workbook(column(1, 2, 9) + `<row r="4"><c r="B4"><f>SUM(Sheet1!A:A)</f></c><c r="C4"><f>Sheet1!A3</f></c></row>`));
  const sheet = await wb.loadSheet(0);
  assert.deepEqual([sheet.cells.get(key(3, 1)).v, sheet.cells.get(key(3, 2)).v], [12, 9]);
});

test("a cell =A:A*2 reads its own row of A, as Excel does", async () => {
  const wb = await openXlsx(workbook(column(1, 2, 9).replace('<c r="A3"><v>9</v></c>', '<c r="A3"><v>9</v></c><c r="B3"><f>A:A*2</f></c>')));
  const sheet = await wb.loadSheet(0);
  assert.equal(sheet.cells.get(key(2, 1)).v, 18);
});

test("a total isn't spoiled by a cell that reads itself through the column (A1 =IFERROR(SUM(A:A),0))", async () => {
  const rows = `<row r="1"><c r="A1"><f>IFERROR(SUM(A:A),0)</f></c></row>`
    + `<row r="2"><c r="A2"><v>1</v></c></row><row r="3"><c r="A3"><v>2</v></c></row>`
    + `<row r="5"><c r="B5"><f>SUM(A:A)</f></c></row>`;
  const sheet = await (await openXlsx(workbook(rows))).loadSheet(0);
  assert.deepEqual([sheet.cells.get(key(0, 0)).v, sheet.cells.get(key(4, 1)).v], [0, 3]);
});

test("a total above 20,000 formulas saved without values doesn't compute them all without a yield", async () => {
  // The runtime stops a script that runs ~0.5 s without yielding. The clock runs fast here, so the
  // reader yields at every chance and the longest stretch between yields is the work it can't split.
  const longest = async (total) => {
    let rows = "";
    for (let i = 1; i <= 20000; i++) rows += `<row r="${i}"><c r="A${i}"><v>${i}</v></c><c r="B${i}"><f>A${i}*2</f></c>${i === 1 ? `<c r="C1"><f>${total}</f></c>` : ""}</row>`;
    let last = performance.now(), worst = 0;
    const pause = async () => { worst = Math.max(worst, performance.now() - last); await new Promise((r) => setImmediate(r)); last = performance.now(); };
    const now = Date.now;
    Date.now = () => performance.now() * 1000;
    try {
      const sheet = await (await openXlsx(workbook(rows), { pause })).loadSheet(0);
      worst = Math.max(worst, performance.now() - last);
      return { worst, c1: sheet.cells.get(key(0, 2)).v };
    } finally { Date.now = now; }
  };
  const plain = await longest("B1"), total = await longest("SUM(B:B)");
  assert.equal(total.c1, 400020000);
  assert.ok(total.worst < 3 * plain.worst + 10, `longest stretch ${total.worst.toFixed(0)} ms, ${plain.worst.toFixed(0)} ms without the total`);
});
