// mod-manager: the Mods panel (tab bar → Mods). Three views:
//   Mods     every mod in ~/.config/herdr-app/mods, grouped by where the shown layout puts it
//            (sidebar, top bar, panes, side panel, status bar, floating), then yours that this
//            layout doesn't use, mods of other layouts and Herdr's system mods (folded);
//            each can be switched off and on, checked, and its folder opened.
//   Look     the Islands look: theme, accent, card and pane opacity, backdrop, agents radar.
//   Layouts  every layout, with its preview; a click switches.
//
// "Off" means: a block is hidden (layout.hide, kept across restarts), a floating block or a
// pane header is taken out of the layout and remembered here to put back. Herdr's own
// layouts only take hide/show (they are read-only otherwise).
import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, layout, layouts, shared, run, exec, appHome, readTextFile, writeTextFile, watchFolder, settings, window as hwin, home, notify } from "herdr";
import * as fs from "fs/promises";
import { installedVersion, availableRelease, startUpdate, pendingResult } from "./update.js";

const SETTINGS = "mods/sidebar-chrome/settings.json";
const BUILTIN_THEMES = { dark: ["graphite", "ink", "moss"], light: ["paper"] };
const SWATCHES = ["#22a99a", "#5b8def", "#8b7cf6", "#d9649a", "#e3814f", "#e5c07b", "#3fae6a", "#96b2d7"];
const PCT = [0.6, 0.7, 0.8, 0.9, 1];
const SELF = "mod-manager";
// Herdr's infrastructure: dialogs, menus and popups other mods open. Listed, never switched off.
const SYSTEM = new Set(["menu", "prompt", "confirm", "toast", "help", "picker", "peek", "new-menu", "machine-add", "worktree"]);
const LAYOUT_LABEL = { main: "Herdr", terminals: "Terminals", win98: "Herdr 98", islands: "Islands" };

// What each mod is, in a few words (mod.json's own title wins).
const ABOUT = {
  "sidebar-chrome": "Brand row and footer; Islands look settings",
  "space-list": "Spaces list and space colors",
  "agent-list": "Agents list, peek on hover",
  "tab-bar": "Tab pills, panel buttons, window buttons",
  "pane-header": "Pane header with the focus line",
  "file-browser": "Files panel; opens spreadsheets",
  "mod-manager": "This panel",
  "status-bar": "Status bar: plan limits, CPU, memory",
  "agent-radar": "Agents drawer on the window edge",
  "sheet-viewer": "Spreadsheet viewer: xlsx, csv",
  spaces: "Spaces list", agents: "Agents list", tabs: "Tab bar", "workspace-chrome": "Brand row and footer",
  "workspace-status": "Status bar", pane: "Pane header", files: "Files panel", changes: "Git changes panel",
  menu: "Right-click menus", prompt: "Text prompts", confirm: "Confirm dialogs", toast: "Notifications",
  help: "Key help", picker: "Space and tab picker", peek: "Peek at a terminal", "new-menu": "New tab menu",
  "machine-add": "Add a machine", worktree: "Git worktrees", "terminals-bar": "Terminals layout: bar",
  "terminals-pane": "Terminals layout: pane", win98: "Herdr 98 desktop",
};

// Groups of the Mods view, in order. `fold`: folded until opened.
const GROUPS = [
  { id: "sidebar", title: "Sidebar" },
  { id: "top", title: "Top bar" },
  { id: "panes", title: "Panes" },
  { id: "panel", title: "Side panel" },
  { id: "status", title: "Status bar" },
  { id: "floating", title: "Floating" },
  { id: "layout", title: "Elsewhere in this layout" },
  { id: "idle", title: "Not in this layout", hint: "Yours, opened by other mods or commands" },
  { id: "other", title: "Other layouts", fold: true },
  { id: "system", title: "Herdr system", hint: "Dialogs, menus and popups other mods open", fold: true },
];
const AREA_BY_ID = { sidebar: "sidebar", tabs: "top", panel: "panel", status: "status", main: "panes" };

function walk(node, fn, parent = null, area = null) {
  if (!node || typeof node !== "object") return;
  const here = AREA_BY_ID[node.id] ?? area;
  fn(node, parent, here);
  for (const c of node.children ?? []) walk(c, fn, node, here);
}
function findId(node, id) { let hit = null; walk(node, (n) => { if (n.id === id) hit = n; }); return hit; }

