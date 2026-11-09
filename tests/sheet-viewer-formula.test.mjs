// The spreadsheet viewer's formula evaluator (mods/sheet-viewer/formula.js), which computes cells
// saved without a value and conditional-format expressions.
// Run with `node --test` from the repository's root.
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../mods/sheet-viewer/formula.js";

/**
 * A ctx over sheets given as rows of values: `{ Sheet1: [[1, 2], [3]] }`. The first sheet is the
 * one a formula without a sheet name reads. `reads` counts the cells the evaluator asked for.
 */
function book(sheets) {
  const names = Object.keys(sheets);
  const ctx = {
    reads: 0,
    get(r, c, name) {
      ctx.reads++;
      const rows = sheets[name ?? names[0]];
      if (!rows) return { error: "#REF!" };
      return rows[r]?.[c] ?? null;
    },
    bounds(name) {
      const rows = sheets[name ?? names[0]];
      if (!rows) return null;
      return { maxRow: rows.length - 1, maxCol: Math.max(0, ...rows.map((row) => row.length - 1)) };
    },
  };
  return ctx;
}

/** The ctx with a memo that keeps every result. */
function remembering(ctx) {
  const kept = new Map();
  ctx.memo = (k, compute) => (kept.has(k) ? kept.get(k) : kept.set(k, compute()).get(k));
  return ctx;
}

test("SUM(A:A) adds up the whole column", () => {
  const ctx = book({ Sheet1: [[1, "x"], [2, 10], [null, 20], [4]] });
  assert.equal(evaluate("SUM(A:A)", ctx), 7);
});

test("COUNTA($B:$B) counts the column's filled cells, text and numbers alike", () => {
  const ctx = book({ Sheet1: [[1, "x"], [2, 10], [null, 20], [4]] });
  assert.equal(evaluate("COUNTA($B:$B)", ctx), 3);
});

test("SUM(Sheet2!C:C) reads the column on the sheet it names", () => {
  const ctx = book({ Sheet1: [[0, 0, 100]], Sheet2: [[0, 0, 5], [], [0, 0, 6]], "My data": [[0, 0, 7]] });
  assert.equal(evaluate("SUM(Sheet2!C:C)", ctx), 11);
  assert.equal(evaluate("SUM('My data'!C:C)", ctx), 7);
});

test("SUM(2:2) adds up the whole row", () => {
  const ctx = book({ Sheet1: [[100, 100], [1, 2, "x", 3], [100]] });
  assert.equal(evaluate("SUM(2:2)", ctx), 6);
  assert.equal(evaluate("SUM($2:$2)", ctx), 6);
});

test("a whole column on a sheet that isn't there reads as one #REF!, not a million", () => {
  const ctx = book({ Sheet1: [[1]] });
  assert.deepEqual(evaluate("SUM(Sheet9!A:A)", ctx), { error: "#REF!" });
  assert.equal(evaluate("COUNTA(Sheet9!A:A)", ctx), evaluate("COUNTA(Sheet9!A1)", ctx));
  assert.ok(ctx.reads < 100, `read ${ctx.reads} cells`);
});

test("copied one column right, A:A reads B:B and $A:$A stays; copied one row down, 1:1 reads 2:2", () => {
  const ctx = book({ Sheet1: [[1, 10], [2, 20]] });
  const right = { r: 0, c: 1, baseR: 0, baseC: 0 }, down = { r: 1, c: 0, baseR: 0, baseC: 0 };
  assert.equal(evaluate("SUM(A:A)", ctx, right), 30);
  assert.equal(evaluate("SUM($A:$A)", ctx, right), 3);
  assert.equal(evaluate("SUM(A:A)", ctx, down), 3);
  assert.equal(evaluate("SUM(1:1)", ctx, down), 22);
  assert.equal(evaluate("SUM($1:$1)", ctx, down), 11);
  assert.equal(evaluate("SUM(1:1)", ctx, right), 11);
});

test("with a memo, a rule checked on every row (A1>AVERAGE(A:A)) reads the column once, not once per row", () => {
  const n = 500;
  const ctx = remembering(book({ Sheet1: Array.from({ length: n }, (_, i) => [i]) }));
  const above = [];
  for (let r = 0; r < n; r++) if (evaluate("A1>AVERAGE(A:A)", ctx, { r, c: 0, baseR: 0, baseC: 0 })) above.push(r);
  assert.equal(above.length, 250);
  assert.equal(above[0], 250);
  assert.ok(ctx.reads < 3 * n, `read ${ctx.reads} cells`);
});

test("a whole column used as one value reads the formula's own row, as Excel does", () => {
  const ctx = book({ Sheet1: [["Yes", 10], ["No", 20], ["No", 30]] });
  const at = (r, c) => ({ r, c, baseR: 0, baseC: 0 });
  // A conditional format =$A:$A="Yes" over A1:A3.
  assert.deepEqual([0, 1, 2].map((r) => evaluate('$A:$A="Yes"', ctx, at(r, 0))), [true, false, false]);
  // =B:B*2 written in C3 reads B3; =-2:2 written in B5 reads B2.
  assert.equal(evaluate("B:B*2", ctx, { r: 2, c: 2 }), 60);
  assert.equal(evaluate("-2:2", ctx, { r: 4, c: 1 }), -20);
  // Outside the range there's nothing to read: #VALUE!, as in Excel.
  assert.deepEqual(evaluate("B1:B2*2", ctx, { r: 2, c: 2 }), { error: "#VALUE!" });
  // Without the formula's place, it can't be known.
  assert.equal(evaluate("B:B*2", ctx), undefined);
});

test("the memo tells apart arguments that print alike: Infinity, an empty one, \"1\" and 1", () => {
  const ctx = remembering(book({ Sheet1: [[1], [2], [3]] }));
  assert.equal(evaluate("SUM(A:A,10^400)", ctx), Infinity);
  assert.equal(evaluate("SUM(A:A,)", ctx), 6);
  assert.equal(evaluate('COUNT(A:A,"1")', ctx), 3);
  assert.equal(evaluate("COUNT(A:A,1)", ctx), 4);
});
