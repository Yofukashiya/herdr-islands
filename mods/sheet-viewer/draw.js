// Draws a chart (chart.js primitives) with native GPUI elements: rects as divs, lines and
// polygons as vector paths (window.paint_path), text as positioned labels.
import { div, PathBuilder } from "gpui-kit";
import { parseChart, renderChart, resolveRefs } from "./chart.js";

const models = new Map(); // ctx.key -> parsed model (charts without cached values filled from the workbook)
const frames = new Map(); // key|w|h -> primitives

const withAlpha = (hex, a) => (a === undefined || a >= 1 || !/^#[0-9a-f]{6}$/i.test(hex) ? hex : hex + Math.round(Math.max(0, a) * 255).toString(16).padStart(2, "0"));

function pathEl(build, color) {
  const w = globalThis.window;
  return div().absolute().left(0).top(0).size_full().child(w.paint_path(build, color));
}

export function drawChart(xml, ctx) {
  let model = models.get(ctx.key);
  if (model === undefined) {
    try {
      model = parseChart(xml);
      if (model && ctx.lookup) resolveRefs(model, ctx.lookup);
    } catch { model = null; }
    if (models.size > 100) models.clear();
    models.set(ctx.key, model);
  }
  if (!model) return div().size_full().bg("#ffffff").flex().items_center().justify_center().text_size(12).text_color("#7f7f7f").child("Chart");
  const fk = `${ctx.key}|${Math.round(ctx.width)}|${Math.round(ctx.height)}|${ctx.zoom}`;
  let items = frames.get(fk);
  if (!items) {
    try {
      // The chart engine works at 100%; zoom scales its output.
      const z = ctx.zoom || 1;
      const out = renderChart(model, { width: ctx.width / z, height: ctx.height / z, theme: ctx.theme, font: ctx.theme?.minorFont ?? "Calibri", format: ctx.format });
      items = (out?.items ?? []).map((p) => scale(p, z));
    } catch (e) {
      items = [{ t: "text", x: ctx.width / 2, y: ctx.height / 2, s: "Chart could not be drawn", size: 12, color: "#7f7f7f", anchor: "middle", base: "middle" }];
    }
    if (frames.size > 200) frames.clear();
    frames.set(fk, items);
  }
  const kids = [];
  items.forEach((p, i) => {
    if (p.t === "rect") {
      if (p.w <= 0 || p.h <= 0) return;
      let el = div().absolute().left(p.x).top(p.y).w(p.w).h(p.h);
      if (p.fill) el = el.bg(withAlpha(p.fill, p.alpha));
      if (p.stroke) el = el.border(Math.max(1, Math.round(p.sw ?? 1))).border_color(withAlpha(p.stroke, p.alpha));
      if (p.r) el = el.rounded(p.r);
      kids.push(el);
    } else if (p.t === "line" && p.pts?.length > 1 && p.stroke) {
      let b = PathBuilder.stroke(Math.max(0.5, p.sw ?? 1)).add_polygon(p.pts, false);
      if (p.dash?.length) b = b.dash_array(p.dash);
      kids.push(pathEl(b.build(), withAlpha(p.stroke, p.alpha)));
    } else if (p.t === "poly" && p.pts?.length > 2) {
      if (p.fill) kids.push(pathEl(PathBuilder.fill().add_polygon(p.pts, true).build(), withAlpha(p.fill, p.alpha)));
      if (p.stroke) kids.push(pathEl(PathBuilder.stroke(Math.max(0.5, p.sw ?? 1)).add_polygon(p.pts, true).build(), withAlpha(p.stroke, p.alpha)));
    } else if (p.t === "text" && p.s) {
      const est = String(p.s).length * p.size * (p.bold ? 0.6 : 0.55) + 4;
      const vertical = p.rot === -90 || p.rot === 90;
      const w = vertical ? p.size * 1.4 : est, h = vertical ? est : p.size * 1.4;
      const x = p.anchor === "middle" ? p.x - w / 2 : p.anchor === "end" ? p.x - w : p.x;
      const y = p.base === "middle" ? p.y - h / 2 : p.base === "bottom" ? p.y - h : p.y;
      let el = div().absolute().left(x).top(y).w(w).h(h).flex().items_center()
        .when(p.anchor === "middle" || vertical, (e) => e.justify_center()).when(p.anchor === "end" && !vertical, (e) => e.justify_end())
        .text_size(p.size).text_color(p.color ?? "#595959").whitespace_nowrap();
      if (p.bold) el = el.font_weight(700);
      if (p.italic) el = el.italic();
      // GPUI can't rotate text: vertical labels stack their letters.
      el = vertical ? el.child(div().flex().flex_col().items_center().children([...String(p.s)].map((ch) => div().child(ch === " " ? " " : ch)))) : el.child(String(p.s));
      kids.push(el);
    }
  });
  return div().relative().size_full().children(kids);
}

function scale(p, z) {
  if (z === 1) return p;
  const q = { ...p };
  for (const k of ["x", "y", "w", "h", "sw", "r", "size"]) if (typeof q[k] === "number") q[k] *= z;
  if (q.pts) q.pts = q.pts.map(([x, y]) => [x * z, y * z]);
  if (q.dash) q.dash = q.dash.map((d) => d * z);
  return q;
}
