// The Islands status card, with plan usage and system load.
//
// Adapted from DanielFGray/herdr-config mods/usage (Apache-2.0), itself after herdr-gpui.
// Changed for Islands and for Windows/macOS:
// - drawn as an Islands card: rounded, the islands' fill and opacity, no divider; icons and
//   the agents dot colored like the Islands status card (machine `working`, branch `accent`,
//   dot `blocked` / `done` / `dim`);
// - fits any width: each part has a priority (agents, usage, space, branch, CPU, MEM, LOAD,
//   palette hint) and the bar shows the most important ones that fit, instead of clipping;
//   system load is not sampled while it is not shown;
// - CPU / MEM / LOAD on Windows and macOS too (system.js), not only Linux's /proc;
// - "Usage Dashboard" opens the browser on every platform (was `open` / `xdg-open` only);
// - environment read without `sh` on Windows; a missing program never stops the bar;
// - its own names (shared state, the refresh command), so it can live next to `usage`.
//
// Per signed-in agent service, a meter for the window closest to its limit. A click opens
// that service's details (this same mod, as a popup, with props.panel set): every window
// with what is left, time to reset and pace against an even spend. Only the bar copy reads
// the services; the popup renders what the bar publishes through shared state.
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, readTextFile, home, theme, shared, setShared, props, run, nextCommand, openOverlay, closeOverlay, appHome, spaces, agents, window, keys, settings } from "herdr";
import * as fs from "fs/promises";
import { UsageService } from "./service.js";
import { resetIn, ago, tightest, pace, describePace } from "./format.js";
import { forPlatform, HISTORY, INTERVAL as SYSTEM_INTERVAL, memoryPercent, gigabytes, uptime } from "./system.js";

const MOD = "status-bar";
const STORAGE_KEY = "usage.v1";
const SHARED = MOD; // the readings, for the popup copy
const REFRESH_KEY = `${MOD}.refresh`; // which provider the popup asked for
const METER_WIDTH = 40;
const PANEL_WIDTH = 340;
const FONT = 12;
const SMALL = FONT * 0.9;
const BAR_TEXT = 11.8;
// herdr-gpui's system load thresholds: yellow from these, red from 90%.
const CPU_WARN = 75;
const MEMORY_WARN = 80;
const SPARK_HEIGHT = 11;
// Width budget: average Geist glyph at BAR_TEXT, the gap between parts, the card's padding.
const CHAR = BAR_TEXT * 0.56;
const GAP = 16;
const PAD = 14;
// Motion, all native: transitions run only when a value changes, loops only while drawn.
const GROW = { duration: 700, easing: "ease-out" };
const SPARK = { duration: 450, easing: "ease-out" };
const PULSE_SLOW = { from: 0.35, to: 1, period: 1800 };
const PULSE_FAST = { from: 0.3, to: 1, period: 900 };
const PULSE_LOW = { from: 0.45, to: 1, period: 1400 };

// Signal colors for the meters and the agents dot: saturated on purpose. The themes' own
// ansi/status colors are pastel and wash out on a 6px bar. Read well on dark and light.
const GREEN = "#22c55e";
const AMBER = "#f59e0b";
const RED = "#ef4444";

/**
 * A plan limit's color by what is LEFT (rounded, as the popup prints it):
 * 50% or more green, 11–49% amber, 10% or less red.
 */
function leftColor(left) {
  const l = Math.round(left);
  return l <= 10 ? RED : l < 50 ? AMBER : GREEN;
}

