// A lazy file browser for the focused pane's folder.
// file-browser: the shipped Files panel, cloned. Changed:
// - a left click opens a file here in Herdr, in a tab of its own (viewer.js): code and text with
//   syntax colors, pictures fitted, spreadsheets in the sheet-viewer mod when it's installed;
// - a right click opens a menu (menu.js) for everything else: its program, a code editor, Explorer /
//   Finder, the path, a terminal there.
// One mod, three roles, by props: { file } a viewer tab, { menu } the menu popup, none the panel.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, focused, exec, watchFolder, theme, window, openOverlay, props } from "herdr";
import { openFile, findEditors, editors, terminalEditor, checkSheetViewer } from "./open.js";
import { FileViewer } from "./viewer.js";
import { FileMenu, menuItems, menuHeight } from "./menu.js";
import { Marks, normPath, readStatus } from "./git.js";

/** A git mark's color, as IDEs have them: modified amber, new green, deleted or in conflict red,
 *  ignored dimmed. Amber is the terminal's yellow: `blocked` is red in some themes (atom-one-dark).
 *  @param {import("./git.js").Row["tone"]} tone
 *  @param {Record<string, string>} t the theme */
const toneColor = (tone, t) => tone === "M" ? t.ansi3 : tone === "A" || tone === "U" ? t.ansi2 : tone === "D" || tone === "!" ? t.ansi1 : tone === "I" ? t.dim : null;

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
const PER_FOLDER = 500, TOTAL = 5000;

async function directory(path, on) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export default class Files extends View {
  init(_props, cx) {
    // A tab's or a popup's props come through props(), not init's argument.
    const p = props() ?? {};
    if (p.file) { this.viewer = new FileViewer(p, cx); return; }
    if (p.menu) { this.menu = new FileMenu(p); return; }
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = new Marks();
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

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const where = location(this.context), { cwd, on } = where, next = JSON.stringify(where);
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders });
      const saved = this.saved.get(next);
      this.context = { key: next, ...where }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = new Marks(); this.watched = null; this.error = null; this.limited = false;
      this.loading = false;
    }
    if (!cwd || this.loading) return;
    this.extras(cx);
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        let marks = new Marks();
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = (/** @type {string[]} */ more) => exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all", ...more], { cwd, on }).catch(() => null);
          // "matching" lists an ignored folder once (node_modules/), not each file in it, so it costs
          // next to nothing. Git before 2.16 doesn't know it: then the marks come without ignored files.
          let result = await status(["--ignored=matching"]);
          if (result && result.code !== 0) result = await status([]);
          const pause = () => new Promise((resolve) => cx.timer.after(1, () => resolve()));
          if (result?.code === 0) marks = await readStatus(result.stdout, top.stdout.trim(), { limit: TOTAL, pause });
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
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

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path);
      const { letter, tone, dot } = this.marks.row(`${this.root}/${path}`), color = toneColor(tone, t);
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => entry.dir ? this.toggle(path, cx) : openFile(this.abs(path), this.on ?? null, cx))
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.contextMenu(path, entry.dir); })
        .child(entry.dir ? svg(`mods/file-browser/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`mods/file-browser/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
        // The letter (a file's) or the dot (a folder's, for changes inside) follows the name, so the
        // radar's strip on the window's edge doesn't cover it.
        .child(h_flex().flex_1().min_w(0).gap(6).items_center()
          .child(div().min_w(0).truncate().when(Boolean(color), el => el.text_color(color)).child(entry.name))
          .when(Boolean(letter), el => el.child(div().flex_none().text_size(11).font_semibold().text_color(color).child(letter)))
          .when(dot, el => el.child(div().size(6).flex_none().rounded_full().bg(color)))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  render(cx) {
    if (this.viewer) return this.viewer.render(cx);
    if (this.menu) return this.menu.render(cx);
    if (key(this.context) !== this.context?.key) this.refresh(cx);
    const t = theme();
    return v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Files"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.root?.split(/[\\/]/).pop() ?? "")))
      // A right click on the empty part of the tree is about the folder itself.
      .child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6)
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.contextMenu("", true); })
        .children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total"))));
  }
}
