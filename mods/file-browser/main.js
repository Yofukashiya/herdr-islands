// A lazy file browser for the focused pane's folder. Folders are listed a batch per process, one
// level ahead of what's open (listing.js, tree.js), so a click on a folder draws its rows at once.
// file-browser: the shipped Files panel, cloned. Changed:
// - a left click opens a file here in Herdr, in a tab of its own (viewer.js): code and text with
//   syntax colors, pictures fitted, spreadsheets in the sheet-viewer mod when it's installed;
// - a right click opens a menu (menu.js) for everything else: its program, a code editor, Explorer /
//   Finder, the path, a terminal there.
// One mod, three roles, by props: { file } a viewer tab, { menu } the menu popup, none the panel.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, focused, exec, watchFolder, theme, window, openOverlay, props, shared, layout } from "herdr";
import { openFile, findEditors, editors, terminalEditor, checkSheetViewer } from "./open.js";
import { FileViewer } from "./viewer.js";
import { FileMenu, menuItems, menuHeight } from "./menu.js";
import { Marks, normPath, readStatus } from "./git.js";
import { listFolders } from "./listing.js";
import { FolderTree, TOTAL } from "./tree.js";

/** A git mark's color, as IDEs have them: modified amber, new green, deleted or in conflict red,
 *  ignored dimmed. Amber is the terminal's yellow: `blocked` is red in some themes (atom-one-dark). */
const toneColor = (tone, t) => tone === "M" ? t.ansi3 : tone === "A" || tone === "U" ? t.ansi2 : tone === "D" || tone === "!" ? t.ansi1 : tone === "I" ? t.dim : null;

