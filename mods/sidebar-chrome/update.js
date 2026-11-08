// Herdr Islands updates: is there a newer release on GitHub, and installing it with the repo's own
// installer in its update mode (only what's installed is updated; settings stay). The same file
// lives in sidebar-chrome (checks in the background) and mod-manager (shows it, installs on a click),
// so each mod still works on its own. Keep the two copies identical.
import { exec, appHome, home, readTextFile, writeTextFile, window as hwin } from "herdr";

export const REPO = "Yofukashiya/herdr-islands";
export const DAY = 24 * 3600e3;
const LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
const PENDING = "update.pending";
/** The installer's output, in the mod's own folder (the only place a mod may write). Hidden, so
 *  Herdr doesn't reload the mod over it, and the installer never touches it. */
export const logPath = (mod) => `${appHome()}/mods/${mod}/.update.log`;

const platform = () => hwin()?.platform ?? (/^[A-Za-z]:/.test(home()) ? "windows" : home().startsWith("/Users") ? "macos" : "linux");
export const load = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } };
export const save = (k, v) => { try { if (v === undefined) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch {} };

/** a > b for versions like "1.10.0" or "v1.9.2". */
export function isNewer(a, b) {
  const parts = (v) => String(v ?? "0").replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const x = parts(a), y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

/** This install's version, from a mod's own mod.json. */
export async function installedVersion(mod) {
  try { return JSON.parse((await readTextFile(`${appHome()}/mods/${mod}/mod.json`)) ?? "{}").version ?? null; } catch { return null; }
}

/** The newest published release: { version, tag, url }, or null before the first one. */
export async function latestRelease() {
  const r = await fetch(LATEST, { headers: { Accept: "application/vnd.github+json", "User-Agent": "herdr-islands" } });
  if (r.status === 404) return null; // no release published yet
  if (r.status !== 200) throw new Error(`GitHub answered ${r.status}`);
  const j = JSON.parse(await r.text());
  if (!j?.tag_name) return null;
  return { version: String(j.tag_name).replace(/^v/, ""), tag: String(j.tag_name), url: String(j.html_url ?? "") };
}

/** The release to offer, from a cache GitHub is asked to refresh once a day (`force`: now). */
export async function availableRelease(current, force = false) {
  let info = load("update.latest", null);
  if (force || !info || Date.now() - load("update.checked", 0) > DAY) {
    info = await latestRelease();
    save("update.latest", info);
    save("update.checked", Date.now());
  }
  return current && info && isNewer(info.version, current) ? info : null;
}

// UTF-16LE base64, for powershell -EncodedCommand: no quoting to get wrong.
function encodeCommand(s) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const b = [];
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); b.push(c & 255, c >> 8); }
  let out = "";
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    out += A[(n >> 18) & 63] + A[(n >> 12) & 63] + (i + 1 < b.length ? A[(n >> 6) & 63] : "=") + (i + 2 < b.length ? A[n & 63] : "=");
  }
  return out;
}

/**
 * Starts the installer of release `info` in update mode, detached from Herdr: it rewrites the
 * calling mod's own files, and Herdr reloads that mod in the middle. Its output goes to
 * logPath(mod); after the reload, pendingResult() tells how it went.
 */
export async function startUpdate(info, mod) {
  if (!/^[A-Za-z0-9._-]+$/.test(info.tag)) throw new Error(`Odd release tag: ${info.tag}`);
  const log = logPath(mod);
  // Empty it first, so a reading can't be the last run's.
  const old = await readTextFile(log).catch(() => null);
  if (old) await writeTextFile(log, "", old).catch(() => {});
  save(PENDING, { version: info.version, at: Date.now() });
  const raw = `https://raw.githubusercontent.com/${REPO}/${info.tag}`;
  let r;
  if (platform() === "windows") {
    // A PowerShell single-quoted string: the curly single quotes count as quotes too, so all are doubled.
    const ps = (s) => `'${String(s).replace(/['‘’‚‛]/g, "$&$&")}'`;
    // A failed download gets its own failure line, so the panel can say why instead of waiting.
    const script = [
      "[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12",
      `try { $s = Invoke-RestMethod ${ps(`${raw}/install.ps1`)} } catch { "islands-update: failed Couldn't download the installer: $($_.Exception.Message)" | Out-File -Encoding utf8 -FilePath ${ps(log)}; exit 1 }`,
      `& ([scriptblock]::Create($s)) --update --ref ${ps(info.tag)} *>&1 | Out-File -Encoding utf8 -FilePath ${ps(log)}`,
    ].join("; ");
    r = await exec("powershell", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command",
      `Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodeCommand(script)}'`]);
  } else {
    const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
    // Downloaded first: `curl | sh` would hide a failed download (sh gets no input and exits 0).
    const inner = `s=$(curl -fsSL ${q(`${raw}/install.sh`)}) || { echo "islands-update: failed Couldn't download the installer"; exit 1; }; printf '%s\\n' "$s" | sh -s -- --update --ref ${q(info.tag)}`;
    r = await exec("sh", ["-c", `nohup sh -c ${q(inner)} > ${q(log)} 2>&1 &`]);
  }
  if (r.code !== 0) {
    save(PENDING, undefined);
    throw new Error(`${r.stderr ?? ""}${r.stdout ?? ""}`.trim().slice(0, 200) || `exit ${r.code}`);
  }
}

/**
 * How an update this mod started went, reported once: { state: "ok" | "failed" | "running",
 * version, detail }. null when none is pending.
 */
export async function pendingResult(mod) {
  const p = load(PENDING, null);
  if (!p) return null;
  const log = (await readTextFile(logPath(mod)).catch(() => null)) ?? "";
  const failed = /islands-update: failed[^\r\n]*/.exec(log);
  if (!failed && /islands-update: ok/.test(log)) {
    save(PENDING, undefined);
    return { state: "ok", version: p.version };
  }
  if (failed || Date.now() - p.at > 5 * 60e3) {
    save(PENDING, undefined);
    return { state: "failed", version: p.version, detail: failed ? failed[0].replace("islands-update: failed", "").trim() : "It didn't finish" };
  }
  return { state: "running", version: p.version };
}
