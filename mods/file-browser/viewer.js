// A file opened from the Files panel, in a tab of its own: code and text read-only with syntax
// colors and line numbers, pictures fitted to the tab, anything else with a way to open it elsewhere.
import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState } from "gpui-base";
import { readTextFile, theme, settings, appHome } from "herdr";
import * as fs from "fs/promises";
import { MOD, IMAGES, LANG, platform, baseName, dirName, nativePath, openDefault, reveal, revealLabel, forgetOpen, copyHere, removeHere, imageSize } from "./open.js";

const MAX_CHARS = 400000;
const CACHE = `mods/${MOD}/.cache`;

export class FileViewer {
  constructor(p, cx) {
    this.file = String(p.file);
    this.on = p.on ?? null;
    this.name = baseName(this.file);
    this.id = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e8).toString(36)}`;
    this.state = "loading";
    this.box = { width: 800, height: 600 };
    this.sweep();
    cx.spawn(async (cx) => {
      try { await (IMAGES.test(this.file) ? this.loadImage() : this.loadText()); }
      catch (e) { this.state = "error"; this.error = String(e?.message ?? e); }
      cx.notify();
    });
  }

  async loadText() {
    let text = null;
    try { text = await readTextFile(this.file, { on: this.on }); }
    catch {
      // Past readTextFile's 1 MiB: fs reads any size, for files under the home folder.
      if (!this.on) text = await fs.readFile(this.file, "utf8").catch(() => null);
    }
    if (text === null) {
      this.state = "error";
      this.error = this.on ? "Can't read this file from the other machine (missing, or over 1 MiB)." : "Can't read this file: it's gone, too large, or not text.";
      return;
    }
    if (text.includes("\0")) { this.state = "binary"; return; }
    const t = theme(), ext = this.name.includes(".") ? this.name.split(".").pop().toLowerCase() : "txt";
    this.truncated = text.length > MAX_CHARS;
    this.code = EditorState.new({
      language: LANG[ext] ?? ext, readonly: true, line_numbers: true,
      value: this.truncated ? text.slice(0, MAX_CHARS) : text,
      font_family: settings().font_family, font_size: 13,
      syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 },
    });
    this.state = "text";
  }

  /** Images load from the Herdr folder, so the picture is copied into this mod's cache first. */
  async loadImage() {
    if (this.on) { this.state = "binary"; this.note = "Pictures from another machine can't be shown here."; return; }
    const dir = `${appHome()}/${CACHE}/${this.id}`;
    await fs.mkdir(dir, { recursive: true }).catch(() => {});
    const safe = this.name.replace(/[^\w.-]+/g, "_");
    if (!(await copyHere(this.file, `${dir}/${safe}`))) throw new Error("Can't read this picture.");
    this.dims = imageSize(await fs.readFile(`${dir}/${safe}`), safe);
    this.rel = `${CACHE}/${this.id}/${safe}`;
    this.state = "image";
  }

  /** Caches of tabs gone more than 12 hours (a crash leaves them behind). */
  sweep() {
    fs.readdir(`${appHome()}/${CACHE}`).then((names) => {
      const now = Date.now();
      for (const n of names) {
        const born = parseInt(n.split("-")[0], 36);
        if (born && now - born > 12 * 3600e3) removeHere(`${appHome()}/${CACHE}/${n}`);
      }
    }).catch(() => {});
  }

  close() {
    this.code?.release?.();
    if (this.rel) removeHere(`${appHome()}/${CACHE}/${this.id}`);
    forgetOpen(this.file, this.on);
  }

  render(cx) {
    const t = theme();
    const button = (id, icon, label, action) => h_flex().id(id).h(26).px(9).gap(6).flex_none().items_center().rounded(6).cursor_pointer()
      .text_size(12).text_color(t.muted).border(1).border_color(t.border).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx2) => action(cx2))
      .child(svg(`mods/${MOD}/${icon}.svg`).size(13).flex_none()).child(label);
    const local = !this.on;
    const bar = h_flex().h(40).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
      .child(svg(`mods/${MOD}/${this.state === "image" ? "image" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
      .child(div().flex_none().font_semibold().child(this.name))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(nativePath(dirName(this.file), this.on)))
      .when(local, (e) => e.child(button("fv-default", "external-link", "Open", (cx2) => openDefault(this.file, cx2))))
      .when(local, (e) => e.child(button("fv-reveal", "folder-open", platform() === "windows" ? "Explorer" : platform() === "macos" ? "Finder" : "Folder", () => reveal(this.file, false))))
      .child(button("fv-copy", "copy", "Copy path", (cx2) => cx2.write_to_clipboard(nativePath(this.file, this.on))));
    let body;
    if (this.state === "text") {
      body = v_flex().flex_1().min_h(0)
        .child(Editor.new(this.code).flex_1().min_h(0))
        .when(Boolean(this.truncated), (e) => e.child(div().px(12).py(6).border_t(1).border_color(t.border).text_size(11.5).text_color(t.dim)
          .child("Showing the first 400 000 characters. Open it in its program for the rest.")));
    } else if (this.state === "image") {
      // Fitted to the tab, never enlarged past its own size.
      const pad = 24, w = this.dims?.w, h = this.dims?.h;
      const k = w && h ? Math.min(1, (this.box.width - pad * 2) / w, (this.box.height - pad * 2) / h) : 1;
      body = div().id("fv-image").flex_1().min_h(0).flex().items_center().justify_center().overflow_hidden()
        .on_size_change((size, cx2) => { if (size.width !== this.box.width || size.height !== this.box.height) { this.box = size; cx2.notify(); } })
        .child(w && h ? image(this.rel).w(Math.max(1, w * k)).h(Math.max(1, h * k)) : image(this.rel).size_full());
    } else {
      const msg = this.state === "loading" ? "Opening…"
        : this.state === "binary" ? (this.note ?? "This file isn't text, so it can't be shown here.")
        : this.error;
      body = v_flex().flex_1().min_h(0).items_center().justify_center().gap(12).p(24)
        .child(div().max_w(520).whitespace_normal().text_center().text_color(this.state === "error" ? t.blocked : t.dim).child(msg))
        .when(this.state !== "loading" && local, (e) => e.child(h_flex().gap(8)
          .child(button("fv-default2", "external-link", "Open with default app", (cx2) => openDefault(this.file, cx2)))
          .child(button("fv-reveal2", "folder-open", revealLabel(), () => reveal(this.file, false)))));
    }
    return v_flex().id("file-viewer").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13).child(bar).child(body);
  }
}