/** Where a layout uses mod `name`: [{ kind, id, area, hidden?, parent? }]. */
function usage(root, name) {
  const out = [];
  walk(root, (n, parent, area) => {
    if (n.content?.mod === name) out.push({ kind: parent?.type === "stack" ? "panel" : "block", id: n.id, hidden: !!n.hidden, area: area ?? "layout" });
    if (n.content?.pane?.header?.content?.mod === name) out.push({ kind: "header", id: n.id, area: "panes" });
    for (const f of n.floating ?? []) if (f.content?.mod === name) out.push({ kind: "floating", id: f.id, parent: n.id, area: "floating" });
    if (n.header?.mod === name || n.header?.content?.mod === name) out.push({ kind: "stack header", id: n.id, area: area ?? "layout" });
  });
  if (root?.terminal_menu === name) out.push({ kind: "menu", area: "layout" });
  return out;
}

const platform = () => hwin()?.platform ?? (/^[A-Za-z]:/.test(home()) ? "windows" : home().startsWith("/Users") ? "macos" : "linux");
function openFolder(dir) {
  const p = platform();
  exec(p === "windows" ? "explorer" : p === "macos" ? "open" : "xdg-open", [p === "windows" ? dir.replace(/\//g, "\\") : dir]).catch(() => {});
}
function openUrl(url) {
  const p = platform();
  exec(p === "windows" ? "explorer" : p === "macos" ? "open" : "xdg-open", [url]).catch(() => {});
}
const load = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

export default class Mods extends View {
  init(_props, cx) {
    this.mods = [];
    this.shipped = new Set();
    this.layoutsInfo = [];
    this.trees = {};
    this.themes = { dark: BUILTIN_THEMES.dark.slice(), light: BUILTIN_THEMES.light.slice() };
    this.errors = {};
    this.checks = {};
    this.busy = false;
    this.settingsText = null;
    this.settings = {};
    this.view = load("view", "mods");
    this.folds = load("folds", Object.fromEntries(GROUPS.filter((g) => g.fold).map((g) => [g.id, true])));
    this.hover = null;
    this.parked = load("parked", {});
    // Herdr Islands updates. sidebar-chrome checks in the background and shares what it found
    // ("islands.update"); without it, this panel asks GitHub itself (at most once a day).
    this.upd = { current: null, info: null, state: null, detail: null, checking: false, checked: false };
    cx.spawn(async (cx) => {
      this.upd.current = await installedVersion(SELF);
      await this.followUpdate(cx);
      if (shared("islands.update") === undefined) this.checkUpdate(cx, false);
      cx.notify();
    });
    this.refresh(cx);
    // Re-read when mods are added or removed.
    cx.spawn(async (cx) => {
      for (;;) {
        cx.notify();
        try { await watchFolder(`${appHome()}/mods`); } catch { return; }
        this.refresh(cx);
      }
    });
  }

  refresh(cx) {
    // Asked again while busy (a copy lands file by file): run once more when this one ends.
    if (this.busy) { this.again = true; return; }
    this.busy = true;
    cx.spawn(async (cx) => {
      const home = appHome();
      try { this.shipped = new Set(Object.keys(JSON.parse((await readTextFile(`${home}/installed.json`)) ?? "{}"))); } catch {}
      const mods = [];
      try {
        for (const d of await fs.readdir(`${home}/mods`, { withFileTypes: true })) {
          if (!d.isDirectory() || d.name.startsWith(".")) continue;
          let meta = {};
          try { meta = JSON.parse((await readTextFile(`${home}/mods/${d.name}/mod.json`)) ?? "{}"); } catch {}
          mods.push({ name: d.name, title: typeof meta.title === "string" && meta.title !== "undefined" ? meta.title : null, place: meta.place });
        }
      } catch {}
      mods.sort((a, b) => a.name.localeCompare(b.name));
      this.mods = mods;
      const infos = [], trees = {};
      for (const name of layouts()) {
        let preview = null;
        try {
          const root = JSON.parse((await readTextFile(`${home}/layouts/${name}.json`)) ?? "{}");
          trees[name] = root;
          if (root.preview && (await fs.exists(`${home}/${root.preview}`))) preview = root.preview;
        } catch {}
        infos.push({ name, label: LAYOUT_LABEL[name] ?? name, preview, shipped: this.shipped.has(`layout:${name}`) });
      }
      this.layoutsInfo = infos;
      this.trees = trees;
      try {
        const files = await fs.readdir(`${home}/themes`);
        const extra = files.filter((f) => f.endsWith(".json") && !layouts().includes(f.replace(/\.json$/, ""))).map((f) => f.replace(/\.json$/, ""));
        this.themes = { dark: [...BUILTIN_THEMES.dark, ...extra], light: BUILTIN_THEMES.light.slice() };
      } catch {}
      await this.readSettings();
      try {
        const st = JSON.parse((await exec("herdr-app", ["status"])).stdout);
        const errs = {};
        for (const e of st.errors ?? []) { const m = /^mod ([^:]+):/.exec(e); if (m) errs[m[1]] = e.slice(m[0].length).trim(); }
        this.errors = errs;
      } catch {}
      this.busy = false;
      if (this.again) { this.again = false; this.refresh(cx); }
      cx.notify();
    });
  }

  async readSettings() {
    try {
      this.settingsText = await readTextFile(`${appHome()}/${SETTINGS}`);
      this.settings = JSON.parse(this.settingsText ?? "{}");
    } catch { this.settings = {}; }
  }

  /** Writes one Islands setting (merging, never clobbering an edit made meanwhile). */
  setSetting(k, v, cx) {
    this.settings = { ...this.settings, [k]: v }; // show it at once
    cx.notify();
    // Writes run one after another, in the order chosen, so a slow earlier write can't land after a
    // later choice. Each merges its own key into what the file holds right then; the panel keeps
    // showing the choices in this.settings meanwhile.
    const path = `${appHome()}/${SETTINGS}`;
    const write = async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const text = await readTextFile(path).catch(() => null);
        let current = {};
        try { current = JSON.parse(text ?? "{}"); } catch { return; } // a broken file: don't clobber it
        try {
          await writeTextFile(path, JSON.stringify({ ...current, [k]: v }, null, 2) + "\n", text);
          return;
        } catch { /* changed under us: read again */ }
      }
    };
    this.writes = (this.writes ?? Promise.resolve()).then(write).catch(() => {});
    const queued = this.writes;
    cx.spawn(async (cx) => {
      await queued;
      cx.notify();
    });
  }

  toggle(m, u, on, cx) {
    const root = layout();
    const name = shared("layout");
    if (u.kind === "block") {
      run(on ? "layout.show" : "layout.hide", { id: u.id });
    } else if (u.kind === "floating" || u.kind === "header") {
      const next = JSON.parse(JSON.stringify(root));
      const slot = `${name}:${m.name}:${u.kind}`;
      if (!on) {
        // Nothing is remembered unless the piece is really there to take out.
        if (u.kind === "floating") {
          const host = findId(next, u.parent) ?? next;
          const spec = (host.floating ?? []).find((f) => f.id === u.id);
          if (!spec) return;
          host.floating = (host.floating ?? []).filter((f) => f.id !== u.id);
          this.parked[slot] = { parent: u.parent, spec, area: "floating" };
        } else {
          const host = findId(next, u.id);
          if (!host?.content?.pane?.header) return;
          this.parked[slot] = { id: u.id, spec: host.content.pane.header, area: "panes" };
          delete host.content.pane.header;
        }
      } else {
        const p = this.parked[slot];
        if (!p) return;
        if (u.kind === "floating") { const host = findId(next, p.parent) ?? next; host.floating = [...(host.floating ?? []), p.spec]; }
        else { const host = findId(next, p.id); if (host?.content?.pane) host.content.pane.header = p.spec; }
        delete this.parked[slot];
      }
      save("parked", this.parked);
      run("layout.set", { layout: next });
    }
    cx.notify();
  }

  /** The release on offer: this panel's own clicked check (the newest answer), else
   *  sidebar-chrome's background finding, else this panel's own. */
  updateInfo() {
    if (this.upd.own) return this.upd.info;
    const fromChrome = shared("islands.update");
    return fromChrome === undefined ? this.upd.info : fromChrome;
  }

  checkUpdate(cx, force) {
    if (this.upd.checking) return;
    this.upd.checking = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const wait = (ms) => new Promise((resolve) => cx.timer.after(ms, () => resolve()));
      const started = Date.now();
      try {
        this.upd.current = await installedVersion(SELF);
        this.upd.info = await availableRelease(this.upd.current, force);
        // A check's own field: `detail` keeps why an install failed, for the banner.
        this.upd.checkError = null;
        if (force) this.upd.own = true;
      } catch (e) {
        this.upd.checkError = `Couldn't reach GitHub: ${String(e?.message ?? e).slice(0, 80)}`;
      }
      // A clicked check spins for at least a moment, or a fast answer looks like nothing happened.
      if (force) await wait(Math.max(0, 700 - (Date.now() - started)));
      this.upd.checking = false;
      this.upd.checked = true;
      if (force) {
        // The answer pulses for a moment, then stays.
        this.upd.flash = true;
        cx.notify();
        await wait(1800);
        this.upd.flash = false;
      }
      cx.notify();
    });
  }

  installUpdate(info, cx) {
    this.upd.state = "running";
    this.upd.detail = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await startUpdate(info, SELF);
        await this.followUpdate(cx);
      } catch (e) {
        this.upd.state = "failed";
        this.upd.detail = String(e?.message ?? e);
        cx.notify();
      }
    });
  }

  /** Watches an update this panel started until it lands (the panel reloads when its files change). */
  async followUpdate(cx) {
    for (;;) {
      const r = await pendingResult(SELF);
      if (!r) return;
      this.upd.state = r.state;
      if (r.state === "running") { cx.notify(); await new Promise((res) => cx.timer.after(3000, () => res())); continue; }
      if (r.state === "ok") {
        this.upd.info = null;
        notify({ title: `Herdr Islands ${r.version}`, body: "Updated. Herdr reloaded the mods.", level: "success" });
      } else {
        this.upd.detail = r.detail;
        notify({ title: "Herdr Islands didn't update", body: `${r.detail}. Log: mods/${SELF}/.update.log`, level: "error" });
      }
      cx.notify();
      return;
    }
  }

  /** The banner over the tabs: an update on offer, under way, or failed. */
  renderUpdate(t, cx) {
    const u = this.upd;
    const info = this.updateInfo();
    const button = (id, label, action, strong) => div().id(id).h(24).px(10).flex().flex_none().items_center().rounded(6).cursor_pointer().text_size(12)
      .when(strong, (e) => e.bg(t.accent).text_color("#ffffff").font_semibold())
      .when(!strong, (e) => e.border(1).border_color(t.border).text_color(t.foreground).hover((s) => s.bg(t.hover)))
      .on_click(action).child(label);
    const card = (color, children) => v_flex().mx(10).mt(10).p(10).gap(8).rounded(10).border(1).border_color(color).bg(color + "14").children(children);
    if (u.state === "running") {
      return card(t.accent, [div().text_size(12.5).child(`Updating Herdr Islands${info ? ` to ${info.version}` : ""}… Herdr reloads the mods when it's done.`)]);
    }
    if (u.state === "failed") {
      return card(t.blocked, [
        div().text_size(12.5).whitespace_normal().child(`The update didn't go through: ${u.detail ?? "unknown error"}`),
        h_flex().gap(6)
          .child(button("upd-log", "Open log folder", () => openFolder(`${appHome()}/mods/${SELF}`)))
          .when(Boolean(info), (e) => e.child(button("upd-retry", "Try again", () => this.installUpdate(info, cx), true))),
      ]);
    }
    if (!info) return null;
    return card(t.accent, [
      v_flex().gap(2)
        .child(div().text_size(13).font_semibold().child(`Herdr Islands ${info.version} is out`))
        .child(div().text_size(11.5).text_color(t.dim).child(`You have ${info.current ?? u.current ?? "an older version"}. Your settings stay.`)),
      h_flex().gap(6)
        .when(Boolean(info.url), (e) => e.child(button("upd-notes", "What's new", () => openUrl(info.url))))
        .child(div().flex_1())
        .child(button("upd-go", "Update", () => this.installUpdate(info, cx), true)),
    ]);
  }

  /** The last line of the Mods view: this install's version and a manual check. */
  renderVersion(t, cx) {
    const u = this.upd;
    if (!u.current) return null;
    const info = this.updateInfo();
    const GREEN = "#22c55e";
    // The space color when space-list shares one (Islands' accent), else the theme's.
    const accent = /^#[0-9a-f]{6}$/i.test(shared("islands.accent") ?? "") ? shared("islands.accent") : t.accent;
    const status = u.checking ? { text: "Checking GitHub…", color: t.muted }
      : u.checkError ? { text: u.checkError, color: t.blocked }
      : info ? { text: `${info.version} is out: update above`, color: accent }
      : u.checked ? { text: "Up to date", color: GREEN, icon: "check" }
      : { text: "Updates are checked once a day", color: t.dim };
    const icon = svg("mods/mod-manager/refresh.svg").size(13).flex_none().text_color(u.checking ? accent : t.muted);
    return h_flex().id("upd-card").mx(10).mt(10).px(12).py(9).gap(10).items_center().rounded(10)
      .border(1).border_color(info ? accent : t.border).bg(info ? accent + "14" : t.surface)
      .child(div().size(28).flex_none().flex().items_center().justify_center().rounded(8).bg(accent + "26")
        .child(svg("mods/mod-manager/puzzle.svg").size(15).text_color(accent)))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().truncate().text_size(12.5).font_semibold().text_color(t.foreground).child(`Herdr Islands ${u.current}`))
        .child(h_flex().id(`upd-status-${u.checking ? "busy" : u.flash ? "new" : "idle"}`).gap(4).items_center().text_size(11).text_color(status.color)
          .when(status.icon === "check", (e) => e.child(svg("mods/mod-manager/check.svg").size(11).flex_none()))
          .child(div().truncate().child(status.text))
          .when(Boolean(u.flash), (e) => e.loop("opacity", { from: 0.35, to: 1, period: 600 }))))
      .child(h_flex().id("upd-check").h(28).px(10).gap(6).flex_none().items_center().rounded(7).cursor_pointer().text_size(12)
        .border(1).border_color(u.checking ? accent : t.border).bg(u.checking ? accent + "22" : t.background)
        .text_color(t.foreground).hover((s) => s.bg(t.hover).border_color(accent))
        .on_click((_e, cx2) => this.checkUpdate(cx2, true))
        .child(u.checking ? icon.spin(800) : icon)
        .child(u.checking ? "Checking…" : "Check for updates"));
  }

  check(m, cx) {
    this.checks[m.name] = { running: true };
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await exec("herdr-app", ["check", `${appHome()}/mods/${m.name}`]);
        const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim().split(/\r?\n/).filter(Boolean);
        this.checks[m.name] = { ok: r.code === 0, text: r.code === 0 ? "Check passed" : out.slice(-3).join(" · ") };
      } catch (e) {
        this.checks[m.name] = { ok: false, text: String(e).slice(0, 200) };
      }
      cx.notify();
    });
  }

  // ---- model for the Mods view ----

  /** Every mod with its group, its switch (if any) and a short "where". */
  entries() {
    const root = layout();
    const current = shared("layout");
    const shippedLayout = this.layoutsInfo.find((l) => l.name === current)?.shipped ?? false;
    return this.mods.map((m) => {
      const uses = usage(root, m.name);
      const shipped = this.shipped.has(m.name);
      const parkedKey = Object.keys(this.parked).find((k) => k.startsWith(`${current}:${m.name}:`));
      const parked = parkedKey ? { kind: parkedKey.split(":").pop(), area: this.parked[parkedKey].area } : null;
      const control = uses.find((u) => u.kind === "block" || u.kind === "floating" || u.kind === "header") ?? (parked && !uses.length ? parked : null);
      const on = control ? (control.kind === "block" ? !control.hidden : !parked || uses.length > 0) : true;
      const locked = m.name === SELF || SYSTEM.has(m.name) || (control && control.kind !== "block" && shippedLayout);
      let group, where;
      if (uses.length || parked) {
        group = (uses[0] ?? parked).area ?? "layout";
        where = uses.length ? uses.map((u) => (u.kind === "panel" ? "panel" : u.kind === "block" ? `block “${u.id}”` : u.kind)).join(", ") : `${parked.kind} · off`;
      } else if (SYSTEM.has(m.name)) {
        group = "system"; where = "opened when needed";
      } else {
        const elsewhere = Object.entries(this.trees).filter(([n, t]) => n !== current && usage(t, m.name).length).map(([n]) => LAYOUT_LABEL[n] ?? n);
        if (elsewhere.length) { group = "other"; where = elsewhere.join(", "); }
        else if (!shipped) { group = "idle"; where = m.place && m.place !== "none" ? `docks ${m.place}` : "opened by other mods"; }
        else { group = "system"; where = "not used by a layout"; }
      }
      return { m, shipped, control, on, locked, group, where, about: ABOUT[m.name] ?? (m.title && m.title !== m.name ? m.title : null) };
    });
  }

  // ---- drawing helpers ----
  chip(t, id, label, on, action, color) {
    return h_flex().id(id).h(24).px(8).gap(5).flex_none().items_center().rounded(6).text_size(11.5).cursor_pointer()
      .border(1).border_color(on ? (color ?? t.accent) : t.border).bg(on ? (color ?? t.accent) + "22" : "#00000000")
      .text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click(action)
      .child(label);
  }

  toggleSwitch(t, id, on, action) {
    return div().id(id).relative().w(30).h(17).flex_none().rounded_full().cursor_pointer()
      .bg(on ? t.accent : t.border)
      .on_click((_e, cx) => { cx.stop_propagation(); action(); })
      .child(div().id(`${id}-knob`).absolute().top(2).left(on ? 15 : 2).size(13).rounded_full().bg("#ffffff").transition("left", { duration: 140, easing: "ease-out" }));
  }

  /** A titled block of settings, like a card. */
  block(t, title, rows) {
    return v_flex().mx(10).mt(10).py(6).rounded(10).border(1).border_color(t.border).bg(t.surface)
      .child(div().px(12).pt(4).pb(2).text_size(11).font_semibold().text_color(t.dim).child(title.toUpperCase()))
      .children(rows);
  }

  row(t, label, control) {
    return h_flex().px(12).py(5).gap(10).items_center().text_size(12.5)
      .child(div().w(64).flex_none().text_color(t.muted).child(label))
      .child(h_flex().flex_1().min_w(0).flex_wrap().gap(5).items_center().child(control));
  }

  // ---- views ----
  renderTabs(t, cx) {
    const tab = (id, label, count) => {
      const on = this.view === id;
      return h_flex().id(`view-${id}`).flex_1().h(26).gap(5).items_center().justify_center().rounded(6).cursor_pointer().text_size(12)
        .when(on, (e) => e.bg(t.surface).border(1).border_color(t.border).text_color(t.foreground).font_semibold())
        .when(!on, (e) => e.text_color(t.muted).hover((s) => s.text_color(t.foreground)))
        .on_click((_e, cx2) => { this.view = id; save("view", id); cx2.notify(); })
        .child(label)
        .when(count !== undefined, (e) => e.child(div().text_size(10.5).text_color(t.dim).child(String(count))));
    };
    return h_flex().mx(10).mt(10).p(2).gap(2).rounded(8).bg(t.hover)
      .child(tab("mods", "Mods", this.mods.length))
      .child(tab("look", "Look"))
      .child(tab("layouts", "Layouts", this.layoutsInfo.length));
  }

  renderMods(t, cx) {
    const entries = this.entries();
    const out = [];
    for (const g of GROUPS) {
      const items = entries.filter((e) => e.group === g.id);
      if (!items.length) continue;
      const folded = !!this.folds[g.id];
      const errs = items.filter((e) => this.errors[e.m.name]).length;
      out.push(h_flex().id(`grp-${g.id}`).mx(10).mt(12).mb(2).gap(6).items_center().cursor_pointer().text_size(11).font_semibold().text_color(t.dim)
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx2) => { this.folds = { ...this.folds, [g.id]: !folded }; save("folds", this.folds); cx2.notify(); })
        .child(svg(`mods/mod-manager/chevron-${folded ? "right" : "down"}.svg`).size(11))
        .child(g.title.toUpperCase())
        .child(div().font_normal().child(String(items.length)))
        .when(errs > 0, (e) => e.child(div().size(6).rounded_full().bg(t.blocked)))
        .child(div().flex_1())
        .when(Boolean(g.hint) && !folded, (e) => e.child(div().font_normal().text_size(10.5).truncate().max_w(200).child(g.hint))));
      if (folded) continue;
      out.push(v_flex().mx(10).rounded(10).border(1).border_color(t.border).bg(t.surface).overflow_hidden()
        .children(items.map((e, i) => this.modRow(t, e, i === items.length - 1, cx))));
    }
    return v_flex().pb(12).child(this.renderVersion(t, cx) ?? div()).children(out);
  }

  modRow(t, e, last, cx) {
    const { m, shipped, control, on, locked } = e;
    const err = this.errors[m.name], chk = this.checks[m.name];
    const hot = this.hover === m.name;
    const dot = err ? t.blocked : control ? (on ? "#22c55e" : t.dim) : t.border;
    const link = (id, label, action) => div().id(id).flex_none().px(5).h(18).rounded(4).flex().items_center().text_size(11).text_color(t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_ev, cx2) => { cx2.stop_propagation(); action(cx2); }).child(label);
    return v_flex().id(`mod-${m.name}`).px(10).py(7).gap(2).when(!last, (x) => x.border_b(1).border_color(t.border))
      .on_hover((h, cx2) => { this.hover = h ? m.name : this.hover === m.name ? null : this.hover; cx2.notify(); })
      .child(h_flex().gap(8).items_center()
        .child(div().size(7).flex_none().rounded_full().bg(dot))
        .child(div().min_w(0).truncate().text_size(12.5).text_color(on || !control ? t.foreground : t.muted).child(m.name))
        .when(!shipped, (x) => x.child(div().flex_none().px(5).h(15).rounded(4).flex().items_center().text_size(9.5).text_color(t.accent).bg(t.accent + "22").child("yours")))
        .child(div().flex_1())
        .when(hot, (x) => x.child(link(`chk-${m.name}`, chk?.running ? "Checking…" : "Check", (cx2) => this.check(m, cx2))).child(link(`dir-${m.name}`, "Folder", () => openFolder(`${appHome()}/mods/${m.name}`))))
        .when(Boolean(control) && !locked, (x) => x.child(this.toggleSwitch(t, `tg-${m.name}`, on, () => this.toggle(m, control, !on, cx)))))
      .child(div().pl(15).text_size(11).text_color(t.dim).truncate().child([e.about, e.where].filter(Boolean).join(" · ")))
      .when(Boolean(err), (x) => x.child(div().pl(15).text_size(11).text_color(t.blocked).whitespace_normal().child(err)))
      .when(Boolean(chk && !chk.running), (x) => x.child(div().pl(15).text_size(11).text_color(chk.ok ? "#22c55e" : t.blocked).whitespace_normal().child(chk.text)));
  }

  renderLook(t, cx) {
    const root = layout();
    const dark = settings()?.dark !== false;
    const picked = typeof root?.theme === "string" ? root.theme : root?.theme?.[dark ? "dark" : "light"] ?? null;
    const themes = dark ? this.themes.dark : this.themes.light;
    const themeRow = this.row(t, "Theme", h_flex().flex_wrap().gap(5).children(themes.map((n) => this.chip(t, `th-${n}`, n, picked === n || (!picked && n === (dark ? "graphite" : "paper")), () => run("app.theme", { name: n })))));
    // The theme works in any layout. The rest are settings of the Islands look, which sidebar-chrome
    // reads, so they show only in a layout that uses it.
    if (findId(root, "brand")?.content?.mod !== "sidebar-chrome") {
      return v_flex().pb(12)
        .child(this.block(t, "Color", [themeRow]))
        .child(div().px(16).py(8).text_size(12).text_color(t.dim).whitespace_normal()
          .child("Accent, surfaces and the agents radar belong to the Islands look (sidebar-chrome). They show here in a layout that uses it, such as Islands."));
    }
    const s = this.settings;
    const accent = s.accent ?? "space";
    const backdrop = s.backdrop === "gradient" || s.backdrop === "plain" ? s.backdrop : "grid";
    const pct = (k) => { const v = typeof s[k] === "number" ? s[k] : 1; return PCT.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a)); };
    const steps = (k, idp) => h_flex().gap(4).children(PCT.map((p) => this.chip(t, `${idp}-${p}`, `${Math.round(p * 100)}%`, pct(k) === p, () => this.setSetting(k, p, cx))));
    return v_flex().pb(12)
      .child(this.block(t, "Color", [
        themeRow,
        this.row(t, "Accent", v_flex().gap(6)
          .child(h_flex().gap(5)
            .child(this.chip(t, "ac-space", "Space color", accent === "space", () => this.setSetting("accent", "space", cx)))
            .child(this.chip(t, "ac-theme", "Theme", accent === "theme", () => this.setSetting("accent", "theme", cx))))
          .child(h_flex().gap(6).children(SWATCHES.map((c) => div().id(`ac-${c}`).size(18).rounded_full().cursor_pointer().bg(c)
            .border(2).border_color(accent === c ? t.foreground : "#00000000")
            .on_click(() => this.setSetting("accent", c, cx)))))),
      ]))
      .child(this.block(t, "Surfaces", [
        this.row(t, "Cards", steps("opacity", "op")),
        this.row(t, "Panes", steps("main_opacity", "mop")),
        this.row(t, "Backdrop", h_flex().gap(4)
          .child(this.chip(t, "bd-grid", "Grid", backdrop === "grid", () => this.setSetting("backdrop", typeof s.backdrop === "string" && s.backdrop.includes("/") ? s.backdrop : "grid", cx)))
          .child(this.chip(t, "bd-gradient", "Gradient", backdrop === "gradient", () => this.setSetting("backdrop", "gradient", cx)))
          .child(this.chip(t, "bd-plain", "Plain", backdrop === "plain", () => this.setSetting("backdrop", "plain", cx)))),
      ]))
      .child(this.block(t, "Extras", [
        h_flex().px(12).py(6).gap(10).items_center().text_size(12.5)
          .child(v_flex().flex_1().min_w(0)
            .child(div().text_color(t.foreground).child("Agents radar"))
            .child(div().text_size(11).text_color(t.dim).child("Drawer with every agent on the window edge")))
          .child(this.toggleSwitch(t, "radar", s.radar !== false, () => this.setSetting("radar", s.radar === false, cx))),
        h_flex().px(12).py(6).gap(10).items_center().text_size(12.5)
          .child(v_flex().flex_1().min_w(0)
            .child(div().text_color(t.foreground).child("Install updates automatically"))
            .child(div().text_size(11).text_color(t.dim).whitespace_normal().child("New Herdr Islands releases install by themselves. Off: you're told, and update from here")))
          .child(this.toggleSwitch(t, "auto-update", s.auto_update === true, () => this.setSetting("auto_update", s.auto_update !== true, cx))),
      ]));
  }

  renderLayouts(t) {
    const current = shared("layout");
    return v_flex().mx(10).mt(10).gap(6).pb(12).children(this.layoutsInfo.map((l) => {
      const on = l.name === current;
      return h_flex().id(`lay-${l.name}`).p(8).gap(12).items_center().rounded(10).cursor_pointer()
        .border(1).border_color(on ? t.accent : t.border).bg(on ? t.accent + "14" : t.surface).hover((s) => s.bg(t.hover))
        .on_click(() => !on && run("layout.switch", { name: l.name }))
        .child(div().w(80).h(50).flex_none().rounded(6).overflow_hidden().border(1).border_color(t.border).bg(t.background)
          .when(Boolean(l.preview), (e) => e.child(image(l.preview).w(80).h(50))))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().truncate().text_size(13).font_semibold().text_color(t.foreground).child(l.label))
          .child(div().text_size(11).text_color(t.dim).child(`${l.name}.json · ${l.shipped ? "Herdr" : "yours"}`)))
        .when(on, (e) => e.child(div().px(6).h(18).rounded(5).flex().items_center().text_size(10.5).text_color(t.accent).bg(t.accent + "22").child("Current")));
    }));
  }

  render(cx) {
    const t = theme();
    const body = this.view === "look" ? this.renderLook(t, cx) : this.view === "layouts" ? this.renderLayouts(t) : this.renderMods(t, cx);
    return v_flex().id("mods").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(svg("mods/mod-manager/puzzle.svg").size(14).text_color(t.muted))
        .child(div().font_semibold().child("Mods"))
        .child(div().flex_1())
        .child(div().id("mods-refresh").p(4).rounded(5).cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx2) => this.refresh(cx2)).child(this.busy ? "…" : "⟳")))
      .child(this.renderUpdate(t, cx) ?? div())
      .child(this.renderTabs(t, cx))
      .child(v_flex().id(`mods-scroll-${this.view}`).flex_1().min_h(0).overflow_y_scrollbar().child(body));
  }
}
