// Workbooks for the spreadsheet viewer's tests (not a test file itself): parts given as text, read
// by openXlsx (mods/sheet-viewer/xlsx.js) the way it reads a workbook the system unzipped.

export const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
export const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/**
 * A one-sheet workbook from the sheet's sheetData and what follows it. `before` goes ahead of
 * sheetData (sheetFormatPr, say); `more` adds parts (a table's, say), and `sheetRels` is the
 * sheet's relationships, for those parts.
 */
export function workbook(sheetData, after = "", { before = "", more = {}, sheetRels = "" } = {}) {
  const parts = {
    "xl/workbook.xml": `<workbook ${NS}><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + `<Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/>`
      + `<Relationship Id="rId2" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
    "xl/styles.xml": `<styleSheet ${NS}><dxfs count="1"><dxf><fill><patternFill><bgColor rgb="FFFFC7CE"/></patternFill></fill></dxf></dxfs></styleSheet>`,
    "xl/worksheets/sheet1.xml": `<worksheet ${NS}>${before}<sheetData>${sheetData}</sheetData>${after}</worksheet>`,
    ...(sheetRels ? { "xl/worksheets/_rels/sheet1.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheetRels}</Relationships>` } : {}),
    ...more,
  };
  return { text: async (p) => parts[p] ?? null, exists: async (p) => p in parts };
}

/** Rows of column A, one value each: column(1, 2, 9). */
export const column = (...values) => values.map((v, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${v}</v></c></row>`).join("");
