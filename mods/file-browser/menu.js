// The Files panel's right-click menu: everything that opens a file or folder somewhere other than
// here (a left click opens it in Herdr). It runs as a popup overlay of this same mod.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, run, closeOverlay } from "herdr";
import { MOD, baseName, dirName, nativePath, openFile, openDefault, reveal, revealLabel, openInEditor } from "./open.js";

const ROW = 28, SEP = 9, PAD = 10;

/**
 * The menu for `target` = { file, rel, isDir, on }: rows { id, label, icon, strong?, act(cx) } and "sep".
 * `editors` are the code editors found ({ name, scheme }), `term` an optional terminal editor argv.
 */
export function menuItems(target, editors = [], term = null) {
  const { file, rel, isDir, on } = target;
  const local = !on, dir = isDir ? file : dirName(file);
  const items = [];
  if (!isDir) {
    items.push({ id: "open", label: "Open", icon: "file", strong: true, act: (cx) => openFile(file, on, cx) });
    if (local) items.push({ id: "default", label: "Open with default app", icon: "external-link", act: (cx) => openDefault(file, cx) });
  }
  if (local) for (const e of editors) items.push({ id: `ed-${e.scheme}`, label: isDir ? `Open folder in ${e.name}` : `Open in ${e.name}`, icon: "code", act: (cx) => openInEditor(e, file, cx) });
  if (!isDir && term) items.push({ id: "term-editor", label: `Open in ${baseName(term[0])}`, icon: "terminal", act: () => run("tab.new", { name: baseName(file), folder: dir, argv: [...term, file] }) });
  items.push("sep");
  if (local) items.push({ id: "reveal", label: isDir ? revealLabel().replace("Show in", "Open in").replace("Open containing folder", "Open folder") : revealLabel(), icon: "folder-open", act: () => reveal(file, isDir) });
  items.push({ id: "copy", label: "Copy path", icon: "copy", act: (cx) => cx.write_to_clipboard(nativePath(file, on)) });
  if (rel) items.push({ id: "copy-rel", label: "Copy relative path", icon: "copy", act: (cx) => cx.write_to_clipboard(rel) });
  items.push("sep");
  items.push({ id: "terminal", label: "Open terminal here", icon: "terminal", act: () => run("tab.new", { folder: dir }) });
  // No leading, trailing or doubled separators.
  return items.filter((it, i, all) => it !== "sep" || (i > 0 && i < all.length - 1 && all[i - 1] !== "sep"));
}

export function menuHeight(items) {
  return items.reduce((h, it) => h + (it === "sep" ? SEP : ROW), PAD);
}

export class FileMenu {
  constructor(p) {
    this.target = p.menu;
    this.overlay = p.overlay;
    this.items = menuItems(this.target, p.editors ?? [], p.term ?? null);
  }

  render() {
    const t = theme();
    return v_flex().id("file-menu").size_full().p(PAD / 2).text_size(12.5).text_color(t.foreground)
      .children(this.items.map((it, i) => it === "sep"
        ? div().id(`fm-sep-${i}`).h(1).my((SEP - 1) / 2).mx(6).bg(t.border)
        : h_flex().id(`fm-${it.id}`).h(ROW).flex_none().px(10).gap(9).items_center().rounded(6).cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { it.act(cx); closeOverlay(this.overlay); })
          .child(svg(`mods/${MOD}/${it.icon}.svg`).size(14).flex_none().text_color(t.muted))
          .child(div().flex_1().min_w(0).truncate().when(Boolean(it.strong), (e) => e.font_semibold()).child(it.label))));
  }
}
