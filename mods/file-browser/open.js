// What a file can be opened with: here in Herdr (left click), or elsewhere (the right-click menu).
import { spaces, run, exec, shared, setShared, appHome, home, window as hwin } from "herdr";
import * as fs from "fs/promises";

export const MOD = "file-browser";
// .xls (Excel 97-2003) isn't here: sheet-viewer can't read it, so it gets "Open with default app".
export const SHEETS = /\.(xlsx|xlsm|csv|tsv)$/i;
export const IMAGES = /\.(png|jpe?g|gif|webp|bmp|ico|svg)$/i;
/** Never text: shown with "Open with default app" at once, without reading the file. */
export const BINARY = /\.(xls|zip|7z|rar|gz|tgz|xz|bz2|zst|tar|exe|msi|dll|so|dylib|bin|iso|dmg|pkg|pdf|docx?|pptx?|odt|ods|odp|mp[34]|m4a|mov|avi|mkv|webm|wav|flac|ogg|aac|woff2?|ttf|otf|class|jar|pyc|o|a|lib|obj|sqlite3?|db|psd|ai|heic|tiff?)$/i;
/** Larger files aren't read for the viewer (a big log or dump would fill the mod's memory). */
export const MAX_READ = 16 * 1024 * 1024;
export const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
/** Files open in a tab: "machine|path" -> the tab's name, so a second click goes to that tab. */
const OPEN = "file-browser.open";

