// Peek: rest the pointer on an agent in the list and a card opens beside it with the
// bottom of that agent's screen, updated while it is open. Read through `hc read`,
// only for the one agent being peeked at and only while its card is open.
import { div, svg, image } from "gpui-kit";
import { h_flex, v_flex, Popup } from "gpui-base";
import { hc, run, settings, shared } from "herdr";

const OPEN_DELAY = 450;  // ms resting on a row before the card opens
const CLOSE_DELAY = 220; // ms after leaving row and card before it closes: room to cross the gap
const REFRESH = 1500;    // ms between reads while open
const LINES = 16;
const WIDTH = 560;

/**
 * The bottom of a screen worth reading. Agent TUIs (Claude Code, Codex) end with an input
 * box drawn between horizontal rules plus a hint line: when rules show up among the last
 * few lines, everything from the first of them down is the input area and is cut. Then no
 * pure box-drawing lines, no runs of blank lines, no trailing blank lines.
 */
export function screenTail(text, n = LINES) {
  const rule = /^[\s─━│┃╭╮╰╯┌┐└┘├┤┬┴┼═║╌╍┄┅—–\-_=]*$/;
  const isRule = (l) => /[─━═╌╍┄┅]{8,}/.test(l) && rule.test(l);
  let lines = String(text ?? "").split(/\r?\n/).map((l) => l.replace(/\s+$/, ""));
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  const tail = lines.length - 8;
  const firstRule = lines.findIndex((l, i) => i >= tail && isRule(l));
  if (firstRule > 0) lines = lines.slice(0, firstRule);
  const out = [];
  for (const line of lines) {
    if (line && rule.test(line)) continue;
    if (!line && (!out.length || !out[out.length - 1])) continue;
    out.push(line);
  }
  while (out.length && !out[out.length - 1]) out.pop();
  return out.slice(-n);
}

/** `hc read` prints text; some versions answer JSON when piped. */
export function screenText(stdout) {
  const s = String(stdout ?? "");
  if (s.trimStart().startsWith("{")) {
    try { return JSON.parse(s).text ?? ""; } catch {}
  }
  return s;
}

export class Peek {
  constructor() {
    this.open = null;     // address of the agent whose card is open
    this.lines = {};      // address -> lines
    this.row = null;      // address of the row under the pointer
    this.card = false;    // pointer on the card
    this.timer = null;    // pending open/close
    this.poll = null;     // refresh while open
  }

  /** The row for `address` gained or lost the pointer. */
  hoverRow(address, on, cx) {
    if (on) {
      this.row = address;
      this.timer?.cancel();
      if (this.open === address) return;
      // Already peeking at another agent: switch at once; else wait a moment.
      const delay = this.open ? 0 : OPEN_DELAY;
      this.timer = cx.timer.after(delay, (cx) => { if (this.row === address) this.show(address, cx); });
    } else {
      if (this.row === address) this.row = null;
      this.closeSoon(cx);
    }
  }

  hoverCard(on, cx) {
    this.card = on;
    if (on) this.timer?.cancel();
    else this.closeSoon(cx);
  }

  closeSoon(cx) {
    this.timer?.cancel();
    this.timer = cx.timer.after(CLOSE_DELAY, (cx) => {
      if (this.row || this.card) return;
      this.hide();
      cx.notify();
    });
  }

  show(address, cx) {
    this.open = address;
    this.poll?.cancel();
    const read = (cx) => cx.spawn(async (cx) => {
      if (this.open !== address) return;
      const r = await hc(["read", address]).catch(() => null);
      if (r && r.code === 0) this.lines[address] = screenTail(screenText(r.stdout));
      if (this.open === address) cx.notify();
    });
    read(cx);
    this.poll = cx.timer.every(REFRESH, read);
    cx.notify();
  }

  hide() {
    this.open = null;
    this.card = false;
    this.poll?.cancel();
    this.poll = null;
  }

  /**
   * `row` wrapped so the card can open from it. Always wrapped (only the card comes and
   * goes), so the row keeps its identity and its hover state between renders.
   */
  wrap(t, a, row, { name, status, icon }) {
    const open = this.open === a.address;
    return Popup.new(`peek-${a.address}`, row)
      .anchor("top_left")
      .when(open, (el) => el.content(this.card_(t, a, { name, status, icon })));
  }

  card_(t, a, { name, status, icon }) {
    const lines = this.lines[a.address];
    const mono = settings()?.font_family ?? settings()?.font ?? "JetBrains Mono";
    const accent = (shared("islands.spaceColors") ?? {})[a.space] ?? t.accent;
    return v_flex()
      .id(`peek-card-${a.address}`)
      .w(WIDTH)
      .ml(8)
      .p(10)
      .gap(8)
      .bg(t.popover)
      .rounded(10)
      .border(1)
      .border_color(t.border)
      .shadow_lg()
      .on_hover((on, cx) => this.hoverCard(on, cx))
      .on_click(() => run("pane.focus", { pane: a.pane }))
      .child(
        h_flex().gap(8).items_center().text_size(12.5)
          .child(div().w(3).h(14).rounded_full().bg(accent))
          .when(Boolean(icon), (el) => el.child(icon))
          .child(div().min_w(0).truncate().font_semibold().text_color(t.foreground).child(name))
          .child(div().min_w(0).flex_1().truncate().text_color(t.dim).child(`${a.space_name}${a.tab_name ? ` · ${a.tab_name}` : ""}`))
          .child(status),
      )
      .child(
        v_flex().id(`peek-text-${a.address}`).p(8).rounded(6).bg(t.background).font_family(mono).text_size(11).text_color(t.foreground)
          .when(!lines, (el) => el.child(div().text_color(t.dim).child("Reading…")))
          .when(Boolean(lines) && lines.length === 0, (el) => el.child(div().text_color(t.dim).child("(empty screen)")))
          .when(Boolean(lines), (el) => el.children(lines.map((l, i) => div().id(`pl-${i}`).h(15).whitespace_nowrap().truncate().child(l || " ")))),
      )
      .child(div().text_size(10.5).text_color(t.dim).child("Click to open · updates live"));
  }
}