// The islands' fill at the opacity in sidebar-chrome/settings.json (1 when unset).
const islandFill = (c) => {
  const o = shared("islands.opacity");
  if (typeof o !== "number" || o >= 1 || !/^#[0-9a-f]{6}$/i.test(c)) return c;
  return c + Math.round(Math.max(0, o) * 255).toString(16).padStart(2, "0");
};

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The panel's fill: the islands' one only in the Islands layout (its brand is sidebar-chrome),
// because the setting outlives a switch to another layout. In a dialog it stays solid over the text.
const panelFill = (c) => !props()?.overlay && find(layout(), "brand")?.content?.mod === "sidebar-chrome" ? islandFill(c) : c;

/** The folder the tree shows: the focused terminal's. A pane with no folder of its own (a file
 *  opened from the tree, any mod's tab) keeps `shown`, the folder already in the tree for this
 *  space. Falling back to the space's folder there would reload the tree on every file opened. */
function location(shown) {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  // A mod pane has no folder; focused().cwd may then be an agent block's elsewhere in the layout.
  const own = pane?.mod ? null : pane?.cwd || f?.cwd;
  if (!own && shown?.cwd && shown.space === space?.id) return { cwd: shown.cwd, on: shown.on, space: shown.space };
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  // One spelling: a Windows terminal reports "D:\repo" while its space says "D:/repo".
  const cwd = own || space?.folder;
  return { cwd: cwd ? normPath(cwd) : cwd, on, space: space?.id };
}
const key = (shown) => JSON.stringify(location(shown));

/** Waits a moment on the timer: the runtime ends a mod that runs ~0.5 s without yielding. */
const pauser = (cx) => () => new Promise((resolve) => cx.timer.after(1, () => resolve()));

export default class Files extends View {
  init(_props, cx) {
    // A tab's or a popup's props come through props(), not init's argument.
    const p = props() ?? {};
    if (p.file) { this.viewer = new FileViewer(p, cx); return; }
    if (p.menu) { this.menu = new FileMenu(p); return; }
    this.saved = new Map();
    this.tree = new FolderTree(); this.marks = new Marks();
    this.term = null;
    this.extras(cx);
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  close() { this.viewer?.close(); }

  /** What the menu offers besides the basics: editors found, a terminal editor from settings.json,
   *  and whether spreadsheets have their viewer. Asked again with each refresh, cheaply. */
  extras(cx) {
    cx.spawn(async () => {
      await findEditors().catch(() => {});
      this.term = await terminalEditor();
      await checkSheetViewer();
    });
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key(context) === context.key;
  }

  /** Lists what the tree asks for, batch after batch, until it asks for nothing: what a batch
   *  brings into view is listed ahead by the next. `all`: the first lists all in view again. */
  async list(cx, all = false) {
    const { cwd: root, on } = this.context, tree = this.tree;
    const where = { root, on, windows: !on && window()?.platform === "windows" };
    for (let batch = tree.next(all); batch; batch = tree.next()) {
      let listings;
      try { listings = await listFolders(exec, where, batch, { pause: pauser(cx) }); }
      catch (e) { listings = e instanceof Error ? e : new Error(String(e)); }
      // The tree is the folder's until another folder is shown; then this listing is of no use.
      if (this.tree !== tree) return;
      tree.apply(batch, listings);
      cx.notify();
    }
  }

  refresh(cx) {
    const where = location(this.context), { cwd, on } = where, next = JSON.stringify(where);
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { open: this.tree.open });
      const saved = this.saved.get(next);
      this.context = { key: next, ...where }; this.root = cwd; this.on = on; this.tree = new FolderTree(saved?.open);
      this.marks = new Marks(); this.watched = null; this.error = null;
      this.loading = false; this.refreshAgain = false;
    }
    if (!cwd) return;
    // A change seen while a refresh runs may have come after it listed: refresh again then.
    if (this.loading) { this.refreshAgain = true; return; }
    this.extras(cx);
    const context = this.context;
    this.loading = true;
    cx.spawn(async cx => {
      try {
        // One process for the folder, every open folder and the folders they show.
        await this.list(cx, true);
        if (!this.current(context)) return;
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        let marks = new Marks();
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = (flags) => exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all", ...flags], { cwd, on }).catch(() => null);
          // "matching" lists an ignored folder once (node_modules/), not each file in it; only files
          // a file pattern ignores (*.log) come one by one. Git before 2.16 doesn't know it: then
          // the marks come without ignored files.
          let result = await status(["--ignored=matching"]);
          if (result && result.code !== 0) result = await status([]);
          if (result?.code === 0) marks = await readStatus(result.stdout, top.stdout.trim(), { limit: TOTAL, pause: pauser(cx) });
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally {
        if (this.context === context) {
          this.loading = false;
          if (this.refreshAgain) { this.refreshAgain = false; this.refresh(cx); }
        }
        cx.notify();
      }
    });
  }

  /** Opens or closes a folder. Listed ahead, it shows its rows now; if not, "Loading…" until it is. */
  toggle(path, cx) {
    this.tree.toggle(path);
    cx.spawn(cx => this.list(cx));
    cx.notify();
  }

  /** The full path of `path` in the tree ("" is the folder itself). */
  abs(path) { return normPath(path ? `${this.root}/${path}` : String(this.root)); }

  /** The right-click menu for a file or folder of the tree, at the pointer. */
  contextMenu(path, isDir) {
    if (!this.root) return;
    const target = { file: this.abs(path), rel: path, isDir, on: this.on ?? null };
    const found = editors(), items = menuItems(target, found, this.term);
    openOverlay({ mod: "file-browser", kind: "popup", width: 236, height: menuHeight(items) + 2, props: { menu: target, editors: found, term: this.term } });
  }

  rows(rows, t) {
    // A drive's root ("C:\") has its separator already.
    const root = String(this.root).replace(/[\\/]$/, "");
    return rows.map((row) => {
      const { path, depth } = row;
      // "Loading…" or why a folder couldn't be listed, under it, where its rows' icons would be.
      if (row.note !== undefined) return h_flex().id(`file-${path}/`).h(28).flex_none().pl(8 + depth * 18 + 19).pr(8).items_center().text_size(12).text_color(t.dim)
        .child(div().min_w(0).truncate().child(row.note));
      const { name, dir, open } = row;
      const { letter, tone, dot } = this.marks.row(`${root}/${path}`), color = toneColor(tone, t);
      return h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => dir ? this.toggle(path, cx) : openFile(this.abs(path), this.on ?? null, cx))
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.contextMenu(path, dir); })
        .child(dir ? svg(`mods/file-browser/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`mods/file-browser/${dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
        // The letter (a file's) or the dot (a folder's, for changes inside) follows the name, so the
        // radar's 30px strip on the window's edge doesn't cover it. A long name stops short of it.
        .child(h_flex().flex_1().min_w(0).gap(6).items_center().when(Boolean(letter) || dot, el => el.pr(22))
          .child(div().min_w(0).truncate().when(Boolean(color), el => el.text_color(color)).child(name))
          .when(Boolean(letter), el => el.child(div().flex_none().text_size(11).font_semibold().text_color(color).child(letter)))
          .when(dot, el => el.child(div().size(6).flex_none().rounded_full().bg(color))));
    });
  }

  render(cx) {
    if (this.viewer) return this.viewer.render(cx);
    if (this.menu) return this.menu.render(cx);
    if (key(this.context) !== this.context?.key) this.refresh(cx);
    const t = theme(), view = this.tree.view();
    const message = this.error || view.error || (!view.rows.length && (!this.root ? "No folder" : view.loading ? "Loading files…" : "No files"));
    return v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(panelFill(t.background)).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Files"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.root?.split(/[\\/]/).pop() ?? "")))
      // A right click on the empty part of the tree is about the folder itself.
      .child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6)
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.contextMenu("", true); })
        .children(this.rows(view.rows, t))
        .when(Boolean(message), el => el.child(div().p(8).text_size(12).text_color(t.dim).child(message)))
        .when(view.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total"))));
  }
}
