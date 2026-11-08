import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, props, window, shared, setShared, updates, layout, appHome, readTextFile, watchFolder, settings } from "herdr";

// A #rrggbb color at an opacity (0..1), as #rrggbbaa. Other colors stay as they are.
const fade = (c, o) => typeof o !== "number" || o >= 1 || !/^#[0-9a-f]{6}$/i.test(c)
  ? c : c + Math.round(Math.max(0, o) * 255).toString(16).padStart(2, "0");
// The islands' fill at "opacity" in this mod's settings.json (1 when unset).
const islandFill = (c) => fade(c, shared("islands.opacity"));

// Two #rrggbb colors mixed, `k` of the way from a to b. Anything else gives a back.
function mix(a, b, k) {
  const hex = /^#([0-9a-f]{6})$/i;
  if (!hex.test(a) || !hex.test(b)) return a;
  const ch = (c, i) => parseInt(c.slice(1 + i * 2, 3 + i * 2), 16);
  return "#" + [0, 1, 2].map((i) => Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * k).toString(16).padStart(2, "0")).join("");
}

// What shows behind the cards. Dark: the grid image (settings.json "backdrop", default
// backgrounds/islands-grid.png), tuned to the dark themes. Light: an image tuned for dark
// would ring every light card with black, so a native gradient made from the theme's own
// canvas, lifted toward white at the top and tinted toward its accent at the bottom. Native
// gradients are sharp at any window size and follow any light theme.
// settings.json "backdrop": "grid" (default) or an image path, "gradient" (native, from the
// theme), or "plain" (the theme's flat canvas).
function backdrop() {
  const t = theme();
  const mode = shared("islands.backdrop") || "grid";
  if (mode === "plain") return "canvas";
  if (settings()?.dark !== false && mode !== "gradient") {
    const image = mode === "grid" ? "backgrounds/islands-grid.png" : mode;
    return { image, fit: "cover" };
  }
  if (settings()?.dark !== false) return { gradient: [mix(t.canvas, "#000000", 0.45), mix(t.canvas, t.accent, 0.14)], angle: 165 };
  return { gradient: [mix(t.canvas, "#ffffff", 0.55), mix(t.canvas, t.accent, 0.12)], angle: 165 };
}

// Same look, whatever order the keys came back in (an order-sensitive check would rewrite
// the layout on every render).
function sameBackground(a, b) {
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return a === b;
  return a.image === b.image && a.fit === b.fit && a.angle === b.angle
    && JSON.stringify(a.gradient ?? null) === JSON.stringify(b.gradient ?? null);
}