// The islands' fill at the opacity in sidebar-chrome/settings.json (1 when unset).
const islandFill = (c) => {
  const o = shared("islands.opacity");
  if (typeof o !== "number" || o >= 1 || !/^#[0-9a-f]{6}$/i.test(c)) return c;
  return c + Math.round(Math.max(0, o) * 255).toString(16).padStart(2, "0");
};

/** "windows" | "macos" | "linux". */
function platform() {
  const p = window()?.platform;
  if (p) return p;
  const h = home();
  return /^[A-Za-z]:/.test(h) ? "windows" : h.startsWith("/Users") ? "macos" : "linux";
}

export default class Usage extends View {
  init(_props, cx) {
    this.width = null;
    this.showSystem = true;
    if (props()?.panel) return;
    this.system = forPlatform(platform(), { readTextFile, exec });
    // Sampling runs a program on Windows and macOS: only while the bar shows the numbers.
    const sample = (cx) => this.showSystem && cx.spawn(async (cx) => (await this.system.sample()) && cx.notify());
    cx.timer.every(SYSTEM_INTERVAL, sample);
    sample(cx);
    cx.spawn(async (cx) => {
      const config = (await readConfig()) ?? {};
      this.service = new UsageService(await herdrIo(), { providers: config.providers, saved: load() });
      const publish = (cx) => {
        const snapshot = this.service.snapshot();
        save(this.service);
        setShared(SHARED, snapshot);
        cx.notify();
      };
      publish(cx);
      // The popup is another copy of this mod: it asks for a refresh with the
      // `status-bar.refresh` command, naming the provider in shared state.
      cx.spawn(async (cx) => {
        for (;;) {
          if ((await nextCommand()) !== "refresh") continue;
          const only = shared(REFRESH_KEY)?.id ?? null;
          this.service.refresh({ manual: true, only, onProgress: () => publish(cx) });
        }
      });
      // Reads are rare, so the clock ticks only to re-time "resets in" and
      // to start whichever reads have come due.
      cx.timer.every(30e3, (cx) => {
        this.service.refresh({ onProgress: () => publish(cx) });
        cx.notify();
      });
      await this.service.refresh({ onProgress: () => publish(cx) });
    });
  }

  render(cx) {
    const t = theme();
    const data = shared(SHARED) ?? { readings: [], busy: false };
    const panel = props()?.panel;
    return panel ? this.renderPanel(t, data.readings.find((r) => r.id === panel), data.pending?.includes(panel)) : this.renderBar(t, data);
  }

  // The one status card: where you are (machine, branch, agents), a meter per service
  // (its numbers live in the popup), this machine's CPU, memory and load, and the
  // command palette hint. Parts that don't fit the card's width are left out, least
  // important first.
  renderBar(t, data) {
    const space = spaces().find((s) => s.active);
    const list = agents();
    const needs = list.filter((a) => a.status === "blocked").length;
    const working = list.some((a) => a.status === "working");
    const label = (icon, text, color) =>
      h_flex().flex_none().gap(6).items_center().child(svg(`mods/status-bar/${icon}.svg`).size(13).text_color(color)).child(div().max_w(220).truncate().child(text));
    // As herdr-gpui: only services with numbers, closest to a limit first
    // (a stable sort keeps equals in registry order). The rest wait in the popup.
    const shown = data.readings.filter(hasNumbers).sort((a, b) => urgency(b) - urgency(a));
    const sys = this.system?.latest;
    // The shown space's color (space-list publishes it), else the theme's accent.
    const accent = /^#[0-9a-f]{6}$/i.test(shared("islands.accent") ?? "") ? shared("islands.accent") : t.accent;
    const spaceName = space?.name ?? "";
    const letter = [...spaceName][0]?.toUpperCase() ?? "?";
    const agentsText = `${list.length} ${list.length === 1 ? "agent" : "agents"}`;
    const needsText = `· ${needs} needs you`;
    const hint = `${paletteKey()}  commands`;
    const text = (s) => String(s).length * CHAR;

    // [id, side, estimated width, element]; listed in priority order.
    const parts = [
      ["agents", "left", 12 + text(agentsText) + (needs > 0 ? 6 + text(needsText) : 0),
        // The dot: red and quick when an agent needs you, amber and slow while one works.
        () => h_flex().flex_none().gap(6).items_center()
          .child(div().id("agents-dot").size(6).rounded(3)
            .bg(needs > 0 ? RED : working ? AMBER : list.length > 0 ? GREEN : t.dim)
            .when(needs > 0, (el) => el.loop("opacity", PULSE_FAST))
            .when(needs === 0 && working, (el) => el.loop("opacity", PULSE_SLOW)))
          .child(agentsText)
          .when(needs > 0, (el) => el.child(div().text_color(t.blocked).child(needsText)))],
      ["usage", "left", shown.reduce((w, r) => w + 16 + text(r.name) + METER_WIDTH + (r.error ? 14 : 0), 22),
        () => h_flex().flex_none().h_full().gap(4).items_center()
          .children(shown.map((r) => segment(t, r)))
          .child(div().id("usage-refresh").size(18).flex().items_center().justify_center().rounded(4)
            .hover((s) => s.bg(t.hover)).on_click(() => requestRefresh(null))
            .child(svg(`mods/${MOD}/refresh.svg`).size(11).text_color(t.muted).when(data.busy, (e) => e.spin(1000))))],
      // Which project: the space's letter tile in its color and its name (@machine when remote).
      ...(space ? [["space", "left", 20 + Math.min(160, text(spaceName)) + (space.machine ? 6 + text(`@${space.machine}`) : 0),
        () => h_flex().flex_none().gap(6).items_center()
          .child(h_flex().size(14).flex_none().rounded(4).bg(accent).items_center().justify_center().text_size(9).font_bold().text_color("#ffffff").child(letter))
          .child(div().max_w(160).truncate().text_color(t.foreground).child(spaceName))
          .when(Boolean(space.machine), (el) => el.child(div().text_color(t.dim).child(`@${space.machine}`)))]] : []),
      ...(space?.branch ? [["branch", "left", 19 + Math.min(220, text(space.branch)), () => label("branch", space.branch, accent)]] : []),
      ...(sys ? [["cpu", "right", text("CPU") + 2 * 5 + HISTORY * 3 + 28, () => cpuItem(t, this.system)]] : []),
      ...(sys?.memory ? [["mem", "right", text("MEM") + 2 * 5 + 32 + 28, () => memItem(t, sys.memory)]] : []),
      ...(sys?.load ? [["load", "right", text("LOAD") + 10 + 3 * 30, () => loadItem(t, sys)]] : []),
      ["palette", "right", text(hint), () => div().id("palette").flex_none().text_color(t.dim).on_click(() => run("app.palette")).child(hint)],
    ];

    // Keep parts in priority order while they fit; before the first measure, show all.
    // The measured width is in zoomed pixels (settings.json "zoom" scales text and px alike),
    // the estimates above are at zoom 1. The spacer between the two sides costs two gaps.
    const zoom = Number(settings()?.zoom) || 1;
    const room = this.width == null ? Infinity : this.width / zoom - 2 * PAD - 2 * GAP;
    const keep = new Set();
    let used = 0;
    for (const [id, , w] of parts) {
      const add = w + (keep.size ? GAP : 0);
      if (used + add > room) continue;
      used += add;
      keep.add(id);
    }
    // Until the first reading lands there are no system parts to keep: go on sampling, or a failed
    // first sample would leave CPU and MEM off until the mod reloads.
    this.showSystem = !sys || keep.has("cpu") || keep.has("mem") || keep.has("load");

    const order = ["space", "branch", "agents", "usage", "cpu", "mem", "load", "palette"];
    const pick = (side) => order.map((id) => parts.find((p) => p[0] === id && p[1] === side && keep.has(id))).filter(Boolean).map((p) => p[3]());
    const tooltip = sys ? systemDetails(sys) : null;
    return h_flex()
      .id("status-bar-bar")
      .on_size_change((size, cx) => {
        if (Math.abs((this.width ?? 0) - size.width) < 1) return;
        this.width = size.width;
        cx.notify();
      })
      .size_full()
      .min_w(0)
      .px(PAD)
      .gap(GAP)
      .items_center()
      .rounded(13) // its own card: rounded inside the 14px card, no divider
      .overflow_hidden()
      .bg(islandFill(t.chrome))
      .text_size(BAR_TEXT)
      .text_color(t.muted)
      .children(pick("left"))
      .child(div().flex_1().min_w(0))
      .child(
        h_flex().id("system-load").flex_none().h_full().gap(GAP).items_center()
          .when(Boolean(tooltip) && this.showSystem, (el) => el.tooltip(tooltip))
          .children(pick("right")),
      );
  }

  // herdr-gpui's usage panel: header, errors, then windows, balances and
  // sections ruled off from each other, then the actions.
  renderPanel(t, reading, refreshing) {
    const frame = v_flex().w(PANEL_WIDTH).p(4).bg(t.popover).text_size(FONT).text_color(t.foreground);
    if (!reading) return frame.child(block().text_color(t.muted).child("Not updated yet"));
    const report = reading.report;
    const groups = report
      ? [
          ...(report.windows.length ? [block().children(report.windows.map((w) => limit(t, w)))] : []),
          ...(report.balances.length ? [balances(t, report.balances)] : []),
          ...report.sections.map((s) => section(t, s)),
        ]
      : [];
    const updated = reading.updated ? `Updated ${ago(reading.updated)} ago` : refreshing ? "Updating…" : "Not updated yet";
    return frame
      .child(
        h_flex()
          .px(8)
          .py(6)
          .gap(12)
          .justify_between()
          .child(v_flex().flex_1().min_w(0).child(div().text_size(FONT * 1.25).font_semibold().child(reading.name)).child(div().truncate().text_size(SMALL).text_color(t.muted).child(updated)))
          .child(
            v_flex()
              .flex_none()
              .max_w(PANEL_WIDTH * 0.6)
              .items_end()
              .text_color(t.muted)
              .when(report?.email, (el) => el.child(div().max_w_full().truncate().child(report.email)))
              .when(report?.plan, (el) => el.child(div().text_size(SMALL).child(report.plan))),
          ),
      )
      .when(reading.error, (el) => el.child(div().px(8).pb(4).text_size(SMALL).text_color(t.ansi3).child(reading.error)))
      .children(groups.flatMap((g) => [rule(t), g]))
      .child(rule(t))
      .child(action(t, "usage-refresh-one", "refresh", refreshing ? "Refreshing…" : "Refresh", () => !refreshing && requestRefresh(reading.id), refreshing))
      .child(
        action(t, "usage-open", "chart", "Usage Dashboard", () => {
          openUrl(reading.dashboard);
          closeOverlay(props().overlay);
        }),
      );
  }
}

/** The system load tooltip: cores, memory in GB, uptime. */
function systemDetails({ cpu, cores, memory, load, uptime: up }) {
  return [
    "This computer",
    `${cpu === null ? "CPU measuring…" : `CPU ${Math.round(cpu)}%`}${cores ? ` of ${cores} cores` : ""}${load ? ` · load ${load.map((l) => l.toFixed(2)).join(" ")}` : ""}`,
    ...(memory ? [`Memory ${gigabytes(memory.used)} of ${gigabytes(memory.total)} (${Math.round(memoryPercent(memory))}%)`] : []),
    ...(up ? [`Up ${uptime(up)}`] : []),
  ].join("\n");
}

const sysLabel = (t, name) => div().flex_none().text_color(t.muted).child(name);
const sysItem = () => h_flex().flex_none().items_center().gap(5);

/** `CPU ▁▃▂▅ 12%`. */
function cpuItem(t, system) {
  const cpu = system.latest.cpu;
  return sysItem().child(sysLabel(t, "CPU")).child(sparkline(t, system.history)).when(cpu !== null, (el) => el.child(share(t, cpu, CPU_WARN)));
}

/** `MEM ━━─ 61%`. */
function memItem(t, memory) {
  const p = memoryPercent(memory);
  return sysItem().child(sysLabel(t, "MEM")).child(loadMeter(t, p, MEMORY_WARN)).child(share(t, p, MEMORY_WARN));
}

/** `LOAD 0.73 1.05 1.10`; load per core reads as a share of the machine, so it warns as CPU does. */
function loadItem(t, { load, cores }) {
  const perCore = cores ? (load[0] / cores) * 100 : 0;
  return sysItem()
    .child(sysLabel(t, "LOAD"))
    .child(div().text_color(loadSeverity(perCore, CPU_WARN, t, t.foreground)).child(load[0].toFixed(2)))
    .child(div().text_color(t.muted).child(`${load[1].toFixed(2)} ${load[2].toFixed(2)}`));
}

/** The global key that opens the palette, as the hint shows it: "ctrl-shift-p" → "Ctrl Shift P". */
function paletteKey() {
  const bound = keys().find((k) => k.section === "global" && k.action === "app.palette")?.keys;
  if (!bound) return "Palette:";
  const mac = platform() === "macos";
  return bound
    .split("-")
    .map((part) => (part === "cmd" || (mac && part === "ctrl") ? "⌘" : part[0].toUpperCase() + part.slice(1)))
    .join(" ");
}

/** Recent CPU usage as thin bars, oldest on the left; empty slots wait on the left until the history fills. Bars glide to each new height. */
function sparkline(t, history) {
  const slots = [...Array(HISTORY - history.length).fill(null), ...history];
  return h_flex()
    .flex_none()
    .items_end()
    .gap(1)
    .h(SPARK_HEIGHT)
    .children(slots.map((v, i) => div().id(`spark-${i}`).w(2).rounded(0.5).transition("height", SPARK)
      .h(v === null ? 1 : Math.max(1, (SPARK_HEIGHT * v) / 100))
      .bg(v === null ? t.hover : loadSeverity(v, CPU_WARN, t, t.muted))));
}

function loadMeter(t, used, warn) {
  return div()
    .w(32)
    .h(5)
    .flex_none()
    .rounded_full()
    .overflow_hidden()
    .bg(t.hover)
    .child(div().id("mem-fill").h_full().w((32 * used) / 100).rounded_full().bg(loadSeverity(used, warn, t, t.muted)).transition("width", GROW));
}

/** "12%", wide enough for "100%" so the bar does not shift as the number changes. */
function share(t, value, warn) {
  return div().flex_none().min_w(28).text_color(loadSeverity(value, warn, t, t.foreground)).child(`${Math.round(value)}%`);
}

/** `normal` below `warn`, yellow from it, red from 90%. */
function loadSeverity(value, warn, t, normal) {
  return value >= 90 ? t.ansi1 : value >= warn ? t.ansi3 : normal;
}

/** A bar segment: name, a meter of the tightest window, "!" when the last read failed. */
function segment(t, reading) {
  const report = reading.report;
  const worst = tightest(report.windows);
  const balance = !worst && report.balances[0];
  return h_flex()
    .id(`usage-${reading.id}`)
    .flex_none()
    .h_full()
    .gap(6)
    .px(6)
    .items_center()
    .rounded(4)
    .hover((s) => s.bg(t.hover))
    .on_click(() => openOverlay({ mod: MOD, kind: "popup", props: { panel: reading.id }, width: PANEL_WIDTH }))
    .child(div().text_color(t.foreground).child(reading.name))
    .when(worst, (el) => el.child(meter(t, reading.id, worst.used)))
    // A service that meters money rather than a window shows what is left or spent.
    .when(balance, (el) => el.child(money(balance.amount)))
    // The numbers are the last good ones; the popup says why.
    .when(reading.error, (el) => el.child(div().flex_none().text_color(t.ansi3).child("!")));
}

/** "Weekly 89% left", its reset, a bar of what is left with a tick where an even spend would have left it, and whether the rest lasts. */
function limit(t, w) {
  const p = pace(w);
  return v_flex()
    .gap(4)
    .child(
      h_flex()
        .justify_between()
        .gap(8)
        .child(div().font_semibold().child(`${w.label} ${100 - Math.round(w.used)}% left`))
        .when(w.resetsAt != null, (el) => el.child(div().flex_none().text_size(SMALL).text_color(t.muted).child(`Resets in ${resetIn(w.resetsAt)}`))),
    )
    .child(bar(t, 100 - w.used, p))
    .when(p, (el) => el.child(div().text_size(SMALL).text_color(t.muted).child(describePace(p, w.used))));
}

/** One row per balance; one with a total gets a bar of what is left. */
function balances(t, list) {
  return block().children(
    list.map((b) => {
      const row = h_flex()
        .justify_between()
        .gap(8)
        .child(div().text_color(t.muted).child(b.label))
        .child(div().font_semibold().child(b.total != null ? `${money(b.amount)} of ${money(b.total)}` : money(b.amount)));
      if (!(b.total > 0)) return row;
      const left = Math.min(100, Math.max(0, (b.amount / b.total) * 100));
      return v_flex().gap(4).child(row).child(bar(t, left, null));
    }),
  );
}

function section(t, s) {
  return block()
    .child(div().font_semibold().child(s.title))
    .children((s.windows ?? []).map((w) => limit(t, w)))
    .children((s.facts ?? []).map(([k, v]) => h_flex().justify_between().gap(8).text_size(SMALL).child(div().text_color(t.muted).child(k)).child(div().child(v))));
}

/** Padding every panel group shares, so they line up. */
function block() {
  return v_flex().px(8).py(6).gap(4);
}

function rule(t) {
  return div().h(1).my(6).bg(t.hover);
}

function action(t, id, icon, label, onClick, disabled = false) {
  return h_flex()
    .id(id)
    .px(8)
    .py(6)
    .gap(8)
    .items_center()
    .rounded(4)
    .text_color(disabled ? t.muted : t.foreground)
    .hover((s) => s.bg(t.hover))
    .on_click(onClick)
    .child(svg(`mods/${MOD}/${icon}.svg`).size(14).flex_none())
    .child(label);
}

/** The panel's full-width bar of what is left (`left` percent), colored by it; the tick marks where an even spend would have left it. */
function bar(t, left, p) {
  const l = Math.min(100, Math.max(0, left));
  return div()
    .relative()
    .w_full()
    .h(6)
    .rounded_full()
    .bg(t.hover)
    .child(div().h_full().w(`${l}%`).rounded_full().bg(leftColor(l)))
    .when(p, (el) => el.child(div().absolute().top(-2).h(10).w(2).left(`${Math.min(100, Math.max(0, 100 - p.expected))}%`).bg(t.foreground)));
}

/**
 * The status bar's small meter of what is LEFT, like a battery: full and green when fresh,
 * shrinking through amber to red. It glides to each new reading, and breathes at 10% or less.
 */
function meter(t, id, used) {
  const left = Math.min(100, Math.max(0, 100 - used));
  return div()
    .w(METER_WIDTH)
    .h(6)
    .flex_none()
    .rounded_full()
    .overflow_hidden()
    .bg(t.hover)
    .child(div().id(`meter-${id}`).h_full().w((METER_WIDTH * left) / 100).rounded_full().bg(leftColor(left))
      .transition("width", GROW)
      .when(Math.round(left) <= 10, (el) => el.loop("opacity", PULSE_LOW)));
}

const money = (amount) => `$${amount.toFixed(2)}`;
const hasNumbers = (r) => r.report && (r.report.windows.length > 0 || r.report.balances.length > 0);
const urgency = (r) => tightest(r.report?.windows ?? [])?.used ?? 0;

/** Asks the bar copy to read one provider, or all with `id` null, now. */
function requestRefresh(id) {
  setShared(REFRESH_KEY, { id, at: Date.now() });
  run(`${MOD}.refresh`);
}

/** The system browser, on every platform. */
function openUrl(url) {
  const p = platform();
  const [cmd, args] = p === "windows" ? ["explorer", [url]] : p === "macos" ? ["open", [url]] : ["xdg-open", [url]];
  exec(cmd, args).catch(() => {});
}

const ENV = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_DATA_HOME", "ANTHROPIC_BASE_URL", "OPENCODE_API_KEY"];

/** The few environment variables the providers honour; empty when they cannot be read. */
async function readEnv() {
  try {
    if (platform() === "windows") {
      // `set` lists NAME=value lines; cmd is always there, unlike sh.
      const r = await exec("cmd", ["/d", "/c", "set"]);
      const pairs = r.stdout.split(/\r?\n/).map((l) => [l.slice(0, l.indexOf("=")).toUpperCase(), l.slice(l.indexOf("=") + 1)]);
      return Object.fromEntries(pairs.filter(([k, v]) => ENV.includes(k) && v));
    }
    const r = await exec("sh", ["-c", ENV.map((n) => `printf '%s\\n' "\${${n}}"`).join(";")]);
    return Object.fromEntries(r.stdout.split("\n").map((v, i) => [ENV[i], v]).filter(([k, v]) => k && v));
  } catch {
    return {};
  }
}

async function herdrIo() {
  return {
    platform: platform(),
    home: home(),
    env: await readEnv(),
    now: () => Date.now(),
    // A missing file reads as null, as the providers expect. fs.readFile, not readTextFile: that one
    // stops at 1 MiB, and ~/.claude.json (where the account email is) grows past it with history.
    readText: (path) => Promise.resolve().then(() => fs.readFile(path, "utf8")).catch(() => null),
    exec: async (cmd, args) => {
      const out = await exec(cmd, args);
      return { code: out.code, stdout: out.stdout };
    },
    fetch: async (url, options) => {
      const response = await fetch(url, options);
      return { status: response.status, text: await response.text() };
    },
  };
}

/** Optional `usage.json` in the app folder: { "providers": ["claude", ...] }. */
async function readConfig() {
  try {
    const text = await readTextFile(`${appHome()}/usage.json`);
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

/** The readings, and when each service may be asked next, so a restart doesn't ask again at once.
 *  Every configured service keeps its schedule, also one whose first read failed with nothing to
 *  show (the snapshot leaves those out), or its back-off would be lost on a restart. */
function save(service) {
  try {
    const entry = (id) => {
      const r = service.readings[id], s = service.state[id];
      return { report: r?.report ?? null, updated: r?.updated ?? null, due: s?.due, rejected: s?.rejected };
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(Object.keys(service.state).map((id) => [id, entry(id)]))));
  } catch {
    // Storage can be unavailable; the bar works without it.
  }
}