export const platform = () => hwin()?.platform ?? (/^[A-Za-z]:/.test(home()) ? "windows" : home().startsWith("/Users") ? "macos" : "linux");
export const baseName = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() ?? String(p);
export const dirName = (p) => String(p).replace(/[\\/][^\\/]*[\\/]?$/, "") || String(p);
const openKey = (file, on) => `${on ?? ""}|${String(file).replace(/\\/g, "/")}`;
/** A path the way this OS writes it, for the clipboard and for Explorer. */
export const nativePath = (p, on) => (!on && platform() === "windows" ? String(p).replace(/\//g, "\\") : String(p));

/** Whether the sheet-viewer mod is installed, kept current by the panel (checkSheetViewer). */
const SHEET_VIEWER = "file-browser.sheetViewer";
export async function checkSheetViewer() {
  const has = await fs.exists(`${appHome()}/mods/sheet-viewer/main.js`).catch(() => false);
  if (shared(SHEET_VIEWER) !== has) setShared(SHEET_VIEWER, has);
}

/** Opens `file` here in Herdr, in a tab of its own: spreadsheets in sheet-viewer (when it's
 *  installed), everything else in this mod's viewer. A file already open goes to its tab.
 *  Synchronous when it can be, so it also works from a menu that closes right after. */
export function openFile(file, on, cx) {
  const k = openKey(file, on);
  const known = (shared(OPEN) ?? {})[k];
  const space = spaces().find((s) => s.active);
  const tabs = space?.tabs ?? [];
  const tab = known && tabs.find((t) => t.name === known);
  if (tab) { run("tab.select", { id: tab.id }); return; }
  // Herdr doesn't hand back the new tab's id, so the name has to be unique in the space for a second
  // click to find the right tab: the file name, else with as many parent folders as it takes
  // (a/index.js and b/index.js become "index.js · a" and "index.js · b"), like an editor's tabs.
  const parts = String(file).replace(/\\/g, "/").split("/").filter(Boolean);
  let name = parts[parts.length - 1] ?? String(file);
  for (let i = parts.length - 2; i >= 0 && tabs.some((t) => t.name === name); i--) {
    name = `${parts[parts.length - 1]} · ${parts.slice(i, -1).join("/")}`;
  }
  const go = (sheet) => {
    setShared(OPEN, { ...(shared(OPEN) ?? {}), [k]: name });
    run("tab.new", { name, mod: sheet ? "sheet-viewer" : MOD, props: { file, on: on ?? null } });
  };
  const isSheet = SHEETS.test(file), has = shared(SHEET_VIEWER);
  if (!isSheet || has !== undefined) { go(isSheet && has); return; }
  cx.spawn(async () => { await checkSheetViewer(); go(shared(SHEET_VIEWER)); });
}

/** The viewer's tab closed: a click opens the file again. */
export function forgetOpen(file, on) {
  const all = { ...(shared(OPEN) ?? {}) };
  delete all[openKey(file, on)];
  setShared(OPEN, all);
}

/** file:///C:/a%20b/c.txt — what the OS hands to a file's default program. */
export function fileUrl(p) {
  const parts = String(p).replace(/\\/g, "/").split("/");
  const enc = parts.map((s, i) => (i === 0 && /^[A-Za-z]:$/.test(s) ? s : encodeURIComponent(s))).join("/");
  return enc.startsWith("/") ? `file://${enc}` : `file:///${enc}`;
}

/** Opens a file (or folder) with whatever the system opens it with. */
export function openDefault(p, cx) { cx.open_url(fileUrl(p)); }

/** Shows a file selected in Explorer / Finder; a folder opens itself. */
export function reveal(p, isDir) {
  const os = platform();
  const r = os === "windows" ? exec("explorer", [isDir ? nativePath(p) : `/select,${nativePath(p)}`])
    : os === "macos" ? exec("open", isDir ? [p] : ["-R", p])
    : exec("xdg-open", [isDir ? p : dirName(p)]);
  r.catch(() => {});
}

export const revealLabel = () => (platform() === "windows" ? "Show in Explorer" : platform() === "macos" ? "Show in Finder" : "Open containing folder");

/** Code editors with a URL handler (vscode://file/...): found once, then remembered for the session. */
const EDITORS = [
  { id: "code", name: "VS Code", scheme: "vscode", win: "Programs/Microsoft VS Code/Code.exe", mac: "/Applications/Visual Studio Code.app" },
  { id: "cursor", name: "Cursor", scheme: "cursor", win: "Programs/cursor/Cursor.exe", mac: "/Applications/Cursor.app" },
];
const FOUND = "file-browser.editors";

export function editors() { return (shared(FOUND) ?? []).map((id) => EDITORS.find((e) => e.id === id)).filter(Boolean); }

export async function findEditors() {
  if (shared(FOUND)) return;
  const os = platform(), found = [];
  for (const e of EDITORS) {
    let ok = false;
    if (os === "windows") {
      ok = (await exec("where", [e.id]).catch(() => null))?.code === 0
        || (await fs.exists(`${home()}/AppData/Local/${e.win}`).catch(() => false));
    } else {
      const test = os === "macos" ? `test -d "${e.mac}" || command -v ${e.id}` : `command -v ${e.id}`;
      ok = (await exec("sh", ["-c", `${test} >/dev/null 2>&1`]).catch(() => null))?.code === 0;
    }
    if (ok) found.push(e.id);
  }
  setShared(FOUND, found);
}

/** vscode://file/C:/repo/a.js — the editor opens the file (or the folder) itself. */
export function openInEditor(editor, p, cx) {
  // The same path encoding as a file:// URL ("#", spaces, Cyrillic), after the editor's scheme.
  cx.open_url(fileUrl(p).replace(/^file:\/\/\/?/, `${editor.scheme}://file/`));
}

/** An optional terminal editor from settings.json ({"terminal_editor": ["nvim"]}), opened in a new tab. */
export async function terminalEditor() {
  try {
    const s = JSON.parse(await fs.readFile(`${appHome()}/mods/${MOD}/settings.json`, "utf8"));
    return Array.isArray(s.terminal_editor) && s.terminal_editor.length && s.terminal_editor.every((x) => typeof x === "string") ? s.terminal_editor : null;
  } catch { return null; }
}

/** A copy of `src` at `dest` (inside the Herdr folder): fs where it can read, the OS elsewhere. */
export async function copyHere(src, dest) {
  try { await fs.writeFile(dest, await fs.readFile(src)); return true; } catch {}
  const ps = (s) => `'${String(s).replace(/['\u2018\u2019\u201A\u201B]/g, "$&$&")}'`;
  const r = platform() === "windows"
    ? await exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", `Copy-Item -LiteralPath ${ps(src)} -Destination ${ps(dest)}`]).catch(() => null)
    : await exec("cp", [src, dest]).catch(() => null);
  return r?.code === 0;
}

/** A local file's size in bytes, or null (mods have no fs.stat; the OS tells). */
export async function fileSize(p) {
  const ps = (s) => `'${String(s).replace(/['‘’‚‛]/g, "$&$&")}'`;
  const r = platform() === "windows"
    // -ErrorAction Stop: a missing file must fail, not print 0 ($null.Length is 0 in PowerShell).
    ? await exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Item -LiteralPath ${ps(p)} -ErrorAction Stop).Length`]).catch(() => null)
    : await exec("wc", ["-c", p]).catch(() => null);
  const n = r?.code === 0 ? parseInt(String(r.stdout).trim(), 10) : NaN;
  return Number.isFinite(n) ? n : null;
}

export function removeHere(abs) {
  const ps = (s) => `'${String(s).replace(/['\u2018\u2019\u201A\u201B]/g, "$&$&")}'`;
  const r = platform() === "windows"
    ? exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", `Remove-Item -LiteralPath ${ps(abs)} -Recurse -Force -ErrorAction SilentlyContinue`])
    : exec("rm", ["-rf", abs]);
  r.catch(() => {});
}