// The window background and the main panel's fill come from the layout, not a mod, so
// this rewrites them there: the backdrop above, and the theme's background faded to
// "main_opacity" (at 1, the plain theme color). Runs when settings.json changes and when
// the theme or the light/dark appearance changes, so neither is left in the old colors.
// Only writes when something differs.
function applyLook() {
  const root = layout();
  // Only the layout this mod belongs to: the settings watcher can outlive a layout switch,
  // and must never restyle another layout (main, terminals, ...).
  if (!root || find(root, "brand")?.content?.mod !== "sidebar-chrome") return;
  const pane = find(root, "main")?.content?.pane;
  const o = shared("islands.mainOpacity");
  const wantPane = typeof o === "number" && o < 1 ? fade(theme().background, o) : "background";
  const wantBg = backdrop();
  const paneOk = !pane || pane.background === wantPane;
  if (paneOk && sameBackground(root.background, wantBg)) return;
  const next = JSON.parse(JSON.stringify(root));
  if (pane) find(next, "main").content.pane.background = wantPane;
  next.background = wantBg;
  run("layout.set", { layout: next });
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 100;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

export default class WorkspaceChrome extends View {
  // The header copy reads settings.json and shares both opacities with every islands mod,
  // again whenever the file changes.
  init(p, cx) {
    if (p?.footer) return;
    const dir = `${appHome()}/mods/sidebar-chrome`;
    const clamp = (v) => (typeof v === "number" ? Math.min(1, Math.max(0, v)) : 1);
    cx.spawn(async (cx) => {
      for (;;) {
        cx.notify(); // touching cx ends this loop when the copy goes (a layout switch)
        let s = {};
        try { s = JSON.parse((await readTextFile(`${dir}/settings.json`)) ?? "{}"); } catch {}
        const o = clamp(s.opacity), main = clamp(s.main_opacity);
        const image = typeof s.backdrop === "string" && s.backdrop ? s.backdrop : null;
        if (shared("islands.opacity") !== o) setShared("islands.opacity", o);
        if (shared("islands.mainOpacity") !== main) setShared("islands.mainOpacity", main);
        if (shared("islands.backdrop") !== image) setShared("islands.backdrop", image);
        // "radar": false hides the agents drawer on the window's edge (agent-radar).
        const radar = s.radar !== false;
        if (shared("islands.radar") !== radar) setShared("islands.radar", radar);
        // "accent": "space" (each space's color, default), "theme" (the theme's), or "#rrggbb".
        const accent = typeof s.accent === "string" && (s.accent === "theme" || /^#[0-9a-f]{6}$/i.test(s.accent)) ? s.accent : "space";
        if (shared("islands.accentMode") !== accent) setShared("islands.accentMode", accent);
        applyLook();
        await watchFolder(dir);
      }
    });
  }
  // The theme or the appearance changed (render runs again for both): re-apply the look
  // once, after this frame, instead of leaving the old theme's colors in the layout.
  followLook() {
    const t = theme();
    const key = [settings()?.dark, t.background, t.canvas, t.accent].join("|");
    if (key === this.lookKey) return;
    const first = this.lookKey === undefined;
    this.lookKey = key;
    if (!first) Promise.resolve().then(applyLook);
  }
  button(id, label, action) {
    const t = theme();
    return div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action).child(label);
  }
  render() {
    const t = theme();
    const collapsed = narrow();
    if (!props()?.footer) this.followLook();
    if (props()?.footer) {
      const row = (id, icon, label, dim, action) => h_flex().id(id).h(28).px(collapsed ? 6 : 8).gap(9).items_center().rounded(8).when(collapsed, el => el.justify_center())
        .text_color(dim ? t.dim : t.muted).hover(s => s.bg(t.hover).text_color(t.foreground)).cursor_pointer()
        .on_click(action).child(svg(`mods/sidebar-chrome/${icon}.svg`).size(14))
        .when(!collapsed, el => el.child(div().min_w(0).truncate().child(label)));
      return v_flex().size_full().rounded(13).overflow_hidden().bg(islandFill(t.chrome)).px(collapsed ? 5 : 8).py(8).text_size(13) // its own card, no divider
        .child(row("settings", "settings", "Settings", false, () => run("app.settings"))
          .when(Boolean(updates().app.ready), el => el.child(div().size(6).rounded_full().bg(t.accent))))
        .child(row("machine", "plus", "Add machine", true, () => run("mod.open", { name: "machine-add" })));
    }
    return h_flex().size_full().rounded(13).overflow_hidden().bg(islandFill(t.chrome)).when(collapsed, el => el.justify_center()).when(!collapsed, el => el.pl(14).pr(10)).gap(4).items_center().text_size(13.5)
      .when(window()?.platform === "macos" && !window()?.fullscreen && !collapsed, el => el.pl(76))
      .when(!collapsed, el => el.child(h_flex().flex_1().min_w(0).gap(8).items_center().child(image("frame/welcome/herdr.png").size(20).flex_none().rounded(5)).child(div().min_w(0).truncate().font_semibold().text_color(t.foreground).child("Herdr"))))
      .when(!collapsed, el => el.child(this.button("search", svg("mods/sidebar-chrome/search.svg").size(15), () => run("mod.open", { name: "picker" }))))
      // On the macOS rail the traffic lights fill the row; the agents list's » unfolds it.
      .when(!(collapsed && window()?.platform === "macos"), el => el.child(this.button("sidebar-toggle", svg("mods/sidebar-chrome/sidebar.svg").size(15), toggleSidebar)));
  }
}
