// A pane's header, for layouts that frame their panes:
//   { "tab": "active", "pane": { "header": { "content": { "mod": "pane-header" } } } }
// Shows the program's icon (the app's program table), the agent's name or
// the terminal's title, the folder, and the agent's status; buttons split, zoom and close
// this pane. Props from the app: { pane, terminal }. Click: focus the pane.

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, props, run, theme, home, shared } from "herdr";

// The header at "main_opacity" in sidebar-chrome/settings.json (1 when unset), like the pane under it.
const mainFill = (c) => {
  const o = shared("islands.mainOpacity");
  if (typeof o !== "number" || o >= 1 || !/^#[0-9a-f]{6}$/i.test(c)) return c;
  return c + Math.round(Math.max(0, o) * 255).toString(16).padStart(2, "0");
};

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

// Home as "~". Windows paths use backslashes and any letter case for the drive
// ("C:\Users\me\repo"), so compare without either; the original only knew "/".
function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  const norm = (s) => s.replace(/\\/g, "/").replace(/^([a-z]):/, (_m, d) => d.toUpperCase() + ":");
  const c = norm(cwd), hh = norm(h).replace(/\/$/, "");
  return c === hh ? "~" : c.startsWith(hh + "/") ? "~" + cwd.slice(h.replace(/[\\/]$/, "").length) : cwd;
}

// Motion, all native (no timers, nothing runs while the pane isn't drawn).
const FADE = { duration: 160, easing: "ease-out" };
const FOCUS = { duration: 240, easing: "ease-out" };

export default class Pane extends View {
  init() { this.hovered = false; }

  me() {
    return panes().find((p) => p.pane === props()?.pane);
  }

  // Header buttons stay in place and fade in on hover instead of popping in; while
  // hidden they don't take clicks.
  button(t, id, icon, command, args, shown) {
    return div()
      .id(id)
      .p(3)
      .rounded(4)
      .text_color(t.dim)
      .opacity(shown ? 1 : 0)
      .transition("opacity", FADE)
      .when(shown, (el) => el
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          run(command, args);
        }))
      .child(svg(`mods/pane/${icon}.svg`).size(14));
  }

  render(cx) {
    const t = theme();
    const p = this.me();
    if (!p) return div();
    const name = ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
    const pic = icon(p.program, 14, t.dim);
    const st = p.status;
    const pane = p.pane;
    // In a split tab the focused pane's header gets an accent line that fades in as focus
    // moves to it (and out of the one it left). A lone pane is always focused: no line.
    const split = panes().filter((x) => x.tab === p.tab).length > 1 && !p.zoomed;
    const lit = split && p.focused;
    const h = this.hovered;
    return h_flex()
      .id(`pane-head-${pane}`)
      .relative()
      .size_full()
      .px(10)
      .gap(8)
      .items_center()
      .rounded_t(13).bg(mainFill(t.background)) // sits inside a 14px card
      .border_b(1)
      .border_color(t.border)
      .text_size(12)
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click(() => run("pane.focus", { pane }))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().truncate().max_w(260).font_medium().text_color(lit ? t.foreground : split ? t.muted : t.foreground).child(name))
      .child(div().flex_1().truncate().text_color(t.dim).child(folder(p.cwd)))
      .when(st === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      // "Needs you" breathes, so a blocked agent in a pane you aren't looking at is noticed.
      .when(st === "blocked", el => el.child(div().id(`ph-need-${pane}`).flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked)
        .loop("opacity", { from: 0.55, to: 1, period: 1600 }).child("Needs you")))
      .when(st === "done", el => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      .child(this.button(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }, h))
      .child(this.button(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }, h))
      .child(this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }, h))
      .child(this.button(t, `ph-x-${pane}`, "close", "pane.close", { pane }, h))
      // In the shown space's color (space-list publishes it), else the theme's accent.
      .child(div().id(`ph-focus-${pane}`).absolute().left(14).right(14).bottom(-1).h(2).rounded_full().bg(shared("islands.accent") ?? t.accent)
        .opacity(lit ? 1 : 0).transition("opacity", FOCUS));
  }
}