/** Width and height from an image's header (PNG, GIF, JPEG, WebP, BMP, ICO, SVG); null when unknown. */
export function imageSize(bytes, name) {
  const b = bytes, u32be = (i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  const u16be = (i) => (b[i] << 8) | b[i + 1], u16le = (i) => b[i] | (b[i + 1] << 8);
  const u24le = (i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16), i32le = (i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24);
  try {
    if (b[0] === 0x89 && b[1] === 0x50) return { w: u32be(16), h: u32be(20) };
    if (b[0] === 0x47 && b[1] === 0x49) return { w: u16le(6), h: u16le(8) };
    if (b[0] === 0x42 && b[1] === 0x4d) return { w: Math.abs(i32le(18)), h: Math.abs(i32le(22)) };
    if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return { w: b[6] || 256, h: b[7] || 256 };
    if (b[0] === 0x52 && b[8] === 0x57) { // RIFF....WEBP
      const kind = String.fromCharCode(b[12], b[13], b[14], b[15]);
      if (kind === "VP8 ") return { w: u16le(26) & 0x3fff, h: u16le(28) & 0x3fff };
      if (kind === "VP8L") { const n = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24); return { w: (n & 0x3fff) + 1, h: ((n >> 14) & 0x3fff) + 1 }; }
      if (kind === "VP8X") return { w: u24le(24) + 1, h: u24le(27) + 1 };
    }
    if (b[0] === 0xff && b[1] === 0xd8) {
      for (let i = 2; i + 9 < b.length;) {
        if (b[i] !== 0xff) { i++; continue; }
        const m = b[i + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: u16be(i + 7), h: u16be(i + 5) };
        i += 2 + u16be(i + 2);
      }
    }
    if (/\.svg$/i.test(name)) {
      let head = "";
      for (let i = 0; i < Math.min(b.length, 4096); i++) head += String.fromCharCode(b[i]);
      const tag = /<svg\b[^>]*>/i.exec(head)?.[0] ?? "";
      const num = (a) => Number(new RegExp(`\\b${a}\\s*=\\s*["']\\s*([\\d.]+)`, "i").exec(tag)?.[1]);
      const vb = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(tag);
      const w = num("width") || Number(vb?.[1]), h = num("height") || Number(vb?.[2]);
      if (w > 0 && h > 0) return { w, h };
    }
  } catch {}
  return null;
}
