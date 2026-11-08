// Agents radar: a drawer on the window's edge. Closed, only a slim strip shows: how many
// agents and each one's status (a red dot that pulses when one needs you, a spinner while
// one works). Hovered, it slides out with every agent: its space color, name, where it is
// and the last line on its screen; a click goes to it. Drag it to another edge or third.
//
// Layout: on the root, `"floating": [{ "id": "radar", "content": { "mod": "agent-radar" },
// "edge": "right", "align": "center", "peek": 30 }]`. Herdr draws the frame and the slide;
// this mod draws one fixed layout and never changes it on hover (that keeps it smooth).
// Screens are read (`hc read`) only while the drawer is open, every 2 seconds.
// Hidden with `"radar": false` in sidebar-chrome/settings.json, or when no agent runs.
import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, placement, run, theme, hc, shared, settings } from "herdr";

const WIDTH = 300;
const ROW = 40;
const MAX = 8;
const READ_EVERY = 2000;
const GREEN = "#22c55e";
const AMBER = "#f59e0b";
const RED = "#ef4444";
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
const LABEL = { blocked: "Needs you", done: "Done", working: "Working…", idle: "Idle" };

/** The last meaningful line of a screen; agent TUIs' input box (between rules at the bottom) is skipped. */
export function lastLine(text) {
  const rule = /^[\s─━│┃╭╮╰╯┌┐└┘├┤┬┴┼═║╌╍┄┅—–\-_=]*$/;
  let lines = String(text ?? "").split(/\r?\n/).map((l) => l.replace(/\s+$/, ""));
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  const tail = lines.length - 8;
  const firstRule = lines.findIndex((l, i) => i >= tail && /[─━═╌╍┄┅]{8,}/.test(l) && rule.test(l));
  if (firstRule > 0) lines = lines.slice(0, firstRule);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (l && !rule.test(l)) return l;
  }
  return "";
}

function screenText(stdout) {
  const s = String(stdout ?? "");
  if (s.trimStart().startsWith("{")) {
    try { return JSON.parse(s).text ?? ""; } catch {}
  }
  return s;
}

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

export default class Radar extends View {
  init(_props, cx) {
    this.lines = {};
    this.lastRead = 0;
    this.reading = false;
    // Cheap check; reads only while the drawer is open.
    cx.timer.every(700, (cx) => {
      if (!placement()?.hovered || this.reading || Date.now() - this.lastRead < READ_EVERY) return;
      this.reading = true;
      this.lastRead = Date.now();
      cx.spawn(async (cx) => {
        const list = this.list();
        await Promise.all(list.map(async (a) => {
          const r = await hc(["read", a.address]).catch(() => null);
          if (r && r.code === 0) this.lines[a.address] = lastLine(screenText(r.stdout));
        }));
        this.reading = false;
        cx.notify();
      });
    });
  }

  /** Most urgent first (needs you, done, working, idle), then most recently changed. */
  list() {
    return [...agents()].sort((a, b) => (RANK[b.status] ?? 0) - (RANK[a.status] ?? 0) || b.seq - a.seq).slice(0, MAX);
  }

  status(t, s) {
    const box = h_flex().w(18).h(18).flex_none().items_center().justify_center();
    if (s === "blocked") return box.child(div().id("st-b").size(10).rounded_full().bg(RED).loop("opacity", { from: 0.3, to: 1, period: 900 }));
    if (s === "working") return box.child(svg("mods/agent-radar/spinner.svg").size(13).text_color(AMBER).spin(900));
    if (s === "done") return box.child(div().size(8).rounded_full().bg(GREEN));
    return box.child(div().size(8).rounded_full().border(1).border_color(t.dim));
  }

  render() {
    if (shared("islands.radar") === false) return div();
    const list = this.list();
    if (!list.length) return div();
    const t = theme();
    const p = placement() ?? { edge: "right", vertical: true };
    const colors = shared("islands.spaceColors") ?? {};
    const mono = settings()?.font_family ?? settings()?.font ?? "JetBrains Mono";
    const needs = list.filter((a) => a.status === "blocked").length;

    // Top or bottom edge: one row of chips, status and name.
    if (!p.vertical) {
      return h_flex().gap(4).p(2).text_size(12).children(list.map((a) =>
        h_flex().id(`rd-${a.address}`).h(30).px(8).gap(6).items_center().rounded(8).hover((s) => s.bg(t.hover))
          .on_click(() => run("pane.focus", { pane: a.pane }))
          .child(div().w(3).h(14).rounded_full().bg(colors[a.space] ?? t.accent))
          .child(this.status(t, a.status))
          .child(div().max_w(120).truncate().text_color(t.foreground).child(a.title || a.program?.name || a.address))));
    }

    // Left or right edge: rows with their edge side (status) toward the edge.
    const right = p.edge !== "left";
    const mirror = (el, parts) => el.children(right ? parts : [...parts].reverse());
    const header = mirror(h_flex().w(WIDTH).h(24).px(8).gap(8).items_center().text_size(11).text_color(t.dim), [
      div().flex_1().child("Agents"),
      h_flex().w(18).flex_none().justify_center().font_semibold().text_color(needs ? RED : t.muted).child(String(list.length)),
    ]);
    const row = (a) => {
      const line = this.lines[a.address];
      return mirror(h_flex().id(`rd-${a.address}`).w(WIDTH).h(ROW).px(8).gap(10).items_center().rounded(8)
        .when(a.focused, (el) => el.bg(t.selected))
        .hover((s) => s.bg(t.hover))
        .on_click(() => run("pane.focus", { pane: a.pane })), [
        div().w(3).h(26).flex_none().rounded_full().bg(colors[a.space] ?? t.accent),
        v_flex().flex_1().min_w(0).gap(2)
          .child(h_flex().gap(6).items_center().min_w(0)
            .child(icon(a.program, 13, t.foreground) ?? div())
            .child(div().min_w(0).truncate().text_size(12).text_color(t.foreground).child(a.title || a.program?.name || a.address))
            .child(div().flex_none().max_w(110).truncate().text_size(10.5).text_color(t.dim).child(`${a.space_name}${a.tab_name ? ` · ${a.tab_name}` : ""}`)))
          .child(div().truncate().font_family(mono).text_size(10.5)
            .text_color(a.status === "blocked" ? RED : t.dim)
            .child(line || LABEL[a.status] || "")),
        this.status(t, a.status),
      ]);
    };
    return v_flex().py(2).children([header, ...list.map(row)]);
  }
}
